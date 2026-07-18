#!/bin/zsh
set -euo pipefail
umask 077

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HIVE_BROKER_URL="${HIVE_BROKER_URL:-http://127.0.0.1:8790}"
export HIVE_ADMIN_TOKEN="$(security find-generic-password -a hive -s is.sokrates.hive.admin -w)"

exec "${HOME}/.local/bin/node" "${HOME}/.local/lib/hive/dist/cli.js" "$@"
