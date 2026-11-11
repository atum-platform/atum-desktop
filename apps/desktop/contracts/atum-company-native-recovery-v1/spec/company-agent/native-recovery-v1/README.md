# Company native recovery service /1 (0444, built not live)

This additive service binding implements company-agent/1 recovery for channel and
private CoS native tasks. Frozen v1/v1.1 packs remain unchanged. Protocol stays
0.10.1; this service does not require new protocol exports.

POST `/api/matrix/v1/cloud/controller/company-ai/executors/{executorId}/recovery`
or `/api/matrix/v1/cloud/controller/company-private-cos/executors/{executorId}/recovery`,
beside `native` and `home`. Use existing bearer controller credential and
`x-atum-controller`; no tenant/principal/payer selectors. SQL RPC:
`atum.company_agent_native_recovery(p_controller uuid, p_credential_digest text,
p_executor uuid, p_input jsonb) -> jsonb`, EXECUTE service_role only.

Every request has EXACTLY these fields (all required, no extra fields):

```json
{
  "schemaVersion": 1,
  "operation": "effects",
  "requestId": "UUID",
  "taskId": "UUID",
  "invocationId": "UUID",
  "homeId": "UUID",
  "leaseToken": "43 base64url characters",
  "leaseGeneration": 1,
  "disclosureEpoch": 1,
  "expectedGeneration": 0,
  "effect": "none",
  "tools": [],
  "operationId": null
}
```

`operation`: `effects | close | requeue | check`. UUIDs use lowercase canonical
format. Epochs are safe integers >=1; expectedGeneration >=0. `effect`:
`none | read_only | side_effect_possible | unknown`; tools: <=12 names matching
`^[A-Za-z0-9_.:/-]{1,64}$`, never arguments or private bodies. operationId is
null or UUID; side-effect CHECK requires the identical recorded operation UUID.
Coordinates come from the current 0442 dispatch/home pointer. The platform owns
attempts; never send attempt, payer, companyId or budgets.

1. Persist `effects` before prompt.submit, before mutation starts, and on lost
   visibility. Strengthen evidence as needed. Effects are monotonic across
   attempts; missing evidence at recovery is unknown. `effects` records evidence
   without closing the grant.
2. Quiesce the old runtime, then `close` with final evidence and a new requestId.
   This durably closes the old grant before settlement. Finish in-flight model
   accounting. An unbilled model call yields 409 on recovery; retry the exact
   recovery request after accounting, without calling the model again.
3. `requeue` for none/read_only; `check` for side_effect_possible with the SAME
   operationId. Never call CompanyAgentTurn.run as a local retry. The returned
   dispatch is already funded and authoritative; do not reserve or dispatch again.
4. Execute CHECK as read-back of that one operation only. No mutation, arbitrary
   continuation or second CHECK is authorized. Unknown effects always terminate.

Responses:
- effects/close: exactly `{schemaVersion:1,taskId,state:'recorded'|'closed',attempt,effect}`.
- admitted: exactly `{schemaVersion:1,taskId,state:'dispatched',attempt,effect,
  mode:'run'|'check',operationId:UUID|null,dispatch:<0442 native dispatch>}`.
- refused: exactly `{schemaVersion:1,taskId,state:'refused',outcome:'uncertain',
  computeSeconds:0,attempt,effect}`. The grant is closed and old funding settled;
  finalize through the existing terminal/outbox path with that outcome/compute.

A recovered 0442 native dispatch also has `recovery:{attempt,mode,effect,operationId}`
so restart/replay preserves CHECK identity. Invocation/task IDs stay stable;
model token, home writer token/epoch, funding and admission IDs change. Use the
returned coordinates for every subsequent callback. Old callbacks are fenced.
Exact requestId/input replay returns its stored receipt, including the original
dispatch; changed input is 409. Historical receipt replay conveys evidence only:
its grant may have been superseded; check current authority before execution.

No unknown rerun, second CHECK, stopped/deadline/exhausted recovery, or renewal
of an exhausted funded slice. none is bounded by original task age (chat <30min,
occurrence <5min), hard ceiling 100; cumulative read_only permits two requeues.
Each interrupted attempt settles via the personal undelivered-outcome adapter
(0239), then the existing company funding adapter makes a separately accounted
attempt subject to unchanged company/requester caps and wallet policy. Historical
reservations remain linked and auditable. No ledger function is changed.

400 invalid shape; 403 controller/scope/home/epoch refusal; 409 request conflict
or unbilled model accounting; 503 unavailable. Shell errors remain body-free.

Round-2 completion fence: after recovery, completion/publication requests MUST
include top-level `nativeAttempt` equal to the returned `attempt` (also
`dispatch.recovery.attempt`). This applies to channel invocation `complete`,
agent `commit`/`abandon`/`published`/`recover`/`release`, and private
`receipt`/`recover`/`commit`/`outbox`/`published`. This field is for callbacks,
not the recovery RPC's fixed request shape. Missing or stale authority is 403
before current funding, settlement, or outbox replay can be selected. The run
lock keeps that check atomic with completion and concurrent recovery. The
private completion helpers have additive final `jsonb` attempt overloads;
old signatures reject recovered native tasks. Non-native tasks retain their
existing behavior. Initial native attempt 0 retains wire compatibility;
once recovery starts, the explicit attempt is mandatory, including terminal
refusal callbacks. Reservation-keyed ledger functions are unchanged.

CHECK reads interrupted-attempt evidence before updating it. A missing recorded
operation ID refuses CHECK even when the request supplies a new valid UUID;
a different recorded ID conflicts. Recovery never writes an operation identity.
