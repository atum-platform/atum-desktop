/**
 * Real-child crash/restart proof for automatic Matrix handoff. The child imports
 * the production v2 MatrixExecutorLease and invokeMatrixHermes code. The Matrix
 * SDK, Hermes model/tool, and encrypted vault remain deliberately fake; 0148's
 * lease/invocation/result RPCs run against the explicitly opted-in loopback DB.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, expect, it } from 'vitest'

const LOOPBACK_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const databaseTest = process.env.ATUM_HANDOFF_DATABASE_URL === LOOPBACK_DATABASE_URL ? it : it.skip
const NODE = process.execPath
const TSX = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const CHILD = fileURLToPath(new URL('./automatic-handoff.process.fixture.ts', import.meta.url))

interface Fixture {
  owner: string
  agent: string
  executorA: string
  executorB: string
  cleanup(): Promise<void>
}

interface ChildMessage {
  phase: string
  calls?: number
  result?: { state: string; eventId?: string }
  message?: string
}

interface ManagedChild {
  child: ChildProcess
  messages: ChildMessage[]
  stderr: string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const children = new Set<ChildProcess>()
let activeFixture: Fixture | undefined
let activeTempDirectory: string | undefined

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function psql(sql: string): Promise<string> {
  const child = spawn('psql', [LOOPBACK_DATABASE_URL, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: { ...process.env, PGPASSWORD: 'postgres' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => (stdout += chunk))
  child.stderr.on('data', chunk => (stderr += chunk))

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
    }
  )

  if (code !== 0) {
    throw new Error(`fixture database request failed (${signal ?? code}): ${stderr.trim()}`)
  }

  return stdout.trim()
}

async function createFixture(): Promise<Fixture> {
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
      (${quote(executorA)}::uuid, ${quote(owner)}::uuid, 'fixture-${executorA.slice(0, 8)}', gen_random_uuid(), 'active', clock_timestamp() + interval '1 hour', ${quote(agent)}::uuid),
      (${quote(executorB)}::uuid, ${quote(owner)}::uuid, 'fixture-${executorB.slice(0, 8)}', gen_random_uuid(), 'active', clock_timestamp() + interval '1 hour', ${quote(agent)}::uuid);
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

      expect(
        await psql(`select count(*) from atum.principals where id in (${quote(owner)}::uuid, ${quote(agent)}::uuid);`)
      ).toBe('0')
    }
  }
}

function launch(input: {
  fixture: Fixture
  executor: string
  eventId: string
  mode: 'hold' | 'run' | 'after-dispatch-hang' | 'saved-result' | 'long-turn-lost-lease'
  vaultPath?: string
}): ManagedChild {
  const child = spawn(NODE, [TSX, CHILD], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      ATUM_HANDOFF_PROCESS_FIXTURE: JSON.stringify({
        owner: input.fixture.owner,
        agent: input.fixture.agent,
        executor: input.executor,
        eventId: input.eventId,
        mode: input.mode,
        vaultPath: input.vaultPath
      })
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })

  children.add(child)
  let stderr = ''
  const messages: ChildMessage[] = []
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', chunk => (stderr += chunk))
  child.on('message', message => {
    if (message && typeof message === 'object' && 'phase' in message && typeof message.phase === 'string') {
      messages.push(message as ChildMessage)
    }
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      children.delete(child)
      resolve({ code, signal })
    })
  })

  return {
    child,
    messages,
    get stderr() {
      return stderr
    },
    exited
  }
}

async function waitForPhase(managed: ManagedChild, phase: string, timeoutMs = 10_000): Promise<ChildMessage> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const message = managed.messages.find(entry => entry.phase === phase)

    if (message) {
      return message
    }

    const terminal = managed.messages.find(entry => entry.phase === 'error')

    if (terminal) {
      throw new Error(`fixture child reported error before ${phase}: ${terminal.message}`)
    }

    const status = await Promise.race([
      managed.exited.then(exit => ({ exit })),
      new Promise<undefined>(resolve => setTimeout(resolve, 25))
    ])

    if (status && 'exit' in status) {
      const finalMessage = managed.messages.find(entry => entry.phase === phase)

      if (finalMessage) {
        return finalMessage
      }

      throw new Error(
        `fixture child exited before ${phase} (${status.exit.signal ?? status.exit.code}): ${managed.stderr.trim()} ${JSON.stringify(managed.messages)}`
      )
    }
  }

  throw new Error(`fixture child did not send ${phase} within ${timeoutMs}ms: ${managed.stderr.trim()}`)
}

async function terminate(managed: ManagedChild): Promise<void> {
  if (managed.child.exitCode === null && !managed.child.killed) {
    managed.child.kill('SIGKILL')
  }

  await managed.exited
}

/** Controlled fixture expiry: only this test owner's already-created lease is accelerated, never the 90s product term. */
async function expireFixtureLease(fixture: Fixture): Promise<void> {
  const output = await psql(
    `update atum_private.matrix_executor_leases set expires_at = clock_timestamp() - interval '1 second' where owner = ${quote(fixture.owner)}::uuid returning owner;`
  )

  const count = output.split(/\s+/).find(value => value === fixture.owner)

  if (count !== fixture.owner) {
    throw new Error(`fixture accelerated lease expiry did not update its own row: ${output}`)
  }
}

async function expectCleanChild(managed: ManagedChild): Promise<void> {
  const exit = await managed.exited
  expect(exit).toEqual({ code: 0, signal: null })
  expect(managed.messages.find(message => message.phase === 'error')).toBeUndefined()
}

async function vaultPath(name: string): Promise<string> {
  activeTempDirectory ??= await mkdtemp(join(tmpdir(), 'atum-handoff-process-'))

  return join(activeTempDirectory, `${name}.json`)
}

afterEach(async () => {
  await Promise.all(
    [...children].map(child =>
      child.exitCode === null && !child.killed
        ? new Promise<void>(resolve => {
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
          })
        : Promise.resolve()
    )
  )
  children.clear()
  const fixture = activeFixture
  activeFixture = undefined
  await fixture?.cleanup()
  const directory = activeTempDirectory
  activeTempDirectory = undefined
  await (directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve())
})

databaseTest(
  'real child kill before dispatch lets successor B execute exactly once',
  async () => {
    const fixture = (activeFixture = await createFixture())
    const childA = launch({ fixture, executor: fixture.executorA, eventId: '$kill-before-dispatch', mode: 'hold' })
    await waitForPhase(childA, 'lease-held')
    await terminate(childA)
    await expireFixtureLease(fixture)

    const childB = launch({
      fixture,
      executor: fixture.executorB,
      eventId: '$kill-before-dispatch',
      mode: 'run',
      vaultPath: await vaultPath('kill-before-dispatch')
    })

    const done = await waitForPhase(childB, 'done')
    await expectCleanChild(childB)

    expect(done).toMatchObject({ calls: 1, result: { state: 'published', eventId: '$fixture-published' } })
  },
  30_000
)

databaseTest(
  'acknowledged dispatch survives a real child kill and is never replayed by B',
  async () => {
    const fixture = (activeFixture = await createFixture())

    const childA = launch({
      fixture,
      executor: fixture.executorA,
      eventId: '$kill-after-dispatch',
      mode: 'after-dispatch-hang'
    })

    await waitForPhase(childA, 'execute-started')
    await terminate(childA)
    await expireFixtureLease(fixture)

    const childB = launch({
      fixture,
      executor: fixture.executorB,
      eventId: '$kill-after-dispatch',
      mode: 'run',
      vaultPath: await vaultPath('kill-after-dispatch')
    })

    const done = await waitForPhase(childB, 'done')
    await expectCleanChild(childB)

    expect(done).toMatchObject({ calls: 0, result: { state: 'unknown' } })
  },
  30_000
)

databaseTest(
  'a restarted real child publishes its persisted result without executing Hermes again',
  async () => {
    const fixture = (activeFixture = await createFixture())
    const persistedVaultPath = await vaultPath('recover-persisted-result')

    const childA = launch({
      fixture,
      executor: fixture.executorA,
      eventId: '$recover-persisted-result',
      mode: 'saved-result',
      vaultPath: persistedVaultPath
    })

    await waitForPhase(childA, 'result-saved')
    await terminate(childA)
    await expireFixtureLease(fixture)

    const restartedA = launch({
      fixture,
      executor: fixture.executorA,
      eventId: '$recover-persisted-result',
      mode: 'run',
      vaultPath: persistedVaultPath
    })

    const done = await waitForPhase(restartedA, 'done')
    await expectCleanChild(restartedA)

    expect(done).toMatchObject({ calls: 0, result: { state: 'published', eventId: '$fixture-published' } })
  },
  30_000
)

databaseTest(
  'a long child turn loses its lease, aborts, and cannot double-dispatch after B takes over',
  async () => {
    const fixture = (activeFixture = await createFixture())

    const childA = launch({
      fixture,
      executor: fixture.executorA,
      eventId: '$lost-lease-long-turn',
      mode: 'long-turn-lost-lease'
    })

    await waitForPhase(childA, 'execute-started')
    await waitForPhase(childA, 'lease-lost', 7_000)
    const firstDone = await waitForPhase(childA, 'done')
    await expectCleanChild(childA)
    await expireFixtureLease(fixture)

    const childB = launch({
      fixture,
      executor: fixture.executorB,
      eventId: '$lost-lease-long-turn',
      mode: 'run',
      vaultPath: await vaultPath('lost-lease-long-turn')
    })

    const done = await waitForPhase(childB, 'done')
    await expectCleanChild(childB)

    expect(firstDone).toMatchObject({ calls: 1, result: { state: 'unknown' } })
    expect(done).toMatchObject({ calls: 0, result: { state: 'unknown' } })
  },
  30_000
)
