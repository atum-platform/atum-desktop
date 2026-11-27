# Assistant voice notes

Cloud assistant chats with Hermes voice transcription use the same Ogg/Opus recording and playback as people chats. Send checks the assistant’s current Matrix profile for `io.atum.voice_transcription_provider`. If this provider needs the sender’s permission, the composer shows “Transcribe with <provider>?”. OK grants permission and sends the draft. Not now dismisses the prompt and leaves the draft playable. An unavailable provider leaves the draft in the composer.

Consent is private to the signed-in Matrix user and syncs through account data. Each assistant and provider pair has its own event type, `io.atum.voice_transcription_consent.<sha256>`. The suffix hashes the UTF-8 bytes of the compact JSON array `[assistantMatrixUserId, provider]`. The content is `{"allowed":true}`. A sent voice message carries the approved provider ID in `io.atum.voice_transcription_provider` so the receiving gateway can enforce the same choice.

The composer and SDK regression tests exercise the inline prompt, deferred send, repeat send, and a provider change between the prompt and OK.
