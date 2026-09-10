# Edge: macbook — recipe only, no seat (Codex, ChatGPT Max 20x)

**Retired for dispatch, 2026-09-06.** `ariadne`'s home edge is `cx53`
(`deploy/subscriptions/ariadne.json`, `deploy/machines/edge-cx53/README.md`); no subscription
names edge `mac`, so this edge is not deployed and nothing here needs to run for the seat to be
woken. The Mac body is interactive-only Codex Desktop, which Hive never dispatches. What follows
is the recipe kept for two reasons: reprovisioning a Mac edge, and the one capability that could
not follow her to Linux — mid-turn steering, whose Desktop IPC and app-server control sockets must
both be on the same machine as the seat, so a cx53 seat has headless wakes only. Reviving this
edge means adding a `mac` row back to the machine map and pointing a subscription at it.

1. Build the checkout; install the launchd plists from `deploy/launchd/` (edit paths inside):
   `launchctl bootstrap gui/$UID deploy/launchd/is.sokrates.hive-edge.plist`.
2. Env (`~/.config/hive/edge.env`): as the laptop example but `HIVE_EDGE_ID=mac`, this machine's
   token, and `HIVE_BROKER_URL` pointing at the BROKER'S TAILNET ADDRESS on the dev box —
   `run-edge.zsh` sources this file; nothing is hardcoded local.
3. Account pin (R-5): authenticate Codex Desktop normally in `/Users/hakon/.codex`, then create the
   pinned profile at `/Users/hakon/.hive/profiles/ariadne` with mode `0700`. Its `auth.json` must be
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
   `CODEX_HOME=/Users/hakon/.hive/profiles/ariadne HIVE_CODEX_DESKTOP_HOME=/Users/hakon/.codex HIVE_ACTOR=ariadne HIVE_SESSION_ID=<thread> hive-codex-live`.
   Neither socket can be remote, so this daemon only ever serves a seat whose subscription names
   *this* machine as its edge — it is the reason a Mac edge would be revived, and the reason the
   cx53 seat has headless wakes only. Without the live daemon, wakes use the subscription's
   normal headless policy under the same pinned `CODEX_HOME`.
5. Subscription: none. `deploy/subscriptions/ariadne.json` names edge `cx53`; a revived Mac edge
   needs its own subscription (or that file edited back) before any wake reaches this box.
   `put-subscription` only ever *upserts*, so re-pointing an actor never removes the row it
   replaces — a retired actor is retired explicitly with `hive delete-subscription <actor>`
   (needs `HIVE_BROKER_URL` + `HIVE_ADMIN_TOKEN`), which fails closed while any delivery for it
   is still non-terminal.
