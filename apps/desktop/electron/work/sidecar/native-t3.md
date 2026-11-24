Native relay authentication (2026-11-25)

The main process calls the native connector through `account.s1Request`, using
the configured domain resource origin and the MAS domain access token, just
like host Stop and Desk. No browser cookie is required. Both native connector
and assertion requests explicitly omit cookies and reject redirects.

The connector helper throws `matrix_s1_authentication` on HTTP 401 so the
existing account code refreshes once and preserves the account-generation
fence. Other failures remain unavailable. Previously the connector collapsed
401 into unavailable and skipped that refresh.

Verification: the connector and assertion helper suites pass 6 tests (exit 0).
Focused ESLint for the five changed TypeScript files passes (exit 0).
The public outbound guard passed against main (exit 0, full history, unpiped).
Platform middleware admission and issuer composition are separate server-side
changes. Live acceptance, rollout, and the outbound guard remain coordinator
gates; no push or deployment is performed by this implementation worker.
