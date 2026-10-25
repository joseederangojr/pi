import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  createTask,
  getTask,
  listBlockedTasks,
  listParallelRunnableTasks,
  removeTask,
  TASK_SNAPSHOT_CUSTOM_TYPE,
  updateTask,
} from "../src/model.ts";
import {
  formatBlockerSummary,
  formatTaskList,
  formatTaskPeek,
  formatTaskTree,
  formatTaskWidget,
} from "../src/render.ts";
import { replayState } from "../src/store.ts";

test("create and update task", () => {
  const initial = createInitialState();
  const createdAt = "2026-01-01T00:00:00.000Z";
  const created = createTask(initial, "Write docs", "first pass", createdAt);

  assert.equal(created.task.id, "task-1");
  assert.equal(created.state.nextId, 2);

  const updated = updateTask(created.state, {
    taskId: "task-1",
    status: "in_progress",
    note: "started",
    blocker: "waiting on API key",
    inputTokensDelta: 120,
    outputTokensDelta: 55,
    costUsdDelta: 0.0123,
    updatedAt: "2026-01-01T01:00:00.000Z",
  });

  assert.equal(updated.error, undefined);
  assert.equal(updated.task?.status, "in_progress");
  assert.equal(updated.task?.blocker, "waiting on API key");
  assert.deepEqual(updated.task?.notes, ["started"]);
  assert.equal(updated.task?.usage.inputTokens, 120);
  assert.equal(updated.task?.usage.outputTokens, 55);
  assert.equal(updated.task?.usage.costUsd, 0.0123);

  const unblocked = updateTask(updated.state, {
    taskId: "task-1",
    clearBlocker: true,
    updatedAt: "2026-01-01T01:10:00.000Z",
  });
  assert.equal(unblocked.task?.blocker, undefined);
});

test("render list, widget, and peek with duration/usage", () => {
  const created = createTask(
    createInitialState(),
    "Build extension",
    undefined,
    "2026-01-01T00:00:00.000Z",
  );
  const updated = updateTask(created.state, {
    taskId: "task-1",
    status: "in_progress",
    inputTokensDelta: 200,
    outputTokensDelta: 80,
    costUsdDelta: 0.034,
    updatedAt: "2026-01-01T00:10:00.000Z",
  });

  const now = "2026-01-01T00:20:00.000Z";
  const list = formatTaskList(updated.state, undefined, 10, now);
  assert.match(list, /task-1 \[in_progress\] Build extension/);
  assert.match(list, /\(10m\) ↑200 ↓80 \$0.0340/);

  const peek = formatTaskPeek(updated.state, "task-1", now);
  assert.match(peek, /duration: 10m/);
  assert.match(peek, /tokens: in=200 out=80/);
  assert.match(peek, /cost_usd: 0.0340/);

  const widget = formatTaskWidget(updated.state, { selectedTaskId: "task-1", pendingConfirmation: undefined }, 10, now);
  assert.match(widget.join("\n"), /↑200 ↓80 \$0.0340/);
});

test("identify blockers and remove tasks", () => {
  const first = createTask(
    createInitialState(),
    "Task A",
    undefined,
    "2026-01-01T00:00:00.000Z",
  );
  const second = createTask(
    first.state,
    "Task B",
    undefined,
    "2026-01-01T00:01:00.000Z",
  );
  const blocked = updateTask(second.state, {
    taskId: "task-2",
    blocker: "waiting for review",
    updatedAt: "2026-01-01T00:02:00.000Z",
  });

  const blockers = listBlockedTasks(blocked.state);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]?.id, "task-2");

  const summary = formatBlockerSummary(blocked.state);
  assert.match(summary, /task-2 Task B: waiting for review/);

  const withDependency = updateTask(blocked.state, {
    taskId: "task-2",
    dependsOn: ["task-1"],
    updatedAt: "2026-01-01T00:03:00.000Z",
  });

  const removed = removeTask(withDependency.state, "task-1");
  assert.equal(removed.error, undefined);
  assert.equal(getTask(removed.state, "task-1"), undefined);
  assert.deepEqual(getTask(removed.state, "task-2")?.dependsOn, []);
});

test("parallel runnable tasks respect blockers and dependencies", () => {
  const a = createTask(createInitialState(), "Task A", undefined, "2026-01-01T00:00:00.000Z");
  const b = createTask(a.state, "Task B", undefined, "2026-01-01T00:01:00.000Z", "lane-b", ["task-1"]);
  const c = createTask(b.state, "Task C", undefined, "2026-01-01T00:02:00.000Z");

  const initiallyReady = listParallelRunnableTasks(c.state).map((task) => task.id);
  assert.deepEqual(initiallyReady, ["task-1", "task-3"]);

  const blocked = updateTask(c.state, {
    taskId: "task-3",
    blocker: "waiting",
    updatedAt: "2026-01-01T00:03:00.000Z",
  });
  const afterBlock = listParallelRunnableTasks(blocked.state).map((task) => task.id);
  assert.deepEqual(afterBlock, ["task-1"]);

  const doneA = updateTask(blocked.state, {
    taskId: "task-1",
    status: "done",
    updatedAt: "2026-01-01T00:04:00.000Z",
  });
  const afterDone = listParallelRunnableTasks(doneA.state).map((task) => task.id);
  assert.deepEqual(afterDone, ["task-2"]);
});

test("render task tree from dependencies", () => {
  const a = createTask(createInitialState(), "Root", undefined, "2026-01-01T00:00:00.000Z");
  const b = createTask(a.state, "Child", undefined, "2026-01-01T00:01:00.000Z", "lane-b", ["task-1"]);
  const c = createTask(
    b.state,
    "Grandchild",
    undefined,
    "2026-01-01T00:02:00.000Z",
    "lane-c",
    ["task-2"],
  );

  const tree = formatTaskTree(c.state);
  assert.match(tree, /○ task-1 Root @task-1/);
  assert.match(tree, /└─ ○ task-2 Child 🚫 \[blocked\] @lane-b/);
  assert.match(tree, /└─ ○ task-3 Grandchild 🚫 \[blocked\] @lane-c/);
});

test("replay state from latest snapshot", () => {
  const first = createTask(
    createInitialState(),
    "Task A",
    undefined,
    "2026-01-01T00:00:00.000Z",
  );
  const second = createTask(
    first.state,
    "Task B",
    undefined,
    "2026-01-01T00:10:00.000Z",
  );

  const state = replayState([
    {
      type: "custom",
      customType: TASK_SNAPSHOT_CUSTOM_TYPE,
      data: {
        version: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        state: first.state,
      },
    },
    {
      type: "custom",
      customType: TASK_SNAPSHOT_CUSTOM_TYPE,
      data: {
        version: 1,
        createdAt: "2026-01-01T00:10:01.000Z",
        state: second.state,
      },
    },
  ]);

  assert.equal(getTask(state, "task-2")?.title, "Task B");
  assert.equal(state.nextId, 3);
});

