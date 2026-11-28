# The agent's Screen (side panel)

Workstream C, step S4 of the agent-browser plan (2026-11-28): the owner watches the agent's own cloud browser in the side panel and takes over for a sign-in, a code or a CAPTCHA. Owner decisions: D2 one explicit "Hand back and continue"; D3 owner only; D4 the agent's cloud browser in cloud and relay mode alike.

## What a person sees

- A **Screen** tab beside the agent's own tab in its chat's side panel. It opens:
  - by itself on the run's first browser or computer-use step (`browser_*`, `computer_use`), once per run. It does not open at compact width, where it would cover the chat.
  - from **Watch** on the agent's working line. Watch now shows while the chat's info card is open, and switches the panel to the Screen.
- One bar: a quiet chip, one action and Reconnect.
  - Watching: "Luna is using the screen" and **Take over**.
  - In control: "You're in control" and **Hand back and continue**. The screen wears an ink ring, not a colour (STYLE.md §3).
  - Handing back: "Handing back…" until the server confirms.
  - Control held by another window or left over from before: **Hand back (force)** beside Take over.
- One muted line under the screen. It names the browser ("Luna's browser in the cloud") so the owner knows it is not this Mac's.
- Other states use kit patterns: waiting for the agent to start browsing, owner only, unavailable, and stream lost with Reconnect.
- Copy is in five locales in `shared/matrix-agent-screen-copy.ts`, so the phone (S5) can reuse it. The copy is covered by the renderer brand gate (`src/i18n/brand-copy.test.ts`).
- Deviation from the brief's literal chip text: the chip names the agent ("Luna is using the screen") instead of "Agent is using the screen". The roster also names agents, never "Agent".

## How it works

| File | Role |
| --- | --- |
| `src/matrix/agent-screen/transport.ts` | **The one transport seam.** `AgentScreenTransport` has four calls: `status`, `observe` (single-use stream grant plus viewer id), `acquire` (expected epoch) and `release` (viewer, or `force`). It also holds a typed in-memory mock. The real transport is `window.atumMatrix.agentScreen`. Without one, the tab and Watch stay hidden. |
| `src/matrix/agent-screen/connection.ts` | A pure reducer for connection and control state. It is grafted from upstream's pane lifecycle and tested. |
| `src/matrix/agent-screen/pane.tsx` (+ `pane.css`) | The viewer, using noVNC on its own WebSocket and Atum Kit only. |
| `src/matrix/agent-screen/auto-open.ts` | The auto-open rule. It uses the same tool names that `matrixHermesProgressEvent` emits and that the activity projection carries. |
| `src/matrix/agent-screen/continue.ts` | The continuation atom. The chat on screen sends the message through its composer's own `send` path, so it arrives as an ordinary new owner turn. |

Rules kept from upstream:
- The server owns the lease. `viewOnly` only shapes the UI; the native RFB filter drops input from anyone who does not hold the lease.
- A close with code 4000 (`control-taken`) re-attaches in watch mode. Three rapid evictions turn into an error with Reconnect.
- A dropped link keeps the lease and the viewer id, and reconnecting presents the same id again.
- Closing the tab sends a clean close, which the native bridge treats as a hand back.
- Paste reaches the screen only while in control, and only up to 256 KiB.

Once-only "carry on" (D2):
- The message is sent only when `release` returns `released: true`. Only the server can say that, and only for the call that actually ended this owner's control.
- Force, closing the tab, eviction and reconnect never write a message.
- A per-epoch guard and a disabled button stop a second send from this window. Deduplication across devices relies on `released` being server-authoritative.

## Pending workstream B (mocked)

The atum-platform worktree `feat/agent-browser-contract` was still empty (`986a49833`, no session log) when this was built. These parts follow the plan's S2 description and need checking against B's contract:

- The field names in `transport.ts`: `viewerId`, `streamUrl`, `expiresAt`, lease `{holder, epoch, viewerHash}`, `released`, and the refusal reasons.
- The preload or main bridge that implements `window.atumMatrix.agentScreen` over the controller endpoint and the hub's `/v1/display` route (S3). No such bridge exists yet, so the feature ships hidden.
- Auto-open for **cloud** turns. Tool names reach the renderer only for Mac-run turns today (`hermesActivity` / `agentTurns[].activity`). A cloud turn's progress notice carries a category, not the tool name. Until the controller projects the cloud run's tool names (or `display.status` running) to the window, cloud agents open the Screen through Watch.

## Licences

- The viewer is adapted from Hermes Desktop's `screen-pane.tsx` and `screen-connection.ts` (NousResearch/hermes-agent `266360dd`, MIT, Copyright (c) 2026 Nous Research). The full notice is in `third-party/licenses/app/hermes-desktop-bot-screen-LICENSE.txt`, with a `base.includes` entry in `third-party/app-components.json`.
- `@novnc/novnc` 1.7.0 is MPL-2.0. It is an unmodified, pinned production dependency, bundled as a lazy chunk. The notice generator copies its `LICENSE.txt`, and the MPL text is in `texts/MPL-2.0.txt`.
- The written notice now names the exact Source Code Form of every MPL-covered npm package: the lockfile's published archive and the repository. For noVNC that is `https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz` and `https://github.com/novnc/noVNC`, from `npmSourceOffer` in `scripts/third-party-notices.mjs`.

## Verification (2026-11-28)

- `npm run typecheck`, and lint with zero errors.
- `npm run build`: noVNC lands in its own `rfb-*.js` chunk.
- Focused tests:
  - `src/matrix/agent-screen/*.test.ts(x)`: reducer, auto-open, pane and the workbench tab.
  - `shared/matrix-agent-screen-copy.test.ts`
  - `src/i18n/brand-copy.test.ts`
  - `scripts/third-party-notices.test.mjs`
  - `scripts/atum-branding.test.mjs`
  - Neighbouring suites: workbench, agent desk and app.
- Screenshots: `node scripts/agent-screen-shots.mjs <dev-url> <out> [chromium]` drives the playground with `?scenario=chat&desk=working&screen=slow`. It captures watch, control, handing back and after hand back, in light and dark.
- Known, pre-existing: the dev playground fails to boot on `main`. `shared/browser/policy.ts` imports `node:net`, which Vite dev externalizes and throws on at module load. The shots ran with a throwaway config that aliased `node:net` to a small shim. That config was not committed.
