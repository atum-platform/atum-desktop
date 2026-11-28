# Agent place icon: where an assistant is working (2026-11-28)

The owner asked on 2026-11-28 to bring back the old icon that shows where an assistant is working: the cloud, the Mac mini, a MacBook. With relay this is usually clear from the model, plan and relay in use. The icon should match the per-Mac machine icons in the agent model picker (desktop #164).

Branch `feat/agent-place-icon`, based on `train/desktop-1128` (PR #179), because #164's machine icons are only on the train so far.

## What the owner sees

- **Roster rows.** A small icon sits right after each assistant's name. It shows a cloud, a Mac mini, a laptop, a Mac Studio, or T3's generic desktop for any other Mac.
- **Chat header.** The same icon follows the assistant's name.
- **Assistant card.** The same icon appears beside the name, after the main-agent badge.
- **No text.** The row and the header show only the icon. Hovering shows a tooltip: "Working in the cloud", "Working on Mac mini", or "Works on Mac mini, which is off". Screen readers hear the same words through `aria-describedby`, because the row's and the header's buttons are named by the assistant's name. The words are translated into vi, ja, zh and zh-Hant.
- **Same look as the picker.** The icon set, muted ink, 1.75 stroke and 14 px size all come from `machine-icon.tsx`. An offline Mac is dimmed to 40%, as in the picker's machine rows.
- **Unknown means no icon.** Nothing is drawn while the place is unknown. The window never shows a guess.

Renders come from the dev fixture `apps/desktop/agent-place-fixture.html`, made with `scripts/agent-place-shots.mjs`. They show the real roster component and the real header layout leaf, with four cloud assistants: one on an Atum model, one on a Claude plan through the Mac mini, one on a ChatGPT plan through a MacBook Air, and one whose only Mac (a Mac Studio) is off.

- [light](agent-place-icon-1128/agent-place-light.png), [dark](agent-place-icon-1128/agent-place-dark.png)
- Tooltip: [light](agent-place-icon-1128/agent-place-tooltip-light.png), [dark](agent-place-icon-1128/agent-place-tooltip-dark.png)

## The "old icon"

The old icon came from private atum-app `50adf8a4a09`, "fix(desktop): cloud/computer agent-home icon and a Kit popover", 2026-11-01. It sat in the title bar. A cloud meant the cloud and a computer meant a Mac, using Phosphor `Cloud` / `DeviceDesktop` in `agent-home-control.tsx` `PlaceIcon`. The icon was dimmed when the Mac was unreachable, and a moving dot showed during a move.

The public repo's `293b202d`, "feat(desktop): hide Mac-era UI for cloud-only assistants", 2026-11-11, removed the settled icon. It now appears only during a Mac-to-cloud move (`agentHomeTitleIconShown`).

That icon described the agent's *home*. In the cloud-only world every home is the cloud, so the place that changes now is where the *turns* run. That is why the new icon reads the relay route instead.

## Where the place comes from (one source of truth)

`src/matrix/agent-place.ts` holds one pure rule. It needs no new server field. The inputs are state the window already holds:

1. **Agent home.** An assistant whose home is a Mac (`MatrixAgentView.home.lives`, atum.agent-home/2.1) is working on that Mac. The icon is dimmed while `placement.reachability` is asleep or offline.
2. **Retired local paths are unknown.** If this Mac answers for the assistant (`macRole: 'answering'`), or the assistant is not on the cloud route, the place is unknown. These are the retired local paths, and the renderer has no reliable name for this Mac.
3. **No plan selection means the cloud.** This covers a cloud assistant on an Atum model or a connected model, where `work_selection_read` returns `selection: null`.
4. **A plan selection means the serving Mac.** The window takes the Mac that serves the selected plan *model*. That is `WorkAgentPlans.machines[plan]` from `work_subscription_read` facts, joined in `electron/work/surface/relay.ts` by #164. Allowed-Mac consent and per-Mac model lists are already applied there. The rule then picks:
   - the one serving Mac that is on;
   - otherwise, if every serving Mac is off, the only serving Mac there is, dimmed;
   - otherwise nothing. Two or more Macs that are on is ambiguous, because the cloud picks one per turn.
5. **Read state.** Before the plan read settles, or after it fails, the place is unknown.

The data path is the pickers' own shared store, `agent-plans-store.ts`, keyed `account:<user>` + principal. That is the same entry the composer chip, the card's Model row and the agent desk use, so a pick made in any picker moves the icon at once, including a pick still in flight. `useAgentPlace` (`agent-place-icon.tsx`) starts one `readAgentPlans` for a cloud assistant that has no entry yet, so an assistant whose chat was never opened still shows its place. It reads once per agent per change of Work's plan facts (`planStatusRevision` or the Work view state), however many surfaces draw it.

`main.log`'s `agent actions … place=cloud|local` line was considered and not used. It comes from `answering`, which says *cloud route* for every cloud agent, including one relaying through a Mac. It is a log, not a window input.

## Server field that would remove the ambiguity (not built)

When two or more Macs that serve the plan are on, the window cannot know which one ran the turn. The relay receipt has no machine. The exact addition would be:

- **Platform.** The relay operation, `status.openOperation` and the terminal receipt, carries the `deviceServiceId` of the Mac that accepted the turn. `work_selection_read` would return the latest one as `lastServedBy: { deviceServiceId, at }`.
- **Desktop.** `agentPlace` would prefer `lastServedBy` when it names one of the plan's serving Macs, and keep today's rule otherwise.

This is optional. Most owners have one Mac per plan, and today's rule already covers that case exactly.

## Files

- `apps/desktop/src/matrix/agent-place.ts`: the rule (pure).
- `apps/desktop/src/matrix/agent-place-copy.ts`: the tooltip and screen-reader words, in five locales.
- `apps/desktop/src/matrix/agent-place-icon.tsx`: `useAgentPlace`, `AgentPlaceIcon` and `AgentPlaceFor`, which reuse `MachineIcon` plus lucide's `CloudIcon` at the same stroke.
- `roster-conversations.tsx` (the row's `adornment` slot and `aria-describedby`), `app.tsx` (the header; hidden when the move-era title-bar home control already shows the place) and `assistant-card/assistant-card.tsx` (the name line).
- Dev only, never bundled: `agent-place-fixture.html`, `src/matrix/playground/agent-place-entry.tsx` and `scripts/agent-place-shots.mjs`.

## Verification

| Check | Result |
| --- | --- |
| `npx vitest run src/matrix/agent-place.test.ts src/matrix/agent-place-icon.test.tsx` | 17 passed |
| Neighbouring suites: roster, assistant card, app, model picker, plans store, agent home | 15 files, 882 passed |
| `npm run typecheck` (boundary, renderer, consumer-browser, electron) | pass |
| `npx eslint` on touched files | 0 errors. The warnings are pre-existing padding warnings on untouched lines |
| Renderer brand gate: the three renderer Vite builds as in `build-matrix-candidate.mjs`, then `node scripts/renderer-brand.mjs <out>` | "Atum branding verified in all three desktop renderers", rc 0 |
| `python3 scripts/public_guard.py --base origin/train/desktop-1128 --head HEAD` | rc 0 |

The full signed candidate build was not run. This is a public repo with free CI, so only a quick local sanity pass was run.
