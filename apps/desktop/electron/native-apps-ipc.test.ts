import { describe, expect, it, vi } from 'vitest'

import { NATIVE_APPS_CHANNELS } from '../shared/skills-launcher'

import type { NativeOpenDocumentWindowCandidate } from './native-app-window'
import { registerNativeAppsIpc } from './native-apps-ipc'

const event = { sender: { id: 1 } } as never
const otherEvent = { sender: { id: 2 } } as never

function setup() {
  let authority = 'account-a:1'
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const controller = { launch: vi.fn(async request => ({ id: request.requestId })), end: vi.fn(async () => undefined) }

  const inventory = {
    list: vi.fn(async refresh => [{ id: refresh ? 'fresh' : 'cached' }])
  }

  const openDocumentWindows = {
    list: vi.fn(async () => [{
      app: { id: 'native-app:excel', name: 'Excel', bundleId: 'com.microsoft.Excel' },
      title: 'Forecast', hasSavedFile: true,
      identity: { appPath: '/Applications/Microsoft Excel.app', bundleId: 'com.microsoft.Excel' as const,
        processId: 41, windowId: 77, documentPath: '/documents/forecast.xlsx' }
    }]),
    resolve: vi.fn(async (candidate: NativeOpenDocumentWindowCandidate) => candidate.identity.documentPath ?? null)
  }

  const deps = {
    assertTrusted: vi.fn(), authority: () => authority,
    chooseFile: vi.fn(async () => '/documents/selection.docx'),
    openArrangementSettings: vi.fn(async () => undefined),
    authorizePath: vi.fn(value => `authorized:${value}`),
    openDocumentWindows
  }

  registerNativeAppsIpc(
    { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) } as never,
    controller as never,
    inventory as never,
    deps
  )

  return { handlers, controller, inventory, deps, openDocumentWindows, changeAuthority: () => {authority = 'account-b:2'} }
}

describe('native app IPC', () => {
  it('refuses untrusted senders before every operation', async () => {
    const s = setup()
    s.deps.assertTrusted.mockImplementation(() => {throw new Error('untrusted_sender')})
    const launch = s.handlers.get(NATIVE_APPS_CHANNELS.launch)!

    await expect(launch(event, { appId: 'native-app:test' })).rejects.toThrow('untrusted_sender')
    expect(s.controller.launch).not.toHaveBeenCalled()
  })

  it('checks trust and authority again after an async launch', async () => {
    const s = setup()
    const launch = s.handlers.get(NATIVE_APPS_CHANNELS.launch)!
    s.controller.launch.mockImplementation(async () => {
      s.changeAuthority()

      return { id: 'launch' }
    })

    await expect(launch(event, { appId: 'native-app:test' })).rejects.toThrow('NATIVE_APP_CANCELLED')
    expect(s.deps.assertTrusted).toHaveBeenCalledTimes(2)
  })

  it('only permits known picker kinds and confines picked files before returning them', async () => {
    const s = setup()
    const chooseFile = s.handlers.get(NATIVE_APPS_CHANNELS.chooseFile)!

    await expect(chooseFile(event, 'shell')).rejects.toThrow('NATIVE_APP_INVALID_REQUEST')
    expect(s.deps.chooseFile).not.toHaveBeenCalled()

    await expect(chooseFile(event, 'word')).resolves.toBe('authorized:/documents/selection.docx')
    expect(s.deps.chooseFile).toHaveBeenCalledWith('word')
    expect(s.deps.authorizePath).toHaveBeenCalledWith('/documents/selection.docx')
    await expect(chooseFile(event, 'pdf')).rejects.toThrow('NATIVE_APP_INVALID_REQUEST')
    await expect(chooseFile(event, 'excel')).rejects.toThrow('NATIVE_APP_INVALID_DOCUMENT')
  })

  it('returns opaque Excel/PowerPoint candidates and resolves a re-proven saved file only for its owner', async () => {
    const s = setup()
    const list = s.handlers.get(NATIVE_APPS_CHANNELS.listOpenDocumentWindows)!
    const resolve = s.handlers.get(NATIVE_APPS_CHANNELS.resolveOpenDocumentWindow)!
    const result = await list(event) as { windows: Array<{ id: string; app: { bundleId: string }; title: string; hasSavedFile: boolean }> }

    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({ app: { bundleId: 'com.microsoft.Excel' }, title: 'Forecast', hasSavedFile: true })
    expect(JSON.stringify(result)).not.toContain('/documents/forecast.xlsx')

    await expect(resolve(otherEvent, result.windows[0]!.id)).resolves.toBeNull()
    await expect(resolve(event, result.windows[0]!.id)).resolves.toBe('authorized:/documents/forecast.xlsx')
    expect(s.openDocumentWindows.resolve).toHaveBeenCalledWith(expect.objectContaining({ identity: expect.objectContaining({ windowId: 77 }) }))
    expect(s.deps.authorizePath).toHaveBeenCalledWith('/documents/forecast.xlsx')
  })

  it('invalidates a prior document candidate on refresh and returns native permission state without prompting', async () => {
    const s = setup()
    const list = s.handlers.get(NATIVE_APPS_CHANNELS.listOpenDocumentWindows)!
    const resolve = s.handlers.get(NATIVE_APPS_CHANNELS.resolveOpenDocumentWindow)!
    const first = await list(event) as { windows: Array<{ id: string }> }
    const second = await list(event) as { windows: Array<{ id: string }> }

    await expect(resolve(event, first.windows[0]!.id)).resolves.toBeNull()
    await expect(resolve(event, second.windows[0]!.id)).resolves.toBe('authorized:/documents/forecast.xlsx')

    s.openDocumentWindows.list.mockRejectedValueOnce(new Error('permission'))
    await expect(list(event)).resolves.toEqual({ windows: [], reason: 'permission' })
  })
})
