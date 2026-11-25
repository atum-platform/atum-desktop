# Connect identity boundary

The owner-view preload exposes `getConnectAssertion()`. Main accepts the request only from the
bound Work incarnation's top frame, checks the account before and after the request, and returns
only the assertion string. The Matrix composition calls `/api/work/connect/assertion` through
`account.s1Request`, including its existing MAS refresh and account-generation fence. Bearers
remain in main. Assertions are never cached by the host.

Local verification (2026-11-24): the focused host, assertion adapter and Matrix Work composition
suite passed 34 tests (exit 0). Desktop typecheck, including renderer/consumer/electron/E2E
projects and the client boundary check, passed (exit 0). Focused ESLint passed (exit 0).

From `apps/desktop`, reproduce with a supported Node version:

```sh
npx vitest run --project electron electron/work/sidecar/host.test.ts electron/work/sidecar/connect-assertion.test.ts electron/matrix/main-work.test.ts
npm run typecheck
```

The companion Work repository's `infra/relay/scripts/prove-local.sh` exercises the real relay
HTTP handlers and a packaged Work server with generated test keys, fake desktop assertion bridge,
wrong-owner/expiry refusals and native MCP OAuth. Source wiring is built and locally verified;
installed production acceptance remains with the coordinator. No production call, push, CI or
deployment is part of this change.
