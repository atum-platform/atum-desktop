# Signed Mac scheduled jobs — protocol 0.7.72

N7a3, built-not-live. Desktop N7b consumes this transport; no service-role,
controller credential, enrollment fabrication or second execution ledger.

## Transport and signing

POST, `Content-Type: application/json`, `Authorization: Bearer <MAS owner access token>`.
Native MAS admission applies; cookies and `x-atum-principal` are rejected. No query
parameters. Assistant path ID is the assistant record ID, **not** agentPrincipal.
All replies are no-store. No extra wire/version header is required.

| Path below `/api/matrix/v1/agents/{assistantId}/jobs/` | Signature action | Request / response schema exported by `@atum/protocol` |
|---|---|---|
| `fire` | `MacJobFire` | `MacJobFireEnvelopeSchema` / `MacJobFireResponseSchema` |
| `occurrence` | `MacJobOccurrence` | `MacJobOccurrenceEnvelopeSchema` / `MacJobOccurrenceResponseSchema` |
| `grant` | `MacJobGrant` | `MacJobGrantEnvelopeSchema` / `MacJobGrantResponseSchema` |

Every body is exactly `{meta, home, request}`. `meta` is D1's
`AgentHomeExecutorSignedMetaSchema`, restricted to `signer:'mac_executor'`:
`requestId,commandId,signer,signerKeyId,deviceServiceId,sequence,issuedAt,expiresAt,nonce,signature`.
IDs are UUIDs; sequence is positive safe integer; time is integer milliseconds;
key ID and nonce are 43-character base64url; signature is 86-character base64url.
Use fresh commandId, nonce and device-wide sequence on **every HTTP attempt**,
including settlement retries. Do not reset sequence independently of other D1
requests on the same device. Lifetime is positive and at most two hours; issuedAt
must not be in the future, expiresAt must be later than both Shell and DB clocks.

`home` is exactly D1's `AgentHomeExecutorLeaseFenceSchema`:
`ownerUserId` (Matrix ID), `agentPrincipal,homeId,homeEpoch,executorTerm,leaseId,
leaseExpiresAtPlatform`. Use the current platform-issued lease expiry, including
renewals. The database checks authenticated owner, assistant, placement, pinned
key/device, home epoch, term, lease and move barrier again at the actual effect.

Sign UTF-8 bytes:

```text
atum.agent-home/2.1\0<Signature action>\0<canonicalJson(body without meta.signature)>
```

`\0` means one NUL byte. Use existing `canonicalJson` from protocol (no custom
JSON serializer), SHA-256 / P-256 ECDSA, 64-byte IEEE-P1363 `r || s`, base64url
without padding. The key is the existing pinned Mac SPKI P-256 key. Every body
field other than signature is covered, including the grant token. Action domain
separation prevents cross-route reuse; home.agentPrincipal binds the path's agent
through the database. Never send a signature-valid boolean or owner UUID.

## Requests

`fire.request` reuses `ControllerJobFireRequestSchema`:

- Claim: `{profile:'atum.controller-job-fire/1',operation:'claim',leaseToken:uuid}`.
- Arm acknowledgement: `{profile:'atum.controller-job-fire/1',operation:'complete',leaseToken:uuid,armId:uuid,occurrenceId:uuid|null,outcome:'queued'|'missed'|'daily_cap'|'terminal'}`.

`occurrence.request` (no profile key), always `executorId:uuid,protocol:3`:

- Claim: `operation:'claim',leaseToken:uuid,scheduleId:string,occurrenceAt:ms,definitionDigest:hex64,catchupWindowMs:120000..7200000,roomId:MatrixRoomId`.
- Dispatch: `operation:'dispatch',leaseToken:uuid,occurrenceId:uuid`.
- Settle: `operation:'complete',occurrenceId:uuid,outcome:'answered'|'stopped'|'failed'|'uncertain',usage:{computeSeconds:0..86400}`.
- Delivery receipt: `operation:'published',occurrenceId:uuid,publishedEvent:MatrixEventId`.

`grant.request` is exactly `{token:<43-character base64url bearer grant>}`.
Authorization remains the MAS bearer. Shell hashes the signed token using SHA-256
UTF-8 to lowercase hex before calling `matrix_agent_job_model_grant_check`.
Plaintext is never forwarded to the RPC or logged. Check each model admission;
never cache a positive result across a placement change. This endpoint validates
the grant, it does not itself call a model. Non-Atum subscription/relay model use
continues through its existing separate provider transport.

## Results and retries

Fire returns the existing closed `ControllerJobFireResponseSchema`: `claimed`
with `fire:null|definition+arm`, or `completed` with stored arm acknowledgement.
Occurrence returns the existing ledger projection: occurrenceId, state, scheduleId,
occurrenceAt, agentPrincipal, executorId, roomId, and optional expiresAt, skipReason,
transactionId, publishedEvent, outcome, deliveryDisposition, resume, occurrenceOutcome.
Dispatch adds paired `budget` and `grants.model`; model grants are a closed union
of ordinary Atum, protected Google, OpenCode Go and ChatGPT relay shapes, retaining
native fields. Grant check returns `{state:'revoked'}` or the closed active grant
projection (owner, agent, reservation, funding, budget, expiry and model policy).
The exact field validation is `packages/protocol/src/mac-jobs.ts`, reusing existing
D1/N5/outcome schemas rather than copying those contracts.

HTTP 409 `lease_lost`:
`{profile:'atum.mac-job-fire/1',code:'lease_lost',detail:{kind:'placement_authority',reason}}`.
Reason is one of `stale_home_epoch,stale_executor_term,wrong_lease,lease_expired,
wrong_signer_location,move_in_progress`.
Other closed refusals are `{profile:'atum.mac-job-fire/1',code}`:
400 `matrix_invalid`, 401/403 `denied`, 404 `not_found`, 409 `conflict`,
429 `busy`, 503 `unavailable`. `busy` is 0215's admission wait (the agent's own running work):
nothing changed, retry the same business request with fresh signing metadata. A duplicate
dispatch is `conflict` (the run already holds its only grant; never start a fresh execution). No database exception text/detail is exposed. Bad/expired
signatures are denied; durable replay is conflict. D1 non-placement refusals
collapse to denied. Unknown or malformed server output fails unavailable.

Replay admission uses D1's durable command/sequence/nonce table before the job RPC.
A consumed tuple stays consumed on later failure; retry using fresh signing metadata.
Business identifiers stay unchanged. Settlement replays the stored result;
**dispatch does not reissue a token** after a lost response. Never start a fresh
execution to recover that response; retain the occurrence and its uncertain state.
Arm acknowledgement and execution settlement are not delivery evidence: publish
and record the receipt through the existing delivery flow before acknowledging
successful delivery. Existing native sweep admission remains separate; these
scheduled occurrence routes cannot bypass its reserved schedule IDs.

## N7a4 snapshot and managed-model admission (0.7.72, unreleased)

`POST /api/matrix/v1/agents/{assistantId}/jobs/snapshot` uses the same MAS owner
bearer, active device key, P-256/P1363 signature and durable D1 replay ledger as
fire/occurrence/grant. Sign action **MacJobSnapshot** with the existing
`atum.agent-home/2.1\0<action>\0<canonical JSON without meta.signature>` bytes.
Its closed body is **`{meta, profile:'atum.mac-job-snapshot/1', home:<D1 fence>}`**;
there is no nested `request`. Middleware admits this route without browser cookies.

Accepted: `{profile:'atum.mac-job-snapshot/1', selected:boolean,
generation:string|null, managedJobIds:string[]}`. `selected` is true when the existing
0316 per-agent `atum_private.agent_sweep_state.mac_jobs_selected` canary is on **or** the
agent is already externally activated by N5/N6 (`execution_generation > 0` or
`native_job_active`). The canary defaults false, is writable only by service_role through
`matrix_agent_job_canary_set(owner,assistant,selected)`, and gates only the first activation;
direct table writes stay private. A missing settings row means false unless an external
generation already exists. Activation is one-way. Once an agent is activated, turning the
canary off is refused with `matrix_conflict`
(detail `already_activated`): the legacy Mac sweep claim then needs a native arm, so an off
canary would stop the agent's jobs. The same rule keeps a cloud-activated agent selected after
it moves to a Mac whose canary is off. To stop Mac execution after activation, move the agent home.
Off on a never-activated agent returns null generation and empty inventory without job/settings/arm changes
(transport replay admission still consumes its nonce). On requires this Mac's current
D1 placement; stale/other Macs and cloud-held homes receive existing `lease_lost`.
N5 reconciliation is extracted into `atum_private.agent_job_reconcile` and shared with
the cloud adapter; N6 sweep projection is activated through its existing functions.
Generation is a lowercase SHA-256 of the ordered managed inventory's job IDs,
definition digests, execution generations and enabled states; retries return the same
generation and arm identities while inventory is unchanged. All refusals use the
existing `atum.mac-job-fire/1` union, including busy/conflict.

The gateway is **services/gateway/atum_gateway** (LiteLLM auth.py → hooks.py →
cloud.py/ledger.py), serving `<base>/chat/completions` (including `/v1` base).
Cloud bearer + `x-atum-controller` + `x-atum-model-grant` remains unchanged.
Mac callers send the MAS domain bearer, `x-atum-model-grant` and
**`x-atum-mac-job-signature`**, with **no `x-atum-controller`**. That header is
unpadded base64url UTF-8 JSON `{meta,home,request:{method:'POST',path:<exact pathname>,
grantDigest:<sha256 plaintext grant>}}`, signed under **MacJobModel** using the same
D1 signing bytes. No query string is allowed. Header/body principal overrides,
cookies, Origin, mixed controller credentials and expired signatures are rejected.

Every admission resolves MAS freshly, verifies the active device's signature,
consumes D1 replay, calls `matrix_agent_job_model_grant_check`, then reserves against
the returned occurrence reservation using existing `cloud_admission_model_reserve`.
Existing gateway hold settlement calls `cloud_admission_charge` once per admission
key (idempotent on retries). Revoked/foreign/expired tokens never reserve;
`lease_lost` is HTTP 409 with the existing refusal in `detail`. Other invalid grants
are HTTP 401; replay is HTTP 409. Store protected-prefix lookup verifies the same
signature and live grant, consumes replay before any Store task creation, then
resolves the occurrence room. A 409 from that lookup (`lease_lost`, replay) is returned
unchanged, never turned into a retryable 503. A server-only request marker avoids consuming that
nonce twice; model admission still rechecks the live grant and placement. Grant plaintext never enters SQL, metadata, logs, or repr.
The gateway's trusted `ledger_service` role receives only context/read, replay and
Mac grant-check RPC access; it cannot set the canary or execute snapshot/fire.
