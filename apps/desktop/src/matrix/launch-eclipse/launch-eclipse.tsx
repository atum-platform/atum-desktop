import type { ReactNode } from 'react'

import { EclipseCanvas } from './eclipse-canvas'
import type { EclipseDirection, EclipsePhase } from './engine'

/** The launch direction Atum ships (see engine.ts for both). */
export const LAUNCH_ECLIPSE_DIRECTION: EclipseDirection = 'totality'

/**
 * The launch's eclipse, drawn live from the launch's own facts and carried into the chat
 * header's face. Where WebGL is missing the CSS hero (`fallback`) stands in.
 */
export function LaunchEclipse({
  brief,
  current,
  fallback,
  phase,
  reduced,
  settled
}: {
  brief: boolean
  current: number
  fallback: ReactNode
  phase: EclipsePhase
  reduced: boolean
  settled: number
}) {
  return (
    <EclipseCanvas
      direction={LAUNCH_ECLIPSE_DIRECTION}
      facts={() => ({ brief, current, phase, reduced, settled })}
      fallback={fallback}
      landOn="[data-matrix-header-mark] > *"
    />
  )
}
