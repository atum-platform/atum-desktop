# Team Space revamp, pass 1 (2026-11-24)

This pass covers the desktop renderer only. It follows §3, "UI/UX critique and Opus revamp brief", of the
Team Space audit dated 2026-11-23. The aim is a calm workspace for a 3–20 person company. It keeps the
Slack-style sidebar, the title-bar Chat · Board · Marketplace tabs, the existing message components and the
existing atoms. It adds no second chat system, no new hierarchy and no runtime dashboard.

All shots come from the design playground (`matrix-playground.html`), which runs the real Matrix window on
fixture data, at `?scenario=team-space-threads&company=team&evidence=1` unless noted. The people, channels and
tasks are the playground's invented fixtures, and no demo activity was added. Each `before-*.png` is the same
view on `origin/main` (`df8195e2`).

## Design decisions

1. **The workspace has one right pane.** A thread, the pinned list, info (company or channel members), search
   results and a task's details all share it, and opening one closes the others. Each owner keeps its own state.
   `team-space/detail-pane.ts` only records which kind holds the pane, so no second store or hierarchy was
   added. All of them use the same geometry (26 rem, full width when narrow).
2. **Search starts from the box at the top of the workspace.** Typing still filters the sidebar. Enter, or the
   "Search “…”" row below the box, runs company message search and shows the results in the right pane. Search
   no longer appears in settings. This follows the owner's "roster search is global search" rule.
3. **Settings show one section at a time: People, Workspace, AI and Billing.** A section appears only when the
   viewer can use it. Billing is for owners and admins. If a role changes while settings are open, the sheet
   falls back to the first section the viewer still has. The AI section says "Company hiring is being prepared"
   in one line while the Marketplace tab is hidden. The audit recommended this, and the hide-until-hireable
   rule is unchanged.
4. **The board has two views, Board and List, plus one "Mine" filter that works in both.** The old third view,
   "My tasks", is now List with Mine on, and a saved "My tasks" preference opens that way. Cards are compact:
   title, owner and due date, plus priority only when it is not normal and checklist progress. The project shows
   as a tooltip, and the description and discussion are in the task's details.
5. **Suggestions look provisional.** The Suggested lane is see-through with a dashed outline, and its cards are
   dashed. Its title has a tooltip: "Not on the board until someone accepts it". The lane is hidden when no
   suggestions are waiting.
6. **Task details show the latest change, with its source and Undo.** "Show all activity (n)" opens the full
   history.
7. **The channel pane shows one short line and at most one action.** The states are opening, "Preparing your
   channel…", and "Couldn’t open this channel." with Try again. A failed open now replaces the previous
   transcript. Before, the old channel stayed on screen as if the click had done nothing.
8. **The two Chiefs of Staff have different names.** "Chief of Staff" is the shared one in channels. "Private
   Chief of Staff" is the person's own row under Direct messages. In the sidebar, names now keep most of the
   row and the status beside them shortens first, so a long name no longer pushes badges out.

## Brief items

| Brief item | State | Shot |
| --- | --- | --- |
| Search out of settings, into the workspace header, results in a focused pane | Done | `02-search-pane`, `03-search-results`, `20-narrow-search` |
| One right detail pane: thread / info / pins / task, one replaces the other | Done | `04-thread-pane`, `11-task-detail` |
| Settings split People / Workspace / AI / Billing, one at a time | Done | `05`–`07`, `before-settings` |
| Returning to an active channel | Unchanged (already right) | `01-channel-active` |
| New company | Unchanged (one card, one action) | `21-new-company` (`?scenario=chat&company=empty`) |
| Channel preparing / failed + retry | Done | `17-channel-failed` (`&channelOpen=fail`). Preparing is covered by a test; the playground can't stage it. |
| Board empty / populated / filtered | Done | `08-board-populated`, `09-board-mine` (Mine, empty lanes kept as drop slots) |
| Board/List and "Mine" | Done | `08`, `09`, `10-board-list` |
| Compact cards | Done | `08`, compare `before-board` |
| Suggestions visibly provisional | Done | `08`, `12-task-detail-suggested` |
| Task detail with evidence, undo collapsed | Done | `11`, `12`. The Show all toggle appears with more than one activity event. |
| Shared vs private Chief of Staff labels | Done (labels) | `01` sidebar, `18-private-cos` (`?scenario=team-space-private-cos`) |
| Marketplace owner / member / empty / uncertain purchase | Already built; shown | `13`, `14`, `16` (`&marketplace=empty`, new fixture mode), `15` (`&marketplace=pending`, "Check again" stays on the row) |
| Marketplace loading | Already built (spinner) | Not shot: the tab is hidden until the Store answers, so loading appears only on a refresh |
| Narrow window | Done | `19-narrow-sidebar`, `20-narrow-search` (the pane takes the full width) |
| Role removed while a pane is open | Done | Panes release on unmount or company change (`detail-pane.test.tsx`). Settings fall back to a section the role still has. |
| Unread / followed threads | Unchanged | The existing Threads view. Not reworked in this pass. |

## Not done in this pass

- No "only you see this chat" line was added to the private Chief of Staff chat, to avoid explaining a default.
- The playground's company search fixture returns no hits, so `03` shows the empty result. The results list is
  covered by `company-workspace.test.tsx`.

## Review round 1 (Sol cross-family review)

| Finding | Fix | Test |
|---|---|---|
| P1: a failed channel open in one company hid the next company's transcript, and Try again kept the old room | The failure is held with its company and room. It is shown only for that company, and cleared when another room or company comes on screen | `company-workspace.test.tsx` › keeps a failed channel open with its company… |
| P2: a remembered "My tasks" view kept forcing the viewer as owner | Migrated once to List plus the viewer's owner filter. After that the filter is ordinary | `company-board.test.tsx` › migrates a remembered My tasks view once… |
| P2: a channel's info pane stayed on the previous channel | Opening another room, or another room arriving as active, closes the members pane unless it is for that room | `team-space-channels.test.tsx` › closes one channel's info pane… |
| P2: changing the search tab or file type cleared results without searching | The typed query is searched again for the new tab or type | `company-workspace.test.tsx` › searches again for the typed query… |
| Own gap: private chat header and composer | Header and composer say "Private Chief of Staff" | `app.test.tsx` (existing private CoS test, updated) |
| Own gap: empty sidebar filter | Says "No matches" | `team-space-channels.test.tsx` › says No matches… |

## Files

- New: `src/matrix/team-space/detail-pane.ts` (and its test), `src/matrix/team-space/revamp-copy.ts`
  (en, vi, ja, zh, zh-hant).
- Changed: `company-workspace.tsx` (search pane, settings sections, channel pane states, info pane),
  `company-board.tsx` (views, Mine, compact cards, provisional lane, task pane, collapsed activity),
  `team-space/company-search.tsx` (`initialQuery` and `pane` props), `team-space/conversation-sections.tsx`
  (private label), `app.tsx` (thread and pins take the shared pane), `team-space-sidebar.module.css`,
  `styles.css`, and two playground fixtures (`?channelOpen=fail`, `?marketplace=empty`).
- No changes to `electron/`, `electron/matrix/company-store.ts`, `electron/matrix/device/*` or readiness.
