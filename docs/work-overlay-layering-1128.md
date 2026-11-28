# Work overlay layering · 2026-11-28

The account menu, rail tooltips and other shell overlays now stack above Work while it stays visible. Chat and the other rail screens use the same renderer stacking rules.

The Electron `<webview>` keeps the existing owner `WebContents` contract. An iframe would share the Matrix renderer’s session and lose the separate Work preload. The pinned Work runtime serves its UI on a verified loopback origin. Main authorizes one guest per mount with the account partition and an inert URL, supplies the sandboxed preload, installs the existing navigation and session policy, and loads the pairing grant directly in the guest. Work still checks its cookie and authenticated session, clears navigation history after pairing, and limits preload IPC to the active guest’s top-level Work origin. Matrix’s CSP stays intact.

React retains the guest in one slot across rail navigation. Going to another destination makes the section inert and invisible while the Work session stays active. Overlays leave the guest in place. Main still owns prewarm, retry, account retirement, and Work off. The renderer no longer measures a rectangle, sends show/hide IPC, or listens to overlay holds for Work. Browser/app and PDF views still need the shared overlay holds. The playground uses the same Work slot for its fixture media.

Local Electron verification used the real Matrix shell on fixture account data with the pinned Work runtime and its bundled preload. Pairing completed in the account partition, the avatar menu won the hit test over Work, and a screenshot showed both surfaces. Chat → Work retained the same guest and route. Atum’s Settings shortcut worked with shell focus, the focused guest received Tab, and Work’s Settings navigation and Back worked. The guest denied off-origin requests and popups. The Work and session suites cover startup, retry, retirement and the secure mount contract, and the renderer test covers guest continuity under an overlay hold.

PR #162 was still open against main. Remove its Work-specific native rail tooltip when assembling both changes. A signed-in production profile, file drag-and-drop, and the macOS release package are outside this local verification.

The production bundle built successfully. A separate launch with an isolated signed-out profile stalled in a macOS Keychain lookup when driven by the unpackaged Electron binary. The Work proof bypassed that login dependency with a fixture account and a fresh local sidecar profile.
