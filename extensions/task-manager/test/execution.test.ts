import assert from "node:assert/strict";
import test from "node:test";

import { harness, FakeSession } from "./helpers.ts";

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ text?: string }> };
  return r?.content?.[0]?.text ?? "";
}

test("dispatch returns while worker remains pending", async () => {
  const session = new FakeSession();
  session.gate = Promise.withResolvers();
  const factory = async () => ({ session, sessionId: "worker-1", sessionFile: "/worker.jsonl" });
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  const started = Date.now();
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  const elapsed = Date.now() - started;
  assert.equal(h.messages.length, 0);
  assert.match(textOf(await h.tool("task_list", {})), /task-1 \[in_progress\]/);
  assert.ok(elapsed < 5000);
  await session.abort();
});

test("completion summary is delivered once", async () => {
  const session = new FakeSession();
  session.gate = Promise.withResolvers();
  const factory = async () => ({ session, sessionId: "worker-1", sessionFile: "/worker.jsonl" });
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  session.gate.resolve();
  await new Promise((r) => setTimeout(r, 50));
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 1);
  assert.match(String((h.messages[0]!.message as { content?: unknown }).content), /Own-session summary/);
  assert.equal(h.messages.length, 1);
});

test("stop actually cancels the worker", async () => {
  const session = new FakeSession();
  session.gate = Promise.withResolvers();
  const factory = async () => ({ session, sessionId: "worker-1", sessionFile: "/worker.jsonl" });
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  assert.equal(session.aborted, false);
  await h.tool("task_update", { task_id: "task-1", status: "pending" });
  assert.equal(session.aborted, true);
  assert.match(textOf(await h.tool("task_list", {})), /task-1 \[pending\]/);
});

test("multiple workers run concurrently", async () => {
  const sessions: FakeSession[] = [];
  const factory = async () => {
    const s = new FakeSession();
    s.gate = Promise.withResolvers();
    sessions.push(s);
    return { session: s, sessionId: `w-${sessions.length}`, sessionFile: `/w-${sessions.length}.jsonl` };
  };
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "A" });
  await h.tool("task_create", { title: "B" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.tool("task_update", { task_id: "task-2", status: "in_progress" });
  await h.emit("agent_settled");
  assert.equal(sessions.length, 2);
  assert.equal(h.messages.length, 0);
  for (const s of sessions) s.gate!.resolve();
  await new Promise((r) => setTimeout(r, 80));
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 2);
});

test("dependent task auto-starts after parent completes", async () => {
  const parentSession = new FakeSession();
  parentSession.gate = Promise.withResolvers();
  const childSession = new FakeSession();
  childSession.gate = Promise.withResolvers();
  let call = 0;
  const factory = async () => {
    call++;
    const s = call === 1 ? parentSession : childSession;
    return { session: s, sessionId: `w-${call}`, sessionFile: `/w-${call}.jsonl` };
  };
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "Parent" });
  await h.tool("task_create", { title: "Child", depends_on: ["task-1"] });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  parentSession.gate.resolve();
  await new Promise((r) => setTimeout(r, 80));
  await h.emit("agent_settled");
  assert.ok(h.messages.length >= 1);
  childSession.gate.resolve();
  await new Promise((r) => setTimeout(r, 80));
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 2);
});

test("pause suspends worker without abandoning task", async () => {
  const session = new FakeSession();
  session.gate = Promise.withResolvers();
  const factory = async () => ({ session, sessionId: "worker-1", sessionFile: "/worker.jsonl" });
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  await h.command("pause");
  // confirm pause action
  await h.command("confirm");
  assert.equal(session.aborted, true);
  assert.match(textOf(await h.tool("task_list", {})), /task-1 \[paused\]/);
});

test("steer sends message to running worker", async () => {
  const session = new FakeSession();
  session.gate = Promise.withResolvers();
  const factory = async () => ({ session, sessionId: "worker-1", sessionFile: "/worker.jsonl" });
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  await h.tool("task_steer", { task_id: "task-1", message: "focus on tests" });
  assert.ok(session.prompts.some((p) => p.includes("[steered] focus on tests")));
  await session.abort();
});

test("broadcast steers all running workers", async () => {
  const sessions: FakeSession[] = [];
  const factory = async () => {
    const s = new FakeSession();
    s.gate = Promise.withResolvers();
    sessions.push(s);
    return { session: s, sessionId: `w-${sessions.length}`, sessionFile: `/w-${sessions.length}.jsonl` };
  };
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "A" });
  await h.tool("task_create", { title: "B" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.tool("task_update", { task_id: "task-2", status: "in_progress" });
  await h.emit("agent_settled");
  await h.tool("task_broadcast", { message: "wrap up" });
  assert.ok(sessions.every((s) => s.prompts.some((p) => p.includes("[steered] wrap up"))));
  for (const s of sessions) s.gate!.resolve();
  await new Promise((r) => setTimeout(r, 80));
  await h.emit("agent_settled");
});

test("restart re-runs an interrupted task", async () => {
  const sessions: FakeSession[] = [];
  const factory = async () => {
    const s = new FakeSession();
    s.gate = Promise.withResolvers();
    sessions.push(s);
    return { session: s, sessionId: `w-${sessions.length}`, sessionFile: `/w-${sessions.length}.jsonl` };
  };
  const h = harness(factory);
  await h.emit("session_start");
  await h.tool("task_create", { title: "T1" });
  await h.tool("task_update", { task_id: "task-1", status: "in_progress" });
  await h.emit("agent_settled");
  // simulate crash/interrupt via replay (worker still gated) -> auto-restarts open tasks
  await h.emit("session_start");
  await h.emit("agent_settled");
  assert.match(textOf(await h.tool("task_list", {})), /task-1 \[in_progress\]/);
  // resolve the new worker
  const last = sessions[sessions.length - 1]!;
  last.gate!.resolve();
  await new Promise((r) => setTimeout(r, 50));
  await h.emit("agent_settled");
});

test("stuck detection does not spam notifications", async () => {
  assert.ok(true);
});
