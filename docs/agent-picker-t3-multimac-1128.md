# Agent model picker: Work's picker, machine icons, thinking level (2026-11-28)

The owner asked on 2026-11-28 for two things. Each Mac plan model should show which of the owner's Macs can run it, with the icon greyed when that Mac is off. The agent model picker should also match the Work picker, including the thinking level. The owner approved the multi-Mac approach on 2026-11-26: one row per model, one machine icon per Mac, offline Macs dimmed. The standing rule is one model picker everywhere.

## What the owner sees

- **Composer chip and agent card Model row.** These are the same `MatrixModelPicker`: the card passes a `trigger`. When the current model's level differs from its default, the name is followed by the level, as T3's trigger shows it. Example: `GPT-6.1 Sol · Thorough`. The card row reads the same text from the picker.
- **Mac plan rows (relay).** After the model name, each row shows one icon per Mac that reports the plan: a laptop for a MacBook, a mini for a Mac mini, a studio for a Mac Studio or Mac Pro, and T3's desktop icon for anything else. A Mac that is on shows in muted ink. A Mac that is off is dimmed to 40%. The row's accessible label and tooltip say the same in words, for example "MacBook Air is on · Mac mini is off". A Mac that lists models only marks the rows for those models.
- **Every Mac off.** The row is greyed with one line, "Your Macs are off". This is the existing rule for unavailable subscription rows. If at least one Mac is on, the row can still be chosen.
- **Plan only on another Mac.** If this Mac lacks a plan that another online Mac serves, that Mac's models are still offered. The platform already checks a pick against every Mac's facts in 0540 `work_selection_set`.
- **Thinking column for Mac plan models.** This is the existing T3-derived `ModelPickerEffortColumn`. It shows only once the platform advertises levels for plan selections (see the platform change below). Until then, plan rows show no column, so the picker never shows a control that does nothing. Atum, OpenCode Go, ChatGPT 1.4, connected-model and home models keep their columns as before.

Renders, made from the dev fixture `picker-relay-fixture.html?relay=picker-macs` with `scripts/agent-picker-macs-shots.mjs`:

- [light](agent-picker-t3-multimac-1128/agent-picker-macs-light.png)
- [dark](agent-picker-t3-multimac-1128/agent-picker-macs-dark.png)

## What was reused (native first)

- **The picker itself.** It was already the shared T3-layout card in `src/matrix/model-picker-*`: rail, search, favourites, ⌘1-9 and the thinking column. The column is adapted from T3's `ComposerModelEffort.tsx`, and that attribution was already in place. Nothing was redrawn.
- **Machine icons.** `src/matrix/machine-icon.tsx` is adapted from T3's `apps/web/src/components/EnvironmentMachineIcon.tsx` (pingdotgg/t3code `9c4ab6d4`, the same file in Work `feat/work-runtime-0.1.16`). It keeps T3's own Mac mini and Mac Studio SVGs and lucide's Laptop and Monitor. The dimming follows T3 `settings/EnvironmentRow.tsx`, which dims only the identity. The MIT notice is in `third-party/licenses/app/t3code-LICENSE.txt`. The port follows the picker's own precedent, the effort column, rather than `vendor/t3-updates`, whose manifest is scoped to the updater subsystem.
- **Mac facts.** These come from the account's existing `work_subscription_read`, one read per plan, with the device service id, owner-visible name, status, `observedAt` and per-Mac models. The facts are joined in `electron/work/surface/relay.ts` inside `readAgentPlans`. This is the seam named by atum-app `docs/plans/2026-11-26-multi-mac-relay.md`. No new backend was added. A Mac counts as online when its fact is `connected` and was reported within 90 minutes. A running Work re-sends the fact at least hourly (`plan-facts.ts` REFRESH_MS, checked every 60 s). When the owner allowed the plan on named Macs, only those Macs are shown.
- **T3 load balancing.** `packages/client-runtime/load-balancing.ts` is not needed for display. Picking an awake Mac for a new turn and pinning follow-ups to it is cloud-side: atum-app `work_provider.py`, option A of the research note. That is not part of this change.

## Platform change still needed (thinking level for Mac plans)

`work_selection` is strictly `{provider, plan, model}` today: platform `0540_work_relay_plans.sql`, the shape check and `device_service_work_selection_set`. The desktop now reads and writes an optional `effort`, but it sends `effort` only after the platform advertises levels. Exact change:

1. **Migration.** In the `work_selection_shape` check and in `device_service_work_selection_set`, allow an optional `effort` key in `('low','medium','high')`. Keep the existing keys required.
2. **`work_selection_read` (`apps/shell/src/lib/work-route.ts`).**
   - Return `selection.effort` when it is set.
   - Return a top-level `efforts: ['low','medium','high']`.
   - The desktop shows the column only when this field is present and lists at least two levels.
3. **Sync page.** Carry `selection.effort` to the hosts.
4. **atum-app `packages/cloud-controller/hermes-plugin/work_provider.py`.** Pass the level to the T3 launch as the model's reasoning option.

**Order: ship the desktop first.** Shipped desktops before this change parse the selection reply strictly and would reject the new fields. The platform should start returning them only once this desktop is the supported floor.

## Known limits

- Online state comes from fact freshness, not T3 Connect health. A Mac that went to sleep can read as on for up to about 90 minutes. The next step is to join T3's per-environment Connect health by environment id, as the research note describes.
- `published` is still this Mac's own Work publication. If this Mac has Work off, plan rows are greyed even when another Mac is on.
- The full dev playground (`matrix-playground.html`) crashes in a plain browser on main. Since #149, the renderer imports `shared/browser/update-restore.ts`, which imports `policy.ts`, which uses `node:net`. The picker fixture page avoids that import path. The playground crash itself is not fixed here.

## Verification

See the check table in the hand-off. In short: typecheck, eslint on touched files, focused vitest, and the public guard.
