import {
  admitMatrixCompanyIntent,
  isDefinitiveMatrixCompanyRefusal,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  matrixCompanyStatusError,
  settleMatrixCompanyIntent
} from '../../shared/matrix-company-ai'
import {
  isMatrixCompanyBrainMutation,
  matrixCompanyBrainCorrectionAuthority,
  type MatrixCompanyBrainRequest,
  matrixCompanyBrainRoute,
  matrixCompanyBrainTaskAuthority,
  type MatrixCompanyBrainValue,
  parseMatrixCompanyBrainRequest,
  parseMatrixCompanyBrainResponse
} from '../../shared/matrix-company-project-brain'

/**
 * Main-process project-summary client.
 *
 * Before I/O a correction must target an item of the exact authorized document
 * the caller displayed, and a task preview may name only a card that document
 * cited. After I/O the returned document is re-parsed and its citations are
 * re-checked against their own company/channel audience, so neither a stale
 * response nor a forged card id can become a wrong-project preview.
 */
export async function requestMatrixCompanyBrain(
  context: MatrixCompanyNativeContext,
  value: MatrixCompanyBrainRequest
): Promise<MatrixCompanyBrainValue> {
  const input = parseMatrixCompanyBrainRequest(value)

  if (input.action === 'brain-correct') {
    matrixCompanyBrainCorrectionAuthority(input.base, input)
  }

  if (input.action === 'brain-open-task') {
    matrixCompanyBrainTaskAuthority(input.base, input)
  }

  const intent = isMatrixCompanyBrainMutation(input) ? admitMatrixCompanyIntent(context, input) : null

  try {
    const result = await matrixCompanyNativeFetch(context, matrixCompanyBrainRoute(input))

    context.assertCurrent()
    context.signal.throwIfAborted()

    if (result.status !== 200) {
      if (result.status === 409) {
        throw new MatrixCompanyNativeError('conflict')
      }

      throw matrixCompanyStatusError(result.status)
    }

    const parsed = parseMatrixCompanyBrainResponse(result.body, input)

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
