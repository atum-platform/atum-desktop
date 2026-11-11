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
   `company` (the public identity, with `revisedAt`: the `origin_server_ts` of
   the newest accepted revision).
2. **Edits** (`shownContent` / `companyShownContent` in `message.ts`). Each
   edit of the original sender is read whole by `matrixCompanyPresentationEdit`:
   the outer keys, a `* ` fallback body, an exact `m.replace` relation to the
   original, a strict full `m.new_content`, and an outer marker identical to the
   inner one (the pack's edit invariants). It must keep the original's identity.
   Edits apply in revision order, so a later-sent lower revision never replaces
   a higher one, and a retry of a shown revision is ignored. Of conflicting
   edits of one revision the lowest event ID counts, whatever their timestamps
   or arrival order. Settled is a
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
     channel's joined members change, and at once when a company marker arrives
     from a sender no view of the company has named
     (`useCompanyStrangerSignal`, `company-presentation-hooks.ts`), so a
     reassignment to an agent that was already a member is seen on its first
     line. While the thread shows company markers the view also has a bounded
     age: it is re-read every 30 s, and an answer older than 60 s no longer binds
     (`useCompanyAIStatus` `maxAgeMs`, `company-ai-status.tsx`). The members
     come from Matrix sync (`conversations.ts` `participants`). Until a read
     started after the latest change answers (`fresh`), and whenever the view's
     agent is not a joined member, there is no binding. An agent a view once
     named is not a stranger: after a reassignment its lines are plain, and its
     return is seen by the bounded-age re-read;
   - a private room: the platform's ready pair binding, checked against the
     room's live members on every render (`companyPrivateCosRoom`: exactly you
     and the bound agent joined, the marker's executor). The store re-reads the
     view on focus, when the app comes back online, and on its quiet refresh
     (`recheckCompanyPrivateCos`).

   Without a binding every message is plain.
4. **Clearing** (`apps/desktop/shared/matrix-transient-lines.ts`). A company
   line ends only by its exact identity (company, agent, audience, room, thread
   root, task, invocation; `matrixCompanyTurnKey`): when it is settled, or when
   a line of it is redacted. A settled line of an identity fences every line of
   that identity. The window remembers each terminal fact for the session
   (`company-turn-memory.ts`, one per account): a tuple seen settled stays ended
   even when the settling edit is later redacted (the surviving edits alone
   would say working again), and a drawn line's later redaction ends its tuple.
   Facts are recorded only from admitted lines.
   Presentation expiry: a company progress line whose newest accepted revision
   (`revisedAt`) is older than three quiet heartbeats (540000 ms,
   `MATRIX_COMPANY_PROGRESS_EXPIRY_MS`) is hidden. One timeout per chat, set for
   the next expiry (`useCompanyLineClock`), re-renders it; nothing polls. Expiry
   is presentation only: it records nothing, never reads as done, and a newer
   revision of the tuple shows the line again. A later message of
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
   its sender is the agent the platform binds to the room: in a private Chief of
   Staff room, the same `privateCosPresentationBinding` the transcript uses,
   read by the chat list's projection (`conversations.ts`). The agent is never
   inferred from who is in the room; while the binding is unknown the line
   previews as an ordinary message. Channels have no room-local agent fact, and
   their lines are thread events a channel row never previews. A marker from
   anyone else, or in a personal room, is an ordinary preview.

## Not covered here

- Publishing (controller side) and Matrix typing for company agents. Typing is
  room-wide in Matrix, so a thread view does not show it.
- The thread list's reply count is the SDK's count. It includes a live line
  until the publisher redacts it.
- The publisher's authorized cleanup (redaction through the platform cleanup
  authority) is the controller's lane. On the desktop a line whose publisher
  never cleans up is hidden by presentation expiry, which changes no execution
  state.
- A chat list row is projected on Matrix sync: a private room's binding that
  loads later applies to the row on the next sync (until then the line is an
  ordinary preview).
- The terminal memory lasts for the window's session; a tuple ended before the
  app started is known only from what survives in the room.

## Verification

From `apps/desktop`: `npx tsc --noEmit -p .`; `npx vitest run` on
`shared/matrix-company-presentation.test.ts`,
`shared/matrix-transient-lines.test.ts`, `src/matrix/message.test.ts` (every
company fixture of the pack through the real projection, accept and reject,
edits included), `src/matrix/room-preview.test.ts`,
`src/app/atum/design-contract.test.ts` and `src/matrix/app.test.tsx` (the
channel thread, reassignment and private room render tests); from
`packages/device-protocol`, `npx vitest run canonical.test.ts`; eslint on the
touched files. The reassignment, bounded-age and expiry tests use fake timers.
