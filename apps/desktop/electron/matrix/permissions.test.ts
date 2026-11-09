import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PERMISSIONS_IPC } from '../../shared/matrix-permissions'

import { requireMatrixCaller } from './ipc-policy'
import { MATRIX_PERMISSION_SETTINGS_URLS, registerMatrixPermissions } from './permissions'

type Handler = (event: object, ...args: unknown[]) => unknown

function setup(overrides: Partial<Parameters<typeof registerMatrixPermissions>[1]> = {}) {
  const handlers = new Map<string, Handler>()

  const deps = {
    assertTrusted: vi.fn(),
    platform: 'darwin' as NodeJS.Platform,
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn((type: 'screen' | 'microphone') => (type === 'screen' ? 'granted' : 'not-determined')),
    getFullDiskAccessStatus: vi.fn(() => 'granted' as const),
    getLocationAccessStatus: vi.fn(() => 'not-determined' as const),
    openExternal: vi.fn(async (_url: string) => undefined),
    relaunch: vi.fn(),
    ...overrides
  }

  const ipc = { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) }

  registerMatrixPermissions(ipc, deps)

  return { deps, handlers }
}

const event = {}

function handler(handlers: Map<string, Handler>, channel: string) {
  const registered = handlers.get(channel)

  if (!registered) {
    throw new Error('missing handler')
  }

  return registered
}

describe('Matrix permission IPC', () => {
  it('uses passive independent probes and preserves manual-only permissions', () => {
    const { deps, handlers } = setup({
      isTrustedAccessibilityClient: vi.fn(() => false),
      getMediaAccessStatus: vi.fn(type => (type === 'screen' ? 'denied' : 'restricted'))
    })

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toEqual({
      platform: 'macos',
      permissions: {
        accessibility: 'not-granted',
        screen: 'denied',
        microphone: 'restricted',
        automation: 'manual-check',
        files: 'manual-check',
        fullDisk: 'granted',
        location: 'not-determined'
      }
    })
    expect(deps.isTrustedAccessibilityClient).toHaveBeenCalledWith(false)
    expect(deps.getMediaAccessStatus).toHaveBeenCalledWith('screen')
    expect(deps.getMediaAccessStatus).toHaveBeenCalledWith('microphone')
    expect(deps.getFullDiskAccessStatus).toHaveBeenCalledOnce()
    expect(deps.getLocationAccessStatus).toHaveBeenCalledOnce()
  })

  it('contains Full Disk Access and location probe failures independently', () => {
    const { handlers } = setup({
      getFullDiskAccessStatus: vi.fn(() => {
        throw new Error('private full-disk detail')
      }),
      getLocationAccessStatus: vi.fn(() => 'denied' as const)
    })

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toMatchObject({
      permissions: { fullDisk: 'unknown', location: 'denied', accessibility: 'granted' }
    })
  })

  it('contains individual probe failures and unknown status values', () => {
    const { handlers } = setup({
      isTrustedAccessibilityClient: vi.fn(() => {
        throw new Error('private accessibility error')
      }),
      getMediaAccessStatus: vi.fn(type => {
        if (type === 'screen') {
          throw new Error('private screen error')
        }

        return 'surprise'
      })
    })

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toMatchObject({
      platform: 'macos',
      permissions: { accessibility: 'unknown', screen: 'unknown', microphone: 'unknown' }
    })
  })

  it.each(['accessibility', 'screen', 'microphone'])('keeps the other probe facts when %s fails', failed => {
    const { handlers } = setup({
      isTrustedAccessibilityClient: vi.fn(() => {
        if (failed === 'accessibility') {
          throw new Error('probe failed')
        }

        return true
      }),
      getMediaAccessStatus: vi.fn(type => {
        if (failed === type) {
          throw new Error('probe failed')
        }

        return 'granted'
      })
    })

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toMatchObject({
      permissions: Object.fromEntries(
        ['accessibility', 'screen', 'microphone'].map(key => [key, key === failed ? 'unknown' : 'granted'])
      )
    })
  })

  it('uses the primary UI guard to reject SDK, page, guest and navigated frames', async () => {
    const url = 'atum-matrix://ui/matrix.html'
    const ui = { mainFrame: { url } }

    const { deps, handlers } = setup({
      assertTrusted: current => requireMatrixCaller(current, ui, url)
    })

    const foreign = { mainFrame: { url: 'atum-matrix://sdk/matrix-sdk.html' } }

    const rejected = [
      { sender: foreign, senderFrame: foreign.mainFrame },
      { sender: ui, senderFrame: { url } },
      { sender: {}, senderFrame: ui.mainFrame }
    ]

    for (const current of rejected) {
      expect(() => handler(handlers, MATRIX_PERMISSIONS_IPC.status)(current)).toThrow('matrix_ipc_denied')
      await expect(handler(handlers, MATRIX_PERMISSIONS_IPC.settings)(current, 'screen')).rejects.toThrow(
        'matrix_ipc_denied'
      )
    }

    ui.mainFrame.url = 'atum-matrix://pages/matrix-pages.html'
    expect(() => handler(handlers, MATRIX_PERMISSIONS_IPC.status)({ sender: ui, senderFrame: ui.mainFrame })).toThrow(
      'matrix_ipc_denied'
    )
    expect(deps.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('rejects status arguments before probing', () => {
    const { deps, handlers } = setup()

    expect(() => handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event, 'extra')).toThrow(
      'matrix_permissions_invalid_request'
    )
    expect(deps.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled()
  })

  it('relaunches only from the trusted Mac UI with no renderer arguments', () => {
    const { deps, handlers } = setup()

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.relaunch)(event)).toBeUndefined()
    expect(deps.relaunch).toHaveBeenCalledOnce()
    expect(() => handler(handlers, MATRIX_PERMISSIONS_IPC.relaunch)(event, 'extra')).toThrow(
      'matrix_permissions_invalid_request'
    )
  })

  it('does not invoke Mac APIs or settings on unsupported platforms', async () => {
    const { deps, handlers } = setup({ platform: 'linux' })

    expect(handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toEqual({
      platform: 'unsupported',
      permissions: {
        accessibility: 'unknown',
        screen: 'unknown',
        microphone: 'unknown',
        automation: 'unknown',
        files: 'unknown',
        fullDisk: 'unknown',
        location: 'unknown'
      }
    })
    expect(deps.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled()
    expect(deps.getFullDiskAccessStatus).not.toHaveBeenCalled()
    await expect(handler(handlers, MATRIX_PERMISSIONS_IPC.settings)(event, 'screen')).rejects.toThrow(
      'matrix_permissions_unsupported'
    )
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('rejects untrusted callers before probes or settings', async () => {
    const { deps, handlers } = setup({
      assertTrusted: vi.fn(() => {
        throw new Error('matrix_ipc_denied')
      })
    })

    expect(() => handler(handlers, MATRIX_PERMISSIONS_IPC.status)(event)).toThrow('matrix_ipc_denied')
    await expect(handler(handlers, MATRIX_PERMISSIONS_IPC.settings)(event, 'screen')).rejects.toThrow(
      'matrix_ipc_denied'
    )
    expect(deps.isTrustedAccessibilityClient).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('opens only fixed known settings URLs and rechecks trust after every await', async () => {
    const assertTrusted = vi.fn()
    const { deps, handlers } = setup({ assertTrusted })
    const open = handler(handlers, MATRIX_PERMISSIONS_IPC.settings)

    for (const permission of Object.keys(MATRIX_PERMISSION_SETTINGS_URLS)) {
      await expect(open(event, permission)).resolves.toBeUndefined()
    }

    expect(vi.mocked(deps.openExternal).mock.calls.map(([url]) => url)).toEqual(
      Object.values(MATRIX_PERMISSION_SETTINGS_URLS)
    )
    expect(assertTrusted).toHaveBeenCalledTimes(Object.keys(MATRIX_PERMISSION_SETTINGS_URLS).length * 2)
  })

  it('rejects extra or prototype-shaped settings arguments without opening a URL', async () => {
    const { deps, handlers } = setup()
    const open = handler(handlers, MATRIX_PERMISSIONS_IPC.settings)

    for (const input of [
      '__proto__',
      'constructor',
      'full-disk',
      'https://untrusted.example/pane',
      { toString: () => 'screen' },
      'screen'
    ]) {
      const args = input === 'screen' ? [input, 'extra'] : [input]
      await expect(open(event, ...args)).rejects.toThrow('matrix_permissions_invalid_request')
    }

    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('redacts external-open failures', async () => {
    const { handlers } = setup({
      openExternal: vi.fn(async () => {
        throw new Error('private operating system detail')
      })
    })

    await expect(handler(handlers, MATRIX_PERMISSIONS_IPC.settings)(event, 'microphone')).rejects.toThrow(
      'matrix_permissions_open_failed'
    )
  })

  it('rejects a pane result after the trusted document changes while opening', async () => {
    let resolve!: () => void

    const pending = new Promise<void>(done => {
      resolve = done
    })

    const url = 'atum-matrix://ui/matrix.html'
    const ui = { mainFrame: { url } }

    const { handlers } = setup({
      assertTrusted: current => requireMatrixCaller(current, ui, url),
      openExternal: () => pending
    })

    const result = handler(handlers, MATRIX_PERMISSIONS_IPC.settings)(
      { sender: ui, senderFrame: ui.mainFrame },
      'files'
    )

    ui.mainFrame.url = 'https://untrusted.example/'
    resolve()
    await expect(result).rejects.toThrow('matrix_ipc_denied')
  })
})
