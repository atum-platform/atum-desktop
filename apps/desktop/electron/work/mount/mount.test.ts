import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from 'vitest'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../../shared/matrix'
import type { WorkEnrollmentFacts, WorkSyncPage } from '../gate/contract'
import type { WorkPlatform } from '../gate/ports'
import { WorkGateService } from '../gate/service'
import { ACCOUNT, Clock, DEVICE, EVENT_A, EVENT_B, FakeSessions, FakeT3, LUNA, REQ_1, REQ_2, REQ_3 } from '../gate/test-support'

import type { WorkMountAccount } from './gate-factory'
import { WorkMount } from './mount'
import { createOwnerEventVerifier, type OwnerEventSource } from './owner-event'

// The mount against the REAL gate (ledger, socket, assertion, sync) and the REAL owner-event verifier, with fakes only
// for what lives outside main: the session server, the homeserver, the platform and lane R's session. What these
// tests pin is the order and the gating, not the gate's own rules (those are the gate's tests).

const TEAM = 'atum-lab.cloudflareaccess.com'
const AUD = 'c'.repeat(64)
const CLIENT_ID = 'abcdefghijklmnopqrst.access'
const HOST = 'work-svc.example.com'
const OWNER = '@owner:example.org'
const AGENT_USER = '@luna:example.org'
const ROOM = '!room:example.org'

let privateKey: CryptoKey
let jwk: object

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })

  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
})

interface Rig {
  root: string
  run: string
  clock: Clock
  t3: FakeT3
  sessions: FakeSessions
  carried: { agentPrincipal: string; grant: string }[]
  /** Request ids of the stop reports the platform took. */
  reported: string[]
  /** Whether the platform has the settlement operation (it does not, by default). */
  settlements: boolean
  order: string[]
  account: WorkMountAccount | undefined
  held: boolean
  homeserver: Map<string, MatrixInvocationMessage>
  homeserverDown: boolean
  sessionStart: () => Promise<unknown>
  sessionRetire: () => Promise<unknown>
  mount: WorkMount
  built: WorkGateService[]
  composed: boolean
  hostStop: Mock<() => Promise<void>>
  setEnabled: Mock<(enabled: boolean) => Promise<void>>
  resetListener: ((account: { root: string }) => void) | undefined
}

let rig: Rig

afterEach(async () => {
  for (const service of rig?.built ?? []) {
    await service.close().catch(() => undefined)
  }

  rmSync(rig.root, { recursive: true, force: true })
  rmSync(rig.run, { recursive: true, force: true })
})

function ownerMessage(eventId: string, overrides: Partial<MatrixInvocationMessage> = {}): MatrixInvocationMessage {
  return {
    roomId: ROOM,
    eventId,
    wireType: 'm.room.message',
    roomPlain: true,
    sender: OWNER,
    senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
    senderVerified: true,
    timestamp: rig.clock.now(),
    related: false,
    content: { msgtype: 'm.text', body: 'list the PDFs in Reports and write their names to index.txt' },
    ...overrides
  }
}

function build(options: { surface?: 'on' | 'hidden'; composed?: boolean } = {}): void {
  const root = mkdtempSync('/tmp/wma-')
  const run = mkdtempSync('/tmp/wmr-')
  const clock = new Clock()
  const sessions = new FakeSessions()
  const t3 = new FakeT3(sessions.sessionIdOf)
  const carried: Rig['carried'] = []
  const reported: string[] = []
  const order: string[] = []
  const built: WorkGateService[] = []

  const facts: WorkEnrollmentFacts = {
    surface: 'work',
    workHostname: HOST,
    workUrl: `https://${HOST}/agent/mcp`,
    accessTeamDomain: TEAM,
    accessAudienceTag: AUD,
    accessClientIds: [CLIENT_ID],
    sessionDurationSeconds: 3600,
    socketPath: join(run, 'g.sock'),
    gateId: { deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1 }
  }

  const page = (appliedSeq: number): WorkSyncPage => ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: appliedSeq, headSeq: appliedSeq, entitled: [LUNA], changes: [], hasMore: false })

  const platform: WorkPlatform = {
    enroll: async () => ({ work: facts }),
    pull: async input => page(input.appliedSeq),
    ack: async () => undefined,
    macEvent: async () => undefined,
    reportSettlements: async input => {
      if (!rig.settlements) {
        throw Object.assign(new Error('unavailable'), { status: 503 })
      }

      reported.push(...input.reports.map(report => report.requestId))
    },
    carryGrant: async carry => void carried.push({ agentPrincipal: carry.agentPrincipal, grant: carry.grant })
  }

  const homeserver = new Map<string, MatrixInvocationMessage>()

  const source: OwnerEventSource = {
    ownerUserId: () => OWNER,
    agentUserId: async () => AGENT_USER,
    assistantRoom: async () => ROOM,
    readEvent: async ({ eventId }) => {
      if (rig.homeserverDown) {
        throw new Error('fetch failed')
      }

      const found = homeserver.get(eventId)

      if (!found) {
        throw Object.assign(new Error('not found'), { httpStatus: 404 })
      }

      return found
    }
  }

  const account: WorkMountAccount = { key: 'acct', generation: 1, root, accountId: ACCOUNT }

  const createGate = (a: WorkMountAccount) => {
    order.push('createGate')

    const service = new WorkGateService({
      account: a,
      accountId: ACCOUNT,
      deviceServiceId: DEVICE,
      t3,
      sessions,
      owner: createOwnerEventVerifier(source),
      modelAccess: async () => 'allowed',
      delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
      held: () => rig.held,
      now: clock.now,
      monotonic: clock.monotonic,
      sleep: async () => undefined,
      stopPollMs: 0,
      stopPolls: 3,
      platform,
      socketPath: join(run, 'g.sock'),
      fetchJwks: async () => ({ keys: [jwk] })
    } as never)

    built.push(service)

    return service
  }

  const hostStop = vi.fn<() => Promise<void>>(async () => {
    order.push(`host.stop socket=${existsSync(join(run, 'g.sock')) ? 'present' : 'gone'}`)
  })

  const setEnabled = vi.fn<(enabled: boolean) => Promise<void>>(async enabled => void order.push(`host.setEnabled(${enabled})`))

  const next = {
    root,
    run,
    clock,
    t3,
    sessions,
    carried,
    reported,
    settlements: false,
    order,
    account: account as WorkMountAccount | undefined,
    held: false,
    homeserver,
    homeserverDown: false,
    sessionStart: async () => undefined as unknown,
    sessionRetire: async () => undefined as unknown,
    built,
    composed: options.composed ?? true,
    hostStop,
    setEnabled,
    resetListener: undefined as ((account: { root: string }) => void) | undefined
  } as Rig

  next.mount = new WorkMount({
    account: () => next.account,
    session: {
      start: async () => {
        order.push('session.start')
        await next.sessionStart()

        return undefined as never
      },
      held: () => next.held,
      retire: async (a, reason) => {
        order.push(`session.retire(${reason}) socket=${existsSync(join(run, 'g.sock')) ? 'present' : 'gone'} thread=${[...t3.threads.values()][0]?.runs[0].status ?? 'none'}`)
        await next.sessionRetire()

        return undefined as never
      },
      onResetDone: listener => {
        next.resetListener = listener as never

        return () => undefined
      }
    },
    host: { stop: hostStop, setEnabled },
    createGate: a => (next.composed ? createGate(a) : undefined),
    surface: options.surface ?? 'on'
  })

  rig = next
  homeserver.set(EVENT_A, ownerMessage(EVENT_A))
  homeserver.set(EVENT_B, ownerMessage(EVENT_B))
}

async function assertion(): Promise<string> {
  const now = Math.floor(rig.clock.now() / 1000)

  return new SignJWT({ type: 'app', sub: '', common_name: CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt(now)
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setExpirationTime(now + 3600)
    .sign(privateKey)
}

async function call(grant: string, requestId: string, event: string): Promise<{ status: number; json: any }> {
  const text = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'launch', arguments: { requestId, projectId: 'project-reports', task: 'List the PDFs.', ownerEvent: event, notAfter: rig.clock.now() + 60_000 } }
  })

  const headers = { host: HOST, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'cf-access-jwt-assertion': await assertion(), authorization: `Bearer ${grant}` }

  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(rig.run, 'g.sock'), path: '/agent/mcp', method: 'POST', headers }, response => {
      let raw = ''

      response.on('data', chunk => (raw += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(raw) }))
    })

    req.on('error', reject)
    req.end(text)
  })
}

/** A fresh gate on the same account root, as the next start of the app would build it. */
function reopen(): WorkGateService {
  const again = new WorkGateService({ account: rig.account ?? { key: 'acct', generation: 1, root: rig.root }, accountId: ACCOUNT, deviceServiceId: DEVICE, t3: rig.t3, sessions: rig.sessions, owner: { fetch: async () => ({ kind: 'unreachable' }) }, modelAccess: async () => 'allowed', delegated: { instanceId: 'a', model: 'b' }, held: () => false, platform: { enroll: async () => ({ work: null }), pull: async () => { throw new Error('offline') }, ack: async () => undefined, macEvent: async () => undefined, carryGrant: async () => undefined }, socketPath: join(rig.run, 'g.sock') } as never)

  rig.built.push(again)

  return again
}

async function openedRoute(): Promise<string> {
  await rig.mount.reconcile()
  await rig.mount.acceptWorkGrant()
  await rig.mount.service()!.sync.tick()

  return rig.carried[0].grant
}

describe('gating', () => {
  it('starts nothing while the Work entry is not on, and says why', async () => {
    build({ surface: 'hidden' })
    await rig.mount.reconcile()

    expect(rig.order).toEqual([])
    expect(rig.mount.state()).toMatchObject({ phase: 'idle', reason: 'surface_off', gate: null })
  })

  it('starts nothing without a signed-in account', async () => {
    build()
    rig.account = undefined
    await rig.mount.reconcile()

    expect(rig.order).toEqual([])
    expect(rig.mount.state().reason).toBe('no_account')
  })

  it('a composition without a gate leaves the session server alone: the owner’s own Work needs none of it', async () => {
    build({ composed: false })
    await rig.mount.reconcile()

    expect(rig.order).toEqual([])
    expect(rig.mount.state()).toMatchObject({ phase: 'idle', reason: 'not_composed' })
  })

  it('sign-in starts no server (plan D7): the entry turning on builds nothing that runs until first use', async () => {
    build({ surface: 'hidden' })
    await rig.mount.setSurface('on')

    expect(rig.order).toEqual(['createGate'])
    expect(rig.mount.state()).toMatchObject({ phase: 'idle', reason: 'not_needed', gate: null })
    expect(rig.mount.service()).toBeUndefined()
  })

  it('what a failed retirement flush left owed (a settled report, no stop owed, a closed gate) is delivered at sign-in, without the server and without the owner opening Work', async () => {
    build()
    rig.settlements = true
    const seed = reopen()

    seed.ledger.enqueue('stop_report', {
      agentPrincipal: LUNA,
      requestId: REQ_1,
      routeEpochAtAdmit: 1,
      agentGenerationAtAdmit: 1,
      scope: 'agent',
      outcome: 'stopped',
      revocationId: 1,
      settledAt: rig.clock.now()
    })
    await seed.close()

    await rig.mount.setSurface('on')
    await vi.waitFor(() => expect(rig.reported).toEqual([REQ_1]))

    expect(rig.order).toEqual(['createGate']) // no session server, no gate start
    expect(rig.mount.state()).toMatchObject({ phase: 'idle', reason: 'not_needed' })

    // once nothing is owed the delivery-only service lets go of the ledger, and the first use builds the gate afresh
    await vi.waitFor(() => expect(rig.built.length).toBeGreaterThan(0))
    await rig.mount.wantServer()
    expect(rig.mount.state().phase).toBe('running')
  })

  it('first use (the owner opens Work) starts the session and the gate; a later reconcile keeps them', async () => {
    build()
    await rig.mount.wantServer()

    expect(rig.order).toEqual(['createGate', 'session.start'])
    expect(rig.mount.state().phase).toBe('running')
  })

  it('an active delegation starts it without the owner opening Work: an accepted grant with the switch on', async () => {
    build()
    // what a previous run of the app left in the ledger of this account
    const seed = reopen()

    seed.ledger.setMeta('work_grant_accepted_at', rig.clock.now())
    seed.ledger.setMeta('route_open', '1')
    await seed.close()
    await rig.mount.reconcile()

    expect(rig.order).toEqual(['createGate', 'session.start'])
    expect(rig.mount.state().phase).toBe('running')
  })

  it('an accepted grant with the switch OFF is not a delegation: nothing starts at sign-in', async () => {
    build()
    const seed = reopen()

    seed.ledger.setMeta('work_grant_accepted_at', rig.clock.now())
    seed.ledger.setMeta('route_open', '0')
    seed.ledger.setMeta('switch_on', '0')
    await seed.close()
    await rig.mount.reconcile()

    expect(rig.order).toEqual(['createGate'])
    expect(rig.mount.state().reason).toBe('not_needed')
  })

  it('a reset or restore a crash left pending is healed at sign-in: it starts the session door', async () => {
    build()
    rig.held = true
    await rig.mount.reconcile()

    expect(rig.order).toContain('session.start')
  })

  it('turning the entry on starts it once Work was used; turning it off later stops nothing', async () => {
    build({ surface: 'hidden' })
    await rig.mount.wantServer()
    await rig.mount.setSurface('on')

    expect(rig.mount.state().phase).toBe('running')

    await rig.mount.setSurface('hidden')
    expect(rig.mount.state()).toMatchObject({ phase: 'running', surface: 'hidden' })
    expect(rig.hostStop).not.toHaveBeenCalled()
  })

  it('the session starts before the gate, and the route stays unbound until the owner accepts the Work screen (D9)', async () => {
    build()
    await rig.mount.wantServer()

    expect(rig.order).toEqual(['createGate', 'session.start'])
    expect(rig.mount.state()).toMatchObject({ phase: 'running', gate: { enrolled: true, workGrantAccepted: false, routeOpen: false, socket: 'unbound' } })
    expect(existsSync(join(rig.run, 'g.sock'))).toBe(false)

    await rig.mount.acceptWorkGrant()

    expect(rig.mount.state().gate).toMatchObject({ workGrantAccepted: true, routeOpen: true, socket: 'bound' })
  })

  it('an update or an owed reset holds the gate: it does not start until reconcile runs again', async () => {
    build()
    rig.held = true
    await rig.mount.reconcile()

    expect(rig.mount.state()).toMatchObject({ phase: 'holding', reason: 'held', gate: null })

    rig.held = false
    await rig.mount.wantServer()

    expect(rig.mount.state().phase).toBe('running')
  })

  it('a failed start is reported with a stable code and leaves nothing bound', async () => {
    build()

    rig.sessionStart = async () => {
      throw new Error('work_unavailable')
    }

    await rig.mount.wantServer()

    expect(rig.mount.state()).toMatchObject({ phase: 'failed', reason: 'start_failed', gate: null })
    expect(existsSync(join(rig.run, 'g.sock'))).toBe(false)
  })
})

describe('the owner’s request, verified by the real verifier through the real socket', () => {
  it('launches on the owner’s own message and refuses a stranger’s, with the gate’s typed answers', async () => {
    build()
    const grant = await openedRoute()

    expect((await call(grant, REQ_1, EVENT_A)).json.result.structuredContent).toMatchObject({ class: 'accepted' })

    rig.homeserver.set(EVENT_B, ownerMessage(EVENT_B, { sender: '@stranger:example.org' }))

    expect((await call(grant, REQ_2, EVENT_B)).json.result.structuredContent).toMatchObject({ class: 'refused', receipt: 'refused', reason: 'owner_event_not_owner' })
    expect(rig.mount.state().gate?.agents[0].running).toBe(1)
  })

  it('an unreachable homeserver is `unavailable` and spends nothing: the same request id works once it is back', async () => {
    build()
    const grant = await openedRoute()

    rig.homeserverDown = true
    expect((await call(grant, REQ_1, EVENT_A)).json.result.structuredContent).toMatchObject({ class: 'unavailable', reason: 'owner_event_unverifiable' })

    rig.homeserverDown = false
    expect((await call(grant, REQ_1, EVENT_A)).json.result.structuredContent).toMatchObject({ class: 'accepted' })
  })

  it('an event older than the contract’s bound is refused by the gate, and one message buys one launch', async () => {
    build()
    const grant = await openedRoute()

    rig.homeserver.set(EVENT_B, ownerMessage(EVENT_B, { timestamp: rig.clock.now() - 3_600_000 }))
    expect((await call(grant, REQ_2, EVENT_B)).json.result.structuredContent).toMatchObject({ reason: 'owner_event_too_old' })

    expect((await call(grant, REQ_1, EVENT_A)).json.result.structuredContent).toMatchObject({ class: 'accepted' })

    rig.homeserver.set(EVENT_A, ownerMessage(EVENT_A))
    expect((await call(grant, REQ_3, EVENT_A)).json.result.structuredContent).toMatchObject({ reason: 'event_already_used' })
  })
})

describe('retire (sign-out and account switch)', () => {
  it('cuts off and settles while the server still runs, then stops the server, then closes the gate', async () => {
    build()
    const grant = await openedRoute()
    const outgoing = rig.account!

    await call(grant, REQ_1, EVENT_A)
    rig.order.length = 0
    rig.account = undefined

    const result = await rig.mount.retire(outgoing)

    expect(result).toEqual({ settled: true, failed: [] })
    // when the session retires, the socket is already gone and the thread was already stopped by the gate
    expect(rig.order).toEqual(['session.retire(sign-out) socket=gone thread=interrupted'])
    expect(rig.mount.state()).toMatchObject({ phase: 'idle', gate: null })
  })

  it('a gate that never started this run still gets its cutoff before the reset', async () => {
    build({ surface: 'hidden' })

    const result = await rig.mount.retire(rig.account!)

    expect(result).toEqual({ settled: true, failed: [] })
    expect(rig.order).toEqual(['createGate', 'session.retire(sign-out) socket=gone thread=none'])
    expect(reopen().state()).toMatchObject({ routeOpen: false })
  })

  it('an unfinished stop stays owed and the remaining steps still run', async () => {
    build()
    const grant = await openedRoute()
    const outgoing = rig.account!

    await call(grant, REQ_1, EVENT_A)
    rig.t3.readFails = true

    const result = await rig.mount.retire(outgoing)

    expect(result.settled).toBe(false)
    expect(rig.order.some(line => line.startsWith('session.retire'))).toBe(true)
    // durable: the next start of the app still owes the stop and settles it before admitting anything
    expect(reopen().state().stopsOwed).toMatchObject({ total: 1, routeWide: true })
  })

  it('a failed session retire is reported and never leaves the gate half open', async () => {
    build()
    await openedRoute()

    rig.sessionRetire = async () => {
      throw new Error('work_stop_failed')
    }

    const result = await rig.mount.retire(rig.account!)

    expect(result).toEqual({ settled: false, failed: ['session_retire:work_stop_failed'] })
    expect(existsSync(join(rig.run, 'g.sock'))).toBe(false)
    expect(rig.mount.state().gate).toBeNull()
  })

  it('a start still in flight when the account retires finishes into nothing', async () => {
    build()
    let release!: () => void
    rig.sessionStart = () => new Promise<void>(resolve => (release = resolve))

    const starting = rig.mount.wantServer()

    await vi.waitFor(() => expect(rig.order).toContain('session.start'))

    const outgoing = rig.account!
    rig.account = undefined
    const retiring = rig.mount.retire(outgoing)

    release()
    await starting
    await retiring

    expect(rig.mount.state()).toMatchObject({ phase: 'idle', gate: null })
    expect(existsSync(join(rig.run, 'g.sock'))).toBe(false)
  })

  it('the auth reset of a retire re-issues sessions: lane R’s “reset done” reaches the gate of that account only', async () => {
    build()
    await openedRoute()
    const before = await rig.sessions.agent(LUNA)

    rig.resetListener?.({ root: '/some/other/account' })
    expect((await rig.sessions.agent(LUNA)).sessionId).toBe(before.sessionId)

    rig.resetListener?.({ root: rig.root })
    await vi.waitFor(async () => expect((await rig.sessions.agent(LUNA)).sessionId).not.toBe(before.sessionId))
  })
})

describe('quit and Work off', () => {
  it('quit closes the gate before the server stops, and is not a revocation: the owner’s switch survives', async () => {
    build()
    await openedRoute()
    rig.order.length = 0

    await rig.mount.quit()

    expect(rig.order).toEqual(['host.stop socket=gone'])

    // the next start of the same account finds the route as the owner left it
    const again = reopen()

    expect(again.state()).toMatchObject({ workGrantAccepted: true, routeOpen: true, switchOn: true })
  })

  it('after quit nothing starts again', async () => {
    build()
    await rig.mount.quit()
    await rig.mount.reconcile()

    expect(rig.order).toEqual(['host.stop socket=gone'])
  })

  it('Work off cuts the route off first, then disables the host; turning it on does not reopen the route', async () => {
    build()
    const grant = await openedRoute()

    await call(grant, REQ_1, EVENT_A)
    rig.order.length = 0

    expect(await rig.mount.workOff()).toEqual({ settled: true, failed: [] })
    expect(rig.order).toEqual(['host.setEnabled(false)'])
    expect([...rig.t3.threads.values()][0].runs[0].status).toBe('interrupted')

    await rig.mount.workOn()

    expect(rig.order).toContain('host.setEnabled(true)')
    // turning Work on starts nothing by itself: the next first use does, and finds the route closed
    expect(rig.mount.state().gate).toBeNull()
    await rig.mount.wantServer()
    expect(rig.mount.state().gate).toMatchObject({ routeOpen: false, socket: 'unbound' })
  })
})

describe('stop reports owed to the platform', () => {
  it('stay queued, counted in the gate state, and are not mixed up with other reports', async () => {
    build()
    const grant = await openedRoute()

    expect(rig.mount.state().gate?.undeliveredReports).toBe(0)

    await call(grant, REQ_1, EVENT_A)
    await rig.mount.setSwitch(false)
    await rig.mount.service()!.gate.scheduleSettle()
    await rig.mount.service()!.sync.tick()

    // the platform has no settlement operation yet: the report waits, and the Mac events (delivered) are not counted
    expect(rig.mount.state().gate?.undeliveredReports).toBe(1)
    expect(rig.mount.service()!.ledger.pending('mac_event')).toHaveLength(0)
  })
})

describe('"Agents may use my ChatGPT plan here" (gate 4b local switch)', () => {
  it('is OFF by default, turns on through the mount, and turning it off interrupts the plan threads and nothing else', async () => {
    build()
    await openedRoute()
    await rig.mount.wantServer()

    expect(rig.mount.state().gate).toMatchObject({ planSwitchOn: false, planConnected: 'unknown' })

    await rig.mount.setPlanSwitch(true)
    expect(rig.mount.state().gate?.planSwitchOn).toBe(true)

    await rig.mount.setPlanSwitch(false)
    expect(rig.mount.state().gate?.planSwitchOn).toBe(false)
    expect(rig.mount.state().gate?.stopsOwed.total).toBe(0)
  })
})

describe('an account that never used Work', () => {
  it('has nothing to reset: sign-out stops the host and never runs the session server’s tools', async () => {
    build({ composed: false })

    const mount = new WorkMount({
      account: () => rig.account,
      session: { start: async () => undefined as never, held: () => false, retire: async () => void rig.order.push('session.retire') as never, onResetDone: () => () => undefined },
      host: { stop: rig.hostStop, setEnabled: rig.setEnabled },
      homeExists: () => false,
      createGate: () => undefined
    })

    expect(await mount.retire(rig.account!)).toEqual({ settled: true, failed: [] })
    expect(rig.order).toEqual(['host.stop socket=gone'])
  })
})
