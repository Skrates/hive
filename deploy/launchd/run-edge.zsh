#!/bin/zsh
set -euo pipefail

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# All edge identity comes from the env file — the broker lives on the dev box
# tailnet in the v0.5 topology, never on this machine. Required keys:
# HIVE_BROKER_URL, HIVE_EDGE_ID, HIVE_EDGE_TOKEN, HIVE_EDGE_DB; optional
# HIVE_EDGE_SOCKET / HIVE_INGRESS_DIR (default under ~/.hive).
set -a
source "${HOME}/.config/hive/edge.env"
set +a

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/cli.js" edge
