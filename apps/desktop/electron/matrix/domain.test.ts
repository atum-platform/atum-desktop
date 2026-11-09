import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureDomainAssistant, readCloudDisclosureVersion, readDomainIdentity } from './domain'

const grant = { issuer: 'https://id.test/', subject: 'alice', accessToken: 'synthetic', refreshToken: 'not-sent' }
const identity = { issuer: grant.issuer, subject: grant.subject, principal: '12345678-1234-1234-1234-123456789abc' }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function deviceTimeZone(timeZone: unknown) {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    calendar: 'gregory',
    locale: 'en-US',
    numberingSystem: 'latn',
    timeZone
  } as Intl.ResolvedDateTimeFormatOptions)
}

describe('main-only domain resource', () => {
  it('uses only the configured endpoint, rejects redirects and projects only validated identity', async () => {
    const request = vi.fn(async () => Response.json({ ...identity, accessToken: 'must-not-reach-ui' }))
    vi.stubGlobal('fetch', request)
    expect(await readDomainIdentity('https://api.test/atum', grant)).toEqual(identity)
    expect(request).toHaveBeenCalledWith(
      'https://api.test/atum/me',
      expect.objectContaining({
        headers: { Authorization: 'Bearer synthetic' },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
  })
  it.each([
    { ...identity, issuer: 'https://other.test/' },
    { ...identity, subject: 'bob' },
    { ...identity, principal: '@alice:test' },
    null
  ])('rejects a mismatched or malformed server identity: %j', async data => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(data))
    )
    await expect(readDomainIdentity('https://api.test', grant)).rejects.toThrow()
  })
  it('signals an authentication rejection without treating service failure as expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    )
    expect(await readDomainIdentity('https://api.test', grant)).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    )
    await expect(readDomainIdentity('https://api.test', grant)).rejects.toThrow('matrix_domain_unavailable')
  })
  it('caps the streamed body even without Content-Length', async () => {
    const cancel = vi.fn()

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16_385))
      },
      cancel
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    )
    await expect(readDomainIdentity('https://api.test', grant)).rejects.toThrow('matrix_domain_invalid')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('first sign-in assistant provisioning', () => {
  const assistant = { agentPrincipal: '22345678-1234-1234-1234-123456789abc', matrixUser: '@agent-0123456789abcdef0123:test' }

  it('posts the current IANA zone on the first assistant request and returns only the validated agent', async () => {
    deviceTimeZone('America/Los_Angeles')
    const request = vi.fn(async () => Response.json({ ...assistant, starter: { state: 'granted', amount: 1 } }))
    vi.stubGlobal('fetch', request)
    expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)
    expect(request).toHaveBeenCalledWith(
      'https://api.test/atum/assistant',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          'Atum-Time-Zone': 'America/Los_Angeles'
        },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
    expect(JSON.stringify(request.mock.calls)).not.toContain(grant.refreshToken)
  })
  it.each([
    ['missing', undefined],
    ['offset', '+07:00'],
    ['lowercase', 'america/los_angeles']
  ])('omits the time-zone header when the device zone is %s', async (_case, zone) => {
    deviceTimeZone(zone)

    const request = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/cloud/disclosure') ? new Response('', { status: 503 }) : Response.json(assistant)
    )

    vi.stubGlobal('fetch', request)

    expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)

    const assistantRequest = request.mock.calls.find(([url]) => url.endsWith('/assistant'))
    expect(assistantRequest?.[1]).toEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }
      })
    )
  })
  it('signals a rejected grant, and treats service failure or a malformed agent as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    expect(await ensureDomainAssistant('https://api.test', grant)).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'matrix_503' }, { status: 503 })))
    await expect(ensureDomainAssistant('https://api.test', grant)).rejects.toThrow('matrix_assistant_unavailable')

    for (const data of [{ ...assistant, agentPrincipal: 'x' }, { ...assistant, matrixUser: 'agent' }, null]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)))
      await expect(ensureDomainAssistant('https://api.test', grant)).rejects.toThrow('matrix_domain_invalid')
    }
  })
  it('reads the active Cloud disclosure and sends its version with the assistant request', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/cloud/disclosure')
        ? Response.json({ kind: 'cloud', version: 7 })
        : Response.json(assistant)
    )
    vi.stubGlobal('fetch', request)

    expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.test/atum/cloud/disclosure',
      'https://api.test/atum/assistant'
    ])
    expect(request).toHaveBeenLastCalledWith(
      'https://api.test/atum/assistant',
      expect.objectContaining({ body: JSON.stringify({ disclosureVersion: 7 }) })
    )
  })
  it('cloud-only: a failed disclosure read is retried once so a new assistant still asks for the cloud', async () => {
    let disclosureReads = 0
    const request = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/cloud/disclosure')) {
        disclosureReads += 1

        return disclosureReads === 1 ? new Response('', { status: 503 }) : Response.json({ kind: 'cloud', version: 7 })
      }

      return Response.json(assistant)
    })
    vi.stubGlobal('fetch', request)

    expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)
    expect(disclosureReads).toBe(2)
    expect(request).toHaveBeenLastCalledWith(
      'https://api.test/atum/assistant',
      expect.objectContaining({ body: JSON.stringify({ disclosureVersion: 7 }) })
    )
  })
  it('the dormant Mac-first path reads the disclosure only once', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/cloud/disclosure') ? new Response('', { status: 503 }) : Response.json({ kind: 'cloud', version: 7 })
    )
    vi.stubGlobal('fetch', request)

    expect(await readCloudDisclosureVersion('https://api.test/atum', grant, false)).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([400, 422])(
    'retries exactly once with the old empty body when the current production Shell refuses the versioned request (%i)',
    async status => {
      const posts: string[] = []
      const request = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/cloud/disclosure')) {
          return Response.json({ kind: 'cloud', version: 7 })
        }

        posts.push(String(init?.body))

        return posts.length === 1 ? new Response('', { status }) : Response.json(assistant)
      })
      vi.stubGlobal('fetch', request)

      expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)
      expect(posts).toEqual([JSON.stringify({ disclosureVersion: 7 }), '{}'])
    }
  )
  it('keeps the existing error path when the empty-body retry is rejected too', async () => {
    const posts: string[] = []
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cloud/disclosure')) {
        return Response.json({ kind: 'cloud', version: 7 })
      }

      posts.push(String(init?.body))

      return new Response('', { status: posts.length === 1 ? 400 : 401 })
    })
    vi.stubGlobal('fetch', request)

    // The retry's own answer is handled exactly like the first request's: 401 is the existing
    // signed-out signal, never an unexpected throw from the versioned-body path.
    await expect(ensureDomainAssistant('https://api.test/atum', grant)).resolves.toBeNull()
    expect(posts).toEqual([JSON.stringify({ disclosureVersion: 7 }), '{}'])
  })
  it('does not retry a versioned request when its failure is not the old Shell’s body refusal', async () => {
    const posts: string[] = []
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cloud/disclosure')) {
        return Response.json({ kind: 'cloud', version: 7 })
      }

      posts.push(String(init?.body))

      return new Response('', { status: 503 })
    })
    vi.stubGlobal('fetch', request)

    await expect(ensureDomainAssistant('https://api.test/atum', grant)).rejects.toThrow('matrix_assistant_unavailable')
    expect(posts).toEqual([JSON.stringify({ disclosureVersion: 7 })])
  })
  it.each([
    ['refused', vi.fn(async () => new Response('', { status: 503 }))],
    ['malformed', vi.fn(async () => Response.json({ kind: 'owner_reader', version: 3 }))],
    ['unreadable', vi.fn(async () => { throw new Error('network') })]
  ])('keeps the old empty assistant body when the disclosure read is %s', async (_case, disclosure) => {
    const request = vi.fn(async (url: string) => (url.endsWith('/cloud/disclosure') ? disclosure() : Response.json(assistant)))
    vi.stubGlobal('fetch', request)

    expect(await ensureDomainAssistant('https://api.test/atum', grant)).toEqual(assistant)
    expect(request).toHaveBeenLastCalledWith(
      'https://api.test/atum/assistant',
      expect.objectContaining({ body: '{}' })
    )
  })
})
