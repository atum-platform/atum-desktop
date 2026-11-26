# Work gate retirement audit

2026-11-26 session log. The owner asked why Work’s Welcome screen still shows
“Atum (delegated)” and “ChatGPT (assistant relay)”. Status is evidence and a
removal plan. Runtime code and saved settings were left in place because the
S2 image still registers a separate tool that uses both instances. The source
audit used atum-desktop `583cd334` (includes #137), atum-app `f7ad45d1be`, and
atum-platform `4bd0fbee1`. R52 and direct delegation availability are from the
rollout brief. The audit used repository source and isolated local tests.

## What calls the gate

- **S2 Mode B.** In atum-app, `packages/cloud-computer/work/plugin/runtime.py:103`
  configures Hermes’s native MCP servers. `packages/cloud-sandbox/host/t3_mcp.py:82`
  supplies the T3 Connect URL and native bearer header.
  `packages/cloud-controller/hermes-plugin/work_provider.py:25` names the native
  driver and default instance IDs `codex`, `claudeAgent`, and `antigravity`.
  Lines 400–413 prefer the matching native instance ID and permit a single
  matching-driver fallback. Lines 455–462 select a configured `work-<8hex>`
  MCP server, and lines 474–497 send, configure, or launch a T3 thread directly.
  Neither hidden provider ID appears in the plugin. The single-driver fallback
  is worth covering in removal tests, since a capability catalogue with only
  the hidden Codex instance could technically satisfy it today.
- **Direct delegation and legacy handoff coexist.** The native toolset exposes
  Work MCP to Matrix and cron through
  `packages/cloud-computer/work/plugin/runtime.py:35` and `:44`. The same S2
  image also installs the separate `atum-work` gateway plugin
  (`packages/cloud-computer/Dockerfile:20`–`:28`). Its owner entrypoint
  runs `configure_work` (`packages/cloud-computer/credential_entrypoint.py:133`),
  which enables the legacy plugin and toolset
  (`packages/cloud-computer/native_work.py:57`–`:62`). The bundled skill still
  tells agents to call `work_handoff` for Mac work
  (`packages/cloud-computer/work/skill/SKILL.md:20`–`:36`).
  `packages/cloud-computer/work/plugin/__init__.py:81`–`:96` queues it for an
  enrolled owner DM, and `:109`–`:113` keeps the tool discoverable while the
  profile has an enrollment. `worker.py:150`–`:174` in that directory
  chooses the eligible Codex plan or sends a launch with no plan. `gate.py:111`
  and `:237`–`:245` route that launch via the Mac’s `/agent/mcp`.
- **Both aliases have a caller on that route.** In the desktop,
  `apps/desktop/electron/work/gate/http.ts:339` passes `launch` to the gate.
  `gate.ts:660`–`:685` defaults to the delegated provider and resolves plan
  launches via the provider table. `gate.ts:760`–`:778` freezes that selection
  in the launch receipt. `mount/gate-factory.ts:96`–`:109` (under
  `apps/desktop/electron/work`) pins `atum-managed-delegated` and the Codex
  plan, and `apps/desktop/shared/matrix-work-relay.ts:15` pins that plan to
  `atum-relay-codex`. The desktop creates the first in
  `sidecar/process.ts:83`–`:85` and `:165`–`:166` and the second in
  `sidecar/supervisor.py:240`–`:276` and `:310`–`:320`.
- **S2 still supplies the legacy transport.** Atum-app’s owner credential
  stager fetches both T3 servers and old enrollments, subscriptions and stop
  settlements (`packages/cloud-sandbox/host/credential_stager.py:335`–`:347`).
  Enrollment is conditional on the Mac route and an available grant
  (`:409`–`:432`), and settlement is required to reconcile a sent task after
  revocation (`packages/cloud-computer/work/plugin/worker.py:280`–`:355`).
  Platform `apps/shell/src/lib/work-route.ts:132`–`:168` handles pull, ack
  and settlement reporting from the Mac. Its `:280`–`:301` and
  `:355`–`:365` serve grants and settlements to the agent. The direct path
  coexists with a reachable legacy handoff wherever its grant is present.
  Actual per-agent enrollment and recent receipt counts are outside this audit.
- **S1 reference image.** At atum-app
  `origin/feat/s1-host-assembly-1113` (`44503b2231`),
  `packages/cloud-computer/Dockerfile:5`–`:16` and
  `packages/cloud-computer/credential_entrypoint.py:20`–`:49` show no Work
  plugin installation or credential staging. Searching that revision’s packages
  for `work_handoff`, `ATUM_WORK_ENROLLMENTS`, `work_sync_pull/ack`, and
  `/agent/mcp` found zero matches. The source tree has a separate device-tool
  path (`packages/cloud-controller/src/device/device-router.ts:50`–`:52`,
  `:154`). The old host’s exact deployed revision and active routes were
  outside scope. The S2 handoff dependency exists independently of Slice 6.
- **Desktop.** The `583cd334` picker reads the native catalogue but recovers
  selection via the gate’s synced `relay_selections`
  (`apps/desktop/electron/work/surface/relay.ts:15`–`:34`,
  `apps/desktop/electron/work/gate/sync.ts:371`). It already writes
  `work_selection_set` (`surface/relay.ts:38`–`:45`). The #139 branch
  (`origin/fix/relay-selection-revision`, `surface/relay.ts:20`–`:62`)
  moves selection reads and conflict recovery to `work_selection_read`. Its
  `:65`–`:66` still supplies Work’s shared-chat names from gate receipts
  (`apps/desktop/src/app/work/work-screen.tsx:153`). Account Connections
  reads `account_connections_read`
  (`apps/desktop/electron/work/surface/account-connections.ts:34`), and
  the gate sync tick currently publishes the native subscription facts that
  feed connection and consent views
  (`apps/desktop/electron/work/gate/sync.ts:242`,
  `apps/desktop/electron/work/gate/plan-fact.ts:133`–`:149`). The desktop’s
  direct T3 publication lives in `apps/desktop/electron/matrix/main-work.ts:543`
  and `apps/desktop/electron/work/sidecar/t3-mcp.ts:251`.

## Removal sequence

1. On the cloud side, verify the native T3 tool route covers the owner requests
   routed to `work_handoff`, including an explicit model/plan, following the
   running task, reporting back, and exact-run Stop. Retire the legacy skill and
   tool registration in the S2 image once those behaviors hold. Finish or settle
   old handoffs while their gate is available. Establish that the remaining S1
   rollout has no gate clients using its deployed revision or confirm Slice 6
   has moved those clients. Fresh and upgraded profiles should expose native T3
   tools with no legacy handoff before removing either provider.
2. Build the desktop removal on #139 after the owner selection read is deployed.
   Detach the gate receipt-derived shared-chat labels and scheduled counts from
   the Work surface as their old data source retires. Keep native fallback
   chrome and the selection contract. Keep the existing account connection and
   owner consent operations. Move subscription fact publication and withdrawal
   off the sync tick, retaining the platform’s device identity and route-epoch
   checks. Preserve the native Mac work switch, publication refresh and clear,
   managed Atum billing and model access, and the owner session’s startup,
   reset, update and teardown behavior.
3. Remove the gate factory, persona/history assembly, Unix HTTP admission,
   delegated session and launch dispatch, relay status and receipt paths, and
   their isolated tests. Keep any shared RPC client, schemas and pairing
   helpers used by the surviving surface. Retire the platform enrollment,
   grants, sync and settlement handlers only after identifying their remaining
   readers and sunsetting old desktop clients. Verify only retired handlers
   and their ingress are deleted.
4. Remove the delegated profile and readiness process from the sidecar and the
   hidden Codex clone. Drop just the two retired IDs in the supervisor’s saved
   provider merge. Keep #137’s OpenCode defaults, explicit disables, custom
   entries and managed Atum. Preserve #136’s ACP command arguments and #138’s
   runtime and UI changes when rebasing. Retain historical Work data and old
   run attribution. Test fresh and upgraded settings, direct launch through
   all three native providers, consent and account connections, plus native
   Work startup and shutdown. Check Welcome and picker output against the
   staged runtime before release.

## Local verification

The desktop dependency helper reused the matching lock. Desktop typecheck
passed. Focused Work Vitest passed 684 tests with nine skips, including the
opt-in packaged runtime tests. A narrower repeat passed 92 tests across
supervisor startup, settings, gate launch, plan admission and settlement
delivery. Those supervisor fixtures execute the actual Python supervisor.
The canonical Python runner passed 50 ACP managed-profile and delegated
containment tests with two expected failures. Focused ESLint passed with
81 existing warnings and zero errors. Git whitespace check passed.
