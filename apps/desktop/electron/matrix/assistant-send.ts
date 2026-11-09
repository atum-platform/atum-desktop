import type { MatrixInvocationResult } from '../../shared/matrix'

/**
 * One message, one execution path. The native caller reserves the operation
 * before entering, then transfers ownership synchronously to the invocation.
 * Once Matrix accepted the message, invocation failure must NOT make the
 * composer restore/re-send the same prompt as another event.
 */
export async function sendAssistantMessage(input: {
  check: () => Promise<void>
  send: () => Promise<string>
  release: () => void
  invoke: (eventId: string) => Promise<MatrixInvocationResult>
}): Promise<{ eventId: string; result: MatrixInvocationResult }> {
  let released = false

  const release = () => {
    if (!released) {
      released = true
      input.release()
    }
  }

  try {
    await input.check()
    const eventId = await input.send()
    release()
    let result: MatrixInvocationResult

    try {
      result = await input.invoke(eventId)
    } catch {
      result = { state: 'unknown' }
    }

    return { eventId, result }
  } finally {
    release()
  }
}
