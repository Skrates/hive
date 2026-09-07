# Broker: dev box (`192.168.1.238`)

One broker for the whole Weave: the Slack Socket Mode ingress, the HTTP listener every edge
dials over the tailnet, and — in the same SQLite file — the review state machine (design
§9.3). `broker.env.example` is the shape of `/etc/hive/broker.env` (mode 0600, owner `hive`);
`HIVE_BROKER_DB` names the database both live in.

## Two generations, two resets

The broker asserts a generation on every boot, and a stale one is a refusal to start, never a
degraded broker:

| Stamp | Guards | Refusal | Reset |
| -- | -- | -- | -- |
| `user_version` (ADR-0003 R-8) | the Hive ledger: deliveries, subscriptions, outbox | `LegacyDatabaseError` | move the whole database aside, start fresh |
| `review_store_generation` (§9.3) | the persisted reviews: `state_json`, batch consequences, effect targets | `LegacyReviewStoreError` | `hive review reset-store` — the ledger is untouched |

Both print `[boot] refusing to start: …` and exit 1, so systemd shows the reason in
`journalctl -u hive-broker`.

## Upgrading past a review-store generation bump

A deploy whose `REVIEW_STORE_GENERATION` is above the stamp in the live database (the first
such deploy is generation 2, over the reviews the round-1 code wrote) refuses to boot. There is
no migration path — nothing in the build reads an older shape — so the reviews are dropped and
rebuilt from GitHub, which is the source of truth for every one of them:

```sh
sudo systemctl stop hive-broker
# operator credential: HIVE_OPERATOR_TOKEN_FILE names an owner-only (0600) file holding the
# token from `hive review create-operator`. Never run this inside an agent's environment.
sudo -u hive HIVE_OPERATOR_TOKEN_FILE=/etc/hive/operator.token \
  hive review reset-store /var/lib/hive/hive-broker.sqlite \
    --confirm /var/lib/hive/hive-broker.sqlite --as-operator
sudo systemctl start hive-broker
# then, per enrolled PR (or wait for the reconcile sweep to reach it):
hive review reconcile Skrates/hive#71
```

What the reset drops: `reviews`, `review_batches`, `review_attempts`, `review_effects`,
`github_inbox`, `source_records`, `review_projection_handles`, `review_transport`, and the
generation stamp itself, all in one transaction, which then re-stamps the running generation.

What it keeps: `review_policies` and `operators` — a policy version is configuration and an
operator's token hash is custody, neither is review state — and every broker table (deliveries,
subscriptions, the outbox), which the review tables never touch.

What is lost, plainly:

- **Revision history.** The batch log is the truth about how a Review reached its state; after
  the reset each Review starts again at the revision reconcile gives it. Anything that depended
  on `--expect <rev>` from before the reset is stale.
- **Projection handles.** The broker no longer knows the board comment id, the check run ids or
  the Slack thread ts it was editing in place. The next reconcile **creates new ones** — so the
  board comment already on each PR is an orphan: nothing will ever update it again. Delete those
  stale comments by hand, or leave them and expect two board comments per PR.
- **Findings, holds and answers not visible on GitHub.** Reconcile rebuilds from what the PR
  carries; an operator hold or a granted round placed before the reset must be placed again.

The reset refuses unless `--confirm` repeats the database path exactly, unless `--as-operator`
is given, and unless the token is a live `operators` row in that very database. Any refusal
leaves the file byte-for-byte as it was.
