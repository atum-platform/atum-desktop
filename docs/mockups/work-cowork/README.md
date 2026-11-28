# Work, Cowork style: mockups

Owner, 2026-11-28: "Work mode still uses 'threads', worktrees etc. - also no way to choose which
project/folder to work in? I think Claude Cowork does very well, we should learn from it", "ability to
organize threads by projects too - see if we can pick up from Hermes, might have it already solved",
and "there's also still a straggling redundant plus icon on the titlebar in Work? What does that do".

Open [`index.html`](index.html) for the frames, with a light/dark toggle. Rebuild:
`python3 docs/mockups/work-cowork/src/build.py` (real Atum Kit CSS and Phosphor icons, headless
Chrome; `--html-only` skips screenshots). The `built/` screenshots come from atum-work's browser tests.

| # | Frame | Light | Dark |
| --- | --- | --- | --- |
| 01 | Work home: greeting, one composer, Project or folder under it, starters, Recent files | ✓ | ✓ |
| 02 | Project or folder: every project (each assistant has one), Choose a folder… | ✓ | ✓ |
| 03 | Sessions by project; the list's + is the one New (New session, Add project…) | ✓ | ✓ |
| 04 | The title band's plus: before and after | ✓ | |

## Native inventory

- **T3 (atum-work) is already project-based.** A project is a folder; threads belong to one; the draft
  hero owns a project picker (`apps/web/src/components/chat/DraftHeroHeadline.tsx`), and T3 ships a
  project-folder list (Labs `boringSidebarEnabled`, `groupSidebarThreadsByProject` in
  `Sidebar.logic.ts`, `SidebarProjectFolderHeader.tsx`). Work flattened it: the folder list is off by
  default, the picker was a muted word inside "Files in … are in reach" (`WorkDraftHero`), absent on a
  no-project draft, and the project filter was hidden in Work (`SidebarThreadHeader.tsx`, being restored
  by atum-work #10). Folder choice existed only as "Add project" in the command palette.
- **Hermes has first-class Projects.** `hermes_cli/projects_db.py`: a named, multi-folder workspace per
  profile; a session belongs by longest cwd prefix; `tui_gateway/server.py` `projects.*` RPCs and
  `tui_gateway/project_tree.py` group sessions into project → repo → lane for Hermes' desktop sidebar.
  Work runs on T3's server, whose project is one folder; for the reader both say the same thing (a
  named folder with sessions under it). Work mirrors T3's store and T3's folder list, so there is no
  second project store to sync. Multi-folder projects stay a Hermes feature for now.
- **The band's plus.** atum-desktop `src/app/work/work-band.tsx` `WorkRosterControls` ("New…") ran New
  thread / New thread in a worktree / Add project through `runCommand` → the view's
  `window.atumWorkCommands`; the view's list `+` (`AtumNewMenu`) runs the same three. Redundant.

## Decisions

- **Sessions**, not Tasks: tasks already mean the company board's kanban cards. Code mode keeps T3's
  threads and worktrees.
- **One New**: the list's `+` (New session, Add project…), ⌘N, and the home composer. The band drops its
  plus.
- **No permission chip in Work**: approvals stay the inline Allow / Not now; the default is automatic.
- **Model and thinking level** stay the composer's own chip (the shared picker, atum-desktop #164).
- **Choose a folder…** is T3's Add project flow (Finder); Drive folders are reachable there.
- **Starters** stay on the no-project draft, as shipped in atum-work #9.

## What ships first, what waits

- Built (atum-work `feat/work-cowork-projects`): frames 01 (without Recent files), 02, 03.
- Built (atum-desktop `fix/work-band-single-new`): frame 04.
- **Recent files** (frame 01) waits for slice 2: the desktop hands the agent's Drive deliverables
  (Cowork S1, #151) to the view; View all opens the Drive deliverables folder.
- **Agent projects** (one per assistant, owner 11-27) are not created yet; once they exist they show
  in the chip and the list with no further view work.
