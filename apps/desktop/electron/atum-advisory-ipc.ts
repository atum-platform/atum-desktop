import type { IpcMainInvokeEvent } from 'electron'

import {
  type AdvisorySearchInvocation,
  type AdvisorySearchResult,
  parseAdvisorySearchResult
} from '../shared/atum-advisory-search'

import type { PrivateAdvisoryRunner } from './atum-messaging/private-advisory-runner'

export const ATUM_ADVISORY_IPC_CHANNELS = [
  'atum:advisory:claim',
  'atum:advisory:attach',
  'atum:advisory:running',
  'atum:advisory:complete',
  'atum:advisory:fail',
  'atum:advisory:cancel-conversation',
  'atum:advisory:search'
] as const
export const ATUM_ADVISORY_JOB_EVENT = 'atum:advisory:job'
export const ATUM_ADVISORY_CANCEL_EVENT = 'atum:advisory:cancel'

interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

function uuid(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${name} must be a UUID`)
  }

  return value
}

function profile(value: unknown): string {
  return text(value, 'profile', 128)
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) {
    throw new Error(`${name} is invalid`)
  }

  return value.trim()
}

function searchInvocation(value: unknown): AdvisorySearchInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('search request is invalid')
  }

  const row = value as Record<string, unknown>

  return {
    request_id: text(row.request_id, 'requestId', 256),
    session_id: text(row.session_id, 'sessionId', 256),
    turn_id: text(row.turn_id, 'turnId', 256),
    profile: profile(row.profile)
  }
}

/** Narrow main/preload door. Platform credentials and lease tokens stay in the runner. */
export function registerAtumAdvisoryIpc(
  ipc: IpcMainLike,
  runner: PrivateAdvisoryRunner,
  trusted: (event: IpcMainInvokeEvent) => void,
  search?: (invocation: AdvisorySearchInvocation) => Promise<AdvisorySearchResult> | AdvisorySearchResult
): () => void {
  ipc.handle('atum:advisory:claim', async (event, clientOperationId) => {
    trusted(event)

    return runner.claim(uuid(clientOperationId, 'clientOperationId'))
  })
  ipc.handle('atum:advisory:attach', async event => {
    trusted(event)

    return runner.attachRenderer()
  })
  ipc.handle('atum:advisory:running', async (event, jobId, runtimeSessionId, durableSessionId, localProfile) => {
    trusted(event)
    await runner.running(
      uuid(jobId, 'jobId'),
      text(runtimeSessionId, 'runtimeSessionId', 256),
      durableSessionId === undefined || durableSessionId === null
        ? null
        : text(durableSessionId, 'durableSessionId', 256),
      localProfile === undefined || localProfile === null ? null : profile(localProfile)
    )
  })
  ipc.handle('atum:advisory:complete', async (event, jobId, replyText) => {
    trusted(event)
    await runner.complete(uuid(jobId, 'jobId'), text(replyText, 'replyText', 20_000))
  })
  ipc.handle('atum:advisory:fail', async (event, jobId, errorCode, retryable) => {
    trusted(event)
    await runner.fail(uuid(jobId, 'jobId'), text(errorCode, 'errorCode', 120), retryable === true)
  })
  ipc.handle('atum:advisory:cancel-conversation', async (event, conversationId, targetId) => {
    trusted(event)
    await runner.cancelConversation(
      uuid(conversationId, 'conversationId'),
      targetId === undefined ? undefined : uuid(targetId, 'targetId')
    )
  })
  ipc.handle('atum:advisory:search', async (event, invocation) => {
    trusted(event)

    if (!search) {
      return parseAdvisorySearchResult(null)
    }

    return parseAdvisorySearchResult(await search(searchInvocation(invocation)))
  })

  return () => ATUM_ADVISORY_IPC_CHANNELS.forEach(channel => ipc.removeHandler?.(channel))
}
