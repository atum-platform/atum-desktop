import {
  admitMatrixCompanyIntent,
  isDefinitiveMatrixCompanyRefusal,
  type MatrixCompanyAIRequest,
  MatrixCompanyAIRequestSchema,
  matrixCompanyAIRoute,
  type MatrixCompanyAIValue,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError,
  matrixCompanyNativeFetch,
  matrixCompanyRefusalError,
  parseMatrixCompanyAIRequest,
  parseMatrixCompanyAIResponse,
  settleMatrixCompanyIntent
} from '../../shared/matrix-company-ai'

/**
 * Main-process Company AI client.
 *
 * The account supplies the resource, the current grant, an account/domain
 * generation guard and the encrypted intent journal. A configure or Stop keeps
 * its exact request UUID until a definitive answer, so a lost response replays
 * the same intent instead of starting another paid task.
 */
export async function requestMatrixCompanyAI(
  context: MatrixCompanyNativeContext,
  value: MatrixCompanyAIRequest
): Promise<MatrixCompanyAIValue> {
  const input = parseMatrixCompanyAIRequest(value)
  const mutation = input.action === 'company-ai-configure' || input.action === 'company-ai-stop'
  const intent = mutation ? admitMatrixCompanyIntent(context, input) : null

  try {
    const result = await matrixCompanyNativeFetch(context, matrixCompanyAIRoute(input))

    context.assertCurrent()
    context.signal.throwIfAborted()

    if (result.status !== 200) {
      throw matrixCompanyRefusalError(result.status, result.body)
    }

    const parsed = parseMatrixCompanyAIResponse(result.body, input)

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

export {
  type MatrixCompanyAIRequest,
  MatrixCompanyAIRequestSchema,
  type MatrixCompanyAIValue,
  type MatrixCompanyNativeContext,
  MatrixCompanyNativeError
}
