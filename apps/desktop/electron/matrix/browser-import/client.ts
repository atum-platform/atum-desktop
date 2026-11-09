/**
 * The platform's side of a browser import, behind one interface so the rest of the import never learns a URL.
 *
 * Three owner-authenticated calls (the same native bearer as every other owner route, refreshed once on a 401 by
 * `account.s1Request`):
 * - `primaryComputer`: where the primary agent's computer is now (its id and attachment epoch);
 * - `readRecipientKey`: `browser.import.recipient-key.read`, answered with the controller-signed key record;
 * - `admit`: the transfer admission. The body is the sealed envelope and its consent record; the platform sees
 *   ciphertext, digests and counts, never a cookie, a value or a site name.
 *
 * The routes are the platform's (atum-platform PR #663, `apps/shell/src/lib/browser-import-authority.ts`), all under
 * `/agents/{agent principal}/` of the Matrix domain API, and its handler is strict about what it is sent:
 * - the agent in the path is the agent's principal, a lowercase UUID, and there is no query string;
 * - the two POSTs carry exactly `application/json`; the GET carries no body;
 * - `GET computer` answers `{computerId, attachmentEpoch}`, or 404 when the agent has no computer;
 * - `POST browser-import/recipient-key` answers the controller-signed record;
 * - `POST browser-import/transfers` takes exactly `{envelope, admission}` and answers 202 `{importId}`;
 * - a refusal is `{error: "matrix_<status>", details: {reason}}` with a closed `reason` word.
 * Removing or erasing what was imported (`.../removals`, `.../erases`) is a later Desktop call, not made here.
 * Tests use an in-memory transport (service.test.ts) or a fake `fetch` (client.test.ts) and never reach a network.
 */
import { endpoint } from '../device/cloud-agent'
import { readDomainJson } from '../domain'

import type { BrowserImportAdmission, BrowserImportEnvelope, BrowserImportRecipientKeyReadRequest } from './contract'

export interface BrowserImportComputer {
  computerId: string
  attachmentEpoch: number
}

export interface BrowserImportTransport {
  /** The computer the agent runs on now, or null when it has none (a local-only agent, not yet placed). */
  primaryComputer(agentPrincipal: string, signal: AbortSignal): Promise<BrowserImportComputer | null>
  /** The platform's answer to a recipient-key read, untrusted until `readTrustedRecipientKey` has checked it. */
  readRecipientKey(
    agentPrincipal: string,
    request: BrowserImportRecipientKeyReadRequest,
    signal: AbortSignal
  ): Promise<unknown>
  /** Hand the sealed import to the platform; resolves when it holds the ciphertext for the computer. */
  admit(
    agentPrincipal: string,
    transfer: { envelope: BrowserImportEnvelope; admission: BrowserImportAdmission },
    signal: AbortSignal
  ): Promise<{ importId: string }>
}

/** A refusal or a lost answer. `status` 0 is no answer at all; `reason` is the platform's closed word, if it sent one. */
export class BrowserImportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string
  ) {
    super(`browser_import_http_${status}${reason ? `_${reason}` : ''}`)
    this.name = 'BrowserImportHttpError'
  }
}

type Send = (accessToken: string, base: string) => Promise<unknown>

export interface HttpBrowserImportTransportOptions {
  /** `account.s1Request`: the owner's bearer and the domain base URL, one refresh after a 401. */
  call(send: Send, signal: AbortSignal): Promise<unknown>
  fetchImpl?: typeof fetch
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SMALL_ANSWER_BYTES = 16_384
const SHORT_TIMEOUT_MS = 20_000
/** A heavy profile is megabytes of ciphertext; the upload gets time to finish on a slow line. */
const UPLOAD_TIMEOUT_MS = 120_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function httpBrowserImportTransport(options: HttpBrowserImportTransportOptions): BrowserImportTransport {
  const fetchImpl = options.fetchImpl ?? fetch

  const agentRoute = (agentPrincipal: string, rest: string) => {
    // The platform accepts only the lowercase form of the principal.
    const agent = agentPrincipal.toLowerCase()

    if (!UUID.test(agent)) {
      throw new BrowserImportHttpError(400, 'invalid')
    }

    return `/agents/${agent}/${rest}`
  }

  async function ask(
    method: 'GET' | 'POST',
    route: string,
    body: unknown,
    signal: AbortSignal,
    limits: { timeoutMs: number }
  ): Promise<{ status: number; value: unknown }> {
    const send: Send = async (accessToken, base) => {
      let response: Response

      try {
        response = await fetchImpl(endpoint(base, route), {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
        })
      } catch {
        signal.throwIfAborted()
        throw new BrowserImportHttpError(0)
      }

      // The account refreshes its grant once on this exact message (account.ts `s1Request`).
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {})
        throw new Error('matrix_s1_authentication')
      }

      let value: unknown = null
      let reason: string | undefined

      if (response.headers.get('content-type')?.startsWith('application/json')) {
        try {
          value = await readDomainJson(response, SMALL_ANSWER_BYTES)
        } catch {
          throw new BrowserImportHttpError(0, 'invalid')
        }

        const details = isRecord(value) && isRecord(value.details) ? value.details.reason : undefined
        reason = typeof details === 'string' && /^[a-z0-9_]{1,64}$/u.test(details) ? details : undefined
      } else {
        await response.body?.cancel().catch(() => {})
      }

      if (!response.ok) {
        throw new BrowserImportHttpError(response.status, reason)
      }

      return { status: response.status, value }
    }

    return (await options.call(send, signal)) as { status: number; value: unknown }
  }

  return {
    async primaryComputer(agentPrincipal, signal) {
      try {
        const { value } = await ask('GET', agentRoute(agentPrincipal, 'computer'), undefined, signal, {
          timeoutMs: SHORT_TIMEOUT_MS
        })

        if (
          !isRecord(value) ||
          typeof value.computerId !== 'string' ||
          !UUID.test(value.computerId) ||
          !Number.isSafeInteger(value.attachmentEpoch) ||
          (value.attachmentEpoch as number) < 1
        ) {
          throw new BrowserImportHttpError(0, 'invalid')
        }

        return { computerId: value.computerId, attachmentEpoch: value.attachmentEpoch as number }
      } catch (error) {
        // No computer for this agent is an answer, not a failure.
        if (error instanceof BrowserImportHttpError && error.status === 404) {
          return null
        }

        throw error
      }
    },

    async readRecipientKey(agentPrincipal, request, signal) {
      return (
        await ask('POST', agentRoute(agentPrincipal, 'browser-import/recipient-key'), request, signal, {
          timeoutMs: SHORT_TIMEOUT_MS
        })
      ).value
    },

    async admit(agentPrincipal, transfer, signal) {
      const { value } = await ask('POST', agentRoute(agentPrincipal, 'browser-import/transfers'), transfer, signal, {
        timeoutMs: UPLOAD_TIMEOUT_MS
      })

      if (!isRecord(value) || value.importId !== transfer.envelope.authenticatedData.importId) {
        throw new BrowserImportHttpError(0, 'invalid')
      }

      return { importId: value.importId }
    }
  }
}
