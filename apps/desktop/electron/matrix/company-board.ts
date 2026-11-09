import {
  admitMatrixCompanyIntent,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  matrixCompanyStatusError,
  settleMatrixCompanyIntent
} from '../../shared/matrix-company-ai'
import { parseMatrixCompanyBoardResponse } from '../../shared/matrix-company-board'
import {
  isMatrixCompanyBoardNegotiatedMutation,
  type MatrixCompanyBoardNegotiatedRequest,
  matrixCompanyBoardNegotiatedRoute,
  type MatrixCompanyBoardNegotiatedValue,
  type MatrixCompanyBoardRequestV11,
  matrixCompanyBoardV1Fallback,
  parseMatrixCompanyBoardFallbackResponse,
  parseMatrixCompanyBoardNegotiatedRequest,
  parseMatrixCompanyBoardV11Response
} from '../../shared/matrix-company-board-negotiated'

const FALLBACK_STATUS = new Set([400, 406, 426])

/**
 * Main-process company board client.
 *
 * A list or card read is freely retryable. A command carries one request UUID;
 * the exact intent replays and a changed command under the same UUID conflicts
 * before I/O. Actor, origin, publication scope, provenance and completion
 * authority are never accepted from the renderer, and every returned card must
 * name the requested company (and board).
 */
export async function requestMatrixCompanyBoard(
  context: MatrixCompanyNativeContext,
  value: MatrixCompanyBoardNegotiatedRequest
): Promise<MatrixCompanyBoardNegotiatedValue> {
  const input = parseMatrixCompanyBoardNegotiatedRequest(value)

  const intent = isMatrixCompanyBoardNegotiatedMutation(input) ? admitMatrixCompanyIntent(context, input) : null

  try {
    let result = await matrixCompanyNativeFetch(context, matrixCompanyBoardNegotiatedRoute(input))

    context.assertCurrent()
    context.signal.throwIfAborted()

    if (input.action.endsWith('-v11')) {
      const requestV11 = input as MatrixCompanyBoardRequestV11
      const fallback = matrixCompanyBoardV1Fallback(requestV11)

      if (result.status !== 200 && fallback && FALLBACK_STATUS.has(result.status)) {
        result = await matrixCompanyNativeFetch(context, matrixCompanyBoardNegotiatedRoute(fallback))
        context.assertCurrent()
        context.signal.throwIfAborted()

        if (result.status !== 200) {
          throw matrixCompanyStatusError(result.status)
        }

        const parsed = parseMatrixCompanyBoardFallbackResponse(result.body, requestV11)

        if (!parsed) {
          throw new MatrixCompanyNativeError('invalid')
        }

        if (intent !== null) {
          settleMatrixCompanyIntent(context, intent)
        }

        return { negotiatedProfile: '1', value: parsed }
      }

      if (result.status !== 200) {
        throw matrixCompanyStatusError(result.status)
      }

      try {
        const parsed = parseMatrixCompanyBoardV11Response(result.body, requestV11)

        if (intent !== null) {
          settleMatrixCompanyIntent(context, intent)
        }

        return { negotiatedProfile: '1.1', value: parsed }
      } catch (error) {
        const parsed = parseMatrixCompanyBoardFallbackResponse(result.body, requestV11)

        if (!parsed) {
          throw error
        }

        if (intent !== null) {
          settleMatrixCompanyIntent(context, intent)
        }

        return { negotiatedProfile: '1', value: parsed }
      }
    }

    if (result.status !== 200) {
      throw matrixCompanyStatusError(result.status)
    }

    const parsed = parseMatrixCompanyBoardResponse(
      result.body,
      input as Exclude<MatrixCompanyBoardNegotiatedRequest, MatrixCompanyBoardRequestV11>
    )

    if (intent !== null) {
      settleMatrixCompanyIntent(context, intent)
    }

    return parsed
  } catch (error) {
    if (
      intent !== null &&
      error instanceof MatrixCompanyNativeError &&
      ['invalid', 'denied', 'missing', 'conflict', 'update_required'].includes(error.code)
    ) {
      settleMatrixCompanyIntent(context, intent)
    }

    throw error
  }
}
