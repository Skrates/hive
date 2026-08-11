---
name: hive-attach
description: Attach a Hive actor, usually codex-1, to the exact current foreground Codex Desktop task and verify the revision-confirmed binding. Use when explicitly invoked from the slash menu or when the user asks to attach this Codex task to Hive. Do not use for merely explaining Hive.
---

# Hive Attach

Attach one Hive actor to this exact local Codex Desktop task.

1. Read the actor from the invocation. Use `codex-1` when the user did not name one. Accept exactly one actor.
2. Confirm `CODEX_THREAD_ID` is present without printing its value. If it is absent, stop and explain that attachment must run from a local Codex task; never infer or select the newest task.
3. Resolve the task working directory with `pwd -P`.
4. Run `hive attach <actor> --cwd <resolved-directory>` through the local shell. Do not add `--session`; the CLI must consume the current task's `CODEX_THREAD_ID` itself.
5. Treat exit status zero as success only because the Hive CLI waits for the live supervisor to confirm the same owner-only binding revision. On failure, report the safe error; the CLI restores the prior binding atomically when one existed, or removes only its own unconfirmed revision when none did. Do not write a binding file manually and do not choose a fallback task.
6. Report the actor, exact cwd, and confirmed `desktop` mode concisely. Never print the Codex task ID or binding-file contents.

This workflow changes only the machine-local Hive routing binding. It does not send a Slack message, change a subscription, start a provider turn, or broaden the task's permissions.
