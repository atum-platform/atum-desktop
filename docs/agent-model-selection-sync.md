# Agent subscription model selection across devices

The platform stores the saved Mac subscription model per owner and agent principal in
`atum_private.matrix_model_choices.work_selection`. All clients signed in as the same owner
read the same row. The assistant record ID and the agent principal are distinct. Supply the
agent principal when reading or writing a selection.

## Owner API

- Send a bearer-authenticated `POST /api/matrix/v1/device-services` with
  `{ operation: "work_selection_read", agentPrincipal }`. The reply contains
  `{ revision, selection }`. The selection is either `null` or
  `{ provider: "atum-work", plan, model }`, with an optional `effort` on supported clients.
  An agent with no row returns revision 0 and a null selection. A managed model write can
  clear a previously saved subscription, so a null selection at a newer revision is meaningful.
- Send `x-atum-work-selection-effort: 1` on reads when the client supports the optional effort.
  When the platform supports it, the reply also advertises `efforts`. Preserve the exact
  model ID and apply the advertised effort options when present.
- Write with `{ operation: "work_selection_set", agentPrincipal, expectedRevision, selection }`.
  Use the revision from the owner read. The response includes the saved selection fields and
  the resulting revision. On a revision conflict, read again before attempting another write.

The owner read works independently of which Mac serves the subscription. Device facts describe
which plans and models are available on each Mac. The managed fallback and the per-destination
model snapshot have their own roles and cannot supply the Work selection or its write revision.

## Client refresh

Desktop reads through `work.readAgentPlans` on mount, picker open or close, local Work status
changes, and window focus. The composer and agent card render the same account-scoped in-memory
entry and adopt the server acknowledgement immediately for a local write. A failed refresh
keeps the last result. Existing read ordering prevents responses started before a local write
from replacing that write after it is acknowledged. A remote write becomes visible on the next
read, so a window that stays focused can keep displaying the previous selection until the next
refresh trigger.

Mobile can use the same owner read on foreground or when showing an agent, and re-read after a
selection change signal if one is available. Keep the cached result scoped to the signed-in
owner and agent. A refresh signal only prompts a read. The response supplies the selection.

The desktop regression test runs the native Work write and read clients against a shared test
server. The receiving Mac starts on Astra, the other Mac saves Sol, and the receiving
composer chip updates on focus while its picker stays closed.

The regression failed on the release train before the focus refresh was wired. The focused
picker, selection store, relay and relay-view suites pass with the change, as do the desktop
typecheck, client boundary check and public renderer build.
