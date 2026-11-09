import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { afterEach, expect, test, vi } from 'vitest'

import { createReportingSink } from './atum-reporting-sinks'

afterEach(() => vi.useRealTimers())
const config = { posthogKey: 'phc_test000000000', posthogHost: 'https://us.i.posthog.com', sentryDsn: 'https://abc@o1.ingest.sentry.io/1', environment: 'test' as const }

test('a new sink settles the original crashed session and preserves oldest-to-newest frames and release', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-sink-journal-'))
  let enabled = true
  const bodies: string[] = []
  const sessionPath = path.join(dir, 'session.json')

  const options = { config, id: 'a'.repeat(32), version: '0.17.0', revision: 'b'.repeat(40), enabled: () => enabled, sessionPath,
    fetch: (async (_url, init) => {bodies.push(String(init!.body));

 return new Response('{}', { status: 200 })}) as typeof fetch }

  const first = createReportingSink(options)
  const originalId = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).sid
  first.error({ operation: 'main', kind: 'TypeError', frames: [
    { filename: 'app:///electron-main.mjs', lineno: 10, colno: 1, in_app: true },
    { filename: 'app:///electron-main.mjs', lineno: 42, colno: 2, in_app: true }
  ] })
  first.endSession(true)
  const second = createReportingSink({ ...options, version: '0.18.0', revision: 'c'.repeat(40) })

  try {
    await vi.waitFor(() => expect(bodies.some(body => body.includes('recovered_after_restart'))).toBe(true))
    const recovered = bodies.find(body => body.includes('recovered_after_restart'))!
    expect(recovered).toContain(`atum-desktop@0.17.0+${'b'.repeat(40)}`)
    expect(recovered.indexOf('"lineno":10')).toBeLessThan(recovered.indexOf('"lineno":42'))
    expect(bodies.some(body => body.includes(originalId) && body.includes('"status":"crashed"') && body.includes('"init":false'))).toBe(true)
  } finally {
    enabled = false; first.discard(); second.discard()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('opting out aborts an actual outstanding SDK request, and no new automatic request begins', async () => {
  let enabled = true
  const signals: AbortSignal[] = []

  const sink = createReportingSink({
    config, id: 'a'.repeat(32), version: '0.17.0', revision: 'b'.repeat(40), enabled: () => enabled,
    fetch: ((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })) as typeof fetch
  })

  await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0))
  enabled = false
  sink.discard()
  expect(signals.every(signal => signal.aborted)).toBe(true)
  const count = signals.length
  sink.error({ operation: 'main', kind: 'Error', frames: [] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(signals).toHaveLength(count)
})

test('real SDK envelopes send only safe diagnostics; opt-out discards PostHog queue across opt-in and permits explicit feedback', async () => {
  let enabled = true
  const bodies: string[] = []

  const sink = createReportingSink({
    config, id: 'a'.repeat(32), version: '0.17.0', revision: 'b'.repeat(40), enabled: () => enabled,
    fetch: (async (_url, init) => {
      const raw = typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(init?.body as Uint8Array)
      bodies.push((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString())

      return new Response('{}', { status: 200 })
    }) as typeof fetch
  })

  sink.event('app_opened', { app_version: '0.17.0' })
  sink.error({ operation: 'renderer', kind: 'TypeError', frames: [{ filename: 'app:///assets/chat-abc.js', lineno: 42, colno: 3, in_app: true }] })
  await vi.waitFor(() => expect(bodies.some(body => body.includes('renderer: TypeError'))).toBe(true))
  const errorBody = bodies.find(body => body.includes('renderer: TypeError'))!
  expect(errorBody).toContain('app:///assets/chat-abc.js')
  expect(errorBody).toContain('renderer: TypeError')
  expect(errorBody).not.toMatch(/minidump|breadcrumb|\/Users\/|ip_address|server_name/)
  const beforeOptOut = bodies.length
  enabled = false
  sink.discard()
  sink.error({ operation: 'renderer', kind: 'Error', frames: [] })
  enabled = true

  // New events after opting back in use a new queue; the earlier app_opened is gone.
  for (let i = 0; i < 20; i++) {sink.event('app_active', {})}
  await vi.waitFor(() => expect(bodies.some(body => body.includes('app_active'))).toBe(true))
  // posthog-node compresses larger payloads; decode actual bytes at the boundary.
  expect(bodies.slice(beforeOptOut).join('')).not.toContain('app_opened')
  expect(bodies.slice(beforeOptOut).join('')).toContain('app_active')
  enabled = false
  sink.discard()
  expect(await sink.feedback('Explicitly submitted feedback')).toBe(true)
  expect(bodies.at(-1)).toContain('Explicitly submitted feedback')
})

test('a live renderer crash settles as crashed once and leaves no recovered_after_restart marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-sink-live-crash-'))
  let enabled = true
  const bodies: string[] = []
  const sessionPath = path.join(dir, 'session.json')

  const options = { config, id: 'a'.repeat(32), version: '0.17.0', revision: 'b'.repeat(40), enabled: () => enabled, sessionPath,
    fetch: (async (_url, init) => {bodies.push(String(init!.body));

 return new Response('{}', { status: 200 })}) as typeof fetch }

  const first = createReportingSink(options)
  first.error({ operation: 'renderer', kind: 'crashed', frames: [] })
  first.endSession(true, { delivered: true })

  try {
    await vi.waitFor(() => expect(bodies.some(body => body.includes('"status":"crashed"'))).toBe(true))
    const delivered = bodies.length
    const second = createReportingSink({ ...options, version: '0.18.0', revision: 'c'.repeat(40) })

    try {
      await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(delivered))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(bodies.some(body => body.includes('recovered_after_restart'))).toBe(false)
    } finally {
      enabled = false; second.discard()
    }
  } finally {
    enabled = false; first.discard()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
