# Matrix SDK 45 security port (2026-11-16)

Local implementation checkpoint; **not ready to ship**. Verification stopped at
its mandatory disk floor. No push, PR, CI, deployment, or real homeserver access.
Electron stays unchanged.

## Versions and advisories

- Both desktop and browser-client: matrix-js-sdk **42.4.0 → 45.1.0**;
  @matrix-org/matrix-sdk-crypto-wasm **18.8.0 → 18.9.2**.
- [GHSA-jx97-gwvc-pfxx](https://github.com/matrix-org/matrix-js-sdk/security/advisories/GHSA-jx97-gwvc-pfxx):
  low severity ReDoS from malicious push-rule / ignored-invite policy-room globs;
  SDK versions through 45.0.0 are vulnerable; 45.1.0 fixes it.
- [GHSA-pqp6-f7wc-6498](https://github.com/matrix-org/vodozemac/security/advisories/GHSA-pqp6-f7wc-6498):
  medium severity malformed Ed25519 Base64 panic; crypto-wasm 18.9.1 adopts
  vodozemac 0.11.2. The 18.9.2 release has no further functional changes.
- Defer crypto-wasm 19.x until a matrix-js-sdk release depends on it. SDK 45.1.0
  pins exactly 18.9.2; no npm override is added.
- `.npmrc` adds dated package exclusions for these two security releases
  (2026-11-11 and 2026-11-10). Remove each exclusion when the release is over
  two weeks old. All other release-age policy stays enabled.

## Migration inventory

Read the installed SDK CHANGELOG sections for 43.0.0, 44.0.0, 45.0.0 and 45.1.0,
plus the [crypto-wasm 18.9.x changelog](https://github.com/matrix-org/matrix-sdk-crypto-wasm/blob/v18.9.2/CHANGELOG.md#L2-L19).
Checked the source diffs of upstream PRs 5520, 5591, 5574, 5573, 5588 and 5199.
Searched desktop src/, electron/, scripts/ and browser-client source/tests.

| Change | Impact and disposition |
| --- | --- |
| 43: remove `tokenRefreshFunction` and `TokenRefreshFunction` | Affects `apps/desktop/src/matrix/sdk.ts:697` and `packages/browser-client/src/chat-runtime.ts:177`; remove callback and SDK refresh-token option; use the host adapter described below. Renewal tests now make HTTP requests through the actual SDK. |
| 43: move OAuth refresh into SDK; change TokenRefresher and authorization grant API | No direct application TokenRefresher or SDK `completeAuthorizationCodeGrant` usages. Desktop/browser OAuth owners already perform their own grants. |
| 43: remove unstable MSC2965 discovery fallback | No SDK unstable discovery usage; browser OAuth already calls stable `/v1/auth_metadata`. Native host OAuth stays outside the renderer. |
| 43: refine import/exportSecretsBundle types | Not used. |
| 43: RTC notification/decline changes | No MatrixRTC usage. |
| 44: remove deprecated RTC APIs | `application`, `membershipID`, `callId`, `joinRTCSession`, `joinRoomSession`, `leaveRoomSession`, `getOldestMembership`, `getFocusInUse`, `_onRTCSessionMemberUpdate`, `updateEncryptionKeyThrottle`, `isLivekitTransportConfig`: not used as SDK APIs. |
| 44: remove oldest-membership transport selection | No `oldest_membership`, `focus_active`, `fociPreferred` or `multiSfuFocus` usage. |
| 44: consolidate LivekitTransport/LivekitTransportConfig | No LiveKit/MatrixRTC imports or calls. |
| 45: LiveKit request `member` → `member_id`, stronger slotId | No LiveKit requests or RTC slots. |
| 45: remove delayed-event parent IDs | No `parent_delay_id` or delayed-event send calls. |
| 45: stable mutual-room endpoint | No shared/mutual-room API calls. |
| 45.1: delayed-event dedicated endpoint/capability/error changes | No delayed-event scheduling API usage. |
| 45.1: sticky duration must be positive, ordering/decryption fixes | No explicit sticky-duration option usage; SDK handles incoming events. |
| 45.1: RTC 32-byte key material | No RTC implementation. |
| 18.9.x crypto API | No announced binding API breaks; security update and Rust SDK update only. |

## Refresh boundary

The documented SDK replacement is `oauthClientId` plus `onTokenRefresh`, with
SDK-owned OAuth discovery, refresh and retry. See
[client options](https://github.com/matrix-org/matrix-js-sdk/blob/v45.1.0/src/client.ts#L337-L356)
and [TokenManager](https://github.com/matrix-org/matrix-js-sdk/blob/v45.1.0/src/http-api/refresh.ts#L160-L197).
This requires the actual refresh secret in the SDK. There is no public external
host refresh callback after PR 5520, so it cannot preserve desktop's native-host
secret boundary directly.

`apps/desktop/shared/matrix-host-refresh.ts:9` is the small adapter for that gap,
using the SDK's public `fetchFn` and `setAccessToken` seams. It keeps the opaque
host handle out of SDK options and HTTP requests. On same-origin authenticated
Matrix `M_UNKNOWN_TOKEN` responses, it asks the existing credential owner once,
shares concurrent refresh/renewal, rotates the handle, and replays the request
once with its original body and updated bearer. A newer token already applied
while a request was in flight avoids another host call. A definitive refusal
passes to normal SDK logout handling; temporary failure becomes the SDK's
`ConnectionError`, preserving the signed-in session. Stopped clients do not apply
late refresh results. Browser-client uses the same adapter with its existing
BoundDevice credential owner; no refresh secrets move into desktop renderers.

`apps/desktop/src/matrix/sdk.ts:5112` routes proactive host renewal through the
same adapter. `apps/desktop/src/matrix/media.ts:88` preserves a replay Request's
abort signal when adding media/read/moderation timeouts. Existing media bounds
and redirect restrictions continue to apply on retries.

## Crypto store compatibility

**Source conclusion: no new IndexedDB crypto schema migration or application
migration call is required for this bump.** The entire Rust crypto migration
module is byte-identical between the old WASM Rust revision and the new one:
[old schema version 107](https://github.com/matrix-org/matrix-rust-sdk/blob/6bcb11f8a57debb0f4f32937d6ba499e76fa0ae3/crates/matrix-sdk-indexeddb/src/crypto_store/migrations/mod.rs#L322)
and [new schema version 107](https://github.com/matrix-org/matrix-rust-sdk/blob/matrix-sdk-0.19.1/crates/matrix-sdk-indexeddb/src/crypto_store/migrations/mod.rs#L322).
The Rust versions come from each WASM release's Cargo.lock. Store opening still
[invokes its built-in upgrade routine](https://github.com/matrix-org/matrix-rust-sdk/blob/matrix-sdk-0.19.1/crates/matrix-sdk-indexeddb/src/crypto_store/mod.rs#L373).
The JS SDK continues to call
[StoreHandle.open/openWithKey](https://github.com/matrix-org/matrix-js-sdk/blob/v45.1.0/src/rust-crypto/index.ts#L140-L149).
Keep existing store prefixes/keys and initRustCrypto; do not clear stores.
This is source evidence, not a completed old-version-to-new-version persistent
store upgrade test.

## Verification

Commands below run from repository root with Node 24.21.0/npm 11.19.0.
The default shell Node 23 was rejected by engine-strict before installation;
no engine policy override was used.

| Command | Result |
| --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund` | PASS: 1 added, 6 changed, no age/peer override flags; no npm ci. |
| `npm run typecheck --workspace apps/desktop` | PASS, exit 0; all four TS phases and client boundary. |
| `node apps/desktop/scripts/check-client-boundary.mjs --typecheck-without-controller` | INCOMPLETE: import boundary passed; tsconfig.json passed (8,239 source files, zero private sources); stopped during remaining configs at disk floor. Initial run caught the obsolete test callback and was corrected. |
| `npm run lint --workspace apps/desktop` | FAIL: first run had 1 import-order error and 4,414 warnings; rerun finished with 1 import-order error and 4,410 warnings. The import was moved into its shared-import group in the final checkpoint; that final placement has not been rerun. Unrelated automatic formatting was removed. Zero-error full lint remains required. |
| `npm run check --workspace packages/browser-client` | PASS: typecheck; 98 tests/15 files; 7 Node proof tests, zero failures; browser build. |
| `npm exec --workspace apps/desktop -- vitest run shared/matrix-host-refresh.test.ts src/matrix/sdk-renewal.test.ts --maxWorkers 2` | PASS: 11 tests/2 files, zero failures. Includes real SDK retry, renewal overlap, replay, handle rotation, host refusal and stop boundaries. |
| `npm exec --workspace apps/desktop -- vitest run src/matrix electron/matrix --maxWorkers 4` | INCOMPLETE: stopped at disk floor. Reported 14 failed tests in 3 known Python-backed files: mac-job-startup (2), conversation/jobs (2), mac-job-runner (10). Traceback includes missing ruamel. No failures outside the five known Python-backed files were reported before stopping; no aggregate pass count available. |
| `npm run test:ui --workspace apps/desktop` | INCOMPLETE: stopped during parallel phase; no final pass/fail count; serial device-approval phase not reached. |
| Offline real-WASM encryption/backup/verification | Located 8 integration files listed below; directory run stopped without a retained final result. Must run separately and report counts on resume. |
| `npm exec --workspace apps/desktop -- vitest run --maxWorkers 4` | NOT RUN: disk floor. |
| `git diff --check` | PASS before checkpoint. |

Offline WASM integration files under `apps/desktop/src/matrix/`:
`device-isolation`, `agent-trust-identity-import`, `agent-backup-restore`,
`prepare-event`, `decryption-restore`, `notice-edit`, `device-trust-proof`,
`device-approval` (all `.integration.test.ts`). Run device-approval serially as
specified by test:ui. Also retain direct WASM attachment coverage in media,
room-shared, sdk-plain-rooms and read-invocation tests.

Disk: `df -g /System/Volumes/Data` reported 6 GiB before and immediately after
installation. During verification it fell to 3 GiB (3,389,044 KiB observed), below
the required 4 GiB floor; running test/typecheck processes were stopped. No
further verification was started. Resume only after sufficient space is restored.

## Remaining acceptance and E2EE risks

- Complete all interrupted and unrun checks; the checkpoint is not release evidence.
- Run the real-WASM suites separately, including serial device approval and
  encryption/backup/verification counts. Persistent-store upgrade and packaged
  Electron WASM loading have not been exercised.
- Live MAS/native-host refresh and actual multi-device acceptance remain untested;
  all completed tests are offline. No real homeserver contact is authorized here.
- Temporary host refresh failures now surface as ConnectionError rather than
  TokenRefreshError because the SDK wraps fetch exceptions. Verify callers and
  full UI behavior in the remaining suites.
- Full desktop tests must explicitly distinguish failures in shared-group-runner,
  mac-job-runner, conversation/jobs, mac-job-startup and shared/setup-methods from
  any additional failures. Provisioning Python is outside this port checkpoint.
