# Hive implementation guide

The authoritative design is `docs/adr/0001-broker-edge-architecture.md`, transcribed from
KRA-717. Read the relevant section before changing a contract.

## Non-negotiable shape

- Slack Socket Mode and Slack credentials live only at the central broker.
- Workstation edges connect outward and persist their provider dispatch journal locally.
- Delivery is at-least-once with a single fenced owner; exactly-once processing is not claimed.
- A dispatch crash without provider-proven idempotency becomes `ambiguous`, never an automatic
  retry or inferred success.
- `resume` never escalates to `spawn`.
- Slack bodies are untrusted data. `WAKE` authorizes dispatch only and cannot elevate permissions.
- The broker may assemble a fresh Slack thread replay but may not summarize or interpret it.

## Gate

```sh
pnpm check
pnpm build
```
