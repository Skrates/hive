#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "usage: install-linux-edge.sh STAGED_RUNTIME" >&2
  exit 2
fi

stage="${1%/}"
runtime="${HOME}/.local/lib/hive"
config_dir="${HOME}/.config/hive"
config="${config_dir}/edge.env"
unit_dir="${HOME}/.config/systemd/user"
unit="${unit_dir}/hive-edge.service"
service="hive-edge.service"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${HOME}/.local/lib/hive.rollback-${stamp}"
manifest="${stage}/.hive-source-manifest"
node_path=""
claude_path=""
claude_version=""
service_path=""
build_path=""
prepared_unit=""
committed=0
swap_phase="untouched"
had_runtime=0
was_active=0
was_enabled=0
had_unit=0

fail() {
  echo "$1" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Hive edge install requires $1."
}

require_node_22() {
  [[ "$node_path" == /* && -x "$node_path" ]] \
    || fail "Hive requires an executable Node.js at an absolute path."
  [[ "$node_path" =~ ^/[A-Za-z0-9._/+-]+$ ]] \
    || fail "Hive Node.js path contains characters that cannot be pinned safely in systemd."
  "$node_path" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
    || fail "Hive requires Node.js 22 or newer."
}

require_secure_broker_transport() {
  "$node_path" -e '
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
  ' "$HIVE_BROKER_URL" \
    || fail "HIVE_BROKER_URL must be credential-free HTTPS or loopback HTTP through a local tunnel."
}

require_secret_config() {
  [[ -f "$config" && -r "$config" ]] || fail "Hive edge environment is missing: ${config}"
  local mode
  mode="$(stat -c '%a' "$config")"
  (( (8#${mode} & 077) == 0 )) || fail "Hive edge environment must not be group/world accessible."
	! grep -Eq '^[[:space:]]*(export[[:space:]]+)?PATH=' "$config" \
    || fail "Hive edge environment must not override the installer-controlled service PATH."

  set -a
  # shellcheck disable=SC1090
  source "$config"
  set +a

  [[ -n "${HIVE_BROKER_URL:-}" ]] || fail "HIVE_BROKER_URL is missing."
  [[ "${HIVE_EDGE_ID:-}" == "fable-linux" ]] \
    || fail "HIVE_EDGE_ID must be fable-linux for this edge deployment."
  local edge_token="${HIVE_EDGE_TOKEN:-}"
  local local_token="${HIVE_EDGE_LOCAL_TOKEN:-}"
  [[ "$edge_token" =~ ^[A-Za-z0-9_-]{32,}$ ]] \
    || fail "HIVE_EDGE_TOKEN is missing or malformed."
  [[ "$local_token" =~ ^[A-Za-z0-9_-]{32,}$ ]] \
    || fail "HIVE_EDGE_LOCAL_TOKEN is missing or malformed."
  edge_token=""
  local_token=""
  [[ "${HIVE_EDGE_DB:-}" == /* ]] || fail "HIVE_EDGE_DB must be an absolute path."
  [[ "${HIVE_EDGE_PORT:-8791}" =~ ^[0-9]+$ ]] \
    || fail "HIVE_EDGE_PORT must be numeric."
  node_path="${HIVE_NODE_COMMAND:-}"
  claude_path="${HIVE_CLAUDE_COMMAND:-}"
  claude_version="${HIVE_CLAUDE_VERSION:-}"
  [[ "$node_path" == /* && -x "$node_path" ]] \
    || fail "HIVE_NODE_COMMAND must name an absolute executable."
  [[ "$node_path" =~ ^/[A-Za-z0-9._/+-]+$ ]] \
    || fail "HIVE_NODE_COMMAND cannot be pinned safely in systemd."
  [[ "$claude_path" == /* && -x "$claude_path" ]] \
    || fail "HIVE_CLAUDE_COMMAND must name an absolute executable."
  [[ "$claude_path" =~ ^/[A-Za-z0-9._/+-]+$ ]] \
    || fail "HIVE_CLAUDE_COMMAND cannot be pinned safely in systemd."
  [[ "$claude_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "HIVE_CLAUDE_VERSION must pin one exact semantic version."
  service_path="${node_path%/*}:${claude_path%/*}:/usr/local/bin:/usr/bin:/bin"
  build_path="${node_path%/*}:${HOME}/.local/share/pnpm:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
  export PATH="$build_path"
  require_secure_broker_transport
}

preflight_claude_cli() {
  local reported_version
  reported_version="$(PATH="$service_path" "$node_path" -e '
    const { spawnSync } = require("node:child_process");
    const command = process.argv[1];
    const expected = process.argv[2];
    const allowed = new Set([
      "HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "LANG", "TERM", "COLORTERM",
      "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
      "XDG_CACHE_HOME", "XDG_CONFIG_DIRS", "XDG_CONFIG_HOME", "XDG_DATA_DIRS", "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
    ]);
    const childEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name))),
      DISABLE_AUTOUPDATER: "1",
    };
    const run = (args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env: childEnv,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) process.exit(1);
      return `${result.stdout}${result.stderr}`.trim();
    };
    const versionOutput = run(["--version"]);
    const match = /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec(versionOutput);
    if (!match || match[1] !== expected) process.exit(1);
    const help = run(["--help"]);
    for (const capability of [
      "--print", "--resume", "--output-format", "--permission-mode", "stream-json",
      "--setting-sources", "--strict-mcp-config",
    ]) {
      if (!help.includes(capability)) process.exit(1);
    }
    const auth = JSON.parse(run([
      "--setting-sources", "", "--strict-mcp-config", "auth", "status", "--json",
    ]));
    if (auth.loggedIn !== true) process.exit(1);
    process.stdout.write(match[1]);
  ' "$claude_path" "$claude_version")" \
    || fail "Pinned Claude CLI version/capability preflight failed."
  [[ "$reported_version" == "$claude_version" ]] \
    || fail "Pinned Claude CLI does not match version ${claude_version}."
}

preflight_fable_binding() {
  local binding_file="${backup}/fable-binding.json"
  local binding_cwd
  touch "$binding_file"
  chmod 600 "$binding_file"
  if ! printf 'header = "Authorization: Bearer %s"\nheader = "x-hive-edge: %s"\n' \
      "$HIVE_EDGE_TOKEN" "$HIVE_EDGE_ID" \
    | curl --config - --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      --output "$binding_file" \
      "${HIVE_BROKER_URL%/}/v1/subscriptions/fable/auto-binding"; then
    fail "Fable's authenticated broker binding preflight failed."
    return 1
  fi
  binding_cwd="$("$node_path" -e '
    const fs = require("node:fs");
    const binding = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expectedVersion = process.argv[2];
    const expectedEdge = process.argv[3];
    const ok = binding.actor === "fable"
      && binding.provider === "claude"
      && binding.providerSurface === "headless-exec"
      && binding.providerVersion === expectedVersion
      && binding.homeEdge === expectedEdge
      && binding.workspace === "hive"
      && binding.wakePolicy === "spawn"
      && binding.permissionProfile === "workspace-write"
      && typeof binding.edgeCwd === "string"
      && binding.edgeCwd.startsWith("/");
    if (!ok) process.exit(1);
    process.stdout.write(binding.edgeCwd);
  ' "$binding_file" "$claude_version" "$HIVE_EDGE_ID")" \
    || fail "Fable's broker subscription does not match the pinned Linux Claude runtime."
  [[ -d "$binding_cwd" ]] \
    || fail "Fable's mapped workspace is missing on Linux: ${binding_cwd}"
  rm -f "$binding_file"
}

wait_for_health() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 80); do
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
      "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  fail "Hive edge did not become healthy at ${url}."
}

wait_for_stopped() {
  local attempt
  for attempt in $(seq 1 40); do
    if ! systemctl --user is-active --quiet "$service"; then
      return 0
    fi
    sleep 0.25
  done
  fail "Hive edge did not stop cleanly."
}

secure_state() {
  local state_dir
  state_dir="$(dirname "$HIVE_EDGE_DB")"
  mkdir -p "$state_dir" "$config_dir"
  chmod 700 "$state_dir" "$config_dir"
  chmod 600 "$config"
  find "$state_dir" -maxdepth 1 -type f \
    \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o -name '*.log' \) \
    -exec chmod 600 {} +
}

restore_service_state() {
  if [[ "$was_enabled" -eq 1 ]]; then
    systemctl --user enable "$service" >/dev/null 2>&1 || return 1
  else
    systemctl --user disable "$service" >/dev/null 2>&1 || true
  fi
  if [[ "$was_active" -eq 1 ]]; then
    systemctl --user start "$service" || return 1
    wait_for_health "http://127.0.0.1:${HIVE_EDGE_PORT:-8791}/health" || return 1
  fi
}

rollback() {
  local status="$1"
  [[ "$committed" -eq 0 ]] || return 0
  [[ "$status" -ne 0 ]] || status=1
  trap - EXIT INT TERM HUP
  set +e

  echo "Hive edge install failed; restoring the previous deployment from ${backup}." >&2
  systemctl --user stop "$service" >/dev/null 2>&1 || true

  if [[ "$swap_phase" != "untouched" ]]; then
    if [[ -e "${backup}/runtime" ]]; then
      if [[ -e "$runtime" ]]; then
        mv "$runtime" "${backup}/failed-runtime"
      fi
      mv "${backup}/runtime" "$runtime"
    elif [[ "$had_runtime" -eq 0 && -e "$runtime" ]]; then
      mv "$runtime" "${backup}/failed-runtime"
    fi
  fi

  if [[ "$had_unit" -eq 1 && -f "${backup}/hive-edge.service" ]]; then
    install -m 0600 "${backup}/hive-edge.service" "$unit"
  else
    rm -f "$unit"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  secure_state || true
  restore_service_state || echo "The prior Hive edge service needs manual recovery." >&2

  echo "Rollback attempted. Failed runtime: ${backup}/failed-runtime" >&2
  echo "Stopped-state database backup: ${backup}/data" >&2
  echo "Manual recovery assets: ${backup}" >&2
  exit "$status"
}

for command_name in curl systemctl sqlite3 sha256sum stat seq grep sed; do
  require_command "$command_name"
done

[[ "$stage" != "$runtime" ]] || fail "The staged runtime must not be the live runtime."
[[ -d "$stage" && -f "$stage/dist/cli.js" && -f "$stage/pnpm-lock.yaml" ]] \
  || fail "Staged Hive runtime is incomplete."
[[ -f "$manifest" ]] || fail "Staged Hive runtime has no immutable source manifest."
[[ ! -e "$backup" ]] || fail "Rollback directory already exists: ${backup}"
forbidden="$(find "$stage" -path "$stage/node_modules" -prune -o \
  \( -name '.git' -o -name '.env' -o -name '.env.*' -o -name '.npmrc' -o -name coverage \) \
  -print -quit)"
[[ -z "$forbidden" ]] || fail "Forbidden deployment input entered the Linux stage: ${forbidden}"
require_secret_config
require_node_22
require_command pnpm
preflight_claude_cli

# Verify and gate the exact received snapshot before stopping the service.
(
  cd "$stage"
  sha256sum --check --status .hive-source-manifest
  pnpm install --frozen-lockfile
  [[ -d node_modules && -d node_modules/.pnpm ]] || fail "Staged Linux node_modules is incomplete."
  "$node_path" -e 'require("better-sqlite3")'
  pnpm check
  pnpm build
  sha256sum --check --status .hive-source-manifest
  "$node_path" dist/cli.js --help >/dev/null
  bash -n deploy/install-linux-edge.sh
)

mkdir -p "$backup" "$backup/data" "$unit_dir"
chmod 700 "$backup" "$backup/data"
secure_state

# Materialize the unit before any stop so systemd uses the exact Node 22 executable gated above.
prepared_unit="${backup}/hive-edge.service.new"
sed -e "s|__HIVE_NODE__|${node_path}|g" \
  -e "s|__HIVE_SERVICE_PATH__|${service_path}|g" \
  "$stage/deploy/systemd/hive-edge.service" > "$prepared_unit"
chmod 600 "$prepared_unit"
grep -Fqx "ExecStart=${node_path} %h/.local/lib/hive/dist/cli.js edge" "$prepared_unit" \
  || fail "Hive edge systemd unit did not pin the validated Node.js executable."
grep -Fqx "Environment=\"PATH=${service_path}\"" "$prepared_unit" \
  || fail "Hive edge systemd unit did not pin the validated service PATH."
grep -Fqx 'Environment="DISABLE_AUTOUPDATER=1"' "$prepared_unit" \
  || fail "Hive edge systemd unit did not disable Claude auto-updates."
! grep -Eq '__HIVE_(NODE|SERVICE_PATH)__' "$prepared_unit" \
  || fail "Hive edge systemd unit still contains an unresolved runtime placeholder."

# Authenticate as the configured edge and prove Fable's exact authority/workspace before stopping.
preflight_fable_binding
unset HIVE_EDGE_TOKEN HIVE_EDGE_LOCAL_TOKEN

if [[ -f "$unit" ]]; then
  had_unit=1
  cp -p "$unit" "${backup}/hive-edge.service"
  chmod 600 "${backup}/hive-edge.service"
fi
if systemctl --user is-active --quiet "$service"; then
  was_active=1
fi
if systemctl --user is-enabled --quiet "$service"; then
  was_enabled=1
fi
if [[ -e "$runtime" ]]; then
  had_runtime=1
fi

# Every failure after this point restores runtime, unit presence, enablement, and active state.
trap 'rollback $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [[ "$had_unit" -eq 1 || "$was_active" -eq 1 ]]; then
  systemctl --user stop "$service"
else
  systemctl --user stop "$service" >/dev/null 2>&1 || true
fi
wait_for_stopped

# The stopped service has released SQLite and its WAL before this backup is taken.
if [[ -f "$HIVE_EDGE_DB" ]]; then
  sqlite3 "$HIVE_EDGE_DB" "PRAGMA quick_check;" | grep -qx ok
  sqlite3 "$HIVE_EDGE_DB" ".backup '${backup}/data/edge.sqlite'"
  chmod 600 "${backup}/data/edge.sqlite"
fi

swap_phase="starting"
if [[ "$had_runtime" -eq 1 ]]; then
  mv "$runtime" "${backup}/runtime"
fi
swap_phase="old-runtime-secured"
mv "$stage" "$runtime"
swap_phase="new-runtime-installed"
find "$runtime" -type d -exec chmod 700 {} +
chmod 700 "$runtime/deploy/install-linux-edge.sh"

install -m 0600 "$prepared_unit" "$unit"
systemctl --user daemon-reload
systemctl --user enable --now "$service"
wait_for_health "http://127.0.0.1:${HIVE_EDGE_PORT:-8791}/health"
secure_state

committed=1
trap - EXIT INT TERM HUP
echo "Hive edge installed from an immutable gated snapshot. Rollback snapshot: ${backup}"
