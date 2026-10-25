import { listStuckTasks, type Task, type TaskState } from "./model.ts";

/** Notify once per idle episode; fresh activity or stopping re-arms the warning. */
export function createStuckReporter(): (state: TaskState, nowIso?: string) => Task[] {
  const reported = new Map<string, string>();
  return (state, nowIso = new Date().toISOString()) => {
    const stuck = listStuckTasks(state, nowIso);
    const stuckIds = new Set(stuck.map((task) => task.id));
    for (const id of reported.keys()) {
      if (!stuckIds.has(id)) reported.delete(id);
    }
    return stuck.filter((task) => {
      if (reported.get(task.id) === task.lastActivityAt) return false;
      reported.set(task.id, task.lastActivityAt);
      return true;
    });
  };
}

