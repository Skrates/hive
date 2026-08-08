#!/usr/bin/env bash
# RunPod pod-boot entry for the Hive edge. Everything durable lives on /workspace.
# Runs as the baked-image ENTRYPOINT (hive at /opt/hive); falls back to a
# /workspace/hive checkout when booted from a stock RunPod image instead.
set -euo pipefail

export HIVE_HOME=/workspace/.hive
mkdir -p "$HIVE_HOME"
chmod 700 "$HIVE_HOME"

# Edge identity + broker route (tailnet). Never bake tokens into the image.
# First boot on an unseeded volume is a legitimate state, not a crash: idle
# loudly and reachably. A custom image gets neither RunPod's web terminal nor
# their SSH (both require a terminal server the official templates bundle), so
# provisioning mode starts its own sshd keyed by the PUBLIC_KEY env RunPod
# injects — the standard custom-image access pattern. No key, still idle: the
# operator can fix the pod's env and restart rather than face a crash-loop.
if [[ ! -f "$HIVE_HOME/edge.env" ]]; then
  echo "PROVISIONING MODE: $HIVE_HOME/edge.env not found — idling for seeding (tailscale, profile, credentials). Restart the pod once seeded." >&2
  if [[ -n "${PUBLIC_KEY:-}" ]]; then
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    printf '%s\n' "$PUBLIC_KEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    mkdir -p /run/sshd
    ssh-keygen -A
    /usr/sbin/sshd -e
    echo "PROVISIONING MODE: sshd up on :22 for the injected PUBLIC_KEY." >&2
  else
    echo "PROVISIONING MODE: no PUBLIC_KEY env — unreachable idle; set it on the pod and restart." >&2
  fi
  exec sleep infinity
fi
set -a
source "$HIVE_HOME/edge.env"
set +a

# Tailnet with durable state so resize cycles keep the node identity.
if command -v tailscaled >/dev/null 2>&1; then
  mkdir -p "$HIVE_HOME/tailscale"
  tailscaled --statedir="$HIVE_HOME/tailscale" --tun=userspace-networking \
    --socks5-server=localhost:1055 >/var/log/tailscaled.log 2>&1 &
  tailscale up --authkey="${TAILSCALE_AUTHKEY:?set in edge.env}" --hostname=hive-runpod || true
fi

if [[ -f /opt/hive/dist/cli.js ]]; then
  exec node /opt/hive/dist/cli.js edge
fi
cd /workspace/hive
exec node dist/cli.js edge
