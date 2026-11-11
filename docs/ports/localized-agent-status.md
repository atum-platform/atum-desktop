# Localized agent status (agent-turns/1.5 consumer, owner-language/1 reporter)

The agent's working line, outcome notices, scheduled lines and appended answer warnings are worded
in the reader's current UI language from codes beside the message body, instead of showing the
sender-language body. `body` stays the canonical text for copy, export and every other Matrix client.

## Wire read (all optional, all top-level content keys; old closed markers are unchanged)

| Key | On | Reader |
|---|---|---|
| `io.atum.presentation {version:1, code, args}` | progress notice, its edit and `m.new_content` | `matrixProgressPresentation` (`shared/matrix-progress-marker.ts`) |
| `io.atum.result_details {devices?, routine_title?, attachment?, resume?}` | `io.atum.result` notice | `matrixResultStatusNotice` (`shared/matrix-agent-status-marker.ts`) |
| `io.atum.result_warning {version:1, from}` | answer `m.text` with an answer-warning status | `matrixAnswerWarning` |
| `io.atum.status {version:1, code, details?}` | scheduled/standing line, never with `io.atum.result` | `matrixStatusLine` |

Every reader is closed: an unknown version, code or key, or a value out of bounds, means "show the
body". A descriptor must pair with the progress marker's `kind`/`phase`. Only the room's agent is
reworded (`agent` in `src/matrix/app.tsx`); a person carrying a marker is shown as written.

Result notices and answer warnings check the whole closed `io.atum.result` (the answer's required
`invocation`/`transaction`, the notice's optional identifiers and stop target) and refuse an
`io.atum.interim` sibling; anything malformed keeps the body.

Information guard: codes whose sentence names something are reworded only when their details carry
that fact (`failed` the routine title, `couldnt_confirm` and `resuming_on_device` the Macs,
`device_unreachable` the Mac and `resume`, `attachment_unsupported` the kind). An empty, unrelated or
partial details object keeps the body, unless the body is exactly the sentence those details give in
one of Atum's languages, so an event never loses a Mac, a routine name or a promise to resume.

## Rendering

- `matrixAgentLocalizedText` (shared) picks the words; `app.tsx` uses it for the notice and markdown
  branches, `typing-indicator.tsx` for the working line via `matrixProgressLineText`.
- Both read `locale` from `useI18n()`, so a language switch rewords existing events with no new event.
- The working line's header row is localized; checklist rows (`✓`/`•`) stay the agent's own text.

## Language report

`electron/matrix/owner-language.ts` adds `Atum-Language` + `Atum-Language-Source` to the roster read
that already carries `Atum-Time-Zone` (`MatrixAccount.agents`). `explicit` = the saved Matrix
account-data choice; `reported` = the supported system language, only when sync confirmed no choice
is saved (`displayPreferences.language.chosen === false`). A value is recorded only when
`Atum-Language-Ack` echoes it for the same account and sign-in generation; a reported value that
loses is not repeated in that sign-in; sign-out clears the record.

Each published snapshot calls `MatrixAccount.ownerLanguageChanged()`: when the synced language just
became known or changed and is not yet acknowledged, one roster read is requested through the same
request-and-sync path a wake uses (`refreshMatrixRosterOnLanguageChange`), not the quarter-hour
refresh. The renderer's optimistic pick is never reported; only the sync echo is. An observed change
from one known language to another drops the stored ack, and an ack for a report begun before that
change records nothing, so returning to a language acknowledged earlier still reports.

## Tests

`shared/matrix-agent-presentation.test.ts` runs the pack's vectors and accept/reject fixtures
(`shared/fixtures/agent-turns-v1.5`, see its PROVENANCE). Also `message.test.ts`,
`typing-indicator.test.tsx`, `app.test.tsx` ("words the agent's outcome…"), `owner-language.test.ts`,
`account.test.ts` (owner language on the roster read), `callback-page.test.ts`.

## Not done here

- Publishing descriptors from the Mac executor (`electron/matrix/main.ts`, `shared/matrix-turn-voice.ts`):
  the Mac still sends body-only lines. Until a sender emits descriptors, viewers show the body.
- Whole-panel catalog work for English-only settings surfaces (uninstall, billing, model settings,
  custom endpoints, MCP auth labels, profile display-name dialogs).
- When the pack is published, vendor it unchanged and point the tests at it.
