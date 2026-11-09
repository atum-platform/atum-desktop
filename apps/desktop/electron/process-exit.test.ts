import { expect, test } from 'vitest'

import {
  backendExitReport,
  childProcessGoneReport,
  PROCESS_GONE_REASONS,
  PROCESS_SIGNALS,
  processExitCode,
  processGoneReason,
  rendererGoneReport
} from './process-exit'

test('only the closed Electron reason set is accepted, and clean-exit is never a report', () => {
  expect(rendererGoneReport({ reason: 'clean-exit', exitCode: 0 })).toBeNull()
  expect(rendererGoneReport({ reason: 'message text', exitCode: 1 })).toBeNull()
  expect(rendererGoneReport({})).toBeNull()
  expect(processGoneReason('crashed')).toBe('crashed')

  for (const reason of PROCESS_GONE_REASONS) {
    expect(rendererGoneReport({ reason, exitCode: 3 })).toEqual({ kind: reason, exitCode: 3 })
  }
})

test('exit codes are bounded integers; anything else stays out of the report', () => {
  expect(processExitCode(0)).toBe(0)
  expect(processExitCode(-11)).toBe(-11)
  expect(processExitCode(1.5)).toBeUndefined()
  expect(processExitCode(Number.NaN)).toBeUndefined()
  expect(processExitCode('1')).toBeUndefined()
  expect(processExitCode(2 ** 32)).toBeUndefined()
  expect(rendererGoneReport({ reason: 'oom' })).toEqual({ kind: 'oom' })
  expect(rendererGoneReport({ reason: 'oom', exitCode: '9' })).toEqual({ kind: 'oom' })
})

test('GPU and utility child failures report; other child types and clean exits do not', () => {
  expect(childProcessGoneReport({ type: 'GPU', reason: 'crashed', exitCode: 139 })).toEqual({
    kind: 'crashed',
    exitCode: 139
  })
  expect(childProcessGoneReport({ type: 'Utility', reason: 'killed' })).toEqual({ kind: 'killed' })
  expect(childProcessGoneReport({ type: 'GPU', reason: 'clean-exit', exitCode: 0 })).toBeNull()
  expect(childProcessGoneReport({ type: 'Zygote', reason: 'crashed' })).toBeNull()
  expect(childProcessGoneReport({ type: 'Unknown', reason: 'oom' })).toBeNull()
})

test('a clean or intentional backend exit is not a failure; a signal or status is', () => {
  expect(backendExitReport({ code: 0, signal: null, intentional: false })).toBeNull()
  expect(backendExitReport({ code: 1, signal: 'SIGTERM', intentional: true })).toBeNull()
  expect(backendExitReport({ code: 1, signal: null, intentional: false })).toEqual({ kind: 'exit', exitCode: 1 })
  expect(backendExitReport({ code: null, signal: 'SIGKILL', intentional: false })).toEqual({ kind: 'SIGKILL' })
  expect(backendExitReport({ code: null, signal: null, intentional: false })).toEqual({ kind: 'exit' })
  expect(backendExitReport({ code: null, signal: 'SIGWEIRD', intentional: false })).toEqual({ kind: 'signal' })
  expect(PROCESS_SIGNALS).toContain('SIGKILL')
})
