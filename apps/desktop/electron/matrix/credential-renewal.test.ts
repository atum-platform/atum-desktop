import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixInvocationResult, MatrixInvocationWatch } from '../../shared/matrix'

import {
  MATRIX_CREDENTIAL_RENEWAL,
  MatrixCredentialRenewal,
  matrixRenewedWatchEnd,
  renewMatrixAgentHost
} from './credential-renewal'
import { MatrixEnrollmentRateLimited } from './enrollment'
import { MatrixHermesListener } from './hermes-listener'
import { LOCAL_TURN_LIMIT_MS } from './local-authority'
import { MatrixSdkHost } from './sdk-host'

const minute = 60_000
const start = new Date('2026-09-29T10:00:00.000Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
})

afterEach(() => {
  vi.useRealTimers()
})

/** One agent's credential: renewing moves its expiry an hour past the moment of renewal,
 * as the platform's rotation does. */
function fixture(
  options: {
    expiresAt?: number
    renew?: () => Promise<unknown>
    busy?: () => boolean
    random?: number
  } = {}
) {
  let expiresAt: number | undefined = options.expiresAt ?? start + 60 * minute
  const log: string[] = []
  const renewals: number[] = []

  const renew = vi.fn(
    options.renew ??
      (async () => {
        renewals.push(Date.now())
        expiresAt = Date.now() + 60 * minute
      })
  )

  const renewal = new MatrixCredentialRenewal({
    label: 'agent 1a2b3c4d',
    expiresAt: () => expiresAt,
    renew,
    busy: options.busy,
    log: line => log.push(line),
    random: () => options.random ?? 0
  })

  return {
    renewal,
    renew,
    renewals,
    log,
    expire: (value: number | undefined) => {
      expiresAt = value
    }
  }
}

describe('when a renewal runs', () => {
  it('renews half an hour ahead, no sooner, and again half an hour before the new expiry', async () => {
    const { renewal, renewals } = fixture()
    renewal.start()

    await vi.advanceTimersByTimeAsync(30 * minute - 1)
    expect(renewals).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(renewals).toEqual([start + 30 * minute])

    // The new credential lasts an hour from its renewal; the next renewal is half an hour in.
    await vi.advanceTimersByTimeAsync(30 * minute)
    expect(renewals).toEqual([start + 30 * minute, start + 60 * minute])
  })

  it('keeps an hour-long credential alive through a turn as long as the longest one, never letting it lapse', async () => {
    // A turn keeps going as long as activity does (LOCAL_TURN_LIMIT_MS is quiet time, not a wall
    // clock), longer than a credential lasts: the agent is busy all along, and each renewal still
    // lands before the expiry it replaces.
    const expiries: number[] = []
    const { renewal, renewals } = fixture({ busy: () => true })
    expiries.push(start + 60 * minute)
    renewal.start()

    await vi.advanceTimersByTimeAsync(LOCAL_TURN_LIMIT_MS)
    expect(renewals.length).toBeGreaterThanOrEqual(Math.floor(LOCAL_TURN_LIMIT_MS / (60 * minute)))

    for (const [index, at] of renewals.entries()) {
      expect(at).toBeLessThan(expiries[index]!)
      expiries.push(at + 60 * minute)
    }

    expect(expiries.at(-1)!).toBeGreaterThan(start + LOCAL_TURN_LIMIT_MS)
    // Renewal leads well inside the credential's hour, whatever the turn limit.
    expect(MATRIX_CREDENTIAL_RENEWAL.leadMs + MATRIX_CREDENTIAL_RENEWAL.jitterMs).toBeLessThan(60 * minute)
  })

  it('spreads agents by up to four minutes earlier, never later', async () => {
    const { renewal, renewals } = fixture({ random: 1 })
    renewal.start()

    await vi.advanceTimersByTimeAsync(26 * minute)
    expect(renewals).toEqual([start + 26 * minute])
  })

  it('renews at once a credential that is already within the half hour', async () => {
    const { renewal, renewals } = fixture({ expiresAt: start + 20 * minute })
    renewal.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(renewals).toEqual([start])
  })

  it('never starts in the last two minutes: the credential ends at its expiry', async () => {
    const { renewal, renew, log } = fixture({ expiresAt: start + 2 * minute })
    renewal.start()

    await vi.advanceTimersByTimeAsync(10 * minute)
    expect(renew).not.toHaveBeenCalled()
    expect(log).toEqual(['[Matrix] agent 1a2b3c4d credential not renewed in time; it ends at its expiry'])
  })

  it('does nothing without a credential', async () => {
    const { renewal, renew } = fixture()
    renewal.start()
    renewal.stop()

    const idle = fixture()
    idle.expire(undefined)
    idle.renewal.start()

    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    expect(renew).not.toHaveBeenCalled()
    expect(idle.renew).not.toHaveBeenCalled()
  })
})

describe('when the agent is busy', () => {
  it('waits for the turn to end, checking every five seconds', async () => {
    let busy = true
    const { renewal, renewals } = fixture({ expiresAt: start + 30 * minute, busy: () => busy })
    renewal.start()

    await vi.advanceTimersByTimeAsync(12_000)
    expect(renewals).toEqual([])

    busy = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(renewals).toEqual([start + 15_000])
  })

  it('renews anyway after two minutes of waiting', async () => {
    const { renewal, renewals } = fixture({ expiresAt: start + 30 * minute, busy: () => true })
    renewal.start()

    await vi.advanceTimersByTimeAsync(2 * minute + 5_000)
    expect(renewals).toEqual([start + 2 * minute])
  })
})

describe('when a renewal fails', () => {
  it('retries a transient failure with backoff, keeping the credential until it succeeds', async () => {
    let failures = 2
    const renewals: number[] = []

    const { renewal, log } = fixture({
      expiresAt: start + 30 * minute,
      renew: async () => {
        renewals.push(Date.now())

        if (failures-- > 0) {
          throw new Error('matrix_enrollment_unavailable')
        }
      },
      random: 0.5
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(renewals).toEqual([start, start + 15_000, start + 45_000])
    expect(log).toEqual([
      '[Matrix] agent 1a2b3c4d credential renewal failed: matrix_enrollment_unavailable; next try in 15 s',
      '[Matrix] agent 1a2b3c4d credential renewal failed: matrix_enrollment_unavailable; next try in 30 s',
      expect.stringMatching(/^\[Matrix\] agent 1a2b3c4d credential renewed ms=\d+$/)
    ])
  })

  it('waits exactly the Retry-After of a 429, instead of its own backoff', async () => {
    const renewals: number[] = []
    let limited = true

    const { renewal, log } = fixture({
      expiresAt: start + 30 * minute,
      renew: async () => {
        renewals.push(Date.now())

        if (limited) {
          limited = false
          throw new MatrixEnrollmentRateLimited(7 * minute)
        }
      }
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(7 * minute - 1)
    expect(renewals).toEqual([start])

    await vi.advanceTimersByTimeAsync(1)
    expect(renewals).toEqual([start, start + 7 * minute])
    expect(log[0]).toBe('[Matrix] agent 1a2b3c4d credential renewal asked to wait; next try in 420 s')
  })

  it('leaves the credential to its expiry when Retry-After is later than the last safe moment', async () => {
    const { renewal, renew, log } = fixture({
      expiresAt: start + 20 * minute,
      renew: async () => {
        throw new MatrixEnrollmentRateLimited(60 * minute)
      }
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)

    expect(renew).toHaveBeenCalledOnce()
    expect(log.at(-1)).toBe('[Matrix] agent 1a2b3c4d credential not renewed in time; it ends at its expiry')
  })

  it.each([
    'matrix_enrollment_denied',
    'matrix_enrollment_invalid',
    'matrix_agent_unavailable',
    'matrix_login_cancelled',
    'matrix_domain_signed_out'
  ])('stops for good on %s', async code => {
    const { renewal, renew, log } = fixture({
      expiresAt: start + 30 * minute,
      renew: async () => {
        throw new Error(code)
      }
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)
    renewal.resume()
    await vi.advanceTimersByTimeAsync(minute)

    expect(renew).toHaveBeenCalledOnce()
    expect(log).toEqual([`[Matrix] agent 1a2b3c4d credential renewal stopped: ${code}; it ends at its expiry`])
  })

  it('names an unexpected failure without its message', async () => {
    const { renewal, log } = fixture({
      expiresAt: start + 30 * minute,
      renew: async () => {
        throw new Error('token=secret-looking value')
      },
      random: 0.5
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(log).toEqual(['[Matrix] agent 1a2b3c4d credential renewal failed: unexpected; next try in 15 s'])
  })
})

describe('stopping and waking', () => {
  it('ignores a renewal that answers after the host stopped, and schedules nothing more', async () => {
    let answer!: () => void

    const { renewal, renew, log } = fixture({
      expiresAt: start + 30 * minute,
      renew: () =>
        new Promise<void>(resolve => {
          answer = resolve
        })
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    renewal.stop()
    answer()
    await vi.advanceTimersByTimeAsync(2 * 60 * minute)

    expect(renew).toHaveBeenCalledOnce()
    expect(log).toEqual([])
  })

  it('runs one renewal at a time', async () => {
    let answer!: () => void

    const { renewal, renew } = fixture({
      expiresAt: start + 30 * minute,
      renew: () =>
        new Promise<void>(resolve => {
          answer = resolve
        })
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    renewal.resume()
    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(renew).toHaveBeenCalledOnce()
    answer()
  })

  it('reschedules from the wall clock after sleep, when timers were paused', async () => {
    const { renewal, renewals } = fixture()
    renewal.start()

    // The Mac slept 40 minutes: the wall clock moved, the timers did not.
    vi.setSystemTime(start + 40 * minute)
    renewal.resume()
    await vi.advanceTimersByTimeAsync(0)

    expect(renewals).toEqual([start + 40 * minute])
  })
})

describe('applying a renewal to the running host', () => {
  const identity = {
    issuer: 'https://id.test/',
    subject: 'alice',
    principal: '12345678-1234-1234-1234-123456789abc',
    executorId: '22345678-1234-1234-1234-123456789abc',
    agentPrincipal: '32345678-1234-1234-1234-123456789abc',
    userId: '@agent:test',
    deviceId: 'AGENT',
    expiresAt: start + 90 * minute
  }

  function target(overrides: Partial<Parameters<typeof renewMatrixAgentHost>[0]> = {}) {
    const calls: string[] = []

    return {
      calls,
      host: {
        current: () => true,
        identity: { userId: '@agent:test', deviceId: 'AGENT' },
        rotate: vi.fn(async () => ({ state: 'ready' as const, identity })),
        expireAt: (at: number) => void calls.push(`expire ${at - start}`),
        notify: () => void calls.push('notify'),
        extend: (at: number) => void calls.push(`extend ${at - start}`),
        changed: () => void calls.push('changed'),
        ...overrides
      }
    }
  }

  it("moves the host's end, tells its SDK, then moves its watch, in one turn of the event loop", async () => {
    const { host, calls } = target()
    await renewMatrixAgentHost(host)

    expect(calls).toEqual([`expire ${90 * minute}`, 'notify', `extend ${90 * minute}`, 'changed'])
  })

  it('applies nothing to a host that ended, or started as another device, meanwhile', async () => {
    let current = true

    const ended = target({
      current: () => current,
      rotate: vi.fn(async () => {
        current = false

        return { state: 'ready' as const, identity }
      })
    })

    await expect(renewMatrixAgentHost(ended.host)).rejects.toThrow('matrix_agent_unavailable')
    expect(ended.calls).toEqual([])

    const other = target({ identity: { userId: '@agent:test', deviceId: 'ELSEWHERE' } })
    await expect(renewMatrixAgentHost(other.host)).rejects.toThrow('matrix_enrollment_invalid')
    expect(other.calls).toEqual([])

    const gone = target({ current: () => false })
    await expect(renewMatrixAgentHost(gone.host)).rejects.toThrow('matrix_agent_unavailable')
    expect(gone.host.rotate).not.toHaveBeenCalled()
  })

  it('keeps a continuous watch to the renewed expiry, and a temporary one to its own quarter hour', () => {
    const watch = { roomId: '!room:test', since: start }
    const temporary = 15 * minute

    expect(matrixRenewedWatchEnd(watch, start + 90 * minute, '!room:test', temporary)).toBe(start + 90 * minute)
    expect(matrixRenewedWatchEnd(watch, start + 90 * minute, undefined, temporary)).toBe(start + 15 * minute)
    expect(matrixRenewedWatchEnd(watch, start + 90 * minute, '!other:test', temporary)).toBe(start + 15 * minute)
    expect(matrixRenewedWatchEnd(watch, start + 10 * minute, undefined, temporary)).toBe(start + 10 * minute)
  })
})

/**
 * The pieces main composes, run together: the real schedule, listener and SDK queue, with the
 * platform's rotation faked. A turn running across the old expiry goes on; the SDK hears
 * `renewed` and then the same watch with its later end.
 */
describe('renewal composed with a running turn', () => {
  it('keeps the agent answering through its old expiry', async () => {
    let expiresAt = start + 31 * minute
    const sent: Array<{ kind: string; watch?: MatrixInvocationWatch }> = []

    const queue = new MatrixSdkHost(
      (_id, value) => sent.push(value as { kind: string; watch?: MatrixInvocationWatch }),
      () => {}
    )

    let turn: AbortSignal | undefined

    const listener = new MatrixHermesListener(
      (_target, _watch, signal) => {
        turn = signal

        return new Promise<MatrixInvocationResult>(() => {})
      },
      () => {}
    )

    const watch: MatrixInvocationWatch = {
      id: 'watch',
      roomId: '!room:test',
      since: start,
      until: expiresAt,
      sender: { userId: '@owner:test', deviceId: 'OWNER' }
    }

    listener.start(watch)
    listener.offer({ watchId: 'watch', roomId: '!room:test', eventId: '$long-turn' })
    let hostEnd = expiresAt

    const renewal = new MatrixCredentialRenewal({
      label: 'assistant',
      expiresAt: () => expiresAt,
      busy: () => false,
      log: () => {},
      random: () => 0,
      renew: () =>
        renewMatrixAgentHost({
          current: () => true,
          identity: { userId: '@agent:test', deviceId: 'AGENT' },
          rotate: async () => {
            expiresAt = Date.now() + 60 * minute

            return {
              state: 'ready',
              identity: {
                issuer: 'https://id.test/',
                subject: 'alice',
                principal: '12345678-1234-1234-1234-123456789abc',
                executorId: '22345678-1234-1234-1234-123456789abc',
                agentPrincipal: '32345678-1234-1234-1234-123456789abc',
                userId: '@agent:test',
                deviceId: 'AGENT',
                expiresAt
              }
            }
          },
          expireAt: at => {
            hostEnd = at
          },
          notify: () => void queue.command({ kind: 'renewed' }).catch(() => {}),
          extend: at => {
            const extended = listener.extend(current => matrixRenewedWatchEnd(current, at, '!room:test', 15 * minute))

            if (extended) {
              void queue.command({ kind: 'watchInvocations', watch: extended }).catch(() => {})
            }
          },
          changed: () => {}
        })
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(minute)

    expect(hostEnd).toBe(start + 61 * minute)
    expect(sent.map(value => value.kind)).toEqual(['renewed', 'watchInvocations'])
    expect(sent[1]!.watch).toMatchObject({ id: 'watch', until: start + 61 * minute })

    // Past the old expiry: the turn is still running and the watch still listening. Half an
    // hour before the renewed expiry, the next renewal moved both again.
    await vi.advanceTimersByTimeAsync(31 * minute)
    expect(turn?.aborted).toBe(false)
    expect(hostEnd).toBe(start + 91 * minute)
    expect(listener.snapshot()).toMatchObject({ state: 'listening', expiresAt: start + 91 * minute })
    expect(sent.map(value => value.kind)).toEqual(['renewed', 'watchInvocations', 'renewed', 'watchInvocations'])
    renewal.stop()
    listener.stop()
    queue.close()
  })
})

describe('behind an enrollment, and when the token is refused', () => {
  it("looks again later behind the agent's enrollment, and never rotates a credential that enrollment renewed", async () => {
    let expiresAt = start + 30 * minute
    const calls: number[] = []

    const renewal = new MatrixCredentialRenewal({
      label: 'agent 1a2b3c4d',
      expiresAt: () => expiresAt,
      renew: async () => {
        calls.push(Date.now())

        // The agent's enrollment is running, and renews the credential before this looks again.
        expiresAt = Date.now() + 60 * minute
        throw new Error('matrix_enrollment_pending')
      },
      log: () => {},
      random: () => 0.5
    })

    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([start])

    // It looks again after its backoff, finds the renewed credential not yet due, and waits.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toEqual([start])

    // Due again half an hour before the new expiry (two minutes of jitter at random 0.5).
    await vi.advanceTimersByTimeAsync(28 * minute - 15_000)
    expect(calls).toEqual([start, start + 28 * minute])
    renewal.stop()
  })

  it('does not rotate a credential renewed elsewhere while it waited, and schedules from the new expiry', async () => {
    let busy = true
    const f = fixture({ expiresAt: start + 30 * minute, busy: () => busy })
    f.renewal.start()
    await vi.advanceTimersByTimeAsync(0)

    // While it waits for the turn to end, an enrollment renews the credential.
    f.expire(start + 60 * minute)
    busy = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.renewals).toEqual([])

    await vi.advanceTimersByTimeAsync(30 * minute - 5_000)
    expect(f.renewals).toEqual([start + 30 * minute])
    f.renewal.stop()
  })

  it('runs a due renewal at once when the token is refused, even while the agent is busy', async () => {
    const { renewal, renewals } = fixture({ expiresAt: start + 30 * minute, busy: () => true })
    renewal.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(renewals).toEqual([])

    await renewal.expedite()
    expect(renewals).toEqual([start])
  })

  it('expedites nothing before its time, twice within a minute, while one runs, or once stopped', async () => {
    const early = fixture()
    early.renewal.start()
    expect(early.renewal.expedite()).toBeUndefined()
    expect(early.renew).not.toHaveBeenCalled()

    let answer!: () => void

    const running = fixture({
      expiresAt: start + 30 * minute,
      busy: () => true,
      renew: () =>
        new Promise<void>(resolve => {
          answer = resolve
        })
    })

    running.renewal.start()
    const first = running.renewal.expedite()
    expect(first).toBeDefined()
    expect(running.renewal.expedite()).toBeUndefined()
    answer()
    await first

    const twice = fixture({
      expiresAt: start + 30 * minute,
      busy: () => true,
      renew: async () => {
        throw new MatrixEnrollmentRateLimited(1_000)
      }
    })

    twice.renewal.start()
    await twice.renewal.expedite()
    vi.setSystemTime(start + 30_000)
    expect(twice.renewal.expedite()).toBeUndefined()

    const stopped = fixture({ expiresAt: start + 30 * minute })
    stopped.renewal.start()
    stopped.renewal.stop()
    expect(stopped.renewal.expedite()).toBeUndefined()
    expect(stopped.renew).not.toHaveBeenCalled()
  })

  it('starts the idle wait over after the Mac wakes', async () => {
    let busy = true
    const { renewal, renewals } = fixture({ expiresAt: start + 60 * minute, busy: () => busy })
    renewal.start()

    // Due at 30 minutes; busy from then.
    await vi.advanceTimersByTimeAsync(30 * minute + 60_000)
    expect(renewals).toEqual([])

    // Asleep for ten minutes, then awake and still busy: another two-minute wait, not a
    // renewal in the middle of the turn.
    vi.setSystemTime(start + 41 * minute)
    renewal.resume()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(renewals).toEqual([])

    busy = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(renewals.length).toBe(1)
  })
})
