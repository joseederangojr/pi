import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerTaskManager } from "../index.ts";
import type { TaskFork, WorkerFactory, WorkerSession } from "../src/execution.ts";

export const model: TaskFork["model"] = {
  id: "test-model", name: "Test", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000, maxTokens: 4_096,
};

export function fork(sessionDir = "/unused"): TaskFork {
  return {
    cwd: process.cwd(), parentId: "main-session", parentFile: "/main.jsonl", leafId: null,
    sessionDir, entries: [], model, thinkingLevel: "medium",
  };
}

type Assistant = Extract<Extract<AgentSessionEvent, { type: "message_end" }>["message"], { role: "assistant" }>;
export function assistant(text: string, stopReason: Assistant["stopReason"] = "stop"): Assistant {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test-model",
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.002, total: 0.035 } },
    stopReason, timestamp: Date.now(),
  };
}

export class FakeSession implements WorkerSession {
  listeners = new Set<(event: AgentSessionEvent) => void>();
  prompts: string[] = [];
  activeTools: string[] | undefined;
  disposed = false;
  aborted = false;
  gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  started = Promise.withResolvers<void>();
  executionReason: Assistant["stopReason"] = "stop";
  failSummary = false;
  duplicateUsage = false;

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: AgentSessionEvent) { for (const listener of this.listeners) listener(event); }
  async prompt(text: string) {
    this.prompts.push(text);
    if (this.prompts.length === 1) {
      this.started.resolve();
      await this.gate?.promise;
    } else if (this.failSummary) throw new Error("Summary provider unavailable");
    const message = assistant(this.prompts.length === 1 ? "Changed files; tests passed." : "Own-session summary: changed files and verified tests.", this.aborted ? "aborted" : this.executionReason);
    this.emit({ type: "message_end", message });
    if (this.duplicateUsage) this.emit({ type: "message_end", message });
    this.emit({ type: "agent_settled", aborted: this.aborted });
  }
  async abort() { this.aborted = true; this.gate?.resolve(); }
  async steer(text: string) { this.prompts.push(`[steered] ${text}`); return "queued" as const; }
  dispose() { this.disposed = true; }
  setActiveToolsByName(names: string[]) { this.activeTools = names; }
}

export function harness(factory: WorkerFactory) {
  let manager = SessionManager.inMemory(process.cwd(), { id: "main-session" });
  const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): unknown }>();
  const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const notifications: string[] = [];
  let input: ((data: string) => unknown) | undefined;
  let widget: string[] = [];
  let widgetPlacement = "aboveEditor";
  const ctx = {
    cwd: process.cwd(), mode: "tui", hasUI: true, model,
    modelRegistry: { getAvailable: () => [model] },
    get sessionManager() { return manager; },
    isIdle: () => true,
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      setWidget(_key: string, content: unknown, options?: { placement: string }) {
        widget = Array.isArray(content) ? content : typeof content === "function" ? content().render(160) : [];
        if (options) widgetPlacement = options.placement;
      },
      onTerminalInput(handler: (data: string) => unknown) {
        input = handler;
        return () => { input = undefined; };
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): unknown }) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { manager.appendCustomEntry(customType, data); },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) { messages.push({ message, options }); },
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  registerTaskManager(pi, factory);
  return {
    ctx, messages, notifications,
    get manager() { return manager; },
    get widget() { return widget.join("\n"); },
    get placement() { return widgetPlacement; },
    input: (data: string) => input?.(data),
    switchSession(id: string) { manager = SessionManager.inMemory(process.cwd(), { id }); },
    async emit(name: string) { for (const handler of events.get(name) ?? []) await handler({}, ctx); },
    async command(args: string) { await commands.get("tasks")!.handler(args, ctx); },
    async tool(name: string, params: Record<string, unknown>) {
      return tools.get(name)!.execute("call-test", params, undefined, undefined, ctx as Parameters<ToolDefinition["execute"]>[4]);
    },
  };
}

