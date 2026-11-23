# Wave 4 phone copy in the mobile design snapshot

The reviewed mobile snapshot gains the copy the iPhone needs to port desktop's work since
12 Nov 2026 (tracker atum-mobile#47, wave 4 lane W4-C), in all five locales (en, vi, ja, zh,
zh-Hant), so the phone can repin once. Owner ruling: phone copy comes only from this export,
worded as desktop's own. The method is the one waves 1 and 3 used
(`docs/ports/mobile-export-wave1-copy.md`, `docs/ports/mobile-export-wave3-copy.md`):

- Keys the export already reads are promoted under their desktop key path.
- Where the export cannot read a table (here Work's `app/work/copy.ts` and `relay-copy.ts`, which
  sit outside `src/matrix`, and i18n scopes other than `atum`, `common`, `timeline`, `dm`), the
  words are copied exactly into `mobileScreensCopy` in `apps/desktop/src/matrix/mobile-copy.ts`,
  with the source named beside them. A script generated them by evaluating the desktop modules
  (each formatter body comes from calling the desktop function with sentinel arguments), then
  checked 605 calls of the copies against the desktop functions, over edge arguments in every
  locale. None of it was typed by hand.

The phone does not rebuild T3 Work session viewing (the T3 Code mobile app pairs with the Mac
through T3's own pairing), so from Work only the relay, plan and consent words that the phone's
Atum chats show are exported. "Left out" below lists the rest and why.

## Counts

- **Added: 199 catalog entries** (184 keys, plus 15 exact-count and absent-argument branches),
  all new to the public snapshot.
- **Refreshed: 1.** `desktop.atum.roster.searchPlaceholder`, the short Search field (#48), in all
  five locales. Argument contract unchanged.
- **Removed: 2.** Desktop dropped them, so the producer can no longer emit them:
  - `src.matrix.drive-copy.matrixDriveCopy.browser.allFiles` ("All files"). Desktop's Finder Drive
    (#43, `12fb6944`) names the whole Drive "Atum Drive" under Locations. The replacement is
    `browser.drive`, added below.
  - `src.matrix.model-picker-copy.COPY.chatgptCloudNotReady` ("Not ready for your assistants yet").
    D6 (#97, `bbc84060`) greys ChatGPT in an assistant's picker with one line. The replacement is
    `COPY.chatgptInWork`, added below. Its Open Work action is Mac-only and stays out.

  Neither key was a target in `phone-copy-map.json`, so the copy map is unchanged. Both are
  recorded in the producer's `deprecated` list with a reason and their replacement.

The catalog goes from 3884 to 4081 entries. `copy-contract.json` gains 199 parameter entries and
5 exact-value selectors, and loses the 2 removed keys. `copy-inventory.json` is now the
producer's inventory for this tree. It lists the new sources the added keys come from
(`chatgpt-training-copy.ts`, `shared/matrix-agent-desk-copy.ts`), the status line's
`matrixApprovalWaitCopy` table and the sources that came in since the last refresh. It also
records the two partial-locale tables (see "Producer changes"). The manifest keeps its
membership, with new hashes for the catalog, the contract and the inventory.

## Added, by item

`MS` = `src.matrix.mobile-copy.mobileScreensCopy`.

| Item | Entries | Keys |
|---|---:|---:|
| Work and relay (#96, #97, #99) | 53 | 43 |
| Drive (#44, #45) | 53 | 53 |
| Side panel (#51) | 36 | 34 |
| Google consent and Connections (#62) | 19 | 19 |
| Turn status (#63) | 11 | 9 |
| Plan cues (#52, #97) | 11 | 10 |
| Researcher hire (#100) | 9 | 9 |
| Agent card (#95) | 4 | 4 |
| Alerts bell (#48) | 2 | 2 |
| Stop (#46, #87) | 1 | 1 |
| **Total** | **199** | **184** |

- **Work and relay** (`MS.relay.*`, `MS.work.*`, from `app/work/relay-copy.ts` and `copy.ts`):
  the picker's greyed-row notes `relay.greyed.{connect,allow,google,encrypted}` and the Allow fix
  `relay.fixAllow` (relay-copy `fix.allow`); the fallback line `relay.fallback(model, why)` with
  `relay.fallbackWhy.{mac_off,consent_off,switch_off,limit,other}`; the turn lines
  `relay.{waiting,needsOk,limitHeld,stopping,stopped,queued,late,empty,failed}` and `relay.stop`;
  the composer chip `relay.chipLimit` and `relay.chipGreyed.*`; the usage/reset line
  `relay.{usageUsed,usageLimit,usageUnknown}`; the consent sheet in its chats wording
  `relay.{consentChatsLine,consentScheduled}`, `MS.work.consent.{title,assistants,macs,otherMac,allow,save,cancel,granted,revoke,failed,none}`;
  and the plan's Settings row title `MS.work.planRow` (copy.ts `connect.rowTitle`).
- **Drive**: the search scope bar `matrixDriveCopy.searchScope.{title,drive,searching}` (#45);
  file status `sync.{synced,pending,paused,conflict,error,uploading}` (#45); Columns and Gallery
  `columnView`, `galleryView`, Group By `groups.*` (title, none, kind, modified, size, the 12
  `kinds`, 4 `dates`, 8 `sizes`) and the 12 `itemKinds` (#44); and `browser.drive` ("Atum Drive"),
  the replacement for the removed `browser.allFiles`.
- **Side panel** (`shared.matrix-agent-desk-copy.matrixAgentDeskCopy.*`, #51): the browser frame's
  address bar `src.matrix.workbench-copy.copy.searchWeb`; the desk `desk`, `working`, `waiting`,
  `onDevice`, `minutes`, `stop`, `steerHint`, `queueHint`, `ask`, `routine`, `composerSteer`,
  `watch`, `more`, `less`; Files `files`, `sentHere`, `save`, `saveShort`, `openDrive`,
  `onItsComputer`, `back`; devices `devices`, `usingNow`; controls `controls`, `notifications`,
  `moreControls`, `allSettings`, `pause`, `controlFailed`, `computerOff`; routines `routines`,
  `paused`, `nextRun`.
- **Google consent and Connections** (`src.matrix.chatgpt-training-copy.COPY.*`, #62): the
  training-off confirmation `title`, `checkbox`, `helper`, `transfer`, `confirm`, `keep`,
  `saving`, `failed`, `stale`; Connections `rowTitle`, `connectedAnotherMac`, `confirmedOn`,
  `notConfirmed`, `readFailed`, `tryAgain`; revoke `revoke`, `revoking`, `revokePending`,
  `revokeFailed`. `checkbox` and `transfer` are the platform's hashed wording
  (`chatgpt-google-v1`, `chatgpt-google-transfer-v1`).
- **Turn status** (#63, `shared.matrix-status-line-copy.*`): the tool code's
  `matrixToolActivityCopy.{read,write,web,run,look,draw,delegate}`, the heartbeat
  `matrixProgressCopy.heartbeat` with `minutes=0` and `minutes=1`, and the approval code's
  `matrixApprovalWaitCopy`.
- **Plan cues** (#52, #97, `src.matrix.model-picker-copy.COPY.*`): the fallback answer line
  `fallbackAnswer` and `fallbackWhy.{offline,limit,slow,other}`; the once-only Google switch
  `googleSwitched` and its `model=null` branch; the chip's `planUnavailable.{mac_offline,no_mac,reconnect}`;
  and D6's `chatgptInWork`.
- **Researcher hire** (#100): `src.matrix.roster-create-copy.copies.{readyToHire,hirePrice,hiring,hired,hireFailed}`
  (the listing, the seat price line, the hire states) and `MS.shell.{agentHireConfirm,agentHireShort,agentAccountRefused,agentLimitRefused}`
  (i18n `matrixShell`, the Hire button, too few Protons and the two refusals listing-hire.tsx
  shows). The sheet's Back, Done, Retry and Top up are already exported (`desktop.common.*`,
  `desktop.atum.discover.topUp`), as is the name refusal (`MS.shell.agentNameRefused`).
- **Agent card** (#95): `src.matrix.assistant-card.copy.assistantCardCopies.{longPersona,personaConflict}`
  and the persona's section headings `MS.assistantCard.{personaWho,personaWhat}`
  (`shared/matrix-assistant-persona.ts` `PERSONA_WHO`, `PERSONA_WHAT`). They are English in every
  locale because the card writes them into the persona file.
- **Alerts bell** (#48): `src.matrix.attention-copy.copies.{notifications,nothing}`. The count
  phrase was already exported.
- **Stop** (#46, #87): `MS.cloud.stopping` (i18n `cloud.stopping`). A scheduled run's Stop (#87)
  adds no words of its own. It uses `cloud.stopping` while the stop is pending and the
  already-exported `matrixAgentStatusCopy.stopped` ("Stopped.") once it is done.

## Argument kinds

Every other added entry takes no argument.

- `%@` string: `relay.fallback(model, why)`; `relay.fallbackWhy.{consent_off,switch_off,limit,other}(plan)`;
  `relay.chipGreyed.*(plan)`; `relay.late(at)`; `work.consent.granted(since)` (a formatted date);
  desk `desk`, `ask`, `composerSteer` (name), `onDevice` (device), `save` (file name), `nextRun`
  (a formatted time); `hirePrice` (a formatted Proton amount), `hiring`, `hired`, `hireFailed`
  (name); `chatgpt-training-copy.COPY.confirmedOn` (a formatted date);
  `model-picker-copy.COPY.fallbackWhy.*` and `planUnavailable.*` (plan).
- Nullable string, with an absent-argument branch the phone selects when it has no value:
  `relay.limitHeld(plan, at?)` and `relay.chipLimit(plan, at?)` (`.at=null`),
  `relay.usageLimit(at?)` (`.at=null`), `COPY.googleSwitched(model?)` (`.model=null`, "Atum's model").
- `%lld` number with exact selectors (`exactValues`, count-one plus the zero alternative):
  `matrixProgressCopy.heartbeat(minutes)`, desk `minutes(count)`, `work.consent.otherMac(index)`,
  and `relay.usageUsed(percent, at?)`. That one has both a number and a nullable string, so it has
  four exact branches (`.percent=1`, `.percent=0`, `.at=null.percent=1`, `.at=null.percent=0`)
  next to `.at=null`. In its format strings the percent sign is `%%`.
- Words, not formatters: relay-copy's `greyed.*` and `fallbackWhy.mac_off` are desktop formatters
  that never use the plan they are given. Here they are plain words.

## Keys the phone rekeys at the repin

| Phone had | Export now carries |
|---|---|
| `src.matrix.drive-copy.matrixDriveCopy.browser.allFiles` | `src.matrix.drive-copy.matrixDriveCopy.browser.drive` ("Atum Drive") |
| `src.matrix.model-picker-copy.COPY.chatgptCloudNotReady` | `src.matrix.model-picker-copy.COPY.chatgptInWork` |

The producer's `phone-chat-keys.json` names `browser.drive` in place of `browser.allFiles`.

## Left out

Placeholders or anything that could leak (EX-ST-RM): none of the added words is a placeholder,
a fixture, a demo value or an address. The outbound guard's identifier patterns find nothing new.
Ruling 1: no added entry shows a VND amount, a paid/bonus split or a rate. The hire price is a
Proton amount per month, like the Store's monthly hire. The picker's per-token `shelfPrice*`
stays out.

Only meaningful on a Mac:

- `matrixAgentDeskCopy.onThisMac` ("On this Mac") and `chatgpt-training-copy.COPY.connectedThisMac`
  ("… used through this Mac"); Drive `sync.localOnly` ("Only on this Mac").
- `matrixAgentDeskCopy.pauseHint`: Pause's hover tooltip, which the owner ruled is never panel
  text. The phone has no hover.
- `model-picker-copy.COPY.openWork` and relay-copy `openWork` ("Open Work"): they open the Work
  page on the Mac.
- The inline "Stop target unavailable" tooltip (#87, an en/vi ternary in `app.tsx`, not a table).

Work strings not exported (the phone's Atum chats do not show them):

- `copy.ts` `rail`, `title`, `view.*`, `retry`, `addProtons`, `pill.*`, `line.*`, `switchLabel`,
  `enrollTitle`, `enrollBody`, `allow`, `notNow`, `close`, `working`, `stopping(name)`,
  `pillWorking`, `anAssistant`, `settings.*`, `reconnect`: the Work page, its title pill and its
  enrollment on the Mac, which is T3 Work session viewing.
- `copy.ts` `planSwitch.{label,help,named,change}`: this Mac's own per-Mac plan switch in Mac
  Settings. `planSwitchOffLine` is the cloud's refusal text, so the phone gets it in the message.
- `copy.ts` `connect.{title,line,action,skip,rowOffer,rowConnected,manage}`: the Connect step and
  its Settings row run T3's own Codex sign-in inside Work on the Mac ("Connected on this Mac").
  Only `connect.rowTitle` is exported, as `MS.work.planRow`.
- `copy.ts` `consent.line`, `consent.scheduled`: the consent sheet's Work-scope wording (work the
  assistants start on the Mac). The Atum chats use the chats scope (`relay.consentChatsLine`,
  `relay.consentScheduled`). Also `consent.thisMac` ("This Mac"): the phone is not a Mac. Other
  Macs are named by their own names, or by `otherMac` when unnamed.
- relay-copy `fix.connect`: it opens Work's Connect step on the Mac. `sharedContext` (O14): drawn
  in Work above the T3 thread, not in an Atum chat. `WORK_RELAY_PLAN_NAMES` ("ChatGPT", "Claude",
  "Antigravity") are product names, never translated. The phone passes the plan name in.
  `workRelayTime` is a time formatter, not copy.

Not in this wave's items, held back: the rest of the new desktop copy since 12 Nov
(`matrix-google-write-copy`, `matrix-native-mac-copy`, the video consent card and
`matrixVideoConsentWaitCopy`, `matrixProgressCopy.done`, `agent-status-copy` lines, the
picker's effort, shelf and sign-in words, and the other Finder Drive words: `listView`,
`gridView`, `viewMode`, `search`, `searchEmpty`, `quickLook`, `forward`, `preview.*`,
`browser.{favorites,locations,recentFiles}`). `roster-create-copy.makeYourOwn` is defined but no
desktop screen draws it. #52's Model Armor, first-48-hours and wallet-hold lanes are backend
only (`agent/`, `cron/`). They add no desktop words. The wallet hold reaches the chat through
the already-exported `matrixAgentStatusCopy.unfunded` and `trialExpired`.

## Desktop wording to review across locales

- Work's `copy.ts` and `relay-copy.ts` have English and Vietnamese only. ja, zh and zh-Hant
  repeat the English, as the desktop shows them (50 of the 53 entries; the other 3 differ only in
  plural form). `chatgpt-training-copy.ts` reads English in ja, zh and zh-Hant on purpose: the
  platform records the wording per language. Translating either belongs in desktop first.
- The persona headings are English in every locale by design (see "Agent card").
- Two fallback vocabularies: relay-copy says "Nguyệt Thực answered · ChatGPT limit reached"
  (vi "… hết lượt dùng"), while the picker's fallback line says "Answered with a fallback" ·
  "ChatGPT reached its limit" (vi "… đã chạm giới hạn"). relay-copy's held line says "hết lượt".
- The consent sheet's scheduled switch is "Also for scheduled tasks" in Work scope and "Also for
  scheduled work" in chats scope. vi uses "Cả việc theo lịch" for both.

## Producer changes (private atum-app, branch `chore/mobile-export-wave4-keys`, local)

- `phone-export-keys.json`: +199 keys, −2 removed keys (moved to `deprecated` with reason and
  replacement). `phone-chat-keys.json`: `browser.allFiles` → `browser.drive`.
- `scripts/copy.mjs`: desktop now has two tables written in some locales only: the Google write
  card's `copies` (en, vi) and `MATRIX_VIDEO_CONSENT_SENTENCES` (the platform's hashed en/vi
  sentences). The producer used to fail on any partial table. It now records these two by exact
  source and table in the inventory ("Partial locale table, not exported") and still fails on any
  other partial table. A new test checks that both are recorded and never exported.
- `wave4/spec.json` and `wave4/splice4.mjs`: wave 3's splice, which also takes the producer's
  inventory and checks that every entry shared with the producer is now byte-identical.

## Validation

- Producer: `scripts/export.mjs` run on this checkout's `apps/desktop/src`, `apps/desktop/shared`
  and `packages/atum-kit`. `export.mjs --check` is clean and all 45 producer tests pass (44 plus
  the new partial-table test). For that run only, four desktop glyph aliases the producer's
  `glyph-map.json` does not map yet (`Checks`, `Forward`, `LayoutGallery`, `LayoutGroups`, from
  #44 and the Finder Drive) were given throwaway mappings. That changes only `glyphs.json`,
  which this change does not touch. Mapping them properly is a separate design-export step.
- Splice: `splice4.mjs` added 199, refreshed 1 and removed 2 (4081 entries). A semantic diff of
  the old and new catalog and contract shows exactly those keys changed. Every other entry the
  snapshot shares with the producer is byte-identical to the producer's, and the copy map equals
  the producer's.
- The 45 generated `mobileScreensCopy` leaves match the desktop modules in all five locales
  (605 comparisons, edge arguments included).
- Desktop: `tsc -p . --noEmit` in `apps/desktop` passes. `vitest run` of
  `src/matrix/mobile-copy.test.ts`, `src/i18n/brand-copy.test.ts`,
  `src/matrix/vietnamese-copy-guard.test.tsx` and `src/matrix/no-meta-notice-copy.test.ts`: 47
  passed. `packages/atum-kit/scripts/build.mjs --check` is clean.
- Outbound guard: `bash scripts/pre-push-public eb808c46 HEAD` (the base branch's checker and
  policy) and `scripts/public_guard.py --base origin/main` both pass: 1 new commit, paths, modes,
  ancestry, identifiers, secrets (gitleaks 8.30.1, no leaks) and metadata. No new identifier enters any export file, so the wave 3 `reviewed_blobs`
  approval is not needed for this change. That digest (`58c6280d…`) now names the previous
  catalog bytes. The new catalog is `5af60ddb3fc05617c308accf423c7b9e13df2ddb391c566bc36014e50d02f11a`
  if the coordinator wants to record it.

Publication (push, PR, merge), the producer branch's push and the real phone repin are
coordinator steps.

## Fix: app-icon manifest hash (23 Nov)

The phone importer rejected `c2d71828` and every desktop revision since `57bdc29f` (11 Nov).
That commit restored the real Atum-owned artwork in `dist/app-icon/atum-app-icon-1024.png`
(SHA-256 `cf67ad54…47248eb`, which matches its own `.json` sidecar). But `dist/manifest.json` still
recorded the snapshot placeholder's hash (`8b5b59a6…cc23f4`). The manifest entry now matches the
bytes on disk, and every other `dist/` file already matched. The manifest SHA-256 goes from
`2ea06dd3…aaff1` to `be38f8aa…2dead`. Follow-up: `export.mjs --check` and the public guards
don't hash `dist/` files against the manifest, so this drift went unnoticed. That check belongs
in the producer (atum-app).

## Wave 4b: relay questions and scheduled plan usage (#103, #104)

Follow-up for the phone's "Work plan rows + consent" lane: the phone-visible copy desktop added
between `46f5a518` and `784f608f`, by the same method as above (generated into
`mobileScreensCopy.relay` by evaluating the desktop modules, producer run, `splice4.mjs` with
`wave4b/spec.json` on atum-app `chore/mobile-export-wave4b-keys`).

- **Added: 5 entries (3 keys).** `MS.relay.waitingForAnswer` and `MS.relay.invalidAnswer`, the
  turn line while a relay turn waits on the assistant's question and after a reply that did not
  answer it (i18n `sidebar.row.waitingForAnswer`, existing, now drawn by `relay-chrome.tsx`;
  `sidebar.row.invalidAnswer`, new in #104; all five locales on desktop).
  `MS.relay.usageScheduled(runs)` (relay-copy, #103), number with exact `runs=1` / `runs=0`
  branches; desktop has en and vi, the other locales repeat the English as desktop shows them.
  En says "1 scheduled runs" for one run, exactly as desktop does.
- **Refreshed / removed: none.** Every other entry the snapshot shares with the producer is still
  byte-identical to it; the inventory and copy map are unchanged.
- **Not exported:** the Settings rows' titles "ChatGPT" and "Claude" (product names, hard-coded),
  the usage line's `·` composition and its date format (`workRelayUsageText` logic, not words),
  and the gate's T3-side prompt and thread titles ("Current owner request:", "Scheduled job …",
  "Scheduled: …", "Assistant conversation"), which only Work shows. No new partial-locale table.
- Checks: producer `export.mjs --check` clean, producer tests 45/45 (one earlier run had 2
  timing failures that did not recur in two full reruns); 44 manifest hashes match their files;
  desktop `tsc -p . --noEmit` and the copy vitest files pass; outbound guard passes (see the commit).

## Wave 4c: Work connections and relay for every plan (#106)

Desktop `f1d10cf0` (#106) moved the plan's connection and consent out of Work into
`app/connections/` (connecting a plan covers every assistant, scheduled turns included, and this
Mac's switch is the off switch). Same method as above; producer inputs on atum-app
`chore/mobile-export-wave4c-keys`.

- **Added: 1.** `shared.matrix-agent-desk-copy.matrixAgentDeskCopy.pauseHint` ("Still answers
  you. Starts nothing on its own."), which desktop has in all five locales. Wave 4 left it out
  because it is Pause's hover tooltip; the phone now has a test waiting for it.
- **Removed: 14.** `MS.work.planRow` and `MS.work.consent.{title,assistants,macs,otherMac
  (+ index=0, index=1),allow,save,cancel,granted,revoke,failed,none}`: #106 deleted their source
  (`work/copy.ts` `connect.*` and `consent.*`, and the consent sheet `plan-consent.tsx`). They are
  deleted from `mobileScreensCopy` and recorded as deprecated in the producer, with no replacement
  in the export.
- **Refreshed: none.** Every other shared entry still matches the producer byte for byte; the
  inventory and copy map are unchanged. Catalog: 4086 → 4073 entries.
- **Held back, desktop has English and Vietnamese only** (`app/connections/copy.ts`; ja, zh and
  zh-Hant read English): `subscriptions`, `dataAndTools`, `onMacs(names)`, `lastSeen(names)`,
  `notConnected`, `inCloud`, `needsAttention`, `connect`, `manage`, `ownerChats.{title,line}`,
  `homeTools.line`, `sheet.{title(plan),line(plan),consent,continue,notNow,needsMac,close}`,
  `progress.{signingIn(plan),done(plan),failed(plan),tryAgain}`, `picker.{use(plan),inWork}`.
  Mac-only in any case: `thisMac`, `mac.{label,help,otherHelp}` (this Mac's switch) and
  `picker.openWork`. Not copy: `ACCOUNT_PLAN_NAMES` (product names).
- **Still exported but no longer drawn by desktop:** relay `greyed.allow`, `chipGreyed.allow`,
  `fixAllow`, `consentChatsLine`, `consentScheduled`. relay-copy still defines them, so they stay
  until desktop removes them.
- Checks: producer `export.mjs --check` clean, tests 45/45 (same throwaway glyph-map entries as
  above); 44 manifest hashes match; desktop `tsc -p . --noEmit` and the copy vitest files pass;
  outbound guard passes.
