import { describe, expect, it, vi } from 'vitest'

import { MATRIX_WORK_IPC, type MatrixWorkProjection, type MatrixWorkRect } from '../../../shared/matrix-work'
import type { OwnerViewPort } from '../session/pairing'
import type { OpenOwnerView } from '../session/session'
import type { WorkIncarnation } from '../sidecar/process'

import { registerMatrixWorkIpc } from './ipc'
import { projectWorkConsent } from './projection'
import { WorkSurface, type WorkSurfaceParts, type WorkViewHandle } from './surface'

describe('Work consent projection', () => {
  const MAC = '00000000-0000-4000-8000-00000000a001'
  const OTHER = '00000000-0000-4000-8000-00000000a002'
  const GONE = '00000000-0000-4000-8000-00000000a003'
  const RIN = '00000000-0000-4000-8000-00000000b001'
  const LUNA = '00000000-0000-4000-8000-00000000b002'

  const record = {
    provider: 'codex' as const,
    state: 'off' as const,
    agents: [],
    devices: [],
    alsoWhenScheduled: false,
    revision: 0
  }

  it('an off record names nothing; this Mac comes first, then Macs with a connected plan', () => {
    const view = projectWorkConsent(
      {
        issuedAt: 1,
        consent: { ...record, alsoWhenScheduled: true, grantedAt: 5, revokedAt: 9 },
        facts: [
          { deviceServiceId: OTHER, provider: 'codex', status: 'connected', displayName: 'Studio Mac' },
          { deviceServiceId: GONE, provider: 'codex', status: 'stale' }
        ]
      },
      MAC,
      [RIN]
    )

    expect(view).toEqual({
      state: 'off',
      agents: [],
      eligible: [RIN],
      macs: [
        { id: MAC, thisMac: true, named: false },
        { id: OTHER, thisMac: false, named: false, name: 'Studio Mac' }
      ],
      alsoWhenScheduled: false,
      grantedAt: 5
    })
  })

  it('an on record keeps what it names, even a Mac or assistant this read no longer lists', () => {
    const view = projectWorkConsent(
      {
        issuedAt: 1,
        consent: { ...record, state: 'on', agents: [LUNA], devices: [GONE], alsoWhenScheduled: true, revision: 3, grantedAt: 7 },
        facts: []
      },
      MAC,
      [RIN]
    )

    expect(view.agents).toEqual([LUNA])
    expect(view.eligible).toEqual([RIN, LUNA])
    expect(view.macs).toEqual([
      { id: MAC, thisMac: true, named: false },
      { id: GONE, thisMac: false, named: true }
    ])
    expect(view.alsoWhenScheduled).toBe(true)
  })
})

const INCARNATION = { id: 'i1', accountKey: 'acct', origin: 'http://127.0.0.1:1' } as WorkIncarnation

function harness(overrides: Partial<WorkSurfaceParts> = {}, open?: () => Promise<OpenOwnerView>, canPrewarm?: () => boolean) {
  const published: (MatrixWorkProjection | null)[] = []
  const placed: (MatrixWorkRect | null)[] = []
  const closed: string[] = []
  const calls: string[] = []
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

    return { port, place: rect => void placed.push(rect), focus: () => void calls.push('focus') }
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

  const enabledNow = { value: true }
  const parts: WorkSurfaceParts = { session, enabled: () => enabledNow.value, readAccess: async () => 'allowed', ...overrides }
  const log = vi.fn()

  const surface = new WorkSurface({
    createView,
    canPrewarm,
    runCommand: async command => {
      calls.push(`run:${command}`)

      return true
    },
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
    published,
    placed,
    closed,
    calls,
    log,
    last: () => published.at(-1),

  }
}

const RECT = { x: 72, y: 52, width: 900, height: 600 }

describe('WorkSurface', () => {
  it('has nothing to say before an account hands over its Work', async () => {
    const { surface } = harness()

    expect(await surface.read()).toBeNull()
  })

  it('preloads one hidden view after launch and reuses it on open', async () => {
    vi.useFakeTimers()

    try {
      const { surface, parts, session, placed } = harness()
      surface.attach(parts)
      expect(session.openOwnerView).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(session.openOwnerView).toHaveBeenCalledTimes(1)
      expect(placed.at(-1)).toBeNull()
      await surface.show(RECT)
      await surface.show(RECT)
      expect(session.openOwnerView).toHaveBeenCalledTimes(1)
      expect(placed.at(-1)).toEqual(RECT)
      surface.attach(undefined)
    } finally {vi.useRealTimers()}
  })

  it('yields warm-up on a busy host but opens immediately on demand', async () => {
    vi.useFakeTimers()

    try {
      const rig = harness({}, undefined, () => false)
      rig.surface.attach(rig.parts)
      await vi.advanceTimersByTimeAsync(4000)
      expect(rig.session.openOwnerView).not.toHaveBeenCalled()
      await rig.surface.show(RECT)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(1)
      rig.surface.attach(undefined)
    } finally {vi.useRealTimers()}
  })

  it('cancels pending warm-up on retirement and Work off', async () => {
    vi.useFakeTimers()

    try {
      const { surface, parts, session } = harness()
      surface.attach(parts)
      surface.attach(undefined)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(session.openOwnerView).not.toHaveBeenCalled()
      surface.attach(parts)
      await surface.setWork(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(session.openOwnerView).not.toHaveBeenCalled()
    } finally {vi.useRealTimers()}
  })

  it('opens without waiting for the balance', async () => {
    const { surface, parts } = harness({
      readAccess: () => new Promise(() => {})
    })

    surface.attach(parts)
    await surface.show(RECT)
    expect(surface.projection()?.view).toBe('ready')
    surface.attach(undefined)
  })

  it('opens the one owner view on the first show and paints it where the page asks', async () => {
    const { last, parts, placed, session, surface } = harness()

    surface.attach(parts)
    expect(last()?.view).toBe('starting')
    await surface.show(RECT)
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)
    expect(last()).toEqual({ view: 'ready', protons: 'ok' })
    expect(placed.at(-1)).toEqual(RECT)

    await surface.show({ ...RECT, height: 400 })
    expect(session.openOwnerView).toHaveBeenCalledTimes(1)
    expect(placed.at(-1)).toEqual({ ...RECT, height: 400 })

    await surface.hide()
    expect(placed.at(-1)).toBeNull()
  })

  it('New thread from the band moves focus into the view before it runs, so the caret lands in its composer', async () => {
    const { calls, parts, surface } = harness()

    surface.attach(parts)
    await surface.show(RECT)
    await expect(surface.runCommand('chat.new')).resolves.toBe(true)
    await surface.runCommand('sidebar.toggle')
    expect(calls.filter(call => call === 'focus' || call.startsWith('run:'))).toEqual(['focus', 'run:chat.new', 'run:sidebar.toggle'])
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

  it('recovers a preloaded sidecar while its view is hidden', async () => {
    vi.useFakeTimers()

    try {
      let exit!: (unexpected: boolean) => void
      const unexpectedExit = new Promise<boolean>(resolve => { exit = resolve })
      const rig = harness()
      const incarnation = { ...INCARNATION, unexpectedExit }
      rig.session.openOwnerView.mockImplementationOnce(async factory => ({
        state: 'paired', incarnation, view: factory(incarnation)
      }))
      rig.surface.attach(rig.parts)
      await vi.advanceTimersByTimeAsync(2000)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(1)
      exit(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
      expect(rig.placed.at(-1)).toBeNull()
      await rig.surface.show(RECT)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
      rig.surface.attach(undefined)
    } finally {vi.useRealTimers()}
  })

  it('automatically reopens a dead sidecar and cancels recovery on detach', async () => {
    vi.useFakeTimers()

    try {
      let exit!: (unexpected: boolean) => void
      const unexpectedExit = new Promise<boolean>(resolve => { exit = resolve })
      const rig = harness()
      rig.surface.attach(rig.parts)
      const incarnation = { ...INCARNATION, unexpectedExit }
      rig.session.openOwnerView.mockImplementationOnce(async factory => ({
        state: 'paired', incarnation, view: factory(incarnation)
      }))
      await rig.surface.show(RECT)
      exit(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
      expect(rig.surface.projection()?.view).toBe('ready')
      rig.surface.attach(undefined)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps backing off when each reopened sidecar pairs and dies at once', async () => {
    vi.useFakeTimers()

    try {
      const rig = harness()
      rig.surface.attach(rig.parts)
      rig.session.openOwnerView.mockImplementation(async factory => {
        const incarnation = { ...INCARNATION, unexpectedExit: Promise.resolve(true) }

        return { state: 'paired', incarnation, view: factory(incarnation) }
      })
      await rig.surface.show(RECT)
      // Crash-looping runs reopen after 1s, 2s, 4s: the delay grows instead of staying at 1s.
      await vi.advanceTimersByTimeAsync(1000)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1999)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(3999)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(rig.session.openOwnerView).toHaveBeenCalledTimes(4)
      rig.surface.attach(undefined)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens after a dead sidecar when Retry is clicked', async () => {
    let exit!: (unexpected: boolean) => void
    const unexpectedExit = new Promise<boolean>(resolve => { exit = resolve })
    const rig = harness()
    rig.surface.attach(rig.parts)
    const incarnation = { ...INCARNATION, unexpectedExit }
    rig.session.openOwnerView.mockImplementationOnce(async factory => ({
      state: 'paired', incarnation, view: factory(incarnation)
    }))
    await rig.surface.show({ x: 0, y: 0, width: 500, height: 500 })
    exit(true)
    await Promise.resolve()
    expect(rig.surface.projection()?.view).toBe('unavailable')
    await rig.surface.retry()
    expect(rig.session.openOwnerView).toHaveBeenCalledTimes(2)
    expect(rig.surface.projection()?.view).toBe('ready')
    rig.surface.attach(undefined)
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

  it('refreshes the balance', async () => {
    let access: 'allowed' | 'empty' = 'empty'
    const { last, parts, surface } = harness({ readAccess: async () => access })

    surface.attach(parts)
    await surface.show(RECT)
    expect(last()?.protons).toBe('empty')
    access = 'allowed'
    expect((await surface.read())?.protons).toBe('ok')
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


})

describe('WorkSurface: native Connect and account consent', () => {
  const MAC = '00000000-0000-4000-8000-00000000a001'

  function navigable() {
    const loads: string[] = []
    const h = harness()

    const create = (h.surface as unknown as { options: { createView: () => WorkViewHandle } }).options.createView

    ;(h.surface as unknown as { options: { createView: () => WorkViewHandle } }).options.createView = () => {
      const handle = create()
      Object.assign(handle.port, {
        currentUrl: () => 'http://127.0.0.1:61275/?pairing=done',
        load: async (url: string) => void loads.push(url)
      })

      return handle
    }

    return { ...h, loads }
  }

  it('Connect opens T3\'s own provider screen on the view\'s own origin, after the view is painted', async () => {
    const { loads, parts, surface } = navigable()

    surface.attach(parts)
    await surface.openPlanConnect()
    expect(loads).toEqual([])
    await surface.show(RECT)
    expect(loads).toEqual(['http://127.0.0.1:61275/settings/providers?instanceId=codex'])

    await surface.openPlanConnect()
    expect(loads).toHaveLength(2)
  })

  it('opens each plan\'s own built-in screen; only ChatGPT waits for its old cloud copy to retire', async () => {
    const { loads, parts, surface } = navigable()
    const prepareChatGptConnect = vi.fn(async () => undefined)

    surface.attach({ ...parts, prepareChatGptConnect })
    await surface.show(RECT)
    await surface.openPlanConnect('claude')
    await surface.openPlanConnect('antigravity')

    expect(loads).toEqual([
      'http://127.0.0.1:61275/settings/providers?instanceId=claudeAgent',
      'http://127.0.0.1:61275/settings/providers?instanceId=antigravity'
    ])
    expect(prepareChatGptConnect).not.toHaveBeenCalled()
  })

  it('reads the account\'s connections through its parts, and nothing while no account is attached', async () => {
    const { parts, surface } = navigable()
    const view = { source: 'this_mac' as const, connections: [] }

    expect(await surface.readConnections()).toBeNull()
    surface.attach({ ...parts, readConnections: async () => view })
    expect(await surface.readConnections()).toBe(view)
  })

  it('keeps the setup offer and waits for custody retirement before navigating', async () => {
    const { loads, parts, surface } = navigable()

    const prepareChatGptConnect = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error('work_chatgpt_custody_pending'))

    surface.attach({ ...parts, prepareChatGptConnect })
    await surface.show(RECT)
    await expect(surface.openPlanConnect()).rejects.toThrow('work_chatgpt_custody_pending')
    expect(loads).toEqual([])

    await surface.openPlanConnect()
    expect(loads).toEqual(['http://127.0.0.1:61275/settings/providers?instanceId=codex'])
  })

  it('reads, sets and revokes the consent through the owner\'s client, naming this Mac by its id', async () => {
    const off = { provider: 'codex' as const, state: 'off' as const, agents: [], devices: [], alsoWhenScheduled: false, revision: 0 }

    const consent = {
      readAgentPlans: vi.fn(),
      selectRelay: vi.fn(),
      read: vi.fn(async () => ({ issuedAt: 1, consent: off, facts: [] })),
      set: vi.fn(async () => ({ ...off, state: 'on' as const, revision: 1 })),
      revoke: vi.fn(async () => off)
    }

    const { parts, surface } = harness({ consent, deviceServiceId: () => MAC })

    surface.attach(parts)
    expect((await surface.readPlanConsent()).macs).toEqual([{ id: MAC, thisMac: true, named: false }])
    await surface.setPlanConsent({ agents: ['00000000-0000-4000-8000-00000000b001'], macs: [MAC], alsoWhenScheduled: false })
    expect(consent.set).toHaveBeenCalledWith({
      agents: ['00000000-0000-4000-8000-00000000b001'],
      devices: [MAC],
      alsoWhenScheduled: false
    })
    await surface.revokePlanConsent()
    expect(consent.revoke).toHaveBeenCalledOnce()

    const none = harness()
    none.surface.attach(none.parts)
    await expect(none.surface.readPlanConsent()).rejects.toThrow('work_consent_unavailable')
  })
})

describe('registerMatrixWorkIpc', () => {
  function registered() {
    let handler!: (event: unknown, value: unknown) => Promise<unknown>
    const ipc = { handle: vi.fn((channel: string, fn: typeof handler) => void (handler = fn)) }

    const surface = {
      getSurfaceMode: vi.fn(async () => null),
      getSidebar: vi.fn(async () => null),
      getAttention: vi.fn(async () => null),
      setSurfaceMode: vi.fn(async () => {}),
      runCommand: vi.fn(async () => true),
      readAgentPlans: vi.fn(),
      selectRelay: vi.fn(),
      read: vi.fn(async () => null),
      show: vi.fn(async () => {}),
      hide: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      setWork: vi.fn(async () => {}),
      openPlanConnect: vi.fn(async () => {}),
      readConnections: vi.fn(async () => null),
      readPlanLabels: vi.fn(async () => ({ claude: { state: 'ready' as const, label: 'Claude Pro' } })),
      readPlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
      setPlanConsent: vi.fn(async () => ({ state: 'on' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false })),
      revokePlanConsent: vi.fn(async () => ({ state: 'off' as const, agents: [], eligible: [], macs: [], alsoWhenScheduled: false }))
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
    await call({ kind: 'setWork', on: true })
    expect(surface.setWork).toHaveBeenCalledWith(true)
    expect(surface.show).toHaveBeenCalledWith(RECT)

    const consent = { agents: ['00000000-0000-4000-8000-00000000b001'], macs: ['00000000-0000-4000-8000-00000000a001'], alsoWhenScheduled: true }
    await call({ kind: 'openPlanConnect' })
    await call({ kind: 'openPlanConnect', plan: 'claude' })
    await call({ kind: 'readConnections' })
    await call({ kind: 'readPlanConsent' })
    await call({ kind: 'setPlanConsent', consent })
    await call({ kind: 'revokePlanConsent' })
    expect(surface.openPlanConnect).toHaveBeenNthCalledWith(1, undefined)
    expect(surface.openPlanConnect).toHaveBeenNthCalledWith(2, 'claude')
    expect(surface.readConnections).toHaveBeenCalledOnce()
    expect(surface.readPlanConsent).toHaveBeenCalledOnce()
    expect(surface.setPlanConsent).toHaveBeenCalledWith(consent)
    expect(surface.revokePlanConsent).toHaveBeenCalledOnce()
    await call({ kind: 'runCommand', command: 'chat.new' })
    expect(surface.runCommand).toHaveBeenCalledWith('chat.new')

    for (const value of [
      { kind: 'runCommand', command: 'terminal.toggle' },
      { kind: 'runCommand', command: 'sidebar.toggle', extra: 1 },
      { kind: 'openPlanConnect', url: 'https://example.invalid' },
      { kind: 'openPlanConnect', plan: 'gemini' },
      { kind: 'readConnections', owner: 'someone' },
      { kind: 'setPlanConsent' },
      { kind: 'setPlanConsent', consent: { ...consent, agents: [] } },
      { kind: 'setPlanConsent', consent: { ...consent, agents: ['all'] } },
      { kind: 'setPlanConsent', consent: { ...consent, macs: [consent.macs[0], consent.macs[0]] } },
      { kind: 'setPlanConsent', consent: { ...consent, provider: 'claude' } },
      { kind: 'setPlanConsent', consent: { ...consent, alsoWhenScheduled: 'yes' } },
      null,
      [],
      { kind: 'launch' },
      { kind: 'read', extra: 1 },
      { kind: 'setAssistants', on: 'yes' },
      { kind: 'setPlan', on: 'yes' },
      { kind: 'setPlan' },
      { kind: 'setPlan', on: true, provider: 'claude' },
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
