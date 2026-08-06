# Operations

## Secret boundary

The broker is the only process that receives Slack credentials. Supply all secrets through the
host secret store or a mode-0600 environment file; never commit them. Edges receive a broker-minted
machine token. The machine-local plane (edge control socket, live surface sockets, ingress inboxes)
authenticates by filesystem ownership — owner-only Unix domain sockets and directories, no local
tokens.

Socket Mode requires both `HIVE_SLACK_APP_TOKEN` (`xapp-…`, scope `connections:write`) and
`HIVE_SLACK_BOT_TOKEN` (`xoxb-…`). The bot token needs, for the admitted private channel:
`groups:history` (thread replay), `chat:write` (outbox posts), and `reactions:write` (lifecycle
stamps on wake messages). A missing `reactions:write` does not block delivery — every stamp fails
as `missing_scope`, logged and dropped — so grant it up front rather than discovering the silence
later.

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

Run `hive edge` on each mapped machine. The edge's environment file MUST set a `PATH` that
contains the provider CLI and `~/.local/bin` (where `hive`, `hive-claude-hook`, and the `node`
symlink live) — a service manager's bare default PATH makes every headless spawn die on ENOENT,
which surfaces as `provider_dispatch_unknown` with no stderr, and stays invisible as long as live
deliveries keep succeeding. The edge serves its control plane on an owner-only UDS socket
(`HIVE_EDGE_SOCKET`, default `~/.hive/edge.sock`):

- live surfaces and hooks renew their liveness registration there (the TTL is the heartbeat);
- `hive reply <delivery-id> "<summary>"` relays an agent's outcome to the broker — not lease-fenced,
  safe to run long after the wake.

Every subscription pins an `accountProfile` — the absolute path of the agent's login profile
(`CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex) on its home edge. A missing profile
directory is a hard pre-dispatch failure (`account_profile_missing`); Hive never falls back to
whatever seat the edge process is logged into (ADR-0003 R-5).

For Codex, use a dedicated pinned `CODEX_HOME` with no legacy `sandbox_mode` or
`sandbox_workspace_write` entries in its `config.toml`. Hive selects a current Codex permission
profile at dispatch time: read-only or workspace write plus the exact owner-only Hive edge socket,
with ordinary outbound network denied. Current Codex intentionally does not compose permission
profiles with legacy sandbox configuration. Authenticate the dedicated home once with
`CODEX_HOME=/absolute/profile/path codex login` before enrolling the subscription.

### Codex live steering

Run `hive-codex-live` with the current Codex thread ID. It connects to the app-server control
socket, owns or resumes the persisted thread on that long-lived connection, serves `/deliver` on
its own owner-only UDS socket, and keeps its registration fresh with the edge. A wake injected into
an active thread is true mid-turn steering. The bridge waits for that exact turn to complete and
returns its final assistant text as the provider outcome, so live Codex turns must not run
`hive reply` themselves. Failure, interruption, timeout, disconnect, or loss of correlation is
uncertainty and is retried. Without a live registration the edge falls back to `codex exec resume`
or spawn according to the subscription policy.

The supervisor's pinned thread is the dedicated fallback. To route an actor into the foreground
Codex Desktop task from that task's shell, run `hive attach <actor>` (or pass `--session <id>` when
`CODEX_THREAD_ID` is unavailable). Attachment is never inferred from "most recent": Hive verifies
an unarchived primary user task at the exact `--cwd`, writes an owner-only revision file, follows
that exact task through Desktop's owner-only IPC stream, and waits for the live surface to confirm
the revision. `hive detach <actor>` removes the binding and waits for the dedicated fallback to be
restored. A present attachment that is invalid, stale, or lacks a Desktop owner withdraws live
registration; it never silently sends the wake to the dedicated task. `GET /binding` on the
actor's owner-only live UDS exposes only the mode, cwd, and attachment revision for diagnosis.

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
notices, and the agent's outcome. Completion-tracked Codex live and headless outcomes are relayed
by the edge from the provider's final response; Claude live boundary delivery uses `hive reply`.
Silence is a defect — a delivered wake with no outcome post means the loop never closed.

There is no reconciliation surface. If a delivery failed, the thread says so; send the message
again or fix the edge.

The wake message itself also carries glanceable state as emoji reactions, stamped by the broker
when the corresponding outbox row drains: :eyes: once the delivery is dispatched, :white_check_mark:
when an outcome closes it, :x: on any terminal failure. Reactions are annotation, not contract —
the thread posts above remain the durable record, and a failed stamp is logged and dropped.

## Scheduled wakes

A Slack message scheduled with the native **Send later** posts as the scheduling user at the
chosen time and reaches the broker as an ordinary message event — so a scheduled
`WAKE: <actor> …` is cron-style agent scheduling with zero new infrastructure. Recurring
operator rituals (morning status sweeps, deploy-window checks) should be scheduled messages, not
human memory.

The admission boundary is unchanged: the *sender at post time* must be in the trust set. That is
true for an operator's Send-later message. It is NOT generally true for messages scheduled by a
seat through a Slack API client — those post under that app's bot identity, and an unadmitted bot
is dropped with a thread notice. Admitting such an identity widens the trust set to everyone who
can make that app post; that is an operator policy decision, never a default.
