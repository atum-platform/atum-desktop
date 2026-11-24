# Automatic agent plan picker — 2026-11-24

Owner request: “agent model picker - work seems connected to sub models now, but agent still has them grayed out? Should be automatic right, Work connected and machine available --> sub models available for agents? And what’s the A on the provider list there?”

State: built, not live. Coordinator owns assembly, review and release; no push, PR, CI, deployment, real-account access or paid invocation performed by this worker.

## Native inventory and cause

- `src/matrix/assistant-card/model-destinations-row.tsx` supplies a synthetic encrypted room and no relay view. Only the composer wired the existing native room read. The picker now uses `useWorkRelayRoom` when no preloaded relay was supplied, without replacing the active conversation’s Stop handler. Synthetic card preferences do not inherit conversation encryption restrictions.
- `electron/work/surface/relay.ts` previously rejected the whole read when a cloud agent was not entitled in this Mac’s ledger, losing account facts already read successfully. It now returns those facts with no local status. Selection still uses the owner-authoritative platform endpoint.
- `model-picker.tsx` treated a supported plan waiting for a view as Work-only, and the existence of any relay view suppressed all supported fallback plans. Loading copy and per-plan matching fix those cases.
- Claude relay rows used `anthropic` while account rail rows used `claude-plan`; the shared mapping now uses `claude-plan` throughout.
- The A was a missing provider mark. Antigravity now uses the bundled PNG extracted from the existing MIT T3 Code icon. Full copyright/permission notice is beside the asset.

## Consent and remaining platform work

Existing `grantAccountPlanUse` already runs for all three plans. Its list was a one-time snapshot. Native relay reads now extend an active grant to newly synced entitled owner agents, preserving device scopes, scheduling policy, revocation and the Mac switch. No new config or permission layer.

The current strict protocol accepts only up to 256 named agent UUIDs; literal all is rejected by both IPC and protocol. C5 needs a server-owned account-wide consent value, expanded and owner-scoped during admission/sync, to guarantee current/future agents before any Mac learns them. This desktop bridge cannot deliver that guarantee alone. Previously revoked grants are intentionally not revived. If an agent is absent from the local ledger, account rows can be selected, but an existing unsynced selection revision may conflict and needs sync/retry; no live-account proof was authorized.

## Verification

Local focused UI behavior tests cover pending relay copy, automatic card relay selection of Claude with a stale Mac fact, existing offline selection, and proper Antigravity mark. Owner relay adapter tests cover absent local agents and extension of Claude/Antigravity grants without reviving revoked Codex consent. UI suite: 164 tests across five files, exit 0. Electron relay adapter: four tests, exit 0. Full desktop `npm run typecheck`, exit 0. Full desktop `npm run lint`, exit 0 (4,031 existing warnings); changed-file ESLint, exit 0 (two existing warnings). `git diff --check`, exit 0. Initial verification found the missing shared dependency and the retired-copy assertion; both were corrected before the passing runs.

Shared dependencies are linked temporarily; missing pinned `@assistant-ui/react-streamdown@0.3.4` was unpacked into this checkout only for verification. Temporary dependencies are removed after checks. No dependency manifests changed.
