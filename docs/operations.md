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

The deafness watchdog posts link canaries into an admitted channel and waits for each to come back
over the Socket Mode link, so its channel must be one whose messages the app actually *receives* —
posting into it is not enough. For the admitted private channel that already holds
(`groups:history` plus the `message.groups` subscription is what carries every wake). If
`HIVE_WATCHDOG_PROBE_CHANNEL` points the canaries at a channel of a different type, grant the
matching pair — a public channel needs `channels:history` and `message.channels` — or every canary
will post successfully and never return, which the watchdog reads as deafness and answers with a
reconnect and then an exit. A canary proves the link only when it comes back as the original
message from the broker's own bot user (`auth.test` on the bot token, resolved at startup) in the
probe channel; a stamped message from any other sender, and the edit or delete echo of a canary,
are kept off the activity clock but never settle a probe.

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
  safe to run long after the wake;
- `hive wake <actor> "<text>"` mints a wake for a peer seat (see below).

### Seat-to-seat wakes

A seat's outcome cannot address another seat. Every Hive post carries `hive_*` message metadata and
admission drops those before the envelope is parsed, so a quoted `WAKE:` line in an outcome or a
digest can never mint a delivery. That drop is deliberate and total, and it stays that way.

Deliberate address is therefore an explicit act, never inferred from where text sits:

```sh
hive wake theoros "verify the KRA-1056 gate set on PR #1072"
hive wake theoros --thread 1786809717.355459 "…"
```

- **A seat cannot name the delivery it mints from.** The edge issues each provider turn a
  capability (`HIVE_DELIVERY_TOKEN`, exported into the child and revoked when the turn settles);
  `hive wake` presents it, and the *edge* resolves which delivery — and which lease generation —
  that turn is. The broker then reads the sender from that ledger row, so attribution is never a
  client claim. One edge serves several actors over one owner-only socket, so a delivery id in the
  request would let any co-tenant seat mint under a peer's name; the machine credential proves the
  machine, and the machine is not the seat. The honest ceiling: seats on a box share a Unix user,
  so this binds a mint to the run that requested it, not against a seat that deliberately reads a
  peer process's state.
- **Only a turn this edge dispatched can mint.** A live-delivered turn holds no per-dispatch
  capability and is refused (KRA-1118); so is a child that outlived its dispatch.
- **The wake lands in the minting seat's thread** unless `--thread` names another thread in the same
  channel. The receiver's outcome relays there, which is what makes a handoff answerable where it
  was asked.
- **The ledger commits before the commons render.** The delivery and its `🐝 wake minted by …` post
  are one transaction; the post goes out through the ordinary `hive_*`-stamped outbox, so humans see
  the handoff and admission ignores it.
- **A mint that cannot be delivered exits non-zero with the reason** (`unroutable_actor`,
  `unknown_source_delivery`, `source_not_held`, `unknown_dispatch_token`, `self_mint_forbidden`,
  `broadcast_forbidden`) — never rendered-and-gone.
- **A seat cannot broadcast or wake itself.** `everyone` stays a human-sender act, and a
  self-directed mint is an unbounded loop with no operator in it.
- **Replaying the identical mint is a no-op** that names the original delivery, so a lost CLI
  response cannot double-wake a peer.

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
to the checked-in Codex actor `ariadne`, reads `CODEX_THREAD_ID` only from the invoking task, resolves that task's physical cwd,
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

### Turn slots (KRA-1364)

A subscription's `turnSlots` (integer ≥ 1, default 1) is how many turns the actor may run at once,
fleet-wide. Leases are keyed `(actor, slot)`; a claim takes the actor's lowest free slot, and every
transition is fenced on the generation that slot holds, so one slot's lease expiring requeues only
the turn it held. Generations are minted per actor, never per slot, so no two slots ever share one:
a turn whose slot lapsed and whose delivery was reclaimed into another slot cannot report in against
the new slot's fence. A multi-slot actor never takes the live route — a live session is one process,
and two slots delivered into it would share a checkout — so its live registration, if any, is never
consulted. The edge declares the `actor:slot` pairs it is running on every claim, and the broker
skips an actor whose slots are all declared; a `busy` entry without a slot is refused with
`busy_malformed`. `turnSlots > 1` requires `wakePolicy: "spawn"`, no pinned `sessionId`, and a
`{slot}` placeholder in every `edgeWorkspaces[].cwd` — slot `n` runs in that path with `{slot}`
replaced by `n`, so two concurrent turns never share a checkout. Those directories must exist on
the edge before the first wake lands. A seat that declares nothing runs exactly the one-slot path it
always did. Lowering `turnSlots` is refused (`turn_slots_leased`, 409) while a turn is still running
in any slot above the new ceiling, on any edge: capacity is counted from the claiming edge's own busy
declaration, so a running high slot elsewhere would otherwise be invisible to the lowered ceiling.
Let those turns finish, then retry the upsert.

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
  dispatch cap in every repo-owned launcher, rather than left at libuv's default of 4, which is
  exactly the dispatch cap and a default nobody chose. At the time of writing that is
  `deploy/systemd/hive-edge.service` (cx53, linux laptop), `deploy/launchd/run-edge.zsh`
  (macbook), and `deploy/machines/edge-runpod/{Dockerfile,start-edge.sh}` (RunPod) — read as
  orientation, not as the authority; the authority is `src/edge/launchers.test.ts`, and the list
  here may lag it. The RunPod launcher is the one the three-guard stack was written for — its
  seat HOME sat on `/workspace`, a network-backed volume — and it stays in the set as the pod
  recipe although no seat has ridden it since 2026-08-16 (Talos lives on cx43, whose launcher is
  the shared systemd unit).

  **Adding a launcher without this line reintroduces the exhaustion on that machine alone, so the
  enumeration is derived, not written down.** `src/edge/launchers.test.ts` walks `deploy/`, finds
  every file whose executable lines launch the edge, and fails if one of them does not set
  `UV_THREADPOOL_SIZE` above `MAX_CONCURRENT_DISPATCHES`. A fourth launcher joins that set by
  existing — no doc edit, no allowlist entry. Do **not** verify this with `git grep
  UV_THREADPOOL_SIZE`: that grep enumerates the launchers which already *have* the line, so the
  one launcher missing it contributes no hit and the output looks exactly as correct as a clean
  run. `bun run check` is the check; the gate reads the constant from `src/edge/service.ts`
  rather than restating `4`, so raising the dispatch cap raises the required pool size with it.

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

## Hive Attention (ADR-0004)

A durable queue of human interventions on the broker's own database. Seats ring a bell; the
human takes the next item at a natural handoff; the response returns to the originating work
context as an ordinary Hive delivery. Nothing about it pushes: a summons writes attention state
only — no Slack mention, DM, toast or focus change.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HIVE_ATTENTION_ENABLED` | `false` | Accept mutations and publish returns. `true`/`false` (or `1`/`0`); anything else refuses to boot. |
| `HIVE_ATTENTION_HUMAN_ID` | `hakon` | The queue identity. Not a person-profile lookup, never a provider actor. |

The human uses the existing operator credential (`HIVE_BROKER_URL` + `HIVE_ADMIN_TOKEN`) directly
against the broker. The CLI refuses it inside an agent's execution environment
(`HIVE_DELIVERY_TOKEN`/`HIVE_SESSION_TOKEN` present). Seats never see it.

Disabled means: no new mutations, no new return publication; reads stay available, and a delivery
already minted keeps its ordinary lifecycle — disabling never cancels a running provider turn.
`hive attention capabilities` states which.

### The loop

```sh
hive attention start --file ./current-design-work.json        # already-begun human work
hive attention queue                                           # pull, never pushed
hive attention next                                            # a repeated next returns the active item
hive attention show 42 --json
hive attention resolve 42 --expected-revision 3 --outcome selected \
  --response "Use candidate C; retain the current lighting." --next
hive attention defer 51 --expected-revision 1 --until 2026-10-13T09:00:00Z --reason "Needs tomorrow's input" --next
hive attention defer 52 --expected-revision 1 --indefinite --reason "parked"
hive attention requeue 52 --expected-revision 2 --reason "Input arrived"
hive attention cancel 53 --expected-revision 1 --reason "obsolete" --next
hive attention add --file ./rannis-intervention.json          # human-first work, queued
```

`--next` means "my part here is finished; show me the next one" — it does not claim the receiving
seat has started. The receipt distinguishes response saved, return pending/minted, and later
reads show `processed` once core Hive recorded the continuation's outcome. Every mutation is
journalled 0600 under `~/.hive/attention/requests/<command_id>.json` before it is sent; on a
timeout the CLI prints the id: reconcile with `hive attention receipt <id>`, or resend the exact
bytes with `hive attention retry-command <id>` (a replay, never a duplicate).

Exit codes: 0 success/replay/`already_active`/`empty`; 2 malformed/oversized/schema; 3 auth or
source authority; 4 not found or attention unavailable on an older broker; 5 revision/state/key/
generation conflict; 6 temporary — retry the same command id; 7 unexpected server failure.

### Seats: binding and summoning

A seat binds a source once per work context, then summons with saved envelopes:

```sh
# Headless turn (while HIVE_DELIVERY_TOKEN is valid):
hive attention bind --project birthday-film --work parents-likeness-round-2 \
  --return actor-context --out ./attention-source.json
# Live session (exact actor + session the surface announced; Claude's hook writes
# ~/.hive/attention/sessions/<actor>/<session>.json and tells the session once):
hive attention bind --session-file ~/.hive/attention/sessions/fable/<session>.json \
  --project hive --work KRA-1500 --return pinned-session --channel C0BGBEQQQHH --thread <ts> --out ./src.json
# Operator enrollment, run on the source edge (verified session or context-restored only):
hive attention bind --operator --actor talos --project p --work w --return actor-context \
  --cwd /workspace/talos/1 --channel C0BGBEQQQHH --thread <ts> --out ./src.json
hive attention summon --source-file ./attention-source.json --file ./summon.json
```

The source file (0600, never overwritten) holds a random handle the edge stored only as a hash,
bound to the issuing broker. Sources stay valid after the turn ends — no actor lease is held for
the human — until `hive attention source revoke <id> --reason …`. Revocation stops new writes;
queued work, provenance, receipt recovery and an already-recorded response's return survive it.

Return modes: `pinned-session` needs a verified session id, an observed cwd, the actor's home edge
and a single-slot actor; `actor-context` restores context through ordinary routing (including slot
allocation) and says so in the envelope; `none` records the response with no wake. A returning
source needs a real Slack thread (the dispatch's own, or `--channel/--thread`, which the broker
reads once to prove it exists).

### Returns

The broker's five-second housekeeping tick runs the return drain as its own job beside review
publication and the outbox: due returns are minted in one transaction with their `minted` phase
(max 25 per pass), then minted returns whose delivery ended are settled. An actor without a live
subscription is `blocked` and rechecked every 60 s; route drift (provider, home edge, account
profile or slot configuration changed since capture) is `failed` and waits for the operator:

```sh
hive attention show 42                                         # phase, transport status, reason
hive attention retry-return 42 --expected-revision 4 --return-generation 1
hive attention reroute-return 42 --expected-revision 4 --return-generation 1 \
  --source src_… --reason "seat moved to cx53"
```

Retry is idempotent while a delivery is in flight and refuses a processed return; a failed
generation is superseded by a new one with a new dedupe key. Reroute is allowed only before
minting or after the previous delivery ended — it cannot retract a running turn.

### Doctor, status and logs

`hive attention doctor --json [--source-file …]` reports broker reachability/UUID, enabled state,
schema and store versions, CLI compatibility, edge reachability and source validity; it never
prints secrets. `hive attention queue` shows the active item, eligible/deferred counts, oldest
eligible age, next due deferral, and pending/blocked/failed returns with route warnings. Logs name
command/item/source ids, generations and delivery ids — never response bodies, handles or artifact
contents.

### Rollout and rollback

1. Back up the broker database with SQLite's online backup (or with the broker stopped) and verify
   the copy opens; never copy the main file without its WAL.
2. Deploy the broker with attention disabled. Migrations only add `attention_*` tables, a module
   version, and two routing columns on `deliveries`; the broker generation stays 5. A newer
   attention store refuses to boot with a diagnostic.
3. Deploy the upgraded edges and provider surfaces (the Claude hook and Codex bridge announce
   `attentionProtocol: 1`; an edge declares protocol 1 on each claim), then the CLI and the
   `hive-attention` launcher.
4. Inspect `hive attention doctor` and source bindings on the pilot seats; then set
   `HIVE_ATTENTION_ENABLED=true` and restart the broker.

Rolling back: disable first (no new mutations or publication), let every minted attention delivery
reach a recorded terminal phase (`hive attention queue` shows none minted), then downgrade. An old
edge never claims a protocol-1 delivery, so a partially downgraded fleet leaves continuations
pending rather than ignoring their constraints. Attention tables are kept for re-upgrade and audit.
