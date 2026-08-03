# Edge: macbook — seat codex-1 (Codex, ChatGPT Max 20x)

1. Build the checkout; install the launchd plists from `deploy/launchd/` (edit paths inside):
   `launchctl bootstrap gui/$UID deploy/launchd/is.sokrates.hive-edge.plist`.
2. Env (`~/.config/hive/edge.env`): as the laptop example but `HIVE_EDGE_ID=mac` and this
   machine's token.
3. Pinned auth home (R-5): `CODEX_HOME=~/.hive/profiles/codex-1` — run `codex login` under it once
   (Hákon's step). The subscription's `accountProfile` is that path.
4. Mid-turn steering (R-4): run `hive-codex-live` with the active thread id
   (`HIVE_ACTOR=codex-1 HIVE_SESSION_ID=<thread> hive-codex-live`). It requires the Codex
   app-server control socket on this machine — codex-1 lives here because the socket cannot be
   remote. Without the live daemon, wakes fall back to `codex exec resume` headless.
5. Subscription: `deploy/subscriptions/codex-1.json`.
