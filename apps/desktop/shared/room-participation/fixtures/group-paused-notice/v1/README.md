# Group paused notice v1

This additive contract supplies the distributed publication rule required by
`atum.room-participation/1`. It does not change the frozen participation pack,
Matrix crypto, invocation authority, wallet or model/tool profiles.

`POST /api/matrix/v1/local-hermes/group-notice` uses the existing native MAS
owner bearer, active executor/session check and current protocol-2 assistant
lease. No cookie, client owner/agent/device override or service credential is
accepted. The native owner SDK first validates the current room and policy.

Claim input: `operation: claim`, executorId, leaseToken, roomId, UTC day,
dailyTurns (1–200). Receipt input: `operation: published`, executorId,
leaseToken, roomId, UTC day, publishedEvent. Both are closed objects.

0206 serializes the existing owner/room policy with the canonical 0200 cap
lock. Only the server's current UTC day and an exhausted canonical invocation
count permit a reservation. One existing policy row retains the day's notice
UUID, assistant principal, executor, Matrix device, eventual
event receipt. No invocation, model grant or wallet hold is created.

Responses have version 1 and a state:

- `publish`: exact owner/room/day/executor/assistant/device binding, original
  fresh cap and a server-fixed `atum-gd-<64 hex>` Matrix transaction ID. Only that
  same executor/device can retry it with a current lease.
- `published`: day and eventId. Any current owner executor can repair its
  advisory account-data receipt; it cannot publish another notice that day.
- `busy`: another publisher owns this day's reservation. Do not publish.
- `not_paused`: stale day or canonical count below the fresh cap. Do not publish.

Native code revalidates the exact publisher, current lease, room membership,
UTC day and unchanged cap before sending. It uses fixed localized `m.notice`
copy, then records the returned event ID canonically, then writes advisory
owner account-data. A lost receipt acknowledgment is resolved by another claim;
a lost Matrix send acknowledgment retries the identical transaction on the
identical Matrix device. Duplicate triggers serialize under the existing native
agent lock. A unavailable/old route fails closed without an SDK send.

Matrix transaction IDs are per device and endpoint. A dispatched reservation
therefore never expires or transfers to another device, even after lease
replacement. An ambiguous external send cannot safely be resent elsewhere:
the original enrolled publisher must resume, or an operator must reconcile its
actual Matrix result. This conservative pending case retains the reservation
and does not fabricate `pausedNoticed`. No unattended cross-device takeover or
claim of unconditional exactly-once delivery is made. Normal concurrency and
same-device restart/lost acknowledgment produce one visible event per room/day.

Next UTC day gets a fresh reservation; raising the cap resumes answers through
0200. A published notice remains one per day even if the raised cap is reached
again. A failed notice attempt cannot widen turn or spending authority.

State matrix: absent reservation + exhausted cap → publish; existing same
publisher → retry; different publisher → busy; receipt → published; below cap
or stale day → not_paused; malformed/binding/lease denial → refusal; missing
route/database or transport error → unavailable, no fallback send.

Migration/route/native source must all be supported before activation. Apply
0200 before0206. Roll back the native feature/route first; retain0206 reservation
columns until every pending external send is reconciled. Never erase pending
reservations while a publisher can retry. Production apply/deploy/release and
the activation window require their separate owner go.
