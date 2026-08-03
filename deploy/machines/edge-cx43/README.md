# Edge: cx43 (Coolify server) — seat claude-2 (Claude Team, rationallyprime@gmail.com)

This box serves the six-kernel investor demo. Under ADR-0003 R-2 the ONLY ceiling on what a wake
can cause is this agent's harness configuration — Hive gates nothing — so the edge runs deliberately
caged:

- Dedicated non-sudo user `hive` with no membership in the `docker` group (no docker-socket
  authority) and no write access to Coolify state or the demo stack volumes.
- `HIVE_HOME=/home/hive/.hive`; profile `/home/hive/.hive/profiles/claude-2`
  (interactive login: Hákon's step).
- Subscription `deploy/subscriptions/claude-2.json` pins `permissionProfile: workspace-write` —
  never `danger-full-access` on this machine — and a workspace cwd inside `/home/hive/work`.
- Tailscale joined; `HIVE_BROKER_URL` = broker tailnet address. Outbound only, no inbound port.
- systemd system unit (copy `deploy/systemd/hive-edge.service`, set `User=hive`,
  `EnvironmentFile=/home/hive/.config/hive/edge.env`, `HIVE_EDGE_ID=cx43`).

The kernels' own credentials and Coolify's API stay out of this user's reach; a compromised
trust-set principal steering this agent gets a caged shell, not the demo stack.
