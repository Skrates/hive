#!/bin/zsh
emulate -L zsh
set -euo pipefail
umask 077

ROOT="${0:A:h:h}"
DOMAIN="gui/$(id -u)"
RUNTIME="${HOME}/.local/lib/hive"
BIN_DIR="${HOME}/.local/bin"
HIVE_BIN="${BIN_DIR}/hive"
AGENTS_DIR="${HOME}/Library/LaunchAgents"
STATE_DIR="${HOME}/Library/Application Support/Hive"
LOG_DIR="${HOME}/Library/Logs/Hive"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="${HOME}/.local/lib/hive.stage-${STAMP}"
BACKUP="${HOME}/.local/lib/hive.rollback-${STAMP}"
NODE="${HOME}/.local/bin/node"
PRE_MANIFEST="${BACKUP}/source-before.sha256"
POST_MANIFEST="${BACKUP}/source-after.sha256"
PREPARED_PLISTS="${BACKUP}/prepared-launchagents"
ARIADNE_BINDING_SNAPSHOT="${BACKUP}/ariadne-binding.snapshot"
COMMITTED=0
SWAP_PHASE="untouched"
HAD_RUNTIME=0
ROLLING_BACK=0
ARIADNE_BINDING_SNAPSHOTTED=0

typeset -a STOP_LABELS=(
  is.sokrates.hive-codex-supervisor
  is.sokrates.hive-edge
  is.sokrates.hive-broker
)
typeset -a START_LABELS=(
  is.sokrates.hive-broker
  is.sokrates.hive-edge
  is.sokrates.hive-codex-supervisor
)
typeset -a PLISTS=(
  is.sokrates.hive-broker.plist
  is.sokrates.hive-edge.plist
  is.sokrates.hive-codex-supervisor.plist
)
typeset -a SOURCE_FILES=(
  AGENTS.md
  README.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
)
typeset -a SOURCE_DIRS=(src deploy docs)
typeset -a LOG_FILES=(
  broker.log
  broker.err.log
  edge.log
  edge.err.log
  codex-supervisor.log
  codex-supervisor.err.log
)

function fail() {
  print -u2 -- "$1"
  return 1
}

function require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Hive install requires $1."
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
    install -m 600 "${ROOT}/${item}" "${STAGE}/${item}"
  done
  for item in $SOURCE_DIRS; do
    mkdir -p "${STAGE}/${item}"
    rsync -a --delete \
      --exclude '.git' --exclude '.git/***' \
      --exclude '.env' --exclude '.env.*' --exclude '.npmrc' \
      --exclude 'coverage' --exclude 'coverage/***' \
      --exclude 'node_modules' --exclude 'node_modules/***' \
      --exclude 'dist' --exclude 'dist/***' \
      "${ROOT}/${item}/" "${STAGE}/${item}/"
  done
}

function assert_no_forbidden_snapshot_files() {
  local found
  found="$(find "$STAGE" \
    \( -name '.git' -o -name '.env' -o -name '.env.*' -o -name '.npmrc' -o -name coverage \) \
    -print -quit)"
  [[ -z "$found" ]] || fail "Forbidden deployment input entered the snapshot: ${found}"
}

function require_node_22() {
  [[ -x "$NODE" ]] || fail "Hive install requires ${NODE}."
  "$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
    || fail "Hive requires Node.js 22 or newer."
}

function require_keychain_secret() {
  local account="$1"
  local service="$2"
  local kind="$3"
  local value
  value="$(security find-generic-password -a "$account" -s "$service" -w 2>/dev/null)" \
    || fail "Missing Keychain item ${service}."
  case "$kind" in
    xapp) [[ "$value" == xapp-* ]] || fail "Keychain item ${service} is not a Slack app token." ;;
    xoxb) [[ "$value" == xoxb-* ]] || fail "Keychain item ${service} is not a Slack bot token." ;;
    token) (( ${#value} >= 32 )) || fail "Keychain item ${service} is too short." ;;
    *) fail "Unknown secret kind ${kind}." ;;
  esac
  value=""
}

function materialize_plist_to() {
  local source="$1"
  local target="$2"
  sed "s|__HOME__|${HOME}|g" "$source" > "$target"
  plutil -lint "$target" >/dev/null
  chmod 600 "$target"
}

function is_loaded() {
  launchctl print "${DOMAIN}/$1" >/dev/null 2>&1
}

function unload_if_loaded() {
  local label="$1"
  if is_loaded "$label"; then
    launchctl bootout "${DOMAIN}/${label}"
    local attempt
    for attempt in {1..40}; do
      if ! is_loaded "$label"; then
        return 0
      fi
      sleep 0.25
    done
    fail "${label} did not finish unloading from launchd."
  fi
  return 0
}

function bootstrap_launchd() {
  local label="$1"
  local plist="$2"
  local attempt
  for attempt in {1..40}; do
    if launchctl bootstrap "$DOMAIN" "$plist" >/dev/null 2>&1; then
      return 0
    fi
    # A successful bootstrap can race launchctl's reply. Treat the exact loaded label as success.
    if is_loaded "$label"; then
      return 0
    fi
    sleep 0.25
  done
  if launchctl bootstrap "$DOMAIN" "$plist"; then
    return 0
  fi
  is_loaded "$label" \
    || fail "${label} could not be bootstrapped after launchd's bounded teardown window."
}

function wait_for_health() {
  local url="$1"
  local label="$2"
  local attempt
  for attempt in {1..80}; do
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
      "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  fail "${label} did not become healthy at ${url}."
}

function wait_for_launchd() {
  local label="$1"
  local attempt
  for attempt in {1..40}; do
    if launchctl print "${DOMAIN}/${label}" 2>/dev/null | grep -q 'state = running'; then
      return 0
    fi
    sleep 0.25
  done
  fail "${label} did not remain running."
}

function wait_for_ariadne_live() {
  local status_file="${BACKUP}/ariadne-live-status.json"
  local admin_token
  local attempt
  admin_token="$(security find-generic-password -a hive -s is.sokrates.hive.admin -w)"
  touch "$status_file"
  chmod 600 "$status_file"
  for attempt in {1..80}; do
    if print -r -- "header = \"Authorization: Bearer ${admin_token}\"" \
      | curl --config - --fail --silent --show-error --connect-timeout 1 --max-time 2 \
        --output "$status_file" \
        "http://127.0.0.1:8790/v1/admin/status?actor=ariadne&stale_after_ms=60000" \
        >/dev/null 2>&1 \
      && "$NODE" -e '
        const fs = require("node:fs");
        const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const actor = status.actors?.find((entry) => entry.subscription?.actor === "ariadne");
        const sub = actor?.subscription;
        const live = actor?.livePresence;
        const now = Date.now();
        const ok = status.slack?.ready === true
          && sub?.provider === "codex"
          && sub?.providerSurface === "codex-desktop-ipc"
          && sub?.providerVersion === "desktop-ipc-v1"
          && sub?.homeEdge === "mac"
          && typeof sub?.sessionId === "string" && sub.sessionId.length > 0
          && sub?.bindingMode === "auto"
          && sub?.bindingSource === "edge-discovery"
          && Number.isInteger(sub?.bindingRevision) && sub.bindingRevision > 0
          && live?.provider === sub.provider
          && live?.providerSurface === sub.providerSurface
          && live?.providerVersion === sub.providerVersion
          && live?.sessionId === sub.sessionId
          && live?.bindingRevision === sub.bindingRevision
          && live?.edgeId === "mac"
          && live?.transport === "desktop-ipc"
          && live?.ownerLoaded === true
          && Date.parse(live.updatedAt) >= now - 60_000
          && Date.parse(live.updatedAt) <= now + 5_000
          && Date.parse(live.expiresAt) >= now + 5_000;
        if (!ok) process.exit(1);
      ' "$status_file"; then
      admin_token=""
      return 0
    fi
    sleep 0.25
  done
  admin_token=""
  fail "Ariadne did not report an exact fresh auto-bound Desktop IPC presence through broker status."
}

function enable_ariadne_auto_binding() {
  local admin_token
  admin_token="$(security find-generic-password -a hive -s is.sokrates.hive.admin -w)"
  if ! print -r -- "header = \"Authorization: Bearer ${admin_token}\"" \
    | curl --config - --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      --request PATCH \
      --header 'content-type: application/json' \
      --data '{"mode":"auto"}' \
      "http://127.0.0.1:8790/v1/admin/subscriptions/ariadne/binding-mode" \
      >/dev/null; then
    admin_token=""
    fail "Hive could not enable Ariadne's restricted home-edge automatic binding mode."
  fi
  admin_token=""
}

function wait_for_file_release() {
  local path="$1"
  local label="$2"
  local attempt
  [[ -e "$path" ]] || return 0
  for attempt in {1..40}; do
    if ! lsof "$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  fail "${label} still has ${path} open after service shutdown."
}

function sqlite_has_column() {
  local database="$1"
  local table="$2"
  local column="$3"
  sqlite3 -batch -noheader "$database" \
    "SELECT 1 FROM pragma_table_info('${table}') WHERE name='${column}' LIMIT 1;" \
    | grep -qx 1
}

function sqlite_has_table() {
  local database="$1"
  local table="$2"
  sqlite3 -batch -noheader "$database" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table}' LIMIT 1;" \
    | grep -qx 1
}

function snapshot_ariadne_binding() {
  local database="${STATE_DIR}/broker.sqlite"
  local mode_select="hex('pinned')"
  local source_select="hex('provisioned')"
  local revision_select="1"
  sqlite_has_column "$database" subscriptions binding_mode \
    && mode_select="hex(binding_mode)"
  sqlite_has_column "$database" subscriptions binding_source \
    && source_select="hex(binding_source)"
  sqlite_has_column "$database" subscriptions binding_revision \
    && revision_select="binding_revision"

  sqlite3 -batch -noheader -separator '|' "$database" \
    "SELECT hex(provider), hex(provider_surface), hex(provider_version),
      session_id IS NULL, hex(session_id), ${mode_select}, ${source_select},
      ${revision_select}, hex(updated_at)
    FROM subscriptions WHERE actor='ariadne';" > "$ARIADNE_BINDING_SNAPSHOT"
  [[ -s "$ARIADNE_BINDING_SNAPSHOT" ]] \
    || fail "The stopped broker database has no Ariadne subscription to snapshot."
  "$NODE" -e '
    const fs = require("node:fs");
    const fields = fs.readFileSync(process.argv[1], "utf8").trimEnd().split("|");
    if (fields.length !== 9) process.exit(1);
    const [provider, surface, version, sessionNull, session, mode, source, revision, updated] = fields;
    const hex = (value, allowEmpty = false) => /^[0-9A-F]+$/.test(value)
      || (allowEmpty && value === "");
    if (!hex(provider) || !hex(surface) || !hex(version) || !hex(session, true)
      || !hex(mode) || !hex(source) || !hex(updated)
      || (sessionNull !== "0" && sessionNull !== "1")
      || !/^[1-9][0-9]*$/.test(revision)) process.exit(1);
  ' "$ARIADNE_BINDING_SNAPSHOT" \
    || fail "Ariadne's stopped binding snapshot is malformed."
  chmod 600 "$ARIADNE_BINDING_SNAPSHOT"
  ARIADNE_BINDING_SNAPSHOTTED=1
}

function restore_ariadne_binding() {
  (( ARIADNE_BINDING_SNAPSHOTTED == 1 )) || return 0
  local database="${STATE_DIR}/broker.sqlite"
  if [[ ! -f "$database" ]]; then
    fail "Cannot restore Ariadne: ${database} is missing."
    return 1
  fi
  wait_for_file_release "$database" "failed Hive broker" || return 1
  local provider_hex surface_hex version_hex session_null session_hex
  local mode_hex source_hex revision updated_hex session_sql assignments delete_presence=""
  IFS='|' read -r provider_hex surface_hex version_hex session_null session_hex \
    mode_hex source_hex revision updated_hex < "$ARIADNE_BINDING_SNAPSHOT"
  if ! "$NODE" -e '
    const values = process.argv.slice(1);
    const [provider, surface, version, sessionNull, session, mode, source, revision, updated] = values;
    const hex = (value, allowEmpty = false) => /^[0-9A-F]+$/.test(value)
      || (allowEmpty && value === "");
    if (values.length !== 9 || !hex(provider) || !hex(surface) || !hex(version)
      || !hex(session, true) || !hex(mode) || !hex(source) || !hex(updated)
      || (sessionNull !== "0" && sessionNull !== "1")
      || !/^[1-9][0-9]*$/.test(revision)) process.exit(1);
  ' "$provider_hex" "$surface_hex" "$version_hex" "$session_null" "$session_hex" \
    "$mode_hex" "$source_hex" "$revision" "$updated_hex"; then
    fail "Ariadne's pre-install binding snapshot failed validation during rollback."
    return 1
  fi
  session_sql="CAST(X'${session_hex}' AS TEXT)"
  [[ "$session_null" == 1 ]] && session_sql="NULL"
  assignments="provider=CAST(X'${provider_hex}' AS TEXT),
    provider_surface=CAST(X'${surface_hex}' AS TEXT),
    provider_version=CAST(X'${version_hex}' AS TEXT), session_id=${session_sql},
    updated_at=CAST(X'${updated_hex}' AS TEXT)"
  sqlite_has_column "$database" subscriptions binding_mode \
    && assignments+=", binding_mode=CAST(X'${mode_hex}' AS TEXT)"
  sqlite_has_column "$database" subscriptions binding_source \
    && assignments+=", binding_source=CAST(X'${source_hex}' AS TEXT)"
  sqlite_has_column "$database" subscriptions binding_revision \
    && assignments+=", binding_revision=${revision}"
  sqlite_has_table "$database" live_presence \
    && delete_presence="DELETE FROM live_presence WHERE actor='ariadne';"
  if ! sqlite3 -batch -bail "$database" "
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE hive_binding_restore_guard(ok INTEGER CHECK(ok = 1));
    UPDATE subscriptions SET ${assignments} WHERE actor='ariadne';
    INSERT INTO hive_binding_restore_guard VALUES(changes());
    ${delete_presence}
    DROP TABLE hive_binding_restore_guard;
    COMMIT;
  "; then
    fail "Could not restore Ariadne's pre-install binding authority."
    return 1
  fi
  if ! sqlite3 "$database" "PRAGMA quick_check;" | grep -qx ok; then
    fail "Broker database failed quick_check after Ariadne binding restoration."
    return 1
  fi
}

function secure_hive_files() {
  mkdir -p "$STATE_DIR" "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$LOG_DIR"
  local name
  for name in $LOG_FILES; do
    touch "${LOG_DIR}/${name}" || return 1
    chmod 600 "${LOG_DIR}/${name}"
  done
  find "$STATE_DIR" -maxdepth 1 -type f \
    \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) \
    -exec chmod 600 {} +
}

function bootstrap_previous_services() {
  local label plist
  for label in $START_LABELS; do
    [[ -f "${BACKUP}/loaded/${label}" ]] || continue
    plist="${AGENTS_DIR}/${label}.plist"
    if [[ ! -f "$plist" ]]; then
      print -u2 "Cannot restore ${label}: ${plist} is missing."
      continue
    fi
    if ! bootstrap_launchd "$label" "$plist"; then
      print -u2 "Failed to restore ${label}."
      continue
    fi
    case "$label" in
      is.sokrates.hive-broker)
        wait_for_health "http://127.0.0.1:8790/health" "restored Hive broker" \
          || print -u2 "Restored Hive broker is not healthy."
        ;;
      is.sokrates.hive-edge)
        wait_for_health "http://127.0.0.1:8791/health" "restored Hive edge" \
          || print -u2 "Restored Hive edge is not healthy."
        ;;
    esac
  done
}

function rollback() {
  local exit_code="$1"
  (( COMMITTED == 0 )) || return 0
  (( ROLLING_BACK == 0 )) || return 0
  ROLLING_BACK=1
  (( exit_code != 0 )) || exit_code=1
  trap - ZERR INT TERM HUP
  set +e

  print -u2 "Hive install failed; restoring the previous deployment from ${BACKUP}."
  local label plist binding_restore_ok=1 services_unloaded_ok=1
  for label in $STOP_LABELS; do
    if ! unload_if_loaded "$label" >/dev/null 2>&1; then
      services_unloaded_ok=0
      print -u2 "${label} did not unload; prior services will remain stopped."
    fi
  done

  if ! restore_ariadne_binding; then
    binding_restore_ok=0
    print -u2 "Ariadne binding restoration failed; prior services will remain stopped."
  fi

  if [[ "$SWAP_PHASE" != "untouched" ]]; then
    if [[ -e "${BACKUP}/runtime" ]]; then
      if [[ -e "$RUNTIME" ]]; then
        mv "$RUNTIME" "${BACKUP}/failed-runtime"
      fi
      mv "${BACKUP}/runtime" "$RUNTIME"
    elif (( HAD_RUNTIME == 0 )) && [[ -e "$RUNTIME" ]]; then
      # A failed first install has no prior runtime to restore; retain the new one for diagnosis.
      mv "$RUNTIME" "${BACKUP}/failed-runtime"
    fi
  fi

  for plist in $PLISTS; do
    if [[ -f "${BACKUP}/launchagents/${plist}" ]]; then
      cp -p "${BACKUP}/launchagents/${plist}" "${AGENTS_DIR}/${plist}"
      chmod 600 "${AGENTS_DIR}/${plist}"
    else
      rm -f "${AGENTS_DIR}/${plist}"
    fi
  done

  rm -f "$HIVE_BIN"
  if [[ -e "${BACKUP}/bin/hive" || -L "${BACKUP}/bin/hive" ]]; then
    cp -Pp "${BACKUP}/bin/hive" "$HIVE_BIN"
  fi

  secure_hive_files || true
  if (( binding_restore_ok == 1 && services_unloaded_ok == 1 )); then
    bootstrap_previous_services
  else
    print -u2 "Inspect ${ARIADNE_BINDING_SNAPSHOT} and launchd state before bootstrapping Hive."
  fi
  print -u2 "Rollback attempted. Failed runtime: ${BACKUP}/failed-runtime"
  print -u2 "Stopped-state database backups: ${BACKUP}/data"
  print -u2 "If a prior service is still down, inspect ${BACKUP}/launchagents and bootstrap it manually."
  exit "$exit_code"
}

for command_name in pnpm rsync shasum sqlite3 launchctl plutil curl security grep lsof; do
  require_command "$command_name"
done
require_node_22
export PATH="${NODE:h}:${PATH}"

[[ ! -e "$STAGE" && ! -e "$BACKUP" ]] || fail "Hive staging path already exists for ${STAMP}."
mkdir -p "$STAGE" "$BACKUP" "$BACKUP/launchagents" "$BACKUP/data" \
  "$BACKUP/loaded" "$BACKUP/bin" "$PREPARED_PLISTS"
chmod 700 "$STAGE" "$BACKUP" "$BACKUP/launchagents" "$BACKUP/data" \
  "$BACKUP/loaded" "$BACKUP/bin" "$PREPARED_PLISTS"

# Capture an explicit source allowlist first. Verify that the source did not drift while copied.
source_manifest "$ROOT" "$PRE_MANIFEST"
copy_source_snapshot
assert_no_forbidden_snapshot_files
source_manifest "$ROOT" "$POST_MANIFEST"
cmp -s "$PRE_MANIFEST" "$POST_MANIFEST" \
  || fail "Hive source changed while the immutable deployment snapshot was being captured; retry."
source_manifest "$STAGE" "${STAGE}/.hive-source-manifest"
cmp -s "$PRE_MANIFEST" "${STAGE}/.hive-source-manifest" \
  || fail "Hive staged source does not match the captured source manifest."

# Install, gate, and build only inside the frozen snapshot, never in the working tree.
(
  cd "$STAGE"
  pnpm install --frozen-lockfile
  [[ -d node_modules && -d node_modules/.pnpm ]] || fail "Staged node_modules is incomplete."
  "$NODE" -e 'require("better-sqlite3")'
  pnpm check
  pnpm build
)
source_manifest "$STAGE" "${STAGE}/.hive-source-manifest.after"
cmp -s "${STAGE}/.hive-source-manifest" "${STAGE}/.hive-source-manifest.after" \
  || fail "Hive staged source changed while gates ran."
rm -f "${STAGE}/.hive-source-manifest.after"
"$NODE" "${STAGE}/dist/cli.js" --help >/dev/null
zsh -n "${STAGE}/deploy/launchd/"*.zsh "${STAGE}/deploy/install-macos.zsh" \
  "${STAGE}/deploy/push-linux-edge.zsh"
bash -n "${STAGE}/deploy/install-linux-edge.sh"

local_plist=""
for local_plist in $PLISTS; do
  materialize_plist_to \
    "${STAGE}/deploy/launchd/${local_plist}" \
    "${PREPARED_PLISTS}/${local_plist}"
done

# All credentials and local configuration are proved before any running service is touched.
require_keychain_secret hive is.sokrates.hive.admin token
require_keychain_secret hive is.sokrates.hive.slack-app xapp
require_keychain_secret hive is.sokrates.hive.slack-bot xoxb
require_keychain_secret mac is.sokrates.hive.edge-token token
require_keychain_secret mac is.sokrates.hive.local-token token
grep -q '"routerMentionIds":\["U0BGBUGGJ1H"\]' \
  "${STAGE}/deploy/launchd/run-broker.zsh" \
  || fail "The staged broker admission policy is missing the shared Hive router mention."

mkdir -p "$BIN_DIR" "$AGENTS_DIR" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR" "$LOG_DIR"
for local_plist in $PLISTS; do
  if [[ -f "${AGENTS_DIR}/${local_plist}" ]]; then
    cp -p "${AGENTS_DIR}/${local_plist}" "${BACKUP}/launchagents/${local_plist}"
  fi
done
if [[ -e "$HIVE_BIN" || -L "$HIVE_BIN" ]]; then
  cp -Pp "$HIVE_BIN" "${BACKUP}/bin/hive"
fi
local_label=""
for local_label in $STOP_LABELS; do
  if is_loaded "$local_label"; then
    : > "${BACKUP}/loaded/${local_label}"
  fi
done
if [[ -e "$RUNTIME" ]]; then
  HAD_RUNTIME=1
fi

# From this point every failure rolls the runtime, launch agents, command shim, and service state back.
trap 'rollback $?' ZERR
trap 'rollback 130' INT
trap 'rollback 143' TERM HUP

for local_label in $STOP_LABELS; do
  unload_if_loaded "$local_label"
done

# Back up SQLite only after broker and edge have released their WALs.
if [[ -f "${STATE_DIR}/broker.sqlite" ]]; then
  wait_for_file_release "${STATE_DIR}/broker.sqlite" "Hive broker"
  sqlite3 "${STATE_DIR}/broker.sqlite" "PRAGMA quick_check;" | grep -qx ok
  snapshot_ariadne_binding
  sqlite3 "${STATE_DIR}/broker.sqlite" ".backup '${BACKUP}/data/broker.sqlite'"
  chmod 600 "${BACKUP}/data/broker.sqlite"
fi
if [[ -f "${STATE_DIR}/edge.sqlite" ]]; then
  wait_for_file_release "${STATE_DIR}/edge.sqlite" "Hive edge"
  sqlite3 "${STATE_DIR}/edge.sqlite" "PRAGMA quick_check;" | grep -qx ok
  sqlite3 "${STATE_DIR}/edge.sqlite" ".backup '${BACKUP}/data/edge.sqlite'"
  chmod 600 "${BACKUP}/data/edge.sqlite"
fi

SWAP_PHASE="starting"
if (( HAD_RUNTIME == 1 )); then
  mv "$RUNTIME" "${BACKUP}/runtime"
fi
SWAP_PHASE="old-runtime-secured"
mv "$STAGE" "$RUNTIME"
SWAP_PHASE="new-runtime-installed"
find "$RUNTIME" -type d -exec chmod 700 {} +
chmod 700 \
  "${RUNTIME}/deploy/launchd/run-broker.zsh" \
  "${RUNTIME}/deploy/launchd/run-edge.zsh" \
  "${RUNTIME}/deploy/launchd/run-operator.zsh" \
  "${RUNTIME}/deploy/launchd/run-codex-supervisor.zsh"

for local_plist in $PLISTS; do
  install -m 600 "${PREPARED_PLISTS}/${local_plist}" "${AGENTS_DIR}/${local_plist}"
done
ln -sfn "${RUNTIME}/deploy/launchd/run-operator.zsh" "$HIVE_BIN"
secure_hive_files

bootstrap_launchd is.sokrates.hive-broker \
  "${AGENTS_DIR}/is.sokrates.hive-broker.plist"
wait_for_health "http://127.0.0.1:8790/health" "Hive broker"
bootstrap_launchd is.sokrates.hive-edge \
  "${AGENTS_DIR}/is.sokrates.hive-edge.plist"
wait_for_health "http://127.0.0.1:8791/health" "Hive edge"
enable_ariadne_auto_binding
bootstrap_launchd is.sokrates.hive-codex-supervisor \
  "${AGENTS_DIR}/is.sokrates.hive-codex-supervisor.plist"
wait_for_launchd is.sokrates.hive-codex-supervisor
wait_for_ariadne_live

COMMITTED=1
trap - ZERR INT TERM HUP
print "Hive installed from an immutable gated snapshot. Rollback snapshot: ${BACKUP}"
print "Next: hive status ariadne"
