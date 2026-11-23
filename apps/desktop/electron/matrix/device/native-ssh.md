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

### ChatGPT relay forced command (removed 2026-11-22)

The SSH ChatGPT relay, its forced-command helper (`atum-chatgpt-relay`), its local socket and its device-frame handler are removed
(self-work plan §12; `docs/work-subscriptions.md`). A task on the owner's plan now runs as a Work session on the Mac, through the Work gate.
What remains of this section's contract is the fail-closed half: the desktop still requests
`{"operation":"ssh_authorized_keys","purposes":true}`, but a list that carries a `relay` row (or any purpose other than `shell`) is refused whole before
anything is installed, and `managedKeys` writes shell keys only, replacing any earlier managed block (so an old forced-command line is
overwritten at the next reconcile). A `ChatGptRelayRequest` device frame is answered `refused 403 relay_disabled`. The text below is
kept only as the record of what the old contract was.

<details><summary>The old relay contract (historical, no code behind it)</summary>


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


</details>

Validation uses mocked filesystem/socket tests plus a compiled Swift helper and
real Unix sockets under a temporary home, with fake inference. No real SSH keys,
LaunchAgents, settings or provider calls are needed.

## B1 canonical hostname repair — 2026-11-18 (built, not live)

Owner request: implement bounded engineering fix B1 from the November 18 release
audit in the existing native Mac checkout; parent owns assembly and activation.
This checkpoint fixes setup/enrollment source and tests only. Installed acceptance
and live SSH proof remain open; no route, DNS, Access or token was changed live.

Existing primitives inventory / immutable contract evidence:

- `native-ssh.ts`: authenticated `ssh_prepare` and `ssh_enroll`; existing protected
  token file, serialized reconciliation, signed enrollment identity/epoch and
  encrypted `outcomeStore` supplied by `matrix/main.ts`.
- Platform origin/main `aa9a421828a5596558b278ef8542ca384187c802`,
  `apps/shell/src/lib/mac-cloudflare.ts`: `macHostPrefix`/`macHostSuffix` and
  `macProvisioner.prepare` return `mac-<opaque 32-hex label>.atumplatform.com`.
  The label is registry state, not a UUID transform. `prepare` disconnects and
  rotates an existing connector before obtaining its token.
- Activation source `4264325779` has the same prepare behavior and owner route
  in `apps/shell/src/lib/device-services.ts`. Its presence is not deployment proof.
- `0513_native_mac_cloudflare.sql` binds enrollment to the prepared route and
  current owner/device epoch; `device-services.ts` exposes no owner read-only
  hostname lookup. The controller-only `list_native` metadata contract is not
  an owner credential path and must not be called using the desktop session.

The client now accepts the authenticated prepare hostname only for the default
platform namespace and exact opaque-label shape; rejects nested/foreign hosts,
URLs, ports, paths and trailing whitespace; and sends the canonical hostname
unchanged to enrollment alongside the existing local ed25519 host key. Custom
platform hostname profiles require a separately reviewed client configuration;
they are not implicitly trusted by this production client.

The existing encrypted settings store persists
`native-ssh:route:<ownerUserId>:<matrixDeviceId>:<deviceServiceId>` with the host
and SHA-256 digest of the tunnel credential, never the credential itself. The
secret remains solely in the existing 0600 token file. Matching metadata lets
restart and epoch rotation reuse the token without prepare. Epoch changes still
force enrollment with the current host key and device epoch. A new token requires
new matching metadata; stale/interrupted writes cannot associate it with another
route. Sign-out/revoke clears metadata independently with the existing token,
managed-key and LaunchAgent cleanup. No new persistence service or platform API.

Legacy recovery is deliberately explicit: an existing token with absent, corrupt,
foreign-scope or digest-mismatched metadata reports
`native_ssh_route_recovery_required`, retains the secret, removes managed keys and
stops the connector. It does **not** call prepare automatically. Use the existing
Disconnect action to revoke/clean up, then Connect to prepare a fresh route under
the authenticated owner. A failed revoke must be resolved/retried before
activation. This is the safe recovery available through the current revoke and
prepare contract, not a silent destructive token rotation. An interrupted first
setup metadata write uses the same recovery. Automatic in-place legacy migration
would require a new read-only owner metadata API and is outside this client fix.

The enrollment fixtures now use the current platform-shaped opaque hostname
rather than the legacy `founder.mac`/UUID shape. They are adapted cross-contract
fixtures, not claimed byte-identical copies of older platform spec fixtures.
Focused tests exercise first setup, restart, epoch change, explicit revoke/route
rotation, sign-out, metadata write failure, corrupt/mismatched metadata, owner and
Matrix-device isolation, malformed/foreign prepare and unchanged shell/relay key
restrictions. Temporary homes and mocked authenticated HTTP/processes only.

Packaging/activation handoff:

1. Parent assembles this source into the Matrix Electron main bundle
   (`scripts/bundle-electron-main.mjs` → `matrix-main.mjs`) and packages/signs it.
   This patch changes no Swift/Python runtime, cloudflared version/digest,
   LaunchAgent arguments, forced command, release manifest or build scripts.
   Updating scripts or a Python-only runtime cannot activate this fix in an old
   installed Electron bundle. Existing native helpers must still be staged/signed.
2. Preserve the existing installed app/settings/token for rollback. Prefer a
   fresh authorized test device; for legacy missing metadata use the explicit
   recovery above, with awareness that revoke/prepare invalidates the old token.
   Rolling back the app does not restore a revoked token or fix its old hostname
   derivation; re-enrollment under the fixed client may be needed.
3. Parent verifies the authenticated prepare host matches platform registry,
   Access wildcard and DNS, then proves host-key-pinned terminal/file read/write
   in a safe temporary directory, restart/epoch rotation, revoked/foreign keys,
   sign-out, sleep/wake and app replacement using the installed app. No live
   route calls or inference were performed for this checkpoint.
4. Capacity discrepancy for assembly: this owned base `8aa853e16` still has
   800,000-byte caps in `native/chatgpt-relay.swift`, `chatgpt-relay-socket.ts` and
   `chatgpt-relay-process.ts`; it does not contain the stated 16 MiB relay change.
   This fix leaves every relay cap and forced-command behavior untouched. Parent
   must retain the separately assembled 16 MiB work and validate it there.

Local validation for B1 (2026-11-18):

- `vitest run --project electron electron/matrix/device/native-ssh.test.ts electron/matrix/device/chatgpt-relay.test.ts electron/matrix/device/chatgpt-relay-socket.test.ts`:
  3 files, 71 tests passed; all network/process paths mocked, no live route call.
- Desktop `npm run typecheck`: passed, including client boundary, renderer,
  consumer browser, Electron and E2E TypeScript projects.
- ESLint on `native-ssh.ts` and `native-ssh.test.ts`: passed without warnings.
- Desktop `npm run lint`: blocked by the existing
  `cloud-agent.ts:73` `@typescript-eslint/consistent-type-imports` error (inline
  NativeSshRequest import annotation present unchanged at base `8aa853e16`), plus
  existing package warnings. Left the adjacent shared transport file unchanged.
- `git diff --check`: passed. No packaging, live SSH/launchd, native prompt,
  DNS/Access, cloud deployment, provider call, PR/CI or push performed.

## macOS login names

Enrollment preserves the spelling of the short account name, including uppercase letters. The first character must be an ASCII letter or underscore. Subsequent characters can also include digits or hyphens, up to 32 characters total. Deploy compatible server-side enrollment validation before releasing the client.

## Setup step reasons and Disconnect

Native SSH reports the failing step (`prepare`, `authorized_keys`, `write_keys`,
`start_tunnel`, or `enroll`) through the existing `matrix:native-ssh` IPC.
The view contains the step and an allowlisted code. Main logs the same pair.
Registry response text and process messages stay out of both. The saved token
and the enrollment-scoped Full Disk Access reminder retain their existing
recovery and acknowledgement rules.

The current Connections row calls `nativeMac.ssh('disconnect')`. C4 can call
the same action from its Connections pane. This action disables automatic
reconnect for the signed-in account on this Mac, revokes the SSH route and
removes the local tunnel, managed keys, token and route metadata. It also cuts
off delegated plan use and withdraws this Mac's acknowledged Work plan fact
through the existing Work publisher, even if Work is stopped. Missing plan
facts or a missing Work ledger require no platform call. When C3 expands
publication to more plans, extend that publisher's withdrawal to cover them.
The action preserves provider sign-ins.

Window focus uses `nativeMac.ssh('refresh')`, which respects the native service's
saved Disconnect setting. Only an explicit Connect restarts setup and resumes
plan-fact publication. Delegated plan use remains off until the owner enables
it. A failed revoke or withdrawal stays visible as a retryable Disconnect,
including after an app restart.

Verification uses mocked owner responses, process calls and Work reports, plus
temporary homes and real Work ledgers. The focused tests cover all five failing
setup steps, credential redaction, cleanup and retry, focus and restart after
Disconnect, and published fact withdrawal.
