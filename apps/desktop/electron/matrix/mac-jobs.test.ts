import { randomUUID, verify } from 'node:crypto'

import { expect, it } from 'vitest'

import { canonicalJson } from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/host-fs'

import { fixture } from './mac-jobs.fixture'

const signal = () => new AbortController().signal

it('uses assistant path, MAS bearer and a real P1363 signature over protocol canonical bytes', async () => {
  const f = fixture()
  await f.client.fire(f.assistantId, f.claim, signal())
  const frame = f.sent[0], { signature, ...meta } = frame.body.meta
  expect(frame.url).toBe(`https://shell.test/api/matrix/v1/agents/${f.assistantId}/jobs/fire`)
  expect(frame.headers.Authorization).toBe('Bearer mas-bearer')
  expect(frame.body.home).toEqual(f.home)
  const bytes = Buffer.from(`atum.agent-home/2.1\0MacJobFire\0${canonicalJson({ ...frame.body, meta })}`)
  expect(verify('sha256', bytes, { key: f.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
})
it('shares D1 sequence and signs each bearer attempt afresh without changing business identity', async () => {
  const f = fixture(), previous = await f.auth.sign('ReadinessReport', meta => ({ meta }))

  f.options.request = async send => { await send('old', 'https://shell.test/api/matrix/v1');

 return send('new', 'https://shell.test/api/matrix/v1') }

  await f.client.fire(f.assistantId, f.claim, signal())
  expect(f.sent[0].body.meta.sequence).toBeGreaterThan(previous.meta.sequence)
  expect(f.sent[1].body.meta.sequence).toBeGreaterThan(f.sent[0].body.meta.sequence)
  expect(f.sent[1].body.meta.commandId).not.toBe(f.sent[0].body.meta.commandId)
  expect(f.sent[1].body.meta.nonce).not.toBe(f.sent[0].body.meta.nonce)
  expect(f.sent[1].body.request).toEqual(f.sent[0].body.request)
  expect(f.authority).toHaveBeenCalledTimes(2)
})
it('returns lease_lost without retry and never sends without a current home', async () => {
  const f = fixture(), refusal = { profile: 'atum.mac-job-fire/1', code: 'lease_lost', detail: { kind: 'placement_authority', reason: 'stale_home_epoch' } }
  f.respond(refusal, 409)
  expect(await f.client.fire(f.assistantId, f.claim, signal())).toEqual(refusal)
  f.authority.mockResolvedValueOnce(null as never)
  await expect(f.client.fire(f.assistantId, f.claim, signal())).rejects.toThrow('mac_job_not_home')
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})
it('does not replay dispatch after response loss or expose error details', async () => {
  const f = fixture()
  f.fetcher.mockRejectedValueOnce(new Error('private-token'))
  await expect(f.client.occurrence(f.assistantId, { operation: 'dispatch', protocol: 3, executorId: randomUUID(),
    occurrenceId: randomUUID(), leaseToken: f.home.leaseId }, signal())).rejects.toThrow('mac_job_unavailable')
  expect(f.fetcher).toHaveBeenCalledTimes(1)
})
it('rechecks grants each call, retains the MAS bearer and signs the grant body', async () => {
  const f = fixture(), token = 'x'.repeat(43)
  f.respond({ state: 'revoked' })
  await f.client.grant(f.assistantId, { token }, signal())
  await f.client.grant(f.assistantId, { token }, signal())
  expect(f.authority).toHaveBeenCalledTimes(2)
  expect(f.sent[0].body.request).toEqual({ token })
  expect(f.sent[0].headers.Authorization).toBe('Bearer mas-bearer')
  const { signature, ...meta } = f.sent[0].body.meta
  const bytes = Buffer.from(`atum.agent-home/2.1\0MacJobGrant\0${canonicalJson({ ...f.sent[0].body, meta })}`)
  expect(verify('sha256', bytes, { key: f.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
})
it('rejects extra fields, mismatched HTTP status, invalid requests and cancellation', async () => {
  const f = fixture()
  f.respond({ state: 'revoked', unexpected: true })
  await expect(f.client.grant(f.assistantId, { token: 'x'.repeat(43) }, signal())).rejects.toThrow('mac_job_unavailable')
  f.respond({ state: 'revoked' }, 503)
  await expect(f.client.grant(f.assistantId, { token: 'x'.repeat(43) }, signal())).rejects.toThrow('mac_job_unavailable')
  await expect(f.client.grant(f.assistantId, { token: 'bad' }, signal())).rejects.toThrow('mac_job_invalid')
  const stop = new AbortController(); stop.abort()
  await expect(f.client.fire(f.assistantId, f.claim, stop.signal)).rejects.toThrow('mac_job_unavailable')
  expect(f.fetcher).toHaveBeenCalledTimes(2)
})

it('preserves occurrence identity and stored delivery receipt on settlement retry', async () => {
  const f = fixture(), occurrenceId = randomUUID(), executorId = randomUUID()
  const request = { operation: 'published' as const, protocol: 3 as const, executorId, occurrenceId, publishedEvent: '$delivered' }

  const receipt = { occurrenceId, executorId, state: 'completed', scheduleId: 'routine_1', occurrenceAt: 1000,
    agentPrincipal: f.home.agentPrincipal, roomId: '!room:atum.test', publishedEvent: '$delivered', outcome: 'answered' }

  f.respond(receipt)
  expect(await f.client.occurrence(f.assistantId, request, signal())).toEqual(receipt)
  expect(await f.client.occurrence(f.assistantId, request, signal())).toEqual(receipt)
  expect(f.sent[1].body.request).toEqual(request)
  expect(f.sent[1].body.meta.commandId).not.toBe(f.sent[0].body.meta.commandId)
  const { signature, ...meta } = f.sent[0].body.meta
  const bytes = Buffer.from(`atum.agent-home/2.1\0MacJobOccurrence\0${canonicalJson({ ...f.sent[0].body, meta })}`)
  expect(verify('sha256', bytes, { key: f.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
})

it('signs the pending snapshot body with shared D1 metadata and preserves platform selection', async () => {
  const f = fixture()

  for (const selected of [false, true]) {
    const result = { profile: 'atum.mac-job-snapshot/1', selected, generation: selected ? 'a'.repeat(64) : null,
      managedJobIds: selected ? ['routine_1'] : [] }

    f.respond(result)
    expect(await f.client.snapshot(f.assistantId, signal())).toEqual(result)
    const frame = f.sent.at(-1)!, { signature, ...meta } = frame.body.meta
    expect(frame.url).toContain('/jobs/snapshot')
    expect(frame.body).toEqual({ profile: 'atum.mac-job-snapshot/1', home: f.home, meta: frame.body.meta })
    const bytes = Buffer.from(`atum.agent-home/2.1\0MacJobSnapshot\0${canonicalJson({ ...frame.body, meta })}`)
    expect(verify('sha256', bytes, { key: f.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  }
})

it('retries explicit busy with bounded backoff and fresh D1 signing on every attempt', async () => {
  const f = fixture()
  const waits: number[] = []

  f.options.wait = async ms => { waits.push(ms) }
  f.respond({ profile: 'atum.mac-job-fire/1', code: 'busy' }, 429)
  expect(await f.client.fire(f.assistantId, f.claim, signal())).toMatchObject({ code: 'busy' })
  expect(waits).toEqual([250, 500, 1000])
  expect(f.sent).toHaveLength(4)

  for (let i = 1; i < f.sent.length; i++) {
    expect(f.sent[i].body.request).toEqual(f.claim)
    expect(f.sent[i].body.meta.sequence).toBeGreaterThan(f.sent[i - 1].body.meta.sequence)
    expect(f.sent[i].body.meta.commandId).not.toBe(f.sent[i - 1].body.meta.commandId)
    expect(f.sent[i].body.meta.nonce).not.toBe(f.sent[i - 1].body.meta.nonce)
  }
})

it('returns dispatch conflict once for occurrence/outbox reconciliation without replay', async () => {
  const f = fixture()
  f.respond({ profile: 'atum.mac-job-fire/1', code: 'conflict' }, 409)
  expect(await f.client.occurrence(f.assistantId, { operation: 'dispatch', protocol: 3,
    executorId: randomUUID(), occurrenceId: randomUUID(), leaseToken: f.home.leaseId }, signal()))
    .toMatchObject({ code: 'conflict' })
  expect(f.sent).toHaveLength(1)
})

it('stops busy retries when cancelled during backoff', async () => {
  const f = fixture(), stop = new AbortController()
  f.respond({ profile: 'atum.mac-job-fire/1', code: 'busy' }, 429)

  f.options.wait = async () => { stop.abort() }
  await expect(f.client.fire(f.assistantId, f.claim, stop.signal)).rejects.toThrow('mac_job_unavailable')
  expect(f.sent).toHaveLength(1)
})

it('settles an existing receipt with current authority after an executor term change', async () => {
  const f = fixture(), occurrenceId = randomUUID(), executorId = randomUUID()
  const request = { operation: 'published' as const, protocol: 3 as const, executorId, occurrenceId, publishedEvent: '$stable' }

  const result = { occurrenceId, executorId, state: 'completed', scheduleId: 'routine', occurrenceAt: 1000,
    agentPrincipal: f.home.agentPrincipal, roomId: '!home:test', outcome: 'answered', publishedEvent: '$stable' }

  f.respond(result)
  await f.client.occurrence(f.assistantId, request, signal())
  f.authority.mockResolvedValueOnce({ ...f.home, executorTerm: f.home.executorTerm + 1, leaseId: randomUUID() })
  expect(await f.client.occurrence(f.assistantId, request, signal())).toEqual(result)
  expect(f.sent[1].body.home.executorTerm).toBe(f.sent[0].body.home.executorTerm + 1)
  expect(f.sent[1].body.request).toEqual(f.sent[0].body.request)
})
