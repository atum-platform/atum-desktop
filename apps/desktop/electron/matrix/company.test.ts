import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseMatrixCompanyRequest, parseMatrixCompanyResponse, requestMatrixCompany } from './company'

const companyId = '00000000-0000-4000-8000-576f18824476'
const principal = '00000000-0000-4000-8000-95eb2692c90e'
const requestId = '00000000-0000-4000-8000-b4b6412c243e'
const grant = { issuer: 'https://id.test/', subject: 'alice', accessToken: 'native-only', refreshToken: 'native-refresh' }

const snapshot = () => ({ schemaVersion: 1, company: { id: companyId, displayName: 'Studio', role: 'admin', authorityGeneration: 1 },
  members: [{ principal, role: 'admin', state: 'active' }], projects: [] })

const directory = { schemaVersion: 1, companies: [], invitations: [] }

const wallet = () => ({ schemaVersion: 1, companyId, unit: 'micro_proton', checkoutOpen: false,
  balances: { paid: 40, earned: 10, promo: 0, held: 20, available: 50 },
  funding: { enabled: true, taskLimit: 60, revision: 2 } })

const channelId = '00000000-0000-4000-8000-676a3a34ff0f'
const projectId = '00000000-0000-4000-8000-072e4e6126bd'
const fileId = '00000000-0000-4000-8000-6964221939c9'
const sourceId = '00000000-0000-4000-8000-d4312aa5d4eb'
const channel = () => ({ schemaVersion: 1 as const,
  channel: { id: channelId, companyId, displayName: 'Ra mắt Việt Nam', visibility: 'company' as const,
    state: 'provisioning' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1 },
  memberPrincipals: [principal], room: { state: 'not_provisioned' as const, roomId: null } })
const fileRef = { v: 1 as const, company_id: companyId, channel_id: channelId, file_id: fileId, revision: 1 as const,
  name: 'brief.pdf', content_type: 'application/pdf', size: 12, sha256: 'a'.repeat(64) }
const sources = () => ({ schemaVersion: 1 as const, companyId, projectId, authorityGeneration: 4, sourceGeneration: 2,
  eligibleChannels: [{ channelId, displayName: 'Launch', state: 'ready' as const }],
  eligibleFiles: [{ file: fileRef, channelId, eventId: '$company-file', publishedAt: '2026-10-15T09:00:00+00:00' }],
  sources: [
    { id: sourceId, kind: 'channel' as const, state: 'active' as const, channelId,
      enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null },
    { id: requestId, kind: 'company_file' as const, state: 'active' as const, channelId, file: fileRef,
      enrolledAt: '2026-10-15T10:01:00+00:00', withdrawnAt: null }
  ], coverage: { state: 'pending' as const } })

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('native company authority client', () => {
  it('uses fixed funding routes with only admin intent and keeps wallet reads body-free', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(wallet()))
    vi.stubGlobal('fetch', fetch)
    const input = { action: 'funding' as const, companyId, requestId, enabled: true, taskLimit: 60 }
    expect(await requestMatrixCompany('https://api.test/matrix/v1', grant, input, AbortSignal.timeout(1000))).toEqual(wallet())
    expect(fetch.mock.calls[0]).toEqual([`https://api.test/matrix/v1/companies/${companyId}/funding`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ requestId, enabled: true, taskLimit: 60 }), redirect: 'error', credentials: 'omit'
    })])
    await requestMatrixCompany('https://api.test/matrix/v1', grant, { action: 'wallet', companyId }, AbortSignal.timeout(1000))
    expect(fetch.mock.calls[1]).toEqual([`https://api.test/matrix/v1/companies/${companyId}/wallet`, expect.objectContaining({ method: 'GET' })])
    expect(fetch.mock.calls[1]![1]).not.toHaveProperty('body')
  })

  it('rejects spending impersonation, precision loss and unexpected financial operations', () => {
    const input = { action: 'funding', companyId, requestId, enabled: true, taskLimit: 60 }

    for (const value of [
      { ...input, actor: principal }, { ...input, payer: principal }, { ...input, taskLimit: 1.5 },
      { ...input, taskLimit: 0 }, { ...input, taskLimit: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, enabled: 'true' }, { action: 'wallet', companyId, balance: 100 },
      { action: 'credit', companyId }, { action: 'reserve', companyId }, { action: 'settle', companyId }
    ]) { expect(() => parseMatrixCompanyRequest(value)).toThrow('invalid') }
  })

  it('accepts genuine untouched zero but refuses contradictory or private wallet projections', () => {
    const input = { action: 'wallet' as const, companyId }

    const untouched = { ...wallet(), balances: { paid: 0, earned: 0, promo: 0, held: 0, available: 0 },
      funding: { enabled: false, taskLimit: null, revision: 0 } }

    expect(parseMatrixCompanyResponse(untouched, input)).toEqual(untouched)

    for (const value of [
      { ...wallet(), companyId: principal }, { ...wallet(), checkoutOpen: true },
      { ...wallet(), privateHistory: [] }, { ...wallet(), balances: { ...wallet().balances, available: 70 } },
      { ...wallet(), balances: { ...wallet().balances, held: -1 } },
      { ...wallet(), funding: { enabled: true, taskLimit: null, revision: 0 } },
      { ...wallet(), funding: { enabled: false, taskLimit: null, revision: 1 } }
    ]) { expect(() => parseMatrixCompanyResponse(value, input)).toThrow('invalid') }
  })

  it('rejects forged authority and URLs before making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    for (const input of [
      { action: 'list', actor: principal }, { action: 'list', url: 'https://foreign.test' },
      { action: 'read', companyId: '../wallet' }, { action: 'create', requestId, displayName: ' Studio' },
      { action: 'create', requestId, displayName: 'Studio', payer: companyId },
      { action: 'invite', companyId, requestId, memberPrincipal: principal }
    ]) {
      expect(() => parseMatrixCompanyRequest(input)).toThrow('matrix_company_invalid')
    }

    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads genuine empty directory from the fixed native resource, without cookies or redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(directory))
    vi.stubGlobal('fetch', fetch)
    expect(await requestMatrixCompany('https://api.test/matrix/v1', grant, { action: 'list' }, AbortSignal.timeout(1000))).toEqual(directory)
    expect(fetch).toHaveBeenCalledWith('https://api.test/matrix/v1/companies', expect.objectContaining({
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: 'Bearer native-only', Accept: 'application/json', 'Atum-Company-Wire': '1.1' }
    }))
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it('sends only mutation intent and keeps the company identifier in the fixed path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetch)
    const input = { action: 'create-project' as const, companyId, requestId, displayName: 'Launch' }
    await requestMatrixCompany('https://api.test/matrix/v1', grant, input, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenCalledWith(`https://api.test/matrix/v1/companies/${companyId}/create-project`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ requestId, displayName: 'Launch' }), redirect: 'error'
    }))
  })

  it('keeps invite and remove on 1.1, selects 1.11 only for leave, and sends no principal in any body', async () => {
    const memberRef = 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew'
    const projected = { schemaVersion: 2, company: { id: companyId, displayName: 'Studio', role: 'admin',
      authorityGeneration: 1 }, members: [{ memberRef, role: 'admin', state: 'active', self: true,
      handle: 'minh', displayName: 'Minh' }], projects: [], defaultChannelId: null }
    const removal = { schemaVersion: 2, companyId, memberRef, state: 'revoking', authorityGeneration: 2 }
    const leave = { schemaVersion: 2, companyId, state: 'revoking', retired: false, authorityGeneration: 2 }
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(projected))
      .mockResolvedValueOnce(json(removal))
      .mockResolvedValueOnce(json(leave))
    vi.stubGlobal('fetch', fetch)

    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'invite', companyId, requestId, memberHandle: '@Lan_Nguyen', role: 'member' },
      AbortSignal.timeout(1000))).resolves.toEqual(projected)
    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'remove-member', companyId, requestId, memberRef }, AbortSignal.timeout(1000))).resolves.toEqual(removal)
    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'leave', companyId, requestId }, AbortSignal.timeout(1000))).resolves.toEqual(leave)

    const routes = ['invite', 'remove-member', 'leave']

    const wires = ['1.1', '1.1', '1.11']

    const bodies = [{ requestId, memberHandle: '@Lan_Nguyen', role: 'member' },
      { requestId, memberRef }, { requestId }]

    routes.forEach((route, index) => {
      const [url, init] = fetch.mock.calls[index]!

      expect(url).toBe(`https://api.test/matrix/v1/companies/${companyId}/${route}`)
      expect(init).toMatchObject({ method: 'POST', headers: {
        Authorization: 'Bearer native-only', Accept: 'application/json',
        'Atum-Company-Wire': wires[index], 'Content-Type': 'application/json' } })
      expect(JSON.parse(String(init!.body))).toEqual(bodies[index])

      const keys = Object.keys(JSON.parse(String(init!.body)) as Record<string, unknown>)

      expect(keys.some(key => key.toLowerCase().includes('principal'))).toBe(false)
      expect(keys).not.toContain('actor')
      expect(keys).not.toContain('self')
    })
  })

  it('parses the 1.11 funded-wallet leave refusal without widening another legacy route', async () => {
    const body = { error: 'matrix_409', details: { reason: 'company_wallet_not_empty' } }

    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), {
      status: 409,
      headers: { 'Content-Type': 'application/json' }
    }))

    vi.stubGlobal('fetch', fetch)

    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'leave', companyId, requestId }, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'conflict', reason: 'company_wallet_not_empty'
    })
    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'remove-member', companyId, requestId, memberRef: 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew' },
      AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'conflict', reason: undefined })

    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'Atum-Company-Wire': '1.11' })
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ 'Atum-Company-Wire': '1.1' })
  })

  it('uses the fixed channel resource and strips company/channel authority from request bodies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(channel()))
    vi.stubGlobal('fetch', fetch)
    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'create-channel', companyId, requestId, displayName: 'Ra mắt Việt Nam' }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(`https://api.test/matrix/v1/companies/${companyId}/channels`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ requestId, displayName: 'Ra mắt Việt Nam' })
    }))
    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'archive-channel', companyId, channelId, requestId }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(`https://api.test/matrix/v1/companies/${companyId}/channels/${channelId}/archive`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId }) }))
  })

  it('uses one fixed project source route and translates only the frozen mutation intent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(sources()))
    vi.stubGlobal('fetch', fetch)
    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'project-sources', companyId, projectId }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.test/matrix/v1/companies/${companyId}/projects/${projectId}/sources`,
      expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' }))
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body')

    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'include-project-channel-source', companyId, projectId, requestId, channelId,
        expectedSourceGeneration: 2 }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.test/matrix/v1/companies/${companyId}/projects/${projectId}/sources`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId, operation: 'include_channel',
        channelId, expectedSourceGeneration: 2 }) }))

    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'include-project-file-source', companyId, projectId, requestId, fileId, revision: 1,
        expectedSourceGeneration: 2 }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.test/matrix/v1/companies/${companyId}/projects/${projectId}/sources`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId, operation: 'include_file',
        fileId, revision: 1, expectedSourceGeneration: 2 }) }))

    await requestMatrixCompany('https://api.test/matrix/v1', grant,
      { action: 'withdraw-project-source', companyId, projectId, requestId, sourceId,
        expectedSourceGeneration: 2 }, AbortSignal.timeout(1000))
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.test/matrix/v1/companies/${companyId}/projects/${projectId}/sources`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId, operation: 'withdraw',
        sourceId, expectedSourceGeneration: 2 }) }))
  })

  it('uses one fixed no-body project reader status route', async () => {
    const status = {schemaVersion: 2, companyId, projectId, authorityGeneration: 2, sourceGeneration: 1,
      coverage: {state: 'pending'}, sources: [{sourceId, kind: 'channel', state: 'active', channelId,
        receiptState: 'none'}]}
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(status))
    vi.stubGlobal('fetch', fetch)
    await expect(requestMatrixCompany('https://api.test/matrix/v1', grant,
      {action: 'project-reader', companyId, projectId}, AbortSignal.timeout(1000))).resolves.toEqual(status)
    expect(fetch).toHaveBeenCalledWith(
      `https://api.test/matrix/v1/companies/${companyId}/projects/${projectId}/reader`,
      expect.objectContaining({method: 'GET', credentials: 'omit', redirect: 'error'}))
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it('accepts the bounded project source document and rejects impossible lineage', () => {
    const input = { action: 'project-sources' as const, companyId, projectId }
    expect(parseMatrixCompanyResponse(sources(), input)).toEqual(sources())
    for (const value of [
      { ...sources(), companyId: principal },
      { ...sources(), sourceGeneration: 0 },
      { ...sources(), coverage: { state: 'empty' } },
      { ...sources(), sources: [{ ...sources().sources[0], file: fileRef }] },
      { ...sources(), eligibleFiles: [{ ...sources().eligibleFiles[0], channelId: principal }] }
    ]) { expect(() => parseMatrixCompanyResponse(value, input)).toThrow('invalid') }
    for (const value of [
      { action: 'project-sources', companyId, projectId, actor: principal },
      { action: 'include-project-file-source', companyId, projectId, requestId, fileId, revision: 2,
        expectedSourceGeneration: 2 },
      { action: 'withdraw-project-source', companyId, projectId, requestId, sourceId,
        expectedSourceGeneration: -1 }
    ]) { expect(() => parseMatrixCompanyRequest(value)).toThrow('invalid') }
  })

  it('accepts bounded channel projections and rejects room or manager fabrication', () => {
    expect(parseMatrixCompanyResponse({ schemaVersion: 1, channels: [channel()] },
      { action: 'list-channels', companyId })).toEqual({ schemaVersion: 1, channels: [channel()] })
    expect(parseMatrixCompanyResponse(channel(), { action: 'read-channel', companyId, channelId })).toEqual(channel())
    const astral = { ...channel(), channel: { ...channel().channel, displayName: '🌙'.repeat(80) } }
    expect(parseMatrixCompanyRequest({ action: 'create-channel', companyId, requestId,
      displayName: '🌙'.repeat(80) })).toEqual({ action: 'create-channel', companyId, requestId,
      displayName: '🌙'.repeat(80) })
    expect(parseMatrixCompanyResponse(astral, { action: 'read-channel', companyId, channelId })).toEqual(astral)
    for (const value of [
      { ...channel(), channel: { ...channel().channel, companyId: principal } },
      { ...channel(), room: { state: 'ready', roomId: null } },
      { ...channel(), room: { state: 'ready', roomId: '!room:server\u007f' } },
      { ...channel(), managerUserId: '@manager:test' },
      { ...channel(), memberPrincipals: [principal, principal] },
      { ...channel(), memberPrincipals: [] }
    ]) {
      expect(() => parseMatrixCompanyResponse(value, { action: 'read-channel', companyId, channelId })).toThrow('invalid')
    }
    for (const value of [
      { action: 'create-channel', companyId, requestId, displayName: 'Launch', managerUserId: '@manager:test' },
      { action: 'create-channel', companyId, requestId, displayName: '🌙'.repeat(81) },
      { action: 'read-channel', companyId, channelId: '../room' }
    ]) {
      expect(() => parseMatrixCompanyRequest(value)).toThrow('invalid')
    }
  })

  it('distinguishes denied, unavailable and limited responses without forwarding server details', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    for (const [status, code] of [[400, 'invalid'], [401, 'authentication'], [403, 'denied'], [404, 'missing'], [409, 'conflict'], [503, 'unavailable']] as const) {
      fetch.mockResolvedValueOnce(new Response('private-server-detail', { status }))
      await expect(requestMatrixCompany('https://api.test', grant, { action: 'list' }, AbortSignal.timeout(1000)))
        .rejects.toMatchObject({ code, message: `matrix_company_${code}` })
    }

    fetch.mockResolvedValueOnce(new Response('private-server-detail', { status: 429, headers: { 'Retry-After': '60' } }))
    await expect(requestMatrixCompany('https://api.test', grant, { action: 'list' }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'limit', retryAfterSeconds: 60 })
  })

  it('refuses another company, duplicate members and contradictory project audiences', () => {
    const input = { action: 'read' as const, companyId }
    expect(() => parseMatrixCompanyResponse({ ...snapshot(), company: { ...snapshot().company, id: principal } }, input)).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse({ ...snapshot(), members: [...snapshot().members, ...snapshot().members] }, input)).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse({ ...snapshot(), projects: [{ id: requestId, displayName: 'Launch',
      collaboration: 'not_provisioned', memberPrincipals: [companyId] }] }, input)).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse({ ...snapshot(), company: { ...snapshot().company, role: 'member' },
      members: [{ principal, role: 'member', state: 'invited' }] }, input)).toThrow('invalid')
  })

  it('never substitutes empty success for malformed or oversized responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ schemaVersion: 1, companies: [], invitations: [], accessToken: 'unexpected' }))
    vi.stubGlobal('fetch', fetch)
    await expect(requestMatrixCompany('https://api.test', grant, { action: 'list' }, AbortSignal.timeout(1000))).rejects.toThrow('unavailable')
    fetch.mockResolvedValueOnce(new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }))
    await expect(requestMatrixCompany('https://api.test', grant, { action: 'list' }, AbortSignal.timeout(1000))).rejects.toThrow('unavailable')
  })
})
