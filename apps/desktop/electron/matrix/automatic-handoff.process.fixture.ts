/**
 * Child half of automatic-handoff.process.test.ts. It deliberately keeps the
 * Matrix SDK, Hermes tool, and encrypted vault fake, while importing the real
 * v2 lease and invocation modules and calling the real loopback 0148 RPCs.
 *
 * The parent owns lifecycle: this fixture sends IPC sentinels at the exact
 * dispatch/result boundaries, then the parent can terminate this *child*.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import type { MatrixInvocationMessage, MatrixSdkCommand } from '../../shared/matrix'
import type { EncryptedStore } from '../encrypted-store'

import { invokeMatrixHermes } from './invocation'
import { MatrixExecutorLease } from './lease'

const exec = promisify(execFile)
const databaseUrl = 'postgres://postgres:postgres@127.0.0.1:56322/postgres'

interface Config {
  owner: string
  agent: string
  executor: string
  eventId: string
  mode: 'hold' | 'run' | 'after-dispatch-hang' | 'saved-result' | 'long-turn-lost-lease'
  vaultPath?: string
}

const rawConfig = process.env.ATUM_HANDOFF_PROCESS_FIXTURE

if (!rawConfig || typeof process.send !== 'function') {
  throw new Error('automatic-handoff process fixture requires parent IPC configuration')
}

const config = JSON.parse(rawConfig) as Config

function send(phase: string, detail: Record<string, unknown> = {}): void {
  process.send!({ phase, ...detail })
}

function sendAndDrain(phase: string, detail: Record<string, unknown> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send!({ phase, ...detail }, error => (error ? reject(error) : resolve()))
  })
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function psql(sql: string): Promise<string> {
  try {
    const { stdout } = await exec('psql', [databaseUrl, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, PGPASSWORD: 'postgres' }
    })

    return stdout.trim()
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error)
    throw new Error(`fixture database request failed: ${stderr}`)
  }
}

async function rpc(name: 'matrix_executor_lease' | 'matrix_invocation', input: Record<string, unknown>) {
  const output = await psql(
    `select atum.${name}(${quote(config.owner)}::uuid, ${quote(JSON.stringify(input))}::jsonb);`
  )

  return JSON.parse(output) as Record<string, unknown>
}

async function recover(input: Record<string, unknown>) {
  const output = await psql(
    `select atum.matrix_agent_invocation_result(${quote(config.owner)}::uuid, ${quote(config.agent)}::uuid, ` +
      `${quote(input.roomId as string)}, ${quote(input.eventId as string)}, ${quote(input.requestHash as string)});`
  )

  return JSON.parse(output) as Record<string, unknown>
}

function message(): MatrixInvocationMessage {
  return {
    roomId: '!automatic-handoff:fixture.invalid',
    eventId: config.eventId,
    wireType: 'm.room.encrypted',
    sender: '@owner:fixture.invalid',
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp: Date.now(),
    related: false,
    content: { msgtype: 'm.text', body: 'Run the subprocess handoff tool' }
  }
}

function readVault(path: string): Record<string, string> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {}
}

function fixtureStore(path: string | undefined) {
  let saved = false

  return {
    get saved(): boolean {
      return saved
    },
    store: {
      getItem(key: string) {
        return path ? (readVault(path)[key] ?? null) : null
      },
      failureCode: () => null,
      setItem(key: string, value: string) {
        if (!path) {
          throw new Error('process fixture requires a vault path to save a result')
        }

        const vault = readVault(path)
        vault[key] = value
        writeFileSync(path, JSON.stringify(vault))
        saved = true
      },
      assertEncryptionAvailable: () => {}
    } as unknown as EncryptedStore
  }
}

function waitForParent(control: string): Promise<void> {
  return new Promise(resolve => {
    process.on('message', value => {
      if (value && typeof value === 'object' && 'control' in value && value.control === control) {
        resolve()
      }
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('fixture timed out waiting for lease transition')
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function main(): Promise<void> {
  let acquired = false
  let blockComplete = false
  let toolCalls = 0
  const vault = fixtureStore(config.vaultPath)

  const lease = new MatrixExecutorLease({
    request: async (operation, executorId, metadata) => {
      // This intentionally simulates a failed renewal after a successful,
      // real acquire. It is the accelerated lost-lease timer: production's
      // 90s term is never waited out in a subprocess test.
      if (config.mode === 'long-turn-lost-lease' && operation === 'acquire' && acquired) {
        throw new Error('fixture accelerated renewal outage')
      }

      const value = await rpc('matrix_executor_lease', { operation, executorId, ...metadata })
      acquired ||= operation === 'acquire' && value.held === true

      return value
    },
    onChange(status) {
      if (status.state === 'held') {
        send('lease-held', { leaseToken: status.leaseToken })
      }

      if (status.state === 'unavailable' && config.mode === 'long-turn-lost-lease') {
        send('lease-lost')
      }
    },
    // MatrixExecutorLease floors the renewal cadence at 1s. A near-term
    // loss margin makes the next failed renewal abort the live child turn.
    renewMs: 2_000,
    lossMarginMs: 88_000,
    random: () => 0.5
  })

  lease.start(config.executor, 2)
  await waitFor(() => Boolean(lease.held(config.executor)?.leaseToken))
  const held = lease.held(config.executor)!
  // Automatic admission accepts only events observed after this lease's
  // server boundary. Create the fake SDK event after the real acquire.
  const event = message()

  if (config.mode === 'hold') {
    await waitForParent('exit')

    return
  }

  const human = { userId: '@owner:fixture.invalid', deviceId: 'OWNER' }

  const agent = {
    issuer: 'https://fixture.invalid',
    subject: 'fixture-owner',
    principal: config.owner,
    agentPrincipal: config.agent,
    executorId: config.executor,
    userId: '@fixture-agent:fixture.invalid',
    deviceId: `fixture-${config.executor.slice(0, 8)}`,
    expiresAt: Date.now() + 60 * 60_000
  }

  const watch = {
    id: 'fixture-watch',
    roomId: event.roomId,
    since: Date.now() - 1,
    until: Date.now() + 5 * 60_000,
    sender: human,
    automatic: { windowStart: event.timestamp - 1 }
  }

  const result = await invokeMatrixHermes(
    {
      context: () => ({ human, agent }),
      read: async (command: MatrixSdkCommand) => (command.kind === 'readInvocation' ? event : '$fixture-published'),
      authorize: async request => {
        if (request.operation === 'recover') {
          return recover(request)
        }

        if (config.mode === 'saved-result' && request.operation === 'complete' && vault.saved && !blockComplete) {
          blockComplete = true
          send('result-saved')
          await waitForParent('complete')
        }

        return rpc('matrix_invocation', request)
      },
      confirm: async () => true,
      prepare: async () => true,
      execute: async input => {
        toolCalls += 1
        send('execute-started', { calls: toolCalls })

        if (config.mode === 'after-dispatch-hang') {
          return new Promise(() => {})
        }

        if (config.mode === 'long-turn-lost-lease') {
          return new Promise((_, reject) => {
            // Keep the fixture child alive for the real lease timer. An
            // unresolved Promise alone does not retain Node's event loop.
            const keepAlive = setInterval(() => {}, 1_000)
            input.signal.addEventListener(
              'abort',
              () => {
                clearInterval(keepAlive)
                reject(input.signal.reason)
              },
              { once: true }
            )
          })
        }

        return { text: `tool-${toolCalls}`, storedSession: 'fixture-session' }
      },
      store: vault.store,
      watch,
      automatic: { leaseToken: held.leaseToken! }
    },
    { roomId: event.roomId, eventId: event.eventId },
    held.signal
  )

  await sendAndDrain('done', { result, calls: toolCalls })
}

void main().catch(error => {
  send('error', { message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  process.exitCode = 1
})
