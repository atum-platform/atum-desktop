# Video generation: the one-time consent

Owner ruling (2026-11-17): video generation uses MiniMax, with a one-time consent the first
time an owner starts using it. Video prompts and input images go to MiniMax through
OpenRouter, and zero data retention is not available for that path. The owner's other chats
are unchanged. This document describes the desktop half. The platform owns the consent
record, the language it is recorded in, and every admission decision.

## Owner endpoint (v1)

Electron main calls `/api/media/video-generation/consent` with the MAS owner bearer, through
`account.s1Request`. This is the same path and auth as the ChatGPT training confirmation
(`docs/chatgpt-training-confirmation.md`). Every request sends
`X-Atum-Host-Bridge-Contract: atum.s2.host-bridge/1.0.0`.

- `GET` returns `{current, wordingVersion, provider:"minimax", providerModel, locale, confirmedAt, revision}`.
  The desktop reads `current` as true only for wording `minimax-video-v1`. `locale` (`en` or
  `vi`) is server-owned, and the card shows that language whatever the app's language is. A
  projection without a known locale, or for another provider, is not read. A failed read is
  "unavailable", never "not consented", and nothing is sent after it.
- `POST` sends exactly `{"wordingVersion":"minimax-video-v1"}`. It goes only after the person
  ticks the initially unticked box and presses Allow video. 400, 401, 403 and 409 (unknown
  wording) are "refused": the card says so calmly and offers no retry loop. A 503 is
  "unavailable": the tick is kept and the person may press again. A repeated POST while
  consent is current is a read on the server.
- `DELETE` with `Idempotency-Key: <UUID>` turns it off. The key is written before the first
  request to `<userData>/video-consent/<accountKey>/revoke-intent.json` (atomic, 0600). It is
  reused on every retry and after a restart, and cleared only by `200 {current:false}`.
  Activating an account loads only that account's key, and resumes it. While a turn-off is
  pending, Allow is refused locally.

Errors are `{"state":"refused"}` (400/401/403/409) and `{"state":"unavailable"}` (503).

Client: `electron/matrix/video-generation-consent.ts`. It shares its transport, its journal
and its revocation loop with the training confirmation, in `electron/matrix/owner-consent.ts`.
IPC kinds: `videoConsent`, `videoConsentAllow` and `videoConsentRevoke`
(`MatrixSubscriptionsBridge.videoConsent`, `allowVideoConsent` and `revokeVideoConsent`).

## Wording `minimax-video-v1`

The sentences live in `apps/desktop/src/matrix/video-consent-copy.ts`, character for
character. The platform hashes each one: SHA-256 over the UTF-8 sentence, with no quotes and
no trailing newline. The hashes are pinned in `src/matrix/video-consent-card.test.tsx`. Any
change needs a new wording version that the platform has agreed first.

| Sentence | SHA-256 |
| --- | --- |
| en checkbox | `c6a62b6ab9e77b2cf058c155b230005a2b4af01a91c27184fdc6185ada83a5ca` |
| en disclosure | `0f233f9f8402ed9dc5ed3e78370ac08ae1982ae865f1bcd257366648bb12f880` |
| vi checkbox | `8b1ddba977956f6eb18788f37a8cf103324340cb4c4ccc8c9ca419c60a65d1f1` |
| vi disclosure | `5edfc042a10c709893beb2f961fa06227cf62552ea7aac0b09c3b26b66e366ac` |

The buttons, title and states are app chrome. They follow the app's language (English
default, Vietnamese provided) and are not part of the hashed wording.

## When the desktop asks

The card appears only when an agent's video step was refused for want of consent:

1. The host refuses the video selection or key with
   `403 {"error":{"kind":"refused","code":"video_consent_required"}}`.
2. The host's `video_generate` call then returns the standard tool error with
   `error_type: "video_consent_required"`. The public tool and backends never produce that
   code themselves; the host's refusal mapping does.
3. The Matrix presentation extension sees it on `post_tool_call`
   (`plugins/platforms/matrix/presentation.py`, `video_consent_required()`). It sets the turn's
   transient line to `device`/`waiting` with the closed descriptor
   `io.atum.presentation {version:1, code:"video_consent_required", args:{}}` and an empty body.
   Only that closed code is read from the result: never its error text and never the prompt.
4. The desktop reads the descriptor (`shared/matrix-progress-marker.ts`). The typing row says
   "Waiting for you to allow video…", and the conversation latches the ask
   (`src/matrix/video-consent-ask.ts`). The card sits under the working line and outlives it.
   It first reads the consent: if it is current, nothing shows.

There is no other consent wall and no modal. "Not now" puts the card away for that line; the
next refused video step asks again. Once allowed, the card settles to one quiet line and
closes. Nothing is posted into the conversation, and the agent tries again on its own. The
desktop never shows a cost.

States: asking, saving, allowed (settles quietly), refused (calm, no retry loop), and
unavailable (Try again; for a failed read, no checkbox at all).

## Settings › Connections

The "Video generation" section has one MiniMax row with a switch. On shows when video was
allowed. Off starts the revocation and reads "Turning off…" until the platform's 200. If it
has not landed after a few rounds, the row says it is still turning off, and the next press
retries with the same key. Turning it back on shows the same explicit card under the row. A
failed read shows "Couldn't check this right now." with Try again, never "off".

## Verification

- `electron/matrix/video-generation-consent.test.ts`: headers and path, strict reads, the
  exact POST body, refusal mapping, and the key reused across 503s and a restart, per owner.
- `src/matrix/video-consent-card.test.tsx`: trigger, gating, states, server locale, pinned
  hashes, put-away, and that nothing but the consent calls is used.
- `src/matrix/video-consent-settings.test.tsx`: the switch, "Turning off…", resume, and that a
  failed read is never shown as off.
- `tests/plugins/matrix_presentation/test_admission_presentation.py`: the code on the line,
  only for that error type, and with no words.
