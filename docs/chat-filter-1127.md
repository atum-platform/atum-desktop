# Chat roster filter (2026-11-27)

Owner ask: "chat should have filter too - a button next to the search bar and the plus icon, like in Work".

## What changed

- The Chat roster's search row is now search, filter, plus: the same order as Work's sidebar
  (search, project-scope filter, plus in `atum-work` `apps/web/src/components/sidebar/SidebarThreadHeader.tsx`).
- The filter button is the same 28 px `ak-iconbtn` as the plus beside it, and its menu is the same
  `DropdownMenu` popover, with single-select radio items and a check on the current one.
- Filters are Matrix's own, as Element X offers them: All, Unread, People (DMs), Groups, Assistants,
  Favourites (`m.favourite`) and Low priority (`m.lowpriority`). Only filters with something to show
  are offered. All is always first and resets.
- A filter narrows the roster's sections in place, and the search still applies on top of it.
  While a filter is on, the funnel is filled and the button's label names the filter.
- The last choice is kept per account (`atum.desktop.rosterFilterByAccount.v1`, the same pattern as
  `last-chat.ts`). A saved filter with nothing left to show reads as All, so the roster never goes blank.

## Files

- `apps/desktop/src/matrix/roster-filter.ts`: the filter predicates, available filters and per-account memory.
- `apps/desktop/src/matrix/roster-filter-button.tsx`: the button and its menu.
- `apps/desktop/src/matrix/roster-conversations.tsx`: applies the filter before the search.
- `apps/desktop/src/matrix/app.tsx`: the search row (filter between search and plus) and its state.
- `apps/desktop/src/matrix/roster-create-copy.ts`: menu words in five locales.
- `apps/desktop/src/matrix/playground/fixtures.ts`: one favourite and one low-priority chat in the
  `roster` scenario, so every filter shows in the playground.
- `apps/desktop/scripts/chat-filter-shots.mjs`: light and dark screenshots from the playground.

## Verification

- `npm run typecheck` (apps/desktop): pass.
- eslint on the changed files: 0 errors. The warnings are all in lines this change didn't touch.
- vitest: the new `roster-filter.test.ts` (each filter, availability, fallback, per-account memory)
  and `roster-filter-button.test.tsx` (menu items, selection, active label, in-place roster
  filtering) pass, along with the roster suites and `app.test.tsx`.
- Screenshots: `node scripts/chat-filter-shots.mjs http://127.0.0.1:5197 <dir> <chrome>` against
  `npx vite --host 127.0.0.1 --port 5197`.
