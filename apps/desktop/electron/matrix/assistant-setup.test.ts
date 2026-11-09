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

describe('a cold first roster read that does not name the default', () => {
  it('waits the first backoff instead of failing the setup', () => {
    expect(matrixAssistantSetupRosterRetry({ roster: undefined, defaultPrincipal: undefined })).toBe(
      MATRIX_READINESS_TIMINGS.backoffMs[0]
    )
    expect(
      matrixAssistantSetupRosterRetry({
        roster: { ok: false, code: 'agent_roster_unavailable' },
        defaultPrincipal: undefined
      })
    ).toBe(MATRIX_READINESS_TIMINGS.backoffMs[0])
  })

  it('continues once the roster names the default, or once a sync has already named it', () => {
    expect(matrixAssistantSetupRosterRetry({ roster: { ok: true }, defaultPrincipal: undefined })).toBeUndefined()
    expect(
      matrixAssistantSetupRosterRetry({ roster: { ok: false, code: 'agent_roster_unavailable' }, defaultPrincipal: 'p' })
    ).toBeUndefined()
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

  it('defaults an unknown named principal to local enrollment', () => {
    expect(
      matrixLocalExecutorRequired({
        principal: 'unknown',
        defaultCloudOnly: true,
        namedCloudOnly: () => undefined
      })
    ).toBe(true)
  })
})
