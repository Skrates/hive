#!/bin/zsh
set -euo pipefail

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HIVE_BROKER_URL="http://127.0.0.1:8790"
export HIVE_EDGE_ID="mac"
export HIVE_EDGE_TOKEN="$(security find-generic-password -a mac -s is.sokrates.hive.edge-token -w)"
export HIVE_EDGE_LOCAL_TOKEN="$(security find-generic-password -a mac -s is.sokrates.hive.local-token -w)"
export HIVE_EDGE_DB="${HOME}/Library/Application Support/Hive/edge.sqlite"
export HIVE_EDGE_HOST="127.0.0.1"
export HIVE_EDGE_PORT="8791"

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/cli.js" edge
