# Edge: cx53 (dedicated Hetzner VM) — seats gnomon, theoros (Claude Team, rationallyprime@gmail.com) and ariadne (Codex, ChatGPT Max)

**Provisioned 2026-08-03:** `agent-cx53` (16 shared vCPU / 32 GB / 320 GB, ~€29/mo) at
**hel1 / 62.238.51.63** (fsn1 and nbg1 had no cx53 stock), firewall `agent-cx53-fw` (inbound
ssh only), users `hive` + `ci-runner` created, tailscale + docker installed (`tailscale up` =
Hákon's step). A *dedicated* agent VM, deliberately **not** the Coolify box: the demo kernels and
bd stack must never contend with agent builds, and a runaway disk-fill must not be able to touch
them. If CPU steal ever measurably drags CI, rescale to ccx33 — without growing the disk, so the
move stays reversible.

Under ADR-0003 R-2 the ONLY ceiling on what a wake can cause is this agent's harness
configuration — Hive gates nothing — so the edge still runs caged:

- Dedicated non-sudo user `hive`; no docker-group membership unless a workload demands it.
- **One edge, three actors** (`gnomon`, `theoros`, `ariadne` since 2026-09-06). They share the
  user and the edge process and nothing else: one workspace each (`/home/hive/work`,
  `/home/hive/work-theoros`, `/home/hive/work-ariadne`) so a checkout is never shared, and one
  pinned profile each under `/home/hive/.hive/profiles/`. Adding a seat here is a subscription
  plus a workspace plus a profile — never an edge change.
- `HIVE_HOME=/home/hive/.hive`; profile `/home/hive/.hive/profiles/gnomon`
  (interactive login: Hákon's step —
  `CLAUDE_CONFIG_DIR=/home/hive/.hive/profiles/gnomon claude login`), and likewise
  `.../profiles/theoros`. `ariadne` is Codex, so her pin is `CODEX_HOME`, not
  `CLAUDE_CONFIG_DIR`: `/home/hive/.hive/profiles/ariadne`, logged in by device auth under that
  home (never a bare `codex login`).
- **An unpinned `claude` on this box is a seat violation.** A bare invocation
  mints a shadow profile at `~/.claude` — same account, no `HIVE_ACTOR`, no
  hooks, invisible to the live registry (R-5 constrains only the dispatch
  path). `/home/hive/.profile` exports `CLAUDE_CONFIG_DIR` so login shells
  (`su - hive`, ssh) land in the pinned seat; do not bypass it with `env -i`
  or non-login shells.
- Subscriptions `deploy/subscriptions/{gnomon,theoros,ariadne}.json` each pin
  `permissionProfile: workspace-write` and a workspace cwd under `/home/hive/`.
- Tailscale joined; `HIVE_BROKER_URL` = broker tailnet address. Outbound only, no inbound port.
- systemd system unit (copy `deploy/systemd/hive-edge.service`, set `User=hive`,
  `EnvironmentFile=/home/hive/.config/hive/edge.env`, `HIVE_EDGE_ID=cx53`).
- **`edge.env` must prepend `/home/hive/.local/bin` to `PATH`.** The unit's own default is the
  minimal system PATH (see the comment above `Environment=PATH=` in the unit), and every agent
  CLI a wake spawns lives in that directory — `node` for the edge itself, `claude` for the two
  Claude seats, and `codex` for `ariadne`, which `CodexProvider.spawn` invokes as a bare
  `codex`. The later `EnvironmentFile` assignment overrides the unit line; without it a wake dies
  `ENOENT` in a retry loop. Verify against the running service, not the login shell:
  `tr '\0' '\n' < /proc/$(systemctl show hive-edge -p MainPID --value)/environ | grep ^PATH=`.

## Second role: self-hosted CI runner

This VM also hosts the GitHub Actions runner for the private repos (sokrates, hive) — saves
Actions minutes and keeps persistent uv/bun/docker-layer caches warm, which is what actually gets
PR feedback under five minutes. Run the runner as its **own** non-sudo user (`ci-runner`), never
as `hive`: CI executes repo-authored code and must not share the agent's home, profile, or hive
socket. Keep `runs-on: ubuntu-latest` as the documented fallback for when the box is down;
self-hosted runners stay private-repo-only (fork PRs on a public repo would run arbitrary code on
this box).
