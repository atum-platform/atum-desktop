import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_WORK_IPC, type MatrixWorkProjection } from '../../shared/matrix-work'
import type { GateEvent } from '../work/gate'

import { createGateDoor, createMatrixWork, MATRIX_WORK_MODEL_ROLE, type MatrixWorkDeps, readWorkAccess } from './main-work'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  session: { fromPartition: () => ({}) },
  WebContentsView: class {}
}))

describe('readWorkAccess', () => {
  const probe = (answer: unknown) => ({
    baseUrl: () => 'http://127.0.0.1:1/v1',
    probe: vi.fn(async () => answer as { ok: true } | { ok: false; code: string })
  })

  it('reads the free probe through the proxy as the balance: ok is allowed, out of Protons is empty, anything else is unknown', async () => {
    expect(await readWorkAccess(probe({ ok: true }))).toBe('allowed')
    expect(await readWorkAccess(probe({ ok: false, code: 'out_of_protons' }))).toBe('empty')

    for (const code of ['setup_required', 'sign_in_required', 'ai_unavailable']) {
      expect(await readWorkAccess(probe({ ok: false, code }))).toBe('unavailable')
    }
  })

  it('asks as Work\'s own role, and a probe that throws is unavailable, never allowed', async () => {
    const port = probe({ ok: true })
    await readWorkAccess(port)
    expect(port.probe).toHaveBeenCalledWith(MATRIX_WORK_MODEL_ROLE)

    expect(
      await readWorkAccess({
        baseUrl: () => undefined,
        probe: async () => {
          throw new Error('down')
        }
      })
    ).toBe('unavailable')
  })
})

describe('createGateDoor', () => {
  function lab() {
    const listeners = new Set<() => void>()
    const gateListeners = new Set<(event: GateEvent) => void>()
    let service: ReturnType<typeof fakeService> | undefined

    const fakeService = () => ({
      state: () => ({ enrolled: true, phase: 'open', workGrantAccepted: true, switchOn: true, socket: 'bound', agents: [] }),
      on: (listener: (event: GateEvent) => void) => {
        gateListeners.add(listener)

        return () => void gateListeners.delete(listener)
      },
      openRoute: vi.fn(async () => {}),
      closeRoute: vi.fn(async () => {})
    })

    const mount = {
      service: () => service as never,
      onChange: (listener: () => void) => {
        listeners.add(listener)

        return () => void listeners.delete(listener)
      },
      acceptWorkGrant: vi.fn(async () => {}),
      setSwitch: vi.fn(async (_on: boolean) => {})
    }

    return {
      door: createGateDoor(mount as never),
      mount,
      listeners,
      gateListeners,
      start: () => (service = fakeService()),
      stop: () => (service = undefined),
      change: () => listeners.forEach(listener => listener())
    }
  }

  it('shows an unenrolled Mac until the mount has a gate, then the gate\'s own state', () => {
    const { door, start } = lab()

    expect(door.state()).toMatchObject({ enrolled: false, workGrantAccepted: false })
    start()
    expect(door.state()).toMatchObject({ enrolled: true, phase: 'open', socket: 'bound' })
  })

  it('follows the mount: every change is announced, and the gate it starts later is listened to', () => {
    const lab1 = lab()
    const events: string[] = []
    const stop = lab1.door.on(event => void events.push(event.type))

    lab1.change()
    expect(events).toEqual(['change'])

    lab1.start()
    lab1.change()
    expect(events).toEqual(['change', 'change'])
    expect(lab1.gateListeners.size).toBe(1)

    for (const listener of [...lab1.gateListeners]) {
      listener({ type: 'change' })
    }

    expect(events).toEqual(['change', 'change', 'change'])

    // the gate is retired and a new one built: the old listener goes, the new one comes
    lab1.stop()
    lab1.change()
    expect(lab1.gateListeners.size).toBe(0)
    lab1.start()
    lab1.change()
    expect(lab1.gateListeners.size).toBe(1)

    stop()
    expect(lab1.listeners.size).toBe(0)
    expect(lab1.gateListeners.size).toBe(0)
  })

  it('hands the owner\'s actions to the mount, and the route to the gate only while there is one', async () => {
    const { door, mount, start } = lab()

    await door.acceptWorkGrant()
    await door.setSwitch(false)
    expect(mount.acceptWorkGrant).toHaveBeenCalledTimes(1)
    expect(mount.setSwitch).toHaveBeenCalledWith(false)

    await expect(door.openRoute()).resolves.toBeUndefined()
    await expect(door.closeRoute()).resolves.toBeUndefined()

    const service = start()
    await door.openRoute()
    await door.closeRoute()
    expect(service.openRoute).toHaveBeenCalledTimes(1)
    expect(service.closeRoute).toHaveBeenCalledTimes(1)
  })
})

describe('createMatrixWork', () => {
  const roots: string[] = []

  afterEach(() => {
    handlers.clear()

    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true })
    }
  })

  function build(overrides: Partial<MatrixWorkDeps> = {}, withRuntime = false) {
    const root = mkdtempSync(join(tmpdir(), 'mw-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const workPreload = join(root, 'matrix-work-preload.js')

    if (withRuntime) {
      mkdirSync(join(resources, 'work-runtime'), { recursive: true })
      writeFileSync(join(resources, 'work-runtime', 't3'), '')
      writeFileSync(workPreload, '')
    }

    const logs: string[] = []
    const published: (MatrixWorkProjection | null)[] = []
    const state = { closing: false }

    const deps: MatrixWorkDeps = {
      userData: join(root, 'userData'),
      home: join(root, 'home'),
      resources,
      workPreload,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } as never,
      ui: () => ({ isDestroyed: () => false }) as never,
      ipcMain: { handle: (channel: string, handler: never) => void handlers.set(channel, handler) },
      requireUi: () => undefined,
      zoomFactor: () => 1,
      sessionFromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) as never,
      model: { baseUrl: () => 'http://127.0.0.1:9/v1', probe: async () => ({ ok: true }) },
      scope: () => ({ accountKey: 'a'.repeat(64), generation: 1 }),
      ownerPrincipal: () => '67000000-0000-4000-8000-0000000000a1',
      deviceServiceId: () => '67000000-0000-4000-8000-0000000000d1',
      deviceServicesEndpoint: () => 'https://api.example.test/api/matrix/v1/device-services',
      bearer: async () => 'bearer',
      ownerHost: () => undefined,
      agentMatrixUser: async () => null,
      agentName: () => undefined,
      openProtons: async () => {},
      publish: (_channel, projection) => void published.push(projection),
      closing: () => state.closing,
      log: line => void logs.push(line),
      ...overrides
    }

    return { work: createMatrixWork(deps), logs, published, state, deps }
  }

  const read = () => handlers.get(MATRIX_WORK_IPC.request)!({} as IpcMainInvokeEvent, { kind: 'read' })

  it('registers the window\'s one Work channel at once, and answers "no Work here" until an account is bound', async () => {
    build()

    expect(handlers.has(MATRIX_WORK_IPC.request)).toBe(true)
    expect(await read()).toBeNull()
  })

  it('draws no Work entry in a build without the staged runtime or the owner-view preload, and says why once', async () => {
    const { logs, work } = build()

    await work.activate()

    expect(await read()).toBeNull()
    expect(logs).toEqual(['[atum-work] bind_failed work_not_in_this_build'])
  })

  it('draws no Work entry while the model proxy is down', async () => {
    const { logs, work } = build({ model: { baseUrl: () => undefined, probe: async () => ({ ok: false, code: 'setup_required' }) } }, true)

    await work.activate()

    expect(await read()).toBeNull()
    expect(logs).toEqual(['[atum-work] bind_failed work_model_unavailable'])
  })

  it('has no account to bind before the owner principal and this Mac\'s enrollment exist, or while the app quits', async () => {
    for (const overrides of [
      { ownerPrincipal: () => undefined },
      { deviceServiceId: () => undefined },
      { scope: () => null }
    ] satisfies Partial<MatrixWorkDeps>[]) {
      const { logs, work } = build(overrides, true)
      await work.activate()
      expect(logs).toEqual([])
    }

    const quitting = build({}, true)
    quitting.state.closing = true
    await quitting.work.activate()
    expect(quitting.logs).toEqual([])
  })

  it('offers no model key until a server has asked for one', () => {
    expect(build().work.modelKeys()).toEqual([])
  })

  it('retire and quit with nothing bound are harmless', async () => {
    const { work } = build()

    await expect(work.retire()).resolves.toBeUndefined()
    await expect(work.quit()).resolves.toBeUndefined()
  })
})
