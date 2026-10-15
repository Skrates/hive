# Hive

Hive is a private development-shop coordination service for event-driven wakeups between
frontier-model teammates. Slack remains the discussion bus, Linear the durable decision ledger,
and Git executable truth.

The authoritative design is [ADR-0003](docs/adr/0003-sender-attributed-trust.md) (sender-attributed
trust), which supersedes most of ADR-0001/0002. [ADR-0004](docs/adr/0004-human-attention-queue.md)
adds Hive Attention. Deployment, secrets and runbooks are in [the operations guide](docs/operations.md).

## Shape

- A central broker owns Slack Socket Mode, Slack credentials, admission, durable events,
  deliveries, subscriptions and fenced actor leases.
- A thin edge on each seat host owns provider-local session discovery, live steering, headless
  resume/spawn and the provider dispatch journal. Edges connect outward and expose no inbound port.
- Trust is sender identity: a message from the closed trust set is delivered as an instruction;
  anyone else is dropped with a thread notice. Hive never grades content — the ceiling is the
  receiving seat's own harness configuration.
- Wake policies are `live_only`, `resume` and `spawn`. Delivery is at-least-once with a single
  fenced claimant, and every wake ends in two thread-visible events: a delivery status and an outcome.

## Hive Attention

A durable queue of human interventions on the same broker (ADR-0004). Seats ring the bell instead
of interrupting Hákon; he takes the next item at a natural handoff; his recorded answer returns to
the originating work as an ordinary Hive wake.

- **Seats** bind their work context once, then summon — through their own edge, never naming
  themselves: `hive attention bind …`, then `hive attention summon --source-file F --file ENVELOPE`
  (or the `hive-attention` launcher and skill from agent-affordances / weave-doctrine).
- **The human** pulls: `hive attention next`, then `hive attention resolve <id> --expected-revision <n>
  --outcome <outcome> --response "<decision>" [--next]` from an operator shell
  (`HIVE_BROKER_URL` + `HIVE_ADMIN_TOKEN`). With the Slack front end on (ADR-0004 Amendment 1), each
  summons also arrives as one DM card — **Take next** is the main button — and the app's Home tab
  shows the queue.
- Answers return context-restored to headless seats, or into the exact captured session when a
  live surface can honour it. Nothing waits on the human: a summoning turn ends normally.
- Off by default; `HIVE_ATTENTION_ENABLED=true` on the broker enables it. `hive attention doctor`
  is the health check.

## Development

```sh
bun install
bun run check
bun run build
```

No live credential belongs in the repository. Broker and edge credentials are injected from the
host secret store.

## Toolchain

ruff/ty/uv are not pinned here — the Weave-wide version authority is the private
`weave-doctrine` repo: its `mise.toml` pins every tool for every seat and CI
runner (`just tools` there installs them; the prek hooks call the bare binaries
off PATH). CI carries transitional pinned installs until the self-hosted-runner
migration.
