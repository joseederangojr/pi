import {
  getTask,
  listBlockedTasks,
  isTaskStuck,
  listParallelRunnableTasks,
  listStuckTasks,
  taskBlocker,
  listTasks,
  listTasksTreeOrder,
  type Task,
  type TaskState,
  type TaskStatus,
} from "./model.ts";

export interface TaskWidgetView {
  selectedTaskId: string | undefined;
  pendingConfirmation: string | undefined;
}

interface TreeRow {
  task: Task;
  parentId: string | undefined;
  branchPrefix: string;
  depth: number;
}

export function formatTaskList(
  state: TaskState,
  status: TaskStatus | undefined,
  limit = 20,
  nowIso = new Date().toISOString(),
): string {
  const all = listTasks(state, status);
  const tasks = all.slice(0, limit);
  if (tasks.length === 0) return "No tasks.";

  const lines = tasks.map(
    (task) =>
      `${task.id} [${task.status}] ${task.title}${taskFlags(state, task, nowIso)} ` +
      `@${task.lane} model:${task.model} tree:${task.sessionTree} deps:${task.dependsOn.length} (${taskDuration(task, nowIso)}) ` +
      `↑${compactTokens(task.usage.inputTokens)} ↓${compactTokens(task.usage.outputTokens)} $${formatUsd(task.usage.costUsd)}`,
  );
  if (all.length > limit) lines.push(`... +${all.length - limit} more`);
  return lines.join("\n");
}

export function formatTaskPeek(state: TaskState, taskId: string, nowIso = new Date().toISOString()): string {
  const task = getTask(state, taskId);
  if (!task) return `Task not found: ${taskId}`;
  return formatTask(state, task, nowIso);
}

export function formatBlockerSummary(state: TaskState): string {
  const blocked = listBlockedTasks(state);
  if (blocked.length === 0) return "No blockers.";
  return blocked
    .map((task) => `${task.id} ${task.title}: ${taskBlocker(state, task)}`)
    .join("\n");
}

export function formatStuckSummary(state: TaskState, nowIso = new Date().toISOString()): string {
  const tasks = listStuckTasks(state, nowIso);
  if (tasks.length === 0) return "No stuck tasks.";
  return tasks.map((task) => `${task.id} ${task.title}: no activity for ${durationText(task.lastActivityAt, nowIso)} (possibly stuck)`).join("\n");
}

export function formatTaskTree(state: TaskState, nowIso = new Date().toISOString()): string {
  const rows = buildTreeRows(state);
  if (rows.length === 0) return "No tasks.";
  return rows.map((row) => formatTreeRow(state, row, false, undefined, nowIso, 0)).join("\n");
}

export function formatTaskWidget(
  state: TaskState,
  view: TaskWidgetView,
  limit = 10,
  nowIso = new Date().toISOString(),
  frame = 0,
): string[] {
  const rows = buildTreeRows(state).sort((a, b) => {
    const priority = (status: Task["status"]) => status === "in_progress" ? 0 : status === "paused" ? 1 : status === "pending" ? 2 : 3;
    const pa = priority(a.task.status);
    const pb = priority(b.task.status);
    if (pa !== pb) return pa - pb;
    return 0;
  });
  const tasks = rows.map((row) => row.task);
  const selectedTaskId = pickSelectedTaskId(tasks, view.selectedTaskId);

  const statusCounts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  const friendly: Record<string, string> = { in_progress: "running", pending: "pending", paused: "paused", done: "done" };
  const countText = Object.entries(statusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${friendly[status] ?? status}${count === 1 ? "" : "s"}`)
    .join(", ");
  const lines: string[] = [`Tasks (${tasks.length})${countText ? " — " + countText : ""}`];

  if (view.pendingConfirmation) {
    lines.push(`confirm: ${view.pendingConfirmation}`);
  }

  if (rows.length === 0) {
    lines.push("(no tasks)");
    return lines;
  }

  const selectedIndex = rows.findIndex((row) => row.task.id === selectedTaskId);
  const start = Math.max(0, selectedIndex - limit + 1);
  const visible = rows.slice(start, start + limit);
  if (start > 0) lines.push(`... ${start} above`);
  for (const row of visible) {
    lines.push(formatWidgetTaskRow(state, row, selectedTaskId, nowIso, frame));
  }

  const hasMore = rows.length - start - visible.length;
  if (hasMore > 0) lines.push(`... +${hasMore} more`);

  return lines;
}

function formatWidgetTaskRow(state: TaskState, row: TreeRow, selectedTaskId: string | undefined, nowIso: string, frame: number): string {
  const task = row.task;
  const indent = "  ".repeat(row.depth);
  const marker = "";
  const blockedDep = task.dependsOn.find((d) => state.tasks[d]?.status !== "done");
  const blockedText = taskBlocker(state, task)
    ? ` [blocked${blockedDep ? ` #${blockedDep.replace("task-", "")}` : ""}]`
    : "";
  const stuckText = isTaskStuck(task, Date.parse(nowIso)) ? ` [stuck: idle ${durationText(task.lastActivityAt, nowIso)}]` : "";
  const metrics = `(${taskDuration(task, nowIso)} ↑${compactTokens(task.usage.inputTokens)} ↓${compactTokens(task.usage.outputTokens)} $${formatUsd(task.usage.costUsd)})`;
  const line = `${indent}${statusIcon(task.status, frame)} #${task.id.replace("task-", "")} ${task.title}${blockedText}${stuckText} ${metrics}`;
  if (task.status === "done") return `\x1b[9m${line}\x1b[0m`;
  return line;
}

function formatTask(state: TaskState, task: Task, nowIso: string): string {
  const lines = [
    `${task.id} [${task.status}] ${task.title}${taskFlags(state, task, nowIso)}`,
    `created: ${task.createdAt}`,
    `updated: ${task.updatedAt}`,
    `last_activity: ${task.lastActivityAt}`, 
  ];

  const blocker = taskBlocker(state, task);
  if (blocker) lines.push(`blocker: ${blocker}`);
  if (task.sessionFile) lines.push(`session_file: ${task.sessionFile}`);
  if (task.summary) lines.push(`summary: ${task.summary}`);

  lines.push(`lane: ${task.lane}`);
  lines.push(`background: ${task.background ? "yes" : "no"}`);
  lines.push(`session_tree: ${task.sessionTree}`);
  lines.push(`depends_on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none"}`);
  lines.push(`duration: ${taskDuration(task, nowIso)}`);
  lines.push(`tokens: in=${task.usage.inputTokens} out=${task.usage.outputTokens}`);
  lines.push(`cost_usd: ${formatUsd(task.usage.costUsd)}`);

  if (task.description) {
    lines.push(`description: ${task.description}`);
  }

  if (task.notes.length > 0) {
    lines.push("notes:");
    for (const note of task.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function pickSelectedTaskId(tasks: Task[], selectedTaskId: string | undefined): string | undefined {
  if (tasks.length === 0) return undefined;
  if (!selectedTaskId) return tasks[0]?.id;
  return tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : tasks[0]?.id;
}

function buildTreeRows(state: TaskState): TreeRow[] {
  const tasks = listTasksTreeOrder(state);
  if (tasks.length === 0) return [];

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const parentById = new Map<string, string | undefined>();
  const children = new Map<string, Task[]>();

  for (const task of tasks) {
    const parentId = task.dependsOn.find((dependencyTaskId) => byId.has(dependencyTaskId));
    parentById.set(task.id, parentId);
    if (!parentId) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(task);
    children.set(parentId, bucket);
  }

  const rows: TreeRow[] = [];
  const visited = new Set<string>();
  const roots = tasks.filter((task) => !parentById.get(task.id));

  for (const root of roots) {
    visitTreeRow(root, undefined, "", true, 0, rows, visited, children, parentById);
  }

  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    visitTreeRow(task, parentById.get(task.id), "", true, 0, rows, visited, children, parentById);
  }

  return rows;
}

function visitTreeRow(
  task: Task,
  parentId: string | undefined,
  prefix: string,
  isLast: boolean,
  depth: number,
  rows: TreeRow[],
  visited: Set<string>,
  children: Map<string, Task[]>,
  parentById: Map<string, string | undefined>,
): void {
  if (visited.has(task.id)) return;
  visited.add(task.id);

  const branchPrefix = prefix.length === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`;
  rows.push({ task, parentId, branchPrefix, depth });

  const childTasks = children.get(task.id) ?? [];
  for (let index = 0; index < childTasks.length; index += 1) {
    const child = childTasks[index];
    if (!child) continue;
    const childPrefix = prefix.length === 0 ? "   " : `${prefix}${isLast ? "   " : "│  "}`;
    visitTreeRow(
      child,
      parentById.get(child.id),
      childPrefix,
      index === childTasks.length - 1,
      depth + 1,
      rows,
      visited,
      children,
      parentById,
    );
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function statusIcon(status: Task["status"], frame = 0): string {
  switch (status) {
    case "in_progress": return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋";
    case "paused": return "⏸";
    case "done": return "✓";
    case "pending": return "○";
    default: return "?";
  }
}

function formatTreeRow(state: TaskState, row: TreeRow, showSelection: boolean, selectedTaskId: string | undefined, nowIso: string, frame = 0): string {
  const task = row.task;
  const flags = taskFlags(state, task, nowIso);
  const marker = showSelection ? `${selectedTaskId === task.id ? ">" : " "} ` : "";
  const extraDeps = row.parentId
    ? task.dependsOn.filter((dependencyTaskId) => dependencyTaskId !== row.parentId)
    : task.dependsOn;
  const extraDepsText = extraDeps.length > 0 ? ` +deps:${extraDeps.join(",")}` : "";
  const blockedIcon = taskBlocker(state, task) ? " 🚫" : "";
  const stuckIcon = isTaskStuck(task, Date.parse(nowIso)) ? " ⚠" : "";

  return (
    `${marker}${row.branchPrefix}${statusIcon(task.status, frame)} ${task.id} ${task.title}${blockedIcon}${stuckIcon}${flags} @${task.lane} ` +
    `(${taskDuration(task, nowIso)} ↑${compactTokens(task.usage.inputTokens)} ` +
    `↓${compactTokens(task.usage.outputTokens)} $${formatUsd(task.usage.costUsd)}) ` +
    `tree:${task.sessionTree}${extraDepsText}`
  );
}

function taskFlags(state: TaskState, task: Task, nowIso: string): string {
  const blocked = taskBlocker(state, task) ? " [blocked]" : "";
  const stuck = isTaskStuck(task, Date.parse(nowIso))
    ? ` [stuck: idle ${durationText(task.lastActivityAt, nowIso)}]`
    : "";
  return blocked + stuck;
}

function taskDuration(task: Task, nowIso: string): string {
  return durationText(task.startedAt ?? task.createdAt, task.status === "in_progress" ? nowIso : task.finishedAt ?? task.updatedAt);
}

function durationText(createdAt: string, updatedAt: string): string {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "0s";

  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h${remMinutes}m` : `${hours}h`;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "0.0000";
  return value.toFixed(4);
}

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1_000) return `${Math.floor(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.floor(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

