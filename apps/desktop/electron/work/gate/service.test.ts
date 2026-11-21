import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { WorkEnrollmentFacts, WorkSyncPage } from './contract'
import type { WorkPlatform } from './ports'
import { WorkGateService } from './service'
import { ACCOUNT, Clock, DEVICE, EVENT_A, EVENT_B, FakeOwner, FakeSessions, FakeT3, LUNA, REQ_1, REQ_2 } from './test-support'

// The gate as main holds it: accept the Work screen, enroll, open the route, serve a real call through the real
// socket, then turn the switch off (T8), back on, and retire for a sign-out. Fakes for T3, the homeserver and the platform.

const TEAM = 'atum-lab.cloudflareaccess.com'
const AUD = 'c'.repeat(64)
const CLIENT_ID = 'abcdefghijklmnopqrst.access'
const HOST = 'work-svc.example.com'

let privateKey: CryptoKey
let jwk: object
let service: WorkGateService
let root: string
let run: string
let clock: Clock
let t3: FakeT3
let carried: { agentPrincipal: string; grant: string }[]
let pages: WorkSyncPage[]

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })

  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
})

afterEach(async () => {
  await service?.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(run, { recursive: true, force: true })
})

function build(): void {
  root = mkdtempSync('/tmp/wga-')
  run = mkdtempSync('/tmp/wgr-')
  clock = new Clock()
  carried = []
  pages = []
  const sessions = new FakeSessions()
  const owner = new FakeOwner()

  owner.clock = clock
  owner.put(EVENT_A)
  owner.put(EVENT_B)
  t3 = new FakeT3(sessions.sessionIdOf)

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

  const platform: WorkPlatform = {
    enroll: async () => ({ work: facts }),
    pull: async input => pages.shift() ?? { deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: input.appliedSeq, headSeq: input.appliedSeq, entitled: [LUNA], changes: [], hasMore: false },
    ack: async () => undefined,
    macEvent: async () => undefined,
    carryGrant: async carry => void carried.push({ agentPrincipal: carry.agentPrincipal, grant: carry.grant })
  }

  service = new WorkGateService({
    account: { key: 'acct', generation: 1, root },
    accountId: ACCOUNT,
    deviceServiceId: DEVICE,
    ledger: undefined as never,
    t3,
    sessions,
    owner,
    modelAccess: async () => 'allowed',
    delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:binh-minh' },
    held: () => false,
    now: clock.now,
    monotonic: clock.monotonic,
    sleep: async () => undefined,
    stopPollMs: 0,
    stopPolls: 3,
    platform,
    socketPath: join(run, 'g.sock'),
    fetchJwks: async () => ({ keys: [jwk] })
  } as never)
}

async function assertion(): Promise<string> {
  const now = Math.floor(clock.now() / 1000)

  return new SignJWT({ type: 'app', sub: '', common_name: CLIENT_ID })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt(now)
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setExpirationTime(now + 3600)
    .sign(privateKey)
}

async function call(grant: string, body: unknown): Promise<{ status: number; json: any; gateId: string | string[] | undefined }> {
  const text = JSON.stringify(body)
  const headers = { host: HOST, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'cf-access-jwt-assertion': await assertion(), authorization: `Bearer ${grant}` }

  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(run, 'g.sock'), path: '/agent/mcp', method: 'POST', headers }, response => {
      let raw = ''

      response.on('data', chunk => (raw += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(raw), gateId: response.headers['x-gate-id'] }))
    })

    req.on('error', reject)
    req.end(text)
  })
}

const launchBody = (requestId: string, event: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'launch', arguments: { requestId, projectId: 'project-reports', task: 'List the PDFs.', ownerEvent: event, notAfter: clock.now() + 60_000 } }
})

describe('the gate as main holds it', () => {
  it('starts closed: nothing is granted and no socket exists until the Work screen is accepted (D9)', async () => {
    build()

    expect(service.state()).toMatchObject({ workGrantAccepted: false, routeOpen: false, phase: 'closed', enrolled: false, socket: 'unbound', continuation: false })
    expect(existsSync(join(run, 'g.sock'))).toBe(false)
    await expect(service.openRoute()).rejects.toThrow()
  })

  it('accept, enroll, bind, grant, launch through the real socket; the state shape carries what the screens read', async () => {
    build()
    await service.acceptWorkGrant()
    await service.sync.tick()
    await service.openRoute()

    const state = service.state()

    expect(state).toMatchObject({ workGrantAccepted: true, routeOpen: true, enrolled: true, hostname: HOST, switchOn: true, socket: 'bound', phase: 'open', continuation: false })
    expect(state.agents).toEqual([{ principal: LUNA, generation: 1, entitled: true, hasGrant: true, running: 0, stopOwed: 0 }])

    const grant = carried.find(item => item.agentPrincipal === LUNA)?.grant as string
    const reply = await call(grant, launchBody(REQ_1, EVENT_A))

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'accepted' })
    expect(service.state().agents[0].running).toBe(1)
  })

  it('T8: the switch off cuts off at once; a call with the still-valid token passes the edge and is refused by the Mac with its id; turning it on resumes nothing', async () => {
    build()
    await service.acceptWorkGrant()
    await service.sync.tick()
    await service.openRoute()
    const grant = carried[0].grant

    await call(grant, launchBody(REQ_1, EVENT_A))
    const threadId = [...t3.threads.keys()][0]

    await service.setSwitch(false)
    await service.gate.scheduleSettle()

    const refused = await call(grant, launchBody(REQ_2, EVENT_B))

    expect(refused.status).toBe(403)
    expect(refused.json.error.type).toBe('revoked')
    expect(String(refused.gateId)).toContain(DEVICE)
    expect(t3.threads.get(threadId)?.runs[0].status).toBe('interrupted')
    expect(service.state()).toMatchObject({ switchOn: false, routeOpen: false, phase: 'closed' })

    await service.setSwitch(true)
    await service.sync.tick()

    // new work is allowed under a NEW grant; the old thread was resumed by nobody
    expect((await call(grant, launchBody(REQ_2, EVENT_B))).json.error.type).toBe('revoked')
    expect(carried).toHaveLength(2)
    expect((await call(carried[1].grant, launchBody(REQ_2, EVENT_B))).json.result.structuredContent).toMatchObject({ class: 'accepted' })
    expect(t3.threads.get(threadId)?.runs[0].status).toBe('interrupted')
    expect(t3.prompts).toBe(2)
  })

  it('retire (sign-out): the cutoff, the socket removed, the cleanup done while the server still runs', async () => {
    build()
    await service.acceptWorkGrant()
    await service.sync.tick()
    await service.openRoute()
    await call(carried[0].grant, launchBody(REQ_1, EVENT_A))

    const result = await service.retire('sign_out')

    expect(result).toEqual({ settled: true })
    expect(existsSync(join(run, 'g.sock'))).toBe(false)
    expect(service.state()).toMatchObject({ socket: 'unbound', routeOpen: false })
    expect([...t3.threads.values()][0].runs[0].status).toBe('interrupted')
  })

  it('retire with the server unreachable keeps the stops owed in the ledger: they survive a restart of the app', async () => {
    build()
    await service.acceptWorkGrant()
    await service.sync.tick()
    await service.openRoute()
    await call(carried[0].grant, launchBody(REQ_1, EVENT_A))

    t3.readFails = true

    expect(await service.retire('work_off')).toEqual({ settled: false })
    expect(service.state().stopsOwed.total).toBe(1)
  })

  it('a taken socket path means the route is down and nothing moves', async () => {
    build()
    await service.acceptWorkGrant()
    await service.openRoute()

    const second = new WorkGateService({
      account: { key: 'acct2', generation: 1, root: mkdtempSync('/tmp/wga-') },
      accountId: ACCOUNT,
      deviceServiceId: DEVICE,
      t3,
      sessions: new FakeSessions(),
      owner: new FakeOwner(),
      modelAccess: async () => 'allowed',
      delegated: { instanceId: 'a', model: 'b' },
      held: () => false,
      platform: { enroll: async () => ({ work: null }), pull: async () => { throw new Error('x') }, ack: async () => undefined, macEvent: async () => undefined, carryGrant: async () => undefined },
      socketPath: join(run, 'g.sock')
    } as never)

    second.ledger.setMeta('facts', JSON.stringify({ surface: 'work', workHostname: HOST, workUrl: `https://${HOST}/agent/mcp`, accessTeamDomain: TEAM, accessAudienceTag: AUD, accessClientIds: [CLIENT_ID], sessionDurationSeconds: 3600, socketPath: join(run, 'g.sock'), gateId: { deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1 } }))

    await expect(second.openRoute()).rejects.toMatchObject({ code: 'path_taken_live' })
    expect(second.state()).toMatchObject({ socket: 'down', socketReason: 'path_taken_live' })
    await second.close()
  })
})
