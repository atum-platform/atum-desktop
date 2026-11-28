# Free plans in Work

Settings → Connections includes a local GitHub Copilot row. Work reports missing
software, sign-in and readiness. Install & sign in opens GitHub’s native browser
flow. GitHub Copilot CLI stores its credentials on the Mac.

Launch Desktop from Finder on a Mac without Copilot, then click Install & sign in.
Use an existing individual Copilot Free account with extra spending disabled.
Confirm the row becomes Connected on this Mac, select Copilot in Work, send a
harmless prompt in a throwaway workspace, then restart and check readiness again.

These plans are for interactive Work sessions. Copilot and Kiro stay outside the
cloud relay and automatic plan switching. Desktop assembly must pin a Work
release containing the matching provider changes.

## Kiro

Work can install the Darwin Kiro CLI archive pinned by the ACP Registry and open
its browser sign-in. An existing Kiro CLI on the Mac can sign in directly. The
native driver uses the CLI’s account and model catalog for readiness.

The owner still needs to confirm Kiro Free availability from Vietnam using an
existing eligible account. In Desktop, click Install & sign in for Kiro, choose
your Free account in the browser, select a model Work offers, send a harmless
prompt, and verify usage and readiness after a restart.

## OpenRouter Free

Connect OpenRouter Free from Settings → Connections after installing OpenCode
2.3.2. This is a manual fallback for a few chats per day. Use a personal
workspace without upstream provider keys. Complete OpenRouter’s browser consent
and select OpenRouter Free in Work. The daily count, when available, comes from
OpenRouter’s key endpoint.

The Work instance stores the PKCE-issued key in OpenCode’s local credential
database beneath the account’s Work directory. It uses a distinct OpenCode
server, provider policy and plugin. The plugin permits two literal Gemma
`:free` models with zero-priced catalogs, limits every request to OpenRouter
chat completions, and sets OpenRouter’s price ceilings to zero. Titles and
compaction use the pinned Gemma free variant. OpenRouter privacy errors link
to its Privacy page.

On a packaged build, choose an already eligible personal account, complete
browser consent, send a harmless Work prompt, and check OpenRouter Activity for
the exact model and zero cost. Verify the separate ordinary OpenCode list has no
OpenRouter models, including after restarting Desktop. Use Work’s provider
settings to disconnect and OpenRouter’s key settings to revoke the issued key.

OpenRouter cloud relay, automatic fallback, upstream key verification, OpenCode
Zen, Cursor and Mistral are outside this release.

Local verification uses synthetic accounts and a loopback fixture. OpenCode
2.3.2 sent both chat and title requests with a zero price limit in the fixture.
Live browser sign-in and the packaged app remain owner acceptance steps.

The local row tests cover missing software, in-progress setup, signed-out and
ready states for all three providers. They also check that the local actions do
not grant cloud relay consent.

The rows refresh when Work is ready, when Desktop regains focus and after
setup returns. The status and the OpenRouter count come from Work.
