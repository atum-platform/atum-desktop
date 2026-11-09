/**
 * The failure logged at every launch, "model check failed once, retrying: Error: Hermes
 * backend: exited before port announcement (SIGTERM)", is exactly what the app's own abort
 * of a starting Hermes looks like: the abort sends SIGTERM to the backend's process group
 * before it announces its port (G1-13). Only the process is faked here; the port watcher
 * is the real one.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true }))
}))
vi.mock('../../../shared/src/json-rpc-gateway', () => ({
  JsonRpcGatewayClient: class {
    connect = mocks.connect
    onState = () => () => {}
    close = vi.fn()
  }
}))

import { openMatrixHermes } from './hermes-runtime'

const config = { python: '/fixture/python', source: '/fixture/source', profiles: '/fixture/profiles' }

function starting() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      queueMicrotask(() => child.emit('exit', null, signal))

      return true
    })
  })

  mocks.spawn.mockReturnValue(child)

  return child
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connect.mockResolvedValue(undefined)
})

describe("a starting Hermes that the app's own abort ends (G1-13)", () => {
  it('fails as "exited before port announcement (SIGTERM)", the line every launch logged', async () => {
    const child = starting()
    const abort = new AbortController()
    const opening = openMatrixHermes(config, { owner: 'owner', executorId: 'executor', signal: abort.signal })

    // The agent's host, still connecting, ended the model check's slot.
    abort.abort()

    await expect(opening).rejects.toThrow('Hermes backend: exited before port announcement (SIGTERM)')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('starts normally when nothing ends it', async () => {
    const child = starting()
    const opening = openMatrixHermes(config, { owner: 'owner', executorId: 'executor', signal: new AbortController().signal })

    child.stdout.write('HERMES_BACKEND_READY port=43123\n')
    const connection = await opening

    expect(child.kill).not.toHaveBeenCalled()
    await connection.close()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

describe('private occurrence uses the existing process owner', () => {
  it('isolates home and credentials and disables the ticker even when requested', async () => {
    const child = starting()
    const executionId = '00000000-0000-4000-8000-4dbb758e437f'
    const abort = new AbortController()

    const opening = openMatrixHermes({ ...config, subscriptionEnv: () => ({ SECRET: 'subscription' }) }, {
      owner: 'owner', executorId: 'executor', signal: abort.signal, runJobs: true,
      occurrence: { executionId, modelBaseUrl: 'http://127.0.0.1:12345/v1', modelKey: 'g'.repeat(43) }
    })

    child.stdout.write('HERMES_BACKEND_READY port=43123\n')
    const connection = await opening
    const env = mocks.spawn.mock.calls[0]![2].env
    expect(env.HERMES_HOME).toMatch(new RegExp(`/occurrences/${executionId}$`))
    expect(env.HERMES_DESKTOP_CRON).toBe('0')
    expect(env.SECRET).toBeUndefined()
    expect(env.HERMES_SHARED_AUTH_DIR).toBe(`${env.HERMES_HOME}/auth`)
    expect(env.ATUM_DESKTOP_JOB_EXECUTION).toBe(executionId)
    abort.abort()
    await connection.close()
    expect(connection.signal.aborted).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('refuses invalid occurrence capability before spawning', async () => {
    starting()
    await expect(openMatrixHermes(config, {
      owner: 'owner', executorId: 'executor', signal: new AbortController().signal,
      occurrence: { executionId: '../escape', modelBaseUrl: 'https://remote/v1', modelKey: 'g'.repeat(43) }
    })).rejects.toThrow('matrix_occurrence_invalid')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
