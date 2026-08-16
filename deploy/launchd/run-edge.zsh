#!/bin/zsh
set -euo pipefail

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# libuv's default threadpool is 4, which is exactly MAX_CONCURRENT_DISPATCHES.
# The claim-time attestation read runs on that pool and can park indefinitely on
# a stalled network mount, and a timeout cannot reclaim a blocked thread. At the
# default, four such reads consume the whole pool and every other fs/dns/crypto
# job on the edge queues behind them. Set before exec so libuv sees it.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

# All edge identity comes from the env file — the broker lives on the dev box
# tailnet in the v0.5 topology, never on this machine. Required keys:
# HIVE_BROKER_URL, HIVE_EDGE_ID, HIVE_EDGE_TOKEN, HIVE_EDGE_DB; optional
# HIVE_EDGE_SOCKET / HIVE_INGRESS_DIR (default under ~/.hive).
set -a
source "${HOME}/.config/hive/edge.env"
set +a

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/cli.js" edge
