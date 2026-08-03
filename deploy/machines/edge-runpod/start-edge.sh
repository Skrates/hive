#!/usr/bin/env bash
# RunPod pod-boot entry for the Hive edge. Everything durable lives on /workspace.
set -euo pipefail

export HIVE_HOME=/workspace/.hive
mkdir -p "$HIVE_HOME"
chmod 700 "$HIVE_HOME"

# Edge identity + broker route (tailnet). Never bake tokens into the image.
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

cd /workspace/hive
exec node dist/cli.js edge
