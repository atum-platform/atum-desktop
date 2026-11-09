---
name: atum-agent-profiles
description: Manage an Atum agent's name, SOUL, and avatar.
version: 1.0.0
author: Atum
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [atum, agents, profiles, identity]
    category: productivity
---

# Atum agent profiles

Use `atum_agents` for live profile facts and changes. Do not infer Main from a
name, avatar, file, or old conversation: `list` returns the current canonical
role on every call.

## Workflow

1. Call `list` to resolve exact principals and the current Main agent.
2. Call `read` for the intended target. Omit `target` for yourself.
3. Confirm the requested change. Preserve fields the owner did not ask to
   change; never rewrite SOUL merely to rename an agent.
4. For name or SOUL, call `update` with both revisions returned by `read`.
   If it conflicts, read again and explain the concurrent change; do not
   silently overwrite it.
5. For an avatar, use a prepared JPEG, PNG, or WebP file no larger than 2 MiB.
   Call `avatar` only when the owner explicitly asked to publish or remove the
   photo. The desktop's owner editor provides cropping before upload.

Ordinary agents may change only themselves. Main may change an owned sibling,
but the host checks Main again during each call. This tool cannot promote Main,
change model or skills, handle credentials, approve spending, or bypass Google
or device restrictions. Avatars use the same canonical owner-scoped assistant
record as names and SOUL; an unavailable platform write means no avatar was
confirmed, so report that honestly.
