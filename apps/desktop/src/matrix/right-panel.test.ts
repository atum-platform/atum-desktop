import { afterEach, describe, expect, it } from 'vitest'

import { $matrixRightPanel, MATRIX_RIGHT_PANEL_DEFAULTS, setMatrixRightPanel } from './right-panel'

afterEach(() => {
  window.localStorage.clear()
  $matrixRightPanel.set({ ...MATRIX_RIGHT_PANEL_DEFAULTS })
})

describe('each screen’s right panel (layout r2 §2)', () => {
  it('opens by default where the neutral panel helps, and stays closed where the main area wants the width', () => {
    expect(MATRIX_RIGHT_PANEL_DEFAULTS.chat).toBe(true)
    expect(MATRIX_RIGHT_PANEL_DEFAULTS.workplace).toBe(true)
    expect(MATRIX_RIGHT_PANEL_DEFAULTS.discover).toBe(false)
    expect(MATRIX_RIGHT_PANEL_DEFAULTS.drive).toBe(false)
  })

  it('remembers each screen on its own, on this Mac', () => {
    setMatrixRightPanel('drive', true)
    setMatrixRightPanel('chat', false)

    expect($matrixRightPanel.get()).toEqual({ chat: false, workplace: true, discover: false, drive: true })
    expect(JSON.parse(window.localStorage.getItem('io.atum.rightPanel') ?? '{}')).toEqual($matrixRightPanel.get())
  })
})
