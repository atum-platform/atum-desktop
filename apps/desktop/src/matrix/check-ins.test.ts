import { createClient, MatrixEvent, MemoryStore } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_CHECK_IN_EVENTS, type MatrixCheckInNudge } from '../../shared/matrix-check-ins'

import { matrixCheckIns } from './check-ins'
import { matrixMessage } from './message'

afterEach(() => vi.restoreAllMocks())

const nudge: MatrixCheckInNudge = {
  kind: 'deadline',
  key: 'quote-lan',
  text: 'Báo giá cho chị Lan hết hạn chiều nay.',
  source: 'files',
  ref: 'quote.md',
  action: 'draft'
}

/** Real SDK HTTP and cache over a disposable account-data server; a PUT is never a sync. */
function server() {
  const records = new Map<string, Record<string, unknown>>()

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const match = url.pathname.match(/\/user\/([^/]+)\/account_data\/(.+)$/)!
    const key = `${decodeURIComponent(match[1]!)}:${decodeURIComponent(match[2]!)}`

    if (init?.method === 'PUT') {
      records.set(key, JSON.parse(String(init.body)))

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const value = records.get(key)

    return new Response(JSON.stringify(value ?? { errcode: 'M_NOT_FOUND', error: 'Not found' }), {
      status: value ? 200 : 404,
      headers: { 'Content-Type': 'application/json' }
    })
  })

  function device(userId = '@alice:test', deviceId = 'ONE') {
    const identity = { userId, deviceId }
    const store = new MemoryStore()
    const client = createClient({ baseUrl: 'https://matrix.test', userId, deviceId, accessToken: 'fixture', store, fetchFn: fetcher })
    const checkIns = matrixCheckIns(client, identity, () => true, () => 1_000)

    const echo = (type: string) => {
      const value = records.get(`${userId}:${type}`)

      if (value) {
        store.storeAccountDataEvents([new MatrixEvent({ type, content: value })])
      }
    }

    return { identity, checkIns, echo }
  }

  return { records, device }
}

it('starts on, with an 08:00 brief, for an account that never chose', () => {
  const view = server().device().checkIns.snapshot(true)

  expect(view.settings).toEqual({ enabled: true, brief: '08:00' })
  expect(view.writable).toBe(true)
})

it('turns check-ins off on one Mac and every Mac of the owner sees it after sync', async () => {
  const s = server()
  const first = s.device()
  const second = s.device('@alice:test', 'TWO')

  await first.checkIns.change({ identity: first.identity, change: { field: 'enabled', value: false, by: 'asked' } })
  expect(s.records.get(`@alice:test:${MATRIX_CHECK_IN_EVENTS.settings}`)).toEqual({
    version: 1,
    enabled: false,
    brief: '08:00',
    offAt: 1_000,
    offBy: 'asked'
  })

  second.echo(MATRIX_CHECK_IN_EVENTS.settings)
  expect(second.checkIns.snapshot(true).settings.enabled).toBe(false)
})

it('records an answer to a nudge apart from the settings and the ledger', async () => {
  const s = server()
  const d = s.device()

  await d.checkIns.feedback({ identity: d.identity, feedback: { kind: 'snooze', nudge, until: 9_000 } })
  await d.checkIns.feedback({ identity: d.identity, feedback: { kind: 'less', nudge: 'meeting' } })

  expect(s.records.get(`@alice:test:${MATRIX_CHECK_IN_EVENTS.feedback}`)).toEqual({
    version: 1,
    muted: ['meeting'],
    snoozed: [{ key: 'quote-lan', until: 9_000, nudge }],
    ackAt: 1_000
  })
  expect(s.records.has(`@alice:test:${MATRIX_CHECK_IN_EVENTS.settings}`)).toBe(false)
  expect(s.records.has(`@alice:test:${MATRIX_CHECK_IN_EVENTS.ledger}`)).toBe(false)
})

it("reads all three records fresh, writes the ledger, and refuses a newer schema rather than overwrite it", async () => {
  const s = server()
  const d = s.device()

  expect((await d.checkIns.read()).ledger.runs).toBe(0)
  await d.checkIns.writeLedger({
    day: '2026-10-05',
    runs: 2,
    nudges: 1,
    lastRunAt: 5,
    lastNudgeAt: 6,
    ignored: 1,
    sent: [{ key: 'quote-lan', text: 'x', at: 6, run: 'r1' }],
    resurfaced: []
  })
  expect((await d.checkIns.read()).ledger).toMatchObject({ runs: 2, nudges: 1, sent: [{ key: 'quote-lan' }] })

  s.records.set(`@alice:test:${MATRIX_CHECK_IN_EVENTS.settings}`, { version: 2, enabled: true })
  await expect(d.checkIns.read()).rejects.toThrow('readonly')
  await expect(
    d.checkIns.change({ identity: d.identity, change: { field: 'enabled', value: false } })
  ).rejects.toThrow('readonly')
  expect(s.records.get(`@alice:test:${MATRIX_CHECK_IN_EVENTS.settings}`)).toEqual({ version: 2, enabled: true })

  d.echo(MATRIX_CHECK_IN_EVENTS.settings)
  expect(d.checkIns.snapshot(true).writable).toBe(false)
})

it("refuses another device's or account's change before any request", async () => {
  const s = server()
  const d = s.device()

  await expect(
    d.checkIns.change({ identity: { ...d.identity, deviceId: 'STALE' }, change: { field: 'introduced' } })
  ).rejects.toThrow('stale')
  expect(s.records.size).toBe(0)
})

it("shows a check-in's card only for a scheduled post that carries a valid nudge", () => {
  const event = (content: Record<string, unknown>, sender = '@atum:test') =>
    new MatrixEvent({ type: 'm.room.message', event_id: '$e', sender, origin_server_ts: 1, content })

  const post = { msgtype: 'm.text', body: nudge.text, 'io.atum.cron': { run: 'r', job: 'a7c4ec4e0001' } }

  expect(matrixMessage(event({ ...post, 'io.atum.nudge': nudge }), '@alice:test', new Set())?.checkIn).toEqual(nudge)
  // No cron marker: an ordinary message, whatever it claims.
  expect(matrixMessage(event({ msgtype: 'm.text', body: 'x', 'io.atum.nudge': nudge }), '@alice:test', new Set())?.checkIn).toBeUndefined()
  // A malformed nudge, or your own message: no card.
  expect(matrixMessage(event({ ...post, 'io.atum.nudge': { ...nudge, action: 'send' } }), '@alice:test', new Set())?.checkIn).toBeUndefined()
  expect(matrixMessage(event({ ...post, 'io.atum.nudge': nudge }, '@alice:test'), '@alice:test', new Set())?.checkIn).toBeUndefined()
})
