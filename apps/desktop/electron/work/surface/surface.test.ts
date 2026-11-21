import { describe, expect, it, vi } from 'vitest'

import { MATRIX_WORK_IPC, type MatrixWorkProjection, type MatrixWorkRect } from '../../../shared/matrix-work'
import type { GateEvent } from '../gate/gate'
import type { OwnerViewPort } from '../session/pairing'
import type { OpenOwnerView } from '../session/session'
import type { WorkIncarnation } from '../sidecar/process'

import { registerMatrixWorkIpc } from './ipc'
import { type GateSurfaceState, projectWorkAgents, projectWorkAssistants } from './projection'
import { WorkSurface, type WorkSurfaceParts, type WorkViewHandle } from './surface'

const OPEN: GateSurfaceState = {
  phase: 'open',
  workGrantAccepted: true,
  switchOn: true,
  enrolled: true,
  socket: 'bound',
  agents: []
}

describe('projectWorkAssistants', () => {
  it.each([
    [null, 'not_enrolled'],
    [{ enrolled: false }, 'not_enrolled'],
    [{ workGrantAccepted: false }, 'needs_grant'],
    // What the owner can change reads first: a switched-off Mac is "off", whatever else holds.
    [{ switchOn: false, socket: 'down', phase: 'stale' }, 'off'],
    [{ socket: 'down' }, 'unreachable'],
    [{ phase: 'holding' }, 'holding'],
    [{ phase: 'stale' }, 'stale'],
    [{ phase: 'closed', socket: 'unbound' }, 'holding'],
    [{}, 'on']
  ] as const)('%j reads %s', (change, expected) => {
    expect(projectWorkAssistants(change === null ? null : { ...OPEN, ...change })).toBe(expected)
  })

  it('lists only agents with something running or a stop owed', () => {
    const agent = (principal: string, running: number, stopOwed: number) => ({
      principal,
      running,
      stopOwed,
      generation: 1,
      entitled: true,
      hasGrant: true
    })

    expect(
      projectWorkAgents({ ...OPEN, agents: [agent('@nova:x', 0, 1), agent('@idle:x', 0, 0), agent('@luna:x', 2, 0)] })
    ).toEqual([
      { principal: '@luna:x', running: 2, stopping: false },
      { principal: '@nova:x', running: 0, stopping: true }
    ])
  })
})

const INCARNATION = { id: 'i1', accountKey: 'acct', origin: 'http://127.0.0.1:1' } as WorkIncarnation

function harness(overrides: Partial<WorkSurfaceParts> = {}, open?: () => Promise<OpenOwnerView>) {
  const published: (MatrixWorkProjection | null)[] = []
  const placed: (MatrixWorkRect | null)[] = []
  const closed: string[] = []
  const calls: string[] = []
  const gateListeners = new Set<(event: GateEvent) => void>()
  let gateState: GateSurfaceState = { ...OPEN }
  let views = 0

  const createView = (): WorkViewHandle => {
    views++
    const onClosed: (() => void)[] = []

    const port = {
      close: () => {
        closed.push(`v${views}`)
        onClosed.splice(0).forEach(listener => listener())
      },
      onClosed: (listener: () => void) => void onClosed.push(listener)
    } as unknown as OwnerViewPort

    return { port, place: rect => void placed.push(rect) }
  }

  const session = {
    openOwnerView: vi.fn(async (factory: (incarnation: WorkIncarnation) => OwnerViewPort): Promise<OpenOwnerView> => {
      if (open) {
        return open()
      }

      const view = factory(INCARNATION)

      return { state: 'paired', view, incarnation: INCARNATION }
    })
  }

  const gate = {
    state: () => gateState,
    on: (listener: (event: GateEvent) => void) => {
      gateListeners.add(listener)

      return () => void gateListeners.delete(listener)
    },
    acceptWorkGrant: vi.fn(async () => void calls.push('accept')),
    setSwitch: vi.fn(async (on: boolean) => void calls.push(`switch:${on}`)),
    openRoute: vi.fn(async () => void calls.push('open')),
    closeRoute: vi.fn(async () => void calls.push('close'))
  }

  const enabledNow = { value: true }
  const parts: WorkSurfaceParts = { session, enabled: () => enabledNow.value, gate, readAccess: async () => 'allowed', ...overrides }
  const log = vi.fn()
  const surface = new WorkSurface({
    createView,
    publish: value => void published.push(value),
    log,
    setWork: async on => {
      calls.push(`work:${on}`)
      enabledNow.value = on
    }
  })

  return {
    surface,
    parts,
    session,
    gate,
    published,
    placed,
    closed,
    calls,
    log,
    last: () => published.at(-1),
    setGate: (next: Partial<GateSurfaceState>) => {
      gateState = { ...gateState, ...next }
      gateListeners.forEach(listener => listener({ type: 'change' }))
    }
  }
}

const RECT = { x: 72, y: 52, width: 900, height: 600 }

describe('WorkSurface', () => {
  it('has nothing to say before an account hands over its Work', async () => {
    const { surface } = harness()

    expect(await surface.read()).toBeNull()
  })

  it('first use asks main to start the server and the gate BEFORE the owner view opens, and a failed ask does not stop the open', async () => {
    const order: string[] = []
    const { parts, session, surface } = harness({ wantServer: async () => void order.push('want') })

    session.openOwnerView.mockImplementationOnce(async factory => {
      order.push('open')

      return { state: 'paired', view: factory(INCARNATION), incarnation: INCARNATION }
    })
    surface.attach(parts)
    await surface.show(RECT)
    expect(order).toEqual(['want', 'open'])

    const failing = harness({ wantServer: async () => { throw new Error('start_failed') } })

    failing.surface.attach(failing.parts)
    await failing.surface.show(RECT)
    expect(failing.session.openOwnerView).toHaveBeenCalledTimes(1)
  })

  it('opens the one owner view on the first show and paints it where the page asks', async () => {
    const { last, parts, placed, session, surface } = harness()

    surface.attach(parts)
    expect(last()?.view).toBe('starting')
    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)
    expect(last()).toEqual({ view: 'ready', assistants: 'on', agents: [], protons: 'ok' })
    expect(placed.at(-1)).toEqual(RECT)

    await surface.show({ ...RECT, height: 400 })
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)
    expect(placed.at(-1)).toEqual({ ...RECT, height: 400 })

    await surface.hide()
    expect(placed.at(-1)).toBeNull()
  })

  it('does not paint a view the page left while it was signing in', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => (finish = resolve))
    const { parts, placed, surface } = harness({}, undefined)

    parts.session.openOwnerView = async factory => {
      const view = factory(INCARNATION)
      await gate

      return { state: 'paired', view, incarnation: INCARNATION }
    }

    surface.attach(parts)
    const opening = surface.show(RECT)
    await surface.hide()
    finish()
    await opening
    expect(placed.at(-1)).toBeNull()
  })

  it('says it could not open, and opens again on retry', async () => {
    let fail = true

    const { last, log, parts, session, surface } = harness({}, async () =>
      fail ? { state: 'failed', reason: 'timeout' } : { state: 'paired', view: { onClosed: () => {}, close: () => {} } as unknown as OwnerViewPort, incarnation: INCARNATION }
    )

    surface.attach(parts)
    await surface.show(RECT)
    expect(last()?.view).toBe('unavailable')
    expect(log).toHaveBeenCalledWith('[work-surface] view_failed timeout')

    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)

    fail = false
    await surface.retry()
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
    expect(last()?.view).toBe('ready')
  })

  it('opens again after the view goes away underneath it', async () => {
    const { closed, last, parts, session, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    surface.attach(parts)
    expect(closed).toEqual(['v1'])
    expect(last()?.view).toBe('starting')
    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
  })

  it('a view that dies underneath the page says so and waits for "Try again"', async () => {
    const { last, parts, session, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    // the view's own close (a crash) reaches the surface as the port's onClosed
    const view = (await session.openOwnerView.mock.results[0]!.value).view as unknown as { close(): void }
    view.close()
    expect(last()?.view).toBe('unavailable')
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)

    await surface.retry()
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
    expect(last()?.view).toBe('ready')
  })

  it('a restart of the server runs with the view closed, nothing opens beside it, and the page gets its view back', async () => {
    const { closed, last, parts, session, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)

    let finish!: () => void
    const running = new Promise<void>(resolve => (finish = resolve))

    const restarting = surface.suspend(async () => {
      expect(closed).toEqual(['v1'])
      expect(last()?.view).toBe('starting')
      // a resize and a retry while the server restarts open nothing
      await surface.show({ ...RECT, width: 800 })
      await surface.retry()
      expect(session.openOwnerView).toHaveBeenCalledTimes(1)
      await running

      return 'restarted'
    })

    finish()
    expect(await restarting).toBe('restarted')
    await Promise.resolve()
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
  })

  it('a restart that fails still lets the page open its view again, and a hidden page opens nothing', async () => {
    const { parts, session, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    await expect(surface.suspend(async () => Promise.reject(new Error('restart_failed')))).rejects.toThrow('restart_failed')
    await Promise.resolve()
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)

    await surface.hide()
    await surface.suspend(async () => undefined)
    await Promise.resolve()
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
  })

  it('starts nothing while Work is off on this Mac', async () => {
    const { last, parts, session, surface } = harness({ enabled: () => false })

    surface.attach(parts)
    await surface.show(RECT)
    expect(session.openOwnerView).not.toHaveBeenCalled()
    expect(last()?.view).toBe('off')
  })

  it('closes the old account’s view and forgets it on sign-out', async () => {
    const { closed, last, parts, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    surface.attach(undefined)
    expect(closed).toEqual(['v1'])
    expect(last()).toBeNull()
  })

  it('closes a view that finished opening for an account that has gone', async () => {
    let finish!: () => void
    const wait = new Promise<void>(resolve => (finish = resolve))
    const { closed, last, parts, surface } = harness()

    parts.session.openOwnerView = async factory => {
      const view = factory(INCARNATION)
      await wait

      return { state: 'paired', view, incarnation: INCARNATION }
    }

    surface.attach(parts)
    const opening = surface.show(RECT)
    surface.attach(undefined)
    finish()
    await opening
    expect(closed.length).toBeGreaterThan(0)
    expect(last()).toBeNull()
  })

  it('follows the gate and the balance', async () => {
    let access: 'allowed' | 'empty' = 'empty'
    const { last, parts, setGate, surface } = harness({ readAccess: async () => access })

    surface.attach(parts)
    await surface.show(RECT)
    expect(last()?.protons).toBe('empty')
    access = 'allowed'
    expect((await surface.read())?.protons).toBe('ok')

    setGate({ agents: [{ principal: '@luna:x', running: 1, stopOwed: 0, generation: 1, entitled: true, hasGrant: true }] })
    expect(last()?.agents).toEqual([{ principal: '@luna:x', running: 1, stopping: false }])
  })

  it('accepts the Work grant, turns the switch on and binds the route, in that order (D9)', async () => {
    const { calls, parts, surface } = harness()

    surface.attach(parts)
    await surface.allowAssistants()
    expect(calls).toEqual(['accept', 'switch:true', 'open'])
  })

  it('turns assistants off by the gate’s own cutoff, then closes the route', async () => {
    const { calls, parts, surface } = harness()

    surface.attach(parts)
    await surface.setAssistants(false)
    expect(calls).toEqual(['switch:false', 'close'])
    await surface.setAssistants(true)
    expect(calls.slice(2)).toEqual(['switch:true', 'open'])
  })

  it('Work off: the view leaves the window first, then the switch runs; Work on opens nothing until shown', async () => {
    const { calls, closed, last, placed, published, surface, parts, session } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    expect(last()?.view).toBe('ready')

    await surface.setWork(false)
    expect(closed).toEqual(['v1'])
    expect(placed.at(-1)).toBeNull()
    expect(calls).toContain('work:false')
    expect(last()?.view).toBe('off')

    await surface.setWork(true)
    expect(calls.at(-1)).toBe('work:true')
    // on again: the page shows the quiet "starting" state and no view exists until the page asks for one
    expect(last()?.view).toBe('starting')
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)

    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(2)
    expect(last()?.view).toBe('ready')
    expect(published.length).toBeGreaterThan(0)
  })

  it('Work off still publishes when the switch fails, and does nothing without an account', async () => {
    const { calls, last, surface, parts } = harness()

    await surface.setWork(false)
    expect(calls).toEqual([])

    surface.attach(parts)
    const failing = new WorkSurface({
      createView: () => {
        throw new Error('unused')
      },
      publish: () => {},
      setWork: async () => {
        throw new Error('work_off_failed')
      }
    })

    failing.attach(parts)
    await expect(failing.setWork(false)).rejects.toThrow('work_off_failed')
    expect(failing.projection()?.view).toBe('starting')
    expect(last()).not.toBeUndefined()
  })

  it('keeps a failed bind as the gate’s state and logs only its code', async () => {
    const { gate, last, log, parts, setGate, surface } = harness()

    gate.openRoute.mockRejectedValueOnce(Object.assign(new Error('/private/path'), { code: 'dir_not_protected' }))
    surface.attach(parts)
    setGate({ socket: 'down' })
    await surface.reconnectAssistants()
    expect(log).toHaveBeenCalledWith('[work-surface] route_bind_failed dir_not_protected')
    expect(last()?.assistants).toBe('unreachable')
  })
})

describe('registerMatrixWorkIpc', () => {
  function registered() {
    let handler!: (event: unknown, value: unknown) => Promise<unknown>
    const ipc = { handle: vi.fn((channel: string, fn: typeof handler) => void (handler = fn)) }

    const surface = {
      read: vi.fn(async () => null),
      show: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      allowAssistants: vi.fn(async () => {}),
      setAssistants: vi.fn(async () => {}),
      setWork: vi.fn(async () => {}),
      reconnectAssistants: vi.fn(async () => {})
    }

    const requireUi = vi.fn()
    registerMatrixWorkIpc(ipc as never, surface, requireUi)

    return { ipc, surface, requireUi, call: (value: unknown) => handler({}, value) }
  }

  it('answers only the Matrix UI, on its one channel', async () => {
    const { call, ipc, requireUi, surface } = registered()

    expect(ipc.handle).toHaveBeenCalledWith(MATRIX_WORK_IPC.request, expect.any(Function))
    requireUi.mockImplementationOnce(() => {
      throw new Error('matrix_ui_sender_invalid')
    })
    await expect(call({ kind: 'read' })).rejects.toThrow('matrix_ui_sender_invalid')
    expect(surface.read).not.toHaveBeenCalled()
  })

  it('routes each request and refuses anything else rather than trimming it', async () => {
    const { call, surface } = registered()

    await call({ kind: 'show', rect: RECT })
    await call({ kind: 'setAssistants', on: false })
    await call({ kind: 'allowAssistants' })
    await call({ kind: 'setWork', on: true })
    expect(surface.setWork).toHaveBeenCalledWith(true)
    expect(surface.show).toHaveBeenCalledWith(RECT)
    expect(surface.setAssistants).toHaveBeenCalledWith(false)
    expect(surface.allowAssistants).toHaveBeenCalledTimes(1)

    for (const value of [
      null,
      [],
      { kind: 'launch' },
      { kind: 'read', extra: 1 },
      { kind: 'setAssistants', on: 'yes' },
      { kind: 'setWork', on: 1 },
      { kind: 'setWork' },
      { kind: 'show', rect: { ...RECT, x: -1 } },
      { kind: 'show', rect: { ...RECT, url: 'http://127.0.0.1' } },
      { kind: 'show', rect: { ...RECT, width: Number.POSITIVE_INFINITY } }
    ]) {
      await expect(call(value)).rejects.toThrow('matrix_work_request_invalid')
    }
  })
})
