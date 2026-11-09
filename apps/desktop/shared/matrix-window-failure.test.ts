import { describe, expect, it } from 'vitest'

import {
  formatMatrixWindowFailureDiagnostic,
  matrixWindowFailureCode,
  parseMatrixWindowFailureDiagnostic
} from './matrix-window-failure'

describe('Matrix window failure diagnostics', () => {
  it('logs only the call, closed refusal code and retryability', () => {
    const value = { source: 'connectHermes', code: 'matrix_agent_unavailable', retryable: true }

    expect(formatMatrixWindowFailureDiagnostic(value)).toBe(
      '[Matrix] window failure source=connectHermes code=matrix_agent_unavailable retryable=true'
    )
  })

  it('extracts a native code without carrying Electron wrapper text, and otherwise uses Error.name', () => {
    expect(
      matrixWindowFailureCode(
        new Error("Error invoking remote method 'matrix:ui': Error: matrix_cloud_agent_unsupported")
      )
    ).toBe('matrix_cloud_agent_unsupported')
    expect(matrixWindowFailureCode(new TypeError('owner words must not be logged'))).toBe('TypeError')
  })

  it('drops free text, extra fields and unrecognised sources', () => {
    expect(
      parseMatrixWindowFailureDiagnostic({
        source: 'connectHermes',
        code: 'room !secret:test failed',
        retryable: true
      })
    ).toBeUndefined()
    expect(
      parseMatrixWindowFailureDiagnostic({
        source: 'connectHermes',
        code: 'matrix_agent_unavailable',
        retryable: true,
        message: 'secret'
      })
    ).toBeUndefined()
    expect(
      parseMatrixWindowFailureDiagnostic({ source: 'private.call', code: 'Error', retryable: false })
    ).toBeUndefined()
  })
})
