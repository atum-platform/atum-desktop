import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileOwnerConsentRevokeJournal, type MatrixOwnerConsentMethod, type MatrixOwnerConsentRevokeJournal } from './owner-consent'
import { MatrixVideoGenerationConsent, requestMatrixVideoConsent } from './video-generation-consent'

const resource = 'https://shell.test'

afterEach(() => vi.unstubAllGlobals())

const notConsented = {
  current: false,
  wordingVersion: null,
  provider: 'minimax',
  providerModel: 'minimax/hailuo-3-max',
  locale: 'en',
  confirmedAt: null,
  revision: null
}

const consented = {
  ...notConsented,
  current: true,
  wordingVersion: 'minimax-video-v1',
  locale: 'vi',
  confirmedAt: '2026-11-17T03:00:00Z',
  revision: 2
}

describe('requestMatrixVideoConsent', () => {
  it('reads the owner endpoint with the owner bearer and the host-bridge contract, never a cookie', async () => {
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      const request = new Request(url, init)
      expect(request.method).toBe('GET')
      expect(request.headers.get('authorization')).toBe('Bearer synthetic')
      expect(request.headers.get('x-atum-host-bridge-contract')).toBe('atum.s2.host-bridge/1.0.0')
      expect(request.headers.has('cookie')).toBe(false)
      expect(init.body).toBeUndefined()

      return Response.json(notConsented)
    })

    vi.stubGlobal('fetch', fetch)

    const answer = await requestMatrixVideoConsent(resource, 'synthetic', 'GET', AbortSignal.timeout(1000))
    expect(String(fetch.mock.calls[0][0])).toBe(`${resource}/api/media/video-generation/consent`)
    expect(answer).toEqual({ status: 200, value: notConsented })
  })
})

type Call = { method: MatrixOwnerConsentMethod; init?: { body?: unknown; idempotencyKey?: string } }
type Scope = { accountKey: string; generation: number }

const OWNER = 'c'.repeat(64)
const OTHER_OWNER = 'd'.repeat(64)
const KEY_1 = '33333333-3333-4333-8333-33333333333c'
const KEY_2 = '44444444-4444-4444-8444-44444444444d'

function memoryJournal(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial))
  const writes: Array<[string, string | null]> = []

  const journal: MatrixOwnerConsentRevokeJournal = {
    read: accountKey => saved.get(accountKey) ?? null,
    write: (accountKey, key) => {
      writes.push([accountKey, key])

      if (key === null) {
        saved.delete(accountKey)
      } else {
        saved.set(accountKey, key)
      }
    }
  }

  return { journal, saved, writes }
}

function client(answers: Array<{ status: number; value: unknown }>, options: {
  journal?: MatrixOwnerConsentRevokeJournal
  scope?: Scope
  keys?: string[]
} = {}) {
  const calls: Call[] = []
  const scope: Scope = options.scope ?? { accountKey: OWNER, generation: 1 }
  const keys = [...(options.keys ?? [KEY_1, KEY_2])]

  const consent = new MatrixVideoGenerationConsent({
    scope: () => scope,
    call: async (method, _signal, init) => {
      calls.push({ method, ...(init ? { init } : {}) })
      const next = answers.shift()

      if (!next) {
        throw new Error('no answer')
      }

      return next
    },
    journal: options.journal ?? memoryJournal().journal,
    sleep: async () => {},
    key: () => keys.shift() ?? 'key-x'
  })

  consent.activate(scope)

  return { calls, consent }
}

const unavailable = { status: 503, value: { state: 'unavailable' } }
const revoked = { status: 200, value: { current: false, revision: 3 } }

describe('MatrixVideoGenerationConsent', () => {
  it('reads the consent and the wording language the server names', async () => {
    const { consent } = client([{ status: 200, value: notConsented }, { status: 200, value: consented }])

    expect(await consent.read()).toEqual({ current: false, locale: 'en', confirmedAt: null })
    expect(await consent.read()).toEqual({ current: true, locale: 'vi', confirmedAt: Date.parse('2026-11-17T03:00:00Z') })
  })

  it('never reads a failure, another wording or a projection without its locale as consented or absent', async () => {
    const { calls, consent } = client([
      unavailable,
      { status: 200, value: { ...consented, wordingVersion: 'minimax-video-v0' } },
      { status: 200, value: { ...notConsented, locale: 'fr' } },
      { status: 200, value: { ...notConsented, provider: 'other' } }
    ])

    await expect(consent.read()).rejects.toThrow('matrix_video_consent_unavailable')
    expect(await consent.read()).toMatchObject({ current: false, confirmedAt: null })
    await expect(consent.read()).rejects.toThrow('matrix_video_consent_unavailable')
    await expect(consent.read()).rejects.toThrow('matrix_video_consent_unavailable')
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('posts exactly the wording version and nothing else', async () => {
    const { calls, consent } = client([{ status: 200, value: consented }])

    expect(await consent.allow()).toEqual({
      status: 'allowed',
      consent: { current: true, locale: 'vi', confirmedAt: Date.parse('2026-11-17T03:00:00Z') }
    })
    expect(calls).toEqual([{ method: 'POST', init: { body: { wordingVersion: 'minimax-video-v1' } } }])
    expect(JSON.stringify(calls[0].init?.body)).toBe('{"wordingVersion":"minimax-video-v1"}')
  })

  it('reads an unknown wording (409) and other refusals as refused, and a 503 as unavailable', async () => {
    const { consent } = client([
      { status: 409, value: { state: 'refused' } },
      { status: 403, value: { state: 'refused' } },
      { status: 400, value: { state: 'refused' } },
      unavailable
    ])

    expect(await consent.allow()).toEqual({ status: 'refused' })
    expect(await consent.allow()).toEqual({ status: 'refused' })
    expect(await consent.allow()).toEqual({ status: 'refused' })
    expect(await consent.allow()).toEqual({ status: 'unavailable' })
  })

  it('turns off with one key reused through 503s, cleared only on 200 {current:false}', async () => {
    const { journal, saved, writes } = memoryJournal()

    const { calls, consent } = client([
      ...Array.from({ length: 6 }, () => unavailable),
      { status: 200, value: { current: true, revision: 3 } },
      revoked,
      revoked
    ], { journal })

    expect(await consent.revoke()).toEqual({ status: 'pending' })
    expect(saved.get(OWNER)).toBe(KEY_1)
    // A pending turn-off fences a new Allow: it finishes first, with its own key.
    expect(await consent.allow()).toEqual({ status: 'unavailable' })
    expect(await consent.revoke()).toEqual({ status: 'unavailable' })
    expect(saved.get(OWNER)).toBe(KEY_1)
    expect(await consent.revoke()).toEqual({ status: 'revoked' })

    expect(new Set(calls.map(call => call.init?.idempotencyKey))).toEqual(new Set([KEY_1]))
    expect(calls.every(call => call.method === 'DELETE')).toBe(true)
    expect(writes).toEqual([[OWNER, KEY_1], [OWNER, null]])

    await consent.revoke()
    expect(calls.at(-1)?.init?.idempotencyKey).toBe(KEY_2)
  })

  it('resumes a persisted key after a restart and reads as revoking meanwhile', async () => {
    const { journal, saved } = memoryJournal({ [OWNER]: KEY_2 })
    let finish: (value: { status: number; value: unknown }) => void = () => {}
    const calls: Call[] = []

    const consent = new MatrixVideoGenerationConsent({
      scope: () => ({ accountKey: OWNER, generation: 9 }),
      call: async (method, _signal, init) => {
        calls.push({ method, ...(init ? { init } : {}) })

        return method === 'GET' ? { status: 200, value: consented } : new Promise(resolve => { finish = resolve })
      },
      journal,
      sleep: async () => {},
      key: () => KEY_1
    })

    consent.activate({ accountKey: OWNER, generation: 9 })

    expect(calls).toEqual([{ method: 'DELETE', init: { idempotencyKey: KEY_2 } }])
    expect(await consent.read()).toMatchObject({ revoking: true })

    const pressed = consent.revoke()
    finish(revoked)
    expect(await pressed).toEqual({ status: 'revoked' })
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect(saved.has(OWNER)).toBe(false)
  })

  it('never resumes or reuses one owner’s pending key for another owner', async () => {
    const { journal, saved } = memoryJournal({ [OWNER]: KEY_2 })
    const { calls, consent } = client([revoked], { journal, scope: { accountKey: OTHER_OWNER, generation: 1 } })

    expect(calls).toEqual([])
    await consent.revoke()

    expect(calls.map(call => call.init?.idempotencyKey)).toEqual([KEY_1])
    expect(saved.get(OWNER)).toBe(KEY_2)
  })

  it('keeps the key in a per-owner file a new process reads back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-video-consent-journal-'))

    try {
      new FileOwnerConsentRevokeJournal(root).write(OWNER, KEY_1)
      const restarted = new FileOwnerConsentRevokeJournal(root)

      expect(restarted.read(OWNER)).toBe(KEY_1)
      expect(restarted.read(OTHER_OWNER)).toBeNull()
      expect(fs.statSync(path.join(root, OWNER, 'revoke-intent.json')).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
