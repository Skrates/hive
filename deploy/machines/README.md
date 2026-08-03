# Hive v0.5 machine map (ADR-0003 cutover staging)

Ratified topology, 2026-08-02/03. One broker, four edges, all links outbound-only.

| Machine | Role | Seats | Notes |
| -- | -- | -- | -- |
| dev box (`192.168.1.238`) | broker | — | joins the tailnet; edges dial in over it |
| linux laptop | edge `laptop` | `claude-1` (Claude Max, rationallyprime@gmail.com) | sleep = dark agent; failures stay thread-visible |
| macbook | edge `mac` | `codex-1` (ChatGPT Max) | app-server socket must be same-machine for mid-turn steering |
| cx53 (`agent-cx53`, hel1, 62.238.51.63) | edge `cx53` | `gnomon` (Claude Team, rationallyprime@gmail.com — name self-chosen) | dedicated agent VM + self-hosted CI runner — deliberately NOT the Coolify demo box (see its README) |
| runpod (EUR-IS-1) | edge `runpod` | `claude-3` (Claude Team, hakon@sokrates.is) | the hive's actuator: Sovereign dev, capability-registry model tests, LoRA runs; seat = custom-image CPU pod spawning sibling GPU pods; durable state on network volume `w65u1o4qbn` (100 GB) |

Seat-to-machine assignment is a subscription-time decision; the mapping above is the ratified
default and the example subscriptions in `../subscriptions/` encode it.

## Network prerequisite (the only plumbing)

The broker sits behind home NAT. Slack Socket Mode dials out, so the broker needs no public
ingress — but the cx53 VM and runpod need a path to the broker's HTTP listener. Install Tailscale
on the dev box, the cx53 VM, and the runpod pod; set each edge's `HIVE_BROKER_URL` to the tailnet
address. Plain off-box HTTP is forbidden (the edge token is bearer authority) — the tailnet
(WireGuard) or a mutually controlled HTTPS tunnel is the transport.

## Cutover afternoon (R-8)

1. Hákon: perform the three interactive Claude logins into their pinned `CLAUDE_CONFIG_DIR`s
   (see each machine README) and confirm the Codex auth home on the macbook.
2. Broker: deploy this revision on the dev box, set the admission policy to the closed trust set
   (both operator IDs `U0AQM4YL9HS` + `U0AND2JSHV1`, plus the Hive app ID), restart
   `hive-broker`.
3. Each machine: pull this revision, install the env file from its directory here, restart the
   edge (systemd unit, launchd plist, or runpod autostart).
4. `hive create-edge <edge-id>` per machine (rotates the bearer), `hive put-subscription` for each
   seat from `../subscriptions/`.
5. Verify: post a wake in #hive to each agent; the thread must show the delivery receipt and the
   agent's `hive reply` outcome. `hive status` must show no open failures.

Rollback: `git revert`, redeploy, restart four edges. No drain states, no dual-stack window.
