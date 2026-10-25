import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionTreeName,
  createInitialState,
  createTask,
  isTaskStuck,
  listStuckTasks,
  listBlockedTasks,
  STUCK_THRESHOLD_MS,
  taskBlocker,
  updateTask,
} from "../src/model.ts";
import { formatStuckSummary, formatTaskList, formatTaskPeek, formatTaskTree, formatTaskWidget } from "../src/render.ts";
import { replayState } from "../src/store.ts";
import { createStuckReporter } from "../src/health.ts";

const at = "2026-01-01T00:00:00.000Z";
const now = "2026-01-01T00:15:00.000Z";

function runningTask() {
  const created = createTask(createInitialState(), "Build feature", undefined, at);
  return updateTask(created.state, { taskId: created.task.id, status: "in_progress", updatedAt: at });
}

test("tasks default to background with stable task-id and hash session names", () => {
  const created = createTask(createInitialState(), "Build feature", undefined, at);
  assert.equal(created.task.background, true);
  assert.match(created.task.sessionTree, /^task-1-[a-f0-9]{8}$/);
  assert.equal(created.task.sessionTree, buildSessionTreeName("task-1", "Build feature", "task-1", at));
  const edited = updateTask(created.state, { taskId: created.task.id, title: "Renamed", lane: "new-lane", updatedAt: now });
  assert.equal(edited.task?.sessionTree, created.task.sessionTree);
});

test("model inherits from dependency unless overridden", () => {
  const root = createTask(createInitialState(), "Root", undefined, at, undefined, [], "provider/model-a");
  const child = createTask(root.state, "Child", undefined, at, undefined, [root.task.id]);
  assert.equal(child.task.model, "provider/model-a");
  const custom = createTask(child.state, "Custom", undefined, at, undefined, [root.task.id], "provider/model-b");
  assert.equal(custom.task.model, "provider/model-b");
});

test("stuck detection uses worker activity, not administrative edits", () => {
  const running = runningTask();
  assert.ok(running.task);
  const start = Date.parse(at);
  assert.equal(isTaskStuck(running.task, start + STUCK_THRESHOLD_MS - 1), false);
  assert.equal(isTaskStuck(running.task, start + STUCK_THRESHOLD_MS), true);
  assert.equal(isTaskStuck(running.task, start - 1), false);
  assert.equal(isTaskStuck(running.task, Number.NaN), false);
  assert.deepEqual(listStuckTasks(running.state, now).map((task) => task.id), ["task-1"]);
  assert.deepEqual(listStuckTasks(running.state, "invalid"), []);

  const edited = updateTask(running.state, { taskId: "task-1", note: "edited", updatedAt: now });
  assert.ok(edited.task);
  assert.equal(isTaskStuck(edited.task, Date.parse(now)), true);
  const active = updateTask(edited.state, { taskId: "task-1", lastActivityAt: now, updatedAt: now });
  assert.deepEqual(listStuckTasks(active.state, now), []);
  for (const status of ["pending", "done"] as const) {
    const stopped = updateTask(running.state, { taskId: "task-1", status, updatedAt: now });
    assert.deepEqual(listStuckTasks(stopped.state, now), []);
  }
});

test("stuck task is identified in every view without displaying hotkeys", () => {
  const { state } = runningTask();
  const views = [
    formatTaskList(state, undefined, 20, now),
    formatTaskPeek(state, "task-1", now),
    formatTaskTree(state, now),
  ];
  for (const view of views) assert.match(view, /\[stuck: idle 15m\]/);
  const widget = formatTaskWidget(state, { selectedTaskId: "task-1", pendingConfirmation: undefined }, 10, now).join("\n");
  assert.match(widget, /\[stuck/);
  assert.match(widget, /\[stuck: idle 15m\]/);
  assert.doesNotMatch(widget, /j\/k|S start|s stop|d delete|repeat action/);
  assert.match(formatStuckSummary(state, now), /task-1 Build feature: no activity for 15m/);
  assert.equal(formatStuckSummary(state, at), "No stuck tasks.");
});

test("stuck warnings fire once per idle episode and re-arm after activity", () => {
  const report = createStuckReporter();
  const { state } = runningTask();
  assert.equal(report(state, now).length, 1);
  assert.equal(report(state, now).length, 0);
  const active = updateTask(state, { taskId: "task-1", lastActivityAt: now, updatedAt: now });
  assert.equal(report(active.state, now).length, 0);
  assert.equal(report(active.state, "2026-01-01T00:30:00.000Z").length, 1);
  const stopped = updateTask(active.state, { taskId: "task-1", status: "pending", updatedAt: now });
  assert.equal(report(stopped.state, "2026-01-01T00:30:00.000Z").length, 0);
  assert.equal(report(createInitialState(), now).length, 0);
});

test("missing and unfinished dependencies are reported as blockers", () => {
  const root = createTask(createInitialState(), "Root", undefined, at);
  const child = createTask(root.state, "Child", undefined, at, undefined, ["task-1", "task-99"]);
  assert.equal(taskBlocker(child.state, child.task), "waiting for task-1, task-99 (missing)");
  assert.deepEqual(listBlockedTasks(child.state).map((task) => task.id), ["task-2"]);
});

test("selection remains visible beyond the first page", () => {
  let state = createInitialState();
  for (let i = 0; i < 15; i++) state = createTask(state, `Task ${i}`, undefined, at).state;
  const widget = formatTaskWidget(state, { selectedTaskId: "task-15", pendingConfirmation: undefined }, 5, at).join("\n");
  assert.match(widget, /○ #15/);
  assert.match(widget, /10 above/);
  assert.doesNotMatch(widget, /task-1 \[/);
});

test("old snapshots get background session names and activity timestamps", () => {
  const state = replayState([{ type: "custom", customType: "task-manager:snapshot", data: {
    version: 1,
    createdAt: at,
    state: { nextId: 1, tasks: { "task-8": { title: "Legacy", status: "in_progress", createdAt: at, updatedAt: at } } },
  } }]);
  const task = state.tasks["task-8"];
  assert.ok(task);
  assert.equal(task.background, true);
  assert.equal(task.lastActivityAt, at);
  assert.match(task.sessionTree, /^task-8-[a-f0-9]{8}$/);
  assert.equal(state.nextId, 9);
});

