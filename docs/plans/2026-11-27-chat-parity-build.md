# Chat parity build plan · 27 November 2026

This plan turns the parity audit in [2026-11-27-chat-parity-audit.md](2026-11-27-chat-parity-audit.md) into slices that Codex workers can build in parallel. It is a plan only. Astra reviewed the pinned plan at `8f36d2d3b1`. Dispatch follows §3.2.

**Authorization.** Owner, 2026-11-27: "chat parity: go with Astra's recommnedations. If there's no plan yet, then opus plan and astra review, then send out to codex workers to build. As the workers build, they should compare their code to Element X as tight reference." The owner approved every default the audit recommended (§1.2).

## 1. Scope

### 1.1 Build now, in priority order

The order is the audit's ranked gap list, with the deferred items held out. Gap 15 has separate desktop and phone owners (S16). Encrypted search (S2) is split out of gap 1, because it depends on the plain search UI and needs its own custody rules.

| # | Slice | Audit gap | Surfaces |
| --- | --- | --- | --- |
| S1 | Cross-chat search, plain rooms | 1 | desktop, phone, platform check |
| S2 | Local index for encrypted history | 1 | desktop, phone |
| S3 | Portable notification modes | 2 | desktop, phone, platform check |
| S4 | Threads in human groups | 3 | desktop, phone, platform config |
| S5 | Shared pins outside Team Space; writable pins on phone | 8 | desktop, phone |
| S6 | Recorded voice notes | 4 | desktop, phone, platform check |
| S7 | Phone SAS verification | 5 | phone |
| S8 | Phone-first cross-signing and key backup | 6 | phone |
| S9 | Opt-in private people chats at creation | 7 | desktop, phone |
| S10 | Message forwarding on phone | 9 | phone |
| S11 | URL cards on phone | 10 | phone, platform check |
| S12 | Actionable polls | 11 | desktop, phone |
| S13 | Static location; incoming stickers | 12 + sticker disposition | desktop, phone |
| S14 | Room-wide mentions on phone | 13 | phone |
| S15 | Room-upgrade continuity | 14 | desktop, phone |
| S16 | Unread and favourites list filters | 15 | phone, desktop tracked in [PR #154](https://github.com/atum-platform/atum-desktop/pull/154) |

S5 sits next to S4 because both open the same room-type gate (§2.4). Its rank among user needs stays where the audit placed it.

### 1.2 Owner-approved defaults the slices follow

- **Threads:** human groups come first, including groups with an explicitly invited assistant. Personal assistant DMs, app-bot rooms and Notes stay flat.
- **Search:** covers all accessible personal and company chats, labelled by source. The device indexes encrypted history locally and shows how much it covers.
- **Encryption choice:** offered when creating a human DM or group, only after two-device verification and recovery pass. Chats stay plain by default. Assistants are not admitted to private rooms.
- **Notifications:** homeserver push rules govern delivery. Atum's thread follow, quiet hours and assistant-activity preferences stay layered on top in account data.
- **Voice notes:** a standard MSC3245 audio event. Audio goes to a transcription provider only with consent. Enabling that provider for the assistant counts as consent.
- **Deferred:** space administration, knocking, live location, MatrixRTC calls, administrator-initiated room upgrades, sticker-pack picking and desktop Sliding Sync. The Sliding Sync item stays a separate performance measurement.
- **Reuse:** build on the licensed SDKs: matrix-js-sdk 42.4.0 on desktop, matrix-rust-sdk through Atum's Swift package on phone, both Apache-2.0. The Atum UI is written independently.

### 1.3 Pinned references

Every Element X link below is pinned to the audit's revisions. These links are behaviour references only (§4).

- Element X iOS `183bbc7f0419bf76ae46d52f448c44eb14fe1069`: prefix `EXI` = `https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/`
- Element X Android `20ad9664790111e5558d4610f9fb05d6cc1efcc2`: prefix `EXA` = `https://github.com/element-hq/element-x-android/blob/20ad9664790111e5558d4610f9fb05d6cc1efcc2/`
- matrix-rust-sdk `e048e09adcb8bed06aa512c446052423aeed6ac6`: prefix `RS` = `https://github.com/matrix-org/matrix-rust-sdk/blob/e048e09adcb8bed06aa512c446052423aeed6ac6/`
- Atum desktop `e926a75606e4ccb9cd8ec5dfbefff3c013d37bf5`: paths are relative to `apps/desktop/`
- Atum phone (atum-mobile-client) `f9231683f80bc378b79299a43ea14af713be548b`: paths are relative to `ios/`
- Matrix Client-Server API v1.19: `https://spec.matrix.org/v1.19/client-server-api/`

Line numbers come from these pins. Workers re-locate them on current `main` before editing.

**Phone SDK.** Keep Atum’s **26.10.15-atum.2** at `66c18d378d44d9ad61946f08b926514cccb14fb5`. The generated Swift interface already declares searchService, runSearchBackfill, threadListService, timelineWithConfiguration, pinEvent/unpinEvent, notification settings, sendVoiceMessage, poll operations, sendLocation, getUrlPreview, verification, recovery and successor/predecessor access. Use its signatures. The newer Element X pin is a comparison reference. Link and exercise each feature against Atum’s selected binary. Bring a specific missing capability to the coordinator only after compiling or exercising it, and continue independent work. [Selected Swift interface](https://github.com/atum-platform/atum-matrix-rust-components-swift/blob/66c18d378d44d9ad61946f08b926514cccb14fb5/Sources/MatrixRustSDK/matrix_sdk_ffi.swift)

## 2. Slices

Every slice has three parts: native mapping first, then the exact seams, then a behaviour comparison. Each "Element X reference" lists the audit evidence for the black-box comparison in §4. Each acceptance list states behaviour, not implementation.

### S1 · Cross-chat search, plain rooms

**Goal.** Find an assistant's earlier answer without remembering which chat it was in. Results reopen at the exact event.

**Native mapping.** Server-side search, spec §Server Side Search (`POST /_matrix/client/v3/search`, `room_events`, `filter.rooms`). This needs no new search engine.

**Desktop (atum-desktop).**
- `src/matrix/roster-global-search.ts`: the roster controller already merges the `people`, `messages` (company) and `files` sources with generation fencing. Add one `personal` messages source. Do not build a second controller.
- `src/matrix/company-message-search.ts:299` `searchCompanyMessages`: follow its validation and coverage shape (`coverage: { eligibleRooms, searchedRooms, truncated, source }`). Add a sibling `searchPersonalMessages` in a new `src/matrix/personal-message-search.ts`. Its room set is the joined, non-encrypted personal rooms shown in the roster: assistant DMs, people DMs, groups and app chats. Leave out ignored senders, and leave out rooms the user has left, since the filter uses current membership.
- SDK: `client.searchRoomEvents({ term, filter })` and `client.search({ body })` for pagination with `next_batch`, as the company search already does at `company-message-search.ts:370`.
- Open a result through `revealMatrixHistoryMessage` in `src/matrix/history-search.ts:20`, using the SDK event-ID context lookup (`client.getEventTimeline`, already used in `message-commands.ts`) when it falls outside the loaded window. Keep bounded text search for searching within a chat.
- The roster result list lives in `src/matrix/roster-conversations.tsx`, the same surface as PR #154's filter.

**Phone (atum-mobile-client).**
- `App/Home/HomeGlobalSearch.swift` is the home search surface. Add a personal messages section next to the existing kinds.
- Reuse the request path the company search uses in `App/Company/CompanySpaceMatrix.swift:55` for `/search` over personal plain rooms. The Rust FFI at this pin exposes no server `/search`, so this path stays Atum's authenticated request.
- Route the result by room and event ID, rechecking membership at open. For an unloaded event use the SDK’s event-focused timeline, then scroll to that ID. Searching the snippet again can land on a duplicate.

**Platform.** Confirm the deployed Synapse `/search` covers personal rooms. Search is on by default. Record the result. No code is expected.

**Element X reference.** `EXI ElementX/Sources/Screens/SearchScreen/SearchScreenViewModel.swift`, `EXI ElementX/Sources/Screens/SearchScreen/View/SearchScreenMessagesNoResultsView.swift`, `EXA features/home/impl/src/main/kotlin/io/element/android/features/home/impl/search/GlobalSearchPresenter.kt`. Compare query debouncing, empty and no-result states, how a result opens the room at its event, and grouping by room.

**UI.** Use mockup M1. Results group by chat, one line per hit: sender, snippet with the match highlighted, time. Source labels say Personal or the company name. A single quiet coverage line sits at the foot, such as "Searched 42 chats". Nothing more.

**Acceptance.**
1. Account A sends "invoice 1042" in a personal assistant DM, a people group and a company channel. Searching "invoice" from account A's roster returns all three, labelled by source, and selecting one opens the chat scrolled to and highlighting that event.
2. After A leaves the group, the group's hit no longer appears.
3. A hit older than the loaded window still opens at the exact event.
4. Encrypted rooms never appear in a `/search` `filter.rooms`, and the coverage line counts them as not searched.
5. The same corpus gives the same hits on phone. Empty or unknown room scope makes no server request. Recheck current room eligibility before displaying and opening results.

**Estimate.** Desktop 3–4 d · Phone 4–5 d · Platform 0–0.5 d.

### S2 · Local index for encrypted history

**Depends on:** S1, which supplies the result model, UI and coverage line.

**Goal.** Encrypted chats that this device can decrypt become searchable. Private search terms and decrypted content stay on the device. History backfill can fetch ciphertext.

**Native mapping.**
- **Phone:** the matrix-rust-sdk local search service. `Client::search_service()` at `RS bindings/matrix-sdk-ffi/src/search_service.rs#L43` provides `set_query` (`#L59`), `paginate` (`#L65`) and `subscribe_to_results` (`#L91`), backed by `crates/matrix-sdk-search` (Tantivy, with an encrypted directory). Its `experimental-search` feature is in the FFI default features at this pin. Check that Atum's Swift package exposes it (§1.3).
- **Desktop:** first prove the encrypted store in [@matrix-org/seshat](https://github.com/matrix-org/seshat/tree/main/seshat-node) can open, index one decrypted event, reopen and wipe in the packaged Electron runtime. Use an account/device-scoped random key protected by Electron safeStorage with a secure OS backend. If packaging or key protection fails, fall back to searching already-loaded decrypted messages in memory. Label that coverage explicitly and leave persistent desktop history indexing open.
- **Phone:** configure `withSearchIndexStore(path:key:)` with a non-nil device-protected key. Use SDK backfill and results, limited to joined eligible rooms. Reuse session teardown for the index and its key.

**Search boundary.** Private search is an explicit device-only scope in M1. Select it **before typing**. Fence and cancel pending remote-source queries on scope change, clear the prior query, and keep private input away from roster people, company, file and server searches. Plain search is a separate scope. Coverage identifies loaded or indexed history. An account change, room leave, redaction, local deletion or sign-out must remove access to the affected results.

**Desktop seams.** Start with the existing human SDK event stream. If the packaging proof passes, pass only scoped decrypted events and deletions to the main-process store. Index live or already-loaded history first. Defer a background crawler until there is a measured coverage need. On phone use `HomeGlobalSearch.swift` for presentation and the existing SDK builder for key and store ownership.

**Element X reference.** `EXI ElementX/Sources/Services/Search/SearchServiceProxy.swift`, `EXI ElementX/Sources/Screens/SearchScreen/View/SearchScreenHistoryLimitSheet.swift`, `EXA libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/search/RustSearchBackfillService.kt`. Compare how coverage and history limits are disclosed, and the backfill pacing.

**UI.** Add the device-only scope to M1. Report the actual private history available on this device. Private hits carry a small lock glyph.

**Acceptance.**
1. A message decrypted on this device in an existing encrypted room is found by search, and opening it reveals the event.
2. Sign-out, then sign back in: the old index is gone and rebuilds.
3. Leaving the room removes its hits.
4. Network capture during a search shows no request carrying the term for encrypted rooms and no decrypted text.
5. The coverage line reflects actual history. A unique private query produces zero network requests carrying that term across **all** sources. Redaction and local deletion remove the affected hits.

**Estimate.** Desktop 5–8 d · Phone 4–7 d (plus a bindings bump if needed) · Platform 0.

Keep S1’s plain search contract. Replacing it with the phone index is outside S2.

### S3 · Portable notification modes

**Goal.** Silence a busy group but still hear direct mentions. The choice holds on every device and in other Matrix clients.

**Native mapping.** Spec §Push Notifications, push rules. The three room modes are All, Mentions and keywords, and Off:
- Off: an `override` rule `rule_id = roomId`, condition `event_match room_id`, `actions: []`. This suppresses even mentions. JS SDK 42.4.0’s `setRoomMutePushRule` writes a room-kind `dont_notify` rule and cannot implement Off.
- Mentions: a `room` rule `rule_id = roomId`, `actions: []`, with the default `.m.rule.is_user_mention` and `.m.rule.is_room_mention` overrides still firing.
- Explicit All: a `room` rule with `notify`. Restore Default removes the room-specific mode and reads the effective DM/group and encryption default.

This follows the matrix-rust-sdk model: `RoomNotificationMode::{AllMessages, MentionsAndKeywordsOnly, Mute}`.

**Desktop seams.**
- `src/matrix/sdk.ts:3764` already calls `client.setRoomMutePushRule('global', roomId, muted)`. Add a `roomNotificationMode` command next to it using `client.addPushRule` and `client.deletePushRule` for the appropriate rule kind, replacing the previous mode as the Rust SDK does. Route existing mute entry points through the same operation. Read the mode back from `client.pushRules` and refresh on `ClientEvent.AccountData` for `m.push_rules`, so a change made in another client appears live.
- `src/matrix/notifications.ts:104–123` currently lets Team Space policy promote an event when the SDK says no notification. Require a positive SDK push decision first. Thread and assistant settings and quiet hours may narrow presentation. Update the contrary comment in `notification-policy.ts`. Accept homeserver unread/highlight semantics and verify them alongside delivery.
- Preserve existing explicit native modes. For legacy Atum-only overrides retain their current local suppression until the user next selects or restores a room mode, then retire that legacy entry. No bulk remote writes on sign-in. Test that restoring a default in Element cannot resurrect an old local override after conversion.

- UI entry points: `src/matrix/notification-level-menu.tsx` (Team Space menu, already offers inherit, all, mentions, nothing), `src/matrix/conversation-menu.tsx` for ordinary chats.

**Phone seams.**
- `App/LiveMatrixSession.swift:729` currently mutes and unmutes. Replace it with `Client::get_notification_settings()` (`RS bindings/matrix-sdk-ffi/src/client.rs#L1997`): `set_room_notification_mode` (`notification_settings.rs#L524`), `get_room_notification_settings` (`#L496`), `restore_default_room_notification_mode` (`#L607`) and the `set_delegate` change callback (`#L467`).
- The chat info row lives in `App/Chat/Views/ChatInfoSheet.swift`.
- The pusher stays event-ID-only (`App/MatrixLiveRuntime.swift:253`). The homeserver applies the rules before pushing.

**Platform.** Confirm that Synapse evaluates room and override rules before calling the push gateway, and that event-ID-only pushes are suppressed for a mentions-only room on a non-mention. Record the result.

**Element X reference.** `EXI ElementX/Sources/Screens/RoomNotificationSettingsScreen/RoomNotificationSettingsScreenViewModel.swift`, `EXI ElementX/Sources/Services/NotificationSettings/RoomNotificationSettingsProxy.swift`, `EXA features/roomdetails/impl/src/main/kotlin/io/element/android/features/roomdetails/impl/notificationsettings/RoomNotificationSettingsPresenter.kt`, `EXA libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/notificationsettings/RustNotificationSettingsService.kt`. Compare default versus user-defined mode, "restore default", encrypted-room mention caveats (`can_push_encrypted_event_to_device`) and live refresh.

**UI.** Mockup M6 (light): three options with one-line hints. Thread and assistant preferences stay where they are.

**Acceptance.**
1. Set Mentions on desktop. On phone, the setting reads Mentions within one sync. A plain group message produces no phone push, and an @mention of the user does.
2. Set Off on phone. Desktop shows Off, and Element X shows the same room mode.
3. A followed Team Space thread with a quieter thread override keeps that override after the room mode changes.
4. An existing legacy preference remains quiet until explicitly changed. After conversion, switching from Off to All and then restoring an inherited Mentions default in Element updates Atum and delivery without reviving the legacy value.

**Estimate.** Desktop 2–3 d · Phone 3–4 d · Platform 0.5–1 d.

### S4 · Threads in human groups

**Goal.** Branch a long assistant answer and rejoin the main discussion in ordinary groups.

**Shared eligibility rule.** Both clients implement the same rule. A room is thread-eligible when the existing group classification says it is a human group, including one with an explicitly invited assistant. Assistant DMs, app-bot rooms, Notes and 1:1 people DMs are not eligible in this tranche. Team Space rooms keep today's behaviour. Reuse the existing classification (`readGroupRoom` at `src/matrix/assistant-room.ts:673`, the roster's group section, and `Sources/AtumChat/ChatRoomNaming.swift` and `ChatPanelPolicy.swift` on phone). Do not introduce a new room type.

**Native mapping.** Spec §Threading (`m.thread` relation, `is_falling_back`) and §Threaded read receipts. On desktop, the human SDK instance already runs with `threadSupport: true` (`electron/matrix/sdk-host.ts:87–88`), and the calls are `room.getThreads()`, `room.getThread(rootId)`, `client.sendMessage(roomId, threadId, content)`, `ThreadEvent.Update` and thread-aware `client.sendReadReceipt`. On phone: `Room::timeline_with_configuration` with thread focus (`RS bindings/matrix-sdk-ffi/src/room/mod.rs#L254`), `Room::thread_list_service` (`#L1426`, `timeline/threads.rs` `ThreadListService` `paginate` and `items`), and `set_thread_subscription` (`#L1385`).

**Desktop seams.**
- `src/matrix/sdk.ts:1158–1190`: today's snapshot flattens thread replies for ordinary rooms and builds `threads` only for company room types. Swap the type check for the eligibility rule, and stop flattening eligible rooms.
- `src/matrix/app.tsx:5747` `openThread` is gated on `teamSpaceRoom`; widen it with the same rule. `MatrixThreadPanel` at `app.tsx:4848` is reused as is.
- `src/matrix/threads.ts` already owns the native calls: `sendMatrixThreadReply` (`:200`), `readMatrixThread` (`:271`), `setMatrixThreadFollow` (`:233`), `matrixThreads` (`:411`). Reuse them and widen their company-only write guard for joined eligible groups. Apply the same rule to the thread summary, panel mount and send/read actions; keep the company-wide inbox company-scoped.
- Assistant replies: the local engines keep `threadSupport=false` intake (`sdk-host.ts:87`). Make sure a trigger inside a thread carries its `m.relates_to` thread root into the turn, so the reply lands under that root (`src/matrix/group-turns.ts`).

**Phone seams.** `App/Company/CompanyThreadsMatrix.swift`, `CompanyThreadsReads.swift:123` and `CompanyThreadsViews.swift` are Team Space only. Move the room-agnostic parts into `App/Chat/Threads/` and keep the Team Space call sites working. Add the entry point in `App/Chat/Views/ChatScreen.swift` and the message menu (`Sources/AtumChat/MessageMenuRules.swift`) for eligible rooms only. Add thread focus in `App/Chat/SDK/SDKTimelineSource.swift`, in a new focused-timeline initializer only.

**Platform.** The cloud agent's Hermes Matrix adapter already reads `m.thread` (atum-app `plugins/platforms/matrix/adapter.py:2755`) and replies in the thread. Its synthetic-root decision is adapter-wide: `session_scope=thread` also forces a root when auto-threading is off. Keep ordinary top-level group turns flat, preserve explicit incoming thread roots and existing Team Space and DM behaviour. PL1 checks the **deployed adapter version** and agent/profile scope. Use the existing `auto_thread=false` with compatible scope only where the profile serves the intended groups. For mixed-room profiles, record the necessary room-classification change in atum-app and gate assistant acceptance on it. Avoid a global default flip or a new user setting.

**Element X reference.** `EXI ElementX/Sources/Screens/ThreadTimelineScreen/ThreadTimelineScreenViewModel.swift`, `EXI ElementX/Sources/Screens/RoomThreadListScreen/RoomThreadListScreenViewModel.swift`, `EXI ElementX/Sources/Screens/Timeline/View/Threads/TimelineThreadSummaryView.swift`, `EXI ElementX/Sources/Services/Room/RoomThreadListServiceProxy.swift`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/threads/list/ThreadsListPresenter.kt`. Compare the root summary (reply count, last reply), opening from a summary, sending inside the thread, thread read state versus the main marker, and the fallback reply for non-thread clients.

**UI.** Mockup M2. On desktop, the existing Team Space thread panel appears in ordinary groups, with a compact "N replies" summary under the root. On phone, the thread opens as a pushed screen.

**Acceptance.**
1. Desktop starts a thread on an assistant answer in a group. A phone reply appears in the same thread, and Element X reads it back in the thread.
2. Reading the thread does not move the main timeline's fully-read marker.
3. A top-level mention of an invited assistant gets a top-level reply. Mention it under an explicit root and its reply carries that same root.
4. Assistant DMs show no thread affordance.
5. Older clients see the fallback reply.

**Estimate.** Desktop 3–5 d · Phone 4–6 d · Platform 0.5–1 d.

### S5 · Shared pins outside Team Space; writable pins on phone

**Depends on:** S4 in the same lane, for file ownership only.

**Native mapping.** Spec §`m.room.pinned_events` state. Desktop: `changeMatrixMessagePin` (`src/matrix/pinned-events.ts:87`) already writes, and `room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId)` checks power. Phone: `Timeline::pin_event` and `unpin_event` (`RS bindings/matrix-sdk-ffi/src/timeline/mod.rs#L967`, `#L977`), with the list read from room info and a pinned-events timeline focus.

**Desktop seams.** `src/matrix/sdk.ts:1180` builds `pinnedMessages` for company types only. Apply the S4 eligibility rule, plus people DMs, since pins are cheap and shared. The panel is `src/matrix/team-space/pinned-panel.tsx`, reused. The helper already reads synced state before writing the whole list. Matrix state has no compare-and-swap for simultaneous writers.

**Phone seams.** `App/Company/CompanySpaceMatrix.swift:93` lists pins only. Add pin and unpin to `MessageMenuRules.swift` behind the power check, and show the list in a shared view.

**Element X reference.** `EXI ElementX/Sources/Screens/PinnedEventsTimelineScreen/PinnedEventsTimelineScreenViewModel.swift`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/pinned/list/PinnedMessagesListPresenter.kt`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/pinned/banner/PinnedMessagesBannerPresenter.kt`.

**UI.** Existing kit with no mockup. People without permission see the list but no pin action.

**Acceptance.**
1. A pin set on phone appears on desktop and in Element X.
2. After another client’s pin or removal syncs, changing a different pin preserves it. For truly simultaneous writes, both clients converge to homeserver state; document the lost-update limitation. No lock service.
3. After demotion below the required power level, the pin action disappears, and a stale write fails gracefully.

**Estimate.** Desktop 1–2 d · Phone 1–2 d.

### S6 · Recorded voice notes

**Goal.** Record, review, cancel and send a playable voice note next to dictation, which stays as it is. Notes play on both devices and in Element X.

**Native mapping.** MSC3245: `m.room.message` with `msgtype: m.audio`, `org.matrix.msc3245.voice: {}`, `org.matrix.msc1767.audio: { duration, waveform }` and `info.duration`, through the content repository (§Content repository). For interop, the encoding target is Ogg Opus (`audio/ogg`). On phone: `Timeline::send_voice_message` (`RS bindings/matrix-sdk-ffi/src/timeline/mod.rs#L607`).

**Desktop seams.**
- A new `src/matrix/voice-note/` holds the recorder state machine (idle, recording, review, sending), the waveform sampler and the player.
- Target genuine Ogg/Opus on the wire. Probe native Ogg/Opus recording and inspect the resulting container before selecting a dependency. If Electron produces WebM/Opus, prefer a single maintained permissive remuxer that keeps the Opus frames. On iOS try native Opus capture with a compatible Ogg container writer. Use a pinned, licensed encoder/container library only where native output fails the two-way playback check. Avoid a general transcoder, hand-built codecs and MIME relabelling.
- Send through the ordinary attachment operation (`sdk.ts`, case `attach`) with voice metadata. It enforces room trust and encrypts the **file bytes** for encrypted rooms. A bare media upload followed by an encrypted message exposes the audio.

- Composer entry: `src/matrix/composer-plus.tsx` and `composer-dock.tsx`. Rendering: admit voice in `src/matrix/message.ts` (`:437` gate) and render the player in the message row.
- Transcription consent: `electron/matrix/voice.ts:134` is the existing transcription service. A voice note sent to an assistant room is a plain audio event. If that assistant has no speech-to-text enabled, require explicit consent before provider transfer. Prefer the existing assistant speech-to-text setting or a deliberate transcribe action; sending audio alone supplies no consent.

**Phone seams.** `App/Chat/Views/Composer.swift`, next to `App/Chat/Dictation/ComposerDictation.swift`. A new `App/Chat/VoiceNote/` holds the `AVAudioRecorder` lifecycle, native capture and the smallest necessary Ogg/Opus packaging step, waveform and player. Mapping goes in `App/Chat/SDK/ItemMapper.swift:219` (detect the voice flag), with the row in `App/Chat/Media/MediaRows.swift`. Microphone permission is requested only on first record.

**Platform.** Verify the actual receiving Hermes adapter gates provider transfer before transcription, including for an invited assistant in a group. An unset or disabled provider leaves an ordinary playable note. Use a local spy for this check.

**Element X reference.** `EXI ElementX/Sources/Screens/Timeline/View/VoiceMessageRoomPlaybackView.swift`, `EXI ElementX/Sources/Screens/Timeline/View/TimelineItemViews/VoiceMessageRoomTimelineView.swift`, `EXI ElementX/Sources/Other/VoiceMessage/VoiceMessageButton.swift`, `EXI ElementX/Sources/Services/Audio/AudioConverter.swift` (behaviour of format conversion only), `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/voicemessages/composer/DefaultVoiceMessageComposerPresenter.kt`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/voicemessages/composer/VoiceMessagePermissionRationaleDialog.kt`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/timeline/components/event/TimelineItemVoiceView.kt`. Compare minimum length, cancel by gesture, review before send, playback scrubbing, refused permission, and the fallback for clients without voice support.

**UI.** Mockup M3, which needs design judgement: the mic affordance next to dictation, the recording ledge, review, and the bubble with waveform and duration.

**Acceptance.**
1. Record on phone; it plays on desktop and in Element X. Repeat in the reverse direction.
2. Cancelling during recording uploads nothing.
3. Refusing the microphone shows a single recoverable line.
4. An assistant with speech-to-text replies to the content. An assistant without it asks once before any audio leaves for a provider.
5. A client without voice support shows a downloadable audio file. In an encrypted room the stored attachment is ciphertext and decrypts for the recipient.

**Estimate.** Desktop 4–6 d · Phone 5–7 d · Platform 0–0.5 d.

### S7 · Phone SAS verification

**Native mapping.** Spec §Device verification (SAS). `Client::get_session_verification_controller` (`RS bindings/matrix-sdk-ffi/src/client.rs#L1702`) provides `request_device_verification` (`session_verification.rs#L156`), `request_user_verification` (`#L165`), `acknowledge_verification_request` and `accept_verification_request` (`#L127`, `#L144`), `start_sas_verification` (`#L187`), `approve_verification` (`#L228`), `decline_verification` (`#L239`), `cancel_verification` (`#L250`) and the delegate's emoji data. Desktop already verifies (`src/matrix/security.ts:608`, `src/matrix/sdk-device-verification.ts`) and acts as the counterpart.

**Phone seams.** `App/MatrixLiveRuntime.swift:532` restores without comparing. Add a verification flow in a new `App/Security/` and present it from `App/Recovery/RecoverySheets.swift`. Before starting, check current atum-mobile-client `main` and the private release tree for any newer verification work, and build on it.

**Element X reference.** `EXI ElementX/Sources/Screens/Onboarding/SessionVerificationScreen/SessionVerificationScreenViewModel.swift`, `EXI ElementX/Sources/Screens/Onboarding/SessionVerificationScreen/SessionVerificationScreenStateMachine.swift`, `EXI ElementX/Sources/Services/SessionVerification/SessionVerificationControllerProxy.swift`, `EXA features/verifysession/impl/src/main/kotlin/io/element/android/features/verifysession/impl/incoming/IncomingVerificationPresenter.kt`, `EXA libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/verification/RustSessionVerificationService.kt`. Compare the state machine: requested, accepted, SAS shown, matched or mismatched, cancelled by peer, timed out.

**UI.** Part of mockup M4: emoji comparison, match and no-match, cancel.

**Acceptance.**
1. A new phone sign-in verifies against desktop by emoji. Both show verified.
2. A mismatch cancels on both devices.
3. A peer cancel shows a single recoverable line.
4. A recovered backup or a locally matched device ID is never labelled verified.

**Estimate.** Phone 3–5 d.

### S8 · Phone-first cross-signing and key backup

**Depends on:** S7 (same lane).

**Native mapping.** Spec §Cross-signing and §Server-side key backups. The calls are `Encryption::enable_recovery` (`RS bindings/matrix-sdk-ffi/src/encryption.rs#L824`), `recover` (`#L885`), `reset_recovery_key` (`#L860`), `recovery_state` and its listener (`#L745`), `backup_state` (`#L704`), `verification_state` (`#L910`), `has_devices_to_verify_against` (`#L777`) and `wait_for_backup_upload_steady_state` (`#L781`).

**Phone seams.** `App/MatrixLiveRuntime.swift:557–659`: auto-bootstrap is off and only restore exists. Provide an explicit setup entry in Security/Recovery so a fresh phone can initialize trust before S9 exists. Establish missing cross-signing through the SDK and complete any required interactive authentication before enabling backup. Preserve existing identities and backups. The recovery key stays inside the established device custody boundary, as the existing restore path does. Integrate into `App/Recovery/RecoverySheets.swift`.

**Element X reference.** `EXI ElementX/Sources/Screens/SecureBackup/SecureBackupRecoveryKeyScreen/SecureBackupRecoveryKeyScreenViewModel.swift`, `EXI ElementX/Sources/Services/SecureBackup/SecureBackupController.swift`, `EXI ElementX/Sources/Screens/HomeScreen/View/HomeScreenRecoveryKeyConfirmationBanner.swift`, `EXA features/securebackup/impl/src/main/kotlin/io/element/android/features/securebackup/impl/setup/SecureBackupSetupPresenter.kt`, `EXA features/securebackup/impl/src/main/kotlin/io/element/android/features/securebackup/impl/enter/SecureBackupEnterRecoveryKeyPresenter.kt`, `EXA libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/encryption/RustEncryptionService.kt`.

**UI.** Part of mockup M4: one save step for the key, one confirmation, then out of the way.

**Acceptance.**
1. A fresh phone-only account creates backup and identity when it chooses to.
2. After reinstall, the recovery key restores history.
3. A second device can then verify (S7).
4. Ordinary chats remain plain, and no setup prompt appears for people who never choose private.

**Estimate.** Phone 5–8 d.

### S9 · Opt-in private people chats at creation

**Depends on:** S7 and S8 on phone. Desktop trust already exists. The choice is exposed only once both devices pass.

**Native mapping.** Spec §End-to-end encryption, `m.room.encryption` with `m.megolm.v1.aes-sha2` in `initial_state`. Desktop: `client.createRoom({ initial_state: [...] })`. Phone: `CreateRoomParameters.is_encrypted` (`RS bindings/matrix-sdk-ffi/src/client.rs#L3484–3488`, `create_room` at `#L1544`).

**Desktop seams.** In `src/matrix/conversations.ts:508–527`, the `ENCRYPTED` table is the documented single switch. Keep every value `false`. Add a per-call `private: true` for `direct` and `group` only. The UI is `src/matrix/new-group.tsx` and `src/matrix/start-chat.tsx`. Inviting an assistant into a private room is blocked, with one line of explanation. A room is never silently converted.

**Phone seams.** Room creation at `App/LiveMatrixSession.swift:338`, plus the new-chat sheet.

**Element X reference.** `EXI ElementX/Sources/Screens/CreateRoomScreen/CreateRoomScreenViewModel.swift`, `EXI ElementX/Sources/Screens/SecurityAndPrivacyScreen/SecurityAndPrivacyScreenViewModel.swift`, `EXA features/securityandprivacy/impl/src/main/kotlin/io/element/android/features/securityandprivacy/impl/root/SecurityAndPrivacyPresenter.kt`. Compare how the irreversibility is communicated.

**UI.** Mockup M4, which needs design judgement: one quiet "Private" option, off by default, with a one-line one-way note.

**Acceptance.**
1. A private group created on phone exchanges messages with desktop and Element X.
2. The default creation path still makes a plain room.
3. Adding an assistant to the private room is refused with one line.
4. Release the choice after the cross-device verification and reinstall proofs. An individual phone-only user can start setup from Security or the Private choice and complete recovery setup before creating the room. Owning two devices is a release test, not a user prerequisite.

**Estimate.** Desktop 2–3 d · Phone 2–3 d · Platform 0.

### S10 · Message forwarding on phone

**Native mapping.** A client choice over stable `m.room.message`. The desktop semantics are the source of truth: `src/matrix/forward-content.ts` and `forward-targets.ts` on desktop. Follow the desktop `sdk.ts` forward command as well as the content projection. Plain attachment → encrypted destination re-encrypts and uploads. Encrypted attachment → plain destination is refused. Strip relations, active mentions and action metadata, and preserve company destination restrictions.

**Phone seams.** `Sources/AtumChat/MessageMenuRules.swift:10` (add Forward), a destination picker built from `App/Chat/Stores/RosterStore.swift`, and the send through `SDKTimelineSource.swift`, using a new `forward(...)` only.

**Element X reference.** `EXI ElementX/Sources/Screens/MessageForwardingScreen/MessageForwardingScreenViewModel.swift`, `EXA features/forward/impl/src/main/kotlin/io/element/android/features/forward/impl/ForwardMessagesPresenter.kt`.

**UI.** Mockup M7 (light): the same picker as the roster search, with a preview of what leaves.

**Acceptance.**
1. Forward text and an image to allowed destinations. Plain media opens after transfer to an encrypted destination. An encrypted attachment cannot be forwarded to a plain room and uploads nothing.
2. The destination list matches desktop's eligibility.

**Estimate.** Phone 2–3 d.

### S11 · URL cards on phone

**Native mapping.** Spec §`GET /_matrix/client/v1/media/preview_url` (authenticated media). Match the desktop policy, which is plain rooms only (`src/matrix/link-preview-media.ts:74`). Encrypted rooms show a plain link.

**Phone seams.** `App/Chat/Views/ChatRowView.swift:30`, plus a new `App/Chat/Media/LinkPreviewCard.swift` that calls the pinned SDK’s `getUrlPreview(url:ts:)` only after confirming the room is plain. Policy goes in `Sources/AtumChat/LinkPolicy.swift`.

**Platform.** Confirm `url_preview_enabled` and its IP blacklist on the homeserver.

**Element X reference.** `EXI ElementX/Sources/Other/SwiftUI/Views/LinkPreviewView.swift`, `EXI ElementX/Sources/Screens/Timeline/View/TimelineItemViews/TextRoomTimelineView.swift`.

**UI.** Mirror desktop's `link-preview-card.tsx` in the phone kit. No mockup.

**Acceptance.**
1. A plain room link shows a card.
2. An encrypted room link shows no card and makes no preview request.

**Estimate.** Phone 1–2 d · Platform 0–0.5 d.

### S12 · Actionable polls

**Native mapping.** MSC3381. Use the pinned SDK’s supported poll event names and result aggregation. Verify the wire spelling against an Element-generated event before sending; do not infer stable spec status from an `m.*` SDK alias. Handle disclosed and undisclosed kinds.
- Desktop: the matrix-js-sdk `Poll` model through `room.polls` and `PollEvent`, with `M_POLL_START`, `M_POLL_RESPONSE` and `M_POLL_END` content helpers.
- Phone: `Timeline::create_poll`, `send_poll_response` and `end_poll` (`RS bindings/matrix-sdk-ffi/src/timeline/mod.rs#L626`, `#L649`, `#L668`).

**Order.** Render and vote first, then create and close.

**Desktop seams.** Admit poll events in `src/matrix/message.ts:437`, using a new `src/matrix/poll/` for the model adapter and the row. Creation goes in `composer-plus.tsx`.

**Phone seams.** `App/Chat/SDK/ItemMapper.swift:197` (question only today), a new row view, and creation from the composer's attach sheet (`App/Chat/Media/AttachSheet.swift`).

**Element X reference.** `EXI ElementX/Sources/Screens/Timeline/View/TimelineItemViews/PollRoomTimelineView.swift`, `EXI ElementX/Sources/Screens/Timeline/View/Polls/PollView.swift`, `EXI ElementX/Sources/Screens/CreatePollScreen/PollFormScreenViewModel.swift`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/timeline/components/event/TimelineItemPollView.kt`, `EXA features/poll/impl/src/main/kotlin/io/element/android/features/poll/impl/actions/DefaultSendPollResponseAction.kt`, `EXA features/poll/impl/src/main/kotlin/io/element/android/features/poll/impl/actions/DefaultEndPollAction.kt`, `EXA features/poll/impl/src/main/kotlin/io/element/android/features/poll/impl/create/CreatePollPresenter.kt`.

**UI.** Mockup M5, which needs design judgement: the poll bubble before and after voting, the ended state, and the create sheet.

**Acceptance.**
1. An Element X poll renders on both Atum clients, and a vote from Atum counts in Element X.
2. Changing a vote replaces the old one.
3. An undisclosed poll hides tallies until it ends.
4. Atum creates and ends a poll, and Element X shows the result.

**Estimate.** Desktop 4–6 d · Phone 4–6 d.

### S13 · Static location; incoming stickers

**Native mapping.** Spec §`m.location` (`geo_uri`, plus `org.matrix.msc3488.location` on read) and §Sticker messages (`m.sticker`). Phone send: `Timeline::send_location` (`RS bindings/matrix-sdk-ffi/src/timeline/mod.rs#L744`).

**Desktop seams.** `src/matrix/message.ts:567` has a body fallback. Render a place card that opens the system map, and admit `m.sticker` as an image using its `body` as alt text (`message.ts:437`, `room-preview.ts:129`). Offer a user-chosen point without permission (a `geo:` coordinate entry suffices). Current location is an optional one-shot shortcut.

**Phone seams.** In `App/Chat/SDK/ItemMapper.swift:195` and `:220`, render the sticker image and the place card. To send, use a MapKit pin picker; Apple's native framework needs no licence review. Location is requested on action only, never in the background.

**Element X reference.** `EXI ElementX/Sources/Screens/Timeline/View/TimelineItemViews/LocationRoomTimelineView.swift`, `EXI ElementX/Sources/Screens/LocationSharing/View/StaticLocationSheet.swift`, `EXI ElementX/Sources/Screens/Timeline/View/TimelineItemViews/StickerRoomTimelineView.swift`, `EXA features/location/impl/src/main/kotlin/io/element/android/features/location/impl/share/ShareLocationPresenter.kt`, `EXA features/location/impl/src/main/kotlin/io/element/android/features/location/impl/show/ShowLocationPresenter.kt`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/timeline/components/event/TimelineItemStickerView.kt`.

**UI.** Existing kit. No mockup.

**Acceptance.**
1. An Element X location opens in the system map with no location permission requested.
2. A place sent from phone renders in Element X.
3. An Element X sticker renders as an image with alt text.

**Estimate.** Desktop 2–3 d · Phone 2–4 d.

### S14 · Room-wide mentions on phone

**Native mapping.** Spec §User and room mentions (`m.mentions.room: true`) and power level `notifications.room`.

**Phone seams.** `App/Chat/SDK/SDKTimelineSource.swift:392` hard-codes the room flag to `false`. The composer suggestion goes in `Sources/AtumChat/Mentions.swift`, shown only when the sender's power level allows it. Typed "@room" text stays plain text unless the suggestion is chosen. Desktop's Team Space composer (`src/matrix/threads.ts:196`) is the in-house reference.

**Element X reference.** `EXI ElementX/Sources/Services/Timeline/IntentionalMentions.swift`, `EXI ElementX/Sources/Other/Pills/MentionBuilder.swift`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/messagecomposer/MessageComposerPresenter.kt`.

**Acceptance.**
1. An authorized sender’s explicit room mention carries `m.mentions.room` and appears as a room mention in Element X. Delivery respects recipient push settings.
2. For an unauthorized sender, no suggestion appears.
3. Typed "@room" text produces no room mention.

**Estimate.** Phone 1 d.

### S15 · Room-upgrade continuity

**Native mapping.** Spec §Room upgrades (`m.room.tombstone`, `m.room.create.predecessor`). Desktop: `room.findPredecessor()`, `client.getRoomUpgradeHistory(roomId)`, the tombstone state, and `client.getVisibleRooms()`, which already hides a replaced room once its successor is joined. Phone: `Room::successor_room` and `predecessor_room` (`RS bindings/matrix-sdk-ffi/src/room/mod.rs#L169`, `#L185`).

**Desktop seams.** Generalize the Notes-only redirection in `src/matrix/notes-self.ts:130` into `src/matrix/room-navigation.ts`. Check that the successor’s predecessor points back to this room before presenting a verified transition. Where state is inaccessible until join, offer an explicit join and verify the backlink once readable. Avoid automatic joins or redirects. Earlier history stays reachable from the successor.

**Phone seams.** `App/LiveMatrixSession.swift:1585` (none today) and `App/Chat/Views/ChatScreen.swift`, for the banner only.

**Element X reference.** `EXI ElementX/Sources/Screens/RoomScreen/RoomScreenViewModel.swift`, `EXI ElementX/Sources/Other/SwiftUI/Views/TombstonedAvatarImage.swift`, `EXA libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/room/tombstone/SuccessorRoom.kt`, `EXA features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/MessagesPresenter.kt`.

**Acceptance.**
1. Upgrade a room on the test homeserver. Opening the old room shows the banner, joining moves there, and earlier history stays readable.
2. An inaccessible successor shows a single line and the old history stays readable.
3. The roster shows only the successor once it is joined.

**Estimate.** Desktop 2–3 d · Phone 2–3 d.

### S16 · Unread and favourites list filters

Desktop PR #154 was **open** at review. Track its merge and coordinate a shared roster hunk with DL3 before assembly. On phone, ML3 checks current Home, then projects unread and favourites from existing row state in `App/Home/HomeScreen.swift`. Keep the assistant and human sections and scroll anchor when the filter clears. Match the audit’s pinned RoomListFilterModels / RoomListFiltersPresenter behaviours using the worker procedure in §4. No protocol changes. Exit with a reversible filter on each client. Keep mobile presence opt-in and unknown distinct from offline; a presence redesign stays deferred.

## 3. Parallel MECE workstreams

A lane owns its files. Shared god-files (`src/matrix/sdk.ts`, `src/matrix/app.tsx`, `App/LiveMatrixSession.swift`, `App/Chat/SDK/SDKTimelineSource.swift`) are split by named region below. A lane edits only its region and puts new logic in new files. Shared regions follow the integration edges below.

| Lane | Repo | Slices, in order | Owns |
| --- | --- | --- | --- |
| DL1 Threads & pins | atum-desktop | S4d → S5d | `threads.ts`, `pinned-events.ts`, `team-space/pinned-panel.tsx`; `sdk.ts` snapshot region ~1150–1195; `app.tsx` `openThread` gate ~5747 and `MatrixThreadPanel`; `group-turns.ts` thread carry |
| DL2 Attention | atum-desktop | S3d | `notification-policy.ts`, `notifications.ts`, `notification-level-menu.tsx`, `notification-policy-settings.tsx`, `conversation-menu.tsx`; `sdk.ts` command region ~3750–3790 |
| DL3 Search | atum-desktop | S1d → S2d | `roster-global-search.ts`, new `personal-message-search.ts`, `history-search.ts`, `chat-search*`, roster result list in `roster-conversations.tsx`; new `electron/matrix/event-index/` |
| DL4 Rich content | atum-desktop | S6d → S12d → S13d | `message.ts` admission and rendering, `composer-plus.tsx`, `composer-dock.tsx`, `room-preview.ts`, `electron/matrix/voice.ts`; new `voice-note/`, `poll/`; the message-row render in `app.tsx` for these kinds only |
| DL5 Rooms | atum-desktop | S15d → S9d | `room-navigation.ts`, `notes-self.ts`, `conversations.ts`, `new-group.tsx`, `start-chat.tsx`; conversation chrome banner |
| ML1 Threads & pins | atum-mobile-client | S4m → S5m | `App/Company/CompanyThreads*.swift` → new `App/Chat/Threads/`; `CompanySpaceMatrix.swift` pins; the thread-focus initializer in `SDKTimelineSource.swift`; thread entry in `ChatScreen.swift` |
| ML2 Attention | atum-mobile-client | S3m | the notification region of `LiveMatrixSession.swift` (~700–780), `ChatInfoSheet.swift`, `App/Push/` |
| ML3 Search | atum-mobile-client | S1m → S2m, S16m | `App/Home/HomeGlobalSearch.swift`, `App/Home/HomeScreen.swift`, `ChatSearchBar.swift`, `Sources/AtumChat/ChatSearch.swift`; new `LocalSearchSource.swift` |
| ML4 Rich content | atum-mobile-client | S6m → S12m → S13m | `Composer.swift`, `App/Chat/Media/*`, `ItemMapper.swift`, `Sources/AtumChat/ContentRules.swift`; new `App/Chat/VoiceNote/`; the send-voice, poll and location functions in `SDKTimelineSource.swift` |
| ML5 Trust | atum-mobile-client | S7 → S8 → S9m | the security region of `MatrixLiveRuntime.swift` (~520–700), `App/Recovery/`, new `App/Security/`; room creation ~338 in `LiveMatrixSession.swift` |
| ML6 Message actions | atum-mobile-client | S10 → S11 → S14 → S15m | forward entry in `MessageMenuRules.swift` and `MessageMenu.swift` after ML1, `ChatRowView.swift`, `LinkPolicy.swift`, `Mentions.swift`; the mention flag ~392 in `SDKTimelineSource.swift`; successor ~1585 in `LiveMatrixSession.swift` |
| PL1 Platform checks | atum-platform | S1p, S3p, S4p, S6p, S11p | homeserver search, push-rule delivery, URL preview and agent thread configuration: verification notes, plus a config change only if a check fails |

**Integration ownership.** Assign shared regions once in the brief. DL1 owns thread/pin eligibility and context actions, DL2 the notification command and shared notification types, DL3 the search bridge and roster result/open handler, DL4 the attachment command and rich-content rows. The coordinator reconciles the desktop roster with #154. ML1 owns thread/pin menu changes and the thread entry in ChatScreen; ML6 applies forward/menu changes **on top of ML1**, and owns the successor banner. ML4 owns media rows and the attachment picker; ML6 wires link cards through ChatRowView after those row changes. ML3 owns Home search/filters and its search-index builder call; ML5 owns trust options in the same runtime builder. The coordinator integrates the builder once and regenerates any shared Xcode project from its source after assembly. Workers can build isolated logic while shared integration waits.

### 3.1 Dependency edges

- **Data or contract:** S1 → S2 on both surfaces. S7 → S8 → S9m. S9d waits on S7 and S8, because the choice is exposed only after both devices pass.
- **File ownership only (serial in a lane):** S4 → S5, S6 → S12 → S13, S15d → S9d, S10 → S11 → S14 → S15m.
- **Shared rule, no code edge:** DL1 and ML1 both implement the eligibility rule in S4, so they run in parallel.
- **Mockup gates (UI only):** M1 gates the S1 result UI, M2 the S4 thread entry, M3 the S6 recorder and bubble, M4 the S7, S8 and S9 screens, and M5 the S12 bubble. Workers build the SDK and engine layers before the mockup lands.
- **Acceptance gates, not build gates:** PL1 results gate S1, S3, S4, S6 and S11 acceptance. Both client halves must be available for each two-way test. Interop with Element X is the coordinator's pass at the end of each lane.

### 3.2 Waves

- **Wave 1 (eight workers):** DL1 and ML1 (S4 → S5), DL2 and ML2 (S3), DL3 and ML3 (S1 → S2, plus mobile S16), ML5 (S7 → S8, followed by gated S9m), and DL4 (S6 → S12 → S13). Start both sides of group threads together. Coordinator PL1 runs local platform checks alongside them, starting at `deploy/chat/prepare.py`, `sygnal.py` and `url_preview.py`, and inspects atum-app’s `plugins/platforms/matrix/adapter.py` for S4/S6. Production delivery and real-device interop are acceptance evidence to collect separately.
- **Wave 2:** start ML4 (S6 → S12 → S13) at the first free slot, ML6 after ML1’s menu contract, and DL5 (S15 → gated S9d). Phone workers own separate derived-data directories. M6 and M7 use the existing kit immediately.

## 4. Worker brief template

Copy it, then fill in the angle-bracket fields.

```text
AUTHORIZATION: owner 2026-11-27, verbatim: "chat parity: go with Astra's recommnedations. If there's no plan yet, then opus plan and astra review, then send out to codex workers to build. As the workers build, they should compare their code to Element X as tight reference."
PLAN: <reviewed atum-desktop plan SHA and supplied slice text>, slices <S#…>, lane <lane id>. The plan is on a local docs branch; include the slice, references and ownership in every repo’s brief.
REPO / BRANCH: <repo>, new branch <feat/chat-parity-…> created from origin/<default branch> (not from the coordinator's local HEAD).

SCOPE
- Build exactly the slices listed, in order. Edit only the files and regions the lane owns (plan §3); put new logic in new files.
- Native first: use the SDK calls and spec sections the slice cites. Before adding any custom layer, show the native call cannot do it, and keep the gap a thin adapter.
- Phone: confirm each cited Rust FFI call exists in Atum's pinned Swift package before coding. Use the generated Swift API at §1.3 and exercise the selected binary. Record a confirmed missing method or runtime capability, continue independent work and leave any producer change to the coordinator.

ELEMENT X COMPARISON RULE
- Before coding, take one concrete scenario from the pinned audit or a running Element X client (e.g. mute → mention → restore default). Record its precondition, action and visible/wire result. Run that scenario against Atum while building; cite the reference revision/path for provenance, the licensed SDK operation, and an Atum test or observation. Mark unrun interop as pending.
- Use the audit’s behaviour descriptions, public spec/SDK docs and black-box observations. Implementers stay out of current Element X source. Independently author Atum logic, interaction, copy, assets, tests and fixtures. The archive’s file links identify where the auditor observed behaviour. No historical parts-bin content is selected.
- For new distributed libraries verify the exact artifact and bundled/transitive licence and NOTICE obligations, pin the resolved version in the repo’s normal lock, and record the reason it is needed.

UI
- Atum kit only: airy, one action plus at most one line per state, never denser than today. No canned assistant text in chats. When the plan requires a mockup (M1–M5), build its UI only after the mockup lands; until then, build the engine and SDK layers.

TESTS
- Behaviour tests (invariants, not snapshots); never read source files in tests.
- Desktop: npm workspace; vitest for the touched modules; use `src/matrix/test-homeserver.ts` for its supported trust/backup cases. It models one room. Use a local real homeserver for search, room-state and delivery interop, or mark those checks pending.
- Phone: unit tests in Sources/AtumChat where the logic is pure; simulator runs with a worker-owned -derivedDataPath that you delete afterwards.
- Write the slice's acceptance list as tests wherever they can be automated; list the rest as manual interop steps for the coordinator.

RULES (no stalls)
- Never stop to ask or wait for approval. Decide (native first), write the decision down, continue. If something truly cannot be done, finish everything else and report the blocker last.
- No rm -rf (use python3 -c "import shutil; shutil.rmtree(...)"), no heredocs piped into interpreters, no destructive git.
- Commit locally only. Do NOT push, open PRs, run CI or reruns, deploy, use paid APIs or cloud resources, or spend money.
- Never print secrets. No personal names in code, copy or docs.
- Update the repo's docs or session log for behaviour changes before committing.

FINAL MESSAGE
- Branch, commit SHAs, files changed.
- Local check table: command → result (the repo's pre-push parity script where one exists, e.g. coord-scripts/prepush/prepush-atum-desktop.sh; typecheck, lint, focused tests). Name any check that could not run, and why.
- Behaviour comparison table per slice: reference revision/path and scenario | observed Element X outcome | Atum result and test evidence | intentional difference or pending interop.
- Acceptance: automated ✓/✗ per item; manual interop steps left for the coordinator.
- Open decisions and deviations from the plan.
```

## 5. Mockups and existing controls (Opus, UI/UX authority)

Put required M1–M5 mockups in `docs/design/chat-parity/` in atum-desktop. M6 and M7 describe existing controls and need no separate design artifact.

| Id | Surface | Design judgement | Gates |
| --- | --- | --- | --- |
| M1 | Global search results: grouping, source labels, coverage line, private-hit marker | **High.** Density and how coverage is disclosed are easy to get wrong | S1, S2 UI |
| M2 | Thread entry in an ordinary group: root summary, desktop panel, phone thread screen | **High.** Must not clutter person–assistant flow | S4 UI |
| M3 | Voice note: mic next to dictation, recording ledge, review, bubble with waveform; transcription consent row | **High.** Two mic actions side by side | S6 UI |
| M4 | Phone trust: SAS emoji compare, recovery key save and restore, "Private" option at chat creation | **High.** One-way choice; trust versus key availability | S7, S8, S9 UI |
| M5 | Poll: bubble before and after voting, ended, undisclosed; create sheet | Medium | S12 UI |
| M6 | Notification mode: All / Mentions / Off with one-line hints | Low, extends the existing menu | S3 UI (may proceed on the existing menu) |
| M7 | Phone forward picker with preview | Low, reuses the roster search | S10 UI (may proceed) |

**Landed 2026-11-27 (M1–M4).** The gallery is at `~/.atum/operations/evidence/mockups-chat-parity-1127/index.html`; design decisions and owner questions are in `NOTES.md`; frames are in `png/`, each with `-light` and `-dark`.
- M1: `png/m1-d-results`, `m1-d-empty`, `m1-p-results`, `m1-p-open`
- M2: `png/m2-d-entry`, `m2-d-thread`, `m2-d-list`, `m2-p-group`, `m2-p-menu`, `m2-p-thread`, `m2-p-list`
- M3: `png/m3-d-idle`, `m3-d-recording`, `m3-d-review`, `m3-d-assistant`, `m3-p-idle`, `m3-p-recording`, `m3-p-review`
- M4: `png/m4-p-confirm`, `m4-d-verify`, `m4-p-emoji`, `m4-p-done`, `m4-p-mismatch`, `m4-p-new`, `m4-p-new-private`, `m4-d-private`, `m4-p-key`, `m4-p-restore`

No mockup is needed for S5, S11, S13, S14, S15 or S16. They use existing kit components.

## 6. Totals and risks

**Engineering days for S1–S15:** desktop 28–43, phone 43–66, platform 1–3.5. Allow another 0.5–1 phone day for S16 once ML3 has confirmed the existing controls. Parallel lanes bring calendar time to about two or three weeks of lane time, plus mockups and interop.

**Risks to watch:**
1. **Phone bindings.** API declarations are verified at the producer pin. Exercise the binary before making a compatibility claim.
2. **Voice interop.** Record the actual container/codec and play a real exchange in both directions.
3. **Desktop index.** Prove key protection and packaged encrypted storage first. Loaded-history search is the bounded fallback.
4. **Push rules.** Verify the native rule round trip, inherited default, actual delivery and unread effects.

5. **Shared files.** Observe the region ownership and integration order in §3.

## Review (Astra)

**Ready to dispatch with these edits.** The first wave pairs search, notification modes and human-group threads across both clients, starts phone trust early and proves the desktop voice format. Desktop filters remain tracked in #154; phone filters have an owner. Private search has an explicit local-only query boundary, and forwarding keeps the existing encrypted-media restriction.

| Decision | Recommendation |
| --- | --- |
| Desktop push rules | Adopt homeserver room modes, distinguish explicit All from inheritance, and respect the SDK delivery decision before applying quieter Atum preferences. [JS mute helper](https://github.com/matrix-org/matrix-js-sdk/blob/v42.4.0/src/client.ts#L5596) · [Rust mode mapping](https://github.com/matrix-org/matrix-rust-sdk/blob/e048e09adcb8bed06aa512c446052423aeed6ac6/crates/matrix-sdk/src/notification_settings/mod.rs#L320) |
| Desktop encrypted search | Prove encrypted Seshat in packaged Electron. If it fails, ship clearly labelled in-memory loaded-history search and defer persistent indexing. |
| Recorded voice | Target Ogg/Opus, prefer native capture, add one permissive muxer or encoder only on demonstrated need. Require ciphertext media in private rooms and explicit transcription consent. |
| Phone Rust bindings | Retain 26.10.15-atum.2. The generated Swift surface covers the planned first-wave SDK calls. Binary and device acceptance belong to the workers. |
| Assistant threads | Keep top-level human-group replies flat and honour explicit roots. Apply a scoped adapter/profile setting only after checking session scope and existing Team Space behaviour. |

**Scope cuts.** Defer speculative background crawling, a second plain search engine, a bulk notification migration and generic transcoding. Use existing menus for M6/M7. Record actual coverage, native pin conflict limits and pending two-client checks in the handoff.
