import { describe, expect, it } from 'vitest'

import { BUNDLED_GIGI } from './bundled-gigi'

describe('the bundled companion geometry', () => {
  it('stands on the baseline her idle pose paints to: the foot line is the idle bounds bottom', () => {
    const idle = BUNDLED_GIGI.bounds!.idle!

    expect(BUNDLED_GIGI.anchor!.footY).toBe(idle.y + idle.height)
    // Inside the frame, with transparent padding below the paws (the stage aligns the paws, not the frame).
    expect(BUNDLED_GIGI.anchor!.footY).toBeLessThan(BUNDLED_GIGI.frameH!)
  })

  it('gives every pose in the atlas painted bounds inside the frame', () => {
    for (const row of BUNDLED_GIGI.stateRows!) {
      const box = BUNDLED_GIGI.bounds![row]

      expect(box, row).toBeDefined()
      expect(box!.x + box!.width).toBeLessThanOrEqual(BUNDLED_GIGI.frameW!)
      expect(box!.y + box!.height).toBeLessThanOrEqual(BUNDLED_GIGI.frameH!)
    }
  })
})
