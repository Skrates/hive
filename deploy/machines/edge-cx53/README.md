# Edge: cx53 (dedicated Hetzner VM) — seat claude-2 (Claude Team, rationallyprime@gmail.com)

Provision a **cx53** (16 shared vCPU / 32 GB / 320 GB, fsn1, ~€29/mo) — a *dedicated* agent VM,
deliberately **not** the Coolify box: the demo kernels and bd stack must never contend with agent
builds, and a runaway disk-fill must not be able to touch them. If CPU steal ever measurably drags
CI, rescale to ccx33 — without growing the disk, so the move stays reversible.

Create it: `hcloud server create --type cx53 --image ubuntu-24.04 --location fsn1 --name agent-cx53`.

Under ADR-0003 R-2 the ONLY ceiling on what a wake can cause is this agent's harness
configuration — Hive gates nothing — so the edge still runs caged:

- Dedicated non-sudo user `hive`; no docker-group membership unless a workload demands it.
- `HIVE_HOME=/home/hive/.hive`; profile `/home/hive/.hive/profiles/claude-2`
  (interactive login: Hákon's step).
- Subscription `deploy/subscriptions/claude-2.json` pins `permissionProfile: workspace-write`
  and a workspace cwd inside `/home/hive/work`.
- Tailscale joined; `HIVE_BROKER_URL` = broker tailnet address. Outbound only, no inbound port.
- systemd system unit (copy `deploy/systemd/hive-edge.service`, set `User=hive`,
  `EnvironmentFile=/home/hive/.config/hive/edge.env`, `HIVE_EDGE_ID=cx53`).

## Second role: self-hosted CI runner

This VM also hosts the GitHub Actions runner for the private repos (sokrates, hive) — saves
Actions minutes and keeps persistent uv/pnpm/docker-layer caches warm, which is what actually gets
PR feedback under five minutes. Run the runner as its **own** non-sudo user (`ci-runner`), never
as `hive`: CI executes repo-authored code and must not share the agent's home, profile, or hive
socket. Keep `runs-on: ubuntu-latest` as the documented fallback for when the box is down;
self-hosted runners stay private-repo-only (fork PRs on a public repo would run arbitrary code on
this box).
