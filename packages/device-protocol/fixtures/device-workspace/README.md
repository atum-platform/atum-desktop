# Device workspace v1 — Phase A completion companion

This companion supplies the missing A2-9 lifecycle for device-service/1.1.
Frozen service packs and their seven tools are unchanged. The app and controller
both validate the pinned companion. It grants no capability or new model tool.

## Negotiation and authority

The Mac opts in with signed Hello.body.workspaceProtocol=1. The controller echoes
it in signed Ready only when it implements this pack; the Hello hash binds the
request. No echo means no workspace frames. A controller never sends an extension
to an old Mac. A new Mac talking to an old controller must retry its connection
without the opt-in after a protocol refusal; it must never send lifecycle frames
on that legacy connection. AppVersion is not authority. Production enablement
requires the owner's explicit go.

After the normal proof and status exchange, WorkspaceFinalize may name one live
admitted grant on that exact connection. All IDs, enrollment/account epochs,
writer epoch and invocation must match the stored grant, never tool args. The
request lives at most 120 seconds and is issued before grant expiry; the controller
must hold the same writer lease throughout collection and commit. The Mac checks
its own scopes, identity and live grant, ends that grant, blocks every Execute in
the shared host, aborts its commands/approvals and proves whole responsibility-tree
quiescence before changes/collect. Failed proof, Stop, cancel, sign-out or account
switch yields no publishable snapshot. The copy remains on disk.

## Result, bytes and confirmation

At most one Finalize is pending per grant/Mac. An exact duplicate request on the
same session reuses the same frozen result/bytes; a changed request with a reused
ID is refused. A different pending request does not enter the whole-host barrier.
After a reconnect, old session requests/results/chunks/confirmations are discarded;
unsaved copies remain. Conflict version keys can be offered under a fresh authorized
request without duplicate publication. Never replay a Finalize across epochs.

All extension frames use the immutable service/1.1 signing domain and signers:
utf8("atum.device-service.v1\0" + type + "\0") + utf8(canonicalJson(body));
controller Ed25519, device ES256 IEEE P1363. Type binds the lifecycle purpose.

Existing bounded binary ArtifactChunk frames use requestId as their commandId.
The controller assembles them only for a pending lifecycle request from that
verified connection; no generic Receipt or model request can create one. Each
artifact is at most 8 MiB, all artifacts at most 64 MiB, count at most 16, and the
signed result must list exactly the bytes consumed. artifacts[].name is a short
opaque wire ID using the existing artifact schema; outputs[] maps each ID to its
relative workspace path and conflicts[] maps conflict IDs to path/label/version key.
Each ID appears exactly once in outputs or conflicts; each references one listed
artifact. IDs are not filesystem paths. This preserves nested and Unicode paths
without changing the frozen binary header or attachment artifact vocabulary. Validate paths, exclusions,
case-fold uniqueness, hashes, manifest folder and transaction label. Manifest
server facts are consistency dependencies; they confer no storage authority.
Resource authority comes only from the broker's owner/agent-scoped grant.

resultHash is base64url SHA-256 of canonical JSON of the complete WorkspaceResult
body with resultHash omitted. WorkspaceConfirm repeats the full binding and hash.
The Mac accepts it only for its retained result on the same authenticated session.
Only an actual matching broker committed/committed_with_siblings result may set
saved=true, and only when every changed output was committed, no deletion remains
unhandled and complete=true. Empty, partial, stale_inputs, unknown, connection/lease
loss or a lost confirmation never makes a copy eligible for pruning. Persist the
saved predicate sealed; recheck the copy's bytes before pruning so later owner
edits cannot be lost. Confirm does not delete a copy immediately.

Conflict copies carry stable version keys and labels, are published create-only
with deterministic per-owner/agent/key task IDs, and are confirmed asynchronously
only after that exact publication is committed (or a verified identical completed
task). Missing acknowledgments retry the same key. Oversized/refused/unconfirmed
copies stay on disk; no result for another label can confirm them.

The generic independent checkers prove data shapes/pins and local invariants.
Consumers must additionally prove stored-grant/connection/lease correlation,
quiescence, byte integrity, broker commit causality and reconnect behavior with
real wire tests. Fixtures with placeholder signature bytes exercise shape only;
cryptographic tests use ephemeral synthetic keys without private key persistence.

Verify both spec/_tools/contract_pack.py and contract_pack.mjs on this directory.
The dedicated package script/CI line is serialized after earlier board claims.
No migration, Drive direct write, deployment, release or flag flip is included.
