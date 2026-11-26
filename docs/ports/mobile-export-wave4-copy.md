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
  other partial table. A new test checks that both are recorded and never exported. (Wave 4h
  exports the card's `copies`, with desktop's English fallback; see "Wave 4h" below.)
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
  inventory and copy map are unchanged. Catalog: 4086 → 4110 entries (+38, −14).
- **Added: 37 Connections entries (25 keys), by coordinator decision.** The words of
  `app/connections/copy.ts`, which desktop has in English and Vietnamese only, follow the
  `relay.usageScheduled` precedent: en and vi from desktop, and ja, zh and zh-Hant a fallback
  that repeats the English, as desktop shows them (marked in `mobile-copy.ts`). Under
  `MS.connections`: `subscriptions`, `dataAndTools`, `onMacs(names)`, `lastSeen(names)`,
  `notConnected`, `inCloud`, `needsAttention`, `connect`, `manage`, `ownerChats.{title,line}`,
  `homeTools.line`, `sheet.{title,line,consent,continue,notNow,needsMac,close}`,
  `progress.{signingIn,done,failed,tryAgain}` and `picker.{use,inWork}`. `sheet.consent` is the
  consent sentence ("Your assistants can use this plan through this Mac."). The six formatters of
  the plan (`sheet.title`, `sheet.line`, `progress.signingIn`, `progress.done`, `progress.failed`,
  `picker.use`) keep desktop's argument: a choice of `codex`, `claude`, `antigravity`, exported as
  one entry per plan (`….plan=codex` and so on), since `sheet.line` names the plan's maker.
  `onMacs` and `lastSeen` take the Macs' names (`%1$@`). Left out as Mac-only: `thisMac`,
  `mac.{label,help,otherHelp}` (this Mac's switch) and `picker.openWork`. Not copy:
  `ACCOUNT_PLAN_NAMES` (product names).
- **#107 and #108** (merged into this branch): #107's only new words are Work's title band on
  the Mac (`work/copy.ts` `band.*`: the Work/Code mode switch, show/hide threads, New thread),
  which is Work session UI and stays out. #108 is the 0.20.52 release prep. Neither changes an
  exported entry. #107 adds one desktop glyph alias (`PenNib`) that the producer cannot map yet.
- **Still exported but no longer drawn by desktop:** relay `greyed.allow`, `chipGreyed.allow`,
  `fixAllow`, `consentChatsLine`, `consentScheduled`. relay-copy still defines them, so they stay
  until desktop removes them.
- Checks: producer `export.mjs --check` clean, tests 45/45 (same throwaway glyph-map entries as
  above, plus `PenNib`); the Connections copies match `connectionsCopy` in all five locales (215
  comparisons); 44 manifest hashes match; desktop `tsc -p . --noEmit` and the copy vitest files pass;
  outbound guard passes.

## Wave 4d: Team Space revamp pass 1 (#114)

Desktop `677b746d` (#114; #111 at `863079c8` changes no copy). Its new words are in
`src/matrix/team-space/revamp-copy.ts`, a five-locale table the producer reads directly, so they are
promoted under their desktop path and nothing goes into `mobileScreensCopy`. Producer inputs are on atum-app
`chore/mobile-export-wave4d-keys`.

- **Added: 23 entries (21 keys)**, `src.matrix.team-space.revamp-copy.copy.*`: `search`,
  `searchFor(query)`, `searchMessagesFor(query)`, `settingsSections`, `people`, `workspace`, `ai`,
  `billing`, `hiringPreparing`, `companyWallet`, `openWallet`, `preparingChannel`, `channelFailed`,
  `tryAgain`, `privateChiefOfStaff`, `noMatches`, `suggested`, `suggestedHint`,
  `showAllActivity(count)` (number, exact `count=1` / `count=0` branches), `showLessActivity`,
  `boardViews`. The file's header says "Desktop only"; the coordinator ruled that the phone's Team Space
  must match desktop as rendered.
- **Removed: 1.** `shared.matrix-company-copy.copy.channelOpenFailed`. #114 retired it from the channel
  pane; nothing draws it now, though the table still defines it. It is replaced by `channelFailed` and
  `tryAgain`, and recorded as deprecated with those replacements.
- **Narrowed, kept:** `matrix-company-board-copy.copy.chiefOfStaff` is still the shared Chief of Staff in
  channels; the private row, header and composer now use `privateChiefOfStaff`. `matrix-company-copy.copy.convergeFailed`
  is still the overview notice; the channel pane's preparing line is now `preparingChannel`. The board's
  `myTasks` and `emptyMyTasks` are no longer drawn, but they were never exported.
- **Refreshed: none.** Every other shared entry still matches the producer byte for byte, including after
  #111–#113. The inventory gains `revamp-copy.ts`. Catalog: 4110 → 4132 entries.

### Phone parity of #114's behaviours

| Behaviour | Phone | Why |
|---|---|---|
| One right pane (thread, pins, info, search results and task details share it; opening one closes the others) | No | It is a layout rule for a side pane. On the phone each of these is its own pushed screen or sheet already. |
| Header search (the box at the top filters the list; Enter or "Search “…”" runs company message search; search leaves settings) | Yes | Same entry point and words (`searchFor`, `searchMessagesFor`, `noMatches`). If the phone's settings still offer search, they should drop it. |
| Sectioned, role-aware settings (People, Workspace, AI, Billing, one at a time; Billing for owners and admins; falls back when a role changes; AI says "Company hiring is being prepared" while the Marketplace is hidden) | Yes | The phone can show the sections as a list. Role gating and the fallback are product rules, not layout. |
| Board/List and Mine (two views plus a Mine filter in both; a saved "My tasks" opens as List with Mine; compact cards; a see-through Suggested lane with its hint; task details with the latest change, Undo and "Show all activity (n)") | Yes | The Mine filter and List suit the phone first. The Board columns are optional on a narrow screen. The words and the migration of "My tasks" apply either way. |
| Channel opening / "Preparing your channel…" / "Couldn’t open this channel." with Try again (one line, one action; a failed open replaces the old transcript and is held per company and room) | Yes | These are state rules and words. They apply the same way on the phone. |
| Private Chief of Staff label ("Chief of Staff" in channels, "Private Chief of Staff" for the person's own row, header and composer) | Yes | Naming only. The phone shows both rows. |
| Narrow sidebar (names keep most of the row, the status shortens first) | No | It is the desktop sidebar's layout. |

- Checks: producer `export.mjs --check` clean and tests 45/45. As before, six desktop glyph aliases the
  producer cannot map yet got throwaway mappings (`Checks`, `Forward`, `LayoutGallery`, `LayoutGroups`,
  `PenNib`, and `Laptop` from #112–#113); `glyphs.json` is not spliced. All 44 manifest hashes match. Desktop
  `tsc -p . --noEmit` and the copy vitest files pass. The outbound guard passes.

## Wave 4e: Team Space Board/List and Mine (follow-up to #114)

The phone repin (W4-D4) found that the Board/List and Mine controls use two words the export
didn't have yet. Producer inputs are on atum-app `chore/mobile-export-wave4e-keys`.

- **Added: 2.** `shared.matrix-company-board-copy.copy.list` ("List") and `…copy.mine` ("Mine"). Desktop has
  both translated in all five locales, so no English fallback applies (vi "Danh sách" / "Của tôi",
  ja "リスト" / "自分", zh "列表" / "我的", zh-Hant "清單" / "我的"). `…copy.board` was already exported.
- **Refreshed / removed: none.** Catalog: 4132 → 4134 entries. Inventory and copy map unchanged.

### The six unmapped glyph aliases

Desktop knows these aliases only as Phosphor icons (`src/lib/icons.ts`). It has no SF Symbol names, and the
public export carries no alias-to-Phosphor file. The SF Symbol map is the producer's `glyph-map.json` in atum-app.
None of the six is mapped there yet, so each wave's run uses throwaway entries and does not ship `glyphs.json`.

| Alias | Phosphor | Desktop draws it | Candidate SF Symbol (for review) |
|---|---|---|---|
| `Checks` | `checks` | nowhere (defined only) | `checkmark` (as `Check`), or leave unmapped |
| `Forward` | `share-fat` | message menu Forward | `arrowshape.turn.up.right` |
| `LayoutGallery` | `slideshow` | Drive's Gallery view | `rectangle.split.3x1` or `photo.on.rectangle` |
| `LayoutGroups` | `rows` | Drive's Group By | `rectangle.grid.1x2` (`PanelBottom` shares Phosphor `rows` but maps to a panel glyph) |
| `PenNib` | `pen-nib` | nowhere since #107's switch to `Laptop` | `pencil.tip`, or leave unmapped |
| `Laptop` | `laptop` | the Work destination in the Mac shell | `laptopcomputer` |

Mapping them changes `glyphs.json`, a design-export decision. This wave doesn't change it.

## Wave 4f: the picker's thinking levels (#119)

Desktop #119 (`2365efe8`) moved the picker's thinking heading, levels and taglines into
`apps/desktop/src/matrix/model-picker-labels.json`, which `model-picker-copy.ts` imports and spreads
(`pickerLabels`). The producer could not load that import: its resolver appended `.ts` to every relative import
(atum-app `scripts/copy.mjs`, then line 168), so `export.mjs --check` stopped on
`model-picker-labels.json.ts`. Producer inputs are on atum-app `chore/mobile-export-wave4f-keys`.

- **Producer fix** (atum-app `packages/mobile-design-exports/scripts/copy.mjs`): a `.json` import in a copy
  module is now read with Node's own JSON loader (`createRequire`, lines 3 and 11; the branch at lines 172–177).
  It must sit inside the desktop app. TypeScript's `esModuleInterop` (line 157; line 113 for the type program,
  with `resolveJsonModule`) gives the default import, as `apps/desktop/tsconfig.json:9,15` does on desktop. The new
  test `test/json-copy-source.test.mjs` checks every `labels.json`-backed key in all five locales against the
  JSON. It fails on the old resolver with the same error, and passes now.
- **No phone-visible change** to the seven existing keys (`COPY.effort`, `efforts.{low,medium,high}`,
  `taglines.{everyday,hard,flagship}`): each is byte-identical in all five locales.
- **Added: 4.** `src.matrix.model-picker-copy.COPY.efforts.{none,minimal,xhigh,max}`, next to `efforts.*`.
  `pickerLabels` now fills every level the JSON has (`model-picker-copy.ts:136–142`; type at line 23). The agent
  picker still draws only `low`/`medium`/`high` (`MATRIX_EFFORTS`, `shared/matrix-models.ts:237`;
  `model-picker-effort-column.tsx:143`), so desktop behaviour is unchanged. The words are the JSON's exactly:
  - `none` (`model-picker-labels.json:13`): Off / Tắt / オフ / 关闭 / 關閉
  - `minimal` (`:14`): Instant / Tức thì / 即答 / 即时 / 即時
  - `xhigh` (`:30`): Extra thorough / Rất kỹ / さらにじっくり / 更深入 / 更深入
  - `max` (`:37`): Maximum / Tối đa / 最大 / 最大 / 最大
- **"Loading models…"** was already exported (`COPY.modelsLoading`, `model-picker-copy.ts:170` en), so nothing
  was added for it.
- **Refreshed / removed: none.** Catalog: 4134 → 4138 entries. Inventory and copy map unchanged.
- Checks: producer `export.mjs --check` 0 and tests 46/46. As before, six glyph aliases got throwaway mappings
  for the run; `glyphs.json` is not spliced. Desktop `tsc -p . --noEmit` 0. The model-picker and copy vitest
  files pass, 180 tests. All 44 manifest hashes match. The outbound guard passes.

## Wave 4g: the beta gate's "Coming soon" (#132)

W4-C7. Desktop #132 (`70464afa`, merged at `f60b25d6`) greys Team Space, hires and skills as "Coming soon"
for accounts without beta features. The phone has to show the same state with the same words. Desktop
added no strings for it (`apps/desktop/docs/beta-features-2026-11-25.md`). Every place reuses two i18n
keys in the `surfaces` scope:

| Key | Desktop draws it |
|---|---|
| `t.surfaces.comingSoon` | the rail's greyed Team space popover title (`app/atum/shell-surface.tsx:209`), the Team Space page title (`matrix/workspace.tsx:363`), the Store card's and sheet's disabled action (`store/discover-view.tsx:257,608`, `store-card.tsx`, `store-detail.tsx`), and the new-assistant sheet's listing button (`agent-roster.tsx:615`, `listing-hire.tsx`), which covers the Researcher hire |
| `t.surfaces.comingSoonHelp` | the rail popover's line (`shell-surface.tsx:272`) and the Team Space page's description (`workspace.tsx:363`) |

The export read only the `atum`, `common`, `timeline` and `dm` scopes, so neither key was in it. The
producer now reads `surfaces` too (atum-app `scripts/copy.mjs` `I18N_SCOPES`), and both keys are promoted
under their own desktop path. Nothing goes into `mobileScreensCopy`. Producer inputs are on atum-app
`chore/mobile-export-wave4g-keys` (`d266144b`).

- **Added: 2.** Both are plain words with no arguments. Desktop has all five locales:
  - `desktop.surfaces.comingSoon`: Coming soon / Sắp có / 近日公開 / 即将推出 / 即將推出
  - `desktop.surfaces.comingSoonHelp`: This place is not ready yet. / Chỗ này chưa sẵn sàng. /
    この場所はまだ利用できません。 / 此处尚未就绪。 / 此處尚未就緒。
- **Removed: 3.** Desktop `e8ce4357` (Kit on T3 step 3, "no Mac is full") removed the disk alerts, so the
  producer can no longer emit `src.matrix.attention-copy.copies.items.disk_critical` ("Mac is out of
  space"), `items.disk_low` ("Mac almost full") and `snooze` ("Remind me later"). They are recorded as
  deprecated with no replacement. None was a `phone-copy-map.json` target, and the phone's main branch
  does not read them.
- **Refreshed: none.** Every other entry the snapshot shares with the producer is still byte-identical.
  Catalog: 4138 → 4137 entries. `copy-contract.json` adds 2 entries and drops 3, with no exact selectors.
  `copy-inventory.json` lists `surfaces` in the five i18n rows and adds `src/matrix/rail-badge-copy.ts`
  (new in `e8ce4357`; listed, nothing from it exported). The copy map is unchanged.
- **Already exported, so not added:** the plain "Coming soon" in other tables
  (`desktop.atum.discover.comingSoon`, `desktop.atum.workspace.launcherComingSoon`, same words in all five
  locales), and the phone's combined rail label `src.matrix.mobile-device-copy.mobileDeviceCopy.teamSpaceSoon`
  ("Team space · Coming soon"). The phone should draw the gate with the `desktop.surfaces.*` keys, as desktop
  does. The listing button's spoken name (`${comingSoon} ${title}`) is a composition, not a new word.
- **Held back:** the rest of the scope, `surfaces.{needsSetup,needsUpdate,needsUpdateHelp}`. No phone flow
  needs them yet.

### For the phone repin

- Manifest SHA-256: `8a9f52066a4990850ca3c242e1915da29d166e2adfa2c22f3250b15598d8eacb` (was
  `2f1c4ea3c95f4b9612817198956306851e2951b123d3873cc851b8d59fa64dc1`).
- Changed file hashes: `Localizable.xcstrings` `7b1b70d0c20109b87a3b29147710dda72a13fe6c5eeef86045bb0430ce9ad52d`,
  `copy-contract.json` `9b20a768b5835643183b71eec26c8bc4d9f7066fd6e102b54d51612acbbdeecb`,
  `copy-inventory.json` `7efc62100014be889525c0c21022e4e05cacd8318547a652923ee657b7d51643`.
  `schemaVersion` stays 1, and the manifest keeps its 44 members.
- Rekeys: none. The phone only gains the two keys, and the three removed keys need nothing from it.
- Which items are greyed is the platform's `betaFeatures: true` on `/me`, the same reader desktop uses
  (`shared/beta-features.ts`). The Shell does not return it yet, so every account sees "Coming soon" until
  it does.

### Checks

- Producer: `export.mjs` and `export.mjs --check` exit 0 on this tree's `apps/desktop` and
  `packages/atum-kit`. Tests pass 47 of 47, including the new beta-gate test, which pins both keys in all
  five locales against the desktop source and fails if any other `desktop.surfaces.*` key is exported.
  Eight glyph aliases the producer cannot map yet got throwaway entries for the run only: the six above,
  plus `Paperclip` and `UserPlus` from `e8ce4357`. `glyphs.json` is not spliced.
- Splice: `wave4/splice4.mjs` with `wave4g/spec.json` added 2, refreshed 0 and removed 3. All 44 manifest
  hashes match their files.
- No desktop source changed, so desktop typecheck, lint and vitest have nothing new to cover. The outbound
  guard results are in the commit.

## Wave 4h: Google write cards for Work (#134)

Desktop #134 (merged at `6bd26341`) shows Work's Google writes on the owner's confirmation card, next to the
assistants' ones, and changed `apps/desktop/src/matrix/google-write-card-copy.ts`. The phone needs the same words
to show these cards and let the owner approve or decline. Producer inputs are on atum-app
`chore/mobile-export-wave4h-keys` (`42d51de7`), run on this tree (`3f56c918`).

The card's own words sit in its `copies` table (`google-write-card-copy.ts:54–155`), written in en and vi only.
Its reader returns `copies[locale] ?? copies.en` (`:157–159`), so desktop shows the English in ja, zh and zh-Hant.
Until now the producer recorded this table as partial and never exported it (see "Producer changes" above). It
now reads it the way desktop does, which is wave 4's rule for Work's en/vi copy ("Desktop wording to review
across locales"): ja, zh and zh-Hant repeat the English. In the producer, the table moves from
`PARTIAL_LOCALE_TABLES` to a new `ENGLISH_FALLBACK_TABLES` in `scripts/copy.mjs`. Any other partial table still
fails generation, and `MATRIX_VIDEO_CONSENT_SENTENCES` stays recorded and unexported.

- **Added: 50.** None takes arguments, and none has exact selectors.
  - 36 under `src.matrix.google-write-card-copy.copies.`: the 24 that #134 added, plus 12 the card already had
    that were never exported because the table was partial.
  - 14 under `shared.matrix-google-write-copy.MATRIX_GOOGLE_WRITE_COPY.`
    (`shared/matrix-google-write-copy.ts:40–115`). These are the question for an email or event and the 11
    field names the card draws (`google-write-card.tsx:183–219`). They are written in all five locales.
- **Held back:** the card's spread copies of the shared words (`copies.question.{send_email,create_event,
  update_event}`, `copies.labels.{from,to,…}`), so the phone reads each word from one place. Also held back are
  the shared table's fields the card does not draw (`labels.{from,calendar,notes,current,after,noInvitations}`),
  and the dialog's `confirm.*` and `cancel`.
- **Refreshed / removed: none.** Catalog: 4137 → 4187 entries. `copy-contract.json` adds 50 entries. The
  `copy-inventory.json` row for `google-write-card-copy.ts` now lists `copies` with the note "English fallback
  table (ja, zh, zh-Hant read en, as desktop does): copies". The copy map is unchanged. A semantic diff of the
  catalog and the contract shows exactly the 50 added keys and no other change.

| Key (`C` = `src.matrix.google-write-card-copy.copies`) | en | vi |
|---|---|---|
| `C.question.create_draft` | Save this draft in Gmail? | Lưu thư nháp này trong Gmail? |
| `C.question.update_draft` | Update this Gmail draft? | Cập nhật thư nháp Gmail này? |
| `C.question.create_label` | Create this Gmail label? | Tạo nhãn Gmail này? |
| `C.mailbox.archive` | Archive this in Gmail? | Lưu trữ mục này trong Gmail? |
| `C.mailbox.unarchive` | Move this back to your Gmail inbox? | Đưa mục này về hộp thư đến Gmail? |
| `C.mailbox.mark_read` | Mark this as read in Gmail? | Đánh dấu đã đọc trong Gmail? |
| `C.mailbox.mark_unread` | Mark this as unread in Gmail? | Đánh dấu chưa đọc trong Gmail? |
| `C.mailbox.star` | Star this in Gmail? | Gắn sao trong Gmail? |
| `C.mailbox.unstar` | Remove the star in Gmail? | Bỏ gắn sao trong Gmail? |
| `C.mailbox.trash` | Move this to the Gmail trash? | Chuyển mục này vào thùng rác Gmail? |
| `C.mailbox.untrash` | Take this out of the Gmail trash? | Lấy mục này ra khỏi thùng rác Gmail? |
| `C.mailbox.add_labels` | Add these Gmail labels? | Thêm các nhãn Gmail này? |
| `C.mailbox.remove_labels` | Remove these Gmail labels? | Gỡ các nhãn Gmail này? |
| `C.labels.name` | Name | Tên |
| `C.labels.labels` | Labels | Nhãn |
| `C.labels.appliesTo` | Applies to | Áp dụng cho |
| `C.labels.conversation` | The whole conversation | Cả cuộc trò chuyện |
| `C.labels.oneEmail` | One email | Một email |
| `C.work.source` | From Work on this Mac | Từ Work trên máy Mac này |
| `C.work.approved` | Approved. | Đã duyệt. |
| `C.work.declined` | Declined. Nothing was changed. | Đã từ chối. Không có gì thay đổi. |
| `C.work.superseded` | A newer request from Work replaced this one. | Một yêu cầu mới hơn từ Work đã thay thế yêu cầu này. |
| `C.work.expired` | This request expired. | Yêu cầu này đã hết hạn. |
| `C.work.changed` | This doesn’t match what Work asked for, so it can’t be approved here. | Nội dung này không khớp với yêu cầu của Work nên không thể duyệt ở đây. |
| `C.approve` · `C.decline` | Approve · Decline | Duyệt · Từ chối |
| `C.approving` · `C.declining` | Approving… · Declining… | Đang duyệt… · Đang từ chối… |
| `C.labels.quote` | Quoted message | Tin nhắn được trích dẫn |
| `C.labels.truncated` | The quoted message is shortened. | Tin nhắn trích dẫn đã được rút gọn. |
| `C.approved` | Approved. Your assistant will carry it out. | Đã duyệt. Trợ lý sẽ thực hiện việc này. |
| `C.declined` | Declined. Your assistant won’t do this. | Đã từ chối. Trợ lý sẽ không thực hiện việc này. |
| `C.superseded` | A newer request replaced this one. | Một yêu cầu mới hơn đã thay thế yêu cầu này. |
| `C.closed` | This request is no longer waiting for you. | Yêu cầu này không còn chờ bạn nữa. |
| `C.changed` | This draft doesn’t match what your assistant proposed, so it can’t be approved here. Ask for a fresh one. | Bản nháp này không khớp với đề xuất của trợ lý nên không thể duyệt ở đây. Hãy nhờ soạn lại. |
| `C.retry` | Couldn’t reach Atum. Try again. | Không kết nối được với Atum. Hãy thử lại. |

| Key (`W` = `shared.matrix-google-write-copy.MATRIX_GOOGLE_WRITE_COPY`) | en | vi |
|---|---|---|
| `W.message.send-email` | Send this email? | Gửi email này? |
| `W.message.create-event` | Add this event to your calendar? | Thêm sự kiện này vào lịch? |
| `W.message.update-event` | Save these changes to your calendar? | Lưu thay đổi này vào lịch? |
| `W.labels.to` · `cc` · `bcc` | To · Cc · Bcc | Đến · Cc · Bcc |
| `W.labels.subject` | Subject | Tiêu đề |
| `W.labels.forwarded` | Forwarded message | Thư được chuyển tiếp |
| `W.labels.attachments` | Attachments | Tệp đính kèm |
| `W.labels.inReplyTo` | Replies in the same conversation. | Trả lời trong cùng cuộc trò chuyện. |
| `W.labels.title` | Title | Tên |
| `W.labels.start` · `end` | Start · End | Bắt đầu · Kết thúc |
| `W.labels.location` | Location | Địa điểm |

### Desktop wording to review across locales

- **English fallback.** All 36 `C.*` keys read English in ja, zh and zh-Hant, as desktop shows them. Translating
  them belongs in desktop first.
- **A mixed-language card.** On desktop the whole card is English in ja, zh and zh-Hant: `copies.en` spreads
  the shared table's English question and labels. The 14 `W.*` keys carry the shared table's own ja, zh and
  zh-Hant words, which desktop's main-process write dialog shows. A phone card built from these keys therefore
  shows translated questions and field names next to English actions and states in those three locales. For
  exact desktop parity in those locales, the phone can read the `en` localization of the `W.*` keys. The real
  fix is the desktop translation of `copies`.

### Phone wording the export does not have yet

Desktop's provenance line is `C.work.source`, "From Work on this Mac" / "Từ Work trên máy Mac này". On the
phone, "this Mac" would point at the phone, so the phone needs "From Work on your Mac". Desktop source was not
changed in this wave, and phone copy comes only from this export (owner ruling, top of this doc). So the phone
lane should not type the words itself. The pattern for words only the phone shows is the desktop phone table,
`apps/desktop/src/matrix/mobile-device-copy.ts` and its `.trace.json` (`teamSpaceSoon` is one such key).
Follow-up for desktop:

- Add a phone key there (suggested name `workGoogleWriteSource`), in all five locales. en "From Work on your
  Mac". vi "Từ Work trên máy Mac của bạn" (suggested, to be reviewed). ja, zh and zh-Hant fall back to English,
  as `C.*` does, unless desktop translates them.
- Then export it in a following wave.

Until that lands, the phone's Work card has no correct provenance words in the export.

Phone mapping notes, from `google-write-card.tsx:393`: a Work card that settles as `closed` shows `C.work.expired`.
An assistant's card that settles as `expired` shows `C.closed`. The other states map to the same name
(`C.work.<state>` for Work, `C.<state>` for an assistant). `C.work.source` is drawn only on Work's card (`:427`).

### For the phone repin

- Manifest SHA-256: `e9136dc388da23f8c88fddfff22d9b63db60abd53023182d8ee6e450bc874c39` (was
  `8a9f52066a4990850ca3c242e1915da29d166e2adfa2c22f3250b15598d8eacb`).
- Changed file hashes: `Localizable.xcstrings` `eca4f73011571be5e78d3eda11a15dd9acc94c4eef1a7b4fc2cf93096d75bee6`,
  `copy-contract.json` `198fcf28decca8f94f97487fbd32b8ed2ccb006912614d7f20536afd7b9ad79d`,
  `copy-inventory.json` `ed5b5624767ee88e0c3f7ff7144f67cbec6339f1c0cda16eee809976a5f35001`.
  `schemaVersion` stays 1, and the manifest keeps its 44 members.
- Rekeys: none. The phone only gains keys.

### Checks

- Producer: `export.mjs` and `export.mjs --check` exit 0 in a scratch root holding this tree's `apps/desktop`
  and `packages/atum-kit` (`git archive 3f56c918`). Tests pass 48 of 48. That includes the new Google write
  card test, which:
  - pins all 50 keys in en and vi against the desktop source;
  - checks that ja, zh and zh-Hant of the 36 card words are the English, and that the shared words are
    desktop's own in every locale;
  - fails if any other key of either table is exported;
  - checks the inventory row.

  The partial-table test now covers only the video consent table. The same eight glyph aliases as wave 4g got
  throwaway entries for the run only. `glyphs.json` is not spliced.
- Splice: `wave4/splice4.mjs` with `wave4h/spec.json` added 50, refreshed 0 and removed 0. All 44 manifest
  hashes match their files.
- No desktop source changed, so desktop typecheck, lint and vitest have nothing new to cover. The outbound
  guard results are in the commit.
