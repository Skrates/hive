# ADR-0004: Hive Attention — a durable queue of human interventions

* Status: Accepted for implementation (specification revision 1.0, 2026-10-12); first release
  ships disabled (`HIVE_ATTENTION_ENABLED=false`) pending the live pilot
* Builds on: ADR-0003 (sender-attributed trust, at-least-once delivery with visible loss,
  pinned account profiles, harness-owned authority, `resume` never escalates to `spawn`)
* Does not resurrect: ADR-0001/0002 ambiguity adjudication, launch grants, exactly-once claims

## Context

Seats finish work, hit genuine blockers, and need decisions. Today they reach Hákon by
posting into Slack, which interrupts whatever he is doing and turns every completion into a
context switch. The human is the scarce resource; the seats are not.

## Decision

Hive gains a durable queue of **human interventions** on the existing broker, SQLite
database, edge UDS transport and delivery/outbox machinery. Seats ring a software bell; the
human explicitly takes the next intervention at a natural handoff; a persisted response
becomes a durable continuation to the originating work context.

**The loop:** human work → autonomous handoff → explicit `next` → focused intervention →
response → autonomous work. Agent completions feed the queue independently; a completion
never advances the human to another project.

### Rulings

**A-1 — Unit and concurrency.** The unit of scheduling is one concrete intervention
(`review`, `decision`, `selection`, `unblock`, `human_work`), not a project. At most one item
per human is `active`, enforced by a partial unique index, not only application logic.

**A-2 — No push.** A summons writes attention state only: no Slack mention, DM, toast,
sound or focus change. Inspection is pull-based. Human-attention requests are not actor
deliveries and inherit neither their TTL nor their retries.

**A-3 — Explicit switching, FIFO-1.** Only `next`, `resolve --next`, `defer --next` and
`cancel --next` change which item holds the active slot, and only under the operator
credential. `selectNext` orders eligible items by `(ready_sequence, item_id)`; the ready
sequence is the id of the event that last made the item ready, so a deferral rejoins at the
tail and an amendment never moves an item. An explicit pick is a visible override, not a
priority. A repeated `next` returns the active item.

**A-4 — The human is not an actor.** `human` is not a provider, holds no actor lease, and is
never in `WAKE: everyone` expansion. The human id (`hakon`) is a queue identity.

**A-5 — Stable identity and honest revisions.** An item's semantic key is
`(human_id, owner_principal, project_id, work_id, intervention_key)`. A command id replays
its committed receipt (resolved before any liveness, revision or route check); the same id
with different content is `command_id_conflict`. Item mutations carry the expected revision;
a stale decision is a 409, never applied to a newer packet.

**A-6 — Source binding.** A seat produces requests through an immutable `AttentionSource`
enrolled from evidence its own edge observed — a running dispatch token (fenced with
`assertLease`), an exact unexpired live registration, or an explicit operator enrollment on
the source edge. The caller never names an actor, principal or delivery to establish
attribution. The edge issues a random local handle, stores only its hash bound to the issuing
broker's UUID, and forwards the source id under its machine credential. The edge retains the
evidence it sent under the bind's command id, so a committed bind is recovered after its
dispatch ended — by a retry presenting the original requester's proof (its dispatch token, its
still-registered session) or by the operator, never by the command id alone; the broker answers
such a recovery only by replay and never enrolls from it.
Live-registry verification counts only through the provider the actor is enrolled on. A source
authorizes producing requests only: never selecting, resolving, waking or the operator
credential.

**A-7 — Return modes.** `pinned_session` (exactly the captured session, live through a
receiver that re-checks the session, or resumed on its home edge where policy permits),
`actor_context` (ordinary routing and slot allocation plus the saved packet; explicitly not
the same session), or `none`. A pinned route that becomes unavailable is never downgraded
silently; the operator reroutes it.

**A-8 — Continuations ride ordinary Hive.** A resolution and its return intent commit
atomically. An independent housekeeping job mints the continuation as a system wake with
origin `attention` (`attention:` event ids, `hive-attention` sender), its own coalescing
group `attention-return:<resolution>:<generation>`, a broker-derived continuation target and
`required_edge_protocol = 1` on the core delivery. Once minted, core Hive owns retries, TTL
and attempt limits; attention never mints behind a live delivery. Review wakes keep their
exact identity.

**A-9 — Constraints at both ends.** One pure rule, `effectiveDeliveryRoute(subscription,
target)`, decides claim eligibility at the broker and live-versus-resume at the edge. Edges
declare `attention_protocol=1` per claim request; an edge that does not is never handed an
attention continuation. Receivers re-check the exact session and its captured cwd immediately
before accepting; an unreported cwd is missing evidence, never agreement. The Claude hook drains
a constrained inbox file only in the named session and cwd, and only after the edge's return
guard confirms the current generation; the Codex bridge refuses a mismatched task or cwd with
`attention_session_mismatch`.

**A-10 — Failure is visible.** Return phases are `pending`, `blocked`, `minted`,
`processed`, `failed`, `superseded`. `processed` means the ordinary Hive continuation
reported an outcome — never a verified business result. A transport row deleted without a
snapshot is `transport_record_missing`, never inferred processed. Retry and reroute are
explicit operator acts fenced on item revision and return generation; a reroute stays within
the item's project and work.

## Consequences

* New broker tables are attention-prefixed with their own module schema version; the broker
  generation stays 5. Core `deliveries` gains two nullable/zero-default routing columns.
* History (items, events, commands, sources, returns) is never deleted, and holds no foreign
  key to core rows that actor retirement deletes.
* Exactly-once provider execution is not claimed; a redelivered continuation carries the same
  resolution coordinate and generation.
* This is the single-Unix-user private-workspace boundary. A process that reads another
  process's files can read a source handle; nothing here claims otherwise.

## Deliberately not in V1

Priority scheduling, aging, quotas, context-switch scoring, calendar projection, focus
inference, notification escalation, GUI, natural-language decision execution, autonomous
approvals and multi-user tenancy.

## Amendment 1 — the Slack front end (2026-10-15)

* Status: Accepted. The CLI pilot of 2026-10-15 proved the queue and the return path on the live
  fleet; this amendment gives the human a friendlier surface over the same broker commands.
* Amends: A-2 (no push). Every other ruling stands unchanged.

### Context

Hive is Slack-centric, and the broker already owns the Slack app, its credentials and its Socket
Mode link. Pull-only inspection proved too quiet in practice: Hákon wants to know that something
is waiting, as long as he is told no more intrusively than a Slack message tells him.

### Rulings

**S-1 — One notification per summons (amends A-2).** When an item is created, the broker posts one
card to the human as a direct message from the Hive app. That message is the notification: Slack's
own pop-up, with no mention, no channel post, no second message and nothing that steals focus.
Every later change to the item (amend, withdraw, resolve, return processed) updates the same
message in place and never notifies again. A summons still never selects work: only `next` and its
variants switch the active item (A-3).

**S-2 — Surfaces.** The DM card holds the brief, rendered from the packet. The app's Home tab holds
the queue: the active item, the eligible items in FIFO order, deferred items with their due times,
and returns that are blocked or failed. A modal makes decisions: resolve (outcome and verbatim
response), defer (until a time, or indefinitely) or cancel (with a reason), with "take next" as an
option. The CLI stays an equal path to every one of these acts.

**S-3 — FIFO stays the default.** The card's primary button is **Take next**: it claims whatever
`next` selects (FIFO-1) and opens its decision modal. **Answer this one** is an explicit pick
(`selection_reason = explicit_pick`, already a recorded event): a visible override meant to be used
rarely, never a priority. If another item is already active, either button opens that one first
(A-3: a second `next` returns the active item).

**S-4 — Slack identity is the operator only for queue acts.** An interaction counts only when Slack
reports it from the configured human's Slack user ID (`HIVE_ATTENTION_SLACK_USER_ID`). It then acts
as the operator principal for exactly these acts: `next`, `resolve`, `defer` and `cancel`. Everything
else the operator can do (add, start, requeue, retry or reroute a return, revoke a source) stays on
the CLI under the operator credential. Any other Slack user is refused, and no command is attempted.

**S-5 — Retries replay, and stale decisions are refused.** Opening a decision modal mints one
command ID and records the item revision it was rendered at, both carried in the modal's private
metadata. A resubmission replays that command (A-5), and a revision conflict reopens the modal with
the current packet instead of applying the decision to an outdated one. Button presses derive their
command ID from Slack's interaction identity, so a Socket Mode redelivery replays as well.

**S-6 — Rendering is inert.** Every string a seat wrote is rendered as Slack `plain_text`, never
`mrkdwn`, so a packet cannot forge a mention, a link or formatting. Over-long fields are shortened
for display with an explicit marker. The stored packet is never altered.

**S-7 — Cards are a projection, never the record.** The broker keeps one row per card (its DM
channel, message timestamp, and the item revision, state and return phase it last rendered). An
independent housekeeping job brings each card up to date. Slack being slow or down never blocks or
fails a command, and an out-of-date card is repaired on a later pass. A broker crash between posting
a card and recording it can leave one duplicate card: visible and harmless, and never double-applied,
because acting from either card goes through the same fenced commands.

**S-8 — Off unless configured.** The Slack front end runs only when attention is enabled and
`HIVE_ATTENTION_SLACK_USER_ID` is set. It also needs these Slack app settings: Interactivity enabled
(Socket Mode carries it, with no request URL), the Home tab enabled, the `app_home_opened` event
subscribed, and the bot scopes `chat:write` and `im:write`. A missing setting degrades to the CLI
with a logged diagnostic, never to a broken queue.

### Consequences

* The attention store moves to schema version 2. That adds one table, `attention_slack_cards`; the
  broker generation stays 5.
* Desktop agent threads on Hákon's Mac are still not reachable by a return: Slack carries the human
  side only. Their delivery path is the spool design, a later amendment.
