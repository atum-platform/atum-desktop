# Relay session isolation (R2, 2026-11-23)

What main writes for each relay native session, once, when the session's folder is created
(`apps/desktop/electron/work/mount/relay-assembly.ts`):

- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`: the persona, identical, read-only, stamped `Atum persona revision: N`.
  Codex and Antigravity read AGENTS.md, Claude Code CLAUDE.md, Antigravity also GEMINI.md.
- `.claude/settings.json`: Claude Code's project settings (`claudeRelaySettings`): deny-read over the protected roots
  (`relayProtectedRoots`, plan O16), required native sandbox, no project MCP servers, no edits to the files above.
- The folder is per (assistant, native thread). A resume reads the same files; a newer definition revision is written only
  into a new folder when a new native session starts (verified with native Claude Code 2.1.325, see the app repo's
  `docs/operations/relay-isolation-lab/`).

Not claimed: that the `.claude/settings.json` deny rules or sandbox are what stop a read. In the decoy lab the native
CLI refused out-of-folder reads only through its default non-interactive permission layer; with `bypassPermissions` the
same settings denied nothing. Treat them as defence in depth, and the approval ceiling (never `full-access`, never a
bypass mode) as the control.

T3 side (atum-work `88d1cf1e2`): a session that a fenced peer link started has a tool allow-list on its MCP credential
(`send_to_user` only), so it cannot read, list, message or start another thread through T3 MCP.

The relay plan allow-list is still Codex only (`WORK_PLAN_PROVIDERS`, `WORK_PLAN_INSTANCE_IDS`, `WORK_RELAY_ENABLED_PLANS`).
Enabling Claude or Antigravity also needs the per-plan gate, fact, consent and selection work named in the app repo's
`docs/session-logs/2026-11-23-relay-r2.md`.
