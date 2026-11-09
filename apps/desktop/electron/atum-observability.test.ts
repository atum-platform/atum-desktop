import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { parseProductEvent } from '../shared/atum-observability'

import { AtumObservability } from './atum-observability'
import { analyticsInstallationId } from './desktop-installation'
import { diagnosticFrames } from './diagnostic-redaction'

const dirs: string[] = []
afterEach(() => {for (const dir of dirs.splice(0)) {fs.rmSync(dir, { recursive: true, force: true })}})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-reporting-')); dirs.push(dir)
  const sink = { event: vi.fn(), error: vi.fn(), feedback: vi.fn(async () => true), discard: vi.fn() }

  const options = {
    installationId: '00000000-0000-4000-8000-6d8f75c72e57', settingsPath: path.join(dir, 'reporting.json'),
    version: '0.17.0', revision: 'a'.repeat(40), packaged: true,
    config: { posthogHost: 'https://us.i.posthog.com', posthogKey: 'phc_test00000000', sentryDsn: 'https://abc@o1.ingest.sentry.io/1', environment: 'test' as const },
    createSink: () => sink
  }

  return { sink, options, reporter: new AtumObservability(options) }
}

test('default-on distributed reporting persists opt-out across real file reads, and explicit feedback still works', async () => {
  const { reporter, sink, options } = harness()
  expect(reporter.status()).toMatchObject({ enabled: true, configured: true })
  reporter.setEnabled(false)
  sink.event.mockClear()
  reporter.capture({ name: 'app_active', properties: {} })
  reporter.error({ operation: 'renderer', kind: 'TypeError' })
  expect(sink.event).not.toHaveBeenCalled()
  expect(sink.error).not.toHaveBeenCalled()
  expect(sink.discard).toHaveBeenCalledOnce()
  expect(new AtumObservability(options).status().enabled).toBe(false)
  expect(await reporter.feedback('The composer is slow')).toEqual({ sent: true })
  expect(sink.feedback).toHaveBeenCalledWith('The composer is slow')
  expect(sink.event).not.toHaveBeenCalled()
})

test('malformed preferences and SDK failures never turn reporting on or break startup', () => {
  const { options } = harness()
  fs.writeFileSync(options.settingsPath, '{broken')
  expect(new AtumObservability(options).status().enabled).toBe(false)
  expect(new AtumObservability({ ...options, createSink: () => {throw new Error('offline')} }).status().configured).toBe(false)
})

test('a turn seen in two windows produces one outcome and one count per tool; local correlation IDs never leave main', () => {
  const { reporter, sink } = harness()

  for (const owner of [1, 2]) {
    reporter.turn(owner, { key: 'private-session:turn-1', phase: 'start' })
    reporter.turn(owner, { key: 'private-session:turn-1', phase: 'tool', toolKey: 'private-tool-1' })
  }

  reporter.windowClosed(1)

  for (const owner of [2, 1, 2]) {reporter.turn(owner, { key: 'private-session:turn-1', phase: 'finish', outcome: 'completed' })}
  const events = sink.event.mock.calls.filter(([name]) => name === 'turn_finished')
  expect(events).toHaveLength(1)
  expect(events[0][1]).toMatchObject({ outcome: 'completed', tool_count: 1 })
  expect(JSON.stringify(sink.event.mock.calls)).not.toContain('private-')
})

test('closing the last observing window reports an unknown outcome, never a failed turn', () => {
  const { reporter, sink } = harness()
  reporter.turn(1, { key: 'turn', phase: 'start' })
  reporter.windowClosed(1)
  expect(sink.event.mock.calls.filter(([name]) => name === 'turn_finished')).toHaveLength(0)
  expect(sink.event.mock.calls.filter(([name]) => name === 'turn_observation_lost')).toHaveLength(1)
})

test('orphaned observations cannot exhaust the turn table for the rest of the launch', () => {
  const { reporter, sink } = harness()

  for (let index = 0; index < 300; index++) {reporter.turn(1, { key: `orphan-${index}`, phase: 'start' })}
  reporter.turn(1, { key: 'fresh', phase: 'start' })
  reporter.turn(1, { key: 'fresh', phase: 'finish', outcome: 'completed' })
  expect(sink.event.mock.calls.filter(([name]) => name === 'turn_finished')).toHaveLength(1)
})

test('untrusted event fields and text cannot enter an automatic payload', () => {
  expect(parseProductEvent({ name: 'app_opened', properties: { prompt: 'private chat' } })).toBeNull()
  expect(parseProductEvent({ name: 'feature_used', properties: { feature: '/home/example/file' } })).toBeNull()
  expect(parseProductEvent({ name: '__proto__', properties: {} })).toBeNull()
  expect(parseProductEvent({ name: 'app_ready', properties: { mode: 'local', duration_ms: Infinity } })).toBeNull()
  const id = analyticsInstallationId('private-installation')
  expect(id).toMatch(/^[a-f0-9]{32}$/)
  expect(id).not.toBe('private-installation')
})

test('diagnostics preserve bundled coordinates while removing messages, source names and private paths', () => {
  const { reporter, sink } = harness()
  const stack = 'TypeError: secret prompt\n at secretFunction (/home/example/Atum.app/Contents/Resources/app.asar/dist/assets/chat-abc.js:12:9)\n at x (/home/example/documents/secret.js:2:1)'
  expect(diagnosticFrames(stack)).toEqual([{ filename: 'app:///assets/chat-abc.js', lineno: 12, colno: 9, in_app: true }])
  reporter.error({ operation: 'renderer', kind: 'private error', stack })
  expect(sink.error.mock.calls[0][0]).toMatchObject({ kind: 'Error', operation: 'renderer' })
  expect(JSON.stringify(sink.error.mock.calls)).not.toMatch(/secret|private/)
})
