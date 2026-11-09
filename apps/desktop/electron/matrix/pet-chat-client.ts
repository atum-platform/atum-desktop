import {
  type AtumPetChatErrorCode,
  type AtumPetChatHistory,
  type AtumPetChatHistoryRequest,
  type AtumPetChatRef,
  type AtumPetChatReply,
  type AtumPetChatRequest,
  isAtumPetChatErrorCode,
  parseAtumPetChatError,
  parseAtumPetChatHistory,
  parseAtumPetChatHistoryRequest,
  parseAtumPetChatReply,
  parseAtumPetChatRequest
} from '../../shared/pet-chat/atum-pet-chat'

import type { NativeGrant } from './authorization'

const CHAT_TIMEOUT_MS = 60_000
const HISTORY_TIMEOUT_MS = 15_000
const MAXIMUM_RESPONSE_BYTES = 64 * 1024

/** A typed companion-chat refusal; nothing else crosses the IPC boundary. */
export class MatrixPetChatError extends Error {
  constructor(
    readonly code: AtumPetChatErrorCode,
    /** True only for a dropped connection or timeout, never a typed server answer. */
    readonly retryable = false
  ) {
    super(code)
  }
}

/** The Matrix domain base the main process already holds a grant for. The
 * resource may or may not carry a trailing slash. */
export function matrixDomainBase(resource: string): string {
  let url: URL

  try {
    url = new URL(resource)
  } catch {
    throw new MatrixPetChatError('temporarily_unavailable')
  }

  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

/** A refused domain grant is retried once after the account refreshes it; it is
 * not a companion-chat error code and never reaches the renderer. */
export class MatrixPetChatAuthenticationError extends Error {
  constructor() {
    super('matrix_pet_chat_authentication')
  }
}

export interface MatrixPetChatClientOptions {
  fetchImpl?: typeof fetch
}

async function request(
  resource: string,
  grant: NativeGrant,
  path: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<unknown> {
  signal.throwIfAborted()
  let response: Response
  let bytes: string

  try {
    response = await fetchImpl(`${matrixDomainBase(resource)}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${grant.accessToken}`,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    })
    bytes = (await response.text()).slice(0, MAXIMUM_RESPONSE_BYTES + 1)

    if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
      throw new MatrixPetChatError('temporarily_unavailable')
    }
  } catch (error) {
    signal.throwIfAborted()

    throw error instanceof MatrixPetChatError ? error : new MatrixPetChatError('temporarily_unavailable', true)
  }

  let parsed: unknown

  try {
    parsed = bytes ? JSON.parse(bytes) : null
  } catch {
    throw new MatrixPetChatError('temporarily_unavailable')
  }

  if (response.status === 401) {
    throw new MatrixPetChatAuthenticationError()
  }

  if (!response.ok) {
    try {
      throw new MatrixPetChatError(parseAtumPetChatError(parsed))
    } catch (error) {
      if (error instanceof MatrixPetChatError) {
        throw error
      }

      throw new MatrixPetChatError('temporarily_unavailable')
    }
  }

  return parsed
}

/** One network failure is retried with the same message id, so the platform's
 * idempotent record sees a replay instead of a second charged turn. */
async function requestChat(
  resource: string,
  grant: NativeGrant,
  input: AtumPetChatRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<AtumPetChatReply> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return parseAtumPetChatReply(
        await request(resource, grant, '/pets/chat', input, signal, CHAT_TIMEOUT_MS, fetchImpl)
      )
    } catch (error) {
      // A typed 503 is a server answer, not a dropped packet: keep it.
      if (!(error instanceof MatrixPetChatError) || !error.retryable || attempt > 0) {
        throw error
      }
    }
  }
}

export async function requestMatrixPetChat(
  resource: string,
  grant: NativeGrant,
  input: AtumPetChatRequest,
  signal: AbortSignal,
  options: MatrixPetChatClientOptions = {}
): Promise<AtumPetChatReply> {
  return requestChat(resource, grant, input, signal, options.fetchImpl ?? fetch)
}

export async function requestMatrixPetChatHistory(
  resource: string,
  grant: NativeGrant,
  ref: AtumPetChatRef,
  signal: AbortSignal,
  options: MatrixPetChatClientOptions = {}
): Promise<AtumPetChatHistory> {
  return parseAtumPetChatHistory(
    await request(
      resource,
      grant,
      '/pets/chat/history',
      { ref },
      signal,
      HISTORY_TIMEOUT_MS,
      options.fetchImpl ?? fetch
    )
  )
}

/** The IPC-boundary shape of a companion ref and message, validated in main. */
export function parsePetChatIpcInput(value: unknown): AtumPetChatRequest | undefined {
  try {
    return parseAtumPetChatRequest(value)
  } catch {
    return undefined
  }
}

export function parsePetChatHistoryIpcInput(value: unknown): AtumPetChatHistoryRequest | undefined {
  try {
    return parseAtumPetChatHistoryRequest(value)
  } catch {
    return undefined
  }
}

export function isPetChatErrorCode(value: unknown): value is AtumPetChatErrorCode {
  return isAtumPetChatErrorCode(value)
}
