import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { AtumObservability } from './atum-observability'
import { reportBackendExit, reportChildProcessGone, reportRendererGone, resetProcessReportLimits } from './process-exit-reports'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  resetProcessReportLimits()

  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-process-exit-'))
  dirs.push(dir)

  const sink = { event: vi.fn(), error: vi.fn(), feedback: vi.fn(async () => true), discard: vi.fn() }

  const options = {
    installationId: '00000000-0000-4000-8000-6d8f75c72e57',
    settingsPath: path.join(dir, 'reporting.json'),
    version: '0.20.17',
    revision: 'a'.repeat(40),
    packaged: true,
    config: {
      posthogHost: 'https://us.i.posthog.com',
      posthogKey: 'phc_test00000000',
      sentryDsn: 'https://abc@o1.ingest.sentry.io/1',
      environment: 'test' as const
    },
    createSink: () => sink
  }

  const reporter = new AtumObservability(options)

  sink.event.mockClear()

  return { reporter, sink }
}

test('a renderer crash is one closed-reason report; clean exits and opt-out send nothing', () => {
  const { reporter, sink } = harness()
  const crashSession = vi.fn()

  expect(reportRendererGone(reporter, { reason: 'clean-exit', exitCode: 0 }, { crashSession })).toBe(false)
  expect(reportRendererGone(reporter, { reason: 'private message', exitCode: 1 }, { crashSession })).toBe(false)
  expect(sink.error).not.toHaveBeenCalled()
  expect(sink.event).not.toHaveBeenCalled()
  expect(crashSession).not.toHaveBeenCalled()

  expect(reportRendererGone(reporter, { reason: 'crashed', exitCode: 139 }, { crashSession })).toBe(true)
  expect(sink.event).toHaveBeenCalledOnce()
  expect(sink.event).toHaveBeenCalledWith('operation_failed', expect.objectContaining({
    operation: 'renderer',
    code: 'process_gone'
  }))
  expect(sink.error).toHaveBeenCalledOnce()
  expect(sink.error.mock.calls[0][0]).toMatchObject({ operation: 'renderer', kind: 'crashed', exitCode: 139 })
  expect(JSON.stringify(sink.error.mock.calls[0][0])).not.toContain('private message')
  expect(crashSession).toHaveBeenCalledOnce()
})

test('opting out sends no renderer report while the consent switch is off', () => {
  const { reporter, sink } = harness()
  const crashSession = vi.fn()

  reporter.setEnabled(false)
  expect(reportRendererGone(reporter, { reason: 'killed' }, { crashSession })).toBe(true)
  expect(sink.event).not.toHaveBeenCalled()
  expect(sink.error).not.toHaveBeenCalled()
})

test('a GPU or utility child crash is reported as a main-process failure; other children and clean exits are ignored', () => {
  const { reporter, sink } = harness()

  expect(reportChildProcessGone(reporter, { type: 'GPU', reason: 'clean-exit', exitCode: 0 })).toBe(false)
  expect(reportChildProcessGone(reporter, { type: 'Zygote', reason: 'crashed', exitCode: 1 })).toBe(false)
  expect(reportChildProcessGone(reporter, { type: 'Utility', reason: 'oom', exitCode: 137 })).toBe(true)
  expect(sink.event).toHaveBeenCalledOnce()
  expect(sink.event).toHaveBeenCalledWith('operation_failed', expect.objectContaining({
    operation: 'main',
    code: 'process_gone'
  }))
  expect(sink.error.mock.calls[0][0]).toMatchObject({ operation: 'main', kind: 'oom', exitCode: 137, childType: 'Utility' })

  reporter.setEnabled(false)
  sink.event.mockClear()
  sink.error.mockClear()
  expect(reportChildProcessGone(reporter, { type: 'GPU', reason: 'crashed', exitCode: 139 })).toBe(true)
  expect(sink.event).not.toHaveBeenCalled()
  expect(sink.error).not.toHaveBeenCalled()
})

test('a non-clean backend exit reports its status class; clean or intentional stops and opt-out send nothing', () => {
  const { reporter, sink } = harness()

  expect(reportBackendExit(reporter, { code: 0, signal: null, intentional: false })).toBe(false)
  expect(reportBackendExit(reporter, { code: 1, signal: 'SIGTERM', intentional: true })).toBe(false)
  expect(sink.event).not.toHaveBeenCalled()
  expect(sink.error).not.toHaveBeenCalled()

  expect(reportBackendExit(reporter, { code: 1, signal: null, intentional: false })).toBe(true)
  expect(sink.event).toHaveBeenCalledWith('operation_failed', expect.objectContaining({
    operation: 'backend',
    code: 'process_gone'
  }))
  expect(sink.error.mock.calls[0][0]).toMatchObject({ operation: 'backend', kind: 'exit', exitCode: 1 })

  sink.event.mockClear()
  sink.error.mockClear()
  expect(reportBackendExit(reporter, { code: null, signal: 'SIGKILL', intentional: false })).toBe(true)
  expect(sink.error.mock.calls[0][0]).toMatchObject({ operation: 'backend', kind: 'SIGKILL' })

  reporter.setEnabled(false)
  sink.event.mockClear()
  sink.error.mockClear()
  expect(reportBackendExit(reporter, { code: 2, signal: null, intentional: false })).toBe(true)
  expect(sink.event).not.toHaveBeenCalled()
  expect(sink.error).not.toHaveBeenCalled()
})

test('a crash loop in one class sends one report per ten-minute cooldown', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const { reporter, sink } = harness()

  for (let i = 0; i < 25; i++) {
    expect(reportRendererGone(reporter, { reason: 'crashed', exitCode: 139 }, { crashSession: vi.fn() })).toBe(true)
  }

  expect(sink.event).toHaveBeenCalledOnce()
  expect(sink.error).toHaveBeenCalledOnce()

  vi.advanceTimersByTime(10 * 60_000)
  reportRendererGone(reporter, { reason: 'crashed', exitCode: 139 }, { crashSession: vi.fn() })
  expect(sink.event).toHaveBeenCalledTimes(2)
  expect(sink.error).toHaveBeenCalledTimes(2)
})

test('the per-process cap stops reports even for distinct classes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const { reporter, sink } = harness()
  const reasons = ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']

  for (const reason of reasons) {
    reportRendererGone(reporter, { reason, exitCode: 1 }, { crashSession: vi.fn() })
  }

  for (const reason of reasons) {
    reportChildProcessGone(reporter, { type: 'GPU', reason, exitCode: 1 })
  }

  for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGKILL', 'SIGTERM', 'SIGBUS', 'SIGHUP', 'SIGUSR1']) {
    reportBackendExit(reporter, { code: null, signal, intentional: false })
  }

  // 21 reportable classes were offered; only the 20-report process budget sends.
  expect(sink.event).toHaveBeenCalledTimes(20)
  expect(sink.error).toHaveBeenCalledTimes(20)
})
