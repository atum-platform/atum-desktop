import { createHash, verify } from 'node:crypto'

import { expect, it } from 'vitest'

import { canonicalJson } from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/host-fs'
import { ModelGrantRegistry } from '../../../../packages/model-client/src/model-grants'

import { MAC_JOB_MODEL_SIGNATURE_HEADER, macJobModelUpstream } from './mac-job-model'
import { fixture } from './mac-jobs.fixture'

it('uses occurrence grant and freshly signed MAS admission for every call, never controller credentials', async () => {
  const f = fixture(), token = 'g'.repeat(43)
  const grant = new ModelGrantRegistry().admit(token, { taskId: f.assistantId, aliases: ['atum'], expiresAt: Date.now() + 60000 })
  let calls = 0
  const sequences: number[] = []

  const upstream = macJobModelUpstream({ ...f.options, assistantId: f.assistantId, baseUrl: 'https://gateway.test/v1',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers)
      expect(String(url)).toBe('https://gateway.test/v1/chat/completions')
      expect(headers.get('authorization')).toBe('Bearer mas-bearer')
      expect(headers.has('x-atum-controller')).toBe(false)
      expect(headers.get('x-atum-model-grant')).toBe(token)
      const frame = JSON.parse(Buffer.from(headers.get(MAC_JOB_MODEL_SIGNATURE_HEADER)!, 'base64url').toString())
      expect(JSON.stringify(frame)).not.toContain(token)
      expect(frame.request).toEqual({ method: 'POST', path: '/v1/chat/completions', grantDigest: createHash('sha256').update(token).digest('hex') })
      const { signature, ...meta } = frame.meta
      expect(verify('sha256', Buffer.from(`atum.agent-home/2.1\0MacJobModel\0${canonicalJson({ ...frame, meta })}`),
        { key: f.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
      sequences.push(meta.sequence)
      calls++

      return new Response(JSON.stringify({ choices: [] }), { headers: { 'content-type': 'application/json' } })
    } })

  const request = { body: { model: 'atum', messages: [] }, token, grant, signal: new AbortController().signal }
  await upstream.complete(request)
  await upstream.complete(request)
  expect(calls).toBe(2)
  expect(sequences[1]).toBeGreaterThan(sequences[0]!)
  f.authority.mockResolvedValueOnce(null as never)
  await expect(upstream.complete(request)).rejects.toThrow('mac_job_not_home')
  expect(calls).toBe(2)
})

it.each(['revoked', 'expired', 'foreign', 'lease_lost'])('does not retry or fall back when gateway refuses %s', async reason => {
  const f = fixture(), token = 'g'.repeat(43)
  const grant = new ModelGrantRegistry().admit(token, { taskId: f.assistantId, aliases: ['atum'], expiresAt: Date.now() + 60000 })
  let redemptions = 0

  const upstream = macJobModelUpstream({ ...f.options, assistantId: f.assistantId, baseUrl: 'https://gateway.test/v1',
    fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get('x-atum-model-grant')).toBe(token)
      redemptions++

      return new Response(JSON.stringify({ error: reason }), { status: reason === 'lease_lost' ? 409 : 403,
        headers: { 'content-type': 'application/json' } })
    } })

  const result = await upstream.complete({ body: { model: 'atum', messages: [] }, token, grant, signal: new AbortController().signal })
  expect(result.json).toEqual({ error: reason })
  expect(redemptions).toBe(1)
})

it('reuses the upstream SSE decoder without exposing credentials in streamed output', async () => {
  const f = fixture(), token = 'g'.repeat(43)
  const grant = new ModelGrantRegistry().admit(token, { taskId: f.assistantId, aliases: ['atum'], expiresAt: Date.now() + 60000 })

  const upstream = macJobModelUpstream({ ...f.options, assistantId: f.assistantId, baseUrl: 'https://gateway.test/v1',
    fetch: async () => new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) })

  const result = await upstream.stream({ body: { model: 'atum', messages: [], stream: true }, token, grant, signal: new AbortController().signal })
  expect('events' in result).toBe(true)

  if ('events' in result) {
    const events = []

    for await (const event of result.events) {events.push(event)}
    expect(events).toEqual([{ data: { choices: [] } }, { done: true }])
  }
})
