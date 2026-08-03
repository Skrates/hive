import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeInboxFiles, drainInbox, hookOutput } from "./claude-hook.js";

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
