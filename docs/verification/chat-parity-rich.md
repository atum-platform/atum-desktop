# Desktop rich content parity

The build compares against the pinned chat parity audit, with independent Atum UI and fixtures. Reference revisions are Element X iOS `183bbc7f0419bf76ae46d52f448c44eb14fe1069` and Android `20ad9664790111e5558d4610f9fb05d6cc1efcc2`.

| Slice | Scenario from the reference audit | Expected outcome |
| --- | --- | --- |
| S6 | Recorder and playback. Start with microphone access, record a note, review or cancel, and play the sent note. | An audio message with voice metadata is playable and cancellation sends nothing. |
| S12 | Poll form and timeline. Answer a running poll, change selections, and end it. | The latest vote counts and a closed poll shows final results. Undisclosed results stay hidden while open. |
| S13 | Location sharing and sticker rows. Receive a static point and a sticker from another member. | The point opens on a map and the received image shows the sticker description to assistive technology. |

## Desktop behavior

- The empty send slot starts recording. Dictation keeps its own microphone control. A recording stays in memory and can be discarded before or after stopping. Review shows the waveform and playback position. Sending is a separate action.
- Recording is limited to 120 seconds and uses a 500 ms minimum. Electron 44.10.1 rejected native Ogg recording and produced WebM/Opus. The fallback decodes locally and encodes mono Ogg/Opus with `@audio/encode-opus@1.3.2`. It is loaded only for the fallback. The release resource directory ships the exact MIT and libopus BSD notices and the MIT notice for the locked `@audio/resample-polyphase@1.1.0` dependency.
- Notes are standard MSC3245 audio. The SDK sends them in personal people chats through the same trust, upload and encryption path as other attachments. Inline playback downloads authenticated media by event ID. An encrypted room sends an encrypted file descriptor and stores ciphertext. Clients without voice UI can still handle the standard audio attachment.
- Playback is available for incoming voice notes regardless of origin. Recording sends are held for recognized Atum assistant DMs, app bots and groups containing a known assistant. The receiving gateway currently supports STT provider autodetection when no explicit provider was selected, so activation for assistant conversations requires the receiving consent guard. The recorder has no provider operation.
- Polls use the SDK poll model and `m.reference` relations. The pinned Rust SDK creates the unstable MSC3381 spelling for start, response and end, which the JS SDK also sends. Results count the latest vote per sender, hide undisclosed tallies until close and wait for complete, decryptable results. The composer creates single-choice polls and accepts votes on polls with multiple choices. It uses Atum Kit controls pending M5 review.
- A location is a static pin entered as coordinates. The SDK includes the legacy `geo_uri` and extensible fields. Opening a pin uses Maps on macOS and OpenStreetMap elsewhere. The app requests no location permission. Incoming stickers use authenticated image media and the event description as alt text, with a text fallback.
- The composer offers new poll and location sends in personal people chats. Team Space keeps its current attachment policy and displays received rich content. Thread replies and sticker selection are outside this lane's composer work.

## Verification

The focused suite exercises recorder cancellation, review before sending, refusal recovery, Matrix voice metadata, encrypted attachment bytes and recipient decryption, new poll votes and votes synced from another sender, close, hidden results, location projections and sticker alt text. A standalone Electron 44.10.1 probe decoded independently generated Ogg/Opus and decoded the renderer's converted recording. `ffprobe` identified the converted file as Ogg/Opus.

Live interop remains for the coordinator. In a two-member room, exchange one note in each direction with Element X, then repeat in an encrypted room. Compare a vote change and a poll close in both clients. Open a received pin and inspect a received sticker. Verify the deployed assistant receiving gate with a provider spy before enabling assistant-room sends.
