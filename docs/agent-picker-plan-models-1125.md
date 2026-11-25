# Agent picker plan catalog — 2026-11-25

Owner report: “Work on Atum on the macbook seem to work already with subscriptions (without me having to do extra steps to login - picks up my existing auths from the macbook); but on agent chat still showing like this”. The agent's OpenAI models showed an indefinite “Loading models…” suffix.

State: built-not-live. Local implementation checkpoint only; installed app acceptance, coordinator review and release remain open. No push, PR, CI, deployment, paid invocation or account mutation was performed. This fresh clone branches from atum-desktop origin/main d83d6f40, which is newer than the reported installed d8e4838268.

## Existing path and root cause

The existing picker already uses the account Connections registry and Work relay adapter. Native Work models are projected by `electron/work/surface/plan-capabilities.ts:23` from `server.getConfig` (`provider-config.ts:8`); `electron/matrix/main-work.ts:550` reports these through PlanFact, and `main-work.ts:691` uses the same projection for local Connections fallback. There is no new model list, login system or provider catalog in this fix.

The account fallback rows in `src/matrix/model-picker.tsx` used “Loading models…” whenever `pick.kind === 'relay'`, without checking whether any request existed or had failed. `src/app/work/use-relay.ts` swallowed every read failure and had no timeout or settled failure state. This reproduces a perpetual label independently of the installed machine's particular network failure.

`electron/work/surface/relay.ts` also joined all plan reads with Promise.all: a 5xx/network failure for optional Claude or Antigravity discarded successful Codex facts, and Codex failure discarded other available plans. A room gate status rejection discarded the successfully read account catalog too. These are verified local causes; the installed Mac's specific failing response has not been observed in this worker.

## Change

- Track loading, ready, unavailable and failed relay reads. Bound renderer reads to eight seconds; ignore late results and leave retry failures settled instead of flashing loading every poll. Missing bridges and empty replies get quiet unavailable copy. Existing saved plan and Atum fallback presentation remain intact.
- Isolate each plan read, with a four-second deadline. A failing or hung optional plan cannot hide another plan. Keep account facts when a room status read fails. Preserve the old server fallback only for unsupported Codex operations (400/404).
- Both picker entry points retain their existing native selection path. The self-loaded assistant-card path now wires the existing fixing action too. Before a plan selection, read scoped native consent with an eight-second bound. Missing agent/device consent opens the existing Allow sheet; expired native consent opens Renew. Selection does not silently grant consent or reuse local credentials in cloud custody.

## Native/cloud dependency and remaining acceptance

Work itself is a separate native T3 surface; its successful local login does not prove the platform has received a `work_subscription_report`. Cloud availability requires the existing Work gate/device enrollment, report/read/selection operations, and native relay admission. `surface/surface.ts:397` runs `setPlanConsent` plus native approval; `electron/matrix/main-work.ts:712` approves named agents via the connector, and `sidecar/native-t3.ts:2` uses domain authentication with the existing one-refresh behavior. The code retains the native source instead of inventing cloud availability from a local login. This worker does not deploy missing platform operations, stage a newer Work runtime, or verify live plan inference. Work's embedded T3 picker is not replaced by this patch; unifying its component with the desktop React picker would require a separate runtime change.

The existing grant sheet can name only agents learned by Work's ledger. A new cloud agent missing there still depends on agent synchronization/platform account-wide consent support documented in `agent-picker-plans-automatic-1124.md`. No claim is made that a desktop-only fix satisfies that platform dependency.

## Verification

Shared dependency trees were symlinked, with no installs or manifest edits. Seven focused UI/native suites passed 145 tests (exit 0), covering ready, empty, error, timeout, recovery, late results, missing/expired/current consent, independent provider failures and room gate failure. Full desktop `npm run typecheck`: exit 0. Full `npm run lint`: exit 0, 4,095 warnings and no errors. Changed-file ESLint: exit 0. `git diff --check`: exit 0. The unpiped public guard is run against the committed head and its exit code is included in the final handoff. No additional nested worker or review was launched.
