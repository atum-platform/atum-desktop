import {
  type BrowserHistoryReaderOptions,
  MacBrowserHistoryError,
  readBrowserHistory,
  sweepStaleChromeHistoryCopies
} from './browser-history'
import {
  disabledResult,
  invalidResult,
  type MacSourceConsentSnapshot,
  type MacSourcesResult,
  permissionResult,
  unavailableResult
} from './contract'
import type { MacLocationProvider } from './location'
import {
  MacMessagesReadError,
  type MessagesReaderOptions,
  readMessageConversations,
  readMessages
} from './messages'
import type { FullDiskAccessStatus } from './permissions'

const REQUEST_BYTES = 4_096
const RESPONSE_BYTES = 96 * 1_024

export interface MacSourcesServiceDependencies {
  consent(): MacSourceConsentSnapshot
  fullDisk(): FullDiskAccessStatus
  messages: MessagesReaderOptions
  browser: BrowserHistoryReaderOptions
  location: MacLocationProvider
}

export interface MacSourcesExecutionContext {
  /** Background sweeps get metadata only and may never cause a native prompt. */
  background: boolean
}

type ParsedRequest =
  | { op: 'messages.conversations'; days: number; limit: number }
  | { op: 'messages.read'; id: string; days: number; limit: number }
  | {
      op: 'browser.history'
      browser: 'safari' | 'chrome' | 'all'
      days: number
      limit: number
      mode: 'recent' | 'top'
    }
  | { op: 'location.current'; precision: 'city' | 'precise' }

function strictObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function boundedInt(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high
}

export function parseMacSourcesRequest(value: unknown): ParsedRequest | null {
  if (!strictObject(value)) {
    return null
  }

  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > REQUEST_BYTES) {
      return null
    }
  } catch {
    return null
  }

  if (
    value.op === 'messages.conversations' &&
    exactKeys(value, ['op', 'days', 'limit']) &&
    boundedInt(value.days, 1, 365) &&
    boundedInt(value.limit, 1, 40)
  ) {
    return value as ParsedRequest
  }

  if (
    value.op === 'messages.read' &&
    exactKeys(value, ['op', 'id', 'days', 'limit']) &&
    typeof value.id === 'string' &&
    /^\d{1,18}$/u.test(value.id) &&
    boundedInt(value.days, 1, 90) &&
    boundedInt(value.limit, 1, 60)
  ) {
    return value as ParsedRequest
  }

  if (
    value.op === 'browser.history' &&
    exactKeys(value, ['op', 'browser', 'days', 'limit', 'mode']) &&
    typeof value.browser === 'string' &&
    ['safari', 'chrome', 'all'].includes(value.browser) &&
    boundedInt(value.days, 1, 90) &&
    boundedInt(value.limit, 1, 100) &&
    typeof value.mode === 'string' &&
    ['recent', 'top'].includes(value.mode)
  ) {
    return value as ParsedRequest
  }

  if (
    value.op === 'location.current' &&
    exactKeys(value, ['op', 'precision']) &&
    typeof value.precision === 'string' &&
    ['city', 'precise'].includes(value.precision)
  ) {
    return value as ParsedRequest
  }

  return null
}

function sourceFor(request: ParsedRequest): keyof MacSourceConsentSnapshot {
  return request.op.startsWith('messages.')
    ? 'messages'
    : request.op === 'browser.history'
      ? 'browser'
      : 'location'
}

function response(value: MacSourcesResult): string {
  const serialized = JSON.stringify(value)

  return Buffer.byteLength(serialized, 'utf8') <= RESPONSE_BYTES
    ? serialized
    : JSON.stringify(unavailableResult())
}

export class MacSourcesService {
  constructor(private readonly dependencies: MacSourcesServiceDependencies) {
    sweepStaleChromeHistoryCopies(dependencies.browser.tmpDir?.())
  }

  async request(
    payload: unknown,
    context: MacSourcesExecutionContext,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted()
    const request = parseMacSourcesRequest(payload)

    if (!request) {
      return response(invalidResult())
    }

    let consent: MacSourceConsentSnapshot

    try {
      consent = this.dependencies.consent()
    } catch {
      return response(disabledResult())
    }

    if (!consent[sourceFor(request)]) {
      return response(disabledResult())
    }

    // Background work may notice who/when is waiting, but message bodies remain foreground-only.
    if (context.background && request.op === 'messages.read') {
      return response(disabledResult())
    }

    try {
      if (request.op === 'messages.conversations') {
        if (this.dependencies.fullDisk() !== 'granted') {
          return response(permissionResult('full_disk'))
        }

        return response(readMessageConversations(request, this.dependencies.messages))
      }

      if (request.op === 'messages.read') {
        if (this.dependencies.fullDisk() !== 'granted') {
          return response(permissionResult('full_disk'))
        }

        return response(readMessages(request, this.dependencies.messages))
      }

      if (request.op === 'browser.history') {
        if (request.browser === 'safari' && this.dependencies.fullDisk() !== 'granted') {
          return response(permissionResult('full_disk'))
        }

        return response(readBrowserHistory(request, this.dependencies.browser))
      }

      return response(
        await this.dependencies.location.current(
          request.precision,
          signal,
          !context.background
        )
      )
    } catch (error) {
      signal.throwIfAborted()

      if (
        (error instanceof MacMessagesReadError || error instanceof MacBrowserHistoryError) &&
        error.code === 'permission_needed'
      ) {
        return response(permissionResult('full_disk'))
      }

      return response(unavailableResult())
    }
  }
}
