# Agent card revamp: build record (2026-11-28)

Owner, 2026-11-28: "In general I think the agent card needs a UI revamp - it was cobbled together from
multiple things and now look scrappy and busy, hard to understand." On the proposal's three questions:
"go with your judgement", so all three are yes. Design of record:
`docs/plans/2026-11-28-agent-card-revamp.md` and `docs/mockups/agent-card/`. Built on
`feat/agent-card-revamp` from `origin/main` `b4cc076b`, in the plan's six slices, one commit each.

Every function on the old card is still there, visible or one tap away. The primary assistant shows the
same rows; its privileges are the Main badge, the locked name and no Delete.

## What changed

| Slice | What | Main files |
| --- | --- | --- |
| S1 Structure and order | Three sections (On its own, In this chat, Can use) replace the one long group. Row glyphs (18 px Phosphor Light, ink-2), hairline from the label. "Model" becomes "Answers with"; the privacy line moves to the foot of In this chat. One state notice under the header: not set up (kit notice with Set up), off the cloud or moving (the home row), or Paused with Resume. The panel's controls become slots (`useAssistantCardControls`) so one schedule read drives the Pause switch, the Paused notice and "3 · paused" on Routines. Pause's "nothing scheduled" moves to its tooltip; failures stay inline. Your devices names the Mac when there is one. | `assistant-card.tsx`, `agent-controls.tsx`, `row-glyph.tsx`, `copy.ts`, `styles.css` |
| S2 Header and "…" menu | @handle under the name (its help sentence is the tooltip). A "…" menu holds Change photo, Remove photo, Rename…, Copy @handle, Change @handle… (the existing handle editor, in a popover), Choose a pet… / Change pet…, and Delete {name}… after a separator in danger ink. The Bot handle section, the Remove photo link and the Delete row leave the body. The Pet row shows only once a pet is chosen (owner question 2). | `card-menu.tsx`, `assistant-card.tsx`, `name-field.tsx` |
| S3 About and editor | About shows what it helps with as three lines of plain prose plus Personality; Edit opens the "About {name}" sheet (what it helps with, or a hand-written persona's whole Instructions, and personality). Save rules unchanged; the footnote and the long-instructions warning move into the sheet. `matrixAssistantAboutSummary` is the one new pure helper. The old window-sized expand editor folds into the sheet. | `about-section.tsx`, `shared/matrix-assistant-about.ts`, `persona-fields.tsx` (removed) |
| S4 Follow-ups into Routines | The follow-up sweep is the first, built-in item of the Routines panel ("Follows up on open threads", "Built in", its switch); the card row goes (owner question 1). Same read, save, conflict and retry paths. A window without the routines list keeps it as a row. The playground gains a follow-up fixture. | `background-sweep-row.tsx`, `routines-panel.tsx`, `playground/routine-fixtures.ts` |
| S5 Files | One list: the newest three across sent-in-this-chat and its computer, then "Show all files · N", which opens the full lists in place (Save, folder browsing) with Show less. A sent file's row saves it; a folder opens the full list there. "No files yet." and the failed read with Try again stay. | `agent-desk.tsx` (`MatrixAgentDeskFiles`) |
| S6 Copy and contract | New strings in all five locales (en, vi, ja, zh, zh-Hant); retired `purposeLabel`, `expandField`, `fieldKeys`, `backgroundFollowups`, `setupRow` and the card's `petChoose`; "No routines" reads "None yet". `apps/desktop/DESIGN.md` gains the assistant card; Atum Kit `STYLE.md` §14 (side panel › agent's tab) describes the new structure. | `copy.ts`, `DESIGN.md`, `packages/atum-kit/STYLE.md` |

## Open items

- **Pause does not stop follow-ups (owner question 3: yes, needs the platform).** The follow-up sweep is
  scheduled by the platform (`atum_private.agent_jobs` rows `as_<agent>`, `clock_state='external'`,
  source `sys_followup_sweep_v1`, migration `0381_native_sweep_jobs.sql`) and claimed by the controller.
  The host's Pause (`/v1/shell/agent-control` → `packages/cloud-sandbox/host/native_agent_control.py`
  `apply_control`) pauses only the agent's own cron `jobs.json`, and the desk's schedule read lists only
  that file, so the card can say Paused while sweeps still run. Smallest fix, in the platform: the sweep
  claim refuses while the owner has paused the agent (or Pause holds the sweep and Resume restores the
  prior setting). A client-side "also switch follow-ups off" was rejected: it loses the prior value
  across devices, overwrites a deliberate choice on Resume and is not atomic.
- **Vietnamese copy needs a native read** (the plan's proposed strings, used as written), and the ja,
  zh and zh-Hant strings were written here without a native review.
- **Phone export.** `packages/mobile-design-exports/dist` is a reviewed snapshot that cannot be
  regenerated in this repository. The next export wave should add the new card keys and drop the six
  retired ones.
- **Playground on `main` is broken** by #149: `shared/browser/update-restore.ts` imports
  `shared/browser/policy.ts`, which imports `node:net`, so the renderer throws on load in the Vite
  playground. Screenshots here used a local, uncommitted Vite alias for `node:net`. Worth checking that
  the packaged renderer is not affected.
- **Overlap with #164** (agent picker): both touch `assistant-card/model-destinations-row.tsx`. This
  branch only adds a `glyph` and `label` prop to the cloud row's trigger; `git merge-tree` against
  `origin/feat/agent-picker-t3-multimac` merges with no conflict. #164's picker is kept as is.

## Verification

Run on 2026-11-28 in `apps/desktop` (Asia/Ho_Chi_Minh).

| check | command | result |
| --- | --- | --- |
| typecheck | `npm run typecheck` | rc 0 (client boundary, `tsc` for the app, consumer-browser and electron projects) |
| lint | `npx eslint <changed files>` | 0 errors; 0 warnings on lines this branch adds (the files carry 46 older warnings) |
| focused suites | `npx vitest run src/matrix/assistant-card src/matrix/assistant-info-panel src/matrix/agent-desk.test.tsx src/matrix/app.test.tsx src/matrix/agent-home-control.test.tsx src/matrix/agent-home-cloud-only.test.tsx src/matrix/execution-policy-control.test.tsx src/matrix/playground src/matrix/roster-context-menu src/app/atum shared/matrix-assistant-about.test.ts shared/matrix-assistant-persona.test.ts` | 2223/2226 on the full set; the 3 failures were the roster card test still waiting for the old inline field (fixed: it checks About now) and the two known 15 s "returns to the last Chat from every rail screen" timeouts under load, which pass alone. After the fix: `src/matrix/assistant-card` + `shared/matrix-assistant-about.test.ts` 181/181, the three `app.test.tsx` cases pass |
| public guard | `python3 scripts/public_guard.py --base origin/main --head HEAD` (repo root) | rc 0, "PASS: 7 new commits" (a fixture UUID in the playground follow-up stub was replaced by the principal so no new identifier is added) |

Tests are behaviour tests from rendered components: section order and the same rows for the primary,
the "…" menu per agent kind (no Delete for the primary), Copy writes the handle, Rename opens the name
field, the Pet row only once chosen, the About summary and editor (Edit, Personality row, ⌘Return,
Done, Esc in a field then Esc for the sheet), follow-ups inside Routines with their switch, the Paused
notice and Resume, and the compact Files list (order, Save, Show all, folder).

## Screenshots

`docs/mockups/agent-card/built/`, the agent's side panel in the playground
(`matrix-playground.html?scenario=chat&evidence=1&desk=…&card=…`), light and dark, @2x:

- before: `before-normal-*`, `before-working-*`, `before-primary-*` (taken at `origin/main`)
- after: `after-normal-*`, `after-working-*`, `after-primary-*`, `after-menu-*`, `after-editor-*`,
  `after-routines-*`

`shoot.mjs` in the same folder reproduces them against `npx vite --host 127.0.0.1 --port 5174`. The
playground has no Macs, so Your devices does not show there; `app.test.tsx` "keeps the agent's
controls in its panel" covers it. Its alias fixture answers every handle as `@minh`.
