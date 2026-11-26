# Work relay tool origins · 2026-11-26

The desktop passes the approved relay tool origin to Work at startup through
`T3CODE_THREAD_MCP_ORIGIN`. The initial list contains
`https://modeb-ta.atumplatform.com`. Entries must be canonical HTTPS origins
on subdomains of `atumplatform.com` using the default HTTPS port. The launcher
drops invalid entries and omits the variable when the list is empty. The value
comes from desktop configuration and is passed only to the Work server.

The existing account and agent contracts have no public tool origin.
`apps/desktop/electron/matrix/domain.ts:38` projects `/me` to identity fields
and a beta flag. Work receives the verified principal through
`apps/desktop/electron/matrix/main.ts:20595`. The agent definition's cloud
placement is a status
(`apps/desktop/electron/matrix/agent-definition.ts:630`), and the signed
agent-home snapshot describes the cloud or Mac location
(`apps/desktop/electron/matrix/agent-home-placement/contract-v25.ts:159`).
The follow-up is an authenticated platform-served list of public tool origins
so desktop can discover additional agent hosts.

Relay attachments require a Work runtime that reads the variable. The current
0.1.18 pin predates that support. This change prepares the desktop launcher
for the updated runtime.

The focused process tests passed 15 tests. The startup fixture exercised the
real supervisor's configuration handoff and verified the variable in the
Work environment. The packaged runtime test requires staged resources.
