#!/bin/zsh
emulate -L zsh
set -euo pipefail

actor="${1:-ariadne}"
if (( $# > 0 )); then
  shift
fi

hive_command="${HIVE_BIN:-${HOME}/.local/bin/hive}"
channel_id="${HIVE_CHANNEL_ID:-C0BGBEQQQHH}"

exec "$hive_command" attach "$actor" \
  --cwd "$PWD" \
  --channel "$channel_id" \
  "$@"
