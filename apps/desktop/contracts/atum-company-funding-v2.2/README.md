# atum.company-funding/2.2 — native company funded grants

Frozen focused additive minor over /2.1. Wallet/top-up/member-transfer routes and
all prior messages stay byte-identical. Adds the native `grant` message only;
company-ai/2 and company-private-cos/2 negotiate it explicitly. Legacy /1 grants
remain drain/recovery-only after cutover. Protocol release allocation is left
to the coordinator. P1 implements proposed 0422; no migrations are added here.

Reuse controllerTurnSlice and the peer reserve/charge/settle path: one immutable
ceiling, compute reservation and expiry for the turn, up to the default two-hour
hard stop with the peer default 5,000ms settlement margin, 1000 requests and 8 concurrent model requests.
All model, auxiliary, child/delegated usage and measured compute are counted.
The funded compute input keeps the peer 1–86,400-second envelope; the execution
cap remains two hours. `expiresAtMs` is the peer slice expiry, the lesser of
server expiry and startedAtMs + computeSeconds*1000. The hard deadline is
min(expiresAtMs, startedAtMs + 7,200,000) minus settlementMarginMs, and must
still be after admission. Never extend immutable reserve inputs.
No renewable segments, personal wallet fallback, overdraft or automatic new paid
turn. Linked routines/jobs/hand-offs require their own current funded authority.
Per-call live lease/funding checks remain mandatory. Stop, lease loss, exhaustion
or deadline interrupt and settle truthfully. Settlement is idempotent and total
charges cannot exceed the held ceiling; release the remainder. Unknown model
charges remain reconciliable, independently of tool-effect receipts.

Grant owner, payer, audience and slice payer identify the SAME company. The grant
profile discriminates channel vs private_pair scope. The live-check reservationId
is cloudAdmissionReservationId. Budget/settlement/receipt APIs instead use
fundingReservationId; preserve migration 0399's mapping and never confuse them.
The new exact key set is version-selected. `toolProfile: peer` replaces /1's empty
`tools` tuple only on these new messages; it does not add gateway tool-policy
validation. Gateway, SQL live check and matrix_store_cloud_model_binding, broker,
executor and mirrors must all be upgraded together (see inventory).

Grant tokens are transmitted only in dispatch's modelToken, never in this checked
projection or durable archives. Host derives requester and current task authority;
no client can submit a payer/ceiling/profile to mint its own grant. A subsequent
authorized user turn has a new normal slice, never a renewal of this one.

Validators cover payer/scope mismatch, reservation identity, time and budget
bounds, forbidden personal fields/renewable segments and both new profiles.
