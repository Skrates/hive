import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  announceSession,
  consumeInboxFiles,
  drainInbox,
  hookOutput,
  quarantineInboxFiles,
  selectDeliverable,
  shouldMaintainHeartbeat,
  type AttentionConstraint,
  type GuardVerdict,
} from "./claude-hook.js";

function inboxFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-hook-"));
  const inbox = join(root, "ariadne");
  mkdirSync(inbox, { recursive: true });
  return inbox;
}

test("the hook drains inbox envelopes in order and consumes them after emission", (t) => {
  const inbox = inboxFixture();
  t.after(() => rmSync(inbox, { recursive: true, force: true }));
  writeFileSync(join(inbox, "delivery-3-attempt-1.json"), JSON.stringify({ framed: "third" }));
  writeFileSync(join(inbox, "delivery-12-attempt-2.json"), JSON.stringify({ framed: "twelfth" }));
  // Non-matching and in-flight files are ignored.
  writeFileSync(join(inbox, "delivery-99-attempt-1.json.tmp"), JSON.stringify({ framed: "partial" }));
  writeFileSync(join(inbox, "notes.txt"), "not a delivery");

  const messages = drainInbox(inbox);
  assert.deepEqual(messages.map((message) => message.framed), ["twelfth", "third"]);

  consumeInboxFiles(inbox, messages);
  const remaining = readdirSync(inbox).filter((name) => name.endsWith(".json"));
  assert.deepEqual(remaining, []);
  const consumed = readdirSync(join(inbox, ".consumed"));
  assert.equal(consumed.length, 2);
});

test("an empty inbox produces no hook output", () => {
  assert.equal(hookOutput("Stop", []), null);
});

test("Stop output injects the envelope as a continuation reason", () => {
  const output = hookOutput("Stop", ["Message from U1: do the thing"]);
  assert.deepEqual(JSON.parse(output!), {
    decision: "block",
    reason: "Message from U1: do the thing",
  });
});

test("PostToolUse output injects the envelope as additional context", () => {
  const output = hookOutput("PostToolUse", ["Message from U1: mid-task steer"]);
  assert.deepEqual(JSON.parse(output!), {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "Message from U1: mid-task steer",
    },
  });
});

test("multiple pending envelopes combine into one injection", () => {
  const output = hookOutput("Stop", ["first", "second"]);
  const parsed = JSON.parse(output!) as { reason: string };
  assert.match(parsed.reason, /first/);
  assert.match(parsed.reason, /second/);
});

test("an unreadable inbox entry is left in place for inspection", (t) => {
  const inbox = inboxFixture();
  t.after(() => rmSync(inbox, { recursive: true, force: true }));
  writeFileSync(join(inbox, "delivery-1-attempt-1.json"), "{not json");
  assert.deepEqual(drainInbox(inbox), []);
  assert.deepEqual(readdirSync(inbox), ["delivery-1-attempt-1.json"]);
});

test("heartbeat policy: a terminal Stop with an empty inbox withdraws liveness; everything else renews", () => {
  // Session ending, nothing pending: no future boundary is promised — deregister.
  assert.equal(shouldMaintainHeartbeat("Stop", 0), false);
  assert.equal(shouldMaintainHeartbeat("SubagentStop", 0), false);
  // Pending messages block the stop, so the session continues.
  assert.equal(shouldMaintainHeartbeat("Stop", 2), true);
  // Mid-session boundaries always renew.
  assert.equal(shouldMaintainHeartbeat("PostToolUse", 0), true);
  assert.equal(shouldMaintainHeartbeat("UserPromptSubmit", 0), true);
});

// ADR-0004 A26: constrained attention envelopes in the actor-scoped inbox.
test("A26 only the named session drains a constrained envelope, and only while the edge says it is current", async () => {
  const inbox = mkdtempSync(join(tmpdir(), "hive-hook-attention-"));
  const write = (name: string, payload: Record<string, unknown>) => writeFileSync(join(inbox, name), JSON.stringify(payload));
  const constraint = (generation: number, deliveryId: number) => ({
    expectedSessionId: "session-A", expectedCwd: "/work/hive", resolutionCommandId: "5c0f2c1e-8b8e-4c55-a3a6-0e5c8f8f2d10", generation, deliveryId, leaseGeneration: 1,
  });
  write("delivery-1-attempt-1.json", { framed: "ordinary wake" });
  write("delivery-2-attempt-1.json", { framed: "current return", attention: constraint(2, 2) });
  write("delivery-3-attempt-1.json", { framed: "superseded return", attention: constraint(1, 3) });
  write("delivery-4-attempt-1.json", { framed: "unreadable constraint", attention: { expectedSessionId: "" } });
  write("delivery-5-attempt-1.json", { framed: "constraint without cwd", attention: { ...constraint(2, 5), expectedCwd: undefined } });
  const messages = drainInbox(inbox);
  assert.deepEqual(messages.map((message) => message.framed), ["ordinary wake", "current return", "superseded return"], "a constraint it cannot read is never treated as unconstrained");

  const guarded: number[] = [];
  const guard = async (c: AttentionConstraint): Promise<GuardVerdict> => {
    guarded.push(c.generation);
    return c.generation === 2 ? "eligible" : "ineligible";
  };
  const unknownSession = await selectDeliverable(messages, { id: null, cwd: "/work/hive" }, guard);
  assert.deepEqual(unknownSession.emit.map((message) => message.framed), ["ordinary wake"]);
  assert.deepEqual(unknownSession.quarantine, []);
  const otherSession = await selectDeliverable(messages, { id: "session-B", cwd: "/work/hive" }, guard);
  assert.deepEqual(otherSession.emit.map((message) => message.framed), ["ordinary wake"], "a mismatched session cannot drain it");
  for (const cwd of ["/work/other", null]) {
    const elsewhere = await selectDeliverable(messages, { id: "session-A", cwd }, guard);
    assert.deepEqual(elsewhere.emit.map((message) => message.framed), ["ordinary wake"], `the named session in cwd ${String(cwd)} cannot drain it`);
    assert.deepEqual(elsewhere.quarantine, []);
  }
  assert.deepEqual(guarded, [], "the guard is not even asked for another session or checkout");

  const owner = await selectDeliverable(messages, { id: "session-A", cwd: "/work/hive" }, guard);
  assert.deepEqual(owner.emit.map((message) => message.framed), ["ordinary wake", "current return"]);
  assert.deepEqual(owner.quarantine.map((message) => message.framed), ["superseded return"], "a superseded generation can never arrive later");

  const offline = await selectDeliverable(messages, { id: "session-A", cwd: "/work/hive" }, async () => "unavailable");
  assert.deepEqual(offline.emit.map((message) => message.framed), ["ordinary wake"]);
  assert.deepEqual(offline.quarantine, [], "an unreachable guard leaves the file for a later boundary");

  quarantineInboxFiles(inbox, owner.quarantine);
  consumeInboxFiles(inbox, owner.emit);
  assert.deepEqual(drainInbox(inbox).map((message) => message.framed), []);
});

test("a session announces itself once to its own per-session binding file", () => {
  const home = mkdtempSync(join(tmpdir(), "hive-hook-home-"));
  const first = announceSession(home, "Fable", "session-A", "/work/hive");
  assert.ok(first);
  assert.equal(first, join(home, "attention", "sessions", "fable", "session-A.json"));
  assert.equal(statSync(first).mode & 0o777, 0o600);
  assert.equal(announceSession(home, "fable", "session-A", "/work/hive"), null, "told once");
  assert.equal(announceSession(home, "fable", "../escape", "/w"), null, "no path segments from a session id");
  assert.deepEqual(JSON.parse(readFileSync(first, "utf8")).session_id, "session-A");
});
