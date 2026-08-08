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
    && rm -rf /var/lib/apt/lists/*

# Tailscale (static build) — tailscaled runs userspace-networking in the pod.
ARG TAILSCALE_VERSION=1.86.2
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
      | tar -xz -C /tmp \
    && mv /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale /usr/local/bin/ \
    && mv /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled /usr/local/bin/ \
    && rm -rf /tmp/tailscale_${TAILSCALE_VERSION}_amd64

# uv — the seat does Sovereign python work in /workspace checkouts.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# runpodctl — the seat spawns sibling GPU pods (vLLM / TensorRT-LLM / diffusion).
RUN curl -fsSL https://github.com/runpod/runpodctl/releases/latest/download/runpodctl-linux-amd64 \
      -o /usr/local/bin/runpodctl && chmod +x /usr/local/bin/runpodctl

# Claude Code — version is pinned by image rebuild, not self-update.
RUN npm install -g @anthropic-ai/claude-code
ENV DISABLE_AUTOUPDATER=1

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
