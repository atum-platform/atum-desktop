# Desktop roster search

DL3 implements desktop S1 and the loaded-history mode of S2 from the reviewed chat parity plan at `2ca259197d`.

## Behaviour

- The roster searches joined plain Personal chats with the Matrix JS SDK's room-scoped `/search`. The existing company and file bridges keep their directory authorization. Personal search uses one native continuation when the first page has no eligible hits. The coverage line marks capped or partial results.
- The search panel shows message hits by chat, newest first, with a marked snippet, sender and time. Company chats show their company label where its name is available. Existing person, chat-name and file matches remain usable within the plain search results. Clearing the field restores the full roster.
- Opening a hit selects its room and exact event ID. For an unloaded plain event, the SDK builds a focused context. Atum rings that row and offers a return to the live transcript. An expired room, redacted event or unrecognized target cannot be selected through search.
- The device-only scope clears the field when selected, cancels scheduled plain requests and discards in-flight replies. The private term is used only by the human SDK's local search of already-decrypted messages in current room and thread timelines. Coverage counts readable loaded messages and eligible private chats. Membership, redaction, local removal and host teardown invalidate access. The fallback makes no durable search copy and starts no backfill.
- The company private assistant's working chat stays outside roster search, in keeping with the existing company authority and presentation rules.
- The account's remembered roster filter still narrows local conversation rows
  while typing. Cross-chat results use the chosen plain or device-only search
  scope and appear above those rows.

## Seshat packaging evidence

The exact npm artifacts were `@matrix-org/seshat@6.0.1` and `@matrix-org/seshat-darwin-arm64@6.0.1`. A fixture app using Electron 44.10.1 and `app.asar` reported `app.isPackaged`. With the arm64 binding unpacked from ASAR, the probe loaded the native code, generated a random passphrase, wrapped it using Electron safeStorage, committed a synthetic event, rejected a wrong passphrase, reopened using the wrapped passphrase, found the event and wiped the index and key file.

For reproduction, create a temporary Electron fixture whose package main is [seshat-packaging-probe.cjs](../electron/matrix/event-index/seshat-packaging-probe.cjs). Unpack the two pinned npm tarballs beneath its `node_modules/@matrix-org/` directory. Pack that fixture into the copied Electron bundle's `Contents/Resources/app.asar` with `asar pack app app.asar --unpack '*.node'`. Give the copy a fixture executable name and matching `CFBundleExecutable`, then run it with a temporary `--user-data-dir` as an Electron app.

The product's candidate and release builder configurations exclude `node_modules` and have no Seshat staging route. The native package's published tarball contains only `index.node` and `package.json`. The exact native artifact's bundled dependency notices and the signed Atum artifact are still required before redistributing or enabling a persistent store. The probe is development evidence and is outside the product build entry points. Production uses the in-memory fallback, leaving persistent per-account and per-device indexing open.

## Behaviour comparison

| Pinned reference and scenario | Element X behaviour observed in the parity audit | Desktop evidence and difference |
| --- | --- | --- |
| [iOS global search](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Screens/SearchScreen/SearchScreenViewModel.swift) and Android's `GlobalSearchPresenter.kt` in the [pinned Home feature](https://github.com/element-hq/element-x-android/tree/20ad9664790111e5558d4610f9fb05d6cc1efcc2/features/home). Type a term with matches across chats, then open one. | The pinned reference uses debounced message search, room grouping, a no-match state and an event-focused open. | Atum retains the roster debounce and empty state, groups hits in place and uses the Matrix event context. The SDK fixture opens the exact ID even with a duplicate message already loaded. Existing person and file matches remain in the roster. M1 uses company-only labels and a temporary ring. |
| [iOS history limit sheet](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Screens/SearchScreen/View/SearchScreenHistoryLimitSheet.swift), [iOS search service](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Services/Search/SearchServiceProxy.swift) and [Android backfill](https://github.com/element-hq/element-x-android/blob/20ad9664790111e5558d4610f9fb05d6cc1efcc2/libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/search/RustSearchBackfillService.kt). Search after decrypting a private chat, with earlier history unavailable. | Device search uses an index and discloses incomplete history. The audit records Android indexing messages received while enabled. | The controller and mounted roster route the private canary only to loaded history. The SDK test observes zero fetches and removes redacted, locally removed and departed-room hits. Atum uses a scope chosen before typing, an inline coverage count and no crawler. |

## Acceptance still to run in integration

Use a real homeserver and two clients. Send the same term to a plain assistant DM, people group and company channel, then search from desktop and phone. Check matching IDs, source label, the ring on a deep event and disappearance after leave. Repeat with a private canary and capture client requests from all sources. Confirm the private scope clears on sign-out and coverage rebuilds from the newly loaded SDK timeline. Exercise historical thread replies after assembling the thread lane. Element X device interop, platform configuration and an installed signed Atum build are pending.

Local checks passed for desktop typecheck, ESLint with zero errors, 72 focused SDK/controller/IPC tests, and 11 focused renderer tests. The renderer fixture covers the three-room corpus and company label, a room disappearing after leave, and the private result opening the exact row when another row has the same body. The SDK fixture checks the native cursor, context URL and request body.

## Integration with group threads and pins

The SDK returns the thread root when it projects a search hit into a Team Space or human-group thread. The roster uses that root to open the thread and reveal the exact reply. A search hit rendered inline still opens the room transcript. The selected thread can draw a bounded historical reply window while the room keeps its live window and pending echoes. Room-level searches retain their event-centered window. Thread reveals from roster search, company search and pins all carry the current account scope.

The SDK regression fixture covers a historical group reply and a personal DM reply shown inline. The renderer fixture checks that a private roster hit highlights the exact row in either transcript.
