import { afterEach, describe, expect, it } from 'vitest'

import { atumAppSurfaceClient, isAppSurfaceFailure } from './atum-app-surfaces'

afterEach(() => {
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('app surface renderer client', () => {
  it('falls back to a stable failure when the desktop bridge is unavailable', async () => {
    const result = await atumAppSurfaceClient().routes('moon')

    expect(isAppSurfaceFailure(result)).toBe(true)
    expect(result).toEqual({ error: 'app_surface_unavailable' })
  })
})
