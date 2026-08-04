# Edge: macbook — seat codex-1 (Codex, ChatGPT Max 20x)

1. Build the checkout; install the launchd plists from `deploy/launchd/` (edit paths inside):
   `launchctl bootstrap gui/$UID deploy/launchd/is.sokrates.hive-edge.plist`.
2. Env (`~/.config/hive/edge.env`): as the laptop example but `HIVE_EDGE_ID=mac`, this machine's
   token, and `HIVE_BROKER_URL` pointing at the BROKER'S TAILNET ADDRESS on the dev box —
   `run-edge.zsh` sources this file; nothing is hardcoded local.
3. Pinned auth home (R-5): `CODEX_HOME=/Users/hakon/.hive/profiles/codex-1` — run `codex login`
   under it once (Hákon's step). The subscription's `accountProfile` is that path. Keep this as a
   dedicated Codex home: its `config.toml` must not contain the legacy `sandbox_mode` or
   `sandbox_workspace_write` settings, because Hive selects a least-privilege permission profile
   that adds only the owner-only edge socket needed by `hive reply`.
4. Mid-turn steering (R-4): the live daemon must run under the SAME pinned home as the login —
   `CODEX_HOME` in the env, not just on the login invocation, or the app-server client silently
   binds `~/.codex` and wakes deliver through the wrong account:
   `CODEX_HOME=/Users/hakon/.hive/profiles/codex-1 HIVE_ACTOR=codex-1 HIVE_SESSION_ID=<thread> hive-codex-live`.
   It requires the Codex app-server control socket on this machine — codex-1 lives here because
   the socket cannot be remote. Without the live daemon, wakes fall back to `codex exec resume`
   headless.
5. Subscription: `deploy/subscriptions/codex-1.json`.
