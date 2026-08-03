# Operations

## Secret boundary

The broker is the only process that receives Slack credentials. Supply all secrets through the
host secret store or a mode-0600 environment file; never commit them. Edges receive a broker-minted
machine token. The machine-local plane (edge control socket, live surface sockets, ingress inboxes)
authenticates by filesystem ownership — owner-only Unix domain sockets and directories, no local
tokens.

Socket Mode requires both `HIVE_SLACK_APP_TOKEN` (`xapp-…`) and `HIVE_SLACK_BOT_TOKEN` (`xoxb-…`).
The bot needs message history/reply access to the admitted private channel.

## Trust set (ADR-0003 R-1)

The admission policy is the closed trust set: the operator's Slack user ID(s) plus each enrolled
agent identity. A message from a trust-set principal in an admitted channel is delivered as an
instruction. A message from anyone else in an admitted channel is dropped with a thread notice.
Messages outside admitted workspaces/channels are ignored silently.

```json
{
  "workspaceIds": ["T…"],
  "channelIds": ["C…"],
  "userIds": ["U-operator-1", "U-operator-2"],
  "appIds": ["A-hive-app"]
}
```

## Broker

Required variables are visible with `hive broker --help`. Bind the HTTP listener to loopback when
broker and edge share a host. Across hosts, put it behind a private tailnet or mutually controlled
HTTPS endpoint. The edge credential is bearer authority, so plain off-box HTTP is forbidden.

```sh
hive broker
hive create-edge mac
hive put-subscription ariadne.json
hive status
```

The broker SQLite file is the delivery ledger and the durable outbox. Back it up with SQLite's
online backup mechanism or while the service is stopped; copying a live database without its WAL is
not a backup.

## Edge and local surfaces

Run `hive edge` on each mapped machine. The edge serves its control plane on an owner-only UDS
socket (`HIVE_EDGE_SOCKET`, default `~/.hive/edge.sock`):

- live surfaces and hooks renew their liveness registration there (the TTL is the heartbeat);
- `hive reply <delivery-id> "<summary>"` relays an agent's outcome to the broker — not lease-fenced,
  safe to run long after the wake.

Every subscription pins an `accountProfile` — the absolute path of the agent's login profile
(`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex) on its home edge. A missing profile
directory is a hard pre-dispatch failure (`account_profile_missing`); Hive never falls back to
whatever seat the edge process is logged into (ADR-0003 R-5).

### Codex live steering

Run `hive-codex-live` with the current Codex thread ID. It connects to the app-server control
socket, verifies the thread is live, serves `/deliver` on its own owner-only UDS socket, and keeps
its registration fresh with the edge. A wake injected into an active thread is true mid-turn
steering; without a live registration the edge falls back to `codex exec resume` / spawn.

### Claude Code boundary delivery

Register `hive-claude-hook` as a Stop and PostToolUse hook in the agent's pinned profile
(`$CLAUDE_CONFIG_DIR/settings.json`):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "hive-claude-hook" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "hive-claude-hook" }] }]
  }
}
```

The hook needs `HIVE_ACTOR` in the session environment. At every boundary it renews the actor's
liveness registration and drains the owner-only ingress inbox (`~/.hive/ingress/<actor>/`),
injecting pending wake envelopes into the session. While the heartbeat is fresh the edge delivers
by inbox alone; once it lapses the edge wakes the session with `--resume`/`-p` instead. Both paths
may occasionally deliver the same message — duplicates are tolerated and self-identifying by
dedupe key (ADR-0003 R-3).

## Delivery lifecycle (ADR-0003 R-3/R-6)

At-least-once with one fenced claimant per attempt. Uncertainty (edge crash, lost provider
outcome, expired lease) requeues the delivery behind exponential backoff; after `maxAttempts`
(default 5) it terminalizes as `failed`. Every state the sender cares about is posted to the
thread through the durable outbox: delivery receipt, retry notices, failure notices, dropped-sender
notices, and the agent's own `hive reply` outcome. Silence is a defect — a delivered wake with no
outcome post means the agent never closed the loop.

There is no reconciliation surface. If a delivery failed, the thread says so; send the message
again or fix the edge.
