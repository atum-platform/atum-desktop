# Work: main-process integration (`apps/desktop/electron/work/mount/`)

How main holds Work: the session (`work/session`), the sidecar host (`work/sidecar`) and the assistants' gate
(`work/gate`) start, retire and tear down together through one object, `WorkMount`. It takes every main-owned
dependency as a port, so any composition (this public main, the Matrix composition) mounts it the same way.

## Order

| Event | Order |
|---|---|
| Start (`reconcile()`) | surface `on` + signed-in account + a gate the composition can build -> `WorkSession.start()` (recovery and the auth-reset marker first) -> enroll -> `gate.start()` only while `held()` is false -> bind the socket only when the owner accepted the Work screen (D9) and the switch is on |
| Sign-out / account switch (`retire(account)`) | gate cutoff, socket removed, owed stops settled **while the server runs** -> `WorkSession.retire` (views closed, process group stopped, partition cleared, auth reset) -> gate closed. A failed step never skips the next; unsettled stops stay owed in the gate's ledger |
| Work off (`workOff()`) | gate cutoff -> host disabled. Turning Work on does not reopen the route: the owner turns the switch on |
| Quit (`quit()`) | gate closed (no cutoff: quitting is not a revocation), then the process group stops |

Hiding the Work entry only keeps the gate from starting; it stops nothing that runs. A start still in flight when the
account retires finishes into nothing (epoch fence).

## Pieces

- `owner-event.ts`: `OwnerEventVerifier` for the gate. Reads the owner's event through the app's own Matrix SDK
  (`readInvocation`, `findAssistantRoom`): the room comes from the account's agent record, the sender must be the
  owner on a device the owner's crypto trusts (or the homeserver-authenticated sender of a plain room), and the event
  must be the owner's own plain text (not an edit, thread, forward or Google-protected content). A homeserver outage,
  a client that is not ready, a roster that did not load or an account that changed mid-read is `unreachable`
  (`unavailable` to the helper, retry the same id). Only stable, specific answers become a refusal. The age bound and the
  one-message-one-launch claim stay in the gate and its ledger.
- `secret-store.ts`: the gate's `SecretStore` over `EncryptedStore` (Electron safeStorage, Keychain-held key), one file
  per account. No plaintext fallback: with no keychain a session is not issued.
- `gate-factory.ts`: `createWorkGateService` fills every port main owns (T3 client, sessions, secrets, socket path of at
  most 100 bytes in a per-account directory). The composition supplies the device-service id, the platform client and the
  owner-event source.
- `mount.ts`: the lifecycle above.

## The Matrix composition (`electron/matrix/main-work.ts`, `work-lifecycle.ts`)

The installed app is the Matrix composition. It builds the app-wide Work objects once (`WorkHost`, `WorkSession`,
`WorkMount`, `WorkSurface`, the window's IPC) and binds them to the signed-in account through `MatrixWorkLifecycle`.

| Event | What runs |
|---|---|
| Window `ready` (`publish`) | `work.activate()`: the account is the Matrix account's scope + the owner principal + this Mac's device-service id (none of them yet: no Work entry). `prepare` checks the build has `work-runtime/t3` and `matrix-work-preload.js`, and the model proxy is up; otherwise nothing is drawn. Then `surface.attach(parts)` and `mount.setSurface('on')` (the local gate: the platform declares no `work` surface id yet) |
| A different account or generation | the old one is retired first (page detached, then `mount.retire`), then the new one bound |
| Sign-out, session ended | `retireWork()` before `account.signOut` / `stopSdk`: page detached, gate cutoff and stops settled while the server runs, server stopped, partition cleared, auth reset. Bounded at 60 s; never throws |
| Quit | `work.quit()`: gate closed without a cutoff, server stopped |
| Settings › This Mac | one row: **Work on this Mac** (`setWork` → `mount.workOff()` / `workOn()`); the per-Mac **Assistants can start work here** row beside it when the Mac has the route |

Model path. Work's Hermes gateways present a key minted in `main-work.ts` to the Matrix managed-model loopback
(`managed-model.ts`; role `work`, listed through `work.modelKeys()` in its `keys()`), which adds the person's domain
bearer; the gateway holds and settles Protons. The retired desktop proxy and broker are not in the Matrix bundle (its
build refuses `electron/atum-messaging/`). The balance read is the proxy's free probe (`out_of_protons` is "empty").
"Add Protons" inside the view, and the title-bar button, open `${resource}/payments/protons`.

`restartWhenIdle` restarts the session server only when the owner's own threads are all at rest
(`WorkGate.ownerRunsIdle`, read through main's owner session); the page's view closes for the restart
(`WorkSurface.suspend`) and returns after it.

## Open

- Stop reports (`StopReport`) stay queued in the gate ledger because the platform has no settlement operation yet;
  `state().gate.undeliveredReports` counts them. Contract amendment needed: `work.mac.settlements`
  (see the lane G report).
- The release build must bundle `electron/work/sidecar/preload.ts` as `matrix-work-preload.js` (private
  `build-matrix-candidate.mjs`) and pass `ATUM_WORK_ARCHIVE` to `matrix-after-pack.mjs`; without either, Work is not drawn.
- The Work billing join (`work/billing.sqlite`) belonged to the retired proxy; Matrix meters each call at the gateway.
