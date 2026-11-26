# Work provider defaults

Work now seeds the native T3 OpenCode instance alongside Codex, Claude and
Antigravity when the corresponding instance ID is missing from the account's
settings. Saved instance IDs, provider configuration, visibility and enabled
flags survive restart. The exact legacy blocked Codex and Claude stubs and the
bare managed Codex config still migrate. The Atum brokers are rebuilt at
startup, and the hidden relay still gets its own Codex settings and MCP
overrides. If a different driver occupies the owner-facing Codex ID, the relay
uses the Codex default, which was the previous fallback.

T3 owns CLI discovery, auth and model inventory. A loopback-only smoke with
temporary homes used the available Work 0.1.16 candidate binary and local
OpenCode 2.3.2. The native snapshot became ready with 12 models. The
supervisor's sampled peaks across installed-OpenCode runs were 8 owned processes
and 1,397,616 KiB combined RSS, within its 128-process and 4 GiB limits.
The limits stay at their current values. The smoke used a candidate binary
with a different digest from the desktop manifest's pinned runtime.

An isolated missing-binary fixture returned an enabled OpenCode snapshot with
`installed: false` and the native missing-CLI message after refresh. The
native picker can show it as unavailable. Its dedicated setup action requires
a native install or auth capability, and both flags are false for OpenCode.
The setup action needs a native Work change in a later slice.

The restart fixture covers default seeding, custom instances, explicit disables
and reserved entries. Desktop typecheck, focused desktop and Python tests, and
lint passed.

The hidden provider entries remain wired to the older `work_handoff` tool.
The [gate retirement audit](work-gate-retirement-1126.md) traces that dependency
and the account and consent behavior to preserve when retiring it.
