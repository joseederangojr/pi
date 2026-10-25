import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { Task, UpdateTaskInput } from "./model.ts";

export interface TaskFork {
  cwd: string;
  parentId: string;
  parentFile: string | undefined;
  leafId: string | null;
  sessionDir: string;
  entries: SessionEntry[];
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

export type WorkerSession = Pick<AgentSession,
  "subscribe" | "prompt" | "abort" | "dispose" | "setActiveToolsByName" | "steer"
>;

export interface TaskWorker {
  session: WorkerSession;
  sessionId: string;
  sessionFile: string;
}

export type WorkerFactory = (task: Task, fork: TaskFork, hooks?: ExecutionHooks) => Promise<TaskWorker>;

interface ExecutionHooks {
  update(task: Task, fork: TaskFork, patch: Omit<UpdateTaskInput, "taskId" | "updatedAt">): void;
  complete(task: Task, fork: TaskFork, summary: string): void;
  failed(task: Task, fork: TaskFork, reason: string): void;
  question(task: Task, fork: TaskFork, question: string): Promise<string>;
}

interface Run {
  cancelled: boolean;
  worker?: TaskWorker;
  finished: Promise<void>;
  preview: string;
  activity: Array<{ kind: "thinking" | "assistant" | "tool"; text: string; streaming: boolean; status?: "running" | "done" | "error" }>;
  toolArgs: Map<string, any>;
}

/** Capture the finalized branch in memory, not a possibly unflushed main-session file. */
export function captureTaskFork(ctx: ExtensionContext, thinkingLevel: TaskFork["thinkingLevel"]): TaskFork {
  if (!ctx.model) throw new Error("Select a model before starting tasks.");
  const entries = structuredClone(ctx.sessionManager.getBranch());
  if (hasUnresolvedToolCalls(entries)) throw new Error("Waiting for the current tool calls to finish.");
  return {
    cwd: ctx.cwd,
    parentId: ctx.sessionManager.getSessionId(),
    parentFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    sessionDir: ctx.sessionManager.getSessionDir(),
    entries,
    model: ctx.model,
    thinkingLevel,
  };
}

export function captureTaskForkFromSession(
  parentTask: Task,
  model: NonNullable<ExtensionContext["model"]>,
  thinkingLevel: TaskFork["thinkingLevel"],
): TaskFork {
  if (!parentTask.sessionFile) throw new Error(`Parent task ${parentTask.id} has no saved session.`);
  const manager = SessionManager.open(parentTask.sessionFile);
  const entries = structuredClone(manager.getBranch());
  if (hasUnresolvedToolCalls(entries)) throw new Error("Parent session still has unresolved tool calls.");
  return {
    cwd: manager.getCwd(),
    parentId: manager.getSessionId(),
    parentFile: manager.getSessionFile() ?? parentTask.sessionFile,
    leafId: manager.getLeafId(),
    sessionDir: manager.getSessionDir(),
    entries,
    model,
    thinkingLevel,
  };
}

export function hasUnresolvedToolCalls(entries: SessionEntry[]): boolean {
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pending.add(block.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  return pending.size > 0;
}

/** A private, inspectable fork; never navigate or write to the main session. */
export function createWorkerSessionManager(task: Task, fork: TaskFork): SessionManager {
  const id = randomUUID();
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd: fork.cwd,
    ...(fork.parentFile ? { parentSession: fork.parentFile } : {}),
  };
  mkdirSync(fork.sessionDir, { recursive: true, mode: 0o700 });
  const file = join(fork.sessionDir, `${task.sessionTree}_${id}.jsonl`);
  writeFileSync(file, [header, ...fork.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const manager = SessionManager.open(file, fork.sessionDir, fork.cwd);
  manager.appendSessionInfo(task.sessionTree);
  return manager;
}

export const createTaskWorker: WorkerFactory = async (task, fork, hooks) => {
  const manager = createWorkerSessionManager(task, fork);
  // Disable extension discovery before factories run, preventing recursive workers.
  // Note: runtime-registered providers/virtual models from the main session are not
  // propagated; only auth/models files under the agent dir are available.
  // Load all extensions except task-manager (to avoid recursion) so workers
  // can use other extensions' tools. Skills are enabled.
  const resourceLoader = new DefaultResourceLoader({
    cwd: fork.cwd,
    agentDir: getAgentDir(),
    noExtensions: false,
    noSkills: false,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((ext: any) => {
        const src = String(ext?.path ?? ext?.source ?? ext?.name ?? "");
        return !src.includes("task-manager");
      }),
    }),
  });
  await resourceLoader.reload();
  const questionTool = {
    name: "task_question",
    label: "Ask question",
    description: "Ask the main session a clarifying question and wait for an answer. Use sparingly.",
    parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
    async execute(_id: any, params: any) {
      if (!hooks?.question) throw new Error("No question handler");
      const answer = await hooks.question(task, fork, params.question);
      return { content: [{ type: "text", text: answer }] };
    },
  };
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: fork.cwd,
    sessionManager: manager,
    resourceLoader,
    model: fork.model,
    thinkingLevel: fork.thinkingLevel,
    customTools: [questionTool as any],
  });
  if (modelFallbackMessage || session.model?.id !== fork.model.id || session.model.provider !== fork.model.provider) {
    session.dispose();
    throw new Error(modelFallbackMessage ?? "Worker could not inherit the selected model.");
  }
  return { session, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! };
};

/** Each start owns an independent SDK session; cancellation wins completion races. */
export function createTaskExecutor(hooks: ExecutionHooks, factory: WorkerFactory = createTaskWorker) {
  const running = new Map<string, Run>();

  function start(task: Task, fork: TaskFork): Promise<void> {
    const existing = running.get(task.id);
    if (existing) return existing.finished;
    const run: Run = { cancelled: false, finished: Promise.resolve(), preview: "", activity: [], toolArgs: new Map() };
    running.set(task.id, run);
    run.finished = execute(run, structuredClone(task), fork).finally(() => {
      if (running.get(task.id) === run) running.delete(task.id);
    });
    return run.finished;
  }

  async function execute(run: Run, task: Task, fork: TaskFork): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      const worker = await factory(task, fork, hooks);
      run.worker = worker;
      if (run.cancelled) return;
      hooks.update(task, fork, {
        sessionId: worker.sessionId,
        sessionFile: worker.sessionFile,
        parentSessionId: fork.parentId,
        ...(fork.leafId ? { forkLeafId: fork.leafId } : {}),
      });
      let settled = false;
      let aborted = false;
      let stopReason = "";
      let errorMessage = "";
      let lastActivity = 0;
      const seenMessages = new WeakSet<object>();
      unsubscribe = worker.session.subscribe((event: AgentSessionEvent) => {
        if (run.cancelled) {
          // Cancellation during prompt preflight can land before the session
          // marks itself active. Reissue abort once the run actually starts.
          if (event.type === "agent_start" && run.worker) {
            void run.worker.session.abort();
          }
          return;
        }
        const now = Date.now();
        const activity = event.type.startsWith("message_") || event.type.startsWith("tool_execution_");
        if (activity && now - lastActivity >= 5_000) {
          lastActivity = now;
          hooks.update(task, fork, { lastActivityAt: new Date(now).toISOString() });
        }
        if (event.type === "agent_settled") {
          settled = true;
          aborted = event.aborted;
        }
        if (event.type === "message_start" && event.message.role === "user") {
          const text = assistantText(event.message as any);
          if (text.trim()) {
            run.activity.push({ kind: "assistant", text: `[You] ${text.trim().slice(0, 400)}`, streaming: false });
            if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
          }
        }
        if (event.type === "message_start" && event.message.role === "assistant") {
          if (!run.activity.some((e) => e.kind === "thinking")) {
            run.activity.push({ kind: "thinking", text: "💭 Thinking…", streaming: true });
          }
          if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
        }
        if (event.type === "message_update" && event.message.role === "assistant") {
          run.preview = assistantText(event.message);
          const text = run.preview.trim();
          if (text) {
            // remove thinking indicator
            const tIdx = run.activity.map((e) => e.kind).lastIndexOf("thinking");
            if (tIdx >= 0) run.activity.splice(tIdx, 1);
            const idx = run.activity.map((e) => e.kind).lastIndexOf("assistant");
            const entry = { kind: "assistant" as const, text: `💬 ${text.slice(0, 400).replace(/\s+/g, " ")}`, streaming: true };
            if (idx >= 0) run.activity[idx] = entry; else run.activity.push(entry);
          } else {
            // thinking already shown via message_start; nothing to do
          }
          if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
          // Thinking is hidden by default; only assistant text is tracked via preview.
        }
        if (event.type === "tool_execution_start") {
          const args = event.args ?? {};
          run.toolArgs.set(event.toolCallId, args);
          let summary = "";
          if (event.toolName === "bash") summary = String(args.command ?? "").slice(0, 80);
          else if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") summary = String(args.path ?? args.file ?? "");
          else summary = JSON.stringify(args).slice(0, 80);
          run.activity.push({ kind: "tool", text: `● ${event.toolName}${summary ? ": " + summary : ""}`, streaming: true, status: "running" as const });
          if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
        }
        if (event.type === "tool_execution_end") {
          const lastIdx = run.activity.map((e) => e.kind).lastIndexOf("tool");
          if (event.isError) {
            const out = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
            const line = { kind: "tool" as const, text: `● ${event.toolName}: ${out.slice(0, 160).replace(/\s+/g, " ")}`, streaming: false, status: "error" as const };
            if (lastIdx >= 0) run.activity[lastIdx] = line; else run.activity.push(line);
          } else if (event.toolName === "edit" || event.toolName === "write") {
            const args = run.toolArgs.get(event.toolCallId) ?? {};
            const targetPath = String(args.path ?? args.file ?? "");
            const newContent = event.toolName === "write"
              ? String(args.content ?? "")
              : String(args.newText ?? args.new_string ?? "");
            const preview = newContent.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n");
            const line = { kind: "tool" as const, text: `  ✓ ${event.toolName}: ${targetPath}${newContent ? "\n" + preview : ""}`, streaming: false, status: "done" as const };
            if (lastIdx >= 0) run.activity[lastIdx] = line; else run.activity.push(line);
          } else if (lastIdx >= 0) {
            const e = run.activity[lastIdx];
            if (e) { e.streaming = false; e.status = "done"; }
          }
          if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
        }
        if (event.type === "tool_execution_end" && event.isError) {
          const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
          const summary = `${event.toolName} failed${output ? `: ${output.slice(0, 160).replace(/\s+/g, " ")}` : ""}`;
          hooks.update(task, fork, { note: summary, lastActivityAt: new Date(now).toISOString() });
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message;
          stopReason = message.stopReason;
          errorMessage = message.errorMessage ?? "";
          run.preview = assistantText(message);
          const text = run.preview.trim();
          if (text) {
            const tIdx = run.activity.map((e) => e.kind).lastIndexOf("thinking");
            if (tIdx >= 0) run.activity.splice(tIdx, 1);
            const aIdx = run.activity.map((e) => e.kind).lastIndexOf("assistant");
            const wrapped = text.match(/.{1,70}(\s|$)/g) ?? [text];
            const newEntries = wrapped.map((w) => ({ kind: "assistant" as const, text: `💬 ${w.trim()}`, streaming: false }));
            if (aIdx >= 0) run.activity.splice(aIdx, 1, ...newEntries);
            else run.activity.push(...newEntries);
            if (run.activity.length > 200) run.activity.splice(0, run.activity.length - 200);
          }
          if (!seenMessages.has(message)) {
            seenMessages.add(message);
            hooks.update(task, fork, {
              inputTokensDelta: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
              outputTokensDelta: message.usage.output,
              costUsdDelta: message.usage.cost.total,
              lastActivityAt: new Date(now).toISOString(),
            });
          }
        }
        if (event.type === "entry_appended" &&
            (event.entry.type === "compaction" || event.entry.type === "branch_summary")) {
          const usage = event.entry.usage;
          if (usage) hooks.update(task, fork, {
            inputTokensDelta: usage.input + usage.cacheRead + usage.cacheWrite,
            outputTokensDelta: usage.output,
            costUsdDelta: usage.cost.total,
            lastActivityAt: new Date(now).toISOString(),
          });
        }
      });
      const prompt = [
        `You are the implementer/worker for task ${task.id}: ${task.title}`,
        task.description ?? "",
        "Execute this task fully: read, edit, run, and verify. Report results, changed files, tests, and any blockers truthfully.",
        "This is an independent background task fork. Complete only this task; do not create more task workers.",
        "If you need clarification, call the task_question tool and wait for the answer before proceeding.",
        "Other tasks may share the working directory. Avoid overwriting unrelated changes.",
        "Verify your work and report results, changed files, tests, and any blockers truthfully.",
      ].filter(Boolean).join("\n\n");
      if (run.cancelled) return;
      await worker.session.prompt(prompt, { expandPromptTemplates: false });
      if (run.cancelled) return;
      if (!settled || aborted || stopReason !== "stop") {
        throw new Error(errorMessage || `Worker did not complete successfully (${stopReason || "unsettled"}).`);
      }

      // Summarize the worker's own transcript, not the task metadata in the main tree.
      const result = run.preview;
      let summary: string;
      try {
        settled = false;
        aborted = false;
        stopReason = "";
        errorMessage = "";
        run.preview = "";
        worker.session.setActiveToolsByName([]);
        await worker.session.prompt(
          "Summarize this task session for the parent conversation. Include results, decisions, changed files, tests actually run, failures, blockers, and remaining work. Be concise and truthful. Do not call tools.",
          { expandPromptTemplates: false },
        );
        if (run.cancelled) return;
        if (!settled || aborted || stopReason !== "stop" || !run.preview.trim()) {
          throw new Error(errorMessage || "No successful summary response.");
        }
        summary = run.preview;
      } catch (error) {
        if (run.cancelled) return;
        summary = `Task execution completed, but session summarization failed: ${errorText(error)}\n\nFinal task response:\n${result || "(no text response; inspect the saved task session)"}`;
      }
      if (!run.cancelled) hooks.complete(task, fork, summary);
    } catch (error) {
      if (!run.cancelled) hooks.failed(task, fork, errorText(error));
    } finally {
      unsubscribe?.();
      run.worker?.session.dispose();
    }
  }

  async function cancel(taskId: string): Promise<void> {
    const run = running.get(taskId);
    if (!run) return;
    run.cancelled = true;
    if (run.worker) await run.worker.session.abort();
    await run.finished;
  }

  async function steer(taskId: string, text: string): Promise<void> {
    const run = running.get(taskId);
    if (!run?.worker) throw new Error(`Task is not running: ${taskId}`);
    await run.worker.session.steer(text);
  }

  return {
    start,
    cancel,
    steer,
    isRunning: (taskId: string) => running.has(taskId),
    preview: (taskId: string) => running.get(taskId)?.preview,
    activity: (taskId: string) => running.get(taskId)?.activity,
    cancelAll: async () => { await Promise.all([...running.keys()].map(cancel)); },
  };
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
