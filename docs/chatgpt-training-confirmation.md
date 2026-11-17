# ChatGPT with Google data: the training-off confirmation

Cloud assistants can answer with the owner's ChatGPT plan. OpenAI's sign-in terms keep
the ChatGPT tokens on the owner's device, so these calls go through the owner's Mac (the
existing desktop ChatGPT relay). When an assistant uses Google data, the platform also
needs the owner's one-time confirmation that ChatGPT training is off. This document
describes the desktop half. The platform owns the record and all admission decisions.

## Shell contract (r3)

`/api/connections/openai-codex/training-confirmation` is called by Electron main with
the MAS owner bearer, through `account.s1Request`. This is the same path the carry route
uses (`electron/matrix/chatgpt-carry.ts`). Every request sends
`X-Atum-Host-Bridge-Contract: atum.s2.host-bridge/1.0.0`.

- `GET` returns `{current, wordingVersion, connectionId, confirmedAt, revision}`. The
  desktop reads `current` as true only for wording `chatgpt-google-v1`. A failed read is
  "unavailable", never "not confirmed".
- `POST {wordingVersion:'chatgpt-google-v1', connectionId, transferWordingVersion:'chatgpt-google-transfer-v1'}`
  is sent only after the person ticks the box and presses Confirm. A 409 means the relay
  connection changed. The card then reads the status again, unticks the box and asks again.
- `DELETE` carries a UUID `Idempotency-Key`. A 503 means live relay calls are still
  draining, so the desktop retries with the same key after a short backoff. Only
  `200 {current:false}` ends the revocation.

Client: `electron/matrix/chatgpt-training-confirmation.ts`. Its transport, revoke journal
and revocation loop are shared with the video-generation consent in
`electron/matrix/owner-consent.ts` (`docs/video-generation-consent.md`). IPC kinds:
`subscriptionChatGptTraining`, `subscriptionChatGptTrainingConfirm` and
`subscriptionChatGptTrainingRevoke` (`MatrixSubscriptionsBridge.chatGptTraining`,
`confirmChatGptTraining` and `revokeChatGptTraining`).

## Revocation survives a restart

The pending DELETE key is written before the first request to
`<userData>/chatgpt-training/<accountKey>/revoke-intent.json`. This follows the same
account-scoped intent-journal pattern as checkout and the store: an atomic 0600 write
through `writeFileAtomicSync`, and the key must be a 64-hex account key. If the key
cannot be persisted, no DELETE is sent. The key is reused on every retry, including after
refusals, and the file is cleared only by `200 {current:false}`. When an account becomes
active, main loads only that account's key. If one exists, main resumes the DELETE with
that same key and reports `revoking: true`. Settings then shows "Revoking…" and waits on
the same flight. While a revocation is pending, a confirm is refused locally. The desktop
does not rely on the platform accepting a different key for a pending fence.

## When the desktop asks

The confirmation is `required` when the account has Google connected now, or when the
owner's Google fence (`io.atum.google_fence`) has ever been observed. Server-side latches
stay authoritative. The question appears inside the existing model picker card, in place
of the list column (`ModelPickerPanel` `takeover`), when a ChatGPT-plan model is chosen
for a cloud assistant while confirmation is required and not current. There is no modal
and no second picker. Confirm stays disabled until the box is ticked. "Keep protected
model" returns to the list with the saved model unchanged. Once a pick is confirmed, it
is written through the existing `modelDestinations.writeSubscription` path.

The checkbox and transfer sentences live in `src/matrix/chatgpt-training-copy.ts`. Each
matches the platform's hashed wording character for character (EN and VI). Other
locales show the English wording, which is how the platform records them. Change these
sentences only together with a new wording version.

## Relay identity

The confirmation is bound to the platform's relay `connection_id`:

- Same-device republication keeps the connection: start-up, model refresh and repair
  retries all call `enable()`.
- Before a new ChatGPT sign-in starts, a relay this Mac still serves is disabled
  (`retireMatrixChatGptRelayForSignIn`).
- After a sign-in completes, the follow-up repair publishes a fresh session
  (`MatrixSubscriptionFollowUpRepair.renew()` → `enable(..., { fresh: true })`). That
  call reads the relay, disables it and then enables it. If the read or the disable
  fails, the new account is never published, and the retries stay fresh.
- Disconnect disables the relay before the native disconnect and before the credential
  is forgotten (`disconnectMatrixSubscriptionChatGpt`).

Signing out of the Atum account does not change the local ChatGPT credential, which is
scoped to that account. It therefore leaves the relay connection alone.

## Unavailable states

These were already built (owner 2026-11-11), and this change reuses them:

- ChatGPT rows grey out with a one-line reason when no relay Mac is online
  (`shared/matrix-subscription-availability.ts`).
- The composer chip shows a red warning when the saved pick cannot answer.
- A reply answered by a fallback model gets a faint line
  (`src/matrix/subscription-fallback-line.tsx`).

No surface shows a cost.
