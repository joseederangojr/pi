import { createHash } from "node:crypto";

export const TASK_SNAPSHOT_CUSTOM_TYPE = "task-manager:snapshot";
export const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

export type TaskStatus = "pending" | "paused" | "in_progress" | "done";

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  lane: string;
  model: string;
  background: boolean;
  parentId?: string;
  sessionTree: string;
  dependsOn: string[];
  notes: string[];
  blocker?: string;
  blockedByTaskId?: string;
  usage: TaskUsage;
  sessionFile?: string;
  sessionId?: string;
  parentSessionId?: string;
  forkLeafId?: string;
  summary?: string;
  summaryDeliveredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskState {
  tasks: Record<string, Task>;
  nextId: number;
}

export interface TaskSnapshot {
  version: 1;
  createdAt: string;
  state: TaskState;
}

export interface UpdateTaskInput {
  taskId: string;
  status?: TaskStatus;
  title?: string;
  description?: string;
  lane?: string;
  model?: string;
  background?: boolean;
  parentId?: string;
  dependsOn?: string[];
  note?: string;
  blocker?: string;
  clearBlocker?: boolean;
  blockedByTaskId?: string;
  clearBlockedBy?: boolean;
  inputTokensDelta?: number;
  outputTokensDelta?: number;
  costUsdDelta?: number;
  sessionFile?: string;
  sessionId?: string;
  parentSessionId?: string;
  forkLeafId?: string;
  summary?: string;
  summaryDeliveredAt?: string;
  lastActivityAt?: string;
  updatedAt: string;
}

export function createInitialState(): TaskState {
  return {
    tasks: {},
    nextId: 1,
  };
}

export function snapshotState(state: TaskState): TaskState {
  return structuredClone(state);
}

const MAX_TASKS = 200;

export function createTask(
  state: TaskState,
  title: string,
  description: string | undefined,
  createdAt: string,
  lane?: string,
  dependsOn: string[] = [],
  model?: string,
  background = true,
  parentId?: string,
): { state: TaskState; task: Task } {
  if (Object.keys(state.tasks).length >= MAX_TASKS) {
    throw new Error(`Task cap reached (${MAX_TASKS}). Remove completed tasks first.`);
  }
  const id = `task-${state.nextId}`;
  const nextLane = lane && lane.trim().length > 0 ? lane.trim() : id;
  const taskModel = resolveTaskModel(state.tasks, dependsOn, model);
  const task: Task = {
    id,
    title,
    ...(description ? { description } : {}),
    status: "pending",
    lane: nextLane,
    model: taskModel,
    background,
    ...(parentId ? { parentId } : {}),
    sessionTree: buildSessionTreeName(id, title, nextLane, createdAt),
    dependsOn,
    notes: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
  };

  return {
    task,
    state: {
      tasks: {
        ...state.tasks,
        [id]: task,
      },
      nextId: state.nextId + 1,
    },
  };
}

export function updateTask(
  state: TaskState,
  input: UpdateTaskInput,
): { state: TaskState; task?: Task; error?: string } {
  const existing = state.tasks[input.taskId];
  if (!existing) {
    return { state, error: `Task not found: ${input.taskId}` };
  }

  const nextUsage: TaskUsage = {
    inputTokens: existing.usage.inputTokens,
    outputTokens: existing.usage.outputTokens,
    costUsd: existing.usage.costUsd,
  };

  if (typeof input.inputTokensDelta === "number") {
    nextUsage.inputTokens += input.inputTokensDelta;
  }
  if (typeof input.outputTokensDelta === "number") {
    nextUsage.outputTokens += input.outputTokensDelta;
  }
  if (typeof input.costUsdDelta === "number") {
    nextUsage.costUsd += input.costUsdDelta;
  }

  const nextDependsOn = input.dependsOn ?? existing.dependsOn;
  const nextModel = input.model
    ? input.model
    : input.dependsOn
      ? resolveTaskModel(state.tasks, nextDependsOn, undefined, existing.model)
      : existing.model;
  const starting = input.status === "in_progress" && existing.status !== "in_progress";
  const finishing = input.status === "done" && existing.status === "in_progress";

  const next: Task = {
    ...existing,
    ...(input.status ? { status: input.status } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
    ...(input.background !== undefined ? { background: input.background } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    model: nextModel,
    ...(input.sessionFile !== undefined ? { sessionFile: input.sessionFile } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.forkLeafId !== undefined ? { forkLeafId: input.forkLeafId } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.summaryDeliveredAt !== undefined ? { summaryDeliveredAt: input.summaryDeliveredAt } : {}),
    ...(starting ? { startedAt: input.updatedAt } : {}),
    ...(finishing ? { finishedAt: input.updatedAt } : {}),
    lastActivityAt: input.lastActivityAt ?? (starting ? input.updatedAt : existing.lastActivityAt),
    notes: input.note ? [...existing.notes, input.note] : existing.notes,
    usage: nextUsage,
    updatedAt: input.updatedAt,
  };

  if (starting) {
    delete next.finishedAt;
    delete next.summary;
    delete next.summaryDeliveredAt;
  }
  if (input.blocker) {
    next.blocker = input.blocker;
  }
  if (input.clearBlocker) {
    delete next.blocker;
  }
  if (input.blockedByTaskId !== undefined) {
    next.blockedByTaskId = input.blockedByTaskId;
  }
  if (input.clearBlockedBy) {
    delete next.blockedByTaskId;
  }

  return {
    task: next,
    state: {
      ...state,
      tasks: {
        ...state.tasks,
        [next.id]: next,
      },
    },
  };
}

export function removeTask(
  state: TaskState,
  taskId: string,
): { state: TaskState; removed?: Task; error?: string } {
  const existing = state.tasks[taskId];
  if (!existing) {
    return { state, error: `Task not found: ${taskId}` };
  }

  const nextTasks = { ...state.tasks };
  delete nextTasks[taskId];

  for (const [currentTaskId, task] of Object.entries(nextTasks)) {
    const nextTask = { ...task };
    let changed = false;
    if (task.dependsOn.includes(taskId)) {
      nextTask.dependsOn = task.dependsOn.filter((dependencyTaskId) => dependencyTaskId !== taskId);
      changed = true;
    }
    if (task.blockedByTaskId === taskId) {
      delete nextTask.blockedByTaskId;
      changed = true;
    }
    if (changed) nextTasks[currentTaskId] = nextTask;
  }

  return {
    removed: existing,
    state: {
      ...state,
      tasks: nextTasks,
    },
  };
}

export function clearTasks(): TaskState {
  return createInitialState();
}

export function getTask(state: TaskState, taskId: string): Task | undefined {
  return state.tasks[taskId];
}

export function listTasks(
  state: TaskState,
  status: TaskStatus | undefined,
): Task[] {
  const tasks = Object.values(state.tasks);
  const filtered = status ? tasks.filter((task) => task.status === status) : tasks;
  return filtered.sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
}

export function listTasksTreeOrder(state: TaskState): Task[] {
  const tasks = listTasks(state, undefined);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const primaryParent = new Map<string, string | undefined>();
  const children = new Map<string, Task[]>();

  for (const task of tasks) {
    const parentId = task.dependsOn.find((dependencyTaskId) => byId.has(dependencyTaskId));
    primaryParent.set(task.id, parentId);
    if (!parentId) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(task);
    children.set(parentId, bucket);
  }

  for (const bucket of children.values()) {
    bucket.sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
  }

  const result: Task[] = [];
  const visited = new Set<string>();
  const roots = tasks.filter((task) => !primaryParent.get(task.id));

  for (const root of roots) {
    visitTree(root, children, visited, result);
  }

  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    visitTree(task, children, visited, result);
  }

  return result;
}

export function taskBlocker(state: TaskState, task: Task): string | undefined {
  if (task.status === "done") return undefined;
  if (task.blockedByTaskId) {
    const blockerTask = state.tasks[task.blockedByTaskId];
    if (blockerTask && blockerTask.status !== "done") {
      return task.blocker ?? `waiting for ${task.blockedByTaskId}`;
    }
  }
  if (task.blocker) return task.blocker;
  // Cycle detection
  const seen = new Set<string>();
  const stack = [...task.dependsOn];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === task.id) return `dependency cycle detected involving ${task.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = state.tasks[id];
    if (dep && dep.status !== "done") {
      for (const d of dep.dependsOn) stack.push(d);
    }
  }
  const waiting = task.dependsOn.filter((id) => state.tasks[id]?.status !== "done");
  if (waiting.length === 0) return undefined;
  return `waiting for ${waiting.map((id) => state.tasks[id] ? id : `${id} (missing)`).join(", ")}`;
}

export function listBlockedTasks(state: TaskState): Task[] {
  return listTasks(state, undefined).filter((task) => Boolean(taskBlocker(state, task)));
}

export function listParallelRunnableTasks(state: TaskState): Task[] {
  return listTasks(state, "pending").filter((task) => canRunInParallel(state, task));
}

export function listStuckTasks(
  state: TaskState,
  nowIso = new Date().toISOString(),
  thresholdMs = STUCK_THRESHOLD_MS,
): Task[] {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return [];
  return listTasks(state, undefined).filter((task) => isTaskStuck(task, now, thresholdMs));
}

export function canRunInParallel(state: TaskState, task: Task): boolean {
  if (task.status !== "pending") return false;
  return !taskBlocker(state, task);
}

export function isTaskStuck(task: Task, nowMs: number, thresholdMs = STUCK_THRESHOLD_MS): boolean {
  if (task.status !== "in_progress") return false;
  const lastActivity = Date.parse(task.lastActivityAt);
  if (!Number.isFinite(lastActivity) || !Number.isFinite(nowMs)) return false;
  return nowMs - lastActivity >= thresholdMs;
}

export function buildSessionTreeName(
  taskId: string,
  title: string,
  lane: string,
  createdAt: string,
): string {
  const source = `${taskId}|${title}|${lane}|${createdAt}`;
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
  return `${taskId}-${hash}`;
}

function resolveTaskModel(
  tasks: Record<string, Task>,
  dependsOn: string[],
  explicitModel: string | undefined,
  fallbackModel = "default",
): string {
  const explicit = explicitModel?.trim();
  if (explicit && explicit.length > 0) return explicit;

  for (const dependencyTaskId of dependsOn) {
    const dependencyTask = tasks[dependencyTaskId];
    if (dependencyTask?.model && dependencyTask.model.trim().length > 0) {
      return dependencyTask.model;
    }
  }

  return fallbackModel;
}

function visitTree(
  task: Task,
  children: Map<string, Task[]>,
  visited: Set<string>,
  result: Task[],
): void {
  if (visited.has(task.id)) return;
  visited.add(task.id);
  result.push(task);

  const childTasks = children.get(task.id) ?? [];
  for (const child of childTasks) {
    visitTree(child, children, visited, result);
  }
}

function taskNumber(taskId: string): number {
  const match = /^task-(\d+)$/.exec(taskId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

