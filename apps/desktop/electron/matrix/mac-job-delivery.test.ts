import { expect, it, vi } from 'vitest'

import { MATRIX_CRON_STRANDED, type MatrixCronPost } from './cron-delivery'
import { assertMacJobDeliveryHome, drainMacJobs, settleMacJobDelivery } from './mac-job-delivery'
import type { MacJobsClient } from './mac-jobs'

it('settles and records the same event through the occurrence route, refusing lease loss', async () => {
  const occurrence = vi.fn().mockResolvedValueOnce({ occurrenceId: 'run', state: 'completed', outcome: 'answered' })
    .mockResolvedValueOnce({ occurrenceId: 'run', publishedEvent: '$event' })
    .mockResolvedValueOnce({ code: 'lease_lost' })

  const client = { occurrence } as unknown as Pick<MacJobsClient, 'occurrence'>

  const post: MatrixCronPost = { roomId: '!room', text: 'answer', jobId: 'brief', runId: 'run', since: 1,
    occurrence: { assistantId: 'assistant', executorId: 'executor', occurrenceId: 'run', computeSeconds: 15, home: { homeId: 'home', homeEpoch: 1, executorTerm: 1, leaseId: 'lease' } } }

  const signal = new AbortController().signal
  await settleMacJobDelivery(client, post, '$event', signal)
  expect(occurrence.mock.calls.map(call => call[1])).toEqual([
    { executorId: 'executor', protocol: 3, occurrenceId: 'run', operation: 'complete', outcome: 'answered', usage: { computeSeconds: 15 } },
    { executorId: 'executor', protocol: 3, occurrenceId: 'run', operation: 'published', publishedEvent: '$event' }
  ])
  await expect(settleMacJobDelivery(client, post, '$event', signal)).rejects.toThrow('matrix_cron_settlement_unavailable')
  expect(occurrence).toHaveBeenCalledTimes(3)
})

it('replays lost completion before D1 publication without settling twice', async () => {
  const { completeMacJobDelivery } = await import('./mac-job-delivery')
  const { MatrixCronDelivery } = await import('./cron-delivery')
  const records = new Map<string, string>()
  let state = 'dispatched', settlements = 0, sends = 0
  let publishedEvent: string | undefined

  const occurrence = vi.fn(async (_assistant, request) => {
    if (request.operation === 'complete' && state !== 'completed') {
      state = 'completed'
      settlements++
      throw Error('lost_completion_response')
    }

    if (request.operation === 'published') { publishedEvent = request.publishedEvent }

    return { occurrenceId: 'run', state, outcome: 'answered', publishedEvent }
  })

  const client = { occurrence } as unknown as Pick<MacJobsClient, 'occurrence'>
  const signal = new AbortController().signal

  const make = () => new MatrixCronDelivery({
    store: { getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value) } },
    requireRoom: async () => {}, find: async () => ({ state: 'absent' }),
    authorizeManaged: async post => { await completeMacJobDelivery(client, post, signal) },
    publish: async () => {
      if (state !== 'completed') { throw Error('wrong_operation') }
      sends++

      return '$event'
    },
    settleManaged: (post, eventId) => settleMacJobDelivery(client, post, eventId, signal), log: () => {}
  })

  await expect(make().deliverManaged({ requestId: 'a', roomId: '!room:test', text: 'saved output', jobId: 'brief', runId: 'run' },
    { assistantId: 'assistant', executorId: 'executor', occurrenceId: 'run', computeSeconds: 15, home: { homeId: 'home', homeEpoch: 1, executorTerm: 1, leaseId: 'lease' } }))
    .rejects.toThrow('managed_delivery_pending')
  expect(sends).toBe(0)
  await make().resumeManaged(new AbortController().signal)
  await make().resumeManaged(new AbortController().signal)
  expect(settlements).toBe(1)
  expect(sends).toBe(1)
  expect(publishedEvent).toBe('$event')
})

it('lets only the home and term that ran an occurrence publish it', () => {
  const home = { homeId: 'home', homeEpoch: 1, executorTerm: 1, leaseId: 'lease' }

  const post = { roomId: '!room', text: 'answer', jobId: 'brief', runId: 'run', since: 1,
    occurrence: { assistantId: 'assistant', executorId: 'executor', occurrenceId: 'run', computeSeconds: 1, home } } as MatrixCronPost

  const fence = { ...home, ownerUserId: '@owner:test', agentPrincipal: 'agent', leaseExpiresAtPlatform: 10 }
  expect(() => assertMacJobDeliveryHome(post, fence)).not.toThrow()
  expect(() => assertMacJobDeliveryHome(post, null)).toThrow('mac_job_not_home')

  for (const changed of [{ homeEpoch: 2 }, { executorTerm: 2 }, { leaseId: 'other' }, { homeId: 'other' }]) {
    expect(() => assertMacJobDeliveryHome(post, { ...fence, ...changed })).toThrow(MATRIX_CRON_STRANDED)
  }
})

it('drains managed deliveries after stopping admission, and lets the move proceed at its deadline', async () => {
  const order: string[] = []
  const lifecycle = { stop: vi.fn(() => void order.push('stop')), drained: vi.fn(async () => void order.push('drained')) }

  const delivery = { resumeManaged: vi.fn(async () => { order.push('deliveries');

 return { left: 0 } }) }

  const log = vi.fn()
  await drainMacJobs({ lifecycle, delivery, deadline: new AbortController().signal, log })
  expect(order).toEqual(['stop', 'drained', 'deliveries'])
  expect(log).not.toHaveBeenCalled()

  // A run that will not finish, and deliveries that cannot settle, still give way to the deadline.
  const deadline = AbortSignal.timeout(10)
  const stuck = { stop: vi.fn(), drained: () => new Promise<void>(() => {}) }

  const left = { resumeManaged: vi.fn(async (signal: AbortSignal) => { expect(signal).toBe(deadline);

 return { left: 2 } }) }

  await expect(drainMacJobs({ lifecycle: stuck, delivery: left, deadline, log })).resolves.toBeUndefined()
  expect(stuck.stop).toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith('[Matrix] managed job deliveries left with the source home: 2')
})
