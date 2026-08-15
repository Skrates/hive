# Hive implementation guide

The authoritative design is `docs/adr/0003-sender-attributed-trust.md` (v0.5), which supersedes
most of ADR-0002's authority strata and ADR-0001's channel-mistrust invariant. Read the relevant
ruling before changing a contract; ADR-0001/0002 remain as history and for their retained
invariants.

## Non-negotiable shape (ADR-0003)

- Slack Socket Mode and Slack credentials live only at the central broker.
- Trust is sender identity: the broker's admission policy is a closed trust set; a trust-set
  message is delivered as an instruction, framed imperatively. Anyone else is dropped with a
  thread notice. Hive never inspects, gates, or grades content — the authority ceiling is the
  receiving agent's own harness configuration.
- Workstation edges connect outward and expose no inbound network port. The machine-local plane is
  owner-only Unix domain sockets; filesystem ownership is the local authentication.
- Delivery is at-least-once with a single fenced claimant; exactly-once is not claimed and not
  reconstructed. Uncertainty retries behind backoff; exhaustion terminalizes as `failed` with a
  thread-visible notice. Duplicates are tolerated and self-identifying (dedupe key + attempt).
- Every wake produces two thread-visible events through the durable outbox: a delivery status and
  the agent's outcome (`hive reply`). Silence is a defect.
- A seat addresses a peer with an explicit act (`hive wake <actor> "<text>"`), never by writing a
  `WAKE:` line into an outcome — every Hive post is `hive_*`-stamped and dropped at admission, so
  text position can never carry intent. Attribution comes from the source delivery's ledger row,
  the ledger commits before the commons render, and an undeliverable mint fails loudly.
- A wake executes under the subscription's pinned account profile; a missing profile is a hard
  pre-dispatch failure, never a fallback.
- `resume` never escalates to `spawn`.

## Gate

```sh
bun run check
bun run build
```
