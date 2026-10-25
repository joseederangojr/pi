import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Input, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { captureTaskFork, captureTaskForkFromSession, createTaskExecutor, hasUnresolvedToolCalls, type TaskFork, type WorkerFactory } from "./src/execution.ts";
import { createStuckReporter } from "./src/health.ts";
import {
  createTask, getTask, listBlockedTasks, listParallelRunnableTasks, listTasksTreeOrder,
  removeTask, taskBlocker, updateTask, type Task, type TaskState, type UpdateTaskInput,
} from "./src/model.ts";
import {
  formatBlockerSummary, formatStuckSummary, formatTaskList, formatTaskPeek,
  formatTaskTree, formatTaskWidget,
} from "./src/render.ts";
import { createTaskRuntimeStore } from "./src/store.ts";

const MERGE_TYPE = "task-manager:merge-summary";
export const TASK_STATE_EVENT = "task-manager:state";
const STATE_FILE = "task-manager-state.json";
const statusSchema = Type.Union([Type.Literal("pending"), Type.Literal("paused"), Type.Literal("in_progress"), Type.Literal("done")]);
const dependenciesSchema = Type.Array(Type.String(), { maxItems: 20 });
type Action = "start" | "force-start" | "stop" | "pause" | "remove" | "clear-all" | "restart";

export default function taskManagerExtension(pi: ExtensionAPI): void {
  registerTaskManager(pi);
}

/** The optional factory keeps native Node tests independent of providers and credentials. */
export function registerTaskManager(pi: ExtensionAPI, workerFactory?: WorkerFactory): void {
  const store = createTaskRuntimeStore();
  const queued = new Set<string>();
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let visible = true;
  let focused = false;
  let widgetFrame = 0;
  let widgetRegistered = false;
  let widgetTui: any;
  let popupOpen = false;
  let placement: "aboveEditor" | "belowEditor" = "aboveEditor";
  let selected: string | undefined;
  let pending: { action: Action; taskId: string | undefined } | undefined;
  const pendingQuestions = new Map<string, (answer: string) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let detachInput: (() => void) | undefined;
  let reportStuck = createStuckReporter();

  const executor = createTaskExecutor({
    update(task, fork, patch) {
      if (owns(task, fork)) patchTask({ taskId: task.id, ...patch, updatedAt: now() });
    },
    complete(task, fork, summary) {
      if (!owns(task, fork)) return;
      patchTask({ taskId: task.id, status: "done", summary, clearBlocker: true, updatedAt: now() });
      deliverSummary(task.id);
      context?.ui.notify(`Completed ${task.id}; task-session summary merged.`, "info");
      autoStartDependents(task.id);
      commit(removeTask(store.getState(), task.id).state);
    },
    failed(task, fork, reason) {
      if (!owns(task, fork)) return;
      patchTask({ taskId: task.id, status: "pending", blocker: `Worker failed: ${reason}`, note: reason, updatedAt: now() });
      context?.ui.notify(`${task.id} failed: ${reason}`, "error");
    },
    question(task, fork, question) {
      if (!owns(task, fork)) throw new Error("Not owner");
      context?.ui.notify(`${task.id} asks: ${question}`, "info");
      // Surface the question to the main agent as a follow-up message.
      pi.sendMessage({
        customType: "task-manager:question",
        content: `Task ${task.id} needs clarification:\n${question}\n\nReply with: /tasks steer ${task.id} <your answer>`,
        display: true,
        details: { taskId: task.id },
      }, { triggerTurn: true, deliverAs: "followUp" });
      return new Promise<string>((resolve) => {
        pendingQuestions.set(task.id, resolve);
      });
    },
  }, workerFactory);

  function owns(task: Task, fork: TaskFork): boolean {
    return sessionId === fork.parentId && context?.sessionManager.getSessionId() === fork.parentId &&
      store.getState().tasks[task.id]?.sessionTree === task.sessionTree;
  }

  function commit(state: TaskState): void {
    const committed = store.commit(state, (type, data) => pi.appendEntry(type, data));
    try { pi.events.emit(TASK_STATE_EVENT, { state: structuredClone(committed) }); } catch { /* ignore */ }
    persistStateFile(committed);
    renderUi();
  }

  function persistStateFile(state: TaskState): void {
    try {
      const dir = join(context?.cwd ?? process.cwd(), ".pi");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, STATE_FILE);
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ version: 1, state }, null, 2), { mode: 0o600 });
      // atomic rename
      renameSync(tmp, target);
    } catch { /* best effort */ }
  }

  function exportMarkdown(state: TaskState): string {
    const lines: string[] = ["# Task Manager State", ""];
    for (const task of listTasksTreeOrder(state)) {
      lines.push(`## ${task.id}: ${task.title}`);
      lines.push(`- Status: ${task.status}`);
      lines.push(`- Lane: ${task.lane}`);
      if (task.parentId) lines.push(`- Parent: ${task.parentId}`);
      if (task.dependsOn.length) lines.push(`- Depends on: ${task.dependsOn.join(", ")}`);
      if (task.blocker) lines.push(`- Blocker: ${task.blocker}`);
      lines.push(`- Model: ${task.model}`);
      lines.push(`- Usage: in=${task.usage.inputTokens} out=${task.usage.outputTokens} cost=$${task.usage.costUsd.toFixed(4)}`);
      if (task.sessionFile) lines.push(`- Session: ${task.sessionTree} (${task.sessionFile})`);
      if (task.notes.length) { lines.push("- Notes:"); for (const n of task.notes) lines.push(`  - ${n.replace(/\n/g, " ")}`); }
      if (task.summary) { lines.push(""); lines.push("### Summary"); lines.push(task.summary.replace(/\n/g, " ")); }
      lines.push("");
    }
    return lines.join("\n");
  }

  function patchTask(input: UpdateTaskInput): Task {
    const result = updateTask(store.getState(), input);
    if (!result.task) throw new Error(result.error ?? "Task update failed.");
    commit(result.state);
    return result.task;
  }

  function renderUi(): void {
    if (!context) return;
    const state = store.getState();
    const tasks = listTasksTreeOrder(state);
    if (!selected || !state.tasks[selected]) selected = tasks[0]?.id;
    context.ui.setStatus("task-manager", `tasks ${tasks.filter((task) => task.status === "in_progress").length} running · ${listBlockedTasks(state).length} blocked`);
    if (!visible) {
      if (widgetRegistered) { context.ui.setWidget("task-manager", undefined); widgetRegistered = false; widgetTui = undefined; }
      return;
    }
    widgetFrame = (widgetFrame + 1) % 1000;
    const focusedNow = focused;
    if (!widgetRegistered) {
      context.ui.setWidget("task-manager", (tui: any, _theme: any) => {
        widgetTui = tui;
        return {
          render: (width: number) => {
            const s = store.getState();
            const ts = listTasksTreeOrder(s);
            if (!selected || !s.tasks[selected]) selected = ts[0]?.id;
            const lines = formatTaskWidget(s, {
              selectedTaskId: selected,
              pendingConfirmation: pending ? `${pending.action}${pending.taskId ? ` ${pending.taskId}` : ""}` : undefined,
            }, 10, new Date().toISOString(), widgetFrame);
            if (focusedNow && lines.length > 0) lines[0] += " [focused]";
            return lines.map((line: string) => truncateToWidth(line, width));
          },
          invalidate() {},
        };
      }, { placement });
      widgetRegistered = true;
    } else if (widgetTui) {
      widgetTui.requestRender();
    }
  }

  function deliverSummary(taskId: string): void {
    const task = store.getState().tasks[taskId];
    if (!task?.summary || task.summaryDeliveredAt) return;
    pi.sendMessage({
      customType: MERGE_TYPE,
      content: `Task ${task.id}: ${task.title}\nSession: ${task.sessionTree}\n\n${task.summary}`,
      display: true,
      details: { taskId: task.id, sessionId: task.sessionId, sessionFile: task.sessionFile },
    }, { triggerTurn: false, deliverAs: "followUp" });
    patchTask({ taskId, summaryDeliveredAt: now(), updatedAt: now() });
  }

  function autoStartDependents(completedTaskId: string): void {
    if (!context) return;
    const state = store.getState();
    // Clear blockers that explicitly link to the completed task.
    for (const task of Object.values(state.tasks)) {
      if (task.status !== "pending") continue;
      if (task.blockedByTaskId === completedTaskId) {
        patchTask({ taskId: task.id, clearBlocker: true, clearBlockedBy: true, updatedAt: now() });
      }
    }
    const fresh = store.getState();
    for (const task of Object.values(fresh.tasks)) {
      if (task.status !== "pending") continue;
      const isDependent = task.dependsOn.includes(completedTaskId) || task.blockedByTaskId === completedTaskId;
      if (!isDependent) continue;
      if (taskBlocker(fresh, task)) continue;
      if (executor.isRunning(task.id) || queued.has(task.id)) continue;
      try { startTask(context, task.id); } catch { /* ignore blocked/unavailable */ }
    }
  }

  function startTask(ctx: ExtensionContext, taskId: string, force = false): void {
    const task = getTask(store.getState(), taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (executor.isRunning(taskId) || queued.has(taskId)) return;
    const blocker = taskBlocker(store.getState(), task);
    if (blocker && !force) throw new Error(`${taskId} blocked: ${blocker}`);
    if (!ctx.model) throw new Error("Select a model before starting tasks.");
    patchTask({
      taskId, status: "in_progress", clearBlocker: force, clearBlockedBy: force,
      ...(task.model === "default" ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
      ...(force && blocker ? { note: `Force-started despite: ${blocker}` } : {}),
      updatedAt: now(),
    });
    // Mark a named branch point in the main session tree (discoverable via /tree).
    try {
      const sm = ctx.sessionManager as any;
      const leaf = sm.getLeafId();
      if (leaf) {
        sm.branch(leaf);
        sm.appendLabelChange(leaf, taskId);
        sm.branch(leaf);
      }
    } catch { /* ignore if not supported */ }
    // Try to start immediately; queue only if the session is not yet in a safe state.
    const branch = ctx.sessionManager.getBranch();
    if (hasUnresolvedToolCalls(branch)) {
      queued.add(taskId);
      // Retry shortly in case the tool call resolves quickly.
      setTimeout(() => { try { flushQueue(ctx); } catch { /* ignore */ } }, 50);
    } else {
      launchTask(ctx, taskId);
    }
  }

  function launchTask(ctx: ExtensionContext, taskId: string): void {
    const task = store.getState().tasks[taskId];
    if (!task || task.status !== "in_progress") return;
    try {
      const thinkingLevel = pi.getThinkingLevel();
      const parentTask = task.parentId ? store.getState().tasks[task.parentId] : undefined;
      let fork: TaskFork;
      if (parentTask?.sessionFile) {
        const model =
          task.model === "default" || task.model === `${ctx.model?.provider}/${ctx.model?.id}`
            ? ctx.model!
            : ctx.modelRegistry.getAvailable().find((candidate) =>
                task.model === candidate.id || task.model === `${candidate.provider}/${candidate.id}`,
              );
        if (!model) throw new Error(`Task model unavailable: ${task.model}`);
        fork = captureTaskForkFromSession(parentTask, model, thinkingLevel);
      } else {
        fork = captureTaskFork(ctx, thinkingLevel);
        if (task.model !== "default" && task.model !== `${fork.model.provider}/${fork.model.id}`) {
          const model = ctx.modelRegistry.getAvailable().find((candidate) =>
            task.model === candidate.id || task.model === `${candidate.provider}/${candidate.id}`,
          );
          if (!model) throw new Error(`Task model unavailable: ${task.model}`);
          fork.model = model;
        }
      }
      void executor.start(task, fork).catch((error: unknown) => {
        if (owns(task, fork)) ctx.ui.notify(errorText(error), "error");
      });
    } catch (error) {
      patchTask({ taskId, status: "pending", blocker: errorText(error), updatedAt: now() });
      ctx.ui.notify(`${taskId}: ${errorText(error)}`, "error");
    }
  }

  function flushQueue(ctx: ExtensionContext): void {
    if (queued.size === 0) return;
    if (hasUnresolvedToolCalls(ctx.sessionManager.getBranch())) return;
    for (const taskId of [...queued]) {
      queued.delete(taskId);
      launchTask(ctx, taskId);
    }
  }

  async function stopTask(taskId: string, visited: Set<string> = new Set()): Promise<void> {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    queued.delete(taskId);
    await executor.cancel(taskId);
    const state = store.getState();
    if (state.tasks[taskId]?.status === "in_progress" || state.tasks[taskId]?.status === "paused") {
      patchTask({ taskId, status: "pending", note: "Stopped/cancelled.", updatedAt: now() });
    }
    // Cascade: stop descendants (dependents or children).
    const descendants = Object.values(state.tasks).filter(
      (task) => task.id !== taskId && (task.dependsOn.includes(taskId) || task.parentId === taskId),
    );
    for (const descendant of descendants) {
      await stopTask(descendant.id, visited);
      if (store.getState().tasks[descendant.id]) {
        patchTask({ taskId: descendant.id, status: "pending", blocker: `Parent ${taskId} stopped.`, updatedAt: now() });
      }
    }
  }

  async function pauseTask(taskId: string): Promise<void> {
    queued.delete(taskId);
    await executor.cancel(taskId);
    if (store.getState().tasks[taskId]?.status === "in_progress") {
      patchTask({ taskId, status: "paused", note: "Paused.", updatedAt: now() });
    }
    context?.ui.notify(`Paused ${taskId}.`, "info");
  }

  async function steerTask(taskId: string, text: string): Promise<void> {
    const resolver = pendingQuestions.get(taskId);
    if (resolver) {
      pendingQuestions.delete(taskId);
      resolver(text.trim());
      patchTask({ taskId, note: `Answered: ${text.trim()}`, updatedAt: now() });
      context?.ui.notify(`Answered ${taskId}.`, "info");
      return;
    }
    if (!text.trim()) throw new Error("Steering message is required.");
    await executor.steer(taskId, text.trim());
    patchTask({ taskId, note: `Steered: ${text.trim()}`, updatedAt: now() });
    context?.ui.notify(`Steered ${taskId}.`, "info");
  }

  async function broadcastTask(text: string): Promise<void> {
    if (!text.trim()) throw new Error("Broadcast message is required.");
    // Derive running tasks from store + executor.
    const ids = Object.values(store.getState().tasks)
      .filter((task) => task.status === "in_progress" && executor.isRunning(task.id))
      .map((task) => task.id);
    if (ids.length === 0) throw new Error("No running tasks to broadcast to.");
    await Promise.all(ids.map((id) => executor.steer(id, text.trim())));
    for (const id of ids) patchTask({ taskId: id, note: `Broadcast: ${text.trim()}`, updatedAt: now() });
    context?.ui.notify(`Broadcast to ${ids.length} task(s).`, "info");
  }

  async function stopAll(): Promise<void> {
    queued.clear();
    await executor.cancelAll();
    // Leave status for replay() to mark as interrupted; manual stops patch explicitly.
  }

  function disposeUi(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    detachInput?.();
    detachInput = undefined;
    focused = false;
    pending = undefined;
    if (widgetRegistered) { try { context?.ui.setWidget("task-manager", undefined); } catch {} widgetRegistered = false; widgetTui = undefined; }
  }

  async function replay(ctx: ExtensionContext): Promise<void> {
    await stopAll();
    disposeUi();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    store.replay(ctx.sessionManager.getBranch());
    reportStuck = createStuckReporter();
    for (const task of Object.values(store.getState().tasks)) {
      if (task.status === "in_progress") {
        patchTask({ taskId: task.id, status: "pending", clearBlocker: true, note: "Resumed from previous session.", updatedAt: now() });
      }
    }
    // Auto-start unfinished/open runnable tasks on session start/resume/restart.
    for (const task of Object.values(store.getState().tasks)) {
      if (task.status !== "pending") continue;
      if (taskBlocker(store.getState(), task)) continue;
      if (executor.isRunning(task.id) || queued.has(task.id)) continue;
      try { startTask(ctx, task.id, true); } catch { /* ignore */ }
    }
    // No global keystroke capture: the editor consumes arrow keys, so interactive
    // navigation lives in the /tasks overlay (ctx.ui.custom) where the component
    // receives all input. This keeps normal editor input fully intact.
    detachInput = undefined;
    timer = setInterval(() => {
      for (const task of reportStuck(store.getState())) {
        ctx.ui.notify(`${task.id} may be stuck: no worker activity for 15 minutes. Peek or stop it to investigate.`, "warning");
      }
      renderUi();
    }, 150);
    timer.unref();
    renderUi();
  }

  pi.on("session_start", async (_event, ctx) => replay(ctx));
  pi.on("session_tree", async (_event, ctx) => replay(ctx));
  pi.on("session_before_switch", async () => { await stopAll(); });
  pi.on("session_before_tree", async () => { await stopAll(); });
  pi.on("session_before_fork", async () => { await stopAll(); });
  pi.on("session_shutdown", async () => { await stopAll(); disposeUi(); context = undefined; });
  pi.on("turn_end", async (_event, ctx) => { context = ctx; flushQueue(ctx); });
  pi.on("agent_settled", async (_event, ctx) => { context = ctx; flushQueue(ctx); });
  pi.on("before_agent_start", async (event) => {
    const guidance = `\n\n# Task Manager\n\nYou are an intelligent task manager responsible for analyzing user requests and breaking complex work into actionable, dependency-aware microtasks. Your responsibility is planning, not execution.\n\n## Workflow\n\n1. Analyze: Identify the objective, requirements, constraints, deliverables, and expected outcomes.\n2. Assess: Determine whether decomposition is necessary. Keep simple requests as single tasks or answer directly without creating tasks.\n3. Decompose: Split complex work into small, cohesive, independently verifiable tasks.\n4. Organize: Group related tasks when useful. Avoid unnecessary hierarchy.\n5. Resolve Dependencies: Identify blocking relationships, parallelizable tasks, and potential execution conflicts.\n6. Sequence: Arrange tasks in dependency-aware execution waves.\n7. Validate: Ensure complete requirement coverage, clear acceptance criteria, and a valid dependency graph.\n\n## Microtask Rules\n\nEach task must:\n- Have one clear responsibility and measurable outcome.\n- Be independently executable and verifiable.\n- Include sufficient context without requiring the original request.\n- Define concrete deliverables and acceptance criteria.\n- Declare blocking dependencies explicitly (use depends_on).\n- Avoid overlapping ownership with other tasks.\n- Be small enough for focused execution without excessive fragmentation.\n- Not split tightly coupled operations unless doing so improves execution, delegation, or verification.\n\n## Dependency Rules\n\n- Model dependencies as a directed acyclic graph (DAG) via depends_on.\n- Never introduce artificial dependencies.\n- Allow independent tasks to execute concurrently (tasks run in the background).\n- Identify shared resources that could cause conflicts.\n- Schedule integration after its prerequisites.\n- Group ready tasks into execution waves without unnecessary synchronization barriers.\n\n## Task Structure (task_create / task_update)\n\nEach task contains:\n- ID: auto-assigned (task-N).\n- Title: Short, action-oriented description.\n- Description: Specific scope and execution instructions.\n- Deliverable: Concrete expected output.\n- Acceptance Criteria: Verifiable completion conditions.\n- Dependencies: Blocking task IDs via depends_on, or none.\n- Status: Pending by default; use task_update status=in_progress to start.\n- Optional: lane, model, parent_id, blocker/clear_blocker, blocked_by/clear_blocked_by.\n\nInclude priority, grouping, risks, or assumptions only when relevant.\n\n## Rules\n\n- Preserve all user requirements and constraints.\n- Never invent requirements or technical decisions.\n- Avoid vague, redundant, or unnecessarily granular tasks.\n- Do not create separate research, documentation, or testing tasks unless justified.\n- Ask for clarification only when missing information blocks meaningful planning.\n- When updating plans, preserve valid tasks, IDs, and statuses; modify only affected tasks.\n- Never claim planned work is completed.\n- Validate coverage, task independence, dependency integrity, and scope before responding.\n\nCore principle: Create the smallest set of independently actionable tasks that fully satisfies the user's request, with enough detail for another agent to execute them without ambiguity.\n\n## Task Manager Actions\n\n- task_create: Create a pending task (title required; supports description, lane, model, background, depends_on, parent_id).\n- task_list: List tasks with optional status filter.\n- task_update: Update metadata or status (pending/in_progress/paused/done); use clear_blocker/clear_blocked_by to unblock; auto-starts when unblocked.\n- task_peek: Inspect a task's state, session, and live output without changes.\n- task_start (via task_update status=in_progress): Forks an independent background session.\n- task_steer: Send a message to a running worker (use this to answer task questions).\n\nWhen a task sends a question (task-manager:question message), answer it autonomously via task_steer unless the question requires user input. If you cannot answer the question yourself, check whether an ask_user_question tool is available and use it to ask the user; after receiving the user\'s answer, you MUST immediately call task_steer with that answer so the worker resumes — do not ask the user to run /tasks steer manually.\n\nIf the request can be answered directly, answer it without creating tasks.`;
    return { systemPrompt: `${event.systemPrompt}${guidance}` };
  });
  const focusHandler = async (ctx: any) => {
    visible = true; renderUi();
    await openTaskOverlay(ctx);
  };
  for (const key of [Key.ctrlAlt("up"), Key.ctrlAlt("t")]) {
    try {
      pi.registerShortcut(key, { description: "Focus task widget (no popup)", handler: focusHandler });
    } catch { /* optional */ }
  }


  pi.registerTool({
    name: "task_create", label: "Create task",
    description: "Create a pending background task. Start it with task_update status=in_progress. Tasks fork the main context and can run concurrently.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Type.String({ maxLength: 2000 })),
      lane: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      background: Type.Optional(Type.Boolean()), depends_on: Type.Optional(dependenciesSchema),
      parent_id: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      context = ctx;
      const title = params.title.trim();
      if (!title) throw new Error("title is required");
      const model = params.model ?? (!params.depends_on?.length && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const created = createTask(store.getState(), title, params.description, now(), params.lane, params.depends_on, model, params.background, params.parent_id);
      selected = created.task.id;
      pending = undefined;
      commit(created.state);
      // Auto-start if there are no blockers.
      if (!taskBlocker(created.state, created.task)) {
        try { startTask(ctx, created.task.id); } catch { /* ignore */ }
      }
      return textResult(`Created ${created.task.id}`, created.task);
    },
  });

  pi.registerTool({
    name: "task_list", label: "List tasks", description: "List tasks, blockers, worker metrics, and session names.",
    parameters: Type.Object({ status: Type.Optional(statusSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params) { return textResult(formatTaskList(store.getState(), params.status, params.limit)); },
  });

  pi.registerTool({
    name: "task_update", label: "Update task",
    description: "Start/stop a worker using in_progress/pending, or update task metadata. Done workers summarize their own session into the main conversation automatically.",
    parameters: Type.Object({
      task_id: Type.String({ minLength: 1 }), status: Type.Optional(statusSchema),
      title: Type.Optional(Type.String({ maxLength: 200 })), description: Type.Optional(Type.String({ maxLength: 2000 })), note: Type.Optional(Type.String({ maxLength: 2000 })),
      lane: Type.Optional(Type.String({ maxLength: 64 })), model: Type.Optional(Type.String({ maxLength: 128 })), background: Type.Optional(Type.Boolean()),
      depends_on: Type.Optional(dependenciesSchema), parent_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      blocker: Type.Optional(Type.String({ maxLength: 500 })), clear_blocker: Type.Optional(Type.Boolean()),
      blocked_by: Type.Optional(Type.String({ minLength: 1 })), clear_blocked_by: Type.Optional(Type.Boolean()),
      input_tokens_delta: Type.Optional(Type.Number({ minimum: 0 })), output_tokens_delta: Type.Optional(Type.Number({ minimum: 0 })),
      cost_usd_delta: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      context = ctx;
      if (params.status === "pending") await stopTask(params.task_id);
      if (params.status === "done" && executor.isRunning(params.task_id)) throw new Error("Worker is still running. Stop it first or wait for completion.");
      const patch: UpdateTaskInput = { taskId: params.task_id, updatedAt: now() };
      if (params.title !== undefined) patch.title = params.title;
      if (params.description !== undefined) patch.description = params.description;
      if (params.note !== undefined) patch.note = params.note;
      if (params.lane !== undefined) patch.lane = params.lane;
      if (params.model !== undefined) patch.model = params.model;
      if (params.background !== undefined) patch.background = params.background;
      if (params.depends_on !== undefined) patch.dependsOn = [...new Set(params.depends_on)];
      if (params.parent_id !== undefined) patch.parentId = params.parent_id;
      if (params.blocker !== undefined) patch.blocker = params.blocker;
      if (params.clear_blocker !== undefined) patch.clearBlocker = params.clear_blocker;
      if (params.blocked_by !== undefined) patch.blockedByTaskId = params.blocked_by;
      if (params.clear_blocked_by !== undefined) patch.clearBlockedBy = params.clear_blocked_by;
      if (params.input_tokens_delta !== undefined) patch.inputTokensDelta = params.input_tokens_delta;
      if (params.output_tokens_delta !== undefined) patch.outputTokensDelta = params.output_tokens_delta;
      if (params.cost_usd_delta !== undefined) patch.costUsdDelta = params.cost_usd_delta;
      if (params.status === "pending") patch.status = "pending";
      patchTask(patch);
      if (params.status === "in_progress") {
        try { startTask(ctx, params.task_id); } catch (error) { ctx.ui.notify(errorText(error), "error"); }
      }
      if (params.status === "done") finishManually(params.task_id, params.note);
      // Auto-start when a task becomes unblocked.
      if (params.clear_blocker || params.clear_blocked_by) {
        const t = getTask(store.getState(), params.task_id);
        if (t && t.status === "pending" && !taskBlocker(store.getState(), t)) {
          try { startTask(ctx, params.task_id); } catch { /* ignore */ }
        }
      }
      return textResult(`Updated ${params.task_id}`, store.getState().tasks[params.task_id]);
    },
  });

  pi.registerTool({
    name: "task_broadcast", label: "Broadcast to tasks", description: "Send a steering message to all running task workers.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      context = ctx;
      await broadcastTask(params.message);
      return textResult(`Broadcast sent`, store.getState());
    },
  });

  pi.registerTool({
    name: "task_steer", label: "Steer task", description: "Send a steering message to a running task worker without switching sessions.",
    parameters: Type.Object({ task_id: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      context = ctx;
      await steerTask(params.task_id, params.message);
      return textResult(`Steered ${params.task_id}`, store.getState().tasks[params.task_id]);
    },
  });

  pi.registerTool({
    name: "task_peek", label: "Peek task", description: "Inspect one task, its worker session path, summary, and live output without changing it.",
    parameters: Type.Object({ task_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const task = store.getState().tasks[params.task_id];
      if (!task) throw new Error(`Task not found: ${params.task_id}`);
      return textResult(peek(params.task_id), task);
    },
  });

  function peek(taskId: string): string {
    const output = executor.preview(taskId);
    return formatTaskPeek(store.getState(), taskId) + (output ? `\n\nWorker output:\n${output.slice(-4_000)}` : "");
  }

  async function openTaskPopup(ctx: ExtensionContext, taskId: string): Promise<void> {
    const input = new Input({ placeholder: "Type a steer message, Enter to send" });
    let mode: "normal" | "insert" = "normal";
    input.focused = false;
    let pendingConfirm: Action | null = null;

    popupOpen = true;
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const close = () => { if (streamTimer) clearInterval(streamTimer); streamTimer = undefined; popupOpen = false; done(); };
      let streamTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => { tui.requestRender(); }, 250);
      streamTimer.unref();
      let scrollOffset = 0;
      let lastTask: any = store.getState().tasks[taskId];
      let lastActivity: any[] = [];
      // use close instead of done below
      const renderInfo = (): string[] => {
        const task = store.getState().tasks[taskId];
        if (task) lastTask = task;
        const activity = typeof executor.activity === "function" ? executor.activity(taskId) : undefined;
        if (activity && activity.length > 0) lastActivity = activity;
        const t = task ?? lastTask;
        if (!t) return [theme.fg("error", `Task not found: ${taskId}`)];
        const blocker = taskBlocker(store.getState(), t);
        const lines: string[] = [];
        lines.push(theme.fg("accent", `${t.id} ${t.title}`));
        lines.push(theme.fg("muted", `status: ${t.status}${blocker ? `  blocker: ${blocker}` : ""}`));
        lines.push(theme.fg("muted", `lane: ${t.lane}  tree: ${t.sessionTree}`));
        lines.push(theme.fg("muted", `tokens: in=${t.usage.inputTokens} out=${t.usage.outputTokens}  $${t.usage.costUsd.toFixed(4)}`));
        if (t.description) lines.push(theme.fg("muted", `desc: ${t.description}`));
        const previewText = executor.preview(taskId);
        const src = lastActivity.length > 0 ? lastActivity : (previewText ? previewText.split(/\r?\n/) : []);
        if (src.length > 0) {
          lines.push(theme.fg("muted", "activity:"));
          const visible = 18;
          const total = src.length;
          const start = scrollOffset > 0
            ? Math.max(0, total - visible - scrollOffset)
            : Math.max(0, total - visible);
          const end = scrollOffset > 0 ? total - scrollOffset : total;
          for (const entry of src.slice(start, end)) {
            const text = typeof entry === "string" ? entry : entry.text;
            const status = typeof entry === "string" ? undefined : entry.status;
            const dotColor = status === "error" ? "error" : status === "done" ? "success" : status === "running" ? "accent" : "muted";
            if (text.startsWith("●") && theme?.fg) {
              lines.push("  " + theme.fg(dotColor, "●") + theme.fg("muted", text.slice(1)));
            } else {
              lines.push(theme.fg ? theme.fg("muted", `  ${text}`) : `  ${text}`);
            }
          }
          if (total > visible) lines.push(theme.fg("dim", `  (${start + 1}-${end} of ${total}) ↑/↓ scroll, End to tail`));
        }
        return lines;
      };

      const runAction = (action: () => Promise<void>) => {
        void action().then(() => tui.requestRender()).catch((error: unknown) => ctx.ui.notify(errorText(error), "error"));
      };

      const component = {
        render(width: number): string[] {
          const lines: string[] = [];
          lines.push(...renderInfo());
          lines.push("");
          if (mode === "insert") {
            lines.push(...input.render(width));
            lines.push("");
          }
          if (pendingConfirm) {
            lines.push(theme.fg("warning", `${pendingConfirm} ${taskId}? (y = yes, any other key = no)`));
          }
          lines.push(theme.fg("dim", mode === "insert" ? "-- INSERT (Esc: normal) --" : "NORMAL (i: insert, ↑/↓ scroll, s start, f force, p pause, x stop, r restart, d remove, Esc close)"));
          // Wrap content in a bordered box for clear boundaries.
          const innerWidth = Math.max(10, width - 2);
          const border = (ch: string) => theme?.fg ? theme.fg("muted", ch) : ch;
          const out: string[] = [];
          out.push(border("┌" + "─".repeat(Math.max(0, width - 2)) + "┐"));
          const box = new Box(1, 0);
          const inner = lines.length === 0 ? ["(no activity)"] : lines;
          for (const line of inner) box.addChild(new Text(line, 0, 0));
          for (const rendered of box.render(innerWidth)) {
            out.push(border("│") + rendered + " ".repeat(Math.max(0, width - 2 - rendered.length)) + border("│"));
          }
          out.push(border("└" + "─".repeat(Math.max(0, width - 2)) + "┘"));
          return out;
        },
        handleInput(data: string) {
          if (mode === "insert") {
            if (matchesKey(data, Key.escape)) { mode = "normal"; input.focused = false; tui.requestRender(); return; }
            if (matchesKey(data, Key.enter)) {
              const message = input.getValue().trim();
              if (message) {
                runAction(async () => { await steerTask(taskId, message); input.setValue(""); });
              }
              return;
            }
            input.handleInput(data);
            tui.requestRender();
            return;
          }
          // normal mode
          if (pendingConfirm) {
            if (data === "y" || data === "Y") {
              const action = pendingConfirm;
              pendingConfirm = null;
              if (action === "remove") runAction(async () => { await perform("remove", taskId, ctx); close(); });
              else runAction(() => perform(action, taskId, ctx));
            } else {
              pendingConfirm = null;
              tui.requestRender();
            }
            return;
          }
          if (data === "i") { mode = "insert"; input.focused = true; tui.requestRender(); return; }
          if (matchesKey(data, Key.escape)) { close(); return; }
          if (matchesKey(data, Key.up)) { scrollOffset = Math.min(scrollOffset + 1, 1000); tui.requestRender(); return; }
          if (matchesKey(data, Key.down)) { scrollOffset = Math.max(0, scrollOffset - 1); tui.requestRender(); return; }
          if (matchesKey(data, Key.pageUp)) { scrollOffset = Math.min(scrollOffset + 10, 1000); tui.requestRender(); return; }
          if (matchesKey(data, Key.pageDown)) { scrollOffset = Math.max(0, scrollOffset - 10); tui.requestRender(); return; }
          if (data === "End" || matchesKey(data, Key.end)) { scrollOffset = 0; tui.requestRender(); return; }
          if (data === "s") { pendingConfirm = "start"; tui.requestRender(); return; }
          if (data === "f") { pendingConfirm = "force-start"; tui.requestRender(); return; }
          if (data === "p") { pendingConfirm = "pause"; tui.requestRender(); return; }
          if (data === "x") { pendingConfirm = "stop"; tui.requestRender(); return; }
          if (data === "r") { pendingConfirm = "restart"; tui.requestRender(); return; }
          if (data === "d") { pendingConfirm = "remove"; tui.requestRender(); return; }
        },
        invalidate() { input.invalidate(); },
      };
      return component;
    }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } });
    renderUi();
  }

  function finishManually(taskId: string, note?: string): void {
    if (executor.isRunning(taskId)) throw new Error("Worker is still running. Stop it first or wait for completion.");
    queued.delete(taskId);
    const task = store.getState().tasks[taskId];
    if (!task) throw new Error(`Task not found: ${taskId}`);
    patchTask({ taskId, status: "done", summary: task.summary ?? `Marked done manually. ${note ?? task.notes.at(-1) ?? task.title}`, updatedAt: now() });
    deliverSummary(taskId);
    autoStartDependents(taskId);
    commit(removeTask(store.getState(), taskId).state);
  }

  async function perform(action: Action, taskId: string | undefined, ctx: ExtensionContext): Promise<void> {
    pending = undefined;
    if (action === "clear-all") {
      await stopAll();
      commit({ tasks: {}, nextId: store.getState().nextId });
      selected = undefined;
    } else {
      if (!taskId) throw new Error("No task selected.");
      if (action === "start" || action === "force-start") startTask(ctx, taskId, action === "force-start");
      if (action === "pause") await pauseTask(taskId);
      if (action === "restart") {
        if (executor.isRunning(taskId)) await stopTask(taskId);
        queued.delete(taskId);
        patchTask({ taskId, status: "pending", clearBlocker: true, note: "Restart requested.", updatedAt: now() });
        startTask(ctx, taskId, true);
      }
      if (action === "stop") await stopTask(taskId);
      if (action === "remove") {
        await stopTask(taskId);
        commit(removeTask(store.getState(), taskId).state);
      }
    }
    renderUi();
  }

  async function runCommand(args: string, ctx: ExtensionContext): Promise<void> {
    context = ctx;
    const [raw = "", ...rest] = args.trim().split(/\s+/);
    const aliases: Record<string, string> = { S: "force-start", s: "stop", P: "pause", p: "peek", d: "remove", x: "clear-all", o: "peek", j: "down", k: "up", r: "restart", R: "restart", restart: "restart", pause: "pause", steer: "steer", broadcast: "broadcast", bcast: "broadcast", export: "export", inspect: "peek", delete: "remove", clear: "clear-all", yes: "confirm", no: "cancel", finish: "done", ready: "parallel", fs: "force-start", enter: "peek" };
    const command = aliases[raw] ?? raw.toLowerCase();
    if (!command) { focused = true; visible = true; renderUi(); ctx.ui.notify("Task tree focused.", "info"); return; }
    if (command === "toggle") { visible = !visible; if (!visible) focused = false; renderUi(); return; }
    if (command === "focus") { focused = true; visible = true; renderUi(); ctx.ui.notify("Task tree focused. Use /tasks up|down|select|peek or Ctrl+Alt+↑ for the overlay.", "info"); return; }
    if (command === "overlay" || command === "ov") { visible = true; await openTaskOverlay(ctx); return; }
    if (command === "help" || command === "h") {
      const md = helpMarkdown();
      pi.sendMessage({ customType: "task-manager:help", content: md, display: true }, { triggerTurn: false, deliverAs: "followUp" });
      return;
    }
    if (command === "confirm") {
      if (!pending) throw new Error("No action pending confirmation.");
      await perform(pending.action, pending.taskId, ctx);
      return;
    }
    if (command === "cancel") { pending = undefined; renderUi(); return; }
    if (["start", "force-start", "stop", "pause", "remove", "clear-all", "restart"].includes(command)) {
      const action = command as Action;
      const taskId = action === "clear-all" ? undefined : (rest[0] ?? selected);
      if (action !== "clear-all" && !taskId) throw new Error("Task id required. Usage: /tasks <action> <task-id>");
      if (action !== "clear-all" && taskId && !store.getState().tasks[taskId]) throw new Error(`Task not found: ${taskId}`);
      await perform(action, taskId, ctx);
      return;
    }
    pending = undefined;
    if (command === "up" || command === "down") {
      const tasks = listTasksTreeOrder(store.getState());
      const index = Math.max(0, tasks.findIndex((task) => task.id === selected));
      selected = tasks[Math.max(0, Math.min(tasks.length - 1, index + (command === "up" ? -1 : 1)))]?.id;
    } else if (command === "select") {
      if (!rest[0] || !store.getState().tasks[rest[0]]) throw new Error(`Task not found: ${rest[0] ?? ""}`);
      selected = rest[0];
    } else if (command === "peek") {
      const taskId = rest[0] ?? selected;
      if (!taskId) throw new Error("No task selected.");
      await openTaskPopup(ctx, taskId);
    } else if (command === "done") {
      if (!selected) throw new Error("No task selected.");
      finishManually(selected, rest.join(" ") || undefined);
    } else if (command === "block" || command === "unblock") {
      if (!selected) throw new Error("No task selected.");
      if (command === "block" && !rest.length) throw new Error("Usage: /tasks block <reason>");
      patchTask({ taskId: selected, ...(command === "block" ? { blocker: rest.join(" ") } : { clearBlocker: true }), updatedAt: now() });
      if (command === "unblock") {
        const t = selected ? getTask(store.getState(), selected) : undefined;
        if (t && t.status === "pending" && !taskBlocker(store.getState(), t) && context) {
          try { startTask(context, selected); } catch { /* ignore */ }
        }
      }
    } else if (command === "blockers") ctx.ui.notify(formatBlockerSummary(store.getState()), "info");
    else if (command === "stuck") ctx.ui.notify(formatStuckSummary(store.getState()), "info");
    else if (command === "tree") ctx.ui.notify(formatTaskTree(store.getState()), "info");
    else if (command === "list") ctx.ui.notify(formatTaskList(store.getState(), undefined, 100), "info");
    else if (command === "parallel") ctx.ui.notify(listParallelRunnableTasks(store.getState()).map((task) => `${task.id}: ${task.title}`).join("\n") || "No runnable tasks.", "info");
    else if (command === "export") {
      const path = join(ctx.cwd, "tasks.md");
      writeFileSync(path, exportMarkdown(store.getState()));
      ctx.ui.notify(`Exported task state to ${path}`, "info");
    } else if (command === "broadcast") {
      let message = rest.join(" ");
      if (!message) message = (await ctx.ui.input("Broadcast to tasks", "Message for all running tasks")) ?? "";
      if (!message.trim()) throw new Error("Broadcast message is required.");
      await broadcastTask(message);
    } else if (command === "steer") {
      const taskId = rest[0] ?? selected;
      let message = rest.slice(1).join(" ");
      if (!taskId) throw new Error("No task selected.");
      if (!message) message = (await ctx.ui.input("Steer task", `Message for ${taskId}`)) ?? "";
      if (!message.trim()) throw new Error("Steering message is required.");
      await steerTask(taskId, message);
    }
    else if (command === "run") {
      for (const task of listParallelRunnableTasks(store.getState())) startTask(ctx, task.id);
    } else if (command === "ui" || command === "u" || command === "b") {
      const mode = command === "u" ? "top" : command === "b" ? "bottom" : rest[0];
      if (mode === "bottom") placement = "belowEditor";
      else if (mode === "show" || mode === "hide") { visible = mode === "show"; if (!visible) focused = false; }
      else throw new Error("Usage: /tasks ui bottom|show|hide");
    } else throw new Error("Unknown command. Run /tasks help.");
    renderUi();
  }

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear, settings.",
    async handler(args, ctx) {
      try {
        if (!args.trim()) { await taskMenu(ctx); return; }
        await runCommand(args, ctx);
      }
      catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });

  async function taskMenu(ctx: ExtensionContext): Promise<void> {
    const ui = ctx.ui;
    while (true) {
      const tasks = Object.values(store.getState().tasks);
      const taskCount = tasks.length;
      const completedCount = tasks.filter((t) => t.status === "done").length;
      const choices: string[] = [`View all tasks (${taskCount})`, "Create task"];
      if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
      if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
      choices.push("Settings", "← Back");

      const choice = await ui.select("Tasks", choices);
      if (!choice || choice === "← Back") return;

      if (choice.startsWith("View")) {
        await viewTasks(ctx);
      } else if (choice === "Create task") {
        await createTaskInteractive(ctx);
      } else if (choice === "Settings") {
        await settingsMenu(ctx);
      } else if (choice.startsWith("Clear completed")) {
        for (const t of tasks.filter((x) => x.status === "done")) {
          commit(removeTask(store.getState(), t.id).state);
        }
        await taskMenu(ctx);
      } else if (choice.startsWith("Clear all")) {
        await stopAll();
        commit({ tasks: {}, nextId: store.getState().nextId });
        await taskMenu(ctx);
      }
    }
  }

  async function viewTasks(ctx: ExtensionContext): Promise<void> {
    const ui = ctx.ui;
    const tasks = listTasksTreeOrder(store.getState());
    if (tasks.length === 0) {
      await ui.select("No tasks", ["← Back"]);
      return;
    }
    const choices = tasks.map((t) => `${t.status === "in_progress" ? "▶" : t.status === "paused" ? "⏸" : t.status === "done" ? "✓" : "○"} #${t.id.replace("task-", "")} [${t.status}] ${t.title}`);
    choices.push("← Back");
    const selectedChoice = await ui.select("Tasks", choices);
    if (!selectedChoice || selectedChoice === "← Back") return;
    const picked = tasks[choices.indexOf(selectedChoice)];
    if (picked) await viewTaskDetail(ctx, picked.id);
    else await viewTasks(ctx);
  }

  async function viewTaskDetail(ctx: ExtensionContext, taskId: string): Promise<void> {
    const ui = ctx.ui;
    const task = store.getState().tasks[taskId];
    if (!task) return viewTasks(ctx);
    const actions: string[] = [];
    if (task.status === "pending") actions.push("▸ Force-start");
    if (task.status === "in_progress") actions.push("⏸ Pause", "■ Stop");
    if (task.status === "paused") actions.push("▸ Resume");
    actions.push("👁 Peek", "✗ Remove", "← Back");
    const blocker = taskBlocker(store.getState(), task);
    const title = `#${task.id.replace("task-", "")} [${task.status}] ${task.title}${blocker ? `\nblocked: ${blocker}` : ""}`;
    const action = await ui.select(title, actions);
    if (action === "▸ Force-start" || action === "▸ Resume") {
      try { startTask(ctx, taskId, true); } catch (e) { ctx.ui.notify(errorText(e), "error"); }
      return viewTasks(ctx);
    } else if (action === "⏸ Pause") {
      try { await pauseTask(taskId); } catch (e) { ctx.ui.notify(errorText(e), "error"); }
      return viewTasks(ctx);
    } else if (action === "■ Stop") {
      try { await stopTask(taskId); } catch (e) { ctx.ui.notify(errorText(e), "error"); }
      return viewTasks(ctx);
    } else if (action === "👁 Peek") {
      try { await openTaskPopup(ctx, taskId); } catch (e) { ctx.ui.notify(errorText(e), "error"); }
      return viewTaskDetail(ctx, taskId);
    } else if (action === "✗ Remove") {
      try { await stopTask(taskId); commit(removeTask(store.getState(), taskId).state); } catch (e) { ctx.ui.notify(errorText(e), "error"); }
      return viewTasks(ctx);
    }
    return viewTasks(ctx);
  }

  async function createTaskInteractive(ctx: ExtensionContext): Promise<void> {
    const ui = ctx.ui;
    const subject = await ui.input("Task subject", "");
    if (!subject) return taskMenu(ctx);
    const description = await ui.input("Task description", "");
    const created = createTask(store.getState(), subject, description || undefined, now());
    selected = created.task.id;
    commit(created.state);
    try { startTask(ctx, created.task.id); } catch { /* ignore */ }
    return taskMenu(ctx);
  }

  async function settingsMenu(ctx: ExtensionContext): Promise<void> {
    const ui = ctx.ui;
    const options = ["Move widget: top", "Move widget: bottom", "Toggle widget visibility", "← Back"];
    const choice = await ui.select("Settings", options);
    if (!choice || choice === "← Back") return taskMenu(ctx);
    if (choice.startsWith("Move widget: top")) placement = "aboveEditor";
    else if (choice.startsWith("Move widget: bottom")) placement = "belowEditor";
    else if (choice.startsWith("Toggle widget visibility")) { visible = !visible; if (!visible) focused = false; }
    renderUi();
    return settingsMenu(ctx);
  }

  async function openTaskOverlay(ctx: ExtensionContext): Promise<void> {
    const list0 = listTasksTreeOrder(store.getState());
    let sel = selected && store.getState().tasks[selected] ? selected : list0[0]?.id;

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const close = () => { if (streamTimer) clearInterval(streamTimer); streamTimer = undefined; done(); };
      let streamTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => { tui.requestRender(); }, 250);
      if (streamTimer) streamTimer.unref();
      const runAction = (action: () => Promise<void>) => { void action().then(() => tui.requestRender()).catch((error: unknown) => ctx.ui.notify(errorText(error), "error")); };
      const component = {
        render(width: number): string[] {
          const lines: string[] = [];
          const state = store.getState();
          const list = listTasksTreeOrder(state);
          lines.push(theme.fg("accent", `Task Tree (${list.length})`));
          lines.push(theme.fg("muted", "↑/↓ j/k navigate | Enter/o peek | s force-start | x stop | p pause | d remove | Esc close"));
          lines.push("");
          for (const task of list) {
            const marker = task.id === sel ? ">" : " ";
            const icon = task.status === "in_progress" ? "▶" : task.status === "paused" ? "⏸" : task.status === "done" ? "✓" : "○";
            const blocker = taskBlocker(state, task) ? " 🚫" : "";
            lines.push(truncateToWidth(`${marker} ${icon} ${task.id} ${task.title}${blocker}`, width));
          }
          if (list.length === 0) lines.push(theme.fg("muted", "(no tasks)"));
          return lines;
        },
        handleInput(data: string) {
          const list = listTasksTreeOrder(store.getState());
          const idx = Math.max(0, list.findIndex((t) => t.id === sel));
          if (matchesKey(data, Key.escape)) { close(); return; }
          if (matchesKey(data, Key.up) || data === "k") {
            sel = list[Math.max(0, idx - 1)]?.id ?? sel;
            selected = sel;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            sel = list[Math.min(list.length - 1, idx + 1)]?.id ?? sel;
            selected = sel;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            if (sel) { close(); void openTaskPopup(ctx, sel); }
            return;
          }
          if (data === "s" || data === "S") { if (sel) runAction(() => perform("force-start", sel, ctx)); return; }
          if (data === "x") { if (sel) runAction(() => perform("stop", sel, ctx)); return; }
          if (data === "p") { if (sel) runAction(() => perform("pause", sel, ctx)); return; }
          if (data === "d") { if (sel) runAction(async () => { await perform("remove", sel, ctx); }); return; }
          if (data === "o") { if (sel) { close(); void openTaskPopup(ctx, sel); } return; }
        },
        invalidate() {},
      };
      return component;
    }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } });
    renderUi();
  }
}

function now(): string { return new Date().toISOString(); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function textResult(text: string, details: unknown = {}) { return { content: [{ type: "text" as const, text }], details }; }
function helpMarkdown(): string {
  return `**Task Manager — Commands & Hotkeys**

**Navigation**
| Key/Command | Action |
|---|---|
| \`/tasks\` | Interactive menu (view/create/clear/settings) |
| \`/tasks toggle\` | Show/hide widget |
| \`/tasks focus\` | Focus widget |
| \`/tasks overlay\` | Open interactive overlay |
| \`/tasks up\` / \`/tasks down\` | Move selection |
| \`/tasks select <id>\` | Select a task |

**Actions**
| Key/Command | Action |
|---|---|
| \`/tasks force-start\` | Start selected task (clears blocker) |
| \`/tasks stop\` | Stop selected task |
| \`/tasks pause\` / \`P\` | Pause (resumable) |
| \`/tasks restart\` / \`r\` | Re-run after crash/interruption |
| \`/tasks remove\` / \`d\` | Remove selected task |
| \`/tasks done [note]\` | Manual completion |
| \`/tasks clear\` | Clear all tasks (no confirmation) |

**Peek / Overlay (normal mode)**
| Key | Action |
|---|---|
| \`i\` | Insert mode (steer) |
| \`↑/↓\`, \`PgUp/PgDn\` | Scroll |
| \`End\` | Jump to tail |
| \`s\` / \`f\` / \`p\` / \`x\` / \`r\` / \`d\` | start / force / pause / stop / restart / remove (confirm with y) |
| \`Esc\` | Close (or normal mode from insert) |

**Info**
| Command | Action |
|---|---|
| \`/tasks peek\` / \`/tasks inspect\` | Inspect selected task |
| \`/tasks block <reason>\` / \`unblock\` | Set/clear blocker |
| \`/tasks blockers\` / \`stuck\` | List blockers/stuck |
| \`/tasks tree\` / \`list\` / \`parallel\` | Show tree/list/ready |
| \`/tasks run\` | Start all ready tasks |
| \`/tasks steer <id> <msg>\` | Steer a worker |
| \`/tasks broadcast\` | Steer all workers |
| \`/tasks export\` | Write tasks.md |
| \`/tasks ui top|bottom|show|hide\` | Move/toggle widget |
| \`/tasks help\` | This help |

Hotkey: \`Ctrl+Alt+↑\` focuses widget; \`Ctrl+Alt+T\` alternative.
`;
}

function helpText(): string {
  return [
    "Task manager commands and hotkeys",
    "/tasks — focus task manager",
    "/tasks toggle — show/hide task manager",
    "/tasks clear — clear all tasks (no confirmation)",
    "/tasks overlay — open interactive overlay",
    "Ctrl+Alt+↑ focuses the widget (no popup). /tasks overlay opens the popup.",
    "While focused: ↑/Ctrl+Alt+↓/j/k navigate; Enter/o/p peek; S force-start; s stop; P pause; d remove; x clear all; r restart; m steer; b broadcast",
    "(Hotkeys are no longer captured globally; use commands to avoid hijacking editor input.)",
    "/tasks pause [task-id] — pause a running worker (resumable)",
    "/tasks steer <task-id> <message> — steer a running worker (also task_steer tool)",
    "Start/stop/remove/clear run immediately; no confirmation required",
    "/tasks start|force-start|stop|remove [task-id] — otherwise acts on selection",
    "/tasks up|down; /tasks select <task-id>; /tasks peek [task-id]",
    "/tasks done [note] — manual completion (stop a running worker first)",
    "/tasks block <reason> | unblock | blockers | stuck",
    "/tasks run — start all currently ready tasks concurrently",
    "/tasks tree | list | parallel — show tree, list, or ready tasks",
    "/tasks export — write tasks.md in the current directory",
    "State is mirrored to .pi/task-manager-state.json and emitted as task-manager:state for other extensions",
    "/tasks ui bottom|show|hide; /tasks u|b — move widget",
    "Tasks inherit the parent task/main model; each worker has a private task-id-hash session",
    "Stuck = no worker activity for 15 minutes; warnings never auto-stop a worker",
  ].join("\n");
}
