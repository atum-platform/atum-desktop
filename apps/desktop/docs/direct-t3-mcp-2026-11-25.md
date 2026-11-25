# Direct T3 MCP desktop handoff

2026-11-25. Owner request: “get Sol workers on the shave down plan right now.”
Desktop C1 is built locally. Activation depends on the coordinated Shell and
Hermes changes and a desktop release.

- **F2, credential custody.** Main records the native T3 session ID, Connect URL and
  expiry in the existing per-account Keychain-backed, mode-0600 Work store.
  A live publication survives app and Work restarts, including a changed loopback
  port. Rotation starts inside the seven-day expiry window or when the Connect
  URL changes. A pending bearer stays encrypted until Shell acknowledges it, so
  a lost reply retries the same token. Main revokes the old native session after
  replacement and uses T3’s session list to recover relay sessions left by an
  interrupted mint. Only the exact relay client label is swept.
- **F2 and F9, withdrawal.** Sign-out, an account switch, a Connect withdrawal and
  a revoke delivered to this Mac use `t3 auth session revoke` against its Work
  home. Local revocation runs even if the Matrix scope or platform bearer has
  ended. A device revoke relies on SQL to remove the Shell row. A failed native
  revoke keeps a retirement record for retry. The Mac that issued the credential
  performs native revocation when it receives the device revocation.
- **F4, shared mint.** Gate and Connect publication share the gate’s existing
  dynamic registration, pairing approval and PKCE exchange. Registration uses
  the published Connect URL. An authenticated loopback token response contains
  T3’s signed session claim `sid`, which identifies its own mint without a
  global session-list diff. Connect reads use the existing owner partition and
  the temporary setup-bearer issuance has been removed.
- **Automatic linking.** For an unlinked Work home, main uses the native Connect
  challenge, Work’s link proof, relay link and local relay-config endpoints.
  Only the relay receives the Atum assertion. Work receives its existing owner
  cookie on loopback. The managed link defaults to notifications and Live
  Activities off, following the local Connect acceptance fixture. A linked
  tunnel can come up asynchronously. An explicit native link-revoked state
  withdraws the MCP credential and preserves that revocation.
- The old native OAuth consent, agent connector routes, and renewal UI were
  removed. The loopback Ask connector remains. D9 route events and agent grants
  also serve the retained atum-work model provider, whose `work_runtime.py`
  calls `GateClient.relay_call` through the signed desktop gate using staged
  Work enrollments. Removing that machinery would break subscription-backed
  responses, including scheduled ones. Subscription consent, facts, selection,
  and settlement remain on that path.

Focused local Vitest passed 87 tests in nine files and covers the native request sequence and auth boundaries,
concurrent OAuth mints, relaunch and interrupted publication, credential
rotation, orphan cleanup and native withdrawal with an unusable Shell call.
Electron TypeScript checking and `git diff --check` ran locally. The coordinator
owns the full pre-push and installed/cloud acceptance. No real Connect or
Cloudflare requests were made in this implementation session.
