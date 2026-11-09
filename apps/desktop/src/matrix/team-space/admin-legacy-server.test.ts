import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestMatrixCompany } from '../../../electron/matrix/company'
import { handleMatrixCompanyCommand } from '../../../electron/matrix/main-company'
import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { companyInvitationPolicy, companyPolicy3 } from '../../../shared/matrix-company-team-space'

import { $companyAdmin, clearCompanyAdmin, loadCompanyAdmin, POLICY_READ_RECHECK_MS } from './admin-store'
import { clearTeamSpaceDiscovery, currentTeamSpaceInviteReadiness, loadTeamSpaceInviteReadiness } from './discovery-store'
import { teamSpaceKey } from './keys'

/*
 * Older servers against the policy 1.2 and invite-readiness reads, through the real chain: the native request (fetch,
 * headers, status, strict parse), the IPC answer main gives the renderer, and the renderer's stores. A server that
 * refuses the profile (400) and one that ignores the header and answers the plain 1.3 shape must both behave like the
 * desktop before policy 1.2: the 1.3 snapshot is the authority and owners and admins invite. A genuine failure (503, a
 * malformed answer) is not an older server.
 */
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../electron/matrix/__fixtures__/team-space')
const read = (path: string): string => readFileSync(resolve(fixtures, path), 'utf8')
const legacySnapshot = read('atum-company-workspace-v1.3/fixtures/admin-snapshot.response.json')
const policySnapshot = read('atum-company-policy-v1.2/fixtures/read.response.json')
const legacyCapabilities = read('atum-company-workspace-v1.3/fixtures/capabilities-active.response.json')
const readiness = read('atum-company-invites-v1/fixtures/capabilities.response.json')
const readiness2 = read('atum-company-invites-v2/fixtures/capabilities.response.json')
const readiness3 = read('atum-company-invites-v3/fixtures/capabilities.response.json')
const policy3Snapshot = read('atum-company-policy-v1.3/fixtures/read.response.json')
const refused = (): Answer => ({ status: 400, body: '{"error":"matrix_400"}' })

const companyId = '00000000-0000-4000-8000-72805976e3a7'
const account = '@owner:example.invalid:DEVICE'

interface Answer {
  status: number
  body: string
  type?: string
}

const json = (body: string, status = 200): Answer => ({ status, body })

/**
 * The server: one answer per request, chosen by the profile headers sent (`profiled` is whether any was). Records what
 * was asked.
 */
function server(answer: (profiled: boolean, headers: { policy?: string; invites?: string }) => Answer) {
  const asked: Array<{ path: string; policy?: string; invites?: string }> = []

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const path = url.replace('https://shell.example/api/matrix/v1', '')
    asked.push({ path, policy: headers['Atum-Company-Policy'], invites: headers['Atum-Company-Invites'] })
    const reply = answer(Boolean(headers['Atum-Company-Policy'] ?? headers['Atum-Company-Invites']),
      { policy: headers['Atum-Company-Policy'], invites: headers['Atum-Company-Invites'] })

    return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.type ?? 'application/json' } })
  }))

  return asked
}

/** The renderer's bridge, answered by main's real Company IPC branch over the real native request. */
function bridge(): MatrixCompanyBridge {
  const frame = { url: 'atum://matrix' }
  const ui = { mainFrame: frame }
  const event = { sender: ui, senderFrame: frame }

  return {
    pending: async () => ({ ok: true, request: null }),
    request: (input: unknown) => handleMatrixCompanyCommand(input, {
      event: event as never,
      ui: ui as never,
      uiUrl: frame.url,
      enabled: true,
      closing: false,
      available: () => true,
      request: value => requestMatrixCompany('https://shell.example/api/matrix/v1', { accessToken: 'token' } as never, value,
        new AbortController().signal)
    })
  } as unknown as MatrixCompanyBridge
}

const state = () => $companyAdmin.get()[teamSpaceKey(account, companyId)]

afterEach(() => {
  vi.unstubAllGlobals()
  clearCompanyAdmin(account)
  clearTeamSpaceDiscovery()
})

describe('the administration read on an older server', () => {
  it('reads policy 1.3 (who may add directly) where the server has it', async () => {
    const asked = server(() => json(policy3Snapshot))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked.map(request => request.policy)).toEqual(['1.3'])
    expect(companyPolicy3(state()?.snapshot)?.directMemberAdd).toBe('members')
    expect(companyInvitationPolicy(state()?.snapshot)).toBe('members')
  })

  it('reads policy 1.2 where the server refuses 1.3, and keeps that read for the account', async () => {
    const asked = server((_profiled, headers) => headers.policy === '1.3' ? refused() : json(policySnapshot))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked.map(request => request.policy)).toEqual(['1.3', '1.2'])
    expect(companyInvitationPolicy(state()?.snapshot)).toBe('members')
    expect(companyPolicy3(state()?.snapshot)).toBeUndefined()

    await loadCompanyAdmin(bridge(), account, companyId, { quiet: true })
    expect(asked.map(request => request.policy)).toEqual(['1.3', '1.2', '1.2'])
  })

  it('asks policy 1.3 again after a while, so a server upgraded under the running app is read with it', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-06T00:00:00Z'), toFake: ['Date'] })

    try {
      let upgraded = false
      const asked = server((_profiled, headers) => headers.policy === '1.3' && !upgraded ? refused()
        : json(headers.policy === '1.3' ? policy3Snapshot : policySnapshot))

      await loadCompanyAdmin(bridge(), account, companyId)
      upgraded = true
      vi.setSystemTime(Date.now() + POLICY_READ_RECHECK_MS + 1)
      await loadCompanyAdmin(bridge(), account, companyId, { quiet: true })

      expect(asked.map(request => request.policy)).toEqual(['1.3', '1.2', '1.3'])
      expect(companyPolicy3(state()?.snapshot)?.directMemberAdd).toBe('members')
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the plain 1.3 snapshot a server answers when it ignores the policy header, without asking again', async () => {
    const asked = server(() => json(legacySnapshot))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked).toHaveLength(1)
    expect(state()).toMatchObject({ loading: false, snapshot: { company: { id: companyId, role: 'owner' } } })
    expect(state()?.error).toBeUndefined()
    // Owners and admins invite, as before policy 1.2; members and pending invitations are all there.
    expect(companyInvitationPolicy(state()?.snapshot)).toBeUndefined()
    expect(state()?.snapshot?.members).toHaveLength(3)
    expect(state()?.snapshot?.invitations.length).toBeGreaterThan(0)

    // The account keeps the plain read from now on.
    await loadCompanyAdmin(bridge(), account, companyId, { quiet: true })
    expect(asked.map(request => request.policy)).toEqual(['1.3', undefined])
  })

  it('steps down one read at a time when the server refuses each profile (400), ending at the plain read', async () => {
    const asked = server(profiled => profiled ? refused() : json(legacySnapshot))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked.map(request => request.policy)).toEqual(['1.3', '1.2', undefined])
    expect(state()?.snapshot?.company.id).toBe(companyId)
    expect(state()?.error).toBeUndefined()
  })

  it('treats a 503 as a failure, not an older server: no older read, and the next read asks policy 1.3 again', async () => {
    const asked = server(() => json('{"error":"matrix_503"}', 503))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked.map(request => request.policy)).toEqual(['1.3'])
    expect(state()).toMatchObject({ error: 'unavailable', loading: false })
    await loadCompanyAdmin(bridge(), account, companyId)
    expect(asked.map(request => request.policy)).toEqual(['1.3', '1.3'])
  })

  it('treats a malformed 200 as a failure, not an older server', async () => {
    const malformed = { ...JSON.parse(legacySnapshot) as Record<string, unknown>, members: 'nobody' }
    const asked = server(() => json(JSON.stringify(malformed)))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(asked.map(request => request.policy)).toEqual(['1.3'])
    expect(state()).toMatchObject({ error: 'unavailable', loading: false })
    expect(state()?.snapshot).toBeUndefined()
  })

  it('refuses a plain 1.3 snapshot for another company even under the fallback', async () => {
    const other = JSON.parse(legacySnapshot) as { company: { id: string } }
    other.company.id = '00000000-0000-4000-8000-8f71c3161f99'
    server(() => json(JSON.stringify(other)))

    await loadCompanyAdmin(bridge(), account, companyId)

    expect(state()).toMatchObject({ error: 'unavailable' })
  })
})

describe('invite readiness on an older server', () => {
  it('reads profile 3 (direct add) where the server has it', async () => {
    const asked = server(() => json(readiness3))

    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toMatchObject({
      state: 'ready', value: { schemaVersion: 3, directAdd: 'ready' }
    })
    expect(asked.map(request => request.invites)).toEqual(['3'])
  })

  it('steps down to profile 2 (mail state) where the server refuses 3', async () => {
    const asked = server((_profiled, headers) => headers.invites === '3' ? refused() : json(readiness2))

    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toMatchObject({ state: 'ready', value: { schemaVersion: 2 } })
    expect(asked.map(request => request.invites)).toEqual(['3', '2'])
  })

  it('is ready where the server answers company-invites/1 only', async () => {
    const asked = server((_profiled, headers) => headers.invites === '1' ? json(readiness) : refused())

    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toMatchObject({ state: 'ready', value: { schemaVersion: 1 } })
    expect(asked.map(request => request.invites)).toEqual(['3', '2', '1'])

    // The account keeps the read it settled on.
    await loadTeamSpaceInviteReadiness(bridge(), account, { force: true })
    expect(asked.map(request => request.invites)).toEqual(['3', '2', '1', '1'])
  })

  it('never takes a profile 2 body as profile 3', async () => {
    server(() => json(readiness2))

    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toEqual({ state: 'unknown' })
  })

  it('is unsupported when the server ignores the header and answers the plain 1.3 capabilities', async () => {
    const asked = server(() => json(legacyCapabilities))

    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toEqual({ state: 'unsupported' })
    expect(asked[0]?.invites).toBe('3')
    expect(currentTeamSpaceInviteReadiness(account)).toEqual({ state: 'unsupported' })
  })

  it('is unsupported on a 400, and stays unknown through a 503 or a malformed answer', async () => {
    server(() => json('{"error":"matrix_400"}', 400))
    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toEqual({ state: 'unsupported' })

    clearTeamSpaceDiscovery()
    server(() => json('{"error":"matrix_503"}', 503))
    await expect(loadTeamSpaceInviteReadiness(bridge(), account)).resolves.toEqual({ state: 'unknown' })

    server(() => json('{"schemaVersion":1}'))
    await expect(loadTeamSpaceInviteReadiness(bridge(), account, { force: true })).resolves.toEqual({ state: 'unknown' })
  })
})
