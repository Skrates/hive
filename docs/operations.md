# Operations

## Secret boundary

The broker is the only process that receives Slack credentials. Supply all secrets through the
host secret store or a mode-0600 environment file; never commit them. Edges receive a broker-minted
machine token and a separate random loopback token used by live provider callbacks.

Socket Mode requires both `HIVE_SLACK_APP_TOKEN` (`xapp-…`) and `HIVE_SLACK_BOT_TOKEN` (`xoxb-…`).
The bot needs message history/reply access to the admitted private channel. The app subscribes to
message events and the admission policy still independently checks workspace, channel, and sender.

## Broker

Required variables are visible with `hive broker --help`; the admission policy is JSON whose fields
are arrays:

```json
{
  "workspaceIds": ["T…"],
  "channelIds": ["C…"],
  "userIds": ["U…"],
  "appIds": ["A…"]
}
```

Bind the HTTP listener to loopback when broker and edge share a host. Across hosts, put it behind a
private tunnel or mutually controlled HTTPS endpoint. The edge credential is bearer authority, so
plain off-box HTTP is forbidden.

```sh
hive broker
hive create-edge mac
hive put-subscription ariadne.json
```

The broker SQLite file is the delivery ledger. Back it up with SQLite's online backup mechanism or
while the service is stopped; copying a live database without its WAL is not a backup.

## Edge and live surfaces

Run `hive edge` on each mapped workstation. `HIVE_EDGE_LOCAL_TOKEN` is shared only with local live
surface processes and the edge HTTP listener remains on loopback. It authorizes registration and
edge-to-surface callback admission; it is deliberately insufficient to acknowledge a delivery.

Initial registration returns a pending edge-issued `bindingId` and monotonic `bindingRevision`; an
immediate exact-fence renewal confirms it before the edge may dispatch. A surface keeps that fence
process-locally and supplies both values on every later serialized TTL renewal. The
actor, provider, callback URL, session, and surface version are immutable within a binding epoch;
a stale or retargeted renewal fails closed. Every callback carries the exact selected fence and the
surface rejects it before delivery when it does not match its current binding.

For each live dispatch the edge also mints a single-use ACK bearer bound to delivery ID, lease
generation, and provider attempt. The bearer expires with the broker lease and is the only
authorization accepted by `POST /v1/live/ack`; never persist, log, place in a provider transcript,
or forward it as model-visible metadata. A live surface with an explicit agent-ACK interface
resolves it process-locally when handling that acknowledgement. `HIVE_EDGE_LOCAL_TOKEN` presented
to the ACK route fails closed.

For Codex live steering, run `hive-codex-live` with the current Codex thread ID. It connects by
WebSocket to the app-server Unix control socket and registers only when that same server reports the
thread `active` or `idle`. A persisted Desktop-owned thread that the standalone daemon reports as
`notLoaded` is not a live target; Hive fails closed rather than opening a competing session.
Codex app-server does not support adding a typed tool to an already-created thread. The v0.3
surface therefore never treats generic turn completion as an ACK and never exposes the bearer to
the transcript; an attached Codex delivery remains `dispatched` until an explicit ACK seam exists
or the lease expires to honest `ambiguous` reconciliation.

For Claude Code, register `hive-claude-channel` as a custom channel MCP server. During the Channels
preview Claude Code also requires its custom-channel development flag. Headless resume/spawn does
not depend on the channel surface. Its `hive_ack` tool resolves the exact delivery, generation, and
provider-attempt bearer inside the channel process.

## Ambiguity

If a lease expires after provider dispatch begins but before durable completion, Hive records
`ambiguous` and never silently retries. Inspect the provider transcript, then call the authenticated
admin reconciliation endpoint with either `processed` or `requeue` and a non-empty audit detail.

```text
POST /v1/admin/deliveries/{delivery_id}/reconcile
{"disposition":"processed","detail":"wake visible in provider transcript"}
```
