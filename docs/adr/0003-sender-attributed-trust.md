# ADR-0003: Sender-attributed trust and the frictionless wake

* Status: Accepted (requirements ratified in discussion, 2026-08-02; implemented v0.5)
* Supersedes: ADR-0001 invariant 6 ("Slack bodies are untrusted; WAKE permits routing only")
  and its crash-honesty reconciliation apparatus; ADR-0002's delivery-authority capability
  (`authorize_live_injection` and the launch-grant/key-rotation/clock-skew stratum), the
  no-effect proof and supervisor phase-ledger machinery, the `ambiguous` reconciliation
  obligations, the `legacyDraining` fences, the operator scope partition, and the
  pagination-snapshot ceremony
* Retains from ADR-0002: D1–D8 (MCP `2026-07-28` adoption: edge-as-client, Streamable HTTP
  off-box, owner-only UDS locally, exact SDK pins, bearer machine credentials, handle
  grammar, resources/tools split, begin_dispatch-creates-Task), the sender-visible Slack
  outbox, the operator CLI skeleton, and D15 observability
* Retains from ADR-0001: broker-only Slack custody, outward-only edges with no inbound
  port, `resume` never escalates to `spawn`

## Requirements (ratified in discussion, 2026-08-02)

1. Slack is the orchestration surface: the operator addresses any agent; the agent acts on
   the message as an instruction; the thread shows delivery and the agent's outcome summary.
2. Peer messages are instructions. Agent→agent messages execute without human prodding.
   Delivered-but-inert is a defect, not a safety feature.
3. Trust is sender identity, not channel sanitization. The trust set is the operator plus
   the four agents; the broker authenticates every sender.
4. The authority ceiling is each agent's own harness permissions. Hive is transport + wake:
   no per-message grants, no consent round-trips, no Hive-side approval gates.
5. Delivery is at-least-once with duplicates tolerated. Loss must be visible in the thread.
6. Mid-session steering is required, satisfied per provider (see matrix).
7. Slack credentials stay broker-only; edges stay outbound-only.

## Rulings

### R-1 — Sender-attributed trust replaces channel mistrust

The broker maintains a closed trust set: the operator's Slack user ID and each enrolled
agent identity. A message from a trust-set principal is delivered as an instruction. The
wake envelope carries `from`, the thread reference, and the body, framed imperatively — the
injected prompt reads as "Message from <sender>: <body>" with no mistrust language.
Messages from any other Slack principal are dropped with a thread notice, never delivered.

Content the sender explicitly marks as quoted/external (or that arrives via a relay tool
rather than authored text) is delimited as data in the envelope. Handling delimited data
safely is the receiving agent's ordinary hygiene, not a Hive control.

### R-2 — Authority lives at the actor

Hive never inspects, gates, or grades message content. What a message can cause is bounded
solely by the receiving agent's own harness configuration (permission settings, sandbox,
allowlists). Compromise of a trust-set principal is mitigated by those same ceilings plus
the closed sender allowlist — proportionate to a single-operator private workspace.

### R-3 — Delivery: retry freely, make loss visible

At-least-once with a fenced single claimant per delivery (one edge owns an attempt at a
time), but no exactly-once proofs. On crash, lost ACK, or any uncertainty: retry with
exponential backoff. The envelope carries a stable dedupe key (Slack message `ts` + delivery
ID) and an `attempt` counter so a receiver can recognize a redelivery at a glance. After N
attempts (default 5) the delivery terminalizes as failed and the broker posts the failure to
the thread. The `ambiguous` disposition, its reconciliation obligations, no-effect proofs,
supervisor phase ledgers, and signed terminals are removed: the worst case they prevented —
a trusted instruction arriving twice — is now an accepted cost.

### R-4 — Live ingress without launch grants

The edge holding a claimed delivery injects it directly over the machine-local owner-only
UDS ingress. No broker-signed launch capability, no key rotation ledger, no clock-skew
contract. UDS filesystem ownership is the local authentication; the edge's bearer
credential is the off-box one.

Steering matrix:

| Agent | Provider | Mechanism | Steering class |
| -- | -- | -- | -- |
| codex-1 | Codex (ChatGPT Max 20x) | app-server `turn/steer` / `turn/start`; `codex exec resume` headless | true mid-turn |
| claude-1 | Claude Code (Max 20x) | boundary hook (Stop/PostToolUse checks ingress inbox) + `--resume`/`-p` idle wake | next-boundary (≤ one tool call) |
| claude-2 | Claude Code (Team Premium) | same | next-boundary |
| claude-3 | Claude Code (Team Premium) | same | next-boundary |

Requirement 6 is satisfied by "delivery at the next natural boundary"; Hive does not
pretend to an interrupt a provider does not offer.

### R-5 — Agent identity binds to an account profile

An enrolled agent is the tuple (agent name, edge/machine, provider, account profile). Each
Claude Code agent pins its own `CLAUDE_CONFIG_DIR` (login profile); the Codex agent pins
its auth home. A wake addressed to an agent always executes under that agent's account, so
the correct subscription's quota is burned and a headless spawn cannot launch under the
wrong seat. Profile misbinding at spawn is a hard startup failure, not a fallback.

### R-6 — Reporting closes the loop

Every wake produces two thread-visible events via the retained outbox: a delivery status
(delivered / retrying / failed-after-N) and the agent's own outcome summary, posted through
the broker reply tool when the agent finishes acting. Silence is always a defect. Duplicate
outcome posts (from redelivery) are permitted and self-identifying via the dedupe key.

### R-7 — Operator surface is flat

One operator credential with read+write authority. Plain cursor pagination with no durable
snapshot rows, replay IDs, or per-scope catalogs. The CLI keeps ADR-0002's command and
exit-code skeleton minus scope ceremony.

### R-8 — Cutover is an afternoon, not a program

The v0.3 wire and the ADR-0002 grant/evidence strata are removed in one coordinated
cutover across the four machines. No `legacyDraining` state, no seven-day dual-stack
window, no compatibility preorder harness. The rollback plan is `git revert` plus
restarting four edges.

## Consequences

The hot path becomes: Slack event → broker persists delivery → edge claims → UDS inject
(or boundary hook / resume / spawn under the pinned profile) → agent acts → outcome posted.
One broker round-trip on the claim, zero on the injection. The contract shrinks by roughly
2,600 normative lines. What is given up: automated recovery proofs for a class of crash
races whose worst outcome is a duplicate instruction to a trusted agent, and multi-tenant
operator scoping for a workspace with one operator. What is gained: the product — messages
that are acted on when they arrive.

## Implementation notes (v0.5)

* The trust set is the broker admission policy (`userIds` + `appIds`); a sender outside it
  inside an admitted channel produces a durable `⛔ … not in the Hive trust set` thread
  notice. Foreign workspaces/channels stay silent — Hive does not post into rooms it does
  not occupy.
* The wake envelope is `frameWakeInstruction`: imperative body, sender, thread reference,
  `delivery/attempt/dedupe` coordinates, an explicit `hive reply <id> "<summary>"`
  instruction, and the thread replay delimited as data.
* Delivery states are `pending → claimed → accepted_local → dispatching → dispatched` with
  terminals `processed | undeliverable | failed`. Uncertainty releases the delivery
  (`release` from the edge, or the broker's lease-expiry sweep) back to `pending` behind
  `retryBackoffMs`; exhaustion terminalizes as `failed`. All failure/retry/receipt/outcome
  posts flow through the durable `outbox` table, drained by the broker.
* The machine-local plane is owner-only UDS: the edge control socket (`~/.hive/edge.sock`)
  serves live-registration heartbeats and `hive reply` outcome relay; the Codex live
  surface serves `/deliver` on its own socket; Claude delivery is an owner-only ingress
  inbox (`~/.hive/ingress/<actor>/`) drained by the `hive-claude-hook` Stop/PostToolUse
  hook, whose periodic re-registration is the session heartbeat.
* Agent outcomes (`recordOutcome`) are deliberately not lease-fenced: a long-running agent
  reports after its edge's lease expired and the report still lands, marking a non-terminal
  delivery `processed` and always posting to the thread.
* The retained MCP surface is the exact `@modelcontextprotocol` v2 `2.0.0` pins, the D6
  handle grammar (`src/mcp/handles.ts`, trimmed to v0.5 handle families), and the
  transport-hygiene modules. The sealed-authority adapter stack, capability catalog,
  generator, and conformance harnesses were removed with the stratum that demanded them;
  the future broker/edge MCP transport rebuilds on the retained pins.
