# Native Mac SSH setup (main process)

This adapter uses the existing `MacDeviceIdentity.enrollment()` identity/epoch and
`account.s1Request` owner session. It does not extend the device-frame transport.
The public SSH registry contract is `atum.device-service/1.3`; the four copied
JSON test fixtures in `native-ssh-fixtures` come from that immutable platform pack.
`ssh_prepare` follows the additive 0513 owner contract supplied for this lane.

`hermesDesktop.nativeSsh.request(action)` is the preload entry point. Actions are
`status`, `connect`, `disconnect`, `enable_remote_login`, `full_disk_access_hint`,
and `open_settings`. Main validates the sender and signed-in owner. No screen is
included. Status returns a fixed reason code, never provider/process error text.
The service starts after existing device enrollment and refreshes keys every minute.
An explicit disconnect suspends automatic setup for the rest of that app session;
`connect` resumes it. A login LaunchAgent keeps the tunnel running outside the app. Key refresh runs
only while the app is running; withdrawn keys may remain until the app resumes.
Tunnel health requires launchd liveness, the first-connect pidfile, and cloudflared
`/ready` on a loopback metrics port allocated at installation time.

Remote Login detection uses the unprivileged launchd disabled-state query and a
localhost port 22 connection. Host keys come from the system ed25519 public key;
the login account comes from the process user. Only `enable_remote_login` invokes
an administrator prompt through osascript. The UI must present that as an explicit
user choice. If macOS refuses systemsetup (including a privacy restriction), guide
the person to System Settings > General > Sharing > Remote Login. Enable Remote
Login for the intended login user. The app cannot inspect or grant the Remote
Login pane's **Allow full disk access for remote users** option: the UI can request
`full_disk_access_hint` after an SSH permission failure and offer `open_settings`.
No permission is inferred from the desktop application's own Full Disk Access.

The installed development helper (2025.11.1) confirms `--token-file` support in
`/opt/homebrew/bin/cloudflared tunnel run --help`; it is not a public-user
prerequisite.

The helper is Cloudflare's Apache-2.0 cloudflared 2026.11.0, downloaded lazily to
Application Support/Atum/native-ssh for arm64/x64. SHA-256 archive digests are pinned
from the [official GitHub release](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0), checked before extraction. This mirrors
the app's verified-helper provisioning approach without requiring Homebrew, a shell
PATH, or an owner-specific binary. No dependency/app install or helper download is
performed by the tests. Updating the pin is a deliberate source change.

The tunnel token exists only in memory and a dedicated **local macOS Keychain**
item (`com.atum.desktop.native-ssh`, account = deviceServiceId). The existing
recovery-key helper is intentionally not reused: it synchronizes to iCloud and
only admits app callers, whereas launchd must read this machine's token after
login. The security CLI receives writes on stdin, never password arguments.
The LaunchAgent's shell reads Keychain into a pipe; cloudflared reads `/dev/stdin`
with its documented `--token-file` option. Neither the plist nor wrapper nor logs
contains the token. A locked Keychain may require the user's normal macOS unlock.
Cloudflare's remotely managed ingress must map the prepared hostname to
`ssh://localhost:22`; the local URL argument supplies the same target but cannot
override a remote ingress rule. The platform prepare implementation owns this.

The managed authorized_keys block contains only validated ed25519 public keys,
with forwarding disabled. Atomic rename preserves bytes outside the block; symlink
SSH directories/files and malformed blocks are refused. Directory/file modes are
700/600. Refresh failure removes managed keys and stops the tunnel. Sign-out and
explicit disconnect attempt remote revoke and every local cleanup independently;
a failed revoke remains an error for retry, while local access is withdrawn.
This does not terminate already established system sshd sessions. Remote Login
itself remains on because the app must not change the user's other SSH access.

Verification: run native-ssh.test.ts and cloud-agent.test.ts, desktop typecheck,
and scripts/public_guard.py against origin/main and the committed HEAD. Real
macOS administrator prompts, Keychain access policy, cloudflared first-run startup,
Cloudflare ingress and native Hermes SSH/file access need coordinator acceptance;
this lane intentionally performs no production or real-home operations.

## Window (renderer)

`atumMatrix.nativeMac` (ui-preload, `shared/matrix-native-mac.ts`) is the Matrix window's bridge to
`matrix:native-ssh`; the `hermesDesktop.nativeSsh` entry in `preload.ts` is not loaded in that window.
Settings › Connections › Your Macs gives this Mac's row native reach's one line and action, after the
row's own fix: `needs_remote_login` → Allow… (the administrator prompt), then Open Settings if that
fails; `needs_full_disk_access_hint` → Open Settings; `error` and a repeated `tunnel_down` → Try again;
connected → the row's quiet Ready. Nothing calls `full_disk_access_hint` yet and the next minute's
refresh replaces it, so the hint needs a sticky trigger from the SSH permission failure.

Command approvals: native Hermes on Matrix posts its approval as one message (a fenced command, a
reason line, the untranslated `!approve` / `!deny` hints) and seeds its own ✅ / ❌ reactions. The window
draws an owner's agent's such message as one card (`src/matrix/native-command-approval.tsx`). Approve
asks `matrix:native-command-confirm` (the device approval key's Touch ID or Mac password over
domain-separated bytes, else Electron's Touch ID; nothing is remembered), then reacts ✅ on that event;
Deny reacts ❌. Hermes still accepts a typed `!approve`; Touch ID is the window's step, not Hermes's.

## Phone (Face ID) spec, for the atum-mobile lane

1. Detect: a message from one of the owner's agents whose body has one ``` fenced block and contains
   `` `!approve `` and `` `!deny` ``. The command is the fence's content; the reason is the next line after `: `.
2. Waiting while the sender itself reacted ✅; answered when the owner reacted ✅ (approved) or ❌/❎ (denied).
3. Card: terminal glyph, "Run this on your Mac?", the command on one line (tap shows all of it and "Why it asks: …").
4. Buttons: Approve (primary) and Deny (plain). No other text. Copy: `shared/matrix-native-mac-copy.ts` `approval`.
5. Approve: LocalAuthentication `.deviceOwnerAuthentication`, reason = `sheetReason(command cut to 80)`.
6. On success send `m.reaction` `m.annotation` key `✅` relating to that exact event id. Cancelled: send nothing.
7. Deny sends key `❌` on that event, without Face ID. Never type `!approve` (it answers the newest prompt).
8. Answered: one line ("Approved" / "Denied"); no seeded ✅ and older than 15 s: "No longer waiting".
9. Hide the message's reaction chips while it is a card, so a tap cannot approve without Face ID.
10. The cloud computer never prompts; every card here is about the owner's Mac.
