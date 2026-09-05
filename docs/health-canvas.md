# AI usage and profile health canvas

The broker publishes a dedicated, machine-owned Slack canvas from three sources:

- The clean, pinned Weave Doctrine checkout supplies every declared seat and its intended skills and enabled Claude plugins.
- The broker's subscriptions and delivery ledger supply every enrolled profile, edge last-seen time and last delivery. Edge maintenance reports arrive over the existing authenticated outbound HTTP connection.
- ClaudeSwifties `/doctor` and `/v3/usage` supply the configured reporters and current quota pools, including never-seen reporters. Retired reporters, explicitly replaced account pools, and pools with no current observer are excluded from the display; the aggregator history is untouched.

Every intended or enrolled seat remains visible when a machine stops reporting, including a seat whose current account has no quota sample yet. Health joins require the exact enrolled edge, actor, provider and absolute account path; an unresolved `~/` declaration cannot match a suffix. The observed hostname is displayed alongside the authenticated edge, so a Mac report cannot supply cx53 health. Labels are never an identity key. Quota pool status never supplies an individual profile's auth verdict. Collector receipt, attempted sample and retained quota sample timestamps are separate. A healthy collector without an enrolled Hive seat remains visible as an independent reporter; missing receipt or quota evidence still raises attention.

## Collection

An edge queries `GET /v1/health/profiles` under its existing machine credential. For each home-edge subscription it launches the read-only `dist/health/profile-probe.js` child, then posts a schema-checked report to `POST /v1/health`. The broker checks the actor, provider and account path against the edge's enrollment. Reports cannot contain arbitrary additional fields. No Slack credential or new inbound port is added to an edge.

Checks run sequentially per edge, with bounded child lifetime, followed by a five-minute pause. They do not hold delivery slots or block the delivery event loop. Failure leaves the prior observation timestamp intact; a failed probe cannot manufacture a new healthy observation. Registered receiving-session evidence is captured separately from disk installation inventory, including its original heartbeat expiration. A past registration or delivery is not current readiness.

Claude checks honor the same `HIVE_CLAUDE_COMMAND` override as delivery and use the pinned `CLAUDE_CONFIG_DIR`, `claude auth status --json`, and the connection-checking `claude mcp list`. A local login is labeled local login presence, not successful remote authentication. Codex starts a bounded, profile-pinned app-server subprocess and reads `account/read` plus paginated `mcpServerStatus/list`. This removes dependence on an obsolete control socket. Grok uses its read-only `_x.ai/auth/info` method and `grok mcp doctor --json`; zero configured servers is reported as `none_configured`, not an unknown connection. Neither probe starts or resumes a model turn. Native checks execute inside the pinned profile directory, so project overrides from the edge service working directory cannot alter profile-level health. Names with spaces, including account-connected Claude MCPs, remain in the inventory.

The broker reads `skills_dir` from the same intended Weave registry used by the canvas and passes it to the edge; an explicit null disables personal-skill inventory, and an omitted value defaults to `<accountProfile>/skills` as in the Weave installer. The edge resolves `~/` on its own machine and reports the exact inspected root. Skill drift compares whole directory content and executable bits against intended source files. It reports missing skills and differences from the intended revision; it does not guess whether differences came from an old install or local edits. Claude plugin inventory uses `claude plugin list --json` to compare active user-scope installations to enabled intent and the locally cached marketplace version when declared. Disabled caches are excluded; missing files and enabled intent without an installation remain defects. Deliberately disabled MCP servers are shown as `disabled` without a reconnect alert. Grok collector bindings are read from `<accountProfile>/.grok/ai-usage/config.json`. Codex cache versions are explicitly **cached only**: they do not prove activation or the version loaded by an existing session. Live marketplace version checks, and verification of all session-loaded files, remain unverified.

## Broker configuration

Create `~/.config/hive/health-canvas.json` on the broker, keeping secrets out of JSON:

```json
{
  "doctrineRoot": "/home/hakon/weave-doctrine-health",
  "brokerDb": "/home/hakon/.local/state/hive/broker.sqlite",
  "usageUrl": "https://agent-cx53.tail1f9f2e.ts.net",
  "canvasId": "F0BUSRNGSJK",
  "usageBindings": [
    {"actor": "ariadne", "edgeId": "edge-mac", "profileId": "ariadne-codex-mac"},
    {"actor": "fable", "edgeId": "edge-linux", "profileId": "fable-linux"}
  ],
  "accountChanges": [{
    "actors": ["gnomon", "theoros"],
    "label": "Shared personal Max",
    "note": "",
    "previousPoolIds": [
      "claude-YhOSo0fqwv94-WK7w7s-FMP9WHw2KkAEa-sM2zHGE2c",
      "claude-yajd8TgdOY23-QOx2iIw0mHbX_UgOkoIM8wcCTgbpog"
    ]
  }]
}
```

The account change is operator-confirmed identity information, not a fabricated merged quota pool. The named old pools and their retired reporter projections are omitted from the canvas. Once collectors supply the new identity and windows, remove the resolved operational note. Do not relabel or merge the old samples into the new account.

`doctrineRoot` must be a clean checkout at the intended revision. Pin and update it deliberately when intended installations change; the renderer reports its full revision. Never silently upgrade seat installations as part of this process. `usageBindings` are explicit joins for profiles whose local collector configuration does not supply a binding; the normal path uses that configuration instead. Optional `probes` entries (`actor`, expected `edgeId`, and a command argument array) support an operator's bounded, on-demand local/SSH probe; production needs none once edge reporting is deployed. Commands must output only the profile report schema. Secrets, provider output and command stderr are never shown on the canvas.

Set `HIVE_HEALTH_CANVAS_CONFIG` to this JSON file in the broker environment so edge targets and the renderer read one registry declaration. Set `HIVE_USAGE_READ_TOKEN` in the broker's owner-only canvas environment file, using the aggregator's separate read token. Load that file alongside `broker.env` in the canvas service. Reuse `HIVE_SLACK_BOT_TOKEN` there; do not copy it to an edge. The existing Hive app needs [`canvases:write`](https://docs.slack.dev/reference/methods/canvases.edit/) and edit access to the dedicated canvas. Reinstall/re-authorize the app after adding the scope. Existing chat permissions do not imply canvas write access.

## Publish and maintain

Deploy the reviewed Hive build to the broker and edges using their existing supervisors. When a deployed checkout has local edits, stage the exact PR commit in a separate release directory and use an `ExecStart` supervisor drop-in; preserve the original checkout and service file for rollback. The broker creates the health-report table on startup. Install the systemd **user** service and timer from `deploy/systemd/user/hive-health-canvas.{service,timer}` into the broker user's `~/.config/systemd/user/`. These units target the verified user-service broker on timaeus-dev, not the separate `/opt/hive` system-service example. Their default paths match that user's `~/hive` checkout and `~/.local/state/hive` state directory; set a service drop-in `WorkingDirectory` and `ExecStart` to the staged release for deployment without modifying the checkout.

Preview first:

```sh
node dist/health/canvas-main.js ~/.config/hive/health-canvas.json ~/.local/state/hive/health-canvas.md preview
```

The environment must contain `HIVE_USAGE_READ_TOKEN`. Preview produces Markdown and a sanitized `.md.json` evidence snapshot, both mode 0600. An unavailable source still renders its declared rows as unknown. A missing/dirty doctrine source fails the refresh, keeping the previous canvas timestamp visible.

After verifying the dedicated canvas ID, enable its single writer:

```sh
systemctl --user daemon-reload
systemctl --user enable --now hive-health-canvas.timer
systemctl --user start hive-health-canvas.service
systemctl --user status hive-health-canvas.service hive-health-canvas.timer
```

`publish` replaces the entire dedicated canvas; never point it at a shared manual board. The service has a three-minute bound and Slack retries are bounded by the next timer tick. systemd does not overlap the same oneshot service. A successful publish labels unattended refresh enabled only when its timer is actually active. Failure is a nonzero service result; the canvas's old timestamp remains visible and must be treated as stale after 15 minutes. Verify a second scheduled update before claiming unattended publication works.

## Initial publication

The initial [AI usage & profile health canvas](https://skrates.slack.com/docs/T0ANP1RUACU/F0BUSRNGSJK) was published from actual observations on 2026-09-05. At first publication it explicitly labeled automatic refresh blocked. At that time, the broker token lacked `canvases:write`; no broker/edge deployment or running refresh timer was claimed. The existing manual State of the Weave canvas was preserved.

Initial coverage: five enrolled seats, nine usage reporters, live disk/MCP probes for Gnomon and Theoros, and an Ariadne disk probe whose pinned app-server health endpoint was unavailable. Fable/Talos maintenance, Grok auth/MCP health, fresh usage for the shared personal Max account, and session-loaded installations remain unverified. These are visible gaps, not healthy defaults.

## Repair verification, 2026-09-05

Maintenance reporters now run for all five seats across the Mac, cx53, cx43, and Fable’s laptop. Gnomon and Theoros collectors again submit fresh samples bound to the same personal Max quota pool, and Fable’s Claude collector is recovered. Their stale version-specific executable paths were replaced by the stable Claude launcher. Talos has an enrolled, profile-pinned Grok collector on cx43. Native provider checks report local login presence for all five seats; Fable’s four Cloudflare MCP logins require human authentication. Skill installations were refreshed with the canonical Weave installer and preserved backups. Plugin catalog refreshes and an active plugin update were performed as explicit repair work, separate from read-only periodic monitoring.
