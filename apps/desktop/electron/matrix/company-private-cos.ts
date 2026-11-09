import {
  admitMatrixCompanyIntent,
  isDefinitiveMatrixCompanyRefusal,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  matrixCompanyRefusalError,
  settleMatrixCompanyIntent
} from '../../shared/matrix-company-ai'
import {
  type MatrixCompanyPrivateCosRequest,
  matrixCompanyPrivateCosRoute,
  type MatrixCompanyPrivateCosValue,
  parseMatrixCompanyPrivateCosRequest,
  parseMatrixCompanyPrivateCosResponse
} from '../../shared/matrix-company-private-cos'

const mutation = (input: MatrixCompanyPrivateCosRequest) =>
  input.action === 'private-cos-ensure' || input.action === 'private-cos-stop'

/**
 * Authenticated native consumer for the frozen private-CoS routes. The renderer can name only the
 * company, an idempotency UUID and (for owner controls) a run UUID; pair/member/payer/room selectors
 * never cross this seam.
 */
export async function requestMatrixCompanyPrivateCos(
  context: MatrixCompanyNativeContext,
  value: MatrixCompanyPrivateCosRequest
): Promise<MatrixCompanyPrivateCosValue> {
  let input: MatrixCompanyPrivateCosRequest

  try {
    input = parseMatrixCompanyPrivateCosRequest(value)
  } catch {
    throw new MatrixCompanyNativeError('invalid')
  }

  const intent = mutation(input) ? admitMatrixCompanyIntent(context, input) : null

  try {
    const result = await matrixCompanyNativeFetch(context, matrixCompanyPrivateCosRoute(input))

    context.assertCurrent()
    context.signal.throwIfAborted()

    const accepted = result.status === 200 || input.action === 'private-cos-ensure' && result.status === 202

    if (!accepted) {
      throw matrixCompanyRefusalError(result.status, result.body)
    }

    let parsed: MatrixCompanyPrivateCosValue

    try {
      parsed = parseMatrixCompanyPrivateCosResponse(result.body, input)
    } catch {
      throw new MatrixCompanyNativeError('invalid')
    }

    if (intent !== null) {settleMatrixCompanyIntent(context, intent)}

    return parsed
  } catch (error) {
    if (intent !== null && error instanceof MatrixCompanyNativeError && isDefinitiveMatrixCompanyRefusal(error)) {
      settleMatrixCompanyIntent(context, intent)
    }

    throw error
  }
}
