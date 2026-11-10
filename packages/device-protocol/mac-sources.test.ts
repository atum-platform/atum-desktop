import { describe, expect, it } from 'vitest'

import { boundedScan, parseMacSourcesRequest, scanRequest } from './mac-sources'

describe('shared Mac source wire contract', () => {
  it.each(['mac.list_message_conversations', 'mac.list_browser_history', 'mac.read_city_location'])('produces a validated metadata-only request for %s', operation => {
    const request = scanRequest(operation)
    expect(request).not.toBeNull()
    expect(parseMacSourcesRequest(request)).toBe(request)
    expect(request?.op).not.toBe('messages.read')
    if (request?.op === 'location.current') expect(request.precision).toBe('city')
  })

  it('preserves valid foreground requests and rejects unknown operations and additive fields', () => {
    for (const request of [
      { op: 'messages.read', id: '123', days: 90, limit: 60 },
      { op: 'location.current', precision: 'precise' }
    ]) {
      expect(parseMacSourcesRequest(request)).toBe(request)
      expect(parseMacSourcesRequest({ ...request, mayPrompt: true })).toBeNull()
    }
    expect(scanRequest('mac.read_messages')).toBeNull()
    for (const value of [null, [], {}, { op: 'messages.conversations', days: 0, limit: 40 },
      { op: 'messages.read', id: '1', days: 1, limit: 61 },
      { op: 'browser.history', browser: 'all', days: 91, limit: 50, mode: 'recent' },
      { op: 'location.current', precision: 'city', extra: 'x'.repeat(4096) }]) {
      expect(parseMacSourcesRequest(value)).toBeNull()
    }
  })

  it('accepts serialized metadata while rejecting foreign, stale and private scan data', () => {
    const now = 100_000_000
    const entry = { objectId: 'A:city', provenance: { deviceServiceId: 'A' }, observedAt: now, fresh: true, data: { timeZone: 'UTC' } }
    const scan = { status: 'ok', cursor: 'cursor', entries: [entry] }
    expect(boundedScan(JSON.stringify(scan), 'A', now)).toEqual(scan)
    expect(boundedScan(scan, 'B', now)).toBeNull()
    expect(boundedScan(scan, 'A', now + 86_400_001)).toBeNull()
    expect(boundedScan({ ...scan, entries: [{ ...entry, data: { text: 'private' } }] }, 'A', now)).toBeNull()
  })
})
