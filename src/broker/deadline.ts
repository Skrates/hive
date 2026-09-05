/**
 * A bound on one awaited step. Every await the deafness watchdog performs is on
 * something that can hang without erroring — a Slack HTTP call under the
 * WebClient's ~30-minute retry policy, a WebSocket disconnect, a Socket Mode
 * handshake. An unbounded one of those does not merely delay a cycle: it holds
 * the single-flight cycle open, so every later interval is skipped and the
 * detector goes quiet in exactly the state it exists to catch.
 */

/** The awaited work outran its deadline; the caller decides what that means. */
export class DeadlineExceeded extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
    super(`${label} exceeded ${ms}ms`);
  }
}

export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label, ms)), ms);
  });
  // Work that rejects after the deadline won the race must not surface as an
  // unhandled rejection — the race already carried the outcome.
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
