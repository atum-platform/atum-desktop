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
  tunnel can come up asynchronously.
- **Unlink and retry.** Main records a desktop-created link in the per-account
  encrypted Work store before applying its local config. An unlink then
  withdraws the Shell credential and revokes the native T3 session without
  recreating the link. Turning Work back on from Settings allows a fresh
  automatic link. Native Connect still controls its explicit revocation state.
  Relay attempts back off from two minutes up to 30 minutes while native link
  state is still checked on the usual cadence. If local config application has
  an ambiguous result, the record is retained so an applied link followed by an
  owner unlink cannot be mistaken for a failed first attempt.
- **Withdrawal diagnostics.** Shell clear and native revoke each report a
  fixed failure code. When either fails, the publication is retained for retry.
  Device revocation notifications are accepted only for the Mac's local
  enrollment, whose ID remains available after it is marked revoked.
- The old native OAuth consent, agent connector routes and renewal UI were
  removed. The loopback Ask connector remains. The app branch's Mode B provider
  calls the staged native T3 MCP endpoint directly, and removes
  `work_runtime.py` and `work_relay.py`. Mode B does not consume the desktop
  gate, D9 route events or agent grants. The desktop gate still serves
  settlement and subscription facts. Gate removal is a separate decision.

Local verification passed 81 focused tests covering fixture-driven Connect,
native auth and Shell calls, including unlink across restart, explicit opt-in,
relay backoff, withdrawal failures and device-scoped revoke. Electron type
checking, the client boundary check and lint for errors in changed files also
passed. Installed-app and cloud acceptance remain with the coordinator.
