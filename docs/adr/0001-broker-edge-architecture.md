# ADR-0001: Broker/edge architecture for event-driven teammate wakeups

- Status: Accepted
- Decision: D-HIVE-HOME v3
- Ratified: 2026-07-12 by Hákon Freyr Gunnarsson
- Durable ledger: [KRA-717](https://linear.app/krates-ehf/issue/KRA-717/hive-ears-v03-brokeredge-architecture)

## Context

Polling the Hive Slack channel dropped crossing messages and could only reach a model session that
was already running. Hive needs one delivery contract that can steer a live session, resume a
persisted session, or—only under explicit policy—spawn a headless session.

This is development-shop meta-infrastructure. It does not belong in the Sokrates product runtime or
Agora credential boundary and never ships in an appliance.

## Decision

### Home and topology

Hive lives in a standalone repository. A central broker runs on the always-on development box. A
thin edge runs on each workstation. The broker alone owns Slack Socket Mode and Slack credentials;
edges use authenticated outbound connections. Off-box traffic uses HTTPS or a private tunnel.

### Broker authority

SQLite is authoritative for normalized Slack events, deliveries, subscriptions, actor leases,
monotonic fencing generations, and terminal reason sets. Slack event IDs are unique and the broker
assigns monotonic delivery IDs.

Delivery advances through:

```text
pending -> claimed -> accepted_local -> dispatching -> dispatched
```

Terminal dispositions are `processed`, `undeliverable`, `ambiguous`, and `dead_letter`, each with a
typed reason set. JSONL is an audit/export format only.

### Crash honesty

Broker and edge deduplicate independently. A crash between provider injection and recording the
dispatch is intrinsically ambiguous. The edge retries only when that exact deployed provider path
has proven idempotency; otherwise the broker records `ambiguous` and requires reconciliation.

In v0.3 reconciliation posts an operator-visible Hive alert. A human inspects the provider session
transcript and records `processed` or `requeue`. Fencing rejects stale claims and acknowledgements;
it cannot retract a provider steer that already happened.

### Subscription and wake policy

A subscription records actor, provider and surface version, session/thread ID, home edge, logical
workspace, per-edge cwd/worktree mapping, wake policy, permission profile, lease/deadline, and
coalescing/rate-limit policy.

- `live_only`: deliver only to a registered live ingress; otherwise `undeliverable`.
- `resume`: prefer live, otherwise resume the mapped session on its home edge before the TTL;
  failure is `undeliverable` and never escalates to spawn.
- `spawn`: prefer live and home-edge resume. After a configured grace period, one fenced eligible
  edge with the declared workspace mapping may spawn a headless session. Wakes coalesce by actor and
  Slack thread and are rate-capped.

Foreign edges never resume machine-local sessions. Hive never opens a desktop UI to satisfy a wake.

### Provider adapters

- Live Codex uses app-server `turn/steer`, queues when non-steerable, and uses `turn/start` when idle.
- Live Claude Code uses a `claude/channel` MCP notification.
- Inactive Codex uses `codex exec resume <session-id>`.
- Inactive Claude Code uses `claude -p --resume <session-id>`.
- Spawn creates a new headless session under the subscription permission profile and records its ID.

For one-shot headless adapters, provider process exit zero after a complete streamed turn is the
provider acknowledgement and terminalizes the delivery as `processed`; the captured output is its
receipt. Live adapters remain `dispatched` until the agent explicitly acknowledges through Hive.

Provider versions and capabilities are recorded and proven by deployed acceptance tests.

### Replay

Deliveries contain an initial broker-assembled thread snapshot and cursor. Immediately before
acting, the edge requests a fresh replay. The broker calls Slack `conversations.replies` and returns
bytes plus envelope metadata. It may assemble but never summarize, redact, prioritize, or interpret.

### Broker/edge protocol

v0.3 uses long-poll HTTP semantics: deliveries after a durable offset, explicit accept/dispatch/result
transitions carrying delivery ID and lease generation, and callable thread replay. Each edge has a
broker-minted machine credential. WebSocket delivery is a later optimization.

### Trust and authority

Admission gates Slack workspace/channel and sender user/app identity. Slack bodies are model-visible
untrusted data. `WAKE` authorizes dispatch only. Launch permission derives from the subscription;
repository mutation and other high-impact authority remain independently pre-registered and cannot
be elevated by Slack content. Spawn defaults to a restricted permission profile.

## Acceptance

A. A live Slack event reaches both live provider surfaces.
B. A stopped mapped session resumes with its conversation and workspace.
C. Explicit spawn policy creates exactly one headless session in the registered workspace.
D. Broker/edge restarts preserve stable identity and an honest terminal disposition.
E. Crossing Slack messages survive through fresh full-thread replay.
F. Provider acknowledgement carries the Slack event ID and delivery ID.
G. Fencing rejects a revived stale edge; uncertain prior dispatch becomes `ambiguous`.
H. Non-allowlisted input never dispatches; hostile allowlisted content remains untrusted.
I. The complete wake-policy matrix terminates correctly and bursts cannot fork-storm.

## Consequences

The Hive Slack protocol will replace polling cadence with event-driven wake semantics. Ariadne owns
implementation and deployment proof; Fable independently reviews the deployed seam, including live
events, restart, fencing, and hostile-input tests.
