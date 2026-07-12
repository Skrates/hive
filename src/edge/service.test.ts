import assert from "node:assert/strict";
import test from "node:test";
import { headlessAcknowledgement } from "./service.js";

test("Codex JSONL receipt yields the final agent message", () => {
  const receipt = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Handled and recorded." } }),
  ].join("\n");
  assert.equal(headlessAcknowledgement(receipt), "Handled and recorded.");
});

test("Claude stream JSON receipt yields the result", () => {
  const receipt = JSON.stringify({ type: "result", subtype: "success", result: "Done from Claude." });
  assert.equal(headlessAcknowledgement(receipt), "Done from Claude.");
});
