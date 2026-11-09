import { describe, expect, it, vi } from 'vitest'

import { switchAnsweringToCloud } from './answering-switch'
import { DeviceRegistryError } from './device/enrollment'

describe('the answering switch at the end of a home move', () => {
  it('does not call the legacy switch for an agent with a saved policy, and reports success', async () => {
    const switchAnswering = vi.fn(async () => ({}))
    await expect(switchAnsweringToCloud({ savedPolicy: true, switchAnswering })).resolves.toBe('follows_policy')
    expect(switchAnswering).not.toHaveBeenCalled()
  })

  it('switches an agent without a saved policy', async () => {
    const switchAnswering = vi.fn(async () => ({}))
    await expect(switchAnsweringToCloud({ savedPolicy: false, switchAnswering })).resolves.toBe('switched')
    expect(switchAnswering).toHaveBeenCalledTimes(1)
  })

  it('reads the platform refusing a policy agent as the policy deciding, not as a failure', async () => {
    const switchAnswering = vi.fn(async () => {
      throw new DeviceRegistryError(403, 'upgrade_required')
    })

    await expect(switchAnsweringToCloud({ savedPolicy: false, switchAnswering })).resolves.toBe('follows_policy')
  })

  it.each([
    new DeviceRegistryError(409, 'answering_conflict'),
    new DeviceRegistryError(0),
    new DeviceRegistryError(403),
    new Error('matrix_s1_authentication')
  ])('still fails the move for any other refusal or outage (%s)', async error => {
    const switchAnswering = vi.fn(async () => {
      throw error
    })

    await expect(switchAnsweringToCloud({ savedPolicy: false, switchAnswering })).rejects.toBe(error)
  })
})
