#!/bin/zsh
emulate -L zsh
set -euo pipefail
umask 077

if (( $# < 1 || $# > 2 )); then
  print -u2 "usage: push-linux-edge.zsh USER@HOST [IDENTITY_FILE]"
  exit 2
fi

ROOT="${0:A:h:h}"
REMOTE="$1"
IDENTITY="${2:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/hive-linux-stage.XXXXXX")"
REMOTE_STAGE=".local/lib/hive.stage-${STAMP}"
PRE_MANIFEST="${LOCAL_STAGE}.source-before.sha256"
POST_MANIFEST="${LOCAL_STAGE}.source-after.sha256"
typeset -a SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)
typeset -a SOURCE_FILES=(
  AGENTS.md
  README.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
)
typeset -a SOURCE_DIRS=(src deploy docs)

if [[ -n "$IDENTITY" ]]; then
  SSH_ARGS+=(-i "$IDENTITY")
fi
RSYNC_SHELL="ssh -o BatchMode=yes -o ConnectTimeout=10"
if [[ -n "$IDENTITY" ]]; then
  RSYNC_SHELL+=" -i ${(q)IDENTITY}"
fi

function cleanup() {
  rm -rf "$LOCAL_STAGE"
  rm -f "$PRE_MANIFEST" "$POST_MANIFEST"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

function fail() {
  print -u2 -- "$1"
  return 1
}

function require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Hive Linux push requires $1."
}

function source_manifest() {
  local base="$1"
  local output="$2"
  local paths_file="${output}.paths"
  (
    cd "$base"
    : > "$paths_file"
    local item
    for item in $SOURCE_FILES; do
      [[ -f "$item" ]] || fail "Hive source snapshot is missing ${item}."
      print -r -- "$item" >> "$paths_file"
    done
    for item in $SOURCE_DIRS; do
      [[ -d "$item" ]] || fail "Hive source snapshot is missing ${item}/."
      find "$item" -type f \
        ! -name '.env' ! -name '.env.*' ! -name '.npmrc' \
        ! -path '*/.git/*' ! -path '*/coverage/*' \
        ! -path '*/node_modules/*' ! -path '*/dist/*' \
        -print >> "$paths_file"
    done
    LC_ALL=C sort -u "$paths_file" | while IFS= read -r item; do
      shasum -a 256 "$item"
    done > "$output"
  )
  rm -f "$paths_file"
}

function copy_source_snapshot() {
  local item
  for item in $SOURCE_FILES; do
    install -m 600 "${ROOT}/${item}" "${LOCAL_STAGE}/${item}"
  done
  for item in $SOURCE_DIRS; do
    mkdir -p "${LOCAL_STAGE}/${item}"
    rsync -a --delete \
      --exclude '.git' --exclude '.git/***' \
      --exclude '.env' --exclude '.env.*' --exclude '.npmrc' \
      --exclude 'coverage' --exclude 'coverage/***' \
      --exclude 'node_modules' --exclude 'node_modules/***' \
      --exclude 'dist' --exclude 'dist/***' \
      "${ROOT}/${item}/" "${LOCAL_STAGE}/${item}/"
  done
}

function assert_no_forbidden_snapshot_files() {
  local found
  found="$(find "$LOCAL_STAGE" \
    \( -name '.git' -o -name '.env' -o -name '.env.*' -o -name '.npmrc' -o -name coverage \) \
    -print -quit)"
  [[ -z "$found" ]] || fail "Forbidden deployment input entered the snapshot: ${found}"
}

for command_name in pnpm node rsync ssh shasum mktemp install cmp find sort; do
  require_command "$command_name"
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
  || fail "Hive requires Node.js 22 or newer."
[[ -z "$IDENTITY" || -r "$IDENTITY" ]] || fail "SSH identity is not readable: ${IDENTITY}"
chmod 700 "$LOCAL_STAGE"

# Capture only the explicit source allowlist before running any gate.
source_manifest "$ROOT" "$PRE_MANIFEST"
copy_source_snapshot
assert_no_forbidden_snapshot_files
source_manifest "$ROOT" "$POST_MANIFEST"
cmp -s "$PRE_MANIFEST" "$POST_MANIFEST" \
  || fail "Hive source changed while the immutable deployment snapshot was being captured; retry."
source_manifest "$LOCAL_STAGE" "${LOCAL_STAGE}/.hive-source-manifest"
cmp -s "$PRE_MANIFEST" "${LOCAL_STAGE}/.hive-source-manifest" \
  || fail "Hive staged source does not match the captured source manifest."

# Gate the exact local snapshot. Linux repeats the gate with Linux-native dependencies before stop.
(
  cd "$LOCAL_STAGE"
  pnpm install --frozen-lockfile
  [[ -d node_modules && -d node_modules/.pnpm ]] || fail "Staged node_modules is incomplete."
  node -e 'require("better-sqlite3")'
  pnpm check
  pnpm build
)
source_manifest "$LOCAL_STAGE" "${LOCAL_STAGE}/.hive-source-manifest.after"
cmp -s "${LOCAL_STAGE}/.hive-source-manifest" "${LOCAL_STAGE}/.hive-source-manifest.after" \
  || fail "Hive staged source changed while gates ran."
rm -f "${LOCAL_STAGE}/.hive-source-manifest.after"

# Preflight remote tooling and configuration before transferring or stopping anything.
ssh $SSH_ARGS "$REMOTE" 'set -eu
  command -v curl >/dev/null
  command -v systemctl >/dev/null
  command -v sqlite3 >/dev/null
  command -v sha256sum >/dev/null
  command -v stat >/dev/null
  test -r "$HOME/.config/hive/edge.env"
  mode="$(stat -c %a "$HOME/.config/hive/edge.env")"
  test "$((0${mode} & 077))" -eq 0
  ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?PATH=" "$HOME/.config/hive/edge.env"
  . "$HOME/.config/hive/edge.env"
  test "${HIVE_EDGE_ID:-}" = fable-linux
  node_path="${HIVE_NODE_COMMAND:-}"
  claude_path="${HIVE_CLAUDE_COMMAND:-}"
  claude_version="${HIVE_CLAUDE_VERSION:-}"
  case "$node_path" in /*) ;; *) exit 1 ;; esac
  case "$claude_path" in /*) ;; *) exit 1 ;; esac
  test -x "$node_path"
  test -x "$claude_path"
  printf "%s" "$claude_version" | grep -Eq "^[0-9]+\.[0-9]+\.[0-9]+$"
  test -n "${HIVE_BROKER_URL:-}"
  build_path="${node_path%/*}:$HOME/.local/share/pnpm:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  service_path="${node_path%/*}:${claude_path%/*}:/usr/local/bin:/usr/bin:/bin"
  PATH="$build_path"
  export PATH
  command -v pnpm >/dev/null
  "$node_path" -e '\''if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'\''
  "$node_path" -e '\''
    let url;
    try {
      url = new URL(process.argv[1]);
    } catch {
      process.exit(1);
    }
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "127.0.0.1"
      || hostname === "localhost"
      || hostname === "[::1]"
      || hostname === "::1";
    const transportAllowed = url.protocol === "https:"
      || (url.protocol === "http:" && loopback);
    if (!transportAllowed || url.username !== "" || url.password !== "") process.exit(1);
  '\'' "$HIVE_BROKER_URL"
  version_output="$(env -i HOME="$HOME" PATH="$service_path" USER="${USER:-rationallyprime}" \
    DISABLE_AUTOUPDATER=1 \
    "$claude_path" --version 2>/dev/null)"
  case "$version_output" in
    "$claude_version"|"$claude_version (Claude Code)") ;;
    *) exit 1 ;;
  esac
'

ssh $SSH_ARGS "$REMOTE" \
  "set -eu; umask 077; test ! -e \"\$HOME/${REMOTE_STAGE}\"; mkdir -p \"\$HOME/${REMOTE_STAGE}\"; chmod 700 \"\$HOME/${REMOTE_STAGE}\""
rsync -a --delete \
  --exclude '.git' --exclude '.git/***' \
  --exclude '.env' --exclude '.env.*' --exclude '.npmrc' \
  --exclude 'coverage' --exclude 'coverage/***' \
  --exclude 'node_modules' --exclude 'node_modules/***' \
  -e "$RSYNC_SHELL" \
  "${LOCAL_STAGE}/" "${REMOTE}:~/${REMOTE_STAGE}/"
ssh $SSH_ARGS "$REMOTE" \
  "bash \"\$HOME/${REMOTE_STAGE}/deploy/install-linux-edge.sh\" \"\$HOME/${REMOTE_STAGE}\""

print "Hive Linux edge pushed from the immutable gated snapshot ${STAMP}."
