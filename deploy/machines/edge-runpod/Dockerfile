# Hive seat-pod image for the runpod edge (claude-3).
# Toolchain only — all durable state lives on the /workspace network volume.
# Built in CI, pushed to ghcr.io/skrates/hive-edge-runpod. RunPod pods cannot
# build images (no docker daemon inside a pod), so this is the only build path.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts/ scripts/
COPY src/ src/
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client \
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

# The hive edge, baked immutable. /workspace/hive stays free for dev checkouts.
WORKDIR /opt/hive
COPY --from=build /app/dist dist/
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json ./
RUN ln -s /opt/hive/dist/cli.js /usr/local/bin/hive-cli

COPY deploy/machines/edge-runpod/start-edge.sh /usr/local/bin/start-edge.sh
RUN chmod +x /usr/local/bin/start-edge.sh

ENTRYPOINT ["/usr/local/bin/start-edge.sh"]
