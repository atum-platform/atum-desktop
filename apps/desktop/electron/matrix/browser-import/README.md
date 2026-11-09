# Browser import (desktop half)

## The flow (`service.ts`)

1. **What Chrome has.** Host names and counts only; nothing is decrypted, no Keychain. Nothing importable ends it here.
2. **Somewhere to send it.** The platform names the primary agent's computer (id and attachment epoch).
3. **Chrome's cookies for the chosen sites.** macOS may show its Keychain dialog for "Chrome Safe Storage", once.
4. **The computer's HPKE key**, read fresh through the owner-authenticated read and trusted only if a controller
   key this Mac pinned at enrollment signed it (`recipient-key.ts`).
5. **Seal** the cookies-only bundle (RFC 8785 JCS, HPKE base mode, authenticated data as AAD) (`envelope.ts`).
6. **One Touch ID.** The Secure Enclave approval key signs the exact bytes that leave the Mac.
7. **Hand over** the envelope and its consent record (`client.ts`). The platform sees digests, counts and ciphertext.

Declining step 6 discards everything: nothing leaves the Mac before the signature exists.

Device-service enrollment is automatic and silent. If it is still reconnecting, the import waits for
that enrollment, then asks exactly once for the risky browser-data transfer itself. No first-import
device confirmation or enrollment step is shown.

## Files

| File | Owns |
| --- | --- |
| `contract.ts` | The vendored wire contract: validators, JCS, digests, signature bytes, recipient-key decision. One module, so swapping to `@atum/protocol` is one edit. |
| `chrome-cookies.ts` | Chrome profiles, the Keychain key, `v10` decryption, Playwright cookie shape. **Adapted from gstack (MIT)**, see below. |
| `skip-list.ts` | The default skip list: banking, wallets, password managers. Extend the lists, not the callers. |
| `sites.ts` | Hosts to registrable sites (PSL, `tldts`), the 1,000-site and 20,000-cookie ceilings, pruning. |
| `envelope.ts` | HPKE sealing (`hpke-js`), the consent record, the signature input. |
| `recipient-key.ts` | The owner-client read request and the trust checks on the answer. |
| `client.ts` | The platform's three owner calls behind one interface (`GET computer`, `POST browser-import/recipient-key`, `POST browser-import/transfers`, atum-platform PR #663). |
| `service.ts` | The flow above, closed result codes, "one import at a time". |
| `last-import.ts` | The one small record Settings shows after a restart: counts and a time. |
| `compose.ts`, `ipc.ts` | What main wires, and the two argument-free IPC handlers. |
| `../browser-import-preload.ts` | `window.atumBrowserImport`: `status()` and `run()`, nothing else. |

Renderer: `src/matrix/browser-import-settings.tsx`. Shared types and copy (five locales, also the Touch ID
sheet's words): `shared/matrix-browser-import.ts`, `shared/matrix-browser-import-copy.ts`.

## Rules this code keeps

- **The renderer cannot widen or redirect an import.** Both bridge calls take nothing; browser, profile, sites and
  agent are decided in main.
- **No cookie value, key or site name** is logged, thrown in a message, returned to the renderer, written to a
  temp file (a locked cookie database is copied *encrypted* into a private directory and removed), or sent to the
  platform in the clear. Log lines are closed words and counts (`service.test.ts` pins the shape).
- **Cookies only.** No passwords, passkeys, localStorage or history. `origins` is always empty.
- **Left behind by default:** banking, wallets, password managers, localhost, IP literals, internal names,
  partitioned (CHIPS) cookies, and any single cookie the contract would refuse (counted, not fatal).
- **Each value is bound to its host.** On a database with the domain hash (version 24+), the first 32 plaintext bytes
  must equal SHA-256 of the row's `host_key` (leading dot included), compared in constant time. A row that fails
  is dropped and counted as `domain_mismatch` (a ciphertext copied into another host's row is never imported), and
  an import whose only losses are such rows ends `failed`, not `nothing_to_import`.
- **Fail closed on the key.** An unpinned, forged, stale-epoch or other-agent key seals nothing. The record's own
  15 s window is not checked: the platform serves the record as the controller published it, and the attachment
  epoch, read fresh just before, is what fences the key (`recipient-key.ts` header).
- **Key-rotation invariant (the cloud's side of the fence).** The cloud must NEVER regenerate a computer's HPKE key
  within an attachment epoch: losing or rotating the key requires a **new attachment epoch**. The Mac reads the
  computer's epoch fresh (signed read), pins it in the signed recipient-key request, and refuses any record whose
  epoch differs (`stale_attachment_epoch` → `key_untrusted`, nothing sealed). It cannot detect a same-epoch record
  that names a different key: `GET computer` returns only `{computerId, attachmentEpoch}`, no key id. If the
  platform ever returned the current key id with it, the Mac should also compare `hpkeKeyId` (platform follow-up);
  until then the invariant above is what makes epoch-only fencing sound. `service.test.ts` pins the epoch refusals.

## What zeroization does and does not cover

Best effort, stated plainly. Covered (each is overwritten with zeros in a `finally`, and `zeroize.test.ts` captures
the buffers and checks them after the call):

- the Keychain answer: `/usr/bin/security` runs with buffer output, so the secret is never decoded to a string;
  `readSafeStoragePassword` returns the bytes and `readChromeCookies` zeroes them once the key is derived (also on
  a refusal or an empty answer);
- the derived AES key, and every AES chunk and concatenated plaintext of each decrypted value;
- the HPKE plaintext handed to `seal` (zeroed whether `seal` returns or throws);
- the cookie arrays the service and the sealer hold: emptied right after sealing (or after a failure on the way), so
  nothing references them while the Touch ID is up. `check.ts` no longer memoizes the Keychain answer (macOS may ask
  twice when the owner runs the check) and keeps no per-row plaintext.

**Not covered:** a cookie value is a JavaScript string from the moment it leaves its decrypted Buffer (it has to be:
it goes into the bundle's JSON). V8 strings are immutable and copied by the engine, so those copies, and the
RFC 8785 string the bundle bytes are encoded from, stay in memory until garbage collection. A native helper that
decrypts, seals and never lets a value into V8 is the real fix; it is a noted follow-up, not built.

## Adapted code and licences

- `chrome-cookies.ts` and `__fixtures__/chrome-fixture.ts` adapt gstack's `browse/src/cookie-import-browser.ts` and
  its test fixtures (MIT, Copyright (c) 2026 Garry Tan, https://github.com/garrytan/gstack, 1.75.0.0, commit
  07b59e39). Notice: `third-party/licenses/app/gstack-LICENSE.txt` and `third-party/app-components.json`
  (`gstack-browser-cookie-import`). Kept: profile layout, key derivation, AES-128-CBC decryption, Chromium epoch,
  SameSite map, copy-on-lock. Changed: `bun:sqlite`/`Bun.spawn` to `node:sqlite`/`execFile`, Chrome and macOS only,
  the Chrome 130+ domain-hash prefix, partition and contract filtering, a Keychain wait long enough to answer.
- `hpke-js` 1.8.0 (MIT) and `tldts` 7.4.19 (MIT), pinned exactly; the notices script picks them up from the lockfile.

## Tests and how to run them

```bash
cd apps/desktop
npx vitest run --project electron electron/matrix/browser-import electron/matrix/browser-import-preload.test.ts \
  shared/matrix-browser-import-copy.test.ts
npx vitest run --project ui src/matrix/browser-import-settings.test.tsx src/i18n/brand-copy.test.ts
```

`__fixtures__/contract-v2.1/` is the platform pack's own conformance data copied byte for byte (known-answer bytes,
accept/reject bundles and envelopes, the 20 admission cases, recipient-key cases, `device-service/3` signature
vectors). When the contract changes, re-copy those files; the tests then say what moved. No test touches the real
Keychain, the real Secure Enclave or a real Chrome profile.

## Not in slice 1 (see the session log for the owner of each)

Arc, Brave, Edge, Safari; more than one profile; removal and a list of imported sites (the platform has
`POST browser-import/removals` and `.../erases`; the Desktop calls and their button come later); re-import
prompts; the cloud-side load (HPKE open, post-decryption site gate, Playwright `addCookies`), retained-session
restore and erase.
