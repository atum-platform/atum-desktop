# Work plan detection on macOS

Status on November 28, 2026. Implemented locally. Installed-app and cloud rollout verification are pending.

The cloud agent picker could show Connect for Antigravity while Work already had a ready personal OAuth session and a native model catalog. The Desktop account-connections reader returned a successful registry reply before consulting Work. A registry row is assembled from acknowledged device reports and current Work enrollment, so a successful read can still omit a locally connected plan. The native relay read also kept a separate persistent catalog that could survive a Work restart.

- The paired Work server's `subscribeServerConfig` snapshot and status updates feed one in-memory observation per Work process. The native `server.refreshProviders` RPC rechecks CLI status and login-shell PATH after pairing and every five minutes. Work's automatic local model selection uses that same stream.
- The picker, first-run connection labels, and device reports use this observation. A definite native sign-out removes this Mac from the local view of the account. Registry facts still supply the other Macs and cloud connections.
- Native connection status appears even while the cloud registry is catching up. Agent model selection remains subject to the existing MCP publication and platform selection checks. Selection first attempts to publish the current Work observations.
- Finder launches retain the login-shell PATH and include macOS's common user and Homebrew binary locations. The separately tracked exact legacy false-stub migration still applies. An intentional provider disable or publication opt-out stays in effect.
- Main logs one safe plan, state and reason per native check. A refused device report logs the plan, state and HTTP status. The native SSH prepare failure is a separate route provisioning signal. If it persists, check the relay transport separately from the Work provider status and capability reports.

Focused tests cover an omitted registry row, native sign-out with and without another Mac, status stream changes, the periodic native refresh, Finder PATH, and publication ordering. No provider sessions or local device settings were modified to verify this change.
