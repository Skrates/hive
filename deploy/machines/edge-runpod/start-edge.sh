#!/usr/bin/env bash
# RunPod pod-boot entry for the Hive edge. Everything durable lives on /workspace.
# Runs as the baked-image ENTRYPOINT (hive at /opt/hive); falls back to a
# /workspace/hive checkout when booted from a stock RunPod image instead.
set -euo pipefail

export HIVE_HOME=/workspace/.hive
mkdir -p "$HIVE_HOME"
chmod 700 "$HIVE_HOME"

# Reachability on every boot, not just provisioning: a custom image gets
# neither RunPod's web terminal nor their SSH (both require a terminal server
# the official templates bundle), so the pod runs its own sshd keyed by the
# PUBLIC_KEY env RunPod injects. Key-gated root over the mapped :22 is the
# seat's maintenance door; without it a wedged edge is a dark pod.
if [[ -n "${PUBLIC_KEY:-}" ]]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  printf '%s\n' "$PUBLIC_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  mkdir -p /run/sshd
  ssh-keygen -A
  /usr/sbin/sshd -e
fi

# Edge identity + broker route (tailnet). Never bake tokens into the image.
# First boot on an unseeded volume is a legitimate state, not a crash: idle
# loudly and reachably so the operator can seed and restart.
if [[ ! -f "$HIVE_HOME/edge.env" ]]; then
  echo "PROVISIONING MODE: $HIVE_HOME/edge.env not found — idling for seeding (tailscale, profile, credentials). Restart the pod once seeded." >&2
  [[ -n "${PUBLIC_KEY:-}" ]] || echo "PROVISIONING MODE: no PUBLIC_KEY env — unreachable idle; set it on the pod and restart." >&2
  exec sleep infinity
fi
set -a
source "$HIVE_HOME/edge.env"
set +a

# Tailnet with durable state so resize cycles keep the node identity. A pod has
# no TUN, so tailscaled runs userspace: tailnet addresses are reachable only
# through its proxy listeners — the edge dials the broker via the HTTP CONNECT
# listener (HIVE_BROKER_PROXY in edge.env, undici ProxyAgent in the edge).
# --ssh gives tailnet-ACL'd shell access as the second maintenance door.
if command -v tailscaled >/dev/null 2>&1; then
  mkdir -p "$HIVE_HOME/tailscale"
  tailscaled --statedir="$HIVE_HOME/tailscale" --tun=userspace-networking \
    --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056 \
    >/var/log/tailscaled.log 2>&1 &
  tailscale up --ssh --authkey="${TAILSCALE_AUTHKEY:?set in edge.env}" --hostname=hive-runpod || true
fi

# libuv's default threadpool is 4 — exactly MAX_CONCURRENT_DISPATCHES. The
# claim-time attestation read runs on that pool, and this seat's HOME is on
# /workspace, RunPod's network-backed volume: a stalled mount parks each read on
# a libuv thread no timeout can reclaim, and the 2s bound frees the dispatch
# slot so the edge keeps claiming and keeps issuing them. Unsized, the pool ends
# up permanently blocked and every later threadpool job queues behind it. Set
# before both execs so a non-Docker run gets it too; the image ENV covers the
# container.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

if [[ -f /opt/hive/dist/cli.js ]]; then
  exec node /opt/hive/dist/cli.js edge
fi
cd /workspace/hive
exec node dist/cli.js edge
