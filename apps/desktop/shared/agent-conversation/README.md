# Agent conversation pure core

P7-2 shared policy against merged platform `spec/agent-conversation/v1`, PR 494
(merge `d76462400953226de0873146be4a61fd731419ea`). A-APP and the bounded early
C-CT holder accepted the cloud freeze in separate written board receipts.
No SDK, Electron or React import; no runtime call site, room write, model call,
flag or release change. The frozen pack and every declared byte are vendored
under fixtures, with its pin and source commit in VENDORED.json.

The marker reader accepts an authoritative owner-sent v1 event and returns only
role/main/at. Builder emits only the known pointer/time fields. Adapter supplies
already-authorized private assistant rooms, explicit read status and trusted
owner identity. A transient read preserves the entire previous resolution, or
throws matrix_conversation_unavailable without one. It never becomes legacy
through a read error. Races select newest main then lowest ID; readable losers
and explicit Earlier rooms refuse turns, strays refuse once a main exists;
unreachable rooms are never main or writable. Display and groups are unaffected.

Sweep candidates contain only earlier writes. The future adapter must suppress
writes while any read is transient, skip already matching pointers, and display
skipped/denied rooms. Migration planning checks capability/confirmation/no-live-
turn/preflight facts, produces chosen main first and other writable rooms in ID
order. Rollback clears only successfully written rooms, in reverse order. No
I/O is implemented here; adapter rollback failures must remain visible and retry.

Version fallback compares numeric components against 0.19.0. The adapter passes
one record per Mac that holds or may take a lease, including null for a missing
report. Replacing an encrypted main with a plain assistant room uses the 0.20.0
floor instead (`CONVERSATION_PLAIN_FLOOR`; amendment `atum.agent-conversation/1.1`
A1, vendored beside the base in `fixtures/agent-conversation/v1.1`). Notice
decision compares UTC day keys; persistence after successful
publish, the per-room scope, calendar derivation and zero-model execution belong
to the future notice adapter. The pure tests do not claim those side effects.

From apps/desktop: `npx vitest run shared/agent-conversation/conformance.test.ts`.
70 tests execute every pure scenario, marker construction/refusal, numeric version
readiness, immutable retry results and the framed pin. The provider's 88-fixture
generic schema/machine suite passes in platform; remaining actual command wire,
state-write failure and notice publisher proofs are P7-3/P7-4 obligations. Those
wire and I/O adapters are subsequent slices.

P7-3 and P7-6 also wait for A-2/A-0b; P7-3–P7-5 ship together. No live account
migration, cloud activation or production acceptance is authorized by this core.
