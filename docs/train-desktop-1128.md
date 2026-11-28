# November 28 desktop integration train

## Merge record

- #163 merged cleanly.
- #164 merged cleanly.
- #165: `work-screen.tsx` keeps the active-only header and mounted guest from Work parity, and removes the duplicate New menu as requested.
- #168 merged cleanly.
- #169: `agent-controls.tsx` uses the card's shared schedule read and includes the host-wide pause flag in both the notice and switch.
- #170 merged cleanly.
- #171 merged cleanly.
- #172: Combined pre-selection publication with account-machine and effort handling in `relay.ts` and `main-work.ts`. Kept guest mounting and the plan status revision in `matrix-work.ts`, and retained machine, model and effort data in `model-picker.tsx`.
- #173 merged cleanly.
- #174 merged cleanly.
- #175: Kept live native label caching and added separate local setup RPCs in `main-work.ts`. Combined design-helper PATH discovery with the local free-plan shim in `process.ts`, and kept both effort and setup types in `surface.ts`.
- #176 merged cleanly.
- #177 merged cleanly.
