import { describe, expect, it, vi } from 'vitest'

import { BrowserImportHttpError, type BrowserImportTransport, httpBrowserImportTransport } from './client'

const BASE = 'https://domain.atum.example/api/matrix/v1'
const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const COMPUTER = '00000000-0000-4000-8000-b454f82c5857'
const signal = new AbortController().signal

interface Seen {
  url: string
  method: string
  authorization: string | null
  contentType: string | null
  body: string | undefined
  redirect: RequestRedirect | undefined
}

function answer(status: number, body?: unknown, contentType = 'application/json'): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType }
  })
}

/** `account.s1Request` in miniature: the bearer, the base URL, and one refresh after a 401. */
function account(tokens: string[] = ['token-1', 'token-2']) {
  const used: string[] = []
  let index = 0

  const call = async (send: (token: string, base: string) => Promise<unknown>) => {
    try {
      used.push(tokens[index]!)

      return await send(tokens[index]!, BASE)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'matrix_s1_authentication' || index > 0) {
        throw error
      }

      index += 1
      used.push(tokens[index]!)

      return send(tokens[index]!, BASE)
    }
  }

  return { call, used }
}

function harness(...responses: (Response | Error)[]) {
  const seen: Seen[] = []
  const queue = [...responses]

  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)

    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect
    })

    const next = queue.shift()

    if (!next) {
      throw new Error('unexpected request')
    }

    if (next instanceof Error) {
      throw next
    }

    return next
  }) as unknown as typeof fetch

  const owner = account()
  const transport: BrowserImportTransport = httpBrowserImportTransport({ call: owner.call, fetchImpl })

  return { transport, seen, owner }
}

describe('the primary computer', () => {
  it('asks for the agent’s computer with the owner’s bearer and nothing else', async () => {
    const { transport, seen } = harness(answer(200, { computerId: COMPUTER, attachmentEpoch: 7, extra: 'ignored' }))

    await expect(transport.primaryComputer(AGENT, signal)).resolves.toEqual({
      computerId: COMPUTER,
      attachmentEpoch: 7
    })
    expect(seen).toEqual([
      {
        url: `${BASE}/agents/${AGENT}/computer`,
        method: 'GET',
        authorization: 'Bearer token-1',
        contentType: null,
        body: undefined,
        redirect: 'error'
      }
    ])
  })

  it('treats a missing computer as an answer, not an error (the platform’s own 404 body)', async () => {
    const { transport } = harness(answer(404, { error: 'matrix_404' }))

    await expect(transport.primaryComputer(AGENT, signal)).resolves.toBeNull()
  })

  it('asks the platform for the lowercase principal it accepts, with no query string', async () => {
    const { transport, seen } = harness(
      answer(200, { computerId: COMPUTER, attachmentEpoch: 1 }),
      answer(200, { meta: {} })
    )

    await transport.primaryComputer(AGENT.toUpperCase(), signal)
    await transport.readRecipientKey(AGENT.toUpperCase(), {} as never, signal)

    expect(seen.map(({ url }) => url)).toEqual([
      `${BASE}/agents/${AGENT}/computer`,
      `${BASE}/agents/${AGENT}/browser-import/recipient-key`
    ])
    expect(seen.every(({ url }) => !url.includes('?'))).toBe(true)
  })

  it.each([
    ['a bad id', { computerId: 'nope', attachmentEpoch: 7 }],
    ['an epoch of zero', { computerId: COMPUTER, attachmentEpoch: 0 }],
    ['a fractional epoch', { computerId: COMPUTER, attachmentEpoch: 1.5 }],
    ['no body', null],
    ['an array', []]
  ])('refuses an answer with %s', async (_name, body) => {
    const { transport } = harness(answer(200, body))

    await expect(transport.primaryComputer(AGENT, signal)).rejects.toMatchObject({ status: 0, reason: 'invalid' })
  })

  it('never builds a route from an agent id that is not a uuid', async () => {
    const { transport, seen } = harness()

    await expect(transport.primaryComputer('../../admin', signal)).rejects.toMatchObject({ status: 400 })
    expect(seen).toEqual([])
  })
})

describe('the recipient key read and the transfer', () => {
  const request = { meta: { signer: 'owner_client' }, ownerUserId: '@owner:atum.example' } as never

  it('posts the read request as JSON and returns the platform’s answer untouched', async () => {
    const record = { meta: { signer: 'platform_controller' } }
    const { transport, seen } = harness(answer(200, record))

    await expect(transport.readRecipientKey(AGENT, request, signal)).resolves.toEqual(record)
    expect(seen[0]).toMatchObject({
      url: `${BASE}/agents/${AGENT}/browser-import/recipient-key`,
      method: 'POST',
      contentType: 'application/json',
      authorization: 'Bearer token-1'
    })
    expect(JSON.parse(seen[0]!.body!)).toEqual(request)
  })

  it('posts the envelope and its consent record, and checks the platform answers for that import', async () => {
    const importId = '00000000-0000-4000-8000-cd2a20671fb6'
    const envelope = { authenticatedData: { importId }, hpke: { ciphertext: 'CIPHERTEXT' } } as never
    const admission = { importId } as never
    const { transport, seen } = harness(answer(202, { importId }))

    await expect(transport.admit(AGENT, { envelope, admission }, signal)).resolves.toEqual({ importId })
    expect(seen[0]).toMatchObject({
      url: `${BASE}/agents/${AGENT}/browser-import/transfers`,
      method: 'POST',
      contentType: 'application/json'
    })
    expect(JSON.parse(seen[0]!.body!)).toEqual({ envelope, admission })
    // The platform refuses any body whose keys are not exactly these two.
    expect(Object.keys(JSON.parse(seen[0]!.body!)).sort()).toEqual(['admission', 'envelope'])
  })

  it('refuses an admission answer for a different import', async () => {
    const envelope = { authenticatedData: { importId: '00000000-0000-4000-8000-cd2a20671fb6' } } as never
    const { transport } = harness(answer(202, { importId: '00000000-0000-4000-8000-e8d95748107a' }))

    await expect(transport.admit(AGENT, { envelope, admission: {} as never }, signal)).rejects.toMatchObject({
      status: 0,
      reason: 'invalid'
    })
  })
})

describe('what goes wrong', () => {
  it('refreshes the grant once on a 401 and sends the same request again', async () => {
    const { transport, seen, owner } = harness(answer(401), answer(200, { computerId: COMPUTER, attachmentEpoch: 3 }))

    await expect(transport.primaryComputer(AGENT, signal)).resolves.toEqual({
      computerId: COMPUTER,
      attachmentEpoch: 3
    })
    expect(owner.used).toEqual(['token-1', 'token-2'])
    expect(seen.map(({ authorization }) => authorization)).toEqual(['Bearer token-1', 'Bearer token-2'])
  })

  it('gives up after one refresh', async () => {
    const { transport } = harness(answer(401), answer(401))

    await expect(transport.primaryComputer(AGENT, signal)).rejects.toThrow('matrix_s1_authentication')
  })

  it.each([
    [409, { error: 'matrix_409', details: { reason: 'replayed_import_id' } }, 'replayed_import_id'],
    [400, { error: 'matrix_400', details: { reason: 'expired' } }, 'expired'],
    [403, { error: 'matrix_403', details: { reason: 'stale_attachment_epoch' } }, 'stale_attachment_epoch'],
    [403, { error: 'matrix_403', details: { reason: 'Not A Closed Word!' } }, undefined],
    [500, { message: 'internal detail that must not travel' }, undefined]
  ])('names a refusal by status and a closed reason only (%s)', async (status, body, reason) => {
    const { transport } = harness(answer(status, body))

    const error = await transport
      .admit(AGENT, { envelope: { authenticatedData: { importId: 'x' } } as never, admission: {} as never }, signal)
      .catch(failure => failure)

    expect(error).toBeInstanceOf(BrowserImportHttpError)
    expect(error).toMatchObject({ status, reason })
    expect(String(error.message)).not.toContain('internal detail')
  })

  it('reports no answer at all as status 0, and passes a cancellation through', async () => {
    const { transport } = harness(new TypeError('fetch failed'))

    await expect(transport.primaryComputer(AGENT, signal)).rejects.toMatchObject({ status: 0 })

    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    const { transport: other } = harness(new Error('aborted'))

    await expect(other.primaryComputer(AGENT, aborted.signal)).rejects.toThrow('cancelled')
  })

  it('refuses an answer that is not JSON or is too large', async () => {
    const html = harness(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))

    await expect(html.transport.primaryComputer(AGENT, signal)).rejects.toMatchObject({ status: 0, reason: 'invalid' })

    const huge = harness(answer(200, { computerId: COMPUTER, attachmentEpoch: 1, padding: 'x'.repeat(20_000) }))

    await expect(huge.transport.primaryComputer(AGENT, signal)).rejects.toMatchObject({ status: 0, reason: 'invalid' })
  })

  it('only talks https and never follows a redirect', async () => {
    const { seen } = harness()
    const fetchImpl = vi.fn()

    const insecure = httpBrowserImportTransport({
      call: send => send('t', 'http://domain.atum.example/api'),
      fetchImpl: fetchImpl as never
    })

    await expect(insecure.primaryComputer(AGENT, signal)).rejects.toBeDefined()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })
})
