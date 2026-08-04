# Edge: linux laptop — seat fable (Claude Max, rationallyprime@gmail.com)

1. `bun install && bun run build` in the hive checkout; symlink `dist/cli.js` targets via the
   systemd unit (`deploy/systemd/hive-edge.service`, a user unit: `systemctl --user enable --now hive-edge`).
   The edge bootstraps its own state dirs on boot (creates the parents of `HIVE_EDGE_DB`,
   `HIVE_EDGE_SOCKET`, and the `HIVE_INGRESS_DIR` itself), so `~/.hive/` need not pre-exist.
2. Pinned profile (R-5): create `~/.hive/profiles/fable` and log in once —
   `CLAUDE_CONFIG_DIR=~/.hive/profiles/fable claude login` (interactive; Hákon's step).
3. Hook (R-4): in `~/.hive/profiles/fable/settings.json` register `hive-claude-hook` for Stop +
   PostToolUse (snippet: `deploy/hooks/claude-settings.json`), and export `HIVE_ACTOR=fable` in
   the sessions that seat runs.
4. Subscription: `deploy/subscriptions/fable.json` (accountProfile points at the profile dir).

Spawn-PATH fix: the edge runs from an absolute node path (systemd `ExecStart`), and it now prepends
its own runtime dir to every spawned child's `PATH` — so the `#!/usr/bin/env node` `hive` /
`hive-claude-hook` CLIs resolve node instead of exiting 127. For scripts run *outside* the edge (a
bare shell where node isn't on `PATH`), fall back to a symlink: `ln -s <node> ~/.local/bin/node`.

A closed lid is a dark agent: deliveries queue, retry with backoff, and terminalize visibly after
maxAttempts. That is the R-3 contract, not a bug. Bump `maxAttempts`/backoff in the subscription
if coffee-break naps burn deliveries too fast.
