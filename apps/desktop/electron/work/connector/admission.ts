import type { Caller } from './contract'

interface AdmissionPorts {
  origin(): string | undefined
  current(): boolean
  signal: AbortSignal
  secret: string
  fetch?: typeof fetch
}

export async function admitConnector(
  caller: Caller,
  ports: AdmissionPorts
): Promise<boolean> {
  const { admission, threadId, providerSessionId, providerInstanceId } = caller
  const origin = ports.origin()

  if (!admission || !origin || !ports.current()) {
    return false
  }

  const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(5_000)])
  const current = () => !signal.aborted && ports.current() && ports.origin() === origin

  try {
    // T3 revalidates the invocation in the native thread lock before answer release.
    const response = await (ports.fetch ?? fetch)(new URL('/atum-work/connector/prepare', origin), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${ports.secret}`,
        'x-atum-work-admission': admission,
        'x-atum-work-caller': Buffer.from(JSON.stringify([threadId, providerSessionId, providerInstanceId])).toString('base64url')
      }
    })

    return current() && response.status === 204
  } catch {
    return false
  }
}
