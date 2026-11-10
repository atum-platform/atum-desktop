# Wave 1 phone copy in the mobile design snapshot

The reviewed mobile snapshot gains the copy that wave 1 of the iPhone parity
plan codes against, in all five locales (en, vi, ja, zh, zh-Hant). Wording is
desktop's own: every new entry comes from an existing desktop copy table, or,
where the export cannot read the table, is copied exactly into
`mobileScreensCopy` in `apps/desktop/src/matrix/mobile-copy.ts` with its source
named beside it.

## Added (49 entries)

- **Team space DMs** (`shared.matrix-team-space-copy.copy.*`): `directMessages`,
  `you`, `personalNotes`, `newMessage`, `newMessageHint`, `newMessageStart`,
  `newMessageNobody`, `newMessageLimit`, `openConversation` (one string
  argument). Chief of Staff name: `shared.matrix-company-board-copy.copy.chiefOfStaff`.
  CoS row states: `shared.matrix-company-private-cos-copy.matrixCompanyPrivateCosRowCopy.{settingUp,notAvailable,retry,open}`
  and `…matrixCompanyPrivateCosCopy.{paused,preparing,ready,unavailable}`,
  the same words `team-space/conversation-sections.tsx` draws.
- **Report person** (`src.matrix.chat-copy.copies.*`): `reportPerson`,
  `reportPersonTitle`, `reportPersonBody`, `reportReason`. Report message,
  report sent and block were already in the snapshot.
- **Delete account dialog** (`src.matrix.legal-copy.copy.*`):
  `deleteAccountDialogTitle`, `deleteAccountDialogBody`, `deleteAccountConfirm`.
- **Cloud-only home** (`src.matrix.agent-home-copy.words.*`): `moveToCloud`,
  `moveSection`, `livesWhere`.
- **Current Store** (`src.matrix.mobile-copy.mobileScreensCopy.store.*`, copied
  from `store/store-copy.ts`): section names `title`, `discover`, `featured`,
  `assistants` (store-copy `agents`), `skills`, `pets`, `apps`, `purchased`;
  price parts `free`, `protons`, `monthly`, `monthlyFirst`, `monthlyFreeFirst`,
  `monthlyThen` (as `storePriceParts` composes them); `get`, `getWithPrice`
  (store-copy `getFor`, "Get · %@"); `balanceLabel`.
- **Empty-chat greeting** (`src.matrix.mobile-copy.mobileScreensCopy.greeting.*`,
  copied from i18n `matrixShell`): `morning`, `afternoon`, `evening`, `prompt`.

## Refreshed to current desktop wording (6 entries)

`src.matrix.moderation-copy.copies.{empty,ignoredPeople,ignoredHow,unignore}`
now say Block / Blocked people instead of Ignore, and
`shared.matrix-first-run-copy.copies.greeting` (and its `firstName=null`
branch) carries the current first-run line. Argument contracts are unchanged.

## Not added

No entry shows a Proton paid/bonus split or a VND rate (owner ruling 1); the
Store's VND currency line, `checkoutSave` and the PayOS checkout words stay out.
The "unnamed" word is already exported as `src.matrix.conversation-copy.copies.unnamed`.

## Validation

The producer, with these promotions, regenerates cleanly (`export.mjs --check`)
and passes its 44 tests. The 49 added entries and 6 refreshed entries are
byte-identical to that producer output; every other catalog entry, contract
entry and resource is unchanged; the manifest keeps its prior membership with
updated hashes for the catalog, contract and inventory. The inventory adds the
`mobileScreensCopy` table and the private-CoS copy source. A dry phone import
against this commit passed `scripts/import-design-exports --verify`.
Publication and the real phone pin update are coordinator steps.
