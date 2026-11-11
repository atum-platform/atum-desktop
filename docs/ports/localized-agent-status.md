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

Compatibility guard: codes whose sentence names something (`failed`, `couldnt_confirm`,
`resuming_on_device`, `attachment_unsupported`, `device_unreachable`) are reworded without details
only when the body is exactly that code's plain sentence in some locale, so an older event never
loses a Mac or routine name.

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
