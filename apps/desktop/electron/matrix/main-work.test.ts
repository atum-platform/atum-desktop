import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_WORK_IPC, type MatrixWorkProjection, type WorkSurfaceModeSnapshot } from '../../shared/matrix-work'
import { type GateEvent, GateLedger, workGatePaths } from '../work/gate'
import { workSessionPaths } from '../work/session'

import { createGateDoor, createMatrixWork, MATRIX_WORK_MODEL_ROLE, type MatrixWorkDeps, readWorkAccess, WORK_MIN_AVAILABLE_MICRO_PROTONS, WorkModelKeys } from './main-work'

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

  const rich = async () => ({ balances: { available: WORK_MIN_AVAILABLE_MICRO_PROTONS } })

  it('needs a real balance AND the model path: ok is allowed, out of Protons is empty, anything else is unknown', async () => {
    expect(await readWorkAccess(probe({ ok: true }), rich)).toBe('allowed')
    expect(await readWorkAccess(probe({ ok: false, code: 'out_of_protons' }), rich)).toBe('empty')

    for (const code of ['setup_required', 'sign_in_required', 'ai_unavailable']) {
      expect(await readWorkAccess(probe({ ok: false, code }), rich)).toBe('unavailable')
    }
  })

  it('a catalog that answers does not make an owner with no Protons eligible: the wallet is read first and decides', async () => {
    const port = probe({ ok: true })

    expect(await readWorkAccess(port, async () => ({ balances: { available: 0 } }))).toBe('empty')
    expect(await readWorkAccess(port, async () => ({ balances: { available: WORK_MIN_AVAILABLE_MICRO_PROTONS - 1 } }))).toBe('empty')
    expect(port.probe).not.toHaveBeenCalled()
  })

  it('an unreadable or malformed wallet is unavailable, never allowed', async () => {
    const port = probe({ ok: true })

    expect(await readWorkAccess(port, async () => { throw new Error('offline') })).toBe('unavailable')
    expect(await readWorkAccess(port, async () => ({ balances: { available: Number.NaN } }))).toBe('unavailable')
    expect(await readWorkAccess(port, async () => ({}) as never)).toBe('unavailable')
  })

  it('asks as Work\'s own role, and a probe that throws is unavailable, never allowed', async () => {
    const port = probe({ ok: true })
    await readWorkAccess(port, rich)
    expect(port.probe).toHaveBeenCalledWith(MATRIX_WORK_MODEL_ROLE)

    expect(
      await readWorkAccess(
        {
          baseUrl: () => undefined,
          probe: async () => {
            throw new Error('down')
          }
        },
        rich
      )
    ).toBe('unavailable')
  })
})

describe('WorkModelKeys', () => {
  function lab() {
    const state = { scope: { accountKey: 'a', generation: 1 } as { accountKey: string; generation: number } | null, closing: false }
    const aborted: string[] = []
    const keys = new WorkModelKeys({ scope: () => state.scope, closing: () => state.closing, abort: role => void aborted.push(role) })

    return { state, aborted, keys }
  }

  it('offers the key only for the account and generation it was minted for, and is stable within them', () => {
    const { keys } = lab()
    const key = keys.mint()

    expect(keys.mint()).toBe(key)
    expect(keys.keys()).toEqual([[key, MATRIX_WORK_MODEL_ROLE]])
  })

  it('an account or generation change drops the key at once, with no retirement call, and cancels the forwards on their way', () => {
    for (const next of [{ accountKey: 'b', generation: 1 }, { accountKey: 'a', generation: 2 }, null]) {
      const { state, aborted, keys } = lab()
      keys.mint()
      state.scope = next

      expect(keys.keys()).toEqual([])
      expect(aborted).toEqual([MATRIX_WORK_MODEL_ROLE])
    }
  })

  it('forget is synchronous, idempotent, and aborts once; a new mint is a different key', () => {
    const { aborted, keys } = lab()
    const first = keys.mint()

    keys.forget()
    keys.forget()
    expect(keys.keys()).toEqual([])
    expect(aborted).toHaveLength(1)
    expect(keys.mint()).not.toBe(first)
  })

  it('mints nothing while signed out or quitting', () => {
    const { state, keys } = lab()

    state.closing = true
    expect(() => keys.mint()).toThrow('work_model_unavailable')
    state.closing = false
    state.scope = null
    expect(() => keys.mint()).toThrow('work_model_unavailable')
  })

  it('minting under a new generation replaces a stale key rather than reusing it', () => {
    const { state, keys } = lab()
    const old = keys.mint()

    state.scope = { accountKey: 'a', generation: 2 }
    expect(keys.mint()).not.toBe(old)
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
    const published: (MatrixWorkProjection | WorkSurfaceModeSnapshot | null)[] = []
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
      wallet: async () => ({ balances: { available: WORK_MIN_AVAILABLE_MICRO_PROTONS } }),
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

  it('the installed composition recovers an update that crashed during its restore BEFORE any server opens the home', async () => {
    const { work, deps } = build({}, true)
    const root = join(deps.userData, 'work-accounts', 'a'.repeat(32))
    const paths = workSessionPaths({ root })
    const snapshot = Buffer.from('snapshot-before-the-update')
    mkdirSync(paths.userdata, { recursive: true })
    mkdirSync(paths.snapshot, { recursive: true })
    writeFileSync(join(paths.snapshot, 'statev2.sqlite'), snapshot)

    writeFileSync(
      join(paths.snapshot, 'manifest.json'),
      JSON.stringify({ id: 'snap-1', from: '0.1.10', to: '0.1.11', files: [{ name: 'statev2.sqlite', sha256: createHash('sha256').update(snapshot).digest('hex'), size: snapshot.length }] })
    )

    // the app died halfway through the restore: the live file is a torn mix and the marker says "started"
    writeFileSync(paths.database, 'half-restored-garbage')
    writeFileSync(paths.marker, JSON.stringify({ version: 1, id: 'm1', reason: 'update', restore: 'started', snapshotId: 'snap-1', at: new Date().toISOString() }))

    await work.activate()

    expect(readFileSync(paths.database)).toEqual(snapshot)
    expect(JSON.parse(readFileSync(paths.marker, 'utf8')).restore).toBe('done')
    // the interrupted snapshot is gone only after the restore completed; it was never reused as a live home
    expect(existsSync(paths.snapshot)).toBe(false)
  })

  it('the update door reads the durable stop ledger when no gate runs: a stop owed on a home a server may still hold is refused up front', async () => {
    const { work, deps } = build({}, true)
    const root = join(deps.userData, 'work-accounts', 'a'.repeat(32))
    const paths = workSessionPaths({ root })
    const ledger = new GateLedger(workGatePaths({ root }).ledger, '67000000-0000-4000-8000-0000000000a1')
    const luna = '67000000-0000-4000-8000-00000000000a'
    ledger.setEntitled(luna, true)

    expect(
      ledger.admit({ principal: luna, requestId: 'AAAAAAAAAAAAAAAAAAAAA1', paramsHash: 'h', callJson: '{}', fingerprint: 'f', sessionId: 's', threadId: 't', eventId: '$e', notAfter: 1, epoch: 1, generation: 1 })
    ).toEqual({ ok: true })
    ledger.markForwarded(luna, 'AAAAAAAAAAAAAAAAAAAAA1', 'inc-1')
    ledger.cutoff({ scope: 'agent', principal: luna, reason: 'agent_removed_owner' })
    ledger.close()
    expect(GateLedger.owedCountAt(workGatePaths({ root }).ledger)).toBe(1)

    // a server holds the home (the runtime file names a live process): the refusal comes first, nothing is touched
    mkdirSync(paths.userdata, { recursive: true })
    writeFileSync(join(paths.userdata, 'server-runtime.json'), JSON.stringify({ pid: process.pid }))
    await work.activate()
    expect(await work.update({ version: '0.1.12', resources: deps.resources })).toEqual({ outcome: 'refused', reason: 'stops_owed' })

    // no server holds it (the app was quit and replaced): the stop settles when the gate starts, so it does not block the update
    rmSync(join(paths.userdata, 'server-runtime.json'))
    expect((await work.update({ version: '0.1.12', resources: deps.resources })).outcome).toBe('refused')
    expect(await work.update({ version: '0.1.12', resources: deps.resources })).not.toEqual({ outcome: 'refused', reason: 'stops_owed' })
  })

  it('exposes the main-owned update door; with no account bound it is unavailable, never a silent no-op', async () => {
    const { work } = build({ scope: () => null }, true)

    await expect(work.update({ version: '9.9.9', resources: '/nowhere' })).rejects.toThrow('work_unavailable')
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
