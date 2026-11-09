import { execFile } from 'node:child_process'
/**
 * Disposable database composition proof for automatic Matrix handoff. This is
 * deliberately not a Matrix-device proof: its SDK, encrypted store, and Hermes
 * tool are fakes. It exercises the native lease/controller and invocation code
 * against the real loopback 0148 RPCs only.
 */
import { randomUUID } from 'node:crypto'

import { afterEach, expect, it } from 'vitest'

import type { MatrixInvocationMessage, MatrixSdkCommand } from '../../shared/matrix'
import type { EncryptedStore } from '../encrypted-store'

import { invokeMatrixHermes } from './invocation'
import { MatrixExecutorLease } from './lease'

const LOOPBACK_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const databaseTest = process.env.ATUM_HANDOFF_DATABASE_URL === LOOPBACK_DATABASE_URL ? it : it.skip

function psql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'psql',
      [LOOPBACK_DATABASE_URL, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { env: { ...process.env, PGPASSWORD: 'postgres' } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`fixture database request failed: ${stderr.trim()}`))
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function rpc(name: 'matrix_executor_lease' | 'matrix_invocation', owner: string, input: Record<string, unknown>) {
  const output = await psql(`select atum.${name}(${quote(owner)}::uuid, ${quote(JSON.stringify(input))}::jsonb);`)

  return JSON.parse(output) as Record<string, unknown>
}

async function recover(owner: string, agent: string, input: Record<string, unknown>) {
  const output = await psql(
    `select atum.matrix_agent_invocation_result(${quote(owner)}::uuid, ${quote(agent)}::uuid, ` +
      `${quote(input.roomId as string)}, ${quote(input.eventId as string)}, ${quote(input.requestHash as string)});`
  )

  return JSON.parse(output) as Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('fixture timed out waiting for lease transition')
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

interface Fixture {
  owner: string
  agent: string
  executorA: string
  executorB: string
  cleanup(): Promise<void>
}

async function fixture(): Promise<Fixture> {
  const owner = randomUUID()
  const agent = randomUUID()
  const executorA = randomUUID()
  const executorB = randomUUID()
  const suffix = owner.slice(0, 8)

  await psql(`
    insert into atum.principals (id, kind, state) values
      (${quote(owner)}::uuid, 'human', 'active'),
      (${quote(agent)}::uuid, 'agent', 'active');
    insert into atum.matrix_agents (owner, principal, issuer, mas_user, matrix_user) values
      (${quote(owner)}::uuid, ${quote(agent)}::uuid, 'https://fixture.invalid/${suffix}', 'fixture-${suffix}', '@fixture-${suffix}:fixture.invalid');
    insert into atum.matrix_executors (id, owner, device, operation_id, state, expires_at, agent) values
      (${quote(executorA)}::uuid, ${quote(owner)}::uuid, 'fixture-a-${suffix}', gen_random_uuid(), 'active', clock_timestamp() + interval '1 hour', ${quote(agent)}::uuid),
      (${quote(executorB)}::uuid, ${quote(owner)}::uuid, 'fixture-b-${suffix}', gen_random_uuid(), 'active', clock_timestamp() + interval '1 hour', ${quote(agent)}::uuid);
  `)

  return {
    owner,
    agent,
    executorA,
    executorB,
    async cleanup() {
      await psql(`
        delete from atum.matrix_invocations where owner = ${quote(owner)}::uuid;
        delete from atum_private.matrix_executor_leases where owner = ${quote(owner)}::uuid;
        delete from atum.matrix_executors where owner = ${quote(owner)}::uuid;
        delete from atum.assistants where owner_principal = ${quote(owner)}::uuid;
        delete from atum.matrix_agents where owner = ${quote(owner)}::uuid;
        delete from atum.principals where id in (${quote(owner)}::uuid, ${quote(agent)}::uuid);
      `)

      const remaining = await psql(
        `select count(*) from atum.principals where id in (${quote(owner)}::uuid, ${quote(agent)}::uuid);`
      )

      expect(remaining).toBe('0')
    }
  }
}

function message(eventId: string, timestamp: number): MatrixInvocationMessage {
  return {
    roomId: '!automatic-handoff:fixture.invalid',
    eventId,
    wireType: 'm.room.encrypted',
    sender: '@owner:fixture.invalid',
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp,
    related: false,
    content: { msgtype: 'm.text', body: 'Run the synthetic handoff tool' }
  }
}

/** Fake Matrix SDK + encrypted store + Hermes tool; only the authority RPCs are real. */
function invocationFixture(input: {
  fixture: Fixture
  executorId: string
  leaseToken: string
  event: MatrixInvocationMessage
  store?: Map<string, string>
  tool: () => Promise<{ text: string; storedSession: string }>
  loseDispatchAck?: boolean
}) {
  const store = input.store ?? new Map<string, string>()
  let loseDispatchAck = input.loseDispatchAck

  const agent = {
    issuer: 'https://fixture.invalid',
    subject: 'fixture-owner',
    principal: input.fixture.owner,
    agentPrincipal: input.fixture.agent,
    executorId: input.executorId,
    userId: '@fixture-agent:fixture.invalid',
    deviceId:
      input.executorId === input.fixture.executorA
        ? `fixture-a-${input.fixture.owner.slice(0, 8)}`
        : `fixture-b-${input.fixture.owner.slice(0, 8)}`,
    expiresAt: Date.now() + 60 * 60_000
  }

  const human = { userId: '@owner:fixture.invalid', deviceId: 'OWNER' }

  const watch = {
    id: 'fixture-watch',
    roomId: input.event.roomId,
    since: Date.now() - 1,
    until: Date.now() + 5 * 60_000,
    sender: human,
    automatic: { windowStart: input.event.timestamp - 1 }
  }

  return {
    deps: {
      context: () => ({ human, agent }),
      read: async (command: MatrixSdkCommand) =>
        command.kind === 'readInvocation' ? input.event : '$fixture-published',
      authorize: async (request: Record<string, unknown>) => {
        // This is the same route split as matrix-authority.ts: recover is the
        // owner/agent result RPC; every mutation is matrix_invocation.
        if (request.operation === 'recover') {
          return recover(input.fixture.owner, input.fixture.agent, request)
        }

        const value = await rpc('matrix_invocation', input.fixture.owner, request)

        if (request.operation === 'dispatch' && loseDispatchAck) {
          loseDispatchAck = false
          throw new Error('synthetic_lost_dispatch_ack')
        }

        return value
      },
      confirm: async () => true,
      prepare: async () => true,
      execute: async () => input.tool(),
      store: {
        getItem: (key: string) => store.get(key) ?? null,
        failureCode: () => null,
        setItem: (key: string, value: string) => store.set(key, value),
        assertEncryptionAvailable: () => {}
      } as unknown as EncryptedStore,
      watch,
      automatic: { leaseToken: input.leaseToken }
    },
    store
  }
}

let activeFixture: Fixture | undefined

afterEach(async () => {
  const current = activeFixture
  activeFixture = undefined
  await current?.cleanup()
})

databaseTest(
  'hands a pre-takeover event to B once, fencing stale and ambiguous execution through real 0148 RPCs',
  async () => {
    const f = (activeFixture = await fixture())

    const leaseA = new MatrixExecutorLease({
      request: (operation, executorId, metadata) => rpc('matrix_executor_lease', f.owner, { operation, executorId, ...metadata }),
      random: () => 0.5
    })

    const leaseB = new MatrixExecutorLease({
      request: (operation, executorId, metadata) => rpc('matrix_executor_lease', f.owner, { operation, executorId, ...metadata }),
      random: () => 0.5
    })

    leaseA.start(f.executorA, 2)
    await waitFor(() => Boolean(leaseA.held(f.executorA)?.leaseToken))
    const heldA = leaseA.held(f.executorA)!
    const boundary = heldA.boundary!
    const oldToken = heldA.leaseToken!
    await new Promise(resolve => setTimeout(resolve, Math.max(0, boundary + 1 - Date.now())))
    const event = message('$takeover-event', Date.now())

    leaseB.start(f.executorB, 2)
    await waitFor(() => leaseB.current.state === 'elsewhere')
    await leaseA.stop()
    await waitFor(() => Boolean(leaseB.held(f.executorB)?.leaseToken))
    const heldB = leaseB.held(f.executorB)!
    expect(heldB.leaseToken).not.toBe(oldToken)

    let toolCalls = 0

    const runB = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event,
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    expect(await invokeMatrixHermes(runB.deps, { roomId: event.roomId, eventId: event.eventId }, new AbortController().signal)).toEqual({
      state: 'published',
      eventId: '$fixture-published'
    })
    expect(toolCalls).toBe(1)

    // Fresh device-store state simulates restart. The server's published row,
    // not the previous fake encrypted store, is what prevents another tool run.
    const afterRestart = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event,
      store: new Map(),
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    expect(await invokeMatrixHermes(afterRestart.deps, { roomId: event.roomId, eventId: event.eventId }, new AbortController().signal)).toEqual({
      state: 'published',
      eventId: '$fixture-published'
    })
    expect(toolCalls).toBe(1)

    const stale = invocationFixture({
      fixture: f,
      executorId: f.executorA,
      leaseToken: oldToken,
      event: message('$stale-token-event', event.timestamp),
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    await expect(
      invokeMatrixHermes(stale.deps, { roomId: stale.deps.watch.roomId, eventId: '$stale-token-event' }, new AbortController().signal)
    ).rejects.toThrow('fixture database request failed')
    expect(toolCalls).toBe(1)

    const lostEvent = message('$lost-dispatch-ack', event.timestamp)

    const lost = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event: lostEvent,
      loseDispatchAck: true,
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    await expect(
      invokeMatrixHermes(lost.deps, { roomId: lostEvent.roomId, eventId: lostEvent.eventId }, new AbortController().signal)
    ).rejects.toThrow('synthetic_lost_dispatch_ack')

    const lostRestart = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event: lostEvent,
      store: new Map(),
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    expect(
      await invokeMatrixHermes(
        lostRestart.deps,
        { roomId: lostEvent.roomId, eventId: lostEvent.eventId },
        new AbortController().signal
      )
    ).toEqual({ state: 'unknown' })
    expect(toolCalls).toBe(1)

    const crashEvent = message('$crashed-tool', event.timestamp)

    const crashed = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event: crashEvent,
      tool: async () => {
        toolCalls += 1
        throw new Error('synthetic Hermes crash')
      }
    })

    expect(
      await invokeMatrixHermes(crashed.deps, { roomId: crashEvent.roomId, eventId: crashEvent.eventId }, new AbortController().signal)
    ).toEqual({ state: 'unknown' })

    const crashRestart = invocationFixture({
      fixture: f,
      executorId: f.executorB,
      leaseToken: heldB.leaseToken!,
      event: crashEvent,
      store: new Map(),
      tool: async () => ({ text: `tool-${++toolCalls}`, storedSession: 'fixture-session' })
    })

    expect(
      await invokeMatrixHermes(
        crashRestart.deps,
        { roomId: crashEvent.roomId, eventId: crashEvent.eventId },
        new AbortController().signal
      )
    ).toEqual({ state: 'unknown' })
    expect(toolCalls).toBe(2)
    await leaseB.stop()
  },
  30_000
)
