# Operations

## Secret boundary

The broker is the only process that receives Slack credentials. Supply all secrets through the
host secret store or a mode-0600 environment file; never commit them. Edges receive a broker-minted
machine token and a separate random loopback token used by live provider callbacks.

Socket Mode requires both `HIVE_SLACK_APP_TOKEN` (`xapp-…`) and `HIVE_SLACK_BOT_TOKEN` (`xoxb-…`).
The bot needs message history/reply access to the admitted private channel. Private-channel message
events already carry the literal mention text, so an `app_mention` subscription is optional; Hive
accepts it when present. The admission policy still independently checks workspace, channel, and
sender.

## Broker

Required variables are visible with `hive broker --help`; the admission policy is JSON whose fields
are arrays:

```json
{
  "workspaceIds": ["T…"],
  "channelIds": ["C…"],
  "userIds": ["U…"],
  "appIds": ["A…"],
  "mentionActors": {
    "U…": "ariadne",
    "W…": "fable"
  },
  "routerMentionIds": ["U…"],
  "originAppActors": {
    "A11111111": "ariadne",
    "A22222222": "fable"
  }
}
```

Channel attachment is the normal route. Every admitted message in an exact channel is delivered to
each actor attached to that channel. The Slack body remains untrusted: attachment authorizes
dispatch only, while the actor's subscription remains the sole source of provider, workspace,
wake-policy, and permission authority.

`mentionActors` maps Slack's immutable user IDs to Hive actors. A real Slack mention such as
`<@U…> — review this` is a wake envelope only when it begins the message (an optional leading
`[actor=sender]` decoration is tolerated) and its ID is configured here. Plain names, `@name`
text, unconfigured mentions, and mentions later in a message do not explicitly address an actor.
In an attached channel they still travel as ordinary channel traffic; in an unattached channel they
remain inert. `WAKE:`, `NEXT`, direct mentions, and `<@Hive> actor:` remain available only as
backwards-compatible single-recipient overrides.

`routerMentionIds` lists shared Hive bot identities. A router mention must begin the message and
name exactly one actor with a colon, for example `<@U…> ariadne:` or `<@U…> fable:`. A configured
router mention with a missing actor or colon is a malformed explicit envelope and gets a corrective
thread reply. Unconfigured, quoted, and mid-body mentions stay inert. A router ID should not also be
used as a per-actor identity in `mentionActors`; router semantics take precedence if it is.

`originAppActors` maps the immutable Slack app ID used by an agent to that Hive actor. Ordinary
channel fanout excludes the originating actor but still reaches attached peers. Human messages
without an app origin reach every attached actor. Hive's own correlated completion messages are
always excluded, preventing recursive delivery.

For an admitted malformed legacy envelope in an unattached channel, Hive replies with the accepted
directed forms. The same text in an attached channel is ordinary channel traffic; no grammar is
required. For a valid explicit target with no active subscription, Hive replies that no agent was
dispatched. Messages outside the admission boundary receive no routing information. Ignored and
unroutable outcomes are also written to the broker log as credential-free structured metadata; the
Slack body is never included.

Bind the HTTP listener to loopback when broker and edge share a host. Across hosts, put it behind a
private tunnel or mutually controlled HTTPS endpoint. The edge credential is bearer authority, so
plain off-box HTTP is forbidden.

```sh
hive broker
hive create-edge mac
hive put-subscription ariadne.json
```

## Operator surface

The normal inspection path is one command. It reports edge heartbeats, actor/session bindings,
registered wake and permission policy, active fences, recent delivery outcomes, ambiguous reasons,
and admitted wakes that Hive could not route. Slack message bodies are deliberately omitted.

```sh
hive status
hive status ariadne
hive deliveries --actor ariadne --status ambiguous
```

The normal attachment path is one idempotent command run from the same exact cwd as the Codex task:

```sh
hive-attach ariadne
# Equivalent explicit form:
hive attach ariadne --cwd "$PWD" --channel C…
hive detach ariadne
```

`hive attach` uses Codex's exact `CODEX_THREAD_ID` when invoked from a task and verifies that it is
a primary user-owned task at the exact cwd. A manual terminal without that context falls back to the
newest matching primary task; pass `--session <id>` to make that choice explicit. The command
atomically pins the session, remaps the home edge to that verified exact cwd, and enables the exact
channel listener. It then waits for the Desktop IPC owner to confirm the same binding revision. It
fails rather than claiming success from the broker row alone.
`hive detach` stops channel-wide delivery without changing the session binding. Codex Desktop does
not treat a leading `!` in chat as terminal passthrough; run the command in a terminal, or ask Codex
to run it.

Low-level session binding remains a narrow operation. It may update only `sessionId`,
`providerSurface`, and `providerVersion`; it cannot change the provider, home edge, workspace
mappings, wake policy, permission profile, or lease state. Only the explicit atomic attachment
operation may replace the home edge's cwd, and only after the Codex catalog proves that the selected
primary user task owns that exact cwd.

```sh
hive bind ariadne 019f... --surface app-server --provider-version 0.145.0
hive unbind ariadne
hive auto-bind ariadne
hive pin-binding ariadne
hive reconcile 42 processed --detail "wake is visible in the provider transcript"
```

`auto-bind` is home-edge-, exact-workspace-, primary-user-task-, and revision-fenced. The local
supervisor discovers the current Codex Desktop task and renews both its callback registration and
broker-visible owner presence. `pin-binding` freezes the current binding without widening any
permission or wake authority.

Slack completion text is off by default. An operator may allow it for one exact actor/channel; all
other channels still receive a fixed receipt, and Slack markup from the provider is escaped.

```sh
hive egress ariadne assistant_text --channel C…
hive outbox --state ambiguous
hive reconcile-outbox 17 sent --slack-ts 123.456 --detail "verified in the Slack thread"
```

For a small visual control surface, run `hive web`. It listens only on `127.0.0.1` (port 8792 by
default), keeps `HIVE_ADMIN_TOKEN` server-side, and never puts that token in a URL or browser
storage. Bind/unbind mutations require a same-origin request and a per-process CSRF token. Do not
publish or reverse-proxy this local dashboard.

```sh
hive web
# Hive operator dashboard: http://127.0.0.1:8792
```

The corresponding authenticated broker endpoints are:

- `GET /v1/admin/status`
- `GET /v1/admin/deliveries`
- `PUT /v1/admin/subscriptions/{actor}/attachment`
- `PATCH /v1/admin/subscriptions/{actor}/listener`
- `PATCH /v1/admin/subscriptions/{actor}/binding`
- `POST /v1/admin/deliveries/{delivery_id}/reconcile`

An edge may read only the sanitized binding for an actor whose `homeEdge` is that authenticated
edge: `GET /v1/subscriptions/{actor}`. This lets a local supervisor converge its live target without
exposing worktree mappings or another workstation's bindings. The response includes only that
actor's effective permission profile so the home edge can preflight the exact provider capability.

The broker SQLite file is the delivery ledger. Back it up with SQLite's online backup mechanism or
while the service is stopped; copying a live database without its WAL is not a backup.

## Edge and live surfaces

Run `hive edge` on each mapped workstation. `HIVE_EDGE_LOCAL_TOKEN` is shared only with local live
surface processes and the edge HTTP listener remains on loopback.

For Codex live steering, run the supervised `codex/live` process (the macOS installer installs its
LaunchAgent). In automatic mode it discovers only the newest primary user task at the subscription's
exact mapped cwd, follows that owner through Codex Desktop's private mode-0600 IPC socket, and uses
the standalone app-server only for surfaces explicitly declared as app-server-owned. It registers
only the exact actor/session/surface/version/revision tuple and reports owner presence to the broker.
A stale or unloaded Desktop task is not a live target; Hive fails closed rather than opening a
competing session.

For Claude Code, register `hive-claude-channel` as a custom channel MCP server. During the Channels
preview Claude Code also requires its custom-channel development flag. Headless resume/spawn does
not depend on the channel surface. Headless execution loads no filesystem settings source and starts
with a strict empty MCP set; personal or project plugins, hooks, settings, and workstation MCP
servers are not inherited into a delivery. Hive disables Claude's auto-updater in the service and
child environment and checks the exact subscription-pinned Claude version before every dispatch.

Provider surfaces are ownership fences. `codex-desktop-ipc`, `desktop-ipc`, app-server control
surfaces, and Claude channel surfaces require an exact live registration; they never fall through
to a headless writer when a supervisor disappears. Only explicit headless surfaces (`headless-exec`,
`codex-cli`, or `claude-cli`) may resume or spawn through the CLI. Unknown surfaces fail closed.

On the Linux Fable edge, pin `HIVE_NODE_COMMAND`, `HIVE_CLAUDE_COMMAND`, and
`HIVE_CLAUDE_VERSION` in the mode-0600 edge environment. The installer checks their absolute paths,
Node major version, exact Claude version and required CLI flags, Fable's broker-side
`workspace-write`/`spawn` authority, mapped cwd, and loopback-tunnel-or-HTTPS broker URL before it
stops the old service. The systemd unit then uses those same binaries and a controlled PATH.

## Ambiguity

If a lease expires after provider dispatch begins but before durable completion, Hive records
`ambiguous` and never silently retries. Inspect the provider transcript, then call the authenticated
admin reconciliation endpoint with either `processed` or `requeue` and a non-empty audit detail.

```text
POST /v1/admin/deliveries/{delivery_id}/reconcile
{"disposition":"processed","detail":"wake visible in provider transcript"}
```
