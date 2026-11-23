import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { afterEach, describe, expect, it } from 'vitest'

import { createT3AuthCli } from '../session/t3-auth'
import { WORK_REQUIRED_SERVER_SETTINGS } from '../sidecar/process'

import { WORK_TOOLS } from './contract'
import { WorkGate } from './gate'
import { GateLedger } from './ledger'
import { createT3PairingCodes, memorySecretStore, T3Sessions } from './sessions'
import { createT3Client } from './t3-client'
import { PINNED_T3_TOOLS } from './test-support'

/**
 * Runs the pinned, real `t3` binary (ATUM_WORK_T3_BIN=<resources>/work-runtime/t3) against throwaway homes on
 * loopback. It proves what the unit fakes cannot: what a fresh install's server really answers to the gate's
 * session issuing and to the owner's thread list.
 */
const T3 = process.env.ATUM_WORK_T3_BIN
const dirs: string[] = []
const servers: ChildProcess[] = []

afterEach(() => {
  for (const child of servers.splice(0)) {
    child.kill('SIGKILL')
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

const ACCOUNT_ID = 'account'
const PRINCIPAL = '67000000-0000-4000-8000-00000000000a'

class FakeOwnerEvents {
  fetched = 0

  async fetch() {
    this.fetched++

    return { kind: 'unreachable' as const }
  }
}

const freePort = () =>
  new Promise<number>(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

async function boot(settings: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'work-real-gate-'))
  dirs.push(root)
  const home = join(root, 'server')
  mkdirSync(join(home, 'userdata'), { recursive: true })
  mkdirSync(join(root, 'os'), { recursive: true })
  writeFileSync(join(home, 'userdata', 'settings.json'), JSON.stringify(settings))
  const environment = { HOME: join(root, 'os'), PATH: '/usr/bin:/bin', T3CODE_HOME: home, T3CODE_TELEMETRY_ENABLED: 'false' }
  const port = await freePort()
  const child = spawn(T3!, ['--mode', 'web', '--no-browser', '--host', '127.0.0.1', '--port', String(port)], { env: environment, stdio: ['ignore', 'pipe', 'ignore'] })
  servers.push(child)
  createInterface({ input: child.stdout! }).on('line', () => undefined)
  const origin = `http://127.0.0.1:${port}`

  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      // The way the sidecar's own `verifyListener` waits: the origin itself answers 200 (the auth route answers sooner).
      if ((await fetch(origin)).ok) {
        return { origin, home, environment }
      }

      await new Promise(resolve => setTimeout(resolve, 200))
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  throw new Error('server never opened')
}

function sessionsFor(server: Awaited<ReturnType<typeof boot>>) {
  const auth = createT3AuthCli({ executable: T3!, home: server.home, environment: server.environment })

  return new T3Sessions({
    origin: () => server.origin,
    pairing: createT3PairingCodes({ executable: T3!, home: server.home, environment: server.environment }),
    auth,
    store: memorySecretStore(),
    agentName: () => 'Luna',
    knownAgents: () => [],
    unfinished: () => false
  })
}


function realClient(server: Awaited<ReturnType<typeof boot>>) {
  return createT3Client({
    origin: () => server.origin,
    incarnation: () => 'real',
    settingsFile: join(server.home, 'userdata', 'settings.json'),
    delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' }
  })
}

describe.skipIf(!T3)('the gate against the real pinned t3 binary', () => {
  it('a fresh install issues peer and owner sessions only with the provisioned setting; without it the refusal is typed', async () => {
    const bare = await boot({})
    await expect(sessionsFor(bare).agent('luna')).rejects.toThrow('t3_oauth_register_failed')

    const server = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const sessions = sessionsFor(server)
    const agent = await sessions.agent('luna')
    const owner = await sessions.owner()

    expect(agent.sessionId).not.toBe(owner.sessionId)
    expect(sessions.agentSessionId('luna')).toBe(agent.sessionId)
  }, 120_000)

  it('the peer session opens an MCP session and its launch reaches T3 (answered by T3, never refused as unauthenticated)', async () => {
    const server = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const sessions = sessionsFor(server)
    const agent = await sessions.agent('luna')
    const owner = await sessions.owner()
    const t3 = realClient(server)

    expect(await t3.prepare(agent.token)).toBe(true)

    // a project of the fresh home, found the way the gate finds threads: the owner's list over every project
    const listed = await t3.list(owner.token, { limit: 200 })
    const projectId = ((listed.data?.threads ?? []) as { projectId?: string }[])[0]?.projectId
    expect(typeof projectId).toBe('string')

    const reply = await t3.launch(
      agent.token,
      {
        projectId: projectId as string,
        workspaceStrategy: { type: 'root' },
        modelSelection: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
        message: 'OWNER (verified, event $e):\nlist the files',
        title: 'List the files',
        clientRequestId: 'AAAAAAAAAAAAAAAAAAAAA1'
      },
      'approval-required/default'
    )

    // A bare server has no delegated provider, so T3 refuses the model with its own typed code; the point is that
    // the peer's bearer was accepted all the way to T3's launch validation.
    expect(reply.transport).toBe('ok')
    expect(reply.status).not.toBe(401)
    expect(reply.status).not.toBe(403)
    expect(reply.isError === true ? typeof reply.code : typeof reply.data?.threadId).toBe('string')
  }, 120_000)

  it('the owner thread list needs allProjects (target_required otherwise) and ownerRunsIdle reads the native page', async () => {
    const server = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const sessions = sessionsFor(server)
    const owner = await sessions.owner()
    const t3 = realClient(server)

    const listed = await t3.list(owner.token, { limit: 200 })
    expect(listed.isError).toBe(false)
    expect(Array.isArray(listed.data?.threads)).toBe(true)
    expect(listed.data?.nextCursor ?? null).toBeNull()
    expect(listed.data?.total).toBe((listed.data?.threads as unknown[]).length)

    const root = mkdtempSync(join(tmpdir(), 'work-real-gate-ledger-'))
    dirs.push(root)
    const ledger = new GateLedger(join(root, 'ledger.sqlite'), 'account')

    const gate = new WorkGate({
      accountId: 'account',
      deviceServiceId: 'device',
      ledger,
      t3,
      sessions,
      owner: { fetch: async () => ({ kind: 'unreachable' }) },
      modelAccess: async () => 'allowed',
      delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
      held: () => false
    })

    // a fresh home's only thread is idle: a restart may go ahead
    expect(await gate.ownerRunsIdle()).toBe(true)
    ledger.close()
  }, 120_000)

  it('revokes a peer session through the running server, idempotently, and the bearer stops working', async () => {
    const server = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const sessions = sessionsFor(server)
    const agent = await sessions.agent('luna')
    const t3 = realClient(server)

    expect(await t3.prepare(agent.token)).toBe(true)
    await sessions.revokeAgent('luna')
    expect(sessions.agentSessionId('luna')).toBeUndefined()
    await expect(sessions.revokeAgent('luna')).resolves.toBeUndefined()
    expect((await t3.list(agent.token, { limit: 5 })).status).toBe(401)
  }, 120_000)
  // ---- gate 4a/4b on the real pin
  const CODEX_OFF = { driver: 'codex', enabled: false, config: { binaryPath: '/usr/bin/false' } }
  const CLAUDE_OFF = { driver: 'claudeAgent', enabled: false, config: { binaryPath: '/usr/bin/false' } }

  function planClient(server: Awaited<ReturnType<typeof boot>>) {
    return createT3Client({
      origin: () => server.origin,
      incarnation: () => 'real',
      settingsFile: join(server.home, 'userdata', 'settings.json'),
      delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
      plan: { instanceId: 'codex' }
    })
  }

  it('the pin reports the plan as disconnected: signed out (a fresh home), and disabled (the way the sidecar ships it until the Connect step)', async () => {
    const fresh = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const owner = await sessionsFor(fresh).owner()

    expect(await planClient(fresh).planProvider?.(owner.token)).toEqual({ status: 'disconnected' })

    const shipped = await boot({ ...WORK_REQUIRED_SERVER_SETTINGS, providerInstances: { codex: CODEX_OFF, claudeAgent: CLAUDE_OFF } })
    const shippedOwner = await sessionsFor(shipped).owner()

    expect(await planClient(shipped).planProvider?.(shippedOwner.token)).toEqual({ status: 'disconnected' })
  }, 120_000)

  it('a plan launch on the pin with no Codex login is `unavailable`, with no receipt, and the plan fact reads disconnected', async () => {
    const server = await boot({ ...WORK_REQUIRED_SERVER_SETTINGS, providerInstances: { codex: CODEX_OFF, claudeAgent: CLAUDE_OFF } })
    const sessions = sessionsFor(server)
    const root = mkdtempSync(join(tmpdir(), 'work-real-plan-'))
    dirs.push(root)
    const ledger = new GateLedger(join(root, 'ledger.sqlite'), ACCOUNT_ID)
    const owner = new FakeOwnerEvents()

    const gate = new WorkGate({
      accountId: ACCOUNT_ID,
      deviceServiceId: 'device',
      ledger,
      t3: planClient(server),
      sessions,
      owner,
      modelAccess: async () => 'allowed',
      delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
      held: () => false
    })

    ledger.setEntitled(PRINCIPAL, true)
    ledger.setMeta('work_grant_accepted_at', Date.now())
    ledger.setMeta('route_open', '1')
    ledger.setPlanSwitch(true)
    gate.noteGoodSync()
    const snapshot = { provider: 'codex' as const, state: 'on' as const, revision: 1, agents: [PRINCIPAL], alsoWhenScheduled: false }

    ledger.tx(() => gate.beginConsent(snapshot))
    gate.finishConsent(snapshot, [])

    const answer = await gate.launch(
      { principal: PRINCIPAL, routeEpoch: 1, generation: 1 },
      { requestId: 'AAAAAAAAAAAAAAAAAAAAA1', projectId: 'p', task: 'x', ownerEvent: '$e'.padEnd(20, 'e'), notAfter: Date.now() + 60_000, plan: 'codex' }
    )

    expect(answer).toMatchObject({ class: 'unavailable', reason: 'provider_not_ready' })
    expect(ledger.receipt(PRINCIPAL, 'AAAAAAAAAAAAAAAAAAAAA1')).toBeUndefined()
    expect(owner.fetched).toBe(0)
    ledger.close()
  }, 120_000)

  it('every tool the pin advertises is outside the gate\'s six, and none is a name the gate would forward', async () => {
    const server = await boot(WORK_REQUIRED_SERVER_SETTINGS)
    const owner = await sessionsFor(server).owner()
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${owner.token}` }
    const init = await fetch(`${server.origin}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }) })
    const sid = init.headers.get('mcp-session-id') as string
    const list = await (await fetch(`${server.origin}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).text()
    const names = [...new Set([...list.matchAll(/"name":"([a-z0-9_]+)"/gu)].map(match => match[1]))]

    expect(names.length).toBeGreaterThan(30)
    expect(names.filter(name => (WORK_TOOLS as readonly string[]).includes(name))).toEqual([])
    // The static list in http.test.ts is the one the gate is proven against: a pin that adds a tool must add it there.
    expect(names.filter(name => !PINNED_T3_TOOLS.includes(name))).toEqual([])
  }, 120_000)
})
