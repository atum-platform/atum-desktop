# C5/A4 compatibility correction — local implementation

Reuse inventory: `WorkConsentRecordSchema`, consent projection/relay, the existing
Connect store, `NativeMacSsh` and `DeviceRegistryError` already own these seams.
No dependency, core tool, service or UI flow added. Branch is based on origin/main
and merges origin/sec/a4-device-targeting-1124 (84ba92230c).

S1: reader accepts `agents: "all"`; display projects it to eligible UUIDs and
marks the all-owner scope. Automatic relay sync and Connect leave an all-owner
grant intact rather than silently replacing it with a finite UUID list.
Sender input remains UUID-list-only; later sender TODO and rollout prerequisites
are in `docs/c5-client-compatibility-backlog.md`. This is built, not released.

S3: device/epoch-targeted authorized-key requests retry the legacy device-less
request only after a typed HTTP 400. Authentication, denial, server and network
failures do not downgrade. Shell's new endpoint remains strict. Regression tests
exercise both requests over the actual requestS1 HTTP adapter and verify no
fallback for 401, 403 or 500.

Local checks:
- Focused vitest: native-ssh, work gate/platform, surface relay/surface, and
  Connections store: exit 0, 185 tests across five files.
- Full desktop lint: exit 0, zero errors, 4036 existing style warnings.
- Client boundary check: exit 0.
- Desktop typecheck: renderer, consumer-browser, Electron and E2E TypeScript
  projects each exit 0 (Node 22, direct installed compiler). The Electron
  compiler infers the Zod union's property as optional; the relay view makes
  the already parsed required key explicit without weakening the shared type.
- Final focused lint after that type correction: exit 0, no errors.
- Public guard must run against the committed head, unpiped; final exit and
  typecheck evidence are retained in the handoff below.

Committed-head public guard: `python3 scripts/public_guard.py --base origin/main
--head HEAD` at 1093d163: exit 0, PASS (three new commits), no leaks. Ran
unpiped. Source checks completed before deleting task-owned node_modules,
Next output and TypeScript build metadata with Python shutil.rmtree/unlink.

Environment repair: npm ci fails because existing lockfile lacks undici@6.29.0.
Installed with `npm install --ignore-scripts --package-lock=false --legacy-peer-deps
--workspace apps/desktop --include-workspace-root --no-audit --no-fund`; no lock
or manifest edits retained. npm misplaced minimatch@3's brace-expansion override;
local node_modules placement repaired to the already configured 1.1.21 for lint.
No product source/dependency change was made for either installation problem.

Rollout: reader-capable desktop release before applying 0547 (migration reads
return all); host bridge first, then 0547, then 0548 + Shell, then the targeted
desktop. S2's optional timestamp reader does not remove the old bridge's strict
shape incompatibility. Nothing pushed, no CI/PR/deploy/cloud activity or spend.

## Post-merge client compilation repair — 2026-11-25

The all-owner early return in `grantAccountPlanUse` omitted its boolean result.
Private-absent renderer compilation reproduced TS2322 (exit 1). It also caused
Allow and Renew to report failure after successfully enabling this Mac. Return
`true` after `setPlan(true)` resolves, preserving the all-owner grant without
rewriting consent. Switch failures still return `false`; no types were loosened.
The existing consent reader and A4 HTTP-400 fallback remain unchanged.

Regression tests first failed (exit 1, three failures): missing success result
and false failure for Allow/Renew. With the repair, the focused Connections,
native-SSH, gate/platform, relay and surface suites pass (exit 0, 188 tests in
five files), including all-owner reading/preservation and HTTP fallback rules.

Private-absent renderer compilation passes (exit 0, 8319 source files and zero
private sources). Full desktop lint passes (exit 0, zero errors, 4070 warnings).
`npm run typecheck --workspace apps/desktop` passes (exit 0): client boundary,
renderer, consumer-browser, Electron and E2E projects. `git diff --check` passes
(exit 0). The public guard passed unpiped against the pre-repair branch head
(exit 0); the worker also runs it against the committed repair before handoff.
Verification reuses temporary shared root/desktop dependency symlinks; no install
or dependency change. Local runtime is Node 23.10.0 and Vitest 4.1.12; hosted CI
uses Node 24. The coordinator owns pushing and exact-head CI verification.
