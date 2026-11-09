import type { MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import { percentToZoomLevel } from '../zoom'

export function requireMatrixDisplayIdentity(expected: MatrixIdentity, actual: MatrixIdentity | null | undefined) {
  if (!actual || expected.userId !== actual.userId || expected.deviceId !== actual.deviceId) {
    throw new Error('matrix_display_preference_stale')
  }
}

/** Native zoom is cosmetic and account-scoped; sign-out resets it. */
export function applyMatrixDisplayZoom(
  contents: { getZoomFactor(): number; setZoomLevel(level: number): void },
  snapshot: MatrixSnapshot
) {
  const value = snapshot.identity ? snapshot.displayPreferences?.textSize.value : undefined
  const percent = value === 90 || value === 110 ? value : 100
  const factor = percent / 100

  if (Math.abs(contents.getZoomFactor() - factor) > 0.0001) {
    contents.setZoomLevel(percentToZoomLevel(percent))
  }
}
