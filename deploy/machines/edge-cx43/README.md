# Edge: cx43 (`coolify-fsn1`, Hetzner) — seat talos (Grok Build, SuperGrok subscription)

Talos's live body since 2026-08-16 (moved off the RunPod pod; subscription and registry cutover
2026-09-05, KRA-1322). The host is also the **public Coolify demo box** (tailnet `100.104.23.33`,
public `167.233.120.83`): the demo stack and the seat share 8 vCPU / 15 GB with no swap.
Operating rule (Hákon, 2026-08-16): **no seat burns during a live demo** — park Talos work for the
demo window rather than resizing anything.

## Layout (verified 2026-09-05)

- Non-sudo user `hive`; profile `/home/hive/.hive/profiles/talos`. Grok Build keeps auth and
  config under `~/.grok` with no config-dir override, so the edge pins `HOME` to the profile — the
  profile *is* the seat's home.
- Edge checkout `/home/hive/hive` (built with the local `tsc`; `.deployed-sha` records the source
  SHA staged there). Shims `hive` and `hive-claude-hook` in `/home/hive/.local/bin`.
- Launcher: the shared `deploy/systemd/hive-edge.service` installed as a **system** unit
  (`User=hive`, `EnvironmentFile=/home/hive/.config/hive/edge.env`, `ExecStart` pointing at the
  checkout's `dist/cli.js`). It is the same unit cx53 runs; there is no cx43-specific launcher.
- Env `/home/hive/.config/hive/edge.env` (mode 0600, owner `hive`): the variable names are in
  `edge.env.example` beside this file — `HIVE_EDGE_ID=cx43`, the broker's tailnet URL, this
  edge's bearer. Values live only on the box.
- Subscription `deploy/subscriptions/talos.json`: `homeEdge: cx43`, `turnSlots: 2`, workspace cwd
  `/home/hive/work/slot-{slot}`. **Both `/home/hive/work/slot-1` and `/home/hive/work/slot-2`
  must exist, owned `hive:hive`, before the first wake lands** — each slot is its own checkout
  tree, never shared (KRA-1364). Tailscale joined; outbound only, no inbound port.

## Install / update the edge code

Boxes hold no GitHub credential: the tree arrives as a `git archive` from an authorized checkout.
The whole flow is the `deploy-hive` skill (weave-doctrine) and its `deploy-hive.sh`; by hand:

```bash
git archive --format=tar <sha> | ssh root@100.104.23.33 'cd /home/hive/hive && tar -x && echo <sha> > .deployed-sha \
  && ./node_modules/.bin/tsc -p tsconfig.json && chmod +x dist/cli.js dist/channel/claude-hook.js \
  && chown -R hive:hive /home/hive/hive && systemctl restart hive-edge && systemctl is-active hive-edge'
```

Done when the broker ledger's `edges.last_seen_at` for `cx43` is later than the restart and
`su - hive -c 'hive --help'` lists the subcommands the revision added.

## Seat move / standup

A new body for an existing actor (profile transfer, cutover acceptance) is `weave-seat-standup`;
Coolify-side service work on this host is `deploy-to-cx43`. Neither is repeated here.
