# Native Mac setup

The adapter uses Hermes SSH through macOS Remote Login, the existing device
enrollment epoch, and the authenticated S1 owner session. It registers the host
with `ssh_prepare` / `ssh_enroll` and reconciles validated ed25519 agent keys in
one scoped `authorized_keys` block every minute while the app runs. Bytes outside
the block survive rotation and revoke. SSH directory/file modes are 700/600.

## Tunnel packaging and ownership

Both Matrix packaging configurations run `scripts/stage-cloudflared.mjs` before
packing. It downloads Cloudflare's Apache-2.0 2026.11.0 archive, verifies the pinned
SHA-256 and target Mach-O architecture, and stages `cloudflared` beside the other
unpacked, signed helpers. Unsupported architectures and missing/corrupt helpers
fail packaging. The running app uses only that packaged executable.

One per-user LaunchAgent (`com.atum.desktop.native-ssh`) invokes cloudflared
directly with `KeepAlive`. launchd owns recovery. Setup installs the job
idempotently, including recovery from interrupted bootstrap. A changed app path
or old shell-wrapper configuration replaces the job. The app has no tunnel PID,
metrics port, readiness probe or restart supervisor. `connected` reports successful
setup and registration. Cloudflare ingress must route the prepared hostname to
`ssh://localhost:22`.

The token is an atomic 600 file within a 700 Application Support/Atum/native-ssh
directory. Only its path appears in launchd arguments. Sign-out and disconnect
attempt remote revoke, launchd removal, managed-key removal and token deletion
independently. Cleanup also removes the previous adapter's Keychain item and shell
wrapper. A cleanup failure remains retryable. Existing sshd sessions survive
revocation, and Remote Login remains the owner's system setting.

## Window adapters

Settings reads the setup result when opened, after actions and on window focus.
Remote Login offers Allow…, with Open Settings after an unsuccessful administrator
prompt. Other existing copy, controls and layouts are preserved. The renderer
has no polling timer or speculative settling period.

The Full Disk Access reminder is acknowledged only after Settings opens
successfully for the enrollment that offered it. The existing encrypted outcomes
store persists `native-ssh:full-disk-access-hint:<deviceServiceId>:<enrollmentEpoch>`.
Reconnects and restarts preserve acknowledgement. Each new epoch offers it again.
Opening Settings acknowledges the reminder and supplies no evidence about TCC.

The authenticated owner's agent messages retain Hermes's command and reason.
The card responds with an event-specific ✅ / ❌ reaction. The sender's seeded ✅
is the waiting signal. Its absence closes the card immediately, with no timed
reaction-seeding lifecycle. Approve performs a fresh Electron Touch ID prompt.
Where Electron cannot offer Touch ID, the existing native helper's `presence`
command uses zero-reuse LocalAuthentication with the Mac password fallback.
The password path refuses biometric-capable hardware and returns success without
loading keys or creating a signature. Cancellation
sends no reaction. This flow has no GUI-broker pause coupling.

## Verification

Focused Vitest covers setup, key rotation/revoke, cleanup, protected token files,
restarts and epoch-scoped acknowledgement, presence cancellation and fallback,
and the two renderer adapters. Packaging tests cover digest rejection and target
staging. The helper can be compiled without invoking a system prompt. Real
launchd installation, live tunnel reachability and native authentication remain
installed-app acceptance work. Tests use temporary homes and mocked process calls.

### ChatGPT relay forced command

The desktop requests `{"operation":"ssh_authorized_keys","purposes":true}`.
The plain operation returns only shell rows in the legacy three-field shape.
Unknown purposes are refused before installation. An `ssh_authorized_keys` row with
`purpose: "relay"` binds its existing `agentId` to the current signed-in owner
principal and this Mac's enrollment epoch. Missing purpose and `"shell"` retain
the terminal restrictions. Full reconciliation replaces both purposes; a removed
relay row immediately leaves the live binding list and cancels its socket calls.
Sign-out clears both purposes through the existing disconnect path.

Packaging compiles `native/chatgpt-relay.swift` into `atum-chatgpt-relay` beside
cloudflared in `app.asar.unpacked`. Its forced command takes only owner UUID,
agent UUID and enrollment epoch. It never reads `SSH_ORIGINAL_COMMAND`, accepts
no socket path, and locates the account home via `getpwuid`. It sends one JSON
envelope after stdin EOF, then reads one response through EOF. Both wire
directions are capped at 800,000 bytes; there is a 65-second I/O deadline and a
70-second hard process deadline.

The running desktop serves `~/.atum-chatgpt-relay/relay.sock` (0600) in a directory
owned by the account (0700). Unsafe directories, symlinks and non-socket files
are refused. The existing saved relay enablement, live account authority,
owner/agent/model checks, relay revision authorization, expiry, replay fence and
account-local Hermes process apply to both transports. SSH replaces only the
device-session admission check with the reconciled owner/agent/enrollment-epoch
binding; `connectionId` remains a syntactically valid legacy envelope field.
No token crosses the socket or SSH. The existing cloud training-confirmation
admission remains required; this adapter creates or resets no confirmation.

No app or disabled relay means no listening socket. Before submission the helper
returns `{state:"refused",status:503,code:"unavailable",retryable:true}`. Once a
write starts, loss/timeout/oversize fails without retry permission. Host code must
map pre-submission unavailable to its existing fallback and never replay an
ambiguous submitted call. Host/platform wiring and installed-Mac qualification
are separate steps; the device-hub path remains until that parity is verified.

Validation uses mocked filesystem/socket tests plus a compiled Swift helper and
real Unix sockets under a temporary home, with fake inference. No real SSH keys,
LaunchAgents, settings or provider calls are needed.
