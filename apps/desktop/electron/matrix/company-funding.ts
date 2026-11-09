import {
  admitMatrixCompanyIntent,
  isDefinitiveMatrixCompanyRefusal,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  settleMatrixCompanyIntent
} from '../../shared/matrix-company-ai'
import {
  isMatrixCompanyFundingMutation,
  matrixCompanyFundingHeaders,
  MatrixCompanyFundingMemberError,
  type MatrixCompanyFundingRequest,
  matrixCompanyFundingRoute,
  type MatrixCompanyFundingValue,
  type MatrixCompanyMemberFundPending,
  parseMatrixCompanyFundingRequest,
  parseMatrixCompanyFundingResponse
} from '../../shared/matrix-company-funding'

/**
 * Main-process company wallet client.
 *
 * Wallet/packs/order reads never touch the intent journal. Creating an order and
 * funding the company from the caller's wallet (2.1) are mutations: the same request
 * UUID and input replay exactly; a changed input under a pending UUID conflicts
 * before any network call. A 403 is the ordinary
 * member path and is surfaced as a typed refusal with no balance value.
 */
export async function requestMatrixCompanyFunding(
  context: MatrixCompanyNativeContext,
  value: MatrixCompanyFundingRequest
): Promise<MatrixCompanyFundingValue> {
  const input = parseMatrixCompanyFundingRequest(value)

  if (input.action === 'funding-member-fund-pending') {
    return pendingMemberFund(context, input.companyId)
  }

  const intent = isMatrixCompanyFundingMutation(input) ? admitMatrixCompanyIntent(context, input) : null

  try {
    const result = await matrixCompanyNativeFetch(context, {
      ...matrixCompanyFundingRoute(input),
      headers: matrixCompanyFundingHeaders()
    })

    context.assertCurrent()
    context.signal.throwIfAborted()

    if (result.status === 403) {
      if (intent !== null) {
        settleMatrixCompanyIntent(context, intent)
      }

      throw new MatrixCompanyFundingMemberError()
    }

    if (result.status !== 200) {
      throw fundingError(result.status, result.body)
    }

    let parsed: MatrixCompanyFundingValue

    try {
      parsed = parseMatrixCompanyFundingResponse(result.body, input)
    } catch (error) {
      // A 200 the client cannot validate may still have committed the mutation. It is an
      // unknown outcome, never a refusal: keep the durable intent so only the same
      // request can be retried, and it replays instead of debiting again.
      if (intent !== null) {
        throw new MatrixCompanyNativeError('unavailable', undefined, 'unconfirmed')
      }

      throw error
    }

    if (intent !== null) {
      settleMatrixCompanyIntent(context, intent)
    }

    return parsed
  } catch (error) {
    if (intent !== null && error instanceof MatrixCompanyNativeError && isDefinitiveMatrixCompanyRefusal(error)) {
      settleMatrixCompanyIntent(context, intent)
    }

    throw error
  }
}

/**
 * The account's unresolved transfer for this company, if the journal holds one. The renderer
 * loses its copy when the wallet closes; this lets it offer "retry the same request" again
 * instead of minting a new request ID that native would refuse before I/O.
 */
function pendingMemberFund(context: MatrixCompanyNativeContext, companyId: string): MatrixCompanyMemberFundPending {
  const bytes = context.journal.read(context.scope)

  if (bytes === null) {
    return { pending: null }
  }

  try {
    const intent = parseMatrixCompanyFundingRequest(JSON.parse(bytes))

    if (intent.action === 'funding-member-fund' && intent.companyId === companyId) {
      return { pending: { requestId: intent.requestId, protons: intent.protons } }
    }
  } catch {
    // Not a transfer intent (an order) or unreadable: nothing to recover here.
  }

  return { pending: null }
}

function fundingError(status: number, body: unknown): MatrixCompanyNativeError {
  const envelope =
    body !== null && typeof body === 'object' ? (body as { schemaVersion?: unknown; error?: { code?: unknown } }) : null

  const code = envelope?.schemaVersion === 2 ? envelope.error?.code : undefined

  if (code === 'denied' && status === 403) {
    return new MatrixCompanyFundingMemberError()
  }

  if (code === 'budget_exhausted' && status === 402) {
    return new MatrixCompanyNativeError('budget_exhausted', undefined, 'budget_exhausted')
  }

  if (code === 'conflict' && status === 409) {
    return new MatrixCompanyNativeError('conflict', undefined, 'conflict')
  }

  if (code === 'insufficient_protons' && status === 409) {
    return new MatrixCompanyNativeError('insufficient_protons', undefined, 'insufficient_protons')
  }

  if (code === 'unavailable' && status === 503) {
    return new MatrixCompanyNativeError('unavailable', undefined, 'unavailable')
  }

  return new MatrixCompanyNativeError(
    status === 400
      ? 'invalid'
      : status === 401
        ? 'authentication'
        : status === 404
          ? 'missing'
          : status === 426
            ? 'update_required'
            : status === 429
              ? 'limit'
              : status === 402
                ? 'budget_exhausted'
                : 'unavailable'
  )
}
