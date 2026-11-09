---
name: atum-agent-tasks
description: Delegate durable work to owned Atum agents.
version: 1.0.0
author: Atum
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [atum, agents, delegation, tasks]
    category: productivity
---

# Atum agent tasks

Use `atum_agents` with `operation=list` to find the exact target principal, then use
`atum_agent_tasks` with `operation=start`. The target works with its own identity,
tools, model grant, billing, and Hermes home; never imply it inherits your access.

Use `list` or `read` for the durable state and result. `pending` means the task was
recorded but the target has not acknowledged it; do not describe that as accepted or
offline without other evidence. `stop_requested` and `steer_sent` acknowledge only
delivery of the control message. Confirm the target's later `stopped`, `running`, or
terminal state before claiming the control took effect. A terminal result is one
message and may be truncated, with a trailing ellipsis, at 32 KiB.

Temporary Hermes subagents are a separate mechanism. Use this skill only when the
owner asks a persistent named Atum agent to do the work.
