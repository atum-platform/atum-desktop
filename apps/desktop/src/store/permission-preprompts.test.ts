import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $atumPermissionPrompt,
  armNotificationPermissionPrompt,
  requestFileAccessPrePrompt,
  requestNotificationPrePrompt,
  resolveAtumPermissionPrompt,
  setAtumPermissionSequenceActive
} from './permission-preprompts'

beforeEach(() => {
  window.localStorage.clear()
  $atumPermissionPrompt.set(null)
  setAtumPermissionSequenceActive(true)
})

describe('permission pre-prompts', () => {
  it('requires presenter arming and calls the OS request only after confirmation', () => {
    const requestOsPermission = vi.fn()
    expect(requestNotificationPrePrompt(requestOsPermission)).toBe('blocked')
    expect(requestOsPermission).not.toHaveBeenCalled()

    armNotificationPermissionPrompt()
    expect(requestNotificationPrePrompt(requestOsPermission)).toBe('shown')
    expect(requestOsPermission).not.toHaveBeenCalled()
    resolveAtumPermissionPrompt(true)
    expect(requestOsPermission).toHaveBeenCalledOnce()
  })

  it('defers a protected-folder request until Continue', () => {
    const requestTcc = vi.fn()
    expect(requestFileAccessPrePrompt('Documents', requestTcc)).toBe(true)
    expect(requestTcc).not.toHaveBeenCalled()
    resolveAtumPermissionPrompt(false)
    expect(requestTcc).not.toHaveBeenCalled()
  })
})
