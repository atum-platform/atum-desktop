import { createHash, randomUUID } from 'node:crypto'

import {
  type MatrixCompanyFileContext,
  type MatrixCompanyFileRefV1 as MatrixCompanyFileRef,
  matrixCompanyFileRef,
  type MatrixCompanyFileSdkCommand
} from '../../shared/matrix-company-files'

import type { MatrixCompanyFilePending } from './account'
import { downloadCompanyFile, uploadCompanyFile } from './company-file-transport'
import { MatrixCompanyFileError, type MatrixCompanyFileRequest, type MatrixCompanyFileValue } from './company-files'

export interface MatrixCompanyFileControllerPorts {
  pending(): MatrixCompanyFilePending | null
  remember(value: MatrixCompanyFilePending): void
  clear(): void
  platform(input: MatrixCompanyFileRequest, signal: AbortSignal): Promise<MatrixCompanyFileValue>
  sdk(command: MatrixCompanyFileSdkCommand): Promise<unknown>
  current(): boolean
  upload?: typeof uploadCompanyFile
  download?: typeof downloadCompanyFile
  requestId?: () => string
}

interface SendInput {
  roomId: string
  name: string
  contentType: string
  bytes: Uint8Array
  threadRootId?: string
  replyTo?: string
}

export type MatrixCompanyFileRecovery = { state: 'idle' | 'needs_bytes' } | { state: 'complete'; eventId: string }

function cancelled(): never {
  throw new MatrixCompanyFileError('cancelled')
}

function live(ports: MatrixCompanyFileControllerPorts, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (!ports.current()) {
    cancelled()
  }
}

function context(value: unknown, input: SendInput): MatrixCompanyFileContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MatrixCompanyFileError('unavailable')
  }
  const row = value as Record<string, unknown>
  const threaded = input.threadRootId !== undefined
  const names = threaded
    ? ['companyId', 'target', 'roomId', 'threadRootId', 'replyTo']
    : ['companyId', 'target', 'roomId']
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
  const event = /^\$[!-~]{1,511}$/u
  if (
    Object.keys(row).sort().join(',') !== names.sort().join(',') ||
    typeof row.companyId !== 'string' ||
    !uuid.test(row.companyId) ||
    !row.target || typeof row.target !== 'object' || Array.isArray(row.target) ||
    Object.keys(row.target).sort().join(',') !== 'channelId,kind' ||
    Reflect.get(row.target, 'kind') !== 'channel' ||
    typeof Reflect.get(row.target, 'channelId') !== 'string' ||
    !uuid.test(Reflect.get(row.target, 'channelId') as string) ||
    row.roomId !== input.roomId ||
    (threaded &&
      (row.threadRootId !== input.threadRootId ||
        row.replyTo !== (input.replyTo ?? input.threadRootId) ||
        typeof row.threadRootId !== 'string' ||
        !event.test(row.threadRootId) ||
        typeof row.replyTo !== 'string' ||
        !event.test(row.replyTo)))
  ) {
    throw new MatrixCompanyFileError('unavailable')
  }
  return row as unknown as MatrixCompanyFileContext
}

function sameIntent(left: MatrixCompanyFilePending, right: MatrixCompanyFilePending): boolean {
  return [
    'requestId',
    'companyId',
    'channelId',
    'roomId',
    'name',
    'contentType',
    'size',
    'sha256',
    'transactionId',
    'threadRootId',
    'replyTo'
  ].every(key => Reflect.get(left, key) === Reflect.get(right, key))
}

function withFile(pending: MatrixCompanyFilePending, fileId: string): MatrixCompanyFilePending {
  return { ...pending, fileId, revision: 1 }
}

function sameFile(left: MatrixCompanyFileRef, right: MatrixCompanyFileRef): boolean {
  return (
    left.v === right.v &&
    left.company_id === right.company_id &&
    left.channel_id === right.channel_id &&
    left.file_id === right.file_id &&
    left.revision === right.revision &&
    left.name === right.name &&
    left.content_type === right.content_type &&
    left.size === right.size &&
    left.sha256 === right.sha256
  )
}

function matchesFile(pending: MatrixCompanyFilePending, file: MatrixCompanyFileRef): boolean {
  return (
    file.company_id === pending.companyId &&
    file.channel_id === pending.channelId &&
    file.name === pending.name &&
    file.content_type === pending.contentType &&
    file.size === pending.size &&
    file.sha256 === pending.sha256 &&
    (!pending.fileId || pending.fileId === file.file_id)
  )
}

function publishedEvent(
  pending: MatrixCompanyFilePending,
  value: Extract<MatrixCompanyFileValue, { state: 'published' }>
): string {
  if (
    !matchesFile(pending, value.file) ||
    value.roomId !== pending.roomId ||
    value.matrixTransactionId !== pending.transactionId ||
    (pending.eventId && value.eventId !== pending.eventId)
  ) {
    throw new MatrixCompanyFileError('conflict')
  }
  return value.eventId
}

async function publishReady(
  source: MatrixCompanyFilePending,
  file: MatrixCompanyFileRef,
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<string> {
  let pending = withFile(source, file.file_id)
  if (!pending.eventId) {
    if (pending.phase !== 'ready') {
      pending = { ...pending, phase: 'ready' }
      ports.remember(pending)
    }
    const eventId = await ports.sdk({
      kind: 'companyFileSend',
      roomId: pending.roomId,
      requestId: pending.requestId,
      file: fileFrom(pending),
      matrixTransactionId: pending.transactionId,
      ...(pending.threadRootId ? { threadRootId: pending.threadRootId, replyTo: pending.replyTo! } : {})
    })
    live(ports, signal)
    if (typeof eventId !== 'string' || !/^\$[!-~]{1,511}$/u.test(eventId)) {
      throw new MatrixCompanyFileError('unavailable')
    }
    pending = { ...pending, phase: 'published', eventId }
    ports.remember(pending)
  }

  const request = {
    action: 'publish',
    companyId: pending.companyId,
    channelId: pending.channelId,
    requestId: pending.requestId,
    fileId: pending.fileId!,
    revision: 1,
    roomId: pending.roomId,
    eventId: pending.eventId!,
    matrixTransactionId: pending.transactionId
  } as const
  let published: MatrixCompanyFileValue | null

  try {
    published = await ports.platform(request, signal)
  } catch (error) {
    if (!retryableStatusError(error)) {
      throw error
    }

    published = await statusOrMissing(pending, ports, signal)
  }

  live(ports, signal)
  if (published && pendingState(published) && published.state !== 'cancelled') {
    published = await waitForCompanyFile(pending, published, ports, signal)
  }
  live(ports, signal)

  // A lost publish reply can leave the file ready but unpublished. Replaying the
  // same request/event/transaction is idempotent and is safer than surfacing an
  // uncertain result that asks the person to try the whole attachment again.
  while (published?.state === 'ready') {
    await waitForStatusPoll(250, signal)
    published = await ports.platform(request, signal)
    live(ports, signal)
  }

  if (
    !published ||
    published.state !== 'published' ||
    !('eventId' in published) ||
    published.eventId !== pending.eventId
  ) {
    throw new MatrixCompanyFileError('unavailable')
  }
  ports.clear()
  return pending.eventId!
}

function fileFrom(pending: MatrixCompanyFilePending) {
  if (!pending.fileId || pending.revision !== 1) {
    throw new MatrixCompanyFileError('unavailable')
  }
  return {
    v: 1 as const,
    company_id: pending.companyId,
    channel_id: pending.channelId,
    file_id: pending.fileId,
    revision: 1 as const,
    name: pending.name,
    content_type: pending.contentType,
    size: pending.size,
    sha256: pending.sha256
  }
}

function pendingState(value: MatrixCompanyFileValue): value is Extract<
  MatrixCompanyFileValue,
  {
    state: 'reserved' | 'writing' | 'unknown' | 'cancelled'
  }
> {
  return ['reserved', 'writing', 'unknown', 'cancelled'].includes(value.state) && !('uploadGrant' in value)
}

async function statusOrMissing(
  pending: MatrixCompanyFilePending,
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<MatrixCompanyFileValue | null> {
  try {
    return await ports.platform(
      {
        action: 'status',
        companyId: pending.companyId,
        channelId: pending.channelId,
        requestId: pending.requestId
      },
      signal
    )
  } catch (error) {
    if (error instanceof MatrixCompanyFileError && error.code === 'missing') {
      return null
    }
    throw error
  }
}

const COMPANY_FILE_STATUS_POLL_MAX_MS = 5_000

function retryableStatusError(error: unknown): error is MatrixCompanyFileError {
  return error instanceof MatrixCompanyFileError && (error.code === 'unavailable' || error.code === 'limit')
}

function waitForStatusPoll(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)

    function done() {
      signal.removeEventListener('abort', aborted)
      resolve()
    }

    function aborted() {
      clearTimeout(timer)
      reject(signal.reason)
    }

    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** A write/status operation already has a ten-minute owner signal. Pending provider states are
 * progress, not a failure: keep reading the same request ID under that signal instead of making
 * the person retry an idempotent company-file operation by hand. */
async function waitForCompanyFile(
  pending: MatrixCompanyFilePending,
  initial: MatrixCompanyFileValue,
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<MatrixCompanyFileValue | null> {
  let value: MatrixCompanyFileValue | null = initial
  let delay = 250

  while (value && pendingState(value) && value.state !== 'cancelled') {
    const retryAfter = value.state === 'unknown' ? delay : Math.min(delay, 1_000)
    await waitForStatusPoll(retryAfter, signal)
    live(ports, signal)

    try {
      value = await statusOrMissing(pending, ports, signal)
    } catch (error) {
      if (!retryableStatusError(error)) {
        throw error
      }

      value = initial
      if (error.retryAfterSeconds) {
        delay = Math.min(error.retryAfterSeconds * 1_000, COMPANY_FILE_STATUS_POLL_MAX_MS)
      }
    }

    live(ports, signal)
    delay = Math.min(delay * 2, COMPANY_FILE_STATUS_POLL_MAX_MS)
  }

  return value
}

/** Finish a ready or Matrix-acknowledged journal without needing the original local bytes. */
export async function recoverCompanyFile(
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<MatrixCompanyFileRecovery> {
  const pending = ports.pending()
  if (!pending) {
    return { state: 'idle' }
  }
  live(ports, signal)
  const roomContext = context(
    await ports.sdk({
      kind: 'companyFileContext',
      roomId: pending.roomId,
      ...(pending.threadRootId ? { threadRootId: pending.threadRootId, replyTo: pending.replyTo! } : {})
    }),
    {
      roomId: pending.roomId,
      name: pending.name,
      contentType: pending.contentType,
      bytes: new Uint8Array(),
      ...(pending.threadRootId ? { threadRootId: pending.threadRootId, replyTo: pending.replyTo! } : {})
    }
  )
  if (roomContext.companyId !== pending.companyId || roomContext.target.kind !== 'channel' ||
      roomContext.target.channelId !== pending.channelId) {
    throw new MatrixCompanyFileError('conflict')
  }
  const platform = await statusOrMissing(pending, ports, signal)
  live(ports, signal)
  if (!platform) {
    return { state: 'needs_bytes' }
  }
  if (platform.state === 'cancelled') {
    ports.clear()
    return { state: 'idle' }
  }
  if (platform.state === 'published' && 'eventId' in platform) {
    const eventId = publishedEvent(pending, platform)
    ports.clear()
    return { state: 'complete', eventId }
  }
  if (platform.state !== 'ready' || !matchesFile(pending, platform.file)) {
    return { state: 'needs_bytes' }
  }
  return { state: 'complete', eventId: await publishReady(pending, platform.file, ports, signal) }
}

/** One idempotent native upload → Matrix reference → publication path. */
export async function sendCompanyFile(
  input: SendInput,
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<string> {
  live(ports, signal)
  const roomContext = context(
    await ports.sdk({
      kind: 'companyFileContext',
      roomId: input.roomId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId, replyTo: input.replyTo ?? input.threadRootId } : {})
    }),
    input
  )
  live(ports, signal)

  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  let existing = ports.pending()
  let requestId = existing?.requestId ?? (ports.requestId ?? randomUUID)()
  let initial: MatrixCompanyFilePending = {
    schemaVersion: 1,
    phase: 'reserved',
    requestId,
    companyId: roomContext.companyId,
    channelId: roomContext.target.kind === 'channel' ? roomContext.target.channelId : unavailableChannel(),
    roomId: roomContext.roomId,
    name: input.name,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    sha256,
    transactionId: `atum-cf-${requestId}`,
    ...(roomContext.threadRootId ? { threadRootId: roomContext.threadRootId, replyTo: roomContext.replyTo! } : {})
  }
  if (existing && !sameIntent(existing, initial)) {
    const recovered = await recoverCompanyFile(ports, signal)
    if (recovered.state !== 'complete') {
      throw new MatrixCompanyFileError('conflict')
    }
    existing = null
    requestId = (ports.requestId ?? randomUUID)()
    initial = { ...initial, requestId, transactionId: `atum-cf-${requestId}` }
  }
  let pending = existing ?? initial
  if (!existing) {
    ports.remember(pending)
  }

  let platform = existing ? await statusOrMissing(pending, ports, signal) : null
  let readyFile = platform?.state === 'ready' ? platform.file : undefined
  live(ports, signal)
  if (platform?.state === 'published' && 'eventId' in platform) {
    const eventId = publishedEvent(pending, platform)
    ports.clear()
    return eventId
  }
  if (readyFile && !matchesFile(pending, readyFile)) {
    throw new MatrixCompanyFileError('conflict')
  }
  if (platform?.state === 'cancelled') {
    ports.clear()
    throw new MatrixCompanyFileError('conflict')
  }

  if ((!platform || pendingState(platform)) && !pending.eventId) {
    platform = await ports.platform(
      {
        action: 'reserve',
        companyId: pending.companyId,
        channelId: pending.channelId,
        requestId: pending.requestId,
        name: pending.name,
        contentType: pending.contentType,
        size: pending.size,
        sha256: pending.sha256
      },
      signal
    )
    live(ports, signal)
    if (pendingState(platform) && platform.state !== 'cancelled') {
      platform = await waitForCompanyFile(pending, platform, ports, signal)
      live(ports, signal)
      if (!platform) {
        throw new MatrixCompanyFileError('unavailable')
      }
    }
    if (platform.state === 'ready') {
      readyFile = platform.file
      if (!matchesFile(pending, readyFile)) {
        throw new MatrixCompanyFileError('conflict')
      }
    }
    if (platform.state === 'cancelled') {
      ports.clear()
      throw new MatrixCompanyFileError('conflict')
    }
  }

  if (platform?.state === 'published' && 'eventId' in platform) {
    const eventId = publishedEvent(pending, platform)
    ports.clear()
    return eventId
  }

  if (platform && 'uploadGrant' in platform) {
    pending = withFile(pending, platform.file.file_id)
    ports.remember({ ...pending, phase: 'writing' })
    try {
      await (ports.upload ?? uploadCompanyFile)(
        {
          serverUrl: platform.serverUrl,
          file: platform.file,
          nativeGrant: platform.uploadGrant.nativeGrant,
          expiresAtMs: platform.uploadGrant.expiresAtMs,
          bytes: input.bytes
        },
        signal
      )
      live(ports, signal)
      pending = { ...pending, phase: 'ready' }
      ports.remember(pending)
      readyFile = platform.file
    } catch (error) {
      ports.remember({ ...pending, phase: 'unknown' })
      // The transfer may have landed, so retain the unknown-effect journal, but
      // never reconcile it through an account/host that changed underneath us.
      if (signal.aborted || !ports.current()) {
        cancelled()
      }
      let recovered = await statusOrMissing(pending, ports, signal)
      live(ports, signal)
      if (recovered && pendingState(recovered) && recovered.state !== 'cancelled') {
        recovered = await waitForCompanyFile(pending, recovered, ports, signal)
        live(ports, signal)
      }
      if (!recovered || !['ready', 'published'].includes(recovered.state)) {
        throw error
      }
      platform = recovered
      readyFile = recovered.state === 'ready' ? recovered.file : undefined
      if (readyFile && !matchesFile(pending, readyFile)) {
        throw new MatrixCompanyFileError('conflict')
      }
    }
  }

  if (platform?.state === 'published' && 'eventId' in platform) {
    const eventId = publishedEvent(pending, platform)
    ports.clear()
    return eventId
  }
  if (!readyFile) {
    ports.remember({ ...pending, phase: 'unknown' })
    throw new MatrixCompanyFileError('unavailable')
  }

  return publishReady(pending, readyFile, ports, signal)
}

/** Fresh-authority native read; the caller owns the save dialog and account fence. */
export async function readCompanyFile(
  file: MatrixCompanyFileRef,
  ports: MatrixCompanyFileControllerPorts,
  signal: AbortSignal
): Promise<{ name: string; bytes: Uint8Array }> {
  const reference = matrixCompanyFileRef(file)
  if (!reference || reference.v !== 1) {
    throw new MatrixCompanyFileError('invalid')
  }
  live(ports, signal)
  const grant = await ports.platform(
    {
      action: 'download',
      companyId: reference.company_id,
      channelId: reference.channel_id,
      fileId: reference.file_id,
      revision: 1
    },
    signal
  )
  live(ports, signal)
  if (!('downloadGrant' in grant)) {
    throw new MatrixCompanyFileError('unavailable')
  }
  if (!sameFile(reference, grant.file)) {
    throw new MatrixCompanyFileError('conflict')
  }
  const result = await (ports.download ?? downloadCompanyFile)(
    {
      serverUrl: grant.serverUrl,
      file: grant.file,
      nativeGrant: grant.downloadGrant.nativeGrant,
      expiresAtMs: grant.downloadGrant.expiresAtMs
    },
    signal
  )
  live(ports, signal)
  return { name: grant.file.name, bytes: result }
}

function unavailableChannel(): never {
  throw new MatrixCompanyFileError('unavailable')
}
