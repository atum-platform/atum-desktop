import { describe, expect, it } from 'vitest'

import { ASSISTANT_TEXT_FAILURE_CODES, parseAssistantTextResultEvent } from './assistant-workspace-text-result'

const RETRYABLE = new Set([
  'permission_required',
  'permission_denied',
  'permission_expired',
  'account_stale',
  'conflict',
  'io_failed'
])

const failure = (code: string) => ({
  sessionId: 'session-1',
  toolCallId: 'call-1',
  result: {
    version: 1,
    kind: 'workspace_text_file',
    outcome: 'failure',
    code,
    retryable: RETRYABLE.has(code),
    rendererMessage: 'provider copy is not a renderer contract',
    incidentRef: '0123456789abcdefabcd'
  }
})

describe('parseAssistantTextResultEvent', () => {
  it('accepts the opaque S4 descriptor without exposing provider-authored copy', () => {
    expect(
      parseAssistantTextResultEvent({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        result: {
          version: 1,
          kind: 'workspace_text_file',
          outcome: 'success',
          descriptor: { fileRef: 'opaque-file-ref', displayName: 'notes.md' }
        }
      })
    ).toEqual({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'opaque-file-ref', displayName: 'notes.md' }
      }
    })
  })

  it.each(ASSISTANT_TEXT_FAILURE_CODES)('accepts closed failure %s with its fixed retry policy', code => {
    const parsed = parseAssistantTextResultEvent(failure(code))

    expect(parsed?.result).toEqual({
      version: 1,
      kind: 'workspace_text_file',
      outcome: 'failure',
      code,
      retryable: RETRYABLE.has(code),
      incidentRef: '0123456789abcdefabcd'
    })
    expect(JSON.stringify(parsed)).not.toContain('provider copy')
  })

  it.each([
    { ...failure('io_failed'), extra: true },
    { ...failure('io_failed'), result: { ...failure('io_failed').result, version: 2 } },
    { ...failure('unknown_failure') },
    { ...failure('scope_escape'), result: { ...failure('scope_escape').result, retryable: true } },
    { ...failure('io_failed'), result: { ...failure('io_failed').result, rendererMessage: '' } },
    { ...failure('io_failed'), result: { ...failure('io_failed').result, incidentRef: 123 } },
    {
      ...failure('io_failed'),
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'x', displayName: '../x.md' }
      }
    }
  ])('fails closed on malformed or expanded envelopes', value => {
    expect(parseAssistantTextResultEvent(value)).toBeNull()
  })
})
