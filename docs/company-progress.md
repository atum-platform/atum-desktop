# Company agent progress and interim messages

`atum.agent-turns/1.6` adds a company scope to the personal working line
(1.3) and interim remarks (1.4). A company agent posts them in a company channel
thread or in a private Chief of Staff room. The desktop shows them with the
personal agent's components, copy and rules. There is no second renderer.

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
     incarnation);
   - an edit keeps the original's identity and never lowers the revision.

   Accepted events fill the existing `progress`/`interim` fields, plus
   `company` (the public identity) and `threadRelation` (root and in-thread
   reply).
2. **Admission** (`matrixAdmitCompanyPresentation`). The renderer keeps the
   company meaning only when the sender is the room's bound agent and the
   marker names that agent principal, company, audience, room and (in a thread
   view) thread. The bindings come from
   `apps/desktop/src/matrix/company-presentation-binding.ts`: the company's
   Chief of Staff view for a channel, and the platform's ready pair binding for
   a private room. Anything else becomes the standard Matrix message. A company
   view also never reads a personal 1.3 marker as a working line.
3. **Clearing** (`apps/desktop/shared/matrix-transient-lines.ts`). A company line
   is hidden when:
   - it is settled or redacted; or
   - its agent later posts a message that is neither a working line nor an
     interim remark, in the same thread, replying to the same trigger or naming
     none.

   An answer in another thread, or a message outside the thread, never ends it.
   Personal rules are unchanged.
4. **Rendering** (`apps/desktop/src/matrix/app.tsx`). The thread panel and the
   private room both draw the live line with `MatrixAgentWorking` under the
   transcript. The aria label is `typingOne` with the Chief of Staff's
   localized name. Interim remarks stay real transcript messages. Only the
   contract's redacted body is shown; descriptors, tool names, arguments and
   results are never read.

## Not covered here

- Publishing (controller side) and Matrix typing for company agents. Typing is
  room-wide in Matrix, so a thread view does not show it.
- The thread list's reply count is the SDK's count. It includes a live line
  until the publisher redacts it.
- The frozen 1.6 pack is not vendored under `packages/device-protocol/fixtures`
  yet: its company fixtures use identifiers that the public outbound guard
  requires to be reviewed. Tests use equivalent hex-identifier fixtures.

## Verification

From `apps/desktop`: `npx tsc --noEmit -p .`; `npx vitest run` on
`shared/matrix-company-presentation.test.ts`,
`shared/matrix-transient-lines.test.ts`, `src/matrix/message.test.ts`,
`src/matrix/room-preview.test.ts`, `src/app/atum/design-contract.test.ts` and
`src/matrix/app.test.tsx` (the channel thread and private room render tests);
eslint on the touched files.
