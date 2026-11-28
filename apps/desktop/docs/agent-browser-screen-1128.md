# The agent's Screen

The owner can watch the agent's cloud browser from its private chat and take over for a sign-in, code or CAPTCHA. Screen and Watch appear after the authenticated controller returns a valid status for that owner and agent. The same Screen follows the agent in cloud and relay mode. At compact widths the panel opens only from Watch.

## Desktop and controller

The bridge follows the owner-screen wire contract in cloud-execution/2.3. Its fixtures in `electron/matrix/__fixtures__/agent-screen` come from that pack, with hexadecimal UUID placeholders suitable for the public fixture guard.

| Desktop action | Controller request |
| --- | --- |
| Check the Screen | `status` with the owner and agent principals and the current `sessionId` when available |
| Watch | `open` with `mode: "watch"` |
| Take over | `open` with `mode: "control"`, the watch `sessionId` and `expectedControlRevision` |
| Connect | `redeem` with the new single-use `ticket`, then binary RFB |
| Hand back | `release` with the same session and expected revision |
| Hand back and continue | `handback` with those fields plus `askEventId` |
| Hand back (force) | `force_release` with the latest revision |

`electron/matrix/main.ts` verifies the IPC sender, checks the selected owner/agent room and uses the owner's native Matrix/MAS device grant from `MatrixAccount.sdkConfiguration()`. It takes the owner principal from `readDomain(false)`. `electron/matrix/agent-screen.ts` sends the token in the first JSON frame on each WebSocket to the configured device hub's `/v1/display` route. Redeeming checks the bound owner, agent, Matrix device and ticket expiry. The hub and controller enforce the computer and private room binding. The preload passes ticket metadata and binary RFB to noVNC through IPC. The Matrix token stays in Electron main. The Electron composite typecheck includes the shared wire types, raw channel, adapter and JSON fixtures.

A control response supplies a fresh ticket. Input turns on after noVNC connects to that control stream and the server confirms the session owns the lease. Revision zero is valid. A dropped link reconnects with the same session. If the controller retires the session, desktop confirms owner access again and starts in watch mode. Close code 4000 returns to watch. A rapid eviction loop stops at Reconnect. Close code 4401 is a refused redemption. The control operations preserve the wire refusals `forbidden`, `stale_revision`, `invalid_request` and `unavailable`.

## Handback and cloud auto-open

The desktop uses the current exchange's visible agent message or waiting line as the ask. If it has no qualifying event, it offers Hand back. If the server refuses a stale ask event, the owner can still choose Hand back. App close, tab close, ordinary release and force release produce no continuation.

A confirmed handback returns `released: true` and a continuation bound to the same ask and private room. Main rechecks the room and sends the visible continuation through the owner's Matrix SDK on the same device, using the returned transaction ID. If a response is lost or the Matrix send fails, retrying the button reuses the original session, revision and ask. The controller returns its journaled receipt and the SDK reuses the Matrix transaction.

The window probes `status` when an eligible chat opens and polls every three seconds while that chat's agent works, until it observes `running: true`. It uses the existing typing, in-flight turn and live progress-line signals to tell when to poll. A positive status opens the panel once per observed run when space allows. Native Hermes tool names still serve as a trigger when present. The cloud status is display-level, so an already-running screen can also open during a later busy turn. No tool names are added to cloud progress notices.

## Licences

- The viewer is adapted from Hermes Desktop's `screen-pane.tsx` and `screen-connection.ts` (NousResearch/hermes-agent `266360dd`, MIT, Copyright (c) 2026 Nous Research). The full notice is in `third-party/licenses/app/hermes-desktop-bot-screen-LICENSE.txt`, with a `base.includes` entry in `third-party/app-components.json`.
- `@novnc/novnc` 1.7.0 is MPL-2.0. It is an unmodified, pinned production dependency, bundled as a lazy chunk with the raw channel and viewer methods declared in `src/novnc.d.ts`. The notice generator copies its `LICENSE.txt`, and the MPL text is in `texts/MPL-2.0.txt`.
- The written notice now names the exact Source Code Form of every MPL-covered npm package: the lockfile's published archive and the repository. For noVNC that is `https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz` and `https://github.com/novnc/noVNC`, from `npmSourceOffer` in `scripts/third-party-notices.mjs`.

## Local verification

- Controller and transport tests cover exact fixture frames, native credential selection, controller refusal mapping, same-device single-use redemption, typed RFB stream routing, confirmed handback and Matrix transaction reuse.
- Screen tests cover connected-control input, loss and eviction, ordinary and force release, handback retry, feature availability and cloud auto-open without native tool names.
- Desktop typecheck, lint with zero errors, brand tests and the public-repository guard are the local gates. An opted-in live controller and browser remain the rollout verification.
