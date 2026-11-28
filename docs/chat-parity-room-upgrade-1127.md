# Room-upgrade continuity (desktop)

Desktop slice S15d is built locally. Release acceptance still needs a real homeserver upgrade (`/rooms/{id}/upgrade`), the phone half (S15m) and Element X interop.

A room that was upgraded keeps its history and says where it went. The old room's `m.room.tombstone` names the replacement; the replacement's `m.room.create` names its predecessor. Atum presents a transition as confirmed only when both ends agree.

- **Old room.** A band in the conversation: “This chat moved to a new room.” with one action. Opening the room joins nothing and redirects nothing. The action is `joinSuccessor`: it joins the replacement (an invitation, or a room not known until joined, asking the tombstone author’s server and the id’s own server), checks that its create event points back at the old room once readable, and opens it. A replacement that does not point back is left again. The old room stays in the list and readable until the replacement is joined and confirmed.
- **Inaccessible or unconfirmed replacement.** One line, no action: “The new room isn’t available. Earlier messages stay here.” or “This chat moved, but the new room can’t be confirmed.” The old history stays readable.
- **New room.** One line and one action, “See earlier messages”, which opens the previous room even though the roster no longer lists it. It shows only for a joined predecessor whose tombstone names this room.
- **Roster.** A replaced room leaves the list only once a joined, confirming replacement exists. matrix-js-sdk’s `getVisibleRooms()` is not used for this: it hides a replaced room as soon as any replacement is known, including an invitation or a room the person left, which would take the old room away before the person could see why it moved. The open room always stays projected.
- **Notes.** The Notes room's own duplicate retirement reads the tombstone through the same helper (`tombstoneReplacement`) and gets no banner.

Code: `src/matrix/room-upgrade.ts` (state reading, confirmation, the join), `room-upgrade-band.tsx` and `room-upgrade-copy.ts` (the band), `shared/matrix-room-upgrade.ts` (the two projected hints on `MatrixRoom`). Call sites in shared files are minimal: `sdk.ts` (roster filter and the `joinSuccessor` command), `app.tsx` (one band line), `shared/matrix.ts` (types and command), `electron/matrix/ipc-policy.ts` (the command’s parser), `conversations.ts` (projection).

## Behaviour comparison

| Scenario | Expected outcome (spec and the plan’s S15 acceptance; Element X not run) | Desktop verification |
| --- | --- | --- |
| Open a tombstoned room whose replacement you have not joined. | The old room shows that it was replaced, with a way to go to the new room; the spec leaves joining to the person. | `room-upgrade.test.ts` and `sdk-room-upgrade.test.ts`: opening and projecting never call `joinRoom`; the band is one line and one action. |
| Go to the new room. | The person joins and lands in the new room; the roster shows only the replacement. | `sdk-room-upgrade.test.ts`: one `joinRoom` with the author’s server, the replacement is selected, and the list holds only the replacement. |
| Scroll back to the earlier history from the new room. | The new room links back to the predecessor’s messages (create `predecessor`). | `sdk-room-upgrade.test.ts`: the replacement carries the predecessor hint, and selecting the hidden old room opens its history. |
| The replacement cannot be reached. | The old room says so and its history stays readable. | `room-upgrade-band.test.tsx` and `sdk-room-upgrade.test.ts`: a failed join leaves the old room selected and in the list; the band turns into one line with no action. |

[Element X iOS room screen at the audit revision](https://github.com/element-hq/element-x-ios/blob/183bbc7f0419bf76ae46d52f448c44eb14fe1069/ElementX/Sources/Screens/RoomScreen/RoomScreenViewModel.swift) · [Element X Android successor room at the audit revision](https://github.com/element-hq/element-x-android/blob/20ad9664790111e5558d4610f9fb05d6cc1efcc2/libraries/matrix/impl/src/main/kotlin/io/element/android/libraries/matrix/impl/room/tombstone/SuccessorRoom.kt) · [Matrix room upgrades](https://spec.matrix.org/v1.19/client-server-api/#room-upgrades) · [matrix-js-sdk room upgrade history](https://github.com/matrix-org/matrix-js-sdk/blob/v42.4.0/src/client.ts)

Element X is cited for behaviour only. Its source was not opened while building and no Element X client was run: the table rests on the plan’s S15 text, the spec and the SDK’s documented operations. Element X interop is pending.

For the interop pass: on a local Synapse, create a room as one account with a second account joined, upgrade it as the first, and open the old room on the second account. Check that the band shows and nothing has joined. Click “Join new room” and confirm the new room opens, the list shows only it, and “See earlier messages” opens the old history. Repeat with a successor the second account may not join (an invite-only room with no invitation) and confirm one line and a readable old room. Repeat on Element X and compare the order of the two steps. Local tests drive real SDK rooms with synthetic state; Docker had no running daemon for a Synapse pass.
