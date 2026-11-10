# Native interim delivery

Hermes emits `message.interim` with `text` and `already_streamed`. Both native
callbacks meet at `tui_gateway.server._event_frame`, which projects display text
through `agent.history_commentary.visible_commentary` in the owning session's
runtime scope. That native helper strips thinking and calls
`agent.redact.redact_sensitive_text`, preserving profile-scoped secret policy.
Provider replay/history and final answers are untouched.

The Matrix adapter accepts native `text` and the legacy `redacted_text`
projection (including explicit blank suppression). It never reads reasoning.
Interim deduplication, session/turn fences and progress cleanup remain in their
existing owners. Producers and consumers must be released together.

The offline regression `matrix-native-interim.test.ts` drives a fake provider's
content-plus-tool, empty tool-only and final responses through the real Hermes
normalizer, interim callback and JSON-RPC framing into a fake Matrix publisher.
Run with the repository Python dependencies available via `PYTHON` and desktop
Vitest. It checks one interim before the final, secret/analysis suppression and
empty/duplicate-round suppression. Existing Matrix suites cover fences and cleanup.

Verification on this change: suites/typecheck deferred because available disk
space was below the required 4 GiB minimum. The public outbound guard is checked
separately before handoff. This change is built, not deployed.
