#!/bin/zsh
set -euo pipefail
umask 077

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HIVE_ACTOR="ariadne"
export HIVE_EDGE_URL="http://127.0.0.1:8791"
export HIVE_EDGE_LOCAL_TOKEN="$(security find-generic-password -a mac -s is.sokrates.hive.local-token -w)"
export HIVE_PROVIDER_SURFACE="codex-desktop-ipc"
export HIVE_PROVIDER_VERSION="desktop-ipc-v1"

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/codex/live.js"
