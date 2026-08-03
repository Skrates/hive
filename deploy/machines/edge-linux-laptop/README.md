# Edge: linux laptop — seat claude-1 (Claude Max, rationallyprime@gmail.com)

1. `pnpm install && pnpm build` in the hive checkout; symlink `dist/cli.js` targets via the
   systemd unit (`deploy/systemd/hive-edge.service`, a user unit: `systemctl --user enable --now hive-edge`).
2. Pinned profile (R-5): create `~/.hive/profiles/claude-1` and log in once —
   `CLAUDE_CONFIG_DIR=~/.hive/profiles/claude-1 claude login` (interactive; Hákon's step).
3. Hook (R-4): in `~/.hive/profiles/claude-1/settings.json` register `hive-claude-hook` for Stop +
   PostToolUse (snippet: `deploy/hooks/claude-settings.json`), and export `HIVE_ACTOR=claude-1` in
   the sessions that seat runs.
4. Subscription: `deploy/subscriptions/claude-1.json` (accountProfile points at the profile dir).

A closed lid is a dark agent: deliveries queue, retry with backoff, and terminalize visibly after
maxAttempts. That is the R-3 contract, not a bug. Bump `maxAttempts`/backoff in the subscription
if coffee-break naps burn deliveries too fast.
