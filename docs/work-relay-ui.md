# Session-handoff relay: the owner's chrome (relay slice R1, lane U1) · 2026-11-22

Lane U1 of the session-handoff relay plan (`docs/plans/2026-11-22-session-handoff-relay.md` in atum-app, branch
`docs/session-handoff-relay-1122`: §3.1, §3.4, §3.6, §6, row U1 of §4, RT4, RT5, RT9, RT12, RT19, §12 O1, O4, O9, O12–O14). This
branch is `feat/relay-r1-ui-1122` from `origin/main` b97b16d9. **Local commit only**: nothing was pushed, no CI ran, no PR exists.
This is UI and view-model code only. **The data wiring is not done.** It is being built separately (G1/H1/P1), and the coordinator
connects it. Nothing here is live.

Authorization: the owner asked for the session-handoff relay on 2026-11-22 and made it top priority. Plan decisions O1–O16 are final.

## What is built

| Piece | Where | What it does |
|---|---|---|
| View-model input | `apps/desktop/shared/matrix-work-relay.ts` | Plain mirrors of the `atum.work-route/1.3` fields the screens read: `{selection, openOperation, limits, consent, connected, localSwitch}`, the plan facts, the receipt classes. It also holds the output type `WorkRelayTurnChrome`. No zod: the strict readers stay in main and the cloud |
| View-model | `apps/desktop/src/app/work/relay-view.ts` | Pure functions: `workRelayPickerView` (the greying rule), `workRelayTurnChrome` (one turn's line), `workRelayFallbackReason`, `workRelayUsage`, `workRelaySharedContext` |
| Words | `apps/desktop/src/app/work/relay-copy.ts` | English and Vietnamese, as Work's own copy. Other languages read English until they are written |
| Components | `apps/desktop/src/app/work/relay-chrome.tsx` | `WorkRelayTurnLine`, `WorkRelayMessageLine` (transcript), `WorkRelaySharedContextLine`, `useWorkRelayUsageText` |
| Picker | `apps/desktop/src/matrix/model-picker.tsx` | New optional prop `workRelay: MatrixModelPickerRelay`. Absent means D6 as before. It is the same two-column picker, not a new one |
| Transcript | `apps/desktop/src/matrix/app.tsx`, `shared/matrix.ts` | `MatrixMessage.relayTurn`: one line drawn where the fallback line is drawn |
| Stop | `apps/desktop/src/app/work/store.ts` | `$workRelayStop`. While it is null, a held line shows no Stop: there is never a button that does nothing |
| Work page (O14) | `work-screen.tsx` | `relayChats` prop: one line above the Work view |
| Settings | `work-settings.tsx` | `planLimit`: usage added to the connected plan row. `relayChats`: the consent sheet's chats sentence |
| Consent sheet | `plan-consent.tsx` | `scope: 'work' \| 'chats'`. `chats` reads "Your chats with them run on your Mac with this plan. Stop it anytime." and "Also for scheduled work". The default stays slice B's text, so the sheet never claims what is not live |
| Playground | `src/matrix/playground/relay-fixtures.ts`, `relay-gallery.tsx` | `?scenario=chat&relay=<state>` and `?view=relay&relay=<state>` |

## The rules, and where each is enforced

| Owner rule | Enforced in | Tested in |
|---|---|---|
| A plan model greys out **only** when no Mac has the plan connected and consented for this assistant. An asleep or offline Mac does not grey it (RT4). A `stale` fact counts as connected | `workRelayPickerView` | `relay-view.test.ts` ("keeps it selectable while that Mac is asleep…", "needs only one Mac"), `model-picker.test.tsx` ("relay R1 … while its Mac is offline (RT4)") |
| A greyed row shows the one fixing action: **Connect** when no Mac has the plan, **Allow** when consent does not name this assistant on a connected Mac. O1 (holds Google) and O9 (encrypted) show one line and no action | `workRelayPickerView` (`fix`), picker note action | both test files |
| One picker everywhere | `MatrixModelPicker` extended with a prop. A pick calls `workRelay.select(model)` (`work_selection_set`) and never the 1.4 plan write | `model-picker.test.tsx` |
| Never show the fallback cost. Use the red composer warning where it already exists | `workRelayChip` → the existing chip glyph and tooltip. Words are checked for no Proton, `$`, relay, token or cost | `relay-view.test.ts` ("the words…"), `model-picker.test.tsx` (chip) |
| The fallback is Nguyệt Thực. Its line appears only when the Atum model really answered | `workRelayTurnChrome`: a fallback comes only from the cloud's reason or a **refused** receipt. `ambiguous`, `none`, `failed` and `revoked` never produce one | `relay-view.test.ts` ("never reads a fallback from anything but a refused receipt") |
| No chip warning for a held run (O4) | `workRelayChip` ignores held kinds | `relay-view.test.ts` |
| Airy: one line and at most one action. Status is UI chrome, never an agent message | `WorkRelayTurnLine` (one `<p>`, at most one button). Every line is 64 characters or fewer | `relay-chrome.test.tsx`, `relay-view.test.ts` |

## Chrome states

| State | Line | Where | Action |
|---|---|---|---|
| Answered on the plan | none | none | none |
| Fallback | "Nguyệt Thực answered · your Mac was off" / "ChatGPT wasn't allowed" / "ChatGPT is off on your Mac" / "ChatGPT limit reached" / "ChatGPT couldn't answer" | under the reply | none |
| Waiting on the Mac (a hold, or running past the 10-minute UI wait, or an ambiguous receipt) | "Waiting for your Mac" | under the owner's message | Stop |
| Needs an OK (approval; R1 treats a question the same way) | "Needs your OK on your Mac" | owner's message | Stop, or Open Work when the owner is on the bound Mac |
| Held at the plan limit | "ChatGPT limit reached · continues at 5:36 PM" | owner's message | Stop |
| Stop owed, not yet confirmed | "Stopping…" | owner's message | none |
| Stopped (also covers cut) | "Stopped" | owner's message | none |
| Queued behind the open operation | "Waiting for the reply above" | owner's message | none |
| Late answer (O13) | "Finished on your Mac at 3:56 PM" | under the reply | none |
| Finished with no answer | "Finished on your Mac · no answer" | owner's message (no reply exists) | none |
| Failed | "Didn't finish on your Mac" | owner's message | none |
| Shared context (O14) | "What you type in Rin's chat here can show up in its replies." | Work page, above the view | none |
| Plan usage | "Connected on this Mac · 42% used · resets 6:59 PM" ("Usage not reported" when unknown) | Settings › Work, plan row | the existing Manage |
| Composer chip | "ChatGPT limit reached · back at 5:34 PM", a fallback line, or the greyed reason | chip tooltip, red glyph | the chip opens the picker |

## For the coordinator: how to connect it

1. **Picker.** Build `workRelayPickerView({plan:'codex', agentPrincipal, account:{consent, facts}, selection, holdsGoogle, encrypted, limit, lastTurn})`
   from `work_subscription_read` and the 1.3 sync's `selections`. Pass `{view, select, fix, models}` as `workRelay`. `fix('connect')` opens
   the Connect step (`openWorkPlanConnect`), or Work when there is no Connect on this Mac. `fix('allow')` opens the consent sheet with
   `openWorkPlanConsent({agent})`.
2. **Transcript.** For each owner message and its answer, set `relayTurn` to `workRelayTurnChrome({operation, receipt, fallback, queued, sentAt, now, limit,
   onBoundMac})`. Set `$workRelayStop` to the bridge's stop.
3. **Fallback reason over the wire.** The agent-turns/1.7 `subscription_fallback` parser accepts `offline | refused | rate_limited | timeout |
   grant_invalid | unattended`. For RT5's "consent off" and "switch off" reasons, the cloud needs to send `consent_off` and `switch_off`. That is a
   contract amendment to agent-turns. `workRelayFallbackReason` already maps them, along with the gate's `plan_consent_off` and `plan_switch_off`.
4. **Work page.** `relayChats` = the assistants with a relay binding on this Mac. **Settings:** `planLimit` = `status.limits` for `codex`.
   `relayChats` turns on the consent sheet's chats sentence. Set it only when the relay is on.

## Known gaps and decisions

- The O14 line is drawn by Atum above the Work view, not inside the T3 thread, because the plan forbids a T3 fork patch. If the gate titles
  the relay thread (for example, "Rin · chat"), the line and the title together identify it. That title belongs to G1.
- The relay selection has no thinking level (1.3 `selection` carries none), so plan rows show no effort column.
- If the owner picks an Atum model while a relay selection is current, the platform clears the relay choice ("ordinary picker writes clear relay choice").
  Until the next view arrives, the Atum row is not checked.
- Claude and Antigravity are typed and given names, but `WORK_RELAY_ENABLED_PLANS` is `['codex']` (R2). A plan switcher in the consent sheet
  arrives with R2.
- The R1s scheduled-run count on the usage line is not built (R1s).
- Copy exists in English and Vietnamese only.

## Verification (2026-11-22)

- `npx vitest run src/app/work src/matrix/model-picker.test.tsx src/matrix/model-picker-sections.test.ts src/matrix/model-picker-popover.test.tsx
  src/matrix/settings-revamp.test.tsx src/matrix/subscription-view.test.ts src/matrix/playground electron/work/surface
  electron/work/gate/platform.test.ts src/matrix/app.test.tsx`: 16 files, 762 tests passed. New: `relay-view.test.ts` (32),
  `relay-chrome.test.tsx` (15), and the picker block "relay R1" (6).
- `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.electron.json`: clean.
- ESLint on the touched files: 0 errors. Warning counts are no higher than on `origin/main`.
- Screenshots: 29 PNGs in light, dark and Vietnamese, covering every chat state, the picker's selectable and greyed states (connect, allow,
  google), the chip (limit, fallback), the Work line, Settings usage and the consent sheet. They are saved in the worktree under
  `docs/evidence/relay-u1/` (gitignored, outside the public boundary) and were captured from the local playground with system Chrome.
- Public guard: run by the lane on the commit; the return code is in its handoff message.
