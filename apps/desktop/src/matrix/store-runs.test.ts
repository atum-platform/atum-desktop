import { createClient, MemoryStore } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { matrixStoreRunsEvent } from '../../shared/matrix-store-runs'

import { matrixStoreRuns } from './store-runs'

afterEach(() => vi.restoreAllMocks())

const ASSISTANT = '00000000-0000-4000-8000-20101becbd5c'
const claim = { occurrence: '2026-10-05T08:00', executorId: 'executor-a', claimedAt: 1_000 }
const ledger = { version: 2, runs: { 'agent/researcher/weekly-digest': claim } } as const

/** Real SDK HTTP over a disposable account-data server shared by the owner's Macs. */
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

  function mac(deviceId: string, active = () => true) {
    const userId = '@owner:test'

    const client = createClient({
      baseUrl: 'https://matrix.test',
      userId,
      deviceId,
      accessToken: 'fixture',
      store: new MemoryStore(),
      fetchFn: fetcher
    })

    return matrixStoreRuns(client, { userId, deviceId }, active)
  }

  return { records, fetcher, mac, key: `@owner:test:${matrixStoreRunsEvent(ASSISTANT)}` }
}

it("reads a claim one Mac wrote on another Mac, fresh from the server, in the assistant's own event", async () => {
  const s = server()

  expect(await s.mac('ONE').read(ASSISTANT)).toEqual({ version: 2, runs: {} })

  await s.mac('ONE').write(ASSISTANT, ledger)
  expect(s.records.get(s.key)).toEqual(ledger)
  expect(await s.mac('TWO').read(ASSISTANT)).toEqual(ledger)
})

it('never overwrites a newer schema, and refuses to read one', async () => {
  const s = server()
  s.records.set(s.key, { version: 3, runs: ledger.runs })

  await expect(s.mac('ONE').read(ASSISTANT)).rejects.toThrow('matrix_store_runs_readonly')
  await expect(s.mac('ONE').write(ASSISTANT, ledger)).rejects.toThrow('matrix_store_runs_readonly')
  expect(s.records.get(s.key)).toEqual({ version: 3, runs: ledger.runs })
})

it('names no event but a Store assistant’s, and writes nothing once signed out or for a bad claim', async () => {
  const s = server()

  await expect(s.mac('ONE').read('../io.atum.check_ins')).rejects.toThrow('matrix_store_runs_invalid')
  await expect(s.mac('ONE', () => false).read(ASSISTANT)).rejects.toThrow('matrix_store_runs_stale')
  await expect(s.mac('ONE', () => false).write(ASSISTANT, ledger)).rejects.toThrow('matrix_store_runs_invalid')
  await expect(
    s.mac('ONE').write(ASSISTANT, {
      version: 2,
      runs: { 'agent/researcher/weekly-digest': { ...claim, occurrence: 'Monday' } }
    })
  ).rejects.toThrow('matrix_store_runs_invalid')
  expect(s.fetcher).not.toHaveBeenCalled()
})

it('replaces the pre-release per-assistant shape, whose one claim names no job', async () => {
  const s = server()
  s.records.set(s.key, { version: 1, last: claim })

  expect(await s.mac('ONE').read(ASSISTANT)).toEqual({ version: 2, runs: {} })
  await s.mac('ONE').write(ASSISTANT, ledger)
  expect(s.records.get(s.key)).toEqual(ledger)
})
