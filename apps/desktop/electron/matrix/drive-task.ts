import { randomUUID } from 'node:crypto'

import type { MatrixDriveSelection, MatrixDriveTaskInput, MatrixDriveTaskResult } from '../../shared/matrix-drive'
import type { MatrixTaskFilesPromise } from '../../shared/matrix-task-files'

export interface NativeDriveMetadata {
  resource: { storage: string; space: string; opaque: string }
  etag?: string
  size?: number
}

export interface NativeCloudFileGrant {
  requestId: string
  agentPrincipal: string
  roomId: string
  eventId: string
  mode: 'read' | 'replace' | 'create'
  resource: NativeDriveMetadata['resource']
  size: number
  etag?: string
  leafName?: string
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

export function parseDriveTaskInput(value: unknown): MatrixDriveTaskInput {
  const fail = (): never => {
    throw new Error('matrix_drive_task_invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail()
  }
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join(',') !== 'body,revision,roomId,selections' ||
    typeof row.roomId !== 'string' ||
    !/^![!-~]{1,254}$/u.test(row.roomId) ||
    typeof row.body !== 'string' ||
    !row.body.trim() ||
    row.body.length > 16000 ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    !Array.isArray(row.selections) ||
    row.selections.length < 1 ||
    row.selections.length > 4
  ) {
    return fail()
  }
  const selections = row.selections.map((item): MatrixDriveSelection => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail()
    }
    const selection = item as Record<string, unknown>
    if (
      typeof selection.id !== 'string' ||
      !UUID.test(selection.id) ||
      !['read', 'replace', 'create'].includes(String(selection.mode)) ||
      Object.keys(selection).sort().join(',') !== (selection.mode === 'create' ? 'id,leafName,mode' : 'id,mode')
    ) {
      return fail()
    }
    if (selection.mode === 'create') {
      if (
        typeof selection.leafName !== 'string' ||
        selection.leafName.length < 1 ||
        selection.leafName.length > 128 ||
        ['.', '..'].includes(selection.leafName) ||
        [...selection.leafName].some(character => {
          const code = character.charCodeAt(0)

          return character === '/' || character === '\\' || code < 32 || code === 127
        })
      ) {
        return fail()
      }
      return { id: selection.id, mode: 'create', leafName: selection.leafName }
    }
    return { id: selection.id, mode: selection.mode as 'read' | 'replace' }
  })
  if (new Set(selections.map(selection => selection.id)).size !== selections.length) {
    return fail()
  }
  return { roomId: row.roomId, body: row.body, revision: Number(row.revision), selections }
}

/** One encrypted event, then grants for its exact ACK. Never invokes local Hermes. */
export async function sendDriveTask(options: {
  input: MatrixDriveTaskInput
  agentPrincipal: string
  current(): void
  ready(): Promise<boolean>
  metadata(id: string, mode: MatrixDriveSelection['mode'], revision: number): Promise<NativeDriveMetadata>
  send(promise: MatrixTaskFilesPromise): Promise<string>
  issue(grant: NativeCloudFileGrant): Promise<void>
}): Promise<MatrixDriveTaskResult> {
  const input = parseDriveTaskInput(options.input)
  const selected: Array<{ selection: MatrixDriveSelection; metadata: NativeDriveMetadata; requestId: string }> = []
  try {
    options.current()
    if (!UUID.test(options.agentPrincipal) || !(await options.ready())) {
      throw new Error('matrix_drive_task_unavailable')
    }
    options.current()
    for (const selection of input.selections) {
      const metadata = await options.metadata(selection.id, selection.mode, input.revision)
      options.current()
      if (selection.mode !== 'create' && (!metadata.etag || !Number.isSafeInteger(metadata.size))) {
        throw new Error('matrix_drive_task_unavailable')
      }
      selected.push({ selection, metadata, requestId: randomUUID() })
    }
    if (!(await options.ready())) {
      throw new Error('matrix_drive_task_unavailable')
    }
    options.current()
  } catch {
    return { state: 'not_sent' }
  }
  let eventId: string
  try {
    eventId = await options.send({ version: 1, requestIds: selected.map(file => file.requestId) })
    if (!/^\$[!-~]{1,254}$/u.test(eventId)) {
      return { state: 'send_unknown' }
    }
  } catch {
    return { state: 'send_unknown' }
  }
  // Independent grant IDs share the same immutable event; concurrent requests
  // fit the controller's bounded rendezvous. Every request rechecks native custody.
  const grants = await Promise.allSettled(
    selected.map(async ({ selection, metadata, requestId }) => {
      options.current()
      await options.issue({
        requestId,
        agentPrincipal: options.agentPrincipal,
        roomId: input.roomId,
        eventId,
        mode: selection.mode,
        resource: metadata.resource,
        size: selection.mode === 'create' ? 5242880 : metadata.size!,
        ...(selection.mode === 'create' ? { leafName: selection.leafName } : { etag: metadata.etag! })
      })
      options.current()
    })
  )
  return { state: grants.every(grant => grant.status === 'fulfilled') ? 'sent' : 'grant_failed_after_ack', eventId }
}
