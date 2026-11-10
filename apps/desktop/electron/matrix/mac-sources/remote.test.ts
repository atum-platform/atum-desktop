import { describe, expect, it, vi } from 'vitest'

import type { DeviceGrant } from '../device/contracts'

import { MacSourceReadiness } from './readiness'
import { grantSourcePosture, RemoteMacSourcesService, type SourceAuthorityQuery } from './remote'
import { scanResult } from './scan'
const grant = { originKind: 'device', agentPrincipal: 'agent', targetDeviceServiceId: 'mac-a' } as DeviceGrant
const read = { mode: 'read', request: { op: 'location.current', precision: 'city' } }

function harness(enabled = true) {
  let revision = 1
  let scope = 'a'
  const request = vi.fn(async (_payload: unknown, _context: unknown, _signal: AbortSignal) => '{"timeZone":"UTC"}')

  const check = vi.fn(async (q: SourceAuthorityQuery) => ({ profile: 'atum.agent-source-authority/1', ownerPrincipal: q.ownerPrincipal,
    agentPrincipal: q.agentPrincipal, gate: q.gate, revision, allowed: q.expectedRevision === null || q.expectedRevision === revision }))

  const service = new RemoteMacSourcesService({ enabled: () => enabled, scope: () => scope, ownerPrincipal: () => 'owner', authority: check, request })

  return { service, request, check, revoke: () => { revision++ }, switch: () => { scope = 'b' } }
}

describe('grant-bound remote source reads, without host I/O', () => {
  it('remote-reads-off calls neither authority nor any reader', async () => {
    const h = harness(false)
    expect(await h.service.request(read, grant, new AbortController().signal)).toContain('disabled')
    expect(h.check).not.toHaveBeenCalled()
    expect(h.request).not.toHaveBeenCalled()
  })

  it('derives prompt and background posture from grants', () => {
    expect(grantSourcePosture(grant)).toEqual({ background: false, mayPrompt: true })
    expect(grantSourcePosture({ ...grant, originKind: 'other' })).toEqual({ background: false, mayPrompt: false })
    expect(grantSourcePosture({ ...grant, occurrenceId: 'o' })).toEqual({ background: true, mayPrompt: false })
  })
  it('schedule cannot promote message bodies or native prompts', async () => {
    const h = harness(), signal = new AbortController().signal, schedule = { ...grant, occurrenceId: 'o' }
    expect(await h.service.request({ mode: 'read', request: { op: 'messages.read', id: '1', days: 1, limit: 1 } }, schedule, signal)).toContain('disabled')
    expect(h.request).not.toHaveBeenCalled()
    await h.service.request(read, schedule, signal)
    expect(h.request.mock.calls[0]?.[1]).toEqual({ background: true, mayPrompt: false })
  })
  it.each(['revoke', 'switch'] as const)('drops buffered results on %s', async action => {
    const h = harness()
    h.request.mockImplementation(async () => { h[action]();

 return '{"secret":"buffered"}' })
    expect(await h.service.request(read, grant, new AbortController().signal)).toBe('{"error":"disabled"}')
  })
  it('checks start and release with captured revision; failures read nothing', async () => {
    const h = harness()
    expect(await h.service.request(read, grant, new AbortController().signal)).toContain('timeZone')
    expect(h.check.mock.calls.map(call => call[0].expectedRevision)).toEqual([null, 1])
    h.request.mockClear(); h.check.mockRejectedValue(new Error('offline'))
    expect(await h.service.request(read, grant, new AbortController().signal)).toContain('disabled')
    expect(h.request).not.toHaveBeenCalled()
  })
  it('interactive grant cannot scan', async () => {
    const h = harness()
    expect(await h.service.request({ mode: 'scan', operationRef: 'mac.read_city_location' }, grant, new AbortController().signal)).toContain('disabled')
    expect(h.request).not.toHaveBeenCalled()
  })
  it('bounds A→B→A replay by device, 24h and 50 items', () => {
    const now = Date.now(), history = Array.from({ length: 80 }, (_, n) => ({ browser: 'chrome', domain: 'example.com', path: `/${n}`, lastVisit: new Date(now - n * 1000).toISOString() }))
    history.unshift({ ...history[0]!, path: '/old', lastVisit: new Date(now - 86_400_001).toISOString() })
    const a = scanResult('a', { history }, undefined, now), b = scanResult('b', { history }, a.cursor, now), again = scanResult('a', { history }, b.cursor, now)

    for (const result of [a, b, again]) { expect(result.entries).toHaveLength(50); expect(result.entries?.every(row => row.fresh)).toBe(true) }
    expect(b.entries?.[0]?.objectId).toMatch(/^b:/)
    expect(scanResult('a', { history }, a.cursor, now).entries?.every(row => !row.fresh)).toBe(true)
  })
  it('requires settled readiness after permission recovery', () => {
    const r = new MacSourceReadiness(), consent = { google: true, folders: true, teamSpaces: true, messages: true, browser: true, location: true }
    expect(r.snapshot(consent, 'granted', true, 0).messages).toBe('off')
    expect(r.snapshot(consent, 'granted', true, 30_000).messages).toBe('ready')
    expect(r.snapshot(consent, 'unknown', true, 31_000).messages).toBe('needs_permission')
    expect(r.snapshot(consent, 'granted', true, 32_000).messages).toBe('needs_permission')
    expect(r.snapshot(consent, 'granted', false, 90_000).location).toBe('off')
  })
})

it('clamps remote precise location to city and fails schedule-like empty occurrence IDs toward background', async () => {
  const h = harness()
  await h.service.request({ mode: 'read', request: { op: 'location.current', precision: 'precise' } }, grant, new AbortController().signal)
  expect(h.request.mock.calls[0]?.[0]).toEqual({ op: 'location.current', precision: 'city' })
  expect(grantSourcePosture({ ...grant, occurrenceId: '' })).toEqual({ background: true, mayPrompt: false })
})

it('a newly local OFF drops buffered results even before the server learns the revocation', async () => {
  let allowed = true

  const service = new RemoteMacSourcesService({ enabled: () => true, scope: () => 'a', allowed: () => allowed,
    ownerPrincipal: () => 'owner', authority: async q => ({ profile: 'atum.agent-source-authority/1', ownerPrincipal: q.ownerPrincipal,
      agentPrincipal: q.agentPrincipal, gate: q.gate, revision: 1, allowed: true }),
    request: async () => { allowed = false;

 return '{"secret":"buffered"}' } })

  expect(await service.request(read, grant, new AbortController().signal)).toBe('{"error":"disabled"}')
})

it('freshness is per row: one browser change cannot make unchanged history fresh', () => {
  const now = Date.now()
  const history = [0, 1].map(n => ({ browser: 'chrome', domain: 'example.com', path: `/${n}`, visits: 1, lastVisit: new Date(now - 1000).toISOString() }))
  const first = scanResult('a', { history }, undefined, now)
  const next = scanResult('a', { history: [history[0], { ...history[1], visits: 2 }] }, first.cursor, now + 1000)
  expect(next.entries).toHaveLength(1)
  expect(next.entries?.[0]?.fresh).toBe(true)
  expect(next.entries?.[0]?.data).toMatchObject({ path: '/1', visits: 2 })
})

it('unknown or denied macOS Location authorization never advertises ready', () => {
  const consent = { google: true, folders: true, teamSpaces: true, messages: true, browser: true, location: true }
  const readiness = new MacSourceReadiness()
  expect(readiness.snapshot(consent, 'granted', true, 0, 'denied').location).toBe('needs_permission')
  expect(readiness.snapshot(consent, 'granted', true, 100_000, 'unknown').location).toBe('needs_permission')
  expect(readiness.snapshot(consent, 'granted', true, 101_000, 'granted').location).toBe('needs_permission')
  expect(readiness.snapshot(consent, 'granted', true, 131_000, 'granted').location).toBe('ready')
})
