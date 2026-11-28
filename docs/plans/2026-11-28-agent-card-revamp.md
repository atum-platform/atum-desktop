# Agent card revamp (design proposal, 2026-11-28)

**Status:** proposal for the owner to approve. Nothing is built yet.
**Authorization:** owner, 2026-11-28: "In general I think the agent card needs a UI revamp - it was
cobbled together from multiple things and now look scrappy and busy, hard to understand."
**Scope:** the assistant card (`apps/desktop/src/matrix/assistant-card/*`), both where it opens:
the side panel beside the agent's chat (`assistant-info-panel.tsx`, the main case) and the
sheet (Settings › Assistants and the roster). One card serves every agent; the primary agent
gets the same rows plus its privileges, with nothing hidden.
**Out of scope:** the Pause and Files *reads* (the `agent-card-pause-files` lane fixes them).
This design assumes they work and only changes where they sit and what they say.

## 1. What's wrong today

Today's card (mockup `docs/mockups/agent-card/today-light.png`) is one long scroll that grew a
piece at a time:

- **The first thing you see is a raw text box.** "What does X help you with?" is an 8-line
  textarea. For a hand-written persona it shows the whole instructions file: markdown headings,
  bullet syntax and workspace paths.
- **It's a settings dump, not a profile.** Eight unrelated rows share one group (Model,
  Notifications, Your devices, Pause, Pet, Skills, Background follow-ups, Routines), in no order
  a person would guess.
- **Rare actions get front-row space.** A full "Bot handle" section with a text field and a help
  sentence, and a red Delete row, are always visible. Both are used about once in the agent's
  life.
- **Too many sentences.** The privacy line, the handle help, "Changes apply from your next
  message.", Pause's status line and the long-instructions warning stack up.
- **Two controls overlap.** Pause ("starts nothing on its own") and Background follow-ups (work
  it starts on its own) sit four rows apart with no visible link.

## 2. Inventory

Frequency: **daily** (glanced at or used most days), **sometimes** (weeks), **rare** (once or a
few times in the agent's life), **state** (shows only when something is happening).

| # | Today's element (code) | What it does | Who needs it | Frequency | Decision |
|---|---|---|---|---|---|
| 1 | Face (`CardAvatar`): click/drop to change, crop dialog, "Remove photo" link under it | Identity; change the picture | everyone | rare to change, seen always | **Keep** the face. **Move** Change/Remove photo to "…" (hover band stays) |
| 2 | Name (`InlineNameField`), Main badge, locked-name tooltip | Identity; rename in place | everyone | rare to change | **Keep**; hover-to-rename stays; also **move** "Rename" into "…" |
| 3 | Title caption (`agent.title`) | Optional role line | some | rare | **Keep** under the name, only when set |
| 4 | "✓ Saved · Undo" note (`CardNote`) | Confirms a save, offers undo | everyone | state | **Keep** as is (shows at the field that saved) |
| 5 | Privacy line "In groups, X answers only you." | Trust: owner-only in groups | everyone | static | **Move** to the foot of "In this chat" (one muted line) |
| 6 | Message pill (sheet only) | Open the chat | sheet users | sometimes | **Keep** (sheet only, as today) |
| 7 | Notice band: save failed / photo error / changed elsewhere | Error and conflict | everyone | state | **Keep** (kit `.ak-notice`, top of the card) |
| 8 | Offline caption | Explains disabled edits | everyone | state | **Keep** |
| 9 | Now (`MatrixAgentDeskNowSection`): working/waiting, steps, Stop, device in use, cloud-stop notice | What it is doing right now | everyone | state | **Keep**, first under the header, unchanged |
| 10 | "Bot handle" section: title, help sentence, field (`AgentHandle` → `MatrixHandleEditor`) | How others find and @mention it | everyone | rare to change | **Merge** into the header as "@handle" under the name. **Move** "Copy @handle" and "Change @handle…" into "…" (the existing editor opens in a popover). Help sentence becomes the tooltip on the handle |
| 11 | Persona textarea "What does X help you with?" (8 rows, raw text for custom personas, expand button) | Its instructions | everyone | rare to edit, worth reading | **Replace** with an **About** section: a 3-line plain-text summary; **Edit** opens the editor sheet (the existing expanded editor). Raw text only appears in the editor |
| 12 | Personality row (opens in place) | Its tone | everyone | rare | **Keep** as a row in About (value = the words, "Not set" when empty); tap opens the same editor sheet |
| 13 | "Changes apply from your next message." | Sets expectations | editors | while editing | **Move** into the editor sheet |
| 14 | Long-instructions warning | Persona exceeds the load limit | rare | state | **Move** into the editor sheet, under the field |
| 15 | Lives on / home row (`MatrixAgentHomeRow`, only off-cloud or moving) | Where it runs; move to cloud | rare (cloud-only now) | state | **Keep** as a state row: a notice under the header while it's off the cloud or moving; absent otherwise (as today) |
| 16 | Model (`ModelDestinationsRow`) | Which model answers | everyone | sometimes | **Keep**, renamed **"Answers with"** (STYLE §12's own words), in "In this chat" |
| 17 | Notifications switch (this chat's mute) | Mute the chat | everyone | sometimes | **Keep** in "In this chat" |
| 18 | Your devices (popover list) | Macs it can use, Allow, Stop | everyone with a Mac | sometimes | **Keep** in "Can use"; value = the device in use, else the Mac's name, else the count |
| 19 | Pause switch + help line + Try again (`PauseRow`) | Stop everything it does on its own | everyone | sometimes | **Keep** in "On its own". Help lines become the switch's tooltip, except a failure (inline "Try again"). When paused, a notice with **Resume** shows under the header |
| 20 | Pet (Choose → Store) | Its companion pet | some | rare | **Keep** in "In this chat" **only once a pet is chosen**. Without one, "Choose a pet…" lives in "…" (open question 2) |
| 21 | Skills · N (popover list, Find more) | What it knows how to do | everyone | sometimes | **Keep** in "Can use" |
| 22 | Background follow-ups switch (`BackgroundSweepRow`) | Built-in follow-up sweep, on by default | rare to change | rare | **Merge** into Routines: shown as the first, built-in routine ("Follows up on open threads", switch) inside the Routines panel (open question 1) |
| 23 | Routines · N (`RoutinesRow` → panel) | Scheduled work | everyone | sometimes | **Keep** in "On its own". Value "3 routines", "None yet", "3 · paused" |
| 24 | Check-ins row (fallback when the routines bridge is missing) | Morning brief on/off | older runtimes | rare | **Keep** as the fallback in "On its own", in the Routines slot |
| 25 | Setup row (local runtime not ready, Set up) | Finish setup | rare | state | **Keep** as a state notice under the header with **Set up**, not a row among settings |
| 26 | Files (`MatrixAgentDeskFiles`): sent in this chat, On its computer (folder browse), empty, failed + Try again | What it made or sent | everyone | sometimes | **Keep**, last. One list, newest 3, then "Show all files · N" opens the full list (today's sections and folder browsing, unchanged). Empty: one line "No files yet." Failed: inline Try again |
| 27 | Delete X… (non-primary) | Retire the agent | rare | rare | **Move** to the bottom of "…", after a separator, in danger ink (STYLE §13 menu rule). The confirm dialog is unchanged |

Nothing is removed. Every function is still on the card, either visible or one tap away
(owner rule: simplify keeps functions).

## 3. Proposed structure

The card reads like a person's profile: who it is, what it's doing, how it works, then the
handful of settings grouped by what they're about.

```
[ face ]                                   …   ← photo, rename, handle, pet, delete
  Nova  (Main)
  @nova
[ Now: Working · 3 min …          Stop ]       ← only while working or waiting
[ Paused. Still answers you.    Resume ]       ← only while paused (one state notice at a time)
About                                   Edit
  Keeps my calendar tidy, drafts replies…      ← 3 lines, plain text
  Personality                Calm, keeps… ›
On its own
  Routines                     3 routines ›
  Pause                                [ ]
In this chat
  Answers with                 GPT-6 Luna ›
  Notifications                        [x]
  Pet                                 Pip ›    ← only once chosen
  In groups, Nova answers only you.
Can use
  Your devices                MacBook Air ›
  Skills                              121 ›
Files
  Weekly plan.docx  · Sent here · 2 h ago
  Meeting notes.pdf · Sent here · yesterday
  Reports           · On its computer      ›
  Show all files                       12 ›
```

**Visible by default:** face, name, @handle, About (summary + Personality), seven rows at most
in three small sections, and Files. **One tap away:** "…" (Change photo, Rename, Copy @handle,
Change @handle…, Choose/Change pet…, Delete…), the About editor, the Routines panel (with
follow-ups), the model picker, the devices list, the skills list, all files.

**Layout rules (kit only):**

- Sections are `.ak-section` labels over `.ak-group` rows. Each row is a 16–18 px Phosphor
  Light glyph in ink-2, the label, a muted value, and a caret or switch. The hairline starts at
  the label (STYLE §13).
- Side panel rhythm stays: 24 px sides, 24 px between sections, face 64 px (88 in the sheet),
  name in Title (20/26), @handle in Body ink-3.
- One state notice at a time, under the header, in this priority: save failure > not set up >
  off the cloud / moving > paused. Now (working/waiting) is not a notice and can sit above one.
- Sections with nothing in them are absent, except Files for a cloud agent whose computer can be
  read (owner 2026-11-27), which says "No files yet."
- No balances, no runtime or placement words, no explanatory paragraphs.
- The primary agent shows the same rows. Its privileges stay: the Main badge, the locked name
  with its tooltip, and no Delete in "…".

**About summary (the one new piece of logic):** a pure function turns the persona into display
text. It uses the template's "what it helps with" field, or for a hand-written persona the first
paragraph of prose. It strips markdown syntax (headings, bullets, emphasis, code ticks), drops
lines that are only paths or code, collapses whitespace and clamps to 3 lines. Empty →
"Not set yet." with Edit. The editor sheet keeps today's fields and save rules (blur or ⌘Return
saves, Esc puts back, Undo note). For a hand-written persona the sheet shows the full
**Instructions** text, the only place raw text appears.

## 4. Mockups

`docs/mockups/agent-card/` (420 px side panel, light and dark, @2x). They are built from the
real kit CSS and Phosphor set by `docs/mockups/agent-card/src/build.py`; rerun it to regenerate.

| State | Light | Dark |
|---|---|---|
| Normal | `normal-light.png` | `normal-dark.png` |
| Paused | `paused-light.png` | `paused-dark.png` |
| Files empty (new agent, no routines, no pet) | `files-empty-light.png` | `files-empty-dark.png` |
| Error (card info failed to load; other rows still work) | `error-light.png` | `error-dark.png` |
| Working (Now block) | `working-light.png` | `working-dark.png` |
| "…" menu open | `menu-light.png` | `menu-dark.png` |
| About editor sheet | `edit-about-light.png` | `edit-about-dark.png` |
| Today, for comparison | `today-light.png` | — |

## 5. Copy

English below with proposed Vietnamese. **Vietnamese is the source language in `copy.ts` and
needs a native review.** Chinese and the other two locales are needed before ship (STYLE §15).
Strings marked *existing* are reused unchanged.

| Key (proposed) | English | Vietnamese (proposed) |
|---|---|---|
| `more` (… tooltip) | More | Thêm |
| `menuPhoto` | Change photo | Đổi ảnh |
| `photoRemove` *existing* | Remove photo | Xoá ảnh |
| `menuRename` *existing* | Rename… | Đổi tên… |
| `copyHandle` *existing* | Copy @{handle} | Sao chép @{handle} |
| `menuChangeHandle` | Change @handle… | Đổi @tên… |
| `handleTip` (= `botNameHelp`) *existing* | Others type this @name to find and mention the assistant. | Người khác gõ @tên này để tìm và nhắc đến trợ lý. |
| `menuPetChoose` / `menuPetChange` | Choose a pet… / Change pet… | Chọn thú cưng… / Đổi thú cưng… |
| `deleteRow` *existing* | Delete {name}… | Xoá {name}… |
| `sectionAbout` | About | Giới thiệu |
| `aboutEdit` | Edit | Sửa |
| `aboutEmpty` | Not set yet. | Chưa có. |
| `personality` *existing* | Personality | Tính cách |
| `personalityEmpty` *existing* | Not set | Chưa đặt |
| `editorTitle` | About {name} | Về {name} |
| `editorWhat` | What {name} helps with | {name} giúp bạn việc gì |
| `instructions` *existing* (hand-written persona) | Instructions | Hướng dẫn |
| `footnote` *existing* (now in the editor) | Changes apply from your next message. | Thay đổi áp dụng từ tin nhắn tiếp theo. |
| `done` *existing* | Done | Xong |
| `sectionOwn` | On its own | Tự làm |
| `routines` *existing* | Routines | Lịch tự động |
| `routineCount` *existing* + new `routineNone`, `routinePausedCount` | 3 routines · None yet · 3 · paused | 3 việc · Chưa có · 3 · đang tạm dừng |
| `pause` *existing* | Pause | Tạm dừng |
| `pauseHint` *existing* (tooltip) | Still answers you. Starts nothing on its own. | Vẫn trả lời bạn. Không tự bắt đầu việc gì. |
| `pausedTitle` | Paused | Đang tạm dừng |
| `pausedBody` (= `pauseHint`) | Still answers you. Starts nothing on its own. | Vẫn trả lời bạn. Không tự bắt đầu việc gì. |
| `resume` (= `routineResume`) *existing* | Resume | Tiếp tục |
| `followupsRoutine` | Follows up on open threads | Theo dõi việc còn dở |
| `followupsBuiltIn` | Built in | Có sẵn |
| `sectionChat` | In this chat | Trong trò chuyện này |
| `answersWith` | Answers with | Trả lời bằng |
| `notifications` *existing* | Notifications | Thông báo |
| `pet` *existing* | Pet | Thú cưng |
| `privacy` *existing* (section foot) | In groups, {name} answers only you. | Trong nhóm, {name} chỉ trả lời bạn. |
| `sectionCanUse` | Can use | Có thể dùng |
| `devices` *existing* | Your devices | Thiết bị của bạn |
| `skills` *existing* | Skills | Kỹ năng |
| `files` *existing* | Files | Tệp |
| `fileSentHere` | Sent here · {when} | Gửi ở đây · {when} |
| `fileOnComputer` (= `onItsComputer`) *existing* | On its computer | Trên máy của nó |
| `filesShowAll` | Show all files | Xem tất cả tệp |
| `noFiles` *existing* | No files yet. | Chưa có tệp nào. |
| `filesUnavailable` *existing* | Couldn’t load its files. | Chưa tải được tệp của nó. |
| `loadFailed` *existing* | Couldn’t load {name}’s info. | Chưa tải được thông tin của {name}. |
| `retry` / `tryAgain` *existing* | Try again | Thử lại |
| `saveFailed` *existing* | Couldn’t save. Your change is still here. | Chưa lưu được. Thay đổi của bạn vẫn còn đây. |
| `setupRowNotReady` + `setUp` *existing* (as a notice) | Not ready yet · Set up | Chưa sẵn sàng · Thiết lập |

Retired strings once built: `purposeLabel` and `purposePlaceholder` (they move into the editor
as `editorWhat`), `backgroundFollowups` as a card row label, and `botName` as a card section
title (it stays in Settings if used there).

## 6. Build slices

Each slice is mergeable alone, keeps every function, and ships with focused vitest coverage.
Behaviour tests come from rendering components, never from reading source (AGENTS.md).

1. **S1: Structure and order (UI, Opus).** Section labels and order, row glyphs, "Answers with"
   label, privacy line under "In this chat", state notices under the header (not set up, off
   the cloud, paused + Resume). `assistant-card.tsx` `CardRows` splits into three section
   components. No data changes. Tests: the order of sections and rows; the primary has the same
   rows; empty sections are absent.
2. **S2: Header and "…" menu (UI, Opus).** @handle under the name, with its tooltip. The "…"
   menu holds photo, rename, copy/change handle (the existing `MatrixHandleEditor` in a
   popover), pet and delete. The Bot handle section and Delete row are removed from the body.
   Tests: menu items per agent kind (primary has no Delete); Copy writes the handle.
3. **S3: About summary and editor sheet (UI + one pure helper).** `aboutSummary(persona)` in
   `shared/` with unit tests (markdown, paths, code, empty, CJK, Vietnamese). About section plus
   the editor sheet reusing `AutoField`'s expanded editor. The footnote and long-persona warning
   move there. Tests: save, Undo and Esc behave as today.
4. **S4: Follow-ups into Routines (engineering, Sol).** The follow-up sweep becomes the first,
   built-in item in the Routines panel, with its switch. The card row goes. If open question 1
   comes back "yes", Pause also covers follow-ups. Tests: the switch's read, save and retry
   paths survive the move.
5. **S5: Files compact list (UI), after `agent-card-pause-files` lands.** Newest 3 across sent
   and own files, "Show all files · N" opens today's full list with folder browsing. Empty and
   failed states as drawn.
6. **S6: Copy and contract.** All five locales from the shared catalog, phone export
   regenerated, `DESIGN.md` › Assistant card and `STYLE.md` §14 (side panel › agent's tab)
   updated to this structure, plus a design-contract check if one fits.

S1 and S2 can run in parallel (separate files: `CardRows` vs the header/`AgentHandle`). S3 and
S4 are independent. S5 waits for the pause-files lane. S6 lands last, or folds into each slice's
copy.

## 7. Open questions for the owner (max 3)

1. **Background follow-ups: fold into Routines as a built-in routine?** *Default: yes.* It shows
   as the first item in the Routines panel ("Follows up on open threads · Built in", on by
   default, with its switch), and the card loses a row. The alternative is to keep it as its own
   row under "On its own".
2. **Pet row: show only once a pet is chosen?** *Default: yes.* Until then "Choose a pet…" lives
   in the "…" menu, so the card has no "Pet · Choose" upsell row. The alternative is to always
   show the row.
3. **Should Pause also stop follow-ups?** *Default: yes.* "Starts nothing on its own" should be
   literally true, so one switch stops routines and follow-ups together. Today Pause covers only
   scheduled jobs (native cron), so this needs S4's engineering check.

Decided here without asking (reversible): the privacy line moves to the foot of "In this chat";
"Model" is renamed "Answers with"; Delete moves into "…"; the handle editor moves from a body
section into a popover from "…".
