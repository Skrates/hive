# Hive

Hive is a private development-shop coordination service for event-driven wakeups between
frontier-model teammates. Slack remains the discussion bus, Linear the durable decision ledger,
and Git executable truth.

The implementation is governed by [ADR-0001](docs/adr/0001-broker-edge-architecture.md) and
[KRA-717](https://linear.app/krates-ehf/issue/KRA-717/hive-ears-v03-brokeredge-architecture).
Deployment and secret-store requirements are in [the operations guide](docs/operations.md).

## Shape

- A central broker owns Slack Socket Mode, Slack credentials, admission, replay, durable events,
  deliveries, subscriptions, and fenced actor leases.
- A thin edge on each workstation owns provider-local session discovery, supervised live steering,
  fenced headless resume/spawn, and the provider dispatch journal. Codex Desktop rebinding follows
  the latest matching primary task automatically; there is no listener ritual.
- Wake policies are `live_only`, `resume`, and `spawn`.
- Slack content is always untrusted data. A wake authorizes dispatch, never mutation authority.
- Explicit `WAKE:`/`NEXT` envelopes, configured direct mentions, and the shared-bot
  `<@Hive> actor:` form can address an actor; malformed or unroutable admitted wakes explain
  themselves in their Slack thread.

## Development

```sh
pnpm install
pnpm check
pnpm build
```

No live credential belongs in the repository. Broker and edge credentials are injected from the
host secret store.

Once configured, `hive status` is the one-shot operational view and `hive web` serves the
loopback-only control surface. See the [operations guide](docs/operations.md#operator-surface) for
binding, delivery inspection, reconciliation, and dashboard security details.
