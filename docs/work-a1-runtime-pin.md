# Work A-1 archive pin — built, not live

Update the single archive lock runtime-tools.json to atum-work 5d8d30d04ee11af5ba92d5aa40a7778505f04cff, same 0.1.11 version and Node 26.13.1. SHA-256 8d8bccdf71ecd769e0093a3fadbe193cf965174cf6053a2a1b4cf6ca96557aaa. stageWorkRuntime validates this archive digest and computes work-runtime/pin.json from extracted t3 bytes; pin.json intentionally identifies the server rather than the tarball. Private distribution signer must refresh that server digest after Developer ID signing changes its bytes.

Verification: actual staging and focused Work tests recorded below. No signing, notarization, push, PR, CI, deployment or publication authorized in this worker.

Actual stageWorkRuntime passed under Node 24.21.0, extracted arm64 server digest 41067e0a1ef949654ad32ef05d725ab03391b48bc310070d35b33074dedfc6a6; temporary staging removed.

## Slice C connector admission

Every connector response carrying an answer requires a live T3 invocation check.
The supervisor passes the private connector credential on an inherited pipe and
does not include it in child environments. Protected input carries the Matrix
provenance marker at the SDK send boundary. Desktop declines protected outbound
questions because its owned-agent roster does not certify the destination's
cloud model route.

The Work runtime only provisions its local policy when machine and per-user
managed preference sources are absent.

TODO after the coordinator publishes Work 0.1.12: update the Work version, fork
commit, archive and SHA-256 in `apps/desktop/runtime-tools.json` together.
