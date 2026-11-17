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
