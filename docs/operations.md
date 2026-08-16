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
an active thread is true mid-turn steering. For a foreground Desktop task, the bridge correlates
the stable Hive delivery message, waits through its `steered` boundary, and returns the next
durable `final_answer` as the provider outcome even if the enclosing task remains active. A retry
recovers that recorded answer instead of injecting the same delivery again. Dedicated app-server
delivery still waits for its exact terminal turn. Live Codex turns must not run `hive reply`
themselves. Failure, interruption, timeout, disconnect, or loss of correlation is uncertainty and
is retried. Without a live registration the edge falls back to `codex exec resume` or spawn
according to the subscription policy.

The supervisor's pinned thread is the dedicated fallback. To route an actor into the foreground
Codex Desktop task from that task's shell, run `hive attach <actor>` (or pass `--session <id>` when
`CODEX_THREAD_ID` is unavailable). Attachment is never inferred from "most recent": Hive verifies
an unarchived primary user task at the exact `--cwd`, writes an owner-only revision file, follows
that exact task through Desktop's owner-only IPC stream, and waits for the live surface to confirm
the revision. `hive detach <actor>` removes the binding and waits for the dedicated fallback to be
restored. If replacement attachment confirmation fails, the CLI revision-fences its rollback and
atomically restores the prior binding instead of deleting a working route. A present attachment
that is invalid, stale, or lacks a Desktop owner withdraws live
registration; it never silently sends the wake to the dedicated task. `GET /binding` on the
actor's owner-only live UDS exposes only the mode, cwd, and attachment revision for diagnosis.
The Desktop state home and the actor's pinned `CODEX_HOME` may be separate directories, but their
resolved `auth.json` must be the same owner-only regular file. Provision the pinned profile by
linking its `auth.json` to the authenticated Desktop home's artifact; do not run a second independent
`codex login` in the profile. A missing, insecure, or different auth artifact rejects the wake before
Desktop injection and terminalizes it as undeliverable.

Install the repository-owned Codex command once with `hive install-codex-skill`. Codex lists it
as **Hive Attach** in the `/` menu (its explicit skill token is `$hive-attach`). The command defaults
to the checked-in Codex actor `codex-1`, reads `CODEX_THREAD_ID` only from the invoking task, resolves that task's physical cwd,
and runs the same revision-confirmed `hive attach` path above. It is marked explicit-only, so ordinary
conversation cannot silently change the foreground binding.

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

## Wake attestation binding (KRA-1077)

Every delivery the edge claims is bound, before dispatch, to the attestation of the home the
turn will actually execute under. Headless spawn/resume reads `.weave-attestation.json` from the
subscription's `accountProfile`. A live surface that has registered a runtime attestation wins
instead — a foreground Codex Desktop attachment (`HIVE_CODEX_DESKTOP_HOME` ≠ pinned profile)
injects into Desktop and must be bound to Desktop's record, not the pinned profile's. The
`attestation_id` and doctrine commit sit in the same `local_deliveries` row as the provider
receipt. That row is the trace: delivery id → attestation id → the exact instruction, settings,
and skill corpus hashes the seat was installed with. `weave doctor` resolves the other end.

A live registration freezes the runtime attestation captured when that `sessionId` first
registered, and holds it while the surface keeps reporting the same record. A new session id,
or a lapsed heartbeat, takes a fresh snapshot.

A registration that carries no attestation field at all is recorded as `attestation_unreported`
rather than as an omission, so "this session never told us what it loaded" stays distinguishable
from "no session is registered". That matters in one direction only: if the *first* registration
reported nothing, a later heartbeat that does carry an id cannot be adopted as the snapshot the
session started under — the pair is `attestation_ambiguous`, because a session spanning a hook
rollout may have loaded different artifacts than the ones now on disk. In the other direction a
heartbeat carrying nothing is simply non-evidence and leaves a known snapshot untouched.

When the reports for one live `sessionId` *disagree*, the edge names the ambiguity instead of
picking a side. A surface reports what its home holds at report time — the Claude hook is a new
process at every boundary — so a reinstall under a still-running session and a crash-then-`--resume`
of the same session id under new artifacts send the identical sequence, and `sessionId` equality
is not proof the loaded runtime survived. The delivery records `attestation_ambiguous` and
dispatches normally; a wrong id would be worse than a named absence. Two absences are not a
disagreement — neither offers an id, so the session's first, more specific absence stands.

One subscription snapshot governs a whole turn: the one the delivery was claimed under. Broker
transitions rebuild their delivery by joining the live `subscriptions` row, so an ordinary
`hive subscribe` re-run landing mid-turn would otherwise route the dispatch through the new
snapshot while the row recorded the binding taken from the claimed one. The new snapshot governs
the next delivery.

The edge records; it does not verify and it does not refuse.

- **Verification lives in one implementation.** `weave doctor` rehashes the record and rejects one
  whose id does not match its own bytes. Re-deriving the content address here would mean a second
  canonical-JSON encoder in another language, and two encoders that disagreed by one escape
  sequence would reject every honest wake. What the edge stores is what the profile *claims*, bound
  immutably to the delivery; whether the claim is true is the doctor's verdict on the same id.
- **An absent record never fails a wake.** Attestation is evidence, not authority — KRA-1074's D1
  ruled the surface first and enforcement after. A profile with no attestation, an unreadable one,
  an unknown schema, one installed for a different actor, and a live session the edge cannot
  attribute all dispatch normally and record a named `attestation_absence` beside the delivery. A misbound seat now leaves evidence at wake
  time instead of needing git forensics afterwards.
- **Nor does it stall — under three separate bounds.** "Does not refuse" is worth nothing if the
  read can hang instead: a profile on a network mount is a supported shape, and `O_NONBLOCK`
  bounds FIFOs and devices but has no effect on a regular file whose mount has stalled. So the
  read carries three guards for three failure modes: `O_NONBLOCK` for FIFOs and devices; the
  libuv threadpool, so a stalled mount cannot park the event loop; and a wall-clock timeout
  (`ATTESTATION_READ_TIMEOUT_MS`, 2s), because the threadpool bounds the *loop* and not the
  *delivery*. Without the third, a stalled read holds one of the four dispatch slots
  indefinitely, and four of them stop the claim loop for every actor on the edge — the outcome
  the threadpool move was meant to prevent, reached by a different route. The blocked libuv
  thread itself cannot be reclaimed by a timeout, so `UV_THREADPOOL_SIZE` is set above the
  dispatch cap in **all three** repo-owned launchers — `deploy/systemd/hive-edge.service` (cx53,
  linux laptop), `deploy/launchd/run-edge.zsh` (macbook), and
  `deploy/machines/edge-runpod/{Dockerfile,start-edge.sh}` (RunPod) — rather than left at
  libuv's default of 4, which is exactly the dispatch cap and a default nobody chose. The RunPod
  entry is the one that matters most, not least: its seat HOME is on `/workspace`, a
  network-backed volume, so it is the deployment the whole three-guard stack was written for.
  Adding a launcher without this line reintroduces the exhaustion on that machine alone —
  `git grep UV_THREADPOOL_SIZE` should return one hit per launcher.

  The residual, stated rather than claimed away: **a mount that is slow but working records a
  false `attestation_unreadable`.** That is the deliberate trade — a delivery bounded at two
  seconds with an honest "the edge could not read this in time" beats an exact id that arrives
  after the edge has stopped claiming. It is the same absence a FIFO already yields, so bounding
  the read mints no new state.
- **A redelivery rebinds the current columns.** A seat reinstalled between attempts ran the
  second attempt under different artifacts; the live columns must name that new claim. The
  replaced attempt's binding and receipt are appended to `attestation_history` so an uncertain
  first try — which at-least-once delivery may already have produced effects under — stays
  traceable beside the later one.

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
