import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FileChatGptTrainingRevokeJournal,
  MatrixChatGptTrainingConfirmation,
  type MatrixChatGptTrainingMethod,
  type MatrixChatGptTrainingRevokeJournal,
  requestMatrixChatGptTraining
} from './chatgpt-training-confirmation'

const resource = 'https://shell.test'
const CONNECTION = '0a1b2c3d-0000-4000-8000-00000000000a'

afterEach(() => vi.unstubAllGlobals())

describe('requestMatrixChatGptTraining', () => {
  it('reads with the owner bearer and the host-bridge contract, never a cookie or a body', async () => {
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      const request = new Request(url, init)
      expect(request.method).toBe('GET')
      expect(request.headers.get('authorization')).toBe('Bearer synthetic')
      expect(request.headers.get('x-atum-host-bridge-contract')).toBe('atum.s2.host-bridge/1.0.0')
      expect(request.headers.has('cookie')).toBe(false)
      expect(request.headers.has('idempotency-key')).toBe(false)
      expect(init.body).toBeUndefined()

      return Response.json({ current: false, wordingVersion: null, connectionId: null, confirmedAt: null, revision: null })
    })

    vi.stubGlobal('fetch', fetch)

    const answer = await requestMatrixChatGptTraining(resource, 'synthetic', 'GET', AbortSignal.timeout(1000))
    expect(String(fetch.mock.calls[0][0])).toBe(`${resource}/api/connections/openai-codex/training-confirmation`)
    expect(answer).toEqual({ status: 200, value: expect.objectContaining({ current: false }) })
  })

  it('sends the DELETE key as Idempotency-Key and a POST body as JSON', async () => {
    const seen: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      seen.push(new Request(url, init))

      return Response.json({ current: false, revision: 3 })
    }))

    await requestMatrixChatGptTraining(resource, 'synthetic', 'DELETE', AbortSignal.timeout(1000), { idempotencyKey: 'key-1' })
    await requestMatrixChatGptTraining(resource, 'synthetic', 'POST', AbortSignal.timeout(1000), { body: { a: 1 } })

    expect(seen[0].method).toBe('DELETE')
    expect(seen[0].headers.get('idempotency-key')).toBe('key-1')
    expect(seen[1].headers.get('content-type')).toBe('application/json')
    expect(await seen[1].json()).toEqual({ a: 1 })
  })

  it('lets the account refresh an expired bearer and refuses a non-https resource', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(requestMatrixChatGptTraining(resource, 'synthetic', 'GET', AbortSignal.timeout(1000)))
      .rejects.toThrow('matrix_s1_authentication')
    await expect(requestMatrixChatGptTraining('http://shell.test', 'synthetic', 'GET', AbortSignal.timeout(1000)))
      .rejects.toThrow('matrix_chatgpt_training_unavailable')
  })
})

type Call = { method: MatrixChatGptTrainingMethod; init?: { body?: unknown; idempotencyKey?: string } }
type Scope = { accountKey: string; generation: number }

const OWNER = 'a'.repeat(64)
const OTHER_OWNER = 'b'.repeat(64)
const KEY_1 = '11111111-1111-4111-8111-11111111111a'
const KEY_2 = '22222222-2222-4222-8222-22222222222b'

/** The journal as main keeps it: one entry per account, with every write in order. */
function memoryJournal(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial))
  const writes: Array<[string, string | null]> = []

  const journal: MatrixChatGptTrainingRevokeJournal = {
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
  required?: boolean
  keys?: string[]
  journal?: MatrixChatGptTrainingRevokeJournal
  scope?: Scope
  events?: string[]
} = {}) {
  const calls: Call[] = []
  let scope: Scope | null = options.scope ?? { accountKey: OWNER, generation: 1 }
  const keys = [...(options.keys ?? [KEY_1, KEY_2])]
  const sleep = vi.fn(async () => {})
  const journal = options.journal ?? memoryJournal().journal

  const confirmation = new MatrixChatGptTrainingConfirmation({
    scope: () => scope,
    call: async (method, _signal, init) => {
      calls.push({ method, ...(init ? { init } : {}) })
      options.events?.push(`${method}:${init?.idempotencyKey ?? ''}`)
      const next = answers.shift()

      if (!next) {
        throw new Error('no answer')
      }

      return next
    },
    required: () => options.required ?? true,
    journal,
    sleep,
    key: () => keys.shift() ?? 'key-x'
  })

  confirmation.activate(scope)

  return { calls, confirmation, sleep, setScope: (next: typeof scope) => { scope = next } }
}

const deleted = { status: 200, value: { current: false, revision: 4 } }
const draining = { status: 503, value: { state: 'unavailable' } }

const confirmed = {
  current: true,
  wordingVersion: 'chatgpt-google-v1',
  connectionId: CONNECTION,
  confirmedAt: '2026-11-16T03:00:00Z',
  revision: 3
}

describe('MatrixChatGptTrainingConfirmation', () => {
  it('reads the current confirmation with the account Google requirement', async () => {
    const { confirmation } = client([{ status: 200, value: confirmed }])

    expect(await confirmation.read()).toEqual({
      current: true,
      required: true,
      connectionId: CONNECTION,
      confirmedAt: Date.parse('2026-11-16T03:00:00Z')
    })
  })

  it('never reads another wording as current, and never reads a failure as absent', async () => {
    const { confirmation } = client([
      { status: 200, value: { ...confirmed, wordingVersion: 'chatgpt-google-v0' } },
      { status: 503, value: { state: 'unavailable' } }
    ])

    expect(await confirmation.read()).toMatchObject({ current: false, confirmedAt: null })
    await expect(confirmation.read()).rejects.toThrow('matrix_chatgpt_training_unavailable')
  })

  it('posts exactly the wording, the transfer wording and the connection the card read', async () => {
    const { calls, confirmation } = client([{ status: 200, value: confirmed }])

    expect(await confirmation.confirm(CONNECTION)).toMatchObject({ status: 'confirmed', training: { current: true } })
    expect(calls).toEqual([{ method: 'POST', init: { body: {
      wordingVersion: 'chatgpt-google-v1',
      connectionId: CONNECTION,
      transferWordingVersion: 'chatgpt-google-transfer-v1'
    } } }])
  })

  it('reports a changed connection as stale and sends nothing for a malformed one', async () => {
    const { calls, confirmation } = client([{ status: 409, value: { state: 'refused' } }])

    expect(await confirmation.confirm('not-a-uuid')).toEqual({ status: 'unavailable' })
    expect(calls).toEqual([])
    expect(await confirmation.confirm(CONNECTION)).toEqual({ status: 'stale' })
  })

  it('retries a draining revocation with the SAME key until it lands, then uses a new one', async () => {
    const { calls, confirmation, sleep } = client([
      { status: 503, value: { state: 'unavailable' } },
      { status: 503, value: { state: 'unavailable' } },
      { status: 200, value: { current: false, revision: 4 } },
      { status: 200, value: { current: false, revision: 4 } }
    ])

    expect(await confirmation.revoke()).toMatchObject({ status: 'revoked', training: { current: false } })
    expect(calls.map(call => call.init?.idempotencyKey)).toEqual([KEY_1, KEY_1, KEY_1])
    expect(sleep).toHaveBeenCalledTimes(2)

    await confirmation.revoke()
    expect(calls.at(-1)?.init?.idempotencyKey).toBe(KEY_2)
  })

  it('keeps the key across presses while live calls still drain, and fences a confirm meanwhile', async () => {
    const draining = Array.from({ length: 6 }, () => ({ status: 503, value: { state: 'unavailable' } }))
    const { calls, confirmation } = client([...draining, { status: 200, value: { current: false, revision: 5 } }])

    expect(await confirmation.revoke()).toEqual({ status: 'pending' })
    expect(await confirmation.confirm(CONNECTION)).toEqual({ status: 'unavailable' })
    expect(await confirmation.revoke()).toMatchObject({ status: 'revoked' })
    expect(new Set(calls.map(call => call.init?.idempotencyKey))).toEqual(new Set([KEY_1]))
    expect(calls.every(call => call.method === 'DELETE')).toBe(true)
  })

  it('keeps the key through a refusal, and stops a revocation whose account changed', async () => {
    const { calls, confirmation, setScope } = client([
      { status: 409, value: { state: 'refused' } },
      draining
    ])

    expect(await confirmation.revoke()).toEqual({ status: 'unavailable' })
    const flight = confirmation.revoke()
    setScope({ accountKey: OTHER_OWNER, generation: 1 })
    expect(await flight).toEqual({ status: 'unavailable' })
    expect(calls.map(call => call.init?.idempotencyKey)).toEqual([KEY_1, KEY_1])
  })
})

describe('the pending revocation key survives a restart', () => {
  it('is persisted for the owner before the first DELETE is sent', async () => {
    const events: string[] = []
    const { journal, saved } = memoryJournal()

    const recorded: MatrixChatGptTrainingRevokeJournal = {
      read: journal.read,
      write: (accountKey, key) => {
        events.push(`persist:${key ?? 'clear'}`)
        journal.write(accountKey, key)
      }
    }

    const { confirmation } = client([deleted], { journal: recorded, events })

    await confirmation.revoke()

    expect(events).toEqual([`persist:${KEY_1}`, `DELETE:${KEY_1}`, 'persist:clear'])
    expect(saved.size).toBe(0)
  })

  it('sends nothing when the key cannot be persisted', async () => {
    const { calls, confirmation } = client([deleted], {
      journal: { read: () => null, write: () => { throw new Error('disk full') } }
    })

    expect(await confirmation.revoke()).toEqual({ status: 'unavailable' })
    expect(calls).toEqual([])
  })

  it('keeps the key on disk through a 503 and clears it only on 200 {current:false}', async () => {
    const { journal, saved, writes } = memoryJournal()

    const { calls, confirmation } = client([
      draining,
      { status: 200, value: { current: true, revision: 4 } },
      deleted
    ], { journal })

    expect(await confirmation.revoke()).toEqual({ status: 'unavailable' })
    expect(saved.get(OWNER)).toBe(KEY_1)
    expect(await confirmation.revoke()).toMatchObject({ status: 'revoked' })

    expect(calls.map(call => call.init?.idempotencyKey)).toEqual([KEY_1, KEY_1, KEY_1])
    expect(writes).toEqual([[OWNER, KEY_1], [OWNER, null]])
    expect(saved.has(OWNER)).toBe(false)
  })

  it('resumes a persisted key on start-up, reads as revoking meanwhile, and fences a confirm', async () => {
    const { journal, saved } = memoryJournal({ [OWNER]: KEY_2 })

    let finish: (value: { status: number; value: unknown }) => void = () => {}
    const calls: Call[] = []

    const confirmation = new MatrixChatGptTrainingConfirmation({
      scope: () => ({ accountKey: OWNER, generation: 7 }),
      call: async (method, _signal, init) => {
        calls.push({ method, ...(init ? { init } : {}) })

        if (method === 'GET') {
          return { status: 200, value: { current: true, wordingVersion: 'chatgpt-google-v1', connectionId: CONNECTION,
            confirmedAt: '2026-11-16T03:00:00Z', revision: 3 } }
        }

        return new Promise(resolve => { finish = resolve })
      },
      required: () => true,
      journal,
      sleep: async () => {},
      key: () => KEY_1
    })

    // A new app session: the same owner, a new generation.
    confirmation.activate({ accountKey: OWNER, generation: 7 })

    expect(calls).toEqual([{ method: 'DELETE', init: { idempotencyKey: KEY_2 } }])
    expect(await confirmation.read()).toMatchObject({ revoking: true })
    expect(await confirmation.confirm(CONNECTION)).toEqual({ status: 'unavailable' })

    const pressed = confirmation.revoke()
    finish(deleted)
    expect(await pressed).toMatchObject({ status: 'revoked' })
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    expect(saved.has(OWNER)).toBe(false)
  })

  it('never shows or reuses one owner’s pending key for another owner', async () => {
    const { journal, saved } = memoryJournal({ [OWNER]: KEY_2 })
    const { calls, confirmation } = client([deleted], { journal, scope: { accountKey: OTHER_OWNER, generation: 1 } })

    expect(calls).toEqual([])
    await confirmation.revoke()

    expect(calls.map(call => call.init?.idempotencyKey)).toEqual([KEY_1])
    expect(saved.get(OWNER)).toBe(KEY_2)
  })

  it('keeps the key in a per-owner file that a new process reads back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-training-journal-'))

    try {
      new FileChatGptTrainingRevokeJournal(root).write(OWNER, KEY_1)
      const restarted = new FileChatGptTrainingRevokeJournal(root)

      expect(restarted.read(OWNER)).toBe(KEY_1)
      expect(restarted.read(OTHER_OWNER)).toBeNull()
      expect(fs.statSync(path.join(root, OWNER, 'revoke-intent.json')).mode & 0o777).toBe(0o600)

      restarted.write(OWNER, null)
      expect(restarted.read(OWNER)).toBeNull()
      expect(() => restarted.write('../escape', KEY_1)).toThrow('matrix_chatgpt_training_invalid')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
