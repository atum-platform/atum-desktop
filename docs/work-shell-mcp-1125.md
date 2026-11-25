# Shell MCP servers in Work

The 2026-11-25 account parity request applies to the owner's Work threads and
assistant handoffs. Desktop starts a loopback MCP proxy as part of Work's existing
account lifecycle and publishes its Google and Owner Chats routes to the
matching Work server's `userdata/managed-mcp-servers.json`. This requires a Work
runtime containing the host-managed MCP setting. The manifest carries a
listener-specific credential. Desktop sends the Matrix access token only to the
configured Shell origin, uses the latest saved token on each request, and
coalesces refresh through the existing Matrix session handler on HTTP 401.
Work retirement revokes the loopback credential and removes the manifest.

Live parity is blocked upstream. As of Shell `30b1c80029`, both MCP routes call
`owner_chats_agent_binding`. Migration `0510_owner_chats_s2_binding.sql` requires
a personal assistant subject and a qualifying runtime or executor. A human
Desktop Matrix token cannot satisfy that binding. The S2 host also registers
Strap and Situation from `home_mcp_by_owner` with separate Cloudflare Access
credentials. Those hosts have no equivalent account-scoped Shell MCP routes in
this baseline. Shell needs a human-account admission path and an account-scoped
interface for the home tools before this transport can provide full parity.
Desktop keeps the same registration and credential handling for both Shell routes.

The loopback fixture exercises the manifest, current token, refresh on refusal,
and sign-out. The staged Work runtime pin and live Shell acceptance are release
work. The Desktop launcher under `electron/work/sidecar` has no source changes
in this checkpoint.
