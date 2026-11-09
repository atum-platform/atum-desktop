import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment } from '../../shared/matrix'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import { createNativeAppInventory } from '../native-app-inventory'
import { NativeAppsController } from '../native-apps'

import { MatrixAgentRuntime } from './agent-runtime'
import { createHermesPagesTransport } from './hermes-pages-transport'
import type { MatrixHermesConnection, MatrixHermesRuntimeConfig } from './hermes-runtime'
import { type MatrixNativeAppSource, readMatrixNativeAppReadiness, registerMatrixNativeApps } from './native-apps'

const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})
const id = '00000000-0000-4000-8000-bd7662a5eeb4'

const windowOne = {
  id: 41,
  title: 'One',
  bounds: { x: 10, y: 20, width: 900, height: 700 },
  minimized: false,
  fullscreen: false
}

const skills = [{ name: 'docx', enabled: true, description: 'Read Word', category: 'productivity' }]

const support = {
  runtime: { kind: 'local', generation: 'one' },
  commands: {},
  bundled: [],
  verified_bundled: ['docx'],
  routes: { docx: { operations: { read: { state: 'ready', reasons: [] } } } }
}

async function nativeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-native-apps-'))
  temporary.push(root)
  const bundle = path.join(root, 'Word.app')
  await fs.mkdir(path.join(bundle, 'Contents'), { recursive: true })
  await fs.writeFile(
    path.join(bundle, 'Contents/Info.plist'),
    '<plist><dict><key>CFBundleIdentifier</key><string>com.microsoft.Word</string><key>CFBundleDisplayName</key><string>Word</string></dict></plist>'
  )
  const open = vi.fn((_file, _args, _options, callback) => callback(null, '', ''))

  const inventory = createNativeAppInventory({
    applicationRoots: [root],
    homeDirectory: root,
    platform: 'linux',
    execFile: open
  })

  let authority = 'human:1:room-a'
  let trusted = true

  const chat = {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getNormalBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    getMinimumSize: () => [800, 600],
    setMinimumSize: vi.fn(),
    unmaximize: vi.fn(),
    maximize: vi.fn(),
    setBounds: vi.fn(),
    show: vi.fn()
  }

  const windows = {
    list: vi.fn(async () => [windowOne]),
    arrange: vi.fn(async () => {}),
    restore: vi.fn(async () => {})
  }

  const ended = vi.fn()

  const controller = new NativeAppsController({
    inventory,
    windows,
    window: () => chat,
    authority: () => authority,
    authorizePath: () => {
      throw new Error('no_paths')
    },
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    beforeLaunch: async () => {},
    ended
  })

  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const settings = vi.fn(async () => {})
  const readiness = vi.fn(async () => ({ skills, support }))
  registerMatrixNativeApps(
    {
      handle(name, handler) {
        handlers.set(name, handler)
      }
    },
    {
      assertTrusted() {
        if (!trusted) {
          throw new Error('untrusted')
        }
      },
      authority: () => authority,
      inventory,
      controller,
      readiness,
      openSettings: settings
    }
  )
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  const [entry] = await inventory.list()

  return {
    call,
    inventory,
    entry,
    controller,
    chat,
    windows,
    open,
    ended,
    readiness,
    settings,
    bundle: await fs.realpath(bundle),
    authority(value: string) {
      authority = value
    },
    untrust() {
      trusted = false
    }
  }
}

describe('Matrix UI to actual native inventory and placement', () => {
  it('opens a discovered canonical bundle normally without asking for window access', async () => {
    const f = await nativeFixture()
    expect(await f.call(MATRIX_NATIVE_APPS.list, true)).toEqual([f.entry])
    await expect(
      f.call(MATRIX_NATIVE_APPS.launch, { appId: f.entry.id, requestId: id, mode: 'normal' })
    ).resolves.toMatchObject({ status: 'opened' })
    expect(f.open).toHaveBeenCalledWith('/usr/bin/open', ['-a', f.bundle], expect.anything(), expect.anything())
    expect(f.windows.list).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
  })
  it('permission denial preserves discovery and ordinary open, and only explicit settings asks for permission', async () => {
    const f = await nativeFixture()
    f.windows.list.mockRejectedValue(new Error('permission'))
    await expect(
      f.call(MATRIX_NATIVE_APPS.launch, { appId: f.entry.id, requestId: id, mode: 'beside' })
    ).resolves.toMatchObject({ status: 'opened', reason: 'permission' })
    expect(await f.call(MATRIX_NATIVE_APPS.list)).toEqual([f.entry])
    expect(f.chat.setBounds).not.toHaveBeenCalled()
    expect(f.settings).not.toHaveBeenCalled()
    await f.call(MATRIX_NATIVE_APPS.settings)
    expect(f.settings).toHaveBeenCalledOnce()
  })
  it('arranges and restores through the unchanged controller and opaque request id', async () => {
    const f = await nativeFixture()
    await expect(
      f.call(MATRIX_NATIVE_APPS.launch, { appId: f.entry.id, requestId: id, mode: 'beside' })
    ).resolves.toMatchObject({ status: 'beside' })
    expect(f.windows.arrange).toHaveBeenCalledOnce()
    await f.call(MATRIX_NATIVE_APPS.end, id)
    expect(f.windows.restore).toHaveBeenCalledWith(expect.objectContaining({ path: f.bundle }), windowOne)
    expect(f.chat.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 })
  })
  it.each(['documentPath', 'path', 'profile', 'command'])(
    'rejects caller-supplied %s before any OS call',
    async key => {
      const f = await nativeFixture()
      await expect(
        f.call(MATRIX_NATIVE_APPS.launch, { appId: f.entry.id, requestId: id, mode: 'normal', [key]: '/secret' })
      ).rejects.toThrow('NATIVE_APP_INVALID_REQUEST')
      expect(f.open).not.toHaveBeenCalled()
    }
  )
  it('rejects untrusted senders and signed-out callers before inventory, readiness or launch', async () => {
    const f = await nativeFixture()
    const list = vi.spyOn(f.inventory, 'list')
    f.untrust()
    await expect(f.call(MATRIX_NATIVE_APPS.list)).rejects.toThrow('untrusted')
    expect(list).not.toHaveBeenCalled()
    f.authority('')
    await expect(f.call(MATRIX_NATIVE_APPS.readiness, '!room')).rejects.toThrow('untrusted')
    expect(f.readiness).not.toHaveBeenCalled()
  })
  it('signed-out humans cannot reach native operations but may finish their prior cleanup', async () => {
    const f = await nativeFixture()
    f.authority('')
    await expect(f.call(MATRIX_NATIVE_APPS.list)).rejects.toThrow('matrix_native_apps_unavailable')
    await expect(f.call(MATRIX_NATIVE_APPS.readiness, '!room')).rejects.toThrow('matrix_native_apps_unavailable')
    await expect(f.call(MATRIX_NATIVE_APPS.end, id)).resolves.toBeUndefined()
    expect(f.readiness).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })
  it('does not project inventory fetched under a retired human', async () => {
    const f = await nativeFixture()
    let release!: (value: (typeof f.entry)[]) => void
    vi.spyOn(f.inventory, 'list').mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const pending = f.call(MATRIX_NATIVE_APPS.list)
    f.authority('human:2:room-a')
    release([f.entry])
    await expect(pending).rejects.toThrow('NATIVE_APP_CANCELLED')
  })
  it('a selected room change cancels a pending placement and restores the touched native window', async () => {
    const f = await nativeFixture()
    let release!: () => void
    f.windows.arrange.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const pending = f.call(MATRIX_NATIVE_APPS.launch, { appId: f.entry.id, requestId: id, mode: 'beside' })
    await vi.waitFor(() => expect(f.windows.arrange).toHaveBeenCalledOnce())
    f.authority('human:1:room-b')
    release()
    await expect(pending).rejects.toThrow('NATIVE_APP_CANCELLED')
    expect(f.windows.restore).toHaveBeenCalledOnce()
    expect(f.chat.setBounds).not.toHaveBeenCalled()
  })
})

function readinessFixture() {
  let authority = 'human:1:room-a'
  let room = '!agent:test'

  let runtime: MatrixHermesRuntimeConfig = {
    python: '/fixture/python',
    source: '/fixture/source',
    profiles: '/fixture/profiles'
  }

  const agent = new MatrixAgentRuntime('agent:analyst', 'analyst')

  let enrollment: MatrixEnrollment = {
    state: 'ready',
    identity: {
      issuer: 'https://issuer.test',
      subject: 'human',
      principal: 'human',
      agentPrincipal: 'analyst',
      executorId: 'executor-a',
      userId: '@analyst:test',
      deviceId: 'A',
      expiresAt: 100
    }
  }

  const pages = vi.fn(async ({ path: route }: { path: string }) =>
    route.startsWith('/api/skills?') ? skills : support
  )

  let connection = { workspace: '/owned/workspace', pages } as unknown as MatrixHermesConnection

  const source: MatrixNativeAppSource = {
    authority: () => authority,
    roomId: () => room,
    runtime: () => runtime,
    agent: () => agent,
    enrollment: () => enrollment,
    blocked: target => target.closed,
    connect: async () => connection,
    connection: () => connection
  }

  return {
    source,
    pages,
    agent,
    enrollment,
    change(kind: string) {
      if (kind === 'human') {
        authority = 'human:2:room-a'
      }

      if (kind === 'room') {
        room = '!other:test'
      }

      if (kind === 'runtime') {
        runtime = { ...runtime }
      }

      if (kind === 'retired') {
        agent.closed = true
      }

      if (kind === 'connection') {
        connection = { ...connection }
      }

      if (kind === 'withdrawn') {
        enrollment = { state: 'withdrawn', identity: null }
      }

      if (kind === 'executor') {
        enrollment = { ...enrollment, identity: { ...enrollment.identity!, executorId: 'executor-b' } }
      }

      if (kind === 'renewal') {
        enrollment = { ...enrollment, identity: { ...enrollment.identity!, expiresAt: 200 } }
      }
    },
    setPages(transport: typeof connection.pages) {
      connection.pages = transport
    }
  }
}

describe('selected agent fixed Hermes probes', () => {
  it('uses only the selected owned connection, native cwd and fixed GET routes', async () => {
    const f = readinessFixture()
    await expect(readMatrixNativeAppReadiness(f.source, '!agent:test', true)).resolves.toEqual({ skills, support })
    expect(f.pages.mock.calls).toEqual([
      [{ path: '/api/skills?profile=default', method: 'GET' }],
      [{ path: '/api/skills/app-readiness?cwd=%2Fowned%2Fworkspace&refresh=true&profile=default', method: 'GET' }]
    ])
    await expect(readMatrixNativeAppReadiness(f.source, '!foreign:test', false)).rejects.toThrow(
      'matrix_native_apps_unavailable'
    )
    expect(f.pages).toHaveBeenCalledTimes(2)
  })
  it.each(['human', 'room', 'runtime', 'retired', 'connection', 'withdrawn', 'executor'])(
    'fences %s changing during a probe',
    async kind => {
      const f = readinessFixture()
      let release!: (value: unknown) => void
      f.pages.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve as typeof release
          })
      )
      const pending = readMatrixNativeAppReadiness(f.source, '!agent:test', false)
      await vi.waitFor(() => expect(f.pages).toHaveBeenCalledOnce())
      f.change(kind)
      release(skills)
      await expect(pending).rejects.toThrow('matrix_native_apps_unavailable')
      expect(f.pages).toHaveBeenCalledOnce()
    }
  )
  it('does not treat expiry-only renewal as an identity replacement', async () => {
    const f = readinessFixture()
    f.pages.mockImplementationOnce(async () => {
      f.change('renewal')

      return skills
    })
    await expect(readMatrixNativeAppReadiness(f.source, '!agent:test', false)).resolves.toEqual({ skills, support })
  })
  it.each([
    {},
    { ...support, routes: { docx: { operations: { read: null } } } },
    { ...support, verified_bundled: null }
  ])('fails optional malformed readiness closed, without fabricating support', async malformed => {
    const f = readinessFixture()
    f.pages.mockResolvedValueOnce(skills).mockResolvedValueOnce(malformed as typeof support)
    await expect(readMatrixNativeAppReadiness(f.source, '!agent:test', false)).rejects.toThrow(
      'matrix_native_apps_unavailable'
    )
  })
  it('composes the actual Hermes profile transport, including named-home resolution', async () => {
    const f = readinessFixture()

    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/api/profiles')
              ? {
                  profiles: [
                    { name: 'other', path: '/other/home' },
                    { name: 'analyst', path: '/owned/home' }
                  ]
                }
              : url.includes('app-readiness')
                ? support
                : skills
          )
        )
    )

    vi.stubGlobal('fetch', fetchMock)
    f.setPages(createHermesPagesTransport(12345, 'synthetic', '/owned/home', new AbortController().signal))
    await expect(readMatrixNativeAppReadiness(f.source, '!agent:test', false)).resolves.toEqual({ skills, support })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:12345/api/profiles',
      'http://127.0.0.1:12345/api/skills?profile=analyst',
      'http://127.0.0.1:12345/api/skills/app-readiness?cwd=%2Fowned%2Fworkspace&refresh=false&profile=analyst'
    ])
  })
})
