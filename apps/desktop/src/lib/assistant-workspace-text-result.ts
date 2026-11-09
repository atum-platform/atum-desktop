import type { WorkspaceTextFileLeaseDescriptor } from './workspace-text-file-lease'

export const ASSISTANT_TEXT_FAILURE_CODES = [
  'permission_required',
  'permission_denied',
  'permission_expired',
  'account_stale',
  'scope_escape',
  'conflict',
  'too_large',
  'io_failed'
] as const

export type AssistantTextFailureCode = (typeof ASSISTANT_TEXT_FAILURE_CODES)[number]

export interface AssistantTextSuccess {
  version: 1
  kind: 'workspace_text_file'
  outcome: 'success'
  descriptor: WorkspaceTextFileLeaseDescriptor
}

export interface AssistantTextFailure {
  version: 1
  kind: 'workspace_text_file'
  outcome: 'failure'
  code: AssistantTextFailureCode
  retryable: boolean
  incidentRef?: string
}

export interface AssistantTextResultEvent {
  sessionId: string
  toolCallId: string
  result: AssistantTextSuccess | AssistantTextFailure
}

const RETRYABLE: Record<AssistantTextFailureCode, boolean> = {
  permission_required: true,
  permission_denied: true,
  permission_expired: true,
  account_stale: true,
  scope_escape: false,
  conflict: true,
  too_large: false,
  io_failed: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])

  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function boundedString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function parseDescriptor(value: unknown): WorkspaceTextFileLeaseDescriptor | null {
  if (!isRecord(value) || !exactKeys(value, ['fileRef', 'displayName'])) {
    return null
  }

  if (!boundedString(value.fileRef) || !boundedString(value.displayName)) {
    return null
  }

  if (/[\\/\0]/u.test(value.displayName) || !/\.(?:md|txt)$/iu.test(value.displayName)) {
    return null
  }

  return { fileRef: value.fileRef, displayName: value.displayName }
}

/** Reject malformed/unknown wire values and never expose provider copy. */
export function parseAssistantTextResultEvent(value: unknown): AssistantTextResultEvent | null {
  if (!isRecord(value) || !exactKeys(value, ['sessionId', 'toolCallId', 'result'])) {
    return null
  }

  if (!boundedString(value.sessionId) || !boundedString(value.toolCallId) || !isRecord(value.result)) {
    return null
  }

  const result = value.result

  if (result.outcome === 'success') {
    if (!exactKeys(result, ['version', 'kind', 'outcome', 'descriptor'])) {
      return null
    }

    const descriptor = parseDescriptor(result.descriptor)

    if (result.version !== 1 || result.kind !== 'workspace_text_file' || !descriptor) {
      return null
    }

    return {
      sessionId: value.sessionId,
      toolCallId: value.toolCallId,
      result: { version: 1, kind: 'workspace_text_file', outcome: 'success', descriptor }
    }
  }

  if (
    result.outcome !== 'failure' ||
    !exactKeys(result, ['version', 'kind', 'outcome', 'code', 'retryable', 'rendererMessage'], ['incidentRef']) ||
    result.version !== 1 ||
    result.kind !== 'workspace_text_file' ||
    !ASSISTANT_TEXT_FAILURE_CODES.includes(result.code as AssistantTextFailureCode) ||
    typeof result.retryable !== 'boolean' ||
    !boundedString(result.rendererMessage, 512)
  ) {
    return null
  }

  const code = result.code as AssistantTextFailureCode

  if (result.retryable !== RETRYABLE[code]) {
    return null
  }

  if (
    result.incidentRef !== undefined &&
    (typeof result.incidentRef !== 'string' || !/^[a-f0-9]{20}$/u.test(result.incidentRef))
  ) {
    return null
  }

  return {
    sessionId: value.sessionId,
    toolCallId: value.toolCallId,
    result: {
      version: 1,
      kind: 'workspace_text_file',
      outcome: 'failure',
      code,
      retryable: result.retryable,
      ...(result.incidentRef ? { incidentRef: result.incidentRef as string } : {})
    }
  }
}
