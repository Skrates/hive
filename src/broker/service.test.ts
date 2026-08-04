import assert from "node:assert/strict";
import test from "node:test";
import type { ReplaySnapshot } from "../domain.js";
import { BrokerService, type SlackTransport } from "./service.js";
import { BrokerStore } from "./store.js";

test("overlapping outbox drains share one healthy in-process pass", async (t) => {
  const store = new BrokerStore(":memory:");
  t.after(() => store.close());
  store.enqueueThreadNotice("C1", "100.1", "one durable notice");

  let replyCalls = 0;
  let markStarted!: () => void;
  let releaseReply!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseReply = resolve; });
  const slack: SlackTransport = {
    async replay(): Promise<ReplaySnapshot> {
      return { channelId: "C1", threadTs: "100.1", fetchedAt: new Date(0).toISOString(), cursor: null, messages: [] };
    },
    async reply(): Promise<string> {
      replyCalls += 1;
      markStarted();
      await blocked;
      return "100.2";
    },
  };
  const broker = new BrokerService(store, slack);

  const first = broker.drainOutbox();
  await started;
  const second = broker.drainOutbox();
  const third = broker.drainOutbox();
  releaseReply();

  assert.deepEqual(await Promise.all([first, second, third]), [1, 1, 1]);
  assert.equal(replyCalls, 1);
  assert.deepEqual(store.listUnsentOutbox(), []);

  // The single-flight latch clears after completion, so a future enqueue gets
  // its own pass instead of remaining attached to the completed promise.
  assert.equal(await broker.drainOutbox(), 0);
});
