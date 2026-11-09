# `atum.agent-presentation/1.1`: agent-profile list projection

This frozen additive pack carries every `atum.agent-presentation/1` fixture byte-for-byte. It adds the existing agent-profile list projection only. The v1 `presentation.snapshot` remains unchanged: it never gains volatile placement.

## Base and verification

The exact `/1` digest is pinned in `contract.json.base.sha256`. Rebuild or compare this pack with `node spec/agent-presentation/author-pack.mjs --check`; both independent standard-library contract checkers validate v1 and v1.1.

## Closed list forms

The controller request message is exactly `{operation: "list"}`. The native HTTP body is exactly `{originPrincipal, request:{operation:"list"}}`: its caller-named origin is re-authorized by SQL under the MAS owner and never grants authority. The native response is exactly `{originPrincipal, originIsMain, agents}`. The controller response is exactly `{executorId, originPrincipal, originIsMain, agents}`; only controller roster entries may optionally include the bounded Matrix `matrixUser` compatibility field. Native entries never include it.

Each response contains 1 through 100 agents. The later server implementation must cap or fail closed at 100 before emission; it cannot rely only on client parser limits. Every entry has principal, displayName, canonical nullable title, isMain, definitionRevision, identityRevision, nullable HTTPS avatar URL, and placement. `title` is canonical normalized `atum.assistants.title`; null means absent and is not a role or authority claim. `originPrincipal` names one roster entry and `originIsMain` equals that entry's `isMain` value.

Placement is exactly `{failoverOrder:[...]}` with exactly one cloud entry. Its order is the server policy’s projected failover order: cloud plus active device services, including disabled destinations without exposing a disabled flag. Mac `name` is the device-service registry `display_name`, not a UUID; duplicate display names are permitted. `online` is server-derived `eligible && stable` reachability only, not dispatch authority—a disabled destination may be online. `leaseHolder` derives from the one current unexpired lease for that agent placement, so at most one entry is true and none may be true.

The projection never exposes disabled flags, policy revision, destination/executor/device-service/Matrix-device IDs, lease tokens or expiry, internal reasons or diagnostics, credentials, endpoints, or secrets. Apart from native `originPrincipal`, which is re-authorized, request bodies cannot supply presentation, placement, role, owner, main, executor, device, or secret-shaped fields. Surrounding denied/invalid/unavailable errors are not success envelopes in this pack.

This is contract-first. Before emission, LB must widen the exact desktop/shared parser, LA must widen the exact platform controller parser, and LC must verify its mobile consumer; only then may the server cap and project the new fields. This pack activates no route, migration, or runtime behavior.
