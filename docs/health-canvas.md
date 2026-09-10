# Hive overview

The current operational canvas is [Hive overview](https://skrates.slack.com/docs/T0ANP1RUACU/F0BUSRNGSJK). It has one quota row per configured seat, grouped attention items, and a link to the [August 6 State of the Weave archive](https://skrates.slack.com/docs/T0ANP1RUACU/F0BPAD39SSU). The archive preserves its historical content; it is not a second current dashboard.

## Data and ownership

The AI Usage `/v3/usage` feed supplies the active quota pools; `/doctor` supplies collector outcomes and receipt times. The broker's `usageBindings` list declares the five seats in presentation order and their quota sources. It is authoritative even when a maintenance report contains an obsolete collector ID. Gnomon and Theoros use the same Gnomon quota collector. Ariadne uses the cloud Codex collector. An unrelated or retired collector cannot append another seat row.

The broker ledger supplies current enrollment, edge heartbeats, and last-delivery status. Quota sample age, collector receipt age, edge presence, and maintenance freshness remain separate. An online edge does not claim a registered or ready receiving session. Maintenance joins still require the exact enrolled actor, provider, edge, and absolute profile path.

Fresh maintenance failures are grouped into short actions: reconnect services, inspect missing/differing skills, or check plugin installations. Four Cloudflare authentication failures become one Cloudflare action. A stale maintenance report produces one stale-check notice; its old auth and inventory failures are not repeated as current findings. This does not turn unknown or stale evidence into healthy status.

Full per-profile MCP/plugin inventories, hashes, paths, collector details, and original observation timestamps remain in the owner-only `.md.json` report written alongside each canvas refresh. They are not repeated on the overview. Provider checks remain read-only and never start a model turn, refresh an account login, or modify installed skills/plugins.

## Broker configuration

`~/.config/hive/health-canvas.json` contains:

- `doctrineRoot`: clean checkout of the intended Weave revision;
- `brokerDb`: the broker SQLite database;
- `usageUrl`: the authenticated AI Usage service base URL;
- `canvasId`: the current machine-owned overview;
- `archiveUrl`: the historical board's Slack link;
- `usageBindings`: ordered `{actor, edgeId, profileId}` entries, one per seat;
- `probes`: optional bounded read-only commands for operator-driven checks.

The deployed bindings match the merged AI Usage roster:

| Seat | Quota collector | Collector edge |
| --- | --- | --- |
| Fable | fable-linux | edge-linux |
| Gnomon | gnomon-cx53 | edge-cx53 |
| Theoros | gnomon-cx53 | edge-cx53 |
| Ariadne | ariadne-codex-cx53 | edge-cx53 |
| Talos | talos-cx43 | edge-cx43 |

The former `accountChanges` history filter is removed. The current AI Usage feed already excludes retired collectors and old session bindings; the explicit roster controls this presenter's membership. Topology changes are manual updates to the source roster and broker configuration.

Slack credentials remain only on the broker. The service loads its owner-only environment files for `HIVE_SLACK_BOT_TOKEN` and `HIVE_USAGE_READ_TOKEN`; no secret belongs in the JSON config. Edge maintenance reports continue over Hive's existing authenticated outbound connection. The broker validates them before storage.

## Preview, publish, and verify

Build and check with `bun run check` and `bun run build`. Stage the exact commit in a separate release directory when a checkout contains local work. Update only the canvas service's release override for a presentation-only deployment; do not restart or replace the broker/edge runtimes.

```sh
node dist/health/canvas-main.js ~/.config/hive/health-canvas.json ~/.local/state/hive/health-canvas.md preview
```

Preview writes Markdown plus the complete sanitized JSON report, both mode 0600. Check the five rows, shared usage, attention grouping, unknown/stale states, reset times, and historical-board link before publishing.

```sh
systemctl --user start hive-health-canvas.service
```

The existing five-minute timer is the single writer for the overview. `publish` replaces that dedicated canvas. A missing or dirty source fails the refresh and leaves its old timestamp visible; the canvas is stale after 15 minutes without an update. Verify Slack readback after publication and again after a scheduled run. Back up the prior release override and config so the previous publisher can be restored.

Changes to the historical manual board use Slack's section edits, preserving the original content beneath a clearly dated archive notice. Never point the automated publisher at that board.
