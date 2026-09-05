# AI usage and profile health canvas

The broker publishes a dedicated, machine-owned Slack canvas from three sources:

- The clean, pinned Weave Doctrine checkout supplies every declared seat and its intended skills and enabled Claude plugins.
- The broker's subscriptions and delivery ledger supply every enrolled profile, edge last-seen time and last delivery. Edge maintenance reports arrive over the existing authenticated outbound HTTP connection.
- ClaudeSwifties `/doctor` and `/v3/usage` supply every configured or historical reporter and quota pools, including never-seen reporters.

The union remains visible when a machine stops reporting. Joins use an explicit actor, provider, account profile and collector edge/profile identity. Labels are never an identity key. Quota pool status never supplies an individual profile's auth verdict. Collector receipt, attempted sample and retained quota sample timestamps are separate.

## Collection

An edge queries `GET /v1/health/profiles` under its existing machine credential. For each home-edge subscription it launches the read-only `dist/health/profile-probe.js` child, then posts a schema-checked report to `POST /v1/health`. The broker checks the actor, provider and account path against the edge's enrollment. Reports cannot contain arbitrary additional fields. No Slack credential or new inbound port is added to an edge.

Checks run sequentially per edge, with bounded child lifetime, followed by a five-minute pause. They do not hold delivery slots or block the delivery event loop. Failure leaves the prior observation timestamp intact; a failed probe cannot manufacture a new healthy observation. Registered receiving-session evidence is captured separately from disk installation inventory, including its original heartbeat expiration. A past registration or delivery is not current readiness.

Claude checks use the pinned `CLAUDE_CONFIG_DIR`, `claude auth status --json`, and the connection-checking `claude mcp list`. A local login is labeled local login presence, not successful remote authentication. Codex reads `account/read` and paginated `mcpServerStatus/list` from the pinned profile's existing app-server control socket. A missing socket is an unverified check, not an expired login. No turn is started or resumed. Grok auth/MCP checks remain unverified; usage is still reported where a collector binding exists.

Skill drift compares whole directory content and executable bits against intended source files. It reports missing skills and differences from the intended revision; it does not guess whether differences came from an old install or local edits. Claude plugin inventory compares user-scope installation records to enabled intent and the locally cached marketplace version when declared. Codex cache versions are explicitly **cached only**: they do not prove activation or the version loaded by an existing session. Live marketplace version checks, and verification of all session-loaded files, remain unverified.

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
    "note": "Hákon confirms these seats moved from separate Team subscriptions. Previous Team samples are historical; new account usage has not been reported.",
    "previousPoolIds": [
      "claude-YhOSo0fqwv94-WK7w7s-FMP9WHw2KkAEa-sM2zHGE2c",
      "claude-yajd8TgdOY23-QOx2iIw0mHbX_UgOkoIM8wcCTgbpog"
    ]
  }]
}
```

The account change is operator-confirmed identity information, not a fabricated merged quota pool. Only the named old pools are marked historical. Once collectors supply the new identity and windows, remove the resolved operational note. Do not relabel or merge the old samples into the new account.

`doctrineRoot` must be a clean checkout at the intended revision. Pin and update it deliberately when intended installations change; the renderer reports its full revision. Never silently upgrade seat installations as part of this process. `usageBindings` are explicit joins for profiles whose local collector configuration does not supply a binding; the normal path uses that configuration instead. Optional `probes` entries (`actor` plus a command argument array) support an operator's bounded, on-demand local/SSH probe; production needs none once edge reporting is deployed. Commands must output only the profile report schema. Secrets, provider output and command stderr are never shown on the canvas.

Set `HIVE_USAGE_READ_TOKEN` in the broker's existing owner-only environment file, using the aggregator's separate read token. Reuse `HIVE_SLACK_BOT_TOKEN` there; do not copy it to an edge. The existing Hive app needs [`canvases:write`](https://docs.slack.dev/reference/methods/canvases.edit/) and edit access to the dedicated canvas. Reinstall/re-authorize the app after adding the scope. Existing chat permissions do not imply canvas write access.

## Publish and maintain

Deploy the reviewed Hive build to the broker and edges using their existing supervisors. The broker creates the health-report table on startup. Install the systemd **user** service and timer from `deploy/systemd/hive-health-canvas.{service,timer}` into the broker user's `~/.config/systemd/user/`. The supplied paths match the existing `~/hive` broker checkout and `~/.local/state/hive` state directory.

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

The initial [AI usage & profile health canvas](https://skrates.slack.com/docs/T0ANP1RUACU/F0BUSRNGSJK) was published from actual observations on 2026-09-05. It explicitly labels automatic refresh blocked. At publication, the broker token lacked `canvases:write`; no broker/edge deployment or running refresh timer was claimed. The existing manual State of the Weave canvas was preserved.

Initial coverage: five enrolled seats, nine usage reporters, live disk/MCP probes for Gnomon and Theoros, and an Ariadne disk probe whose pinned app-server health endpoint was unavailable. Fable/Talos maintenance, Grok auth/MCP health, fresh usage for the shared personal Max account, and session-loaded installations remain unverified. These are visible gaps, not healthy defaults.
