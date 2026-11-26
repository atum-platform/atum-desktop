# Shell MCP servers in Work

The 2026-11-25 account parity request applies to the owner's Work threads and
assistant handoffs. Desktop serves Google and Owner Chats through the existing
Work loopback connector. The Work launcher passes the connector address and
delivers its token over the inherited supervisor pipe. The provider-facing
bearer is derived from that token and authorizes only the two MCP routes. Work
verifies the listener before adding the tools to new sessions, and the launcher
stops the sidecar when Desktop's control pipe closes.

Desktop forwards the Matrix bearer only to the configured Shell origin. It
reads the current token on each request and retries once on a 401 using the
existing Matrix session refresh. The connector closes on Work retirement.
Desktop removes the legacy manifest and any interrupted write at startup and
before starting Work. Connector startup can fail independently of Work.

The launcher and supervisor are shared with the relay and launcher changes.
This implementation needs no edits to either because they already deliver the
connector credentials. The staged Work runtime pin and live Shell acceptance
remain release work. Strap and Situation still need account-scoped Shell routes.

## 2026-11-26 integration

Rebased on Desktop main and kept its existing direct T3 publication and `/ask`
route. Account MCP adds its health proof and two routes to that listener. A
listen error for the current account leaves the sidecar launch without connector
credentials. Account changes still cancel the launch. The Google write card is
part of the same Desktop change so Work's pending writes can be acted on.
