# Direct T3 MCP desktop handoff

2026-11-25. Owner request: “get Sol workers on the shave down plan right now.”
Desktop C1 is built locally. Activation depends on the coordinated Shell and
Hermes changes and a desktop release.

- On a verified Work ready event, main starts checking the environment link
  immediately and once per minute. A short-lived local T3 CLI session reads
  link state and requests a pairing token. Connect handles OAuth discovery and
  dynamic registration. The loopback Work server approves full access and
  exchanges the PKCE code. The device-services client sends the resulting
  bearer, Connect MCP URL and millisecond expiry to C1.
- Main keeps publication metadata in memory. It remints on app startup, a
  changed Work origin or Connect URL, and with less than seven days remaining.
  Main serializes publication with sign-out and revocation clears. Work and
  Connect requests reject redirects. Credentials stay out of logs and renderer
  state. If the owner's bearer is already unusable, the Shell's device-revoke
  cleanup and credential expiry are the remaining backstops.
- The old native OAuth consent, agent connector routes, and renewal UI were
  removed. The loopback Ask connector remains. D9 route events and agent grants
  also serve the retained atum-work model provider, whose `work_runtime.py`
  calls `GateClient.relay_call` through the signed desktop gate using staged
  Work enrollments. Removing that machinery would break subscription-backed
  responses, including scheduled ones. Subscription consent, facts, selection,
  and settlement remain on that path.

Local fixture coverage exercises discovery, registration, pairing, PKCE,
rotation, replacement and clearing. The baseline dependency helper rejects the
checked-in npm lock because the TUI requests `undici@6.29.0` and the root
override resolves 6.29.1. Verification uses a checkout-local overlay of the
existing cached dependencies. The lock verification remains failed.
