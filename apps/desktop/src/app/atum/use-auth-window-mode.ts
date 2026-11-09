import { useEffect } from 'react'

/**
 * Renderer half of the reversible window-mode contract (electron/atum-window-mode.ts).
 *
 * Mounted by `AtumAuthView`, which the shell renders instead of the product UI
 * for every gated account state. So the lifecycle is exactly:
 *
 *   loading            → auth view not mounted (startup owns the window); the
 *                        window keeps its normal geometry throughout boot.
 *   signed_out         → mount → 'auth'  → compact, centered credential window.
 *   signing_in         → still mounted   → stays compact (no resize thrash).
 *   error / expired    → still mounted   → stays compact; copy changes only.
 *   signed_in restored → unmount         → 'normal' → prior bounds + maximized
 *                        state come back, and the compact size is never
 *                        persisted as the user's window geometry.
 *
 * Every branch is best-effort: an older preload, a secondary window, or a
 * non-Electron test host has no bridge (or is rejected by the main process),
 * and the gate simply renders at whatever size the window already is. Sign-in
 * must never depend on a chrome nicety succeeding.
 */
export function useAuthWindowMode(): void {
  useEffect(() => {
    const bridge = window.hermesDesktop?.atumWindow

    if (!bridge) {
      return
    }

    void bridge.setMode('auth').catch(() => undefined)

    return () => {
      void bridge.setMode('normal').catch(() => undefined)
    }
  }, [])
}
