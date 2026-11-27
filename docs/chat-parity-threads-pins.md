# Desktop chat parity for threads and pins

S4 enables threads in joined human groups, including a group with an invited assistant. Desktop uses the group admission code's ordinary-room and private-chat distinction from synced state. Assistant DMs, app-bot rooms, Notes and people DMs keep flat timelines. Team Space retains its existing panel and company-wide inbox.

The M2 group interaction uses the existing message hover action, a single root summary with faces, count and last reply time, and the existing right-hand thread panel. Group details show the three latest threads and an All threads entry. The list uses the same bounded SDK projection as Team Space, covering known roots and loaded replies. Historical assistant results that used a thread relation for an ordinary answer still render flat.

Desktop sends standard `m.thread` replies via matrix-js-sdk 42.4.0. The first reply has a fallback to the root. The SDK uses the last settled reply as the fallback when available. A thread receipt sends private `m.read.private` with the thread ID. The main read-markers path uses the main timeline. Assistant intake and publication are owned by the platform check. The local group intake on this base still filters out thread triggers, so desktop UI and wire support alone do not establish local assistant replies inside a thread.

S5 extends shared pins to human groups and people DMs through the existing `m.room.pinned_events` projection and panel. A fresh write uses the synced list and the current state-event power level. Members without write power can still see the pins. Truly simultaneous writes from clients holding the same state can overwrite each other. The homeserver's resolved state is authoritative, and clients converge on sync.

## Behaviour comparison

The Element X column comes from the pinned parity audit and planned interaction. Live cross-client checks are pending. Implementation uses the Apache-2.0 Matrix JS SDK and the existing Atum kit.

| Scenario and reference | Element X behaviour | Atum evidence and differences |
| --- | --- | --- |
| Start a thread in a group, open the root summary and read its replies. [iOS thread timeline](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Screens/ThreadTimelineScreen/ThreadTimelineScreenViewModel.swift), [Android thread list](https://github.com/element-hq/element-x-android/blob/20ad9664790111e5558d4610f9fb05d6cc1efcc2/features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/threads/list/ThreadsListPresenter.kt) | With Labs enabled, the root links to its own thread timeline. The thread list groups activity by root. | `app.test.tsx` opens the existing side panel from the hover action, the root summary and chat details. `threads.test.ts` projects the incoming reply under its root. Atum enables this for human groups and uses a side panel. |
| Read a reply while the main room has a separate read marker. [Matrix threading and receipts](https://spec.matrix.org/v1.19/client-server-api/#threading) | Thread and main-room read positions have separate scopes. | `threads.test.ts` checks the actual SDK receipt payload and the unchanged main marker. Atum sends a private receipt. |
| Post the first reply to a thread. [Matrix fallback](https://spec.matrix.org/v1.19/client-server-api/#fallback-for-unthreaded-clients) | A thread-aware client groups the message under the root. A flat client can follow the fallback reply target. | `threads.test.ts` checks the explicit root, mention, fallback flag and fallback target on the SDK's HTTP request. Live rendering in the older client remains pending. |
| Read a pin from another client, then change power or edit the list. [iOS pinned timeline](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Screens/PinnedEventsTimelineScreen/PinnedEventsTimelineScreenViewModel.swift), [Android pinned list](https://github.com/element-hq/element-x-android/blob/20ad9664790111e5558d4610f9fb05d6cc1efcc2/features/messages/impl/src/main/kotlin/io/element/android/features/messages/impl/pinned/list/PinnedMessagesListPresenter.kt) | Pins are shared room state. Room power controls mutations. | `sdk-conversations.test.ts` checks synced state on both eligible room kinds, preservation of an incoming pin and removal, and stale-write refusal after demotion. `app.test.tsx` covers the read-only panel. Atum uses the existing header pin control and bounded lookup. |

## Coordinator acceptance

- Open a desktop group thread on an assistant answer, reply on phone, read it in Element X and confirm the main-room read marker stays put. Check the fallback in a client with threads disabled.
- Check top-level and explicit-thread mentions through the deployed assistant profile. Confirm the top-level answer stays flat and the threaded answer uses the selected root.
- Pin from phone, verify the desktop and Element X lists, then demote the writer and confirm the action disappears. Exercise a simultaneous write with both clients and check convergence.
