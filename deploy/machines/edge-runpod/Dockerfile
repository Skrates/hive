# Hive seat-pod image for the runpod edge (claude-3).
# Toolchain only — all durable state lives on the /workspace network volume.
# Built in CI, pushed to ghcr.io/skrates/hive-edge-runpod. RunPod pods cannot
# build images (no docker daemon inside a pod), so this is the only build path.

# Build on the SAME Debian release as the runtime stage: better-sqlite3 compiles
# from source here (prebuild-install skips bun runtimes) and must link the
# runtime's glibc. The bun binary rides in from the official image.
FROM node:22-bookworm-slim AS build
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts/ scripts/
COPY src/ src/
RUN bun run build \
    && rm -rf node_modules \
    && bun install --frozen-lockfile --production

FROM node:22-bookworm-slim
# openssh-server serves provisioning mode only (see start-edge.sh): a custom
# image gets neither RunPod's web terminal nor their SSH, so an unseeded pod
# would otherwise be unreachable.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client openssh-server \
      # seat toolchain (Talos cold-inventory, 2026-08-09): burns, CI hardening,
      # native npm rebuilds, and pod-side debugging when the edge wedges.
      python3 patch ripgrep zip unzip build-essential pkg-config \
      shellcheck git-lfs sqlite3 rsync \
      less file xz-utils bzip2 zstd iproute2 iputils-ping dnsutils \
      lsof strace wget \
    && rm -rf /var/lib/apt/lists/*

# Tailscale (static build) — tailscaled runs userspace-networking in the pod.
ARG TAILSCALE_VERSION=1.86.2
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
      | tar -xz -C /tmp \
    && mv /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale /usr/local/bin/ \
    && mv /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled /usr/local/bin/ \
    && rm -rf /tmp/tailscale_${TAILSCALE_VERSION}_amd64

# GitHub CLI — the seat works PRs, reviews, and Actions runs; version is
# pinned by image rebuild, like everything else here.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv — the seat does Sovereign python work in /workspace checkouts.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# bun — the runtime stage never had it; only the build stage did. Seats build
# hive checkouts and bun-based repos on /workspace.
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun

# mise — the single version authority (weave-doctrine mise.toml is the ONE
# pin). The binary rides the image; per-repo tools (just, ruff, ty, prek, ...)
# resolve at runtime from each checkout's mise.toml on the volume.
RUN curl -fsSL https://mise.jdx.dev/mise-latest-linux-x64 -o /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise && mise --version

# yq — mikefarah single binary (the Debian package is a different tool).
RUN curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# Graphite CLI — stacked-PR burns and restacks.
RUN npm install -g @withgraphite/graphite-cli@stable

# pnpm — corepack is present but pnpm itself is not; many monorepos assume it.
RUN npm install -g pnpm

# runpodctl — the seat spawns sibling GPU pods (vLLM / TensorRT-LLM / diffusion).
RUN curl -fsSL https://github.com/runpod/runpodctl/releases/latest/download/runpodctl-linux-amd64 \
      -o /usr/local/bin/runpodctl && chmod +x /usr/local/bin/runpodctl

# Claude Code — version is pinned by image rebuild, not self-update.
RUN npm install -g @anthropic-ai/claude-code
ENV DISABLE_AUTOUPDATER=1

# libuv's default threadpool is 4 — exactly MAX_CONCURRENT_DISPATCHES. The
# claim-time attestation read runs on that pool, and this is THE deployment the
# guard exists for: the seat's HOME is /workspace/.hive/profiles/talos, and
# /workspace is RunPod's network-backed volume. A stalled mount parks each read
# on a libuv thread that no timeout can reclaim; the 2s bound frees the delivery
# and its dispatch slot, so the edge keeps claiming and keeps issuing reads
# until the whole pool is permanently blocked and every later threadpool job
# (further reads, all fs/promises work, dns.lookup for a broker reconnect)
# queues behind it. Sized above the dispatch cap so that stall stays loud and
# bounded instead of silently exhausting the pool. Set here as well as in
# start-edge.sh: this covers a hand-run container, the script covers a
# non-Docker run from /workspace/hive.
ENV UV_THREADPOOL_SIZE=16

# Grok Build — Talos's harness: xAI's agentic CLI, spawned by the edge's grok
# provider adapter with HOME pinned to the account profile (Grok Build keeps
# auth + config under ~/.grok and has no config-dir override). Subscription
# login artifact lives on the volume, never in the image. The install script
# has no version pin; the image rebuild IS the pin.
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
    && { command -v grok >/dev/null || ln -s /root/.local/bin/grok /usr/local/bin/grok; } \
    && grok --version

# The hive edge, baked immutable. /workspace/hive stays free for dev checkouts.
WORKDIR /opt/hive
COPY --from=build /app/dist dist/
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json ./
RUN ln -s /opt/hive/dist/cli.js /usr/local/bin/hive-cli

COPY deploy/machines/edge-runpod/start-edge.sh /usr/local/bin/start-edge.sh
RUN chmod +x /usr/local/bin/start-edge.sh

ENTRYPOINT ["/usr/local/bin/start-edge.sh"]
