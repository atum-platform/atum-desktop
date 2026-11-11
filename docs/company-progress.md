# Company agent progress and interim messages

`atum.agent-turns/1.6` adds a company scope to the personal working line
(1.3) and interim remarks (1.4). A company agent posts them in a company channel
thread or in a private Chief of Staff room. The desktop shows them with the
personal agent's components, copy and rules. There is no second renderer.

The authority is the vendored pack,
`packages/device-protocol/fixtures/agent-turns-v1.6` (README and
`contract.json`). Threat model: any room member, or a compromised or foreign
agent account, can send arbitrary Matrix events into a company channel thread
or a private Chief of Staff room. Every rule below fails closed to the standard
Matrix message.

## Path

1. **Projection** (`apps/desktop/src/matrix/message.ts`, `companyPresentationOf`).
   Content that claims the company profile (`io.atum.company`, or an
   `io.atum.progress` marker whose profile is 1.6) is read only as company
   presentation, never as a personal marker. The strict reader
   (`apps/desktop/shared/matrix-company-presentation.ts`,
   `matrixCompanyPresentationContent`) rejects unknown keys at content and
   marker level, mixed audiences, timeline fallbacks and wrong roots. On top of
   that, the projection checks:
   - the event's own `m.thread` relation goes to the marker's root;
   - the marker names this room;
   - the company and audience match the room's immutable binding (a channel's
     create binding, or the private room's state marker and membership
     incarnation).

   Accepted events fill the existing `progress`/`interim` fields, plus
   `company` (the public identity).
2. **Edits** (`shownContent` / `companyShownContent` in `message.ts`). Each
   edit of the original sender is read whole by `matrixCompanyPresentationEdit`:
   the outer keys, a `* ` fallback body, an exact `m.replace` relation to the
   original, a strict full `m.new_content`, and an outer marker identical to the
   inner one (the pack's edit invariants). It must keep the original's identity.
   Edits apply in revision order, so a later-sent lower revision never replaces
   a higher one, and a retry of a shown revision is ignored. Settled is a
   terminal fence: once the original or an accepted edit says settled, nothing
   after it is read. A rejected edit is not applied; the original shows
   unedited. The edits come from the room's relations plus the SDK's latest
   replacement.
3. **Admission** (`matrixAdmitCompanyPresentation`), for company rooms only
   (a channel thread, a private Chief of Staff room). The renderer keeps the
   company meaning only when the sender is the room's bound agent and the
   marker names that agent principal, company, audience, room and (in a thread
   view) thread. Nothing else in a company room carries agent-turns meaning: a
   personal 1.3 marker or a 1.4 interim flag without the full 1.6 identity is a
   plain message, whoever sent it. The bindings come from
   `apps/desktop/src/matrix/company-presentation-binding.ts`:
   - a channel: the company's Chief of Staff view, read again whenever the
     channel's joined members change (`useCompanyAIStatus` with a refresh key,
     `company-ai-status.tsx`). The members come from Matrix sync
     (`conversations.ts` `participants`). Until that read answers (`fresh`),
     and whenever the view's agent is not a joined member, there is no binding;
   - a private room: the platform's ready pair binding, checked against the
     room's live members on every render (`companyPrivateCosRoom`: exactly you
     and the bound agent joined, the marker's executor). The store re-reads the
     view on focus, when the app comes back online, and on its quiet refresh
     (`recheckCompanyPrivateCos`).

   Without a binding every message is plain.
4. **Clearing** (`apps/desktop/shared/matrix-transient-lines.ts`). A company
   line ends only by its exact identity (company, agent, audience, room, thread
   root, task, invocation; `matrixCompanyTurnKey`): when it is settled (the
   projection keeps that fence), or when its publisher redacts it. A settled
   line of an identity fences every line of that identity. A later message of
   the agent never ends a company line: 1.6 defines no terminal answer that
   carries the identity, so an answer or status for another task cannot hide
   active work. The filter is one pass, and `matrixLiveWorkingLine` reads the
   live line from its output without filtering again. Personal rules are
   unchanged.
5. **Rendering** (`apps/desktop/src/matrix/app.tsx`). The thread panel and the
   private room both draw the live line with `MatrixAgentWorking` under the
   transcript. The aria label is `typingOne` with the Chief of Staff's
   localized name. Interim remarks stay real transcript messages. Only the
   contract's redacted body is shown; descriptors, tool names, arguments and
   results are never read.
6. **Previews** (`apps/desktop/src/matrix/room-preview.ts`). A company line is
   skipped as a row's preview only when the room-local projection admits it and
   its sender is the room's bound agent. In a private Chief of Staff room that
   is the one joined member besides you and the room's creator. Channels have no
   room-local agent fact, and their lines are thread events a channel row never
   previews. A marker from anyone else, or in a personal room, is an ordinary
   preview.

## Not covered here

- Publishing (controller side) and Matrix typing for company agents. Typing is
  room-wide in Matrix, so a thread view does not show it.
- The thread list's reply count is the SDK's count. It includes a live line
  until the publisher redacts it.
- A line whose publisher never redacts or settles it stays live; the contract
  requires idempotent cleanup retries on the controller side.
- A channel reassignment that changes no membership (the new agent was already
  a joined member) is picked up on the next Chief of Staff view read, not at
  once.

## Verification

From `apps/desktop`: `npx tsc --noEmit -p .`; `npx vitest run` on
`shared/matrix-company-presentation.test.ts`,
`shared/matrix-transient-lines.test.ts`, `src/matrix/message.test.ts` (every
company fixture of the pack through the real projection, accept and reject,
edits included), `src/matrix/room-preview.test.ts`,
`src/app/atum/design-contract.test.ts` and `src/matrix/app.test.tsx` (the
channel thread, reassignment and private room render tests); from
`packages/device-protocol`, `npx vitest run canonical.test.ts`; eslint on the
touched files.
