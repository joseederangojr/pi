import {
  buildSessionTreeName,
  createInitialState,
  snapshotState,
  TASK_SNAPSHOT_CUSTOM_TYPE,
  type Task,
  type TaskSnapshot,
  type TaskState,
  type TaskStatus,
} from "./model.ts";

export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface TaskRuntimeStore {
  getState(): TaskState;
  replay(entries: BranchEntry[]): TaskState;
  commit(nextState: TaskState, appendEntry: (customType: string, data: TaskSnapshot) => void): TaskState;
}

export function createTaskRuntimeStore(
  initialState: TaskState = createInitialState(),
): TaskRuntimeStore {
  let state = snapshotState(initialState);

  return {
    getState() {
      return state;
    },
    replay(entries) {
      state = replayState(entries);
      return state;
    },
    commit(nextState, appendEntry) {
      const normalized = normalizeState(nextState);
      // Append first; only advance in-memory state on success.
      appendEntry(TASK_SNAPSHOT_CUSTOM_TYPE, {
        version: 1,
        createdAt: new Date().toISOString(),
        state: snapshotState(normalized),
      });
      state = normalized;
      return state;
    },
  };
}

export function replayState(entries: BranchEntry[]): TaskState {
  let state = createInitialState();

  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== TASK_SNAPSHOT_CUSTOM_TYPE) continue;
    if (!isTaskSnapshot(entry.data)) continue;
    state = normalizeState(entry.data.state);
  }

  return state;
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<TaskSnapshot>;
  if (maybe.version !== 1) return false;
  if (!maybe.state || typeof maybe.state !== "object") return false;
  return true;
}

export function normalizeState(state: TaskState): TaskState {
  const nextTasks: Record<string, Task> = {};

  for (const [taskId, task] of Object.entries(state.tasks ?? {})) {
    const status = normalizeStatus(task.status);
    const lane = typeof task.lane === "string" && task.lane.length > 0 ? task.lane : taskId;
    const title = typeof task.title === "string" && task.title.length > 0 ? task.title : taskId;
    const createdAt =
      typeof task.createdAt === "string" && task.createdAt.length > 0
        ? task.createdAt
        : new Date(0).toISOString();

    nextTasks[taskId] = {
      ...task,
      id: taskId,
      title,
      createdAt,
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : createdAt,
      lastActivityAt: typeof task.lastActivityAt === "string" ? task.lastActivityAt : task.updatedAt ?? createdAt,
      status,
      lane,
      model: typeof task.model === "string" && task.model.trim().length > 0 ? task.model.trim() : "",
      background: task.background !== false,
      sessionTree:
        typeof task.sessionTree === "string" && task.sessionTree.trim().length > 0
          ? task.sessionTree.trim()
          : buildSessionTreeName(taskId, title, lane, createdAt),
      dependsOn: Array.isArray(task.dependsOn)
        ? task.dependsOn.filter((value): value is string => typeof value === "string")
        : [],
      notes: Array.isArray(task.notes) ? task.notes.filter((note): note is string => typeof note === "string") : [],
      usage: {
        inputTokens: toNumber(task.usage?.inputTokens),
        outputTokens: toNumber(task.usage?.outputTokens),
        costUsd: toNumber(task.usage?.costUsd),
      },
    };
  }

  // Resolve transitive model inheritance to a fixpoint.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of Object.values(nextTasks)) {
      if (task.model.length > 0 && task.model !== "default") continue;
      const inherited = inheritedModel(nextTasks, task.dependsOn);
      if (inherited && inherited !== task.model) {
        task.model = inherited;
        changed = true;
      } else if (!inherited && task.model.length === 0) {
        task.model = "default";
      }
    }
  }
  for (const task of Object.values(nextTasks)) {
    if (task.model.length === 0) task.model = "default";
  }

  return {
    tasks: nextTasks,
    nextId: Math.max(
      typeof state.nextId === "number" && Number.isFinite(state.nextId) ? Math.floor(state.nextId) : 1,
      nextIdFromTasks(nextTasks),
    ),
  };
}

function normalizeStatus(status: TaskStatus | undefined): TaskStatus {
  if (status === "pending" || status === "paused" || status === "in_progress" || status === "done") return status;
  return "pending";
}

function toNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function nextIdFromTasks(tasks: Record<string, Task>): number {
  let max = 0;
  for (const taskId of Object.keys(tasks)) {
    const match = /^task-(\d+)$/.exec(taskId);
    if (!match) continue;
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  return max + 1;
}

function inheritedModel(tasks: Record<string, Task>, dependsOn: string[]): string | undefined {
  for (const dependencyTaskId of dependsOn) {
    const dependencyTask = tasks[dependencyTaskId];
    if (!dependencyTask?.model) continue;
    const model = dependencyTask.model.trim();
    if (model.length > 0 && model !== "default") return model;
  }
  return undefined;
}

