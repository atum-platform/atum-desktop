import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseMatrixAliasRequest, parseMatrixAliasResponse, requestMatrixAlias } from './aliases'

const requestId = '00000000-0000-4000-8000-576f18824476'
const assistantId = '00000000-0000-4000-8000-95eb2692c90e'
const grant = { accessToken: 'synthetic-native-bearer' } as never
afterEach(() => vi.unstubAllGlobals())

describe('native alias transport', () => {
  it.each([{ action: 'current', owner: requestId }, { action: 'current', assistantId: 'not-uuid' }, { action: 'lookup', handle: 'alice', assistantId }, { action: 'lookup' }, { action: 'lookup', handle: '' }, { action: 'claim', handle: 'alice', requestId, principal: requestId }, { action: 'claim', handle: 'alice', requestId: 'new' }, { action: 'check', handle: 'a'.repeat(34) }])('rejects authority fields and malformed requests', input => {
    expect(() => parseMatrixAliasRequest(input)).toThrow('matrix_alias_invalid')
  })

  it('distinguishes absent assignment from an invalid or unavailable projection', () => {
    expect(parseMatrixAliasResponse(null, { action: 'current' })).toEqual({ kind: 'current', alias: null })

    for (const result of [{}, { handle: 'Alice', generation: 1 }, { handle: 'alice', generation: 0 }, { handle: 'alice', generation: 1, owner: requestId }]) {
      expect(() => parseMatrixAliasResponse(result, { action: 'current' })).toThrow('matrix_alias_unavailable')
    }
  })

  it('requires result handles to match the exact server normalization, without trimming', () => {
    const input = { action: 'check' as const, handle: '@AlICE' }
    expect(parseMatrixAliasResponse({ handle: 'alice', available: true, code: null }, input)).toMatchObject({ handle: 'alice', available: true })

    for (const result of [{ handle: 'other', available: true, code: null }, { handle: null, available: true, code: null }, { handle: 'alice', available: false, code: null }]) {
      expect(() => parseMatrixAliasResponse(result, input)).toThrow('unavailable')
    }

    expect(() => parseMatrixAliasResponse({ handle: 'alice', available: true, code: null }, { action: 'check', handle: ' alice ' })).toThrow('unavailable')
    expect(() => parseMatrixAliasResponse({ handle: 'other', state: 'assigned', principal: requestId, generation: 1 }, { action: 'claim', handle: 'alice', requestId })).toThrow('unavailable')
  })

  it('validates claim principals without exposing them through parsed or transported results', async () => {
    const input = { action: 'claim' as const, handle: 'alice_bot', requestId, assistantId }
    const response = { handle: 'alice_bot', state: 'assigned', principal: requestId, generation: 1, replayed: true }

    const parsed = parseMatrixAliasResponse(response, input)
    expect(parsed).toEqual({ kind: 'claim', handle: 'alice_bot', generation: 1, replayed: true })
    expect(parsed).not.toHaveProperty('principal')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    const transported = await requestMatrixAlias('https://api.test', grant, input, AbortSignal.timeout(2000))
    expect(transported).toEqual(parsed)
    expect(transported).not.toHaveProperty('principal')
  })

  it('uses only fixed endpoints, bearer auth and the original UUID, with no redirect or cookie authority', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ handle: 'alice_bot', state: 'assigned', principal: requestId, generation: 1, replayed: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(requestMatrixAlias('https://api.test/api/matrix/v1', grant, { action: 'claim', handle: 'alice_bot', requestId, assistantId }, AbortSignal.timeout(2000))).resolves.toMatchObject({ kind: 'claim', replayed: true })
    expect(fetcher).toHaveBeenCalledWith('https://api.test/api/matrix/v1/aliases/claim', expect.objectContaining({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', body: JSON.stringify({ handle: 'alice_bot', requestId, assistantId }) }))
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer synthetic-native-bearer', Accept: 'application/json', 'Content-Type': 'application/json' })
    fetcher.mockResolvedValueOnce(Response.json(null))
    await requestMatrixAlias('https://api.test/api/matrix/v1', grant, { action: 'current', assistantId }, AbortSignal.timeout(2000))
    expect(fetcher.mock.calls[1][0]).toBe(`https://api.test/api/matrix/v1/aliases/current?assistantId=${assistantId}`)
  })

  it('finds a handle without a selector, and keeps the principal native', async () => {
    expect(parseMatrixAliasRequest({ action: 'lookup', handle: '@Lan' })).toEqual({ action: 'lookup', handle: '@Lan' })
    const input = { action: 'lookup' as const, handle: '@Lan' }
    const person = { handle: 'lan', state: 'assigned', principal: requestId, kind: 'human', generation: 2, matrixUser: '@user-0a1b:atum.test' }
    const parsed = parseMatrixAliasResponse(person, input)
    expect(parsed).toEqual({ kind: 'lookup', handle: 'lan', state: 'assigned', principalKind: 'human', matrixUser: '@user-0a1b:atum.test' })
    expect(parsed).not.toHaveProperty('principal')
    expect(parsed).not.toHaveProperty('generation')
    // The directory may know a person without knowing their chat address yet.
    expect(parseMatrixAliasResponse({ ...person, matrixUser: null }, input)).toMatchObject({ state: 'assigned', matrixUser: null })
    expect(parseMatrixAliasResponse({ handle: 'lan', state: 'available' }, input)).toEqual({ kind: 'lookup', handle: 'lan', state: 'available' })
    expect(parseMatrixAliasResponse({ handle: 'lan', state: 'unavailable' }, input)).toEqual({ kind: 'lookup', handle: 'lan', state: 'unavailable' })
    expect(parseMatrixAliasResponse({ handle: null, state: 'invalid' }, { action: 'lookup', handle: 'no-such' })).toEqual({ kind: 'lookup', handle: null, state: 'invalid' })
  })

  it.each([
    { handle: 'other', state: 'available' },
    { handle: 'lan', state: 'available', reason: 'held' },
    { handle: 'lan', state: 'invalid' },
    { handle: null, state: 'invalid' },
    { handle: 'lan', state: 'pending' },
    { handle: 'lan', state: 'assigned', principal: requestId, kind: 'human', generation: 1 },
    { handle: 'lan', state: 'assigned', principal: requestId, kind: 'robot', generation: 1, matrixUser: null },
    { handle: 'lan', state: 'assigned', principal: 'not-uuid', kind: 'human', generation: 1, matrixUser: null },
    { handle: 'lan', state: 'assigned', principal: requestId, kind: 'agent', generation: 0, matrixUser: null },
    { handle: 'lan', state: 'assigned', principal: requestId, kind: 'agent', generation: 1, matrixUser: 'lan' },
    { handle: 'lan', state: 'assigned', principal: requestId, kind: 'agent', generation: 1, matrixUser: '@lan:test', holder: requestId }
  ])('refuses a lookup answer that is not exactly about the handle asked for (%#)', result => {
    expect(() => parseMatrixAliasResponse(result, { action: 'lookup', handle: 'lan' })).toThrow('matrix_alias_unavailable')
  })

  it('reads a lookup from its fixed endpoint with the handle as the only query', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ handle: 'lan_bot', state: 'assigned', principal: requestId, kind: 'agent', generation: 1, matrixUser: '@agent-1a2b:atum.test' }))
    vi.stubGlobal('fetch', fetcher)
    const found = await requestMatrixAlias('https://api.test/api/matrix/v1', grant, { action: 'lookup', handle: '@Lan_Bot' }, AbortSignal.timeout(2000))
    expect(found).toEqual({ kind: 'lookup', handle: 'lan_bot', state: 'assigned', principalKind: 'agent', matrixUser: '@agent-1a2b:atum.test' })
    // Normalized at the main boundary: the wire value is what the answer is checked against.
    expect(fetcher.mock.calls[0][0]).toBe('https://api.test/api/matrix/v1/aliases/lookup?handle=lan_bot')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' })
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer synthetic-native-bearer', Accept: 'application/json' })
  })

  it('posts only a complete exact email and returns only the Matrix identity', async () => {
    const fetcher = vi.fn(async () => Response.json({ kind: 'search', matrixUser: '@nguyen:test' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(requestMatrixAlias('https://api.test/api/matrix/v1', grant,
      { action: 'search', email: 'nguyen@example.com' }, AbortSignal.timeout(2000)))
      .resolves.toEqual({ kind: 'search', matrixUser: '@nguyen:test' })
    expect(fetcher).toHaveBeenCalledWith('https://api.test/api/matrix/v1/aliases/search', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'nguyen@example.com' }), credentials: 'omit', redirect: 'error'
    }))
    for (const email of ['nguyen', 'NGUYEN@example.com', 'nguyen@example.com ']) {
      expect(() => parseMatrixAliasRequest({ action: 'search', email })).toThrow('matrix_alias_invalid')
    }
  })

  it('posts contacts as their Matrix IDs only and answers one handle or null per ID, in order', async () => {
    const poon = '@synthetic-user-0020:atumplatform.com'
    const agent = '@synthetic-user-0012:atumplatform.com'
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ contacts: [{ matrixUser: poon, handle: 'poon' }, { matrixUser: agent, handle: null }] }))
    vi.stubGlobal('fetch', fetcher)
    await expect(requestMatrixAlias('https://api.test/api/matrix/v1', grant, { action: 'contacts', matrixUsers: [poon, agent] }, AbortSignal.timeout(2000)))
      .resolves.toEqual({ kind: 'contacts', contacts: [{ matrixUser: poon, handle: 'poon' }, { matrixUser: agent, handle: null }] })
    expect(fetcher.mock.calls[0][0]).toBe('https://api.test/api/matrix/v1/aliases/contacts')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', body: JSON.stringify({ matrixUsers: [poon, agent] }) })
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer synthetic-native-bearer', Accept: 'application/json', 'Content-Type': 'application/json' })
  })

  it.each([
    { action: 'contacts' },
    { action: 'contacts', matrixUsers: [] },
    { action: 'contacts', matrixUsers: ['@a:test', '@a:test'] },
    { action: 'contacts', matrixUsers: ['poon'] },
    { action: 'contacts', matrixUsers: ['@Upper:test'] },
    { action: 'contacts', matrixUsers: Array.from({ length: 51 }, (_, index) => `@u${index}:test`) },
    { action: 'contacts', matrixUsers: ['@a:test'], assistantId }
  ])('refuses a contacts request outside the contract', input => {
    expect(() => parseMatrixAliasRequest(input)).toThrow('matrix_alias_invalid')
  })

  it('refuses a contacts answer that names another ID, reorders, drops, leaks a room or carries a non-handle', () => {
    const input = { action: 'contacts' as const, matrixUsers: ['@a:test', '@b:test'] }

    for (const result of [
      { contacts: [{ matrixUser: '@b:test', handle: null }, { matrixUser: '@a:test', handle: null }] },
      { contacts: [{ matrixUser: '@a:test', handle: null }] },
      { contacts: [{ matrixUser: '@a:test', handle: null }, { matrixUser: '@b:test', handle: null, roomId: '!r:test' }] },
      { contacts: [{ matrixUser: '@a:test', handle: 'Poon' }, { matrixUser: '@b:test', handle: null }] },
      { contacts: [{ matrixUser: '@a:test', handle: null }, { matrixUser: '@b:test', handle: null }], extra: true }
    ]) {
      expect(() => parseMatrixAliasResponse(result, input)).toThrow('matrix_alias_unavailable')
    }
  })

  it('reads a contacts 429 with its wait and a Shell without the route as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"matrix_429"}', { status: 429, headers: { 'Retry-After': '120', 'content-type': 'application/json' } })))
    await expect(requestMatrixAlias('https://api.test', grant, { action: 'contacts', matrixUsers: ['@a:test'] }, AbortSignal.timeout(2000)))
      .rejects.toMatchObject({ code: 'limit', retryAfterSeconds: 120 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })))
    await expect(requestMatrixAlias('https://api.test', grant, { action: 'contacts', matrixUsers: ['@a:test'] }, AbortSignal.timeout(2000)))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each([400, 401, 403, 404, 409, 429, 500])('preserves bounded refusal %s without provider error text', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"private details"}', { status, headers: { 'Retry-After': '60', 'content-type': 'application/json' } })))
    await expect(requestMatrixAlias('https://api.test', grant, { action: 'current' }, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: ({400:'invalid',401:'authentication',403:'denied',404:'missing',409:'conflict',429:'limit',500:'unavailable'} as const)[status], ...(status === 429 ? { retryAfterSeconds: 60 } : {}) })
  })

  it('reads a 404 without the authority JSON as a missing route, never a missing assistant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })))
    const input = { action: 'rename' as const, handle: 'lan_helper_bot', from: '@lan_helpr_bot', requestId, assistantId }

    await expect(requestMatrixAlias('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('renames from the handle shown, and keeps the principal native', async () => {
    const input = { action: 'rename' as const, handle: 'Lan_Helper_Bot', from: '@lan_helpr_bot', requestId, assistantId }
    expect(parseMatrixAliasRequest(input)).toEqual(input)

    for (const malformed of [{ ...input, from: undefined }, { ...input, from: '' }, { ...input, from: 'a'.repeat(34) }, { ...input, requestId: 'new' },
      { ...input, principal: requestId }, { action: 'rename', handle: 'lan_helper_bot', requestId }]) {
      expect(() => parseMatrixAliasRequest(malformed)).toThrow('matrix_alias_invalid')
    }

    const answer = { handle: 'lan_helper_bot', state: 'assigned', principal: requestId, generation: 1, previous: 'lan_helpr_bot' }
    const parsed = parseMatrixAliasResponse(answer, input)
    expect(parsed).toEqual({ kind: 'rename', handle: 'lan_helper_bot', generation: 1, previous: 'lan_helpr_bot' })
    expect(parsed).not.toHaveProperty('principal')
    expect(parseMatrixAliasResponse({ ...answer, replayed: true }, input)).toMatchObject({ kind: 'rename', replayed: true })

    // The answer must be about this change: the new handle, and the one it replaced.
    for (const result of [{ ...answer, previous: 'other_bot' }, { ...answer, previous: 'lan_helper_bot', handle: 'lan_helper_bot' }, { ...answer, previous: undefined },
      { handle: 'lan_helper_bot', state: 'assigned', principal: requestId, generation: 1 }, { ...answer, holder: requestId }]) {
      expect(() => parseMatrixAliasResponse(result, input)).toThrow('matrix_alias_unavailable')
    }

    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(answer))
    vi.stubGlobal('fetch', fetcher)
    await expect(requestMatrixAlias('https://api.test/api/matrix/v1', grant, input, AbortSignal.timeout(2000))).resolves.toEqual(parsed)
    expect(fetcher).toHaveBeenCalledWith('https://api.test/api/matrix/v1/aliases/rename', expect.objectContaining({
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      body: JSON.stringify({ handle: 'Lan_Helper_Bot', from: '@lan_helpr_bot', requestId, assistantId })
    }))
  })

  it('says when handles are not open yet, and otherwise keeps a denial a denial', async () => {
    const claim = { action: 'claim' as const, handle: 'alice_bot', requestId, assistantId }
    const refused = (body: unknown) => new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } })

    vi.stubGlobal('fetch', vi.fn(async () => refused({ error: 'matrix_403', details: { reason: 'alias_claims_closed' } })))
    await expect(requestMatrixAlias('https://api.test', grant, claim, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'closed' })

    for (const body of [{ error: 'matrix_403' }, { error: 'matrix_403', details: { reason: 'cloud_answering' } }, 'not json']) {
      vi.stubGlobal('fetch', vi.fn(async () => refused(body)))
      await expect(requestMatrixAlias('https://api.test', grant, claim, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'denied' })
    }
  })

  it('carries a rename wait of up to 30 days, while a check budget waits at most a day', async () => {
    const month = String(30 * 86400)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': month } })))
    await expect(requestMatrixAlias('https://api.test', grant, { action: 'rename', handle: 'b_bot', from: 'a_bot', requestId }, AbortSignal.timeout(2000)))
      .rejects.toMatchObject({ code: 'limit', retryAfterSeconds: 30 * 86400 })
    const check = await requestMatrixAlias('https://api.test', grant, { action: 'check', handle: 'b_bot' }, AbortSignal.timeout(2000)).catch(error => error)
    expect(check).toMatchObject({ code: 'limit' })
    expect(check.retryAfterSeconds).toBeUndefined()
  })
})
