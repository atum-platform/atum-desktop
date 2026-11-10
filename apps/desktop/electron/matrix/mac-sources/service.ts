import { type MacSourcesRequest, parseMacSourcesRequest } from '../../../../../packages/device-protocol/mac-sources'

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
  /** Independently granted prompt authority; background always overrides it. */
  mayPrompt?: boolean
}

function sourceFor(request: MacSourcesRequest): keyof MacSourceConsentSnapshot {
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
          !context.background && context.mayPrompt !== false
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
