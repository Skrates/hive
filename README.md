# Hive

Hive is a private development-shop coordination service for event-driven wakeups between
frontier-model teammates. Slack remains the discussion bus, Linear the durable decision ledger,
and Git executable truth.

The implementation is governed by [ADR-0001](docs/adr/0001-broker-edge-architecture.md) and
[KRA-717](https://linear.app/krates-ehf/issue/KRA-717/hive-ears-v03-brokeredge-architecture).

## Shape

- A central broker owns Slack Socket Mode, Slack credentials, admission, replay, durable events,
  deliveries, subscriptions, and fenced actor leases.
- A thin edge on each workstation owns provider-local session discovery, live steering, headless
  resume/spawn, and the provider dispatch journal.
- Wake policies are `live_only`, `resume`, and `spawn`.
- Slack content is always untrusted data. A wake authorizes dispatch, never mutation authority.

## Development

```sh
pnpm install
pnpm check
pnpm build
```

No live credential belongs in the repository. Broker and edge credentials are injected from the
host secret store.
