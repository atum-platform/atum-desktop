# November 28 desktop integration train

## Merge record

- #163 merged cleanly.
- #164 merged cleanly.
- #165. `work-screen.tsx` keeps the active-only header and mounted guest from Work parity, and removes the duplicate New menu as requested.
- #168 merged cleanly.
- #169. `agent-controls.tsx` uses the card's shared schedule read and includes the host-wide pause flag in both the notice and switch.
- #170 merged cleanly.
- #171 merged cleanly.
- #172. Combined pre-selection publication with account-machine and effort handling in `relay.ts` and `main-work.ts`. Kept guest mounting and the plan status revision in `matrix-work.ts`, and retained machine, model and effort data in `model-picker.tsx`.
- #173 merged cleanly.
- #174 merged cleanly.
- #175. Kept live native label caching and added separate local setup RPCs in `main-work.ts`. Combined design-helper PATH discovery with the local free-plan shim in `process.ts`, and kept both effort and setup types in `surface.ts`.
- #176 merged cleanly.
- #177 merged cleanly.
- Work 0.12.2 pin merged cleanly.
- #178 merged cleanly.

## Focused test files by merge

| Input | Test files |
| --- | --- |
| #163 | `electron/matrix/main-work.test.ts`, `electron/work/surface/electron-view.test.ts`, `electron/work/surface/place-view.test.ts`, `electron/work/surface/surface.test.ts`, `src/app/atum/shell-frame.test.tsx`, `src/app/work/work-screen.test.tsx`, `src/components/overlay-inventory.test.ts` |
| #164 | `electron/work/surface/relay.test.ts`, `src/matrix/assistant-card/model-destinations-row.test.tsx`, `src/matrix/model-picker-shelf.test.tsx`, `src/matrix/model-picker.test.tsx` |
| #165 | `src/app/work/work-screen.test.tsx` |
| #168 | `electron/matrix/agent-routines.test.ts`, `src/matrix/agent-desk.test.tsx`, `src/matrix/assistant-card/agent-controls.test.tsx`, `src/matrix/assistant-card/assistant-card.test.tsx`, `src/matrix/assistant-card/routines-panel.test.tsx` |
| #169 | `shared/matrix-assistant-about.test.ts`, `src/matrix/app.test.tsx`, `src/matrix/assistant-card/agent-controls.test.tsx`, `src/matrix/assistant-card/assistant-card.test.tsx`, `src/matrix/assistant-card/background-sweep-row.test.tsx` |
| #170 | `electron/matrix/local-turn.test.ts`, `src/matrix/cloud-stop.test.ts`, `src/matrix/use-cloud-stop.test.tsx` |
| #171 | `electron/work/sidecar/process-settings.test.ts` |
| #172 | `electron/work/sidecar/shell-environment.test.ts`, `electron/work/sidecar/t3-mcp.test.ts`, `electron/work/surface/account-connections.test.ts`, `electron/work/surface/model-default.test.ts`, `electron/work/surface/plan-capabilities.test.ts`, `electron/work/surface/plan-facts.test.ts`, `electron/work/surface/provider-config.test.ts`, `src/app/connections/view.test.ts` |
| #173 | `electron/work/connector/learning.test.ts` |
| #174 | `electron/matrix/work-design-formats.test.ts`, `scripts/verify-work-runtime-signatures.test.mjs` |
| #175 | `electron/work/sidecar/process-settings.test.ts`, `electron/work/surface/local-plans.test.ts`, `electron/work/surface/surface.test.ts`, `src/app/connections/local-plan-rows.test.tsx` |
| #176 | `electron/matrix/openrouter-free-oauth.test.ts`, `src/matrix/google-connection-settings.test.tsx`, `src/matrix/model-picker.test.tsx`, `src/matrix/settings-revamp.test.tsx` |
| #177 | `electron/backend-ready.test.ts`, `scripts/renderer-brand.test.mjs`, `src/components/boot-failure-reauth.test.ts`, `src/components/onboarding/index.test.tsx`, `src/i18n/brand-copy.test.ts`, `src/matrix-pages/providers.test.tsx` |
| Work 0.12.2 pin | Pin-only change. Covered by the canonical build and public guard. |
| #178 | `electron/matrix/pets.test.ts` |

## Integration checks

- The learning receipt and design deliverable changes both survive the automatic merge in the deliverable host.
- The picker keeps live plan refreshes, local free-plan setup, and Atum Free under its separate account path.
- The routines panel uses the existing agent model for runtime identification. This keeps the wire value internal and leaves the renderer brand gate intact.
- The Resume fixture supplies the current host schedule after the write, including the global pause state.
- The held first-run heads are absent from the train ancestry.
- Verify the combined head with desktop typecheck, lint, the canonical build and renderer brand gate, the focused inventory above, and the public guard against main.

### Client check repair

The brand scrub changed the logged-out billing card to refer to the provider and changed the early runtime-exit label to Atum. The billing state, rendered billing card, and abort tests now expect those messages. They still check that logged-out billing hides account rows and that a terminated runtime reports the signal.

The macOS Work host test also had a stale channel inventory after the learning channel landed. It now verifies that switching runtime pins preserves the original owner handlers, with duplicate registration still rejected by the test IPC implementation.

The Skills archive confirmation test follows the new recovery copy and still exercises cancellation, confirmation, and refresh.

Run the full client suite with `npm exec --workspace apps/desktop -- vitest run --maxWorkers 4` and the public history check with `python3 scripts/public_guard.py --base origin/main --head HEAD`.
