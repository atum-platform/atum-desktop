import { createHash, randomUUID } from 'node:crypto'

import type { MatrixCompanyFileContext, MatrixCompanyFileRefV2, MatrixCompanyFileSdkCommand } from '../../shared/matrix-company-files'

import { downloadCompanyFileV2, uploadCompanyFileV2 } from './company-file-transport'
import { MatrixCompanyFileError } from './company-files'
import type {
  MatrixCompanyFileAuthorityV2,
  MatrixCompanyFileRequestV2,
  MatrixCompanyFileValueV2
} from './company-files-v2'

export interface MatrixCompanyFileControllerV2Ports {
  platform(input: MatrixCompanyFileRequestV2, signal: AbortSignal): Promise<MatrixCompanyFileValueV2>
  sdk(command: MatrixCompanyFileSdkCommand): Promise<unknown>
  current(): boolean
  serverUrl: string
  upload?: typeof uploadCompanyFileV2
  download?: typeof downloadCompanyFileV2
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

function live(ports: MatrixCompanyFileControllerV2Ports, signal: AbortSignal) {
  signal.throwIfAborted()

  if (!ports.current()) {throw new MatrixCompanyFileError('cancelled')}
}

function context(value: unknown, input: SendInput, authority: MatrixCompanyFileAuthorityV2): MatrixCompanyFileContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new MatrixCompanyFileError('unavailable')}
  const row = value as MatrixCompanyFileContext

  const targetMatches = row.target?.kind === 'channel' && authority.audience.kind === 'channel'
    ? row.target.channelId === authority.audience.channel_id
    : row.target?.kind === 'conversation' && authority.audience.kind === 'conversation' &&
      row.target.conversationId === authority.audience.conversation_id

  if (row.companyId !== authority.companyId || row.roomId !== input.roomId || !targetMatches ||
      row.threadRootId !== input.threadRootId || row.replyTo !== input.replyTo) {throw new MatrixCompanyFileError('conflict')}

  return row
}

async function waitUntilUploaded(
  file: MatrixCompanyFileRefV2,
  authority: MatrixCompanyFileAuthorityV2,
  ports: MatrixCompanyFileControllerV2Ports,
  signal: AbortSignal
) {
  let delay = 200

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const status = await ports.platform({ action: 'status-v2', ...authority, file }, signal)
    live(ports, signal)

    if (status.state === 'ready') {return}

    if (status.state === 'failed') {throw new MatrixCompanyFileError('unavailable')}
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
    delay = Math.min(delay * 2, 2_000)
  }

  throw new MatrixCompanyFileError('unavailable')
}

/** Audience-scoped upload. The SDK validates the room target; platform authority supplies current epochs/generation. */
export async function sendCompanyFileV2(
  input: SendInput,
  authority: MatrixCompanyFileAuthorityV2,
  ports: MatrixCompanyFileControllerV2Ports,
  signal: AbortSignal
): Promise<string> {
  live(ports, signal)
  context(await ports.sdk({ kind: 'companyFileContext', roomId: input.roomId,
    ...(input.threadRootId ? { threadRootId: input.threadRootId, replyTo: input.replyTo ?? input.threadRootId } : {}) }),
  { ...input, ...(input.threadRootId ? { replyTo: input.replyTo ?? input.threadRootId } : {}) }, authority)
  live(ports, signal)

  const reserveRequestId = (ports.requestId ?? randomUUID)()
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')

  const reserved = await ports.platform({ action: 'reserve-v2', ...authority, requestId: reserveRequestId,
    name: input.name, contentType: input.contentType, size: input.bytes.byteLength, sha256 }, signal)

  live(ports, signal)

  if (reserved.state !== 'reserved' || !('uploadSessionId' in reserved)) {throw new MatrixCompanyFileError('unavailable')}

  try {
    await (ports.upload ?? uploadCompanyFileV2)({ serverUrl: ports.serverUrl, file: reserved.file,
      uploadSessionId: reserved.uploadSessionId, bytes: input.bytes }, signal)
  } catch (error) {
    live(ports, signal)
    await waitUntilUploaded(reserved.file, authority, ports, signal)

    if (!(error instanceof Error)) {throw error}
  }

  live(ports, signal)

  const publishRequestId = (ports.requestId ?? randomUUID)()

  const published = await ports.platform({ action: 'publish-v2', ...authority,
    requestId: publishRequestId, file: reserved.file }, signal)

  live(ports, signal)

  if (published.state !== 'ready' || !('file' in published)) {throw new MatrixCompanyFileError('unavailable')}

  const eventId = await ports.sdk({
    kind: 'companyFileSend', roomId: input.roomId, requestId: reserveRequestId, file: published.file,
    matrixTransactionId: `atum-cf-${reserveRequestId}`,
    ...(input.threadRootId ? { threadRootId: input.threadRootId, replyTo: input.replyTo ?? input.threadRootId } : {})
  })

  live(ports, signal)

  if (typeof eventId !== 'string' || !/^\$[!-~]{1,511}$/u.test(eventId)) {throw new MatrixCompanyFileError('unavailable')}

  return eventId
}

/** No bytes are cached: authority and a new grant are required for every save/open. */
export async function readCompanyFileV2(
  file: MatrixCompanyFileRefV2,
  authority: MatrixCompanyFileAuthorityV2,
  ports: MatrixCompanyFileControllerV2Ports,
  signal: AbortSignal
): Promise<{ name: string; bytes: Uint8Array }> {
  live(ports, signal)

  const granted = await ports.platform({ action: 'download-v2', ...authority,
    requestId: (ports.requestId ?? randomUUID)(), file }, signal)

  live(ports, signal)

  if (granted.state !== 'download' || granted.fileId !== file.file_id) {throw new MatrixCompanyFileError('unavailable')}

  const bytes = await (ports.download ?? downloadCompanyFileV2)({ serverUrl: ports.serverUrl, file,
    downloadGrantId: granted.downloadGrantId, expiresAtMs: granted.expiresAtMs }, signal)

  live(ports, signal)

  return { name: file.name, bytes }
}
