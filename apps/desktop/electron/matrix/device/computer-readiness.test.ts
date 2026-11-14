import { expect, it, vi } from 'vitest'

import { createComputerReadiness } from './computer-readiness'

it('requests missing macOS permissions once and silently recovers when granted', async () => {
  let granted = false
  const request = vi.fn(async () => {})
  const explain = vi.fn(async () => {})
  const ready = createComputerReadiness({ status: async () => ({ accessibility: granted, screen_recording: granted }), request, explain })
  expect(await ready()).toContain('Accessibility')
  expect(await ready()).toContain('Accessibility')
  expect(request).toHaveBeenCalledTimes(1)
  expect(explain).toHaveBeenCalledWith(expect.any(String), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  granted = true
  expect(await ready()).toBeNull()
  expect(explain).toHaveBeenCalledTimes(1)
})
it('links directly to Screen Recording when Accessibility is ready', async () => {
  const explain = vi.fn(async () => {})
  const ready = createComputerReadiness({ status: async () => ({ accessibility: true, screen_recording: false }), request: async () => {}, explain })
  expect(await ready()).toContain('Screen Recording')
  expect(explain).toHaveBeenCalledWith(expect.any(String), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
})
