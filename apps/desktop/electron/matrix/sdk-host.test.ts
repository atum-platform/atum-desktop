import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appHostDisposition,
  boundSdkConfiguration,
  MATRIX_AGENT_REFRESH_WAIT_MS,
  matrixAgentRenews,
  matrixAgentSdkRefresh,
  matrixHostAgent,
  matrixHostApp,
  matrixHumanSdkReady,
  matrixInvocationUses,
  MatrixSdkHost,
  matrixSdkRendererRestartable,
  stopSdkWithApps
} from './sdk-host'

afterEach(() => vi.useRealTimers())

it('uses human snapshot readiness without the agent-only host.ready flag', () => {
  const human = { identity: { userId: '@owner:test', deviceId: 'OWNER' } }
  expect(matrixHumanSdkReady('ready', human)).toBe(true)
  expect(matrixHumanSdkReady('ready', undefined)).toBe(false)
  expect(matrixHumanSdkReady('signed_out', human)).toBe(false)
  expect(matrixHumanSdkReady('error', human)).toBe(false)
  expect(matrixHumanSdkReady('signing_in', human)).toBe(false)
  expect(matrixHumanSdkReady('connecting', human)).toBe(false)
  expect(matrixHumanSdkReady('offline', human)).toBe(false)
})

it('scopes stop/crash/expiry cancellation to the human and the invoking participant', () => {
  const roles = ['human', 'agent', 'app:river', 'app:moon'] as const
  expect(roles.map(role => matrixInvocationUses(role))).toEqual([true, true, false, false])
  expect(roles.map(role => matrixInvocationUses(role, 'river'))).toEqual([true, false, true, false])
  expect(roles.map(role => matrixInvocationUses(role, 'moon'))).toEqual([true, false, false, true])
})

it('restarts core SDK renderers without assigning app execution to main', () => {
  expect(matrixSdkRendererRestartable('human', false)).toBe(true)
  expect(matrixSdkRendererRestartable('agent', true)).toBe(true)
  expect(matrixSdkRendererRestartable('agent:alfred', true)).toBe(true)
  expect(matrixSdkRendererRestartable('agent:alfred', false)).toBe(false)
  expect(matrixSdkRendererRestartable('app:moon', true)).toBe(false)
})

it('distinguishes temporary availability from authority withdrawal, including pending receipt/version binding', () => {
  const app = {
    app_id: 'app',
    app_version_id: 'version',
    availability: 'available' as const,
    matrix_room_context: 'addressed_only' as const,
    link: { mode: 'external_account' as const, state: 'linked' as const }
  }

  const enrolled = { state: 'ready' as const, identity: null, selection: { appId: 'app', appVersionId: 'version' } }
  expect(appHostDisposition(enrolled, app)).toBe('restore')
  expect(appHostDisposition(enrolled, { ...app, availability: 'unavailable' })).toBe('suspend')
  expect(appHostDisposition(enrolled, { ...app, matrix_room_context: null })).toBe('suspend')
  expect(appHostDisposition(enrolled, { ...app, matrix_room_context: undefined })).toBe('suspend')
  expect(appHostDisposition(enrolled)).toBe('withdraw')
  expect(appHostDisposition(enrolled, { ...app, link: { ...app.link, state: 'unlinked' } })).toBe('withdraw')

  for (const state of ['revoking', 'expired'] as const) {
    expect(appHostDisposition({ ...enrolled, state }, app)).toBe('withdraw')
  }

  const pending = { ...enrolled, state: 'pending' as const }
  expect(appHostDisposition(pending, app)).toBe('suspend')
  expect(appHostDisposition(pending, { ...app, app_version_id: 'new-version' })).toBe('withdraw')
  expect(appHostDisposition(pending, { ...app, app_id: 'new-app' })).toBe('withdraw')
})

it('gives each app an independent SDK queue; stopping one leaves human, Hermes and another app usable', async () => {
  const roles = ['human', 'agent', 'app:river', 'app:moon'] as const
  expect(roles.map(matrixHostApp)).toEqual([undefined, undefined, 'river', 'moon'])

  const hosts = roles.map(() => {
    const send = vi.fn()
    const host = new MatrixSdkHost(send, vi.fn())
    const result = host.command({ kind: 'readInvocation' }).catch(error => error.message)

    return { host, send, result }
  })

  hosts[2].host.close()
  expect(await hosts[2].result).toBe('matrix_sdk_stopped')

  for (const index of [0, 1, 3]) {
    const { host, send, result } = hosts[index]
    host.result(hosts[2].send.mock.calls[0][0], true, 'foreign result')
    host.result(send.mock.calls[0][0], true, roles[index])
    expect(await result).toBe(roles[index])
    host.close()
  }
})

it('stops both SDK hosts despite app cleanup failure, without concealing host failure', async () => {
  const cleanup = vi.fn(async () => {
    throw new Error('private path')
  })

  const human = vi.fn(async () => {})
  const agent = vi.fn(async () => {})
  const reported = vi.fn()
  await stopSdkWithApps(cleanup, human, agent, reported)
  expect(human).toHaveBeenCalledOnce()
  expect(agent).toHaveBeenCalledOnce()
  expect(reported).toHaveBeenCalledExactlyOnceWith()
  human.mockRejectedValueOnce(new Error('matrix_sdk_stopped'))
  await expect(stopSdkWithApps(cleanup, human, agent, reported)).rejects.toThrow('matrix_sdk_stopped')
  expect(agent).toHaveBeenCalledTimes(2)
})

it('allows the bounded attachment budget without extending ordinary commands', async () => {
  vi.useFakeTimers()
  const send = vi.fn()
  const host = new MatrixSdkHost(send, vi.fn())
  const file = host.command({ kind: 'readInvocation', includeAttachment: true }, 75_000)
  const settled = vi.fn()
  void file.then(settled)
  const text = host.command({ kind: 'readInvocation' }).catch(error => error.message)
  await vi.advanceTimersByTimeAsync(40_000)
  expect(await text).toBe('matrix_operation_timeout')
  expect(settled).not.toHaveBeenCalled()
  host.result(send.mock.calls[0][0], true, 'verified bytes')
  expect(await file).toBe('verified bytes')
  host.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('still times out a stalled attachment and drops its late result', async () => {
  vi.useFakeTimers()
  const send = vi.fn()
  const host = new MatrixSdkHost(send, vi.fn())

  const file = host.command({ kind: 'readInvocation', includeAttachment: true }, 75_000).catch(error => error.message)

  await vi.advanceTimersByTimeAsync(75_000)
  expect(await file).toBe('matrix_operation_timeout')
  host.result(send.mock.calls[0][0], true, 'late bytes')
  host.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps queues separate and ignores foreign, duplicate and late results', async () => {
  const send = vi.fn()
  const human = new MatrixSdkHost(send, vi.fn())
  const agent = new MatrixSdkHost(vi.fn(), vi.fn())
  const result = human.command({ kind: 'devices' })
  const id = send.mock.calls[0][0]
  agent.result(id, true, 'foreign')
  human.result(id, true, 'human')
  human.result(id, true, 'duplicate')
  expect(await result).toBe('human')
  human.close()
  agent.close()
})

it('coalesces stop, disallows new commands and rejects pending commands on destruction', async () => {
  const send = vi.fn()
  const destroy = vi.fn()
  const host = new MatrixSdkHost(send, destroy)
  const pending = host.command({ kind: 'send' }).catch(error => error.message)
  const stop = host.stop()
  expect(host.stop()).toBe(stop)
  await expect(host.command({ kind: 'send' })).rejects.toThrow('matrix_sdk_stopped')
  host.result(send.mock.calls[1][0], true, null)
  await stop
  expect(await pending).toBe('matrix_sdk_stopped')
  await host.stop()
  expect(destroy).toHaveBeenCalledTimes(1)
})

it('bounds stop if the renderer is hung and handles crashed sends without exposing their payload', async () => {
  vi.useFakeTimers()
  const destroy = vi.fn()
  const host = new MatrixSdkHost(() => {}, destroy)
  const stop = host.stop()
  await vi.advanceTimersByTimeAsync(5_000)
  await stop
  expect(destroy).toHaveBeenCalledOnce()

  const crashed = new MatrixSdkHost(() => {
    throw new Error('private')
  }, vi.fn())

  await expect(crashed.command({})).rejects.toThrow('matrix_operation_failed')
  crashed.close()
  expect(vi.getTimerCount()).toBe(0)
})

it("names another agent's host by its principal, and nothing else", () => {
  expect(matrixHostAgent('agent:alfred-principal')).toBe('alfred-principal')
  expect(matrixHostAgent('agent')).toBeUndefined()
  expect(matrixHostAgent('app:river')).toBeUndefined()
  expect(matrixHostApp('agent:alfred-principal')).toBeUndefined()
  // Another agent's host stopping never cancels the default agent's or an app's turn.
  expect(matrixInvocationUses('agent:alfred-principal')).toBe(false)
  expect(matrixInvocationUses('agent:alfred-principal', 'river')).toBe(false)
})

// An agent host's refresh (launch checklist G1-12; RT slice 2): the SDK gets main's renewed
// token, never one it already holds, and never a way to extend its own lifetime.
describe("an agent host's token refresh", () => {
  const digest = (token: string) => `digest:${token}`

  const configuration = (accessToken: string) => ({
    baseUrl: 'https://matrix.test',
    userId: '@agent:test',
    deviceId: 'AGENT',
    accessToken,
    storageKey: 'key'
  })

  it('hands over a renewed token once, with the same handle, and records that the host holds it', async () => {
    const first = await matrixAgentSdkRefresh({
      handle: 'handle',
      expected: 'handle',
      configuration: () => configuration('renewed'),
      holds: digest('old'),
      digest
    })

    expect(first).toEqual({
      result: { ok: true, accessToken: 'renewed', refreshToken: 'handle' },
      holds: digest('renewed')
    })
    expect(first.result).not.toHaveProperty('expiresAt')

    // Asked again with nothing newer: the token the server refused is not handed back.
    expect(
      await matrixAgentSdkRefresh({
        handle: 'handle',
        expected: 'handle',
        configuration: () => configuration('renewed'),
        holds: first.holds,
        digest
      })
    ).toEqual({ result: { ok: false, reauthenticate: false } })
  })

  it('signs a host out that asks with another handle, has none, or has no current credential', async () => {
    const current = () => configuration('renewed')

    for (const [handle, expected] of [
      ['other', 'handle'],
      ['handle', undefined]
    ] as const) {
      expect(
        await matrixAgentSdkRefresh({ handle, expected, configuration: current, holds: undefined, digest })
      ).toEqual({
        result: { ok: false, reauthenticate: true }
      })
    }

    expect(
      await matrixAgentSdkRefresh({
        handle: 'handle',
        expected: 'handle',
        configuration: () => {
          throw new Error('matrix_agent_unavailable')
        },
        holds: undefined,
        digest
      })
    ).toEqual({ result: { ok: false, reauthenticate: true } })
  })

  it('keeps a host signed in when the vault could not be read just now', async () => {
    expect(
      await matrixAgentSdkRefresh({
        handle: 'handle',
        expected: 'handle',
        configuration: () => {
          throw new Error('matrix_vault_unavailable')
        },
        holds: digest('old'),
        digest
      })
    ).toEqual({ result: { ok: false, reauthenticate: false } })

    // Readable again: the renewed token is handed over as usual.
    expect(
      await matrixAgentSdkRefresh({
        handle: 'handle',
        expected: 'handle',
        configuration: () => configuration('renewed'),
        holds: digest('old'),
        digest
      })
    ).toMatchObject({ result: { ok: true, accessToken: 'renewed' } })
  })

  it("waits for main's renewal in flight before answering that nothing is newer", async () => {
    vi.useFakeTimers()
    let token = 'old'
    let renewed!: () => void

    const renewing = new Promise<void>(resolve => {
      renewed = () => {
        token = 'renewed'
        resolve()
      }
    })

    const answer = matrixAgentSdkRefresh({
      handle: 'handle',
      expected: 'handle',
      configuration: () => configuration(token),
      holds: digest('old'),
      digest,
      renewing: () => renewing
    })

    await vi.advanceTimersByTimeAsync(1_000)
    renewed()

    expect(await answer).toEqual({
      result: { ok: true, accessToken: 'renewed', refreshToken: 'handle' },
      holds: digest('renewed')
    })
  })

  it('waits at most its bound for a renewal that does not finish, then reports nothing newer', async () => {
    vi.useFakeTimers()

    const answer = matrixAgentSdkRefresh({
      handle: 'handle',
      expected: 'handle',
      configuration: () => configuration('old'),
      holds: digest('old'),
      digest,
      renewing: () => new Promise(() => {}),
      waitMs: 15_000
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(await answer).toEqual({ result: { ok: false, reauthenticate: false } })
  })

  it("by default waits out a renewal's worst case: a domain-grant refresh and two 10 s requests", async () => {
    vi.useFakeTimers()
    let token = 'old'

    const answer = matrixAgentSdkRefresh({
      handle: 'handle',
      expected: 'handle',
      configuration: () => configuration(token),
      holds: digest('old'),
      digest,
      renewing: () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            token = 'renewed'
            resolve()
          }, 40_000)
        )
    })

    await vi.advanceTimersByTimeAsync(40_000)
    expect(await answer).toMatchObject({ result: { ok: true, accessToken: 'renewed' } })
    expect(MATRIX_AGENT_REFRESH_WAIT_MS).toBeGreaterThan(40_000)
  })

  it('does not wait on a renewal when it can answer at once', async () => {
    const renewing = vi.fn(() => new Promise<void>(() => {}))

    await expect(
      matrixAgentSdkRefresh({
        handle: 'handle',
        expected: 'handle',
        configuration: () => configuration('renewed'),
        holds: digest('old'),
        digest,
        renewing
      })
    ).resolves.toMatchObject({ result: { ok: true } })
    await expect(
      matrixAgentSdkRefresh({
        handle: 'other',
        expected: 'handle',
        configuration: () => configuration('x'),
        holds: undefined,
        digest,
        renewing
      })
    ).resolves.toEqual({ result: { ok: false, reauthenticate: true } })
    expect(renewing).not.toHaveBeenCalled()
  })

  it("gives only agents' hosts a refresh handle: never the person's or an app's", () => {
    const account = {
      sdkConfiguration: () => ({ ...configuration('human'), userId: '@owner:test', deviceId: 'OWNER' }),
      agentSdkConfiguration: () => configuration('agent')
    }

    const agent = { userId: '@agent:test', deviceId: 'AGENT' }
    expect(boundSdkConfiguration(account, 'agent', agent, 'handle').refreshToken).toBe('handle')
    expect(
      boundSdkConfiguration(account, 'agent:00000000-0000-4000-8000-3d68c3458eb4', agent, 'handle').refreshToken
    ).toBe('handle')
    expect(boundSdkConfiguration(account, 'agent', agent)).not.toHaveProperty('refreshToken')
    expect(boundSdkConfiguration(account, 'app:river', agent, 'handle')).not.toHaveProperty('refreshToken')
    const human = boundSdkConfiguration(account, 'human', { userId: '@owner:test', deviceId: 'OWNER' }, 'handle')
    expect(human).not.toHaveProperty('refreshToken')
    expect(human.threadSupport).toBe(true)
    expect(boundSdkConfiguration(account, 'agent', agent)).not.toHaveProperty('threadSupport')
    expect(boundSdkConfiguration(account, 'app:river', agent)).not.toHaveProperty('threadSupport')
    expect(['human', 'agent', 'agent:x', 'app:river'].map(role => matrixAgentRenews(role as never))).toEqual([
      false,
      true,
      true,
      false
    ])
  })
})
