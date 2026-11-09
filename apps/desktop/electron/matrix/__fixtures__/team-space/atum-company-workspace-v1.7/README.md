# `atum.company-workspace/1.7`: company avatar mutation

Status: frozen additive company-identity mutation. Base:
`atum.company-workspace/1.6` at `fe7b147c0ef3b5b73dea81c92a4a768b108c2de8a7144fced30d8407bf1cb0de`. Select it with
`Atum-Company-Wire: 1.7`. Every 1.1–1.6 message stays unchanged; only the
messages introduced here use `schemaVersion: 8`.

## Mutation

`POST /api/matrix/v1/companies/{companyId}/set-avatar` accepts exactly:

```json
{
  "requestId": "00000000-0000-4000-8000-ba58ff7e081b",
  "operation": "set_avatar",
  "avatarUri": "mxc://matrix.atum.app/company-logo"
}
```

The desktop first uploads its already-prepared JPEG, PNG, or WebP bytes with
the authenticated user's Matrix session. This mutation carries only the
resulting opaque `mxc://` URI; it never accepts bytes, HTTP URLs, credentials,
room IDs, an actor, a manager identity, or a client-selected revision.

The platform resolves the actor from the native bearer and permits only the
active company owner or an active admin. It persists one monotonic company
avatar revision, journals the exact actor/request/input/result, and appends the
same admin audit evidence as other company mutations. Replaying an identical
request returns the stored result with `replayed: true`; reusing the request ID
for different input is a conflict. A distinct request that names the current
URI is a semantic no-op: it keeps the revision while still leaving a request
and audit receipt.

## Manager projection

The company record is the identity source of truth. The fenced Team Space room
manager projects the URI to `m.room.avatar` on company channel rooms, including
the protected default channel (`#chung` in Vietnamese), and acknowledges the
exact avatar revision. Conversation rooms keep their participant identity and
do not inherit the company avatar.

The current architecture has no Matrix `m.space` company room; this contract
does not invent one. A future company-space lifecycle may consume the same
durable avatar revision without changing this native mutation.

## Response

The response contains exactly `schemaVersion`, `operation`, `companyId`,
`avatarUri`, `avatarRevision`, and `replayed`. It is `no-store`. Authorization
failures disclose no company or avatar state.
