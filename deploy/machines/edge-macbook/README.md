# Edge: macbook — seat codex-1 (Codex, ChatGPT Max 20x)

1. Build the checkout; install the launchd plists from `deploy/launchd/` (edit paths inside):
   `launchctl bootstrap gui/$UID deploy/launchd/is.sokrates.hive-edge.plist`.
2. Env (`~/.config/hive/edge.env`): as the laptop example but `HIVE_EDGE_ID=mac`, this machine's
   token, and `HIVE_BROKER_URL` pointing at the BROKER'S TAILNET ADDRESS on the dev box —
   `run-edge.zsh` sources this file; nothing is hardcoded local.
3. Account pin (R-5): authenticate Codex Desktop normally in `/Users/hakon/.codex`, then create the
   pinned profile at `/Users/hakon/.hive/profiles/codex-1` with mode `0700`. Its `auth.json` must be
   an owner-only symlink to `/Users/hakon/.codex/auth.json` (after backing up any existing profile
   artifact); do **not** run a second independent `codex login` under the profile. The subscription's
   `accountProfile` is the profile path, and live delivery compares the two resolved `auth.json`
   paths before injection. A different, missing, or insecure artifact is a hard pre-dispatch
   `account_profile_mismatch`, never a fallback. Keep the profile's `config.toml` free of the legacy
   `sandbox_mode` and `sandbox_workspace_write` settings because Hive supplies the selected
   least-privilege permission profile.
4. Mid-turn steering (R-4): run the live daemon with both homes explicit. `CODEX_HOME` selects the
   pinned dedicated/headless seat, while `HIVE_CODEX_DESKTOP_HOME` selects the running Desktop app's
   state database and owner-only IPC socket:
   `CODEX_HOME=/Users/hakon/.hive/profiles/codex-1 HIVE_CODEX_DESKTOP_HOME=/Users/hakon/.codex HIVE_ACTOR=codex-1 HIVE_SESSION_ID=<thread> hive-codex-live`.
   The Desktop IPC and app-server control sockets must be on this machine — `codex-1` lives here
   because neither socket can be remote. Without the live daemon, wakes use the subscription's
   normal headless policy under the same pinned `CODEX_HOME`.
5. Subscription: `deploy/subscriptions/codex-1.json`.
