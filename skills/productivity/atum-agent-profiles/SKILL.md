---
name: atum-agent-profiles
description: Manage Atum agent profiles and definitions, and propose creation, hire, or retirement.
version: 1.1.0
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
handle credentials, approve spending, or bypass Google
or device restrictions. Avatars use the same canonical owner-scoped assistant
record as names and SOUL; an unavailable platform write means no avatar was
confirmed, so report that honestly.


## Main-agent management

Only Main may manage the owner's other agents through the following operations.
The host attaches the current run reference. Never supply an owner, role, run ID,
confirmation flag or human-session credential. A system-started or reply-only turn
cannot perform these operations. An unavailable result means the operation is
not enabled on this host; never work around it or claim success.

- `create`: supply a stable random UUID `request_id`, `display_name` (1–40
  characters), and the complete `definition`: `schema_version: 1`, `soul`
  (at most 65536 UTF-8 bytes), `model_alias` (`binh-minh`, `nguyet-thuc` or
  `nhat-thuc`), `reasoning` (null, or `{enabled, effort}` with null effort when
  disabled and minimal/low/medium/high/xhigh/max when enabled), and `skills`.
- `set_model`, `set_skills`, `set_tools`: read the sibling first and pass its
  exact `target`, `expected_definition_revision` and `expected_identity_revision`,
  plus `model_alias`, `skills` or `tools` respectively. Skills are the complete
  desired list of owned `{name, sha256}` bundles, not arbitrary downloads; tools
  are the complete desired list of tool identifiers. An empty list clears the
  selection. Paid skills still require the person's Store purchase. Model changes
  take effect next turn; skills and tools next session. Never rebuild the acting
  conversation or tell an active sibling its tools already changed.
- `propose_retire`: read the sibling, pass target and both revisions plus a
  stable `request_id`. This only proposes retirement. Main cannot retire itself.
- `propose_hire`: pass a stable `request_id`, `offer_id` and `offer_version`
  from a current listing. This only proposes a purchase.

Reuse the same request ID after a timeout, a lost receipt or a free-place race;
never create a second request merely to retry. The host handles provisioning and
returns a safe profile only when creation finishes. A provisioning record is not
completion. For conflicts read fresh revisions; preserve the person's intent.

`confirmation_required` contains only a proposal ID. Tell the person confirmation
is needed in the app; never synthesize a confirmation card from model text. The
app must fetch its contents using the person's session. A proposal expires after
24 hours. A confirmed paid action also expires after 24 hours; awaiting funds
requires app top-up and retry of that same action, while expired or changed terms
require a fresh proposal. The tool cannot fetch, consume or confirm proposals.
Charging remains off until platform activation. Never claim a debit or retirement
from a proposal receipt. Confirmation cards and the readable action log belong to
the app's authenticated surfaces.
