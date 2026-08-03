# Edge: runpod — seat claude-3 (Claude Team, hakon@sokrates.is)

The hive's actuator: primarily Sovereign development and local-model testing for the capability
registry, occasionally the diffusion pipeline (LoRA training). The seat rides a cheap always-on
CPU pod and spawns ephemeral sibling GPU pods per job; the edge must survive stop/resize/start
cycles.

## Region + volume (created 2026-08-03)

- Datacenter: **EUR-IS-1** (network-volume capable; Blackwell inventory: RTX PRO 6000/WK, 4090,
  5090, B300, H100 NVL — A100/Ada excluded by policy).
- Network volume: **`hive-claude3-workspace`** (id `w65u1o4qbn`, 100 GB, grow-in-place only).
- The volume is a **cache**, not the source of truth: models sync from external S3/GCS/HF
  (`HF_HOME=/workspace/models/hf`, `hf_transfer` for cold pulls). RunPod's S3-compatible API
  (`s3api-eur-is-1.runpod.io`) allows push/pull without any pod running.

## Persistent-volume layout (everything durable lives on `/workspace`)

```text
/workspace/hive/            # dev checkout (the *running* edge is baked into the image)
/workspace/.hive/           # HIVE_HOME: edge.env, edge.sock, hive-edge.sqlite, ingress/, tailscale/
/workspace/.hive/profiles/claude-3/   # pinned CLAUDE_CONFIG_DIR (interactive login: Hákon)
/workspace/models/          # checkpoint + LoRA library, HF cache
/workspace/pipeline/        # the diffusion/training stack (owner's rig, not a tutorial env)
```

Pod-local disk resets on stop; nothing durable may live outside `/workspace`.

## Seat pod (custom image)

CI builds `ghcr.io/skrates/hive-edge-runpod` (see `.github/workflows/edge-runpod-image.yml`):
node 22 + git + tailscale + uv + runpodctl + Claude Code + the hive dist at `/opt/hive`,
`ENTRYPOINT start-edge.sh`. Pods can't build images (no docker daemon inside), so GHCR is the
only build path. The package is private — add a GHCR pull credential under RunPod → Settings →
Container Registry Auth before first deploy.

```bash
runpodctl pod create \
  --name hive-seat-claude-3 \
  --compute-type cpu \
  --image ghcr.io/skrates/hive-edge-runpod:latest \
  --data-center-ids EUR-IS-1 \
  --network-volume-id w65u1o4qbn \
  --container-disk-in-gb 20
```

`start-edge.sh` sources `/workspace/.hive/edge.env` (`HIVE_EDGE_ID=runpod`, broker tailnet URL,
edge token, `TAILSCALE_AUTHKEY`), starts tailscaled with state under
`/workspace/.hive/tailscale/`, and execs the baked edge. IP/hostname churn from resize cycles is
harmless — the edge only dials out.

## GPU workloads (official images, spawned by the seat)

Serving uses upstream images as-is — `vllm/vllm-openai:<pinned>` or NGC TensorRT-LLM — never
hand-rolled CUDA stacks (and never llama.cpp). The diffusion pipeline may layer a custom image on
an official PyTorch-CUDA base. All siblings mount the same network volume, so the model cache is
warm across pods:

```bash
runpodctl pod create \
  --name vllm-capreg-run \
  --image vllm/vllm-openai:latest \
  --gpu-id "NVIDIA RTX PRO 6000 Blackwell Workstation Edition" \
  --data-center-ids EUR-IS-1 \
  --network-volume-id w65u1o4qbn
```

(Exact `--gpu-id` strings come from `runpodctl gpu list`.)

A stopped pod is a dark agent with thread-visible failures, same contract as a closed laptop lid.
Scale before handing the agent heavy work; the subscription's cwd is `/workspace`.
