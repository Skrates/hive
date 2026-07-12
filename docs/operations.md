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
surface processes and the edge HTTP listener remains on loopback.

For Codex live steering, run `hive-codex-live` with the current Codex thread ID. It connects by
WebSocket to the app-server Unix control socket and registers only when that same server reports the
thread `active` or `idle`. A persisted Desktop-owned thread that the standalone daemon reports as
`notLoaded` is not a live target; Hive fails closed rather than opening a competing session.

For Claude Code, register `hive-claude-channel` as a custom channel MCP server. During the Channels
preview Claude Code also requires its custom-channel development flag. Headless resume/spawn does
not depend on the channel surface.

## Ambiguity

If a lease expires after provider dispatch begins but before durable completion, Hive records
`ambiguous` and never silently retries. Inspect the provider transcript, then call the authenticated
admin reconciliation endpoint with either `processed` or `requeue` and a non-empty audit detail.

```text
POST /v1/admin/deliveries/{delivery_id}/reconcile
{"disposition":"processed","detail":"wake visible in provider transcript"}
```
