import {
  type AdvisorySearchInvocation,
  type AdvisorySearchResult,
  parseAdvisorySearchResult
} from '../../shared/atum-advisory-search'

import type { PrivateAdvisoryRunner } from './private-advisory-runner'
import type { MessagingClientBoundary } from './types'

interface PendingSearch {
  session_id: string
  turn_id: string
  durable_session_id: string
  identity_id: string
  source: 'desktop' | 'atum-private-advisory'
  query: string
  reference: string | null
  limit: number
}

type Client = Pick<MessagingClientBoundary, 'status' | 'listAssistants' | 'advisorySearch'>
type Runner = Pick<PrivateAdvisoryRunner, 'searchConversation'>

function result(status: AdvisorySearchResult['status']): AdvisorySearchResult {
  return { status, results: [], next_reference: null, previous_reference: null }
}

function pending(value: unknown, input: AdvisorySearchInvocation): PendingSearch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  if (
    row.session_id !== input.session_id ||
    row.turn_id !== input.turn_id ||
    typeof row.identity_id !== 'string' ||
    !row.identity_id ||
    typeof row.durable_session_id !== 'string' ||
    !row.durable_session_id ||
    (row.source !== 'desktop' && row.source !== 'atum-private-advisory') ||
    typeof row.query !== 'string' ||
    [...row.query].length > 500 ||
    (row.reference !== null &&
      (typeof row.reference !== 'string' || !/^atum-advisory:[A-Za-z0-9_-]{1,4096}$/.test(row.reference))) ||
    typeof row.limit !== 'number' ||
    !Number.isSafeInteger(row.limit) ||
    row.limit < 1 ||
    row.limit > 5
  ) {
    return null
  }

  return {
    session_id: row.session_id as string,
    turn_id: row.turn_id as string,
    durable_session_id: row.durable_session_id,
    identity_id: row.identity_id,
    source: row.source,
    query: row.query,
    reference: row.reference as string | null,
    limit: row.limit
  }
}

/** Main resolves authority through the actual pending backend request, not renderer arguments. */
export class AdvisoryHistorySource {
  constructor(
    private readonly client: Client,
    private readonly runner: Runner,
    private readonly readPending: (input: AdvisorySearchInvocation) => Promise<unknown>
  ) {}

  async search(input: AdvisorySearchInvocation): Promise<AdvisorySearchResult> {
    try {
      const accountId = (await this.client.status()).accountId

      if (!accountId) {
        return result('unavailable')
      }

      const scope = pending(await this.readPending(input), input)

      if (!scope) {
        return result('denied')
      }

      const assistants = (await this.client.listAssistants()).filter(
        assistant => assistant.identityId === scope.identity_id && assistant.status === 'active'
      )

      if (assistants.length !== 1) {
        return result('denied')
      }

      const assistantId = assistants[0].id
      const room = await this.runner.searchConversation(accountId, scope.session_id, assistantId, scope.source)

      if ((await this.client.status()).accountId !== accountId) {
        return result('denied')
      }

      const response = await this.client.advisorySearch({
        target_assistant_id: assistantId,
        conversation_id: room,
        query: scope.query,
        reference: scope.reference,
        limit: scope.limit
      })

      if ((await this.client.status()).accountId !== accountId) {
        return result('denied')
      }

      const current = pending(await this.readPending(input), input)

      if (!current || JSON.stringify(current) !== JSON.stringify(scope)) {
        return result('denied')
      }

      const currentRoom = await this.runner.searchConversation(accountId, scope.session_id, assistantId, scope.source)

      if (currentRoom !== room || (await this.client.status()).accountId !== accountId) {
        return result('denied')
      }

      return parseAdvisorySearchResult(response)
    } catch (error) {
      // Both backend HTTP helpers encode status at the start of the error.
      // A forbidden pending scope is denied, while outages remain unavailable.
      if (error instanceof Error && /^403:/.test(error.message)) {
        return result('denied')
      }

      return result('unavailable')
    }
  }
}
