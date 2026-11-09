import { describe, expect, it, vi } from 'vitest'

import { createMatrixPagesComputerUseScope, isMatrixComputerUseRequest } from './pages-computer-use'

type ForwardRequest = { path: string; method: string; body?: unknown }

function status(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin',
    installed: true,
    ready: true,
    accessibility: true,
    screen_recording: true,
    screen_recording_capturable: true,
    error: null,
    ...overrides
  }
}

function scope(responses: unknown[] = [], current: () => boolean = () => true) {
  const forward = vi.fn(async () => responses.shift())

  return { scope: createMatrixPagesComputerUseScope({ isCurrent: current, forward }), forward }
}

describe('native computer-use route ownership', () => {
  it('recognizes only the exact passive status route', () => {
    expect(isMatrixComputerUseRequest('/api/tools/computer-use/status')).toBe(true)
    expect(isMatrixComputerUseRequest('/api/tools/computer-use/status?profile=default')).toBe(false)
    expect(isMatrixComputerUseRequest('/api/tools/computer-use/status/')).toBe(false)
    expect(isMatrixComputerUseRequest('/api/tools/computer-use/permissions/grant')).toBe(false)
  })

  it.each([
    { path: '/api/tools/computer-use/status?profile=default' },
    { path: '/api/tools/computer-use/status', method: 'POST' },
    { path: '/api/tools/computer-use/status', body: {} },
    { path: '/api/tools/computer-use/status', body: undefined },
    { path: '/api/tools/computer-use/status', method: 'GET', profile: 'other' },
    { path: '/api/tools/computer-use/status', method: 'GET', action: 'grant' }
  ])('rejects near-miss or expanded request authority %#', async request => {
    const f = scope()

    await expect(f.scope.request(request as never)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward).not.toHaveBeenCalled()
  })

  it('forwards exactly one fixed read and projects only the frozen DTO', async () => {
    const f = scope([
      status({
        version: 'cua-driver 0.5.1',
        checks: [{ label: 'private', status: 'ok', message: 'secret path' }],
        source: { executable: '/private/cua-driver', pid: 123 },
        can_grant: true,
        config: { install: 'forbidden' }
      })
    ])

    await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toEqual({
      platform: 'darwin',
      installed: true,
      ready: true,
      accessibility: true,
      screenRecording: true,
      screenRecordingCapturable: true
    })
    expect(f.forward).toHaveBeenCalledWith({ path: '/api/tools/computer-use/status?profile=default', method: 'GET' })
  })
})

describe('native computer-use status normalization', () => {
  it('derives macOS readiness from Accessibility and Screen Recording only', async () => {
    const ready = scope([status({ ready: false })])
    const unknown = scope([status({ accessibility: null, ready: false })])
    const denied = scope([status({ screen_recording: false, ready: true })])

    await expect(ready.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({ ready: true })
    await expect(unknown.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({ ready: null })
    await expect(denied.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({ ready: false })
  })

  it('retains unknown TCC values but rejects malformed known booleans and malformed payloads', async () => {
    const unknown = scope([status({ accessibility: undefined, screen_recording: null, screen_recording_capturable: undefined })])

    await expect(unknown.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })

    for (const response of [
      null,
      {},
      { platform: 'darwin', installed: 'yes' },
      status({ accessibility: 'granted' }),
      status({ screen_recording: 1 }),
      status({ screen_recording_capturable: 'yes' }),
      status({ ready: 'ready' })
    ]) {
      const f = scope([response])
      await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow(
        'matrix_computer_use_response_invalid'
      )
    }
  })

  it('uses only strict non-macOS readiness and removes all TCC fields', async () => {
    const linux = scope([status({ platform: 'linux', ready: false, accessibility: true, screen_recording: true })])
    const unknown = scope([status({ platform: 'win32', ready: null })])

    await expect(linux.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toEqual({
      platform: 'linux',
      installed: true,
      ready: false,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })
    await expect(unknown.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({
      platform: 'win32',
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })
  })

  it('does not claim a driver, readiness, or permissions on unsupported or uninstalled sources', async () => {
    const unsupported = scope([status({ platform: 'freebsd', installed: true, ready: true })])
    const absent = scope([status({ installed: false, ready: true })])

    await expect(unsupported.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({
      platform: 'unsupported',
      installed: false,
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })
    await expect(absent.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toMatchObject({
      platform: 'darwin',
      installed: false,
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })
  })

  it('turns a failed raw probe into unknown status without exposing its diagnostics', async () => {
    const f = scope([status({ error: 'private /home/example/cua failure' })])

    await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).resolves.toEqual({
      platform: 'darwin',
      installed: true,
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    })
  })
})

describe('native computer-use scope retirement', () => {
  it('rejects before forwarding when the selected agent is already retired', async () => {
    const f = scope([status()], () => false)

    await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.forward).not.toHaveBeenCalled()
  })

  it('rejects a response that arrives after the selected agent retires', async () => {
    let current = true

    const forward = vi.fn(async () => {
      current = false

      return status()
    })

    const f = createMatrixPagesComputerUseScope({ isCurrent: () => current, forward })

    await expect(f.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(forward).toHaveBeenCalledOnce()
  })

  it('redacts transport failures to the stable unavailable error', async () => {
    const f = scope()
    f.forward.mockRejectedValueOnce(new Error('token=private path=/home/example/cua-driver'))

    await expect(f.scope.request({ path: '/api/tools/computer-use/status' })).rejects.toThrow('matrix_pages_agent_unavailable')
  })
})
