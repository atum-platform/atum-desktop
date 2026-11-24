import { describe, expect, it } from 'vitest'

import {
  matrixAssistantSetupRosterRetry,
  matrixAssistantSetupRunsLocally,
  matrixLocalExecutorRequired
} from './assistant-setup'
import { MATRIX_READINESS_TIMINGS } from './readiness'

describe('the default assistant’s local setup after the first roster sync', () => {
  it('skips every local step when the roster already places it in the cloud', () => {
    expect(matrixAssistantSetupRunsLocally({ cloudOnly: true })).toBe(false)
  })

  it('keeps local setup for an assistant that is not cloud-only', () => {
    expect(matrixAssistantSetupRunsLocally({ cloudOnly: false })).toBe(true)
  })
})

describe('a cold roster read', () => {
  it('waits the first backoff while placement is unknown, including failed discovery', () => {
    expect(matrixAssistantSetupRosterRetry({ placementKnown: false })).toBe(MATRIX_READINESS_TIMINGS.backoffMs[0])
  })

  it('continues only after placement is known', () => {
    expect(matrixAssistantSetupRosterRetry({ placementKnown: true })).toBeUndefined()
  })
})

describe('localExecutorRequired for an enrollment target', () => {
  it('follows the default’s placement for the unnamed target', () => {
    expect(
      matrixLocalExecutorRequired({
        principal: undefined,
        defaultCloudOnly: true,
        namedCloudOnly: () => true
      })
    ).toBe(false)
    expect(
      matrixLocalExecutorRequired({
        principal: undefined,
        defaultCloudOnly: false,
        namedCloudOnly: () => false
      })
    ).toBe(true)
  })

  it('follows a named principal this Mac knows', () => {
    expect(
      matrixLocalExecutorRequired({
        principal: 'named',
        defaultCloudOnly: true,
        namedCloudOnly: () => true
      })
    ).toBe(false)
    expect(
      matrixLocalExecutorRequired({
        principal: 'named',
        defaultCloudOnly: false,
        namedCloudOnly: () => false
      })
    ).toBe(true)
  })

  it('does not enroll an unknown named principal', () => {
    expect(
      matrixLocalExecutorRequired({
        principal: 'unknown',
        defaultCloudOnly: true,
        namedCloudOnly: () => undefined
      })
    ).toBe(false)
  })
})

it('does not enroll the default before its placement is known', () => {
  expect(matrixLocalExecutorRequired({ principal: undefined, defaultCloudOnly: undefined, namedCloudOnly: () => undefined })).toBe(false)
})
