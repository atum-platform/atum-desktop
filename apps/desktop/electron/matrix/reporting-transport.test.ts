import { expect, test, vi } from 'vitest'

const electron = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: electron.fetch } }))

import { fetchMatrixReporting } from './reporting-transport'

test('reporting Chromium transport omits credentials and bypasses the cache while preserving the sink request', async () => {
  const response = new Response(null, { status: 200 })
  const controller = new AbortController()
  const headers = { 'content-type': 'application/x-sentry-envelope' }
  const body = '{"event_id":"safe"}'
  electron.fetch.mockResolvedValueOnce(response)

  await expect(fetchMatrixReporting('https://o1.ingest.sentry.io/api/1/envelope/', {
    method: 'POST', headers, body, signal: controller.signal
  })).resolves.toBe(response)

  expect(electron.fetch).toHaveBeenCalledOnce()
  expect(electron.fetch).toHaveBeenCalledWith('https://o1.ingest.sentry.io/api/1/envelope/', {
    method: 'POST', headers, body, signal: controller.signal, credentials: 'omit', cache: 'no-store'
  })
})
