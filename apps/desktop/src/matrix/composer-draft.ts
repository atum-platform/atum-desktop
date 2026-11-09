import { useEffect, useMemo, useState } from 'react'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  boundedMatrixDraftText,
  matrixDraftKey,
  type MatrixDraftTarget
} from '../../shared/matrix-drafts'

import { runMatrixCommand } from './text-document-actions'

export const MATRIX_DRAFT_WRITE_DEBOUNCE_MS = 500
const LOCAL_DRAFTS_MAX = 200
const localDrafts = new Map<string, string>()

function localKey(identity: MatrixIdentity, target: MatrixDraftTarget): string {
  return `${identity.userId}\0${identity.deviceId}\0${matrixDraftKey(target)}`
}

export function clearLocalMatrixRoomDrafts(roomId: string): void {
  for (const key of localDrafts.keys()) {
    if (key.split('\0')[2] === roomId) {localDrafts.delete(key)}
  }
}

/** Window-local bridge while the account-data write/sync round trip catches up. */
export function localMatrixDraft(identity: MatrixIdentity | null, target: MatrixDraftTarget | undefined): string | undefined {
  return identity && target ? localDrafts.get(localKey(identity, target)) : undefined
}

export function setLocalMatrixDraft(identity: MatrixIdentity | null, target: MatrixDraftTarget | undefined, text: string): void {
  if (!identity || !target) {
    return
  }

  const key = localKey(identity, target)
  localDrafts.delete(key)
  localDrafts.set(key, text)

  while (localDrafts.size > LOCAL_DRAFTS_MAX) {
    localDrafts.delete(localDrafts.keys().next().value!)
  }
}

/** Drop the bridge once ordinary sync has caught up, so later writes from another device can win. */
export function reconcileLocalMatrixDraft(
  identity: MatrixIdentity | null,
  target: MatrixDraftTarget | undefined,
  syncedText: string
): void {
  if (!identity || !target) {
    return
  }

  const key = localKey(identity, target)

  if (localDrafts.get(key) === syncedText) {
    localDrafts.delete(key)
  }
}

export function clearLocalMatrixDrafts(): void {
  localDrafts.clear()
}

export function clearLocalMatrixDraftsForIdentity(identity: MatrixIdentity): void {
  const prefix = `${identity.userId}\0${identity.deviceId}\0`

  for (const key of localDrafts.keys()) {
    if (key.startsWith(prefix)) {
      localDrafts.delete(key)
    }
  }
}

export interface MatrixDraftWriter {
  status: 'saved' | 'pending' | 'failed'
  schedule(text: string): void
  clear(): Promise<void>
  flush(): Promise<void>
  reconcile(syncedText: string): void
}

/** Debounces typing but serializes acknowledged account-data writes so Send's clear always wins. */
export function createMatrixDraftWriter(
  write: (text: string) => Promise<void | { status: 'saved' | 'pending' }>,
  initialText = '',
  delayMs = MATRIX_DRAFT_WRITE_DEBOUNCE_MS,
  statusChanged: (status: MatrixDraftWriter['status']) => void = () => {}
): Omit<MatrixDraftWriter, 'status'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | undefined
  let lastQueued: string | undefined = boundedMatrixDraftText(initialText)
  let desired = lastQueued
  let tail = Promise.resolve()

  const enqueue = (text: string) => {
    const bounded = boundedMatrixDraftText(text)

    if (bounded === lastQueued) {
      return tail
    }

    lastQueued = bounded
    desired = bounded
    statusChanged('pending')

    const operation = () => write(bounded).then(result => {
      if (desired === bounded) {
        statusChanged(result?.status === 'pending' ? 'pending' : 'saved')
      }
    }).catch(error => {
      if (desired === bounded) {statusChanged('failed')}

      if (lastQueued === bounded) {lastQueued = undefined}
      throw error
    })

    tail = tail.then(operation, operation)

    return tail
  }

  const cancelTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const flush = () => {
    cancelTimer()

    if (pending === undefined) {
      return tail
    }

    const text = pending
    pending = undefined

    return enqueue(text)
  }

  return {
    schedule(text) {
      pending = text
      cancelTimer()
      timer = setTimeout(() => {
        timer = undefined
        void flush().catch(() => {})
      }, delayMs)
    },

    clear() {
      pending = undefined
      cancelTimer()

      return enqueue('')
    },

    flush,

    reconcile(syncedText) {
      if (desired === boundedMatrixDraftText(syncedText)) {
        statusChanged('saved')
      }
    }
  }
}

/** The writer's identity is the Matrix account plus room/root. IME and selection never enter it. */
export function useMatrixDraftWriter(
  identity: MatrixIdentity | null,
  target: MatrixDraftTarget | undefined,
  initialText: string
): MatrixDraftWriter | null {
  const [status, setStatus] = useState<MatrixDraftWriter['status']>('saved')

  const scope = identity && target
    ? `${identity.userId}\0${identity.deviceId}\0${matrixDraftKey(target)}`
    : ''

  const writer = useMemo(() => {
    if (!identity || !target) {
      return null
    }

    const fencedIdentity = { userId: identity.userId, deviceId: identity.deviceId }
    const fencedTarget = { roomId: target.roomId, ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}) }

    return createMatrixDraftWriter(
      text => runMatrixCommand({ kind: 'draft', identity: fencedIdentity, ...fencedTarget, text }).then(result =>
        result && typeof result === 'object' && Reflect.get(result, 'status') === 'pending'
          ? { status: 'pending' as const }
          : { status: 'saved' as const }
      ),
      initialText,
      MATRIX_DRAFT_WRITE_DEBOUNCE_MS,
      setStatus
    )
  // The scope contains every authority-bearing field. The initial text belongs to this mount only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  useEffect(() => () => {
    void writer?.flush().catch(() => {})
  }, [writer])

  useEffect(() => {
    setStatus('saved')
  }, [scope])

  return useMemo(() => writer ? { ...writer, status } : null, [status, writer])
}
