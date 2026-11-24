# 0.20.55 review remediation — 2026-11-24

State: implemented and checked locally; not pushed, released, or installed.
Scope: the nine retained release review findings. Coordinator owns review and shipping.

## Changes and behavior tests

1. Roster unknown, loading or unavailable can hold launch only for the existing
   20-second assistant timeout. Human chats then open; existing roster authority
   checks continue suppressing local setup/not-ready notices. Tests:
   startup-screen “opens the shell after the bounded roster wait”; app “opens the
   shell after the roster timeout with setup notices suppressed” (undefined and
   unavailable).
2. The delegated gateway and delegated ACP connector override HOME, XDG roots,
   CODEX_HOME and CLAUDE_CONFIG_DIR with their account profile. Owner gateway,
   T3 and owner-started providers retain the real HOME. Tests: process “isolates
   delegated gateway and connector HOME while owner providers inherit the real
   HOME”; process-settings native supervisor fixture observes both gateway HOME
   values and the connector override.
3. The native T3 Codex adapter preserves user MCPs; runtime approval mode alone
   does not establish universal MCP approval. Relay selection now uses hidden
   atum-relay-codex; owner selection remains codex. At startup the supervisor
   derives this instance from owner settings and adds Codex's native --config
   mcp_servers={name={enabled=false},...} override for every configured server,
   including named profile entries and quoted/dotted names. An empty table
   alone would merge, so named disable entries are necessary. Unreadable or
   unenumerable custom MCP launch overrides and shadow homes disable this relay
   instance, leaving owner Work available. Tests: supervisor “disables every
   user MCP in the relay Codex instance while preserving owner settings” and
   t3-client-plan “admits the hidden relay Codex instance by its native driver
   without selecting the owner instance”.
   Existing equivalent: T3 CodexTextGeneration native MCP disable table;
   CodexAdapterV2 per-thread config preserves T3's scoped MCP registration.
   Settings/config changes take effect on the next Work supervisor start.
4. The server and gateways still spawn concurrently. Background native gateway
   discovery checks profile and child PID before writing a fresh startup marker
   containing the current T3 server PID. Admission verifies that PID.
   Delegated providerReady requires that marker plus T3's advertised connector.
   Tests: sessions-client “knows the provider is ready only when the delegated
   instance advertises its model” covers the gateway-not-yet-ready interval;
   supervisor “starts the native server without waiting on either gateway” and
   “publishes gateway readiness only after discovery and clears an old server
   marker”.
5. Login-shell PATH caching retains only successful captures. Concurrent callers
   still share one capture; timeout fallback retries on the next start. Test:
   “retries after timed-out captures and caches the next successful capture”.
6. Hub requirement is tri-state. Unknown roster authority preserves current
   connection state; explicit false stops S2-only hub transport. Test:
   cloud-agent “keeps the legacy hub link while the roster is stale”.
7. Room nudges resolve the target assistant from that room, with the existing
   personal-room membership/type validation, before selecting a conversation.
   Legacy snapshots retain the singular assistant fallback. Test: room-agent
   “routes a room nudge to its assistant after Main is reassigned”.
8. Automatic landing accepts the roster's cloud primary without requiring local
   assistant custody. Test: app “lands automatically on the roster cloud primary
   without a local assistant”.
9. Explicit update and sign-out restart await an in-flight background session
   start before stopping/resetting/replacing it. Tests: session “joins background
   startup before a sign-out restart stops and resets the server” and “awaits
   background startup before an explicit update preflights and replaces the pin”.

## Owner decision retained

Owner-started provider sessions continue using the real HOME. Native Codex
sessions and Claude projects/transcripts remain shared between Atum accounts
using the same macOS login. Account-separated provider transcript storage is
explicitly deferred to the owner. HOME overrides select configuration roots;
they are not an OS filesystem sandbox.

## Local verification

- Work/device/main-work focused suite: 111 files passed, 5 skipped; 2,420 tests
  passed, 20 skipped; exit 0. Subsequent targeted provider tests: 18 passed;
  native settings fixture: 1 passed. Final gateway/mount focused run: 68 passed;
  final supervisor run including marker regression: 7 passed; all exit 0.
- New renderer launch/landing cases: 3 passed; exit 0.
- Electron and renderer TypeScript no-emit checks: exit 0.
- Repository ESLint: exit 0; warnings remain, no errors.
- Full startup-screen/room-agent/app renderer suite: 507 passed, 2 failed;
  exit 1. Both failures below reproduce on the unchanged release app.tsx.
- Public guard against origin/main at the incoming release head: exit 0. The
  same guard is run again against the remediation commit before handoff.
- Two app tests reproduce failures with unchanged app.tsx from beebac94:
  “does not silently choose the former default when Main has no available
  default room/runtime” and “offers the attach entry, stages one file, and
  sends it in a cloud assistant's chat”. Baseline focused commands exit 1.
  These are not claimed fixed by this patch.

No dependencies installed. Dependency links are removed before commit.
Checkout footprint is about 360 MB. No push, PR/CI action, deploy, cloud resource,
spending, nested agent, credential sign-in or installed-app modification.
