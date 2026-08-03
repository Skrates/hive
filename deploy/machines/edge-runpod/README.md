# Edge: runpod — seat claude-3 (Claude Team, hakon@sokrates.is)

The hive's actuator: primarily Sovereign development and local-model testing for the capability
registry, occasionally the diffusion pipeline (LoRA training). The pod's CPU/GPU scale to the
anticipated workload; the edge rides along and must survive stop/resize/start cycles.

## Persistent-volume layout (everything durable lives on `/workspace`)

```text
/workspace/hive/            # this checkout (built)
/workspace/.hive/           # HIVE_HOME: edge.sock, hive-edge.sqlite, ingress/
/workspace/.hive/profiles/claude-3/   # pinned CLAUDE_CONFIG_DIR (interactive login: Hákon)
/workspace/models/          # checkpoint + LoRA library, HF cache (HF_HOME=/workspace/models/hf)
/workspace/pipeline/        # the diffusion/training stack (ComfyUI etc. — owner's rig, not a tutorial env)
```

Pod-local disk resets on stop; nothing durable may live outside `/workspace`.

## Boot

RunPod start command (or container start script) runs `deploy/machines/edge-runpod/start-edge.sh`,
which exports `HIVE_HOME=/workspace/.hive`, sources `/workspace/.hive/edge.env`
(`HIVE_EDGE_ID=runpod`, broker tailnet URL, edge token), starts tailscaled with state under
`/workspace/.hive/tailscale/`, and execs `hive edge`. IP/hostname churn from resize cycles is
harmless — the edge only dials out.

A stopped pod is a dark agent with thread-visible failures, same contract as a closed laptop lid.
Scale the pod *before* handing the agent heavy work; the subscription's cwd is `/workspace`.
