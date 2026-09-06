# Hive v0.5 machine map (ADR-0003 cutover staging)

Ratified topology, 2026-08-02/03, amended 2026-09-06 (Ariadne moved from the macbook to the
shared cx53 edge). One broker, three seat-serving edges, all links outbound-only.

| Machine | Role | Seats | Notes |
| -- | -- | -- | -- |
| dev box (`192.168.1.238`) | broker | — | joins the tailnet; edges dial in over it |
| linux laptop | edge `laptop` | `fable` (Claude Max, rationallyprime@gmail.com) | sleep = dark agent; failures stay thread-visible |
| macbook | no edge since 2026-09-06 | — | `ariadne`'s home edge moved to cx53; the Mac body is interactive-only Codex Desktop, which Hive never dispatches. `edge-macbook/` stays as the launchd + account-pin recipe — no subscription names that edge. Mid-turn steering (`hive-codex-live`) is the one capability that cannot follow her: both sockets must be same-machine |
| cx53 (`agent-cx53`, hel1, 62.238.51.63) | edge `cx53` | `gnomon` + `theoros` (Claude Team, rationallyprime@gmail.com — names self-chosen), `ariadne` (Codex, ChatGPT Max; headless `codex exec` since 2026-09-06) | dedicated agent VM + self-hosted CI runner — deliberately NOT the Coolify demo box (see its README). One edge, three actors: separate workspaces and pinned profiles, never a shared checkout |
| cx43 (`coolify-fsn1`, fsn1, 167.233.120.83) | edge `cx43` | `talos` (Grok Build, SuperGrok subscription; `hive` user beside the Coolify demo stack) | moved off the RunPod pod 2026-08-16, subscription cutover 2026-09-05 (KRA-1322); two turn slots at `/home/hive/work/slot-{1,2}` (KRA-1364); no burns during a live demo. `edge-runpod/` stays as the pod recipe — no subscription names that edge |

Seat-to-machine assignment is a subscription-time decision; the mapping above is the ratified
default and the example subscriptions in `../subscriptions/` encode it.

## Network prerequisite (the only plumbing)

The broker sits behind home NAT. Slack Socket Mode dials out, so the broker needs no public
ingress — but the Hetzner boxes (cx53, cx43) need a path to the broker's HTTP listener. Install
Tailscale on the dev box and on every edge host; set each edge's `HIVE_BROKER_URL` to the tailnet
address. Plain off-box HTTP is forbidden (the edge token is bearer authority) — the tailnet
(WireGuard) or a mutually controlled HTTPS tunnel is the transport.

## Cutover afternoon (R-8)

1. Hákon: perform the three interactive Claude logins into their pinned `CLAUDE_CONFIG_DIR`s
   (see each machine README) and confirm the Codex auth home on Ariadne's edge host.
2. Broker: deploy this revision on the dev box, set the admission policy to the closed trust set
   (both operator IDs `U0AQM4YL9HS` + `U0AND2JSHV1`, plus the Hive app ID), restart
   `hive-broker`.
3. Each machine: pull this revision, install the env file from its directory here, restart the
   edge (systemd unit or launchd plist).
4. `hive create-edge <edge-id>` per machine (rotates the bearer), `hive put-subscription` for each
   seat from `../subscriptions/`.
5. Verify: post a wake in #hive to each agent; the thread must show the delivery receipt and the
   agent's `hive reply` outcome. `hive status` must show no open failures.

Rollback: `git revert`, redeploy, restart every edge in the table above. No drain states, no
dual-stack window.
