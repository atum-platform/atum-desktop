import { useLayoutEffect } from 'react'

import type { MatrixWindowMode } from '../../shared/matrix-window'

/**
 * Which window the account is in. The compact window (460 x 600) is the auth step and
 * nothing else: no account signed in here — signing in, a sign-in that failed, an account
 * that can't be opened. From the moment an account is signed in, it is the product window:
 * the launch with its eclipse, its account steps (connect, recovery) and the app (owner,
 * 2026-10-05: "I only meant the auth step, NOT the loading screen step").
 *
 * Nothing is asked of main before its first real snapshot (`settled`), and the first answer
 * goes out before that screen paints: main shows the window only once it has it
 * (electron/matrix/window-launch.ts), so the window never appears at the wrong size.
 */
export function useMatrixWindowMode({ identity, settled }: { identity: string | null; settled: boolean }): void {
  const mode: MatrixWindowMode = identity ? 'normal' : 'auth'

  useLayoutEffect(() => {
    if (settled) {
      void window.atumMatrix.setWindowMode(mode).catch(() => {})
    }
  }, [mode, settled])
}
