# Agent plan picker and direct T3 publication

November 25, 2026. The owner reported that agents were still missing subscription relays. The picker showed a model-loading error for every ChatGPT plan model. The change is ready for release verification after local checks. Installed desktop and agent acceptance are separate release steps.

Both the agent composer and the assistant card now ask main for the direct T3 publication status and native Work provider catalog. The publication must be acknowledged, unexpired and scoped to this device. The same local `server.getConfig` read and built-in model projection used for native Work plan capabilities supply the picker. An account- and device-scoped cache retains the last native provider observations when Work cannot answer. Explicit provider disconnects replace those observations. The renderer receives publication status, plan model names and the agent's selection revision.

The existing `work_selection_set` operation still carries the principal, expected revision, provider, plan and model. The picker reads its existing selection from the local synced ledger and uses the write response while sync catches up. The direct path relies on the owner's published T3 authorization. It does not perform the old room consent preflight.

Removed the renderer's room polling hook, legacy room read and stop IPC, and transcript state derived from that room read. Agent-turn presentation still supplies fallback notices and the agent Stop control interrupts the native turn.

Focused coverage exercises both picker entry points, unavailable publication and provider states, persistence of native model names through an offline read, and the existing selection payload and revision. Verification uses shared dependencies with no installation.
