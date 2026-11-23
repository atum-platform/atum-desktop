import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { Caller } from './contract'

export function protectedThreadsPath(accountRoot: string): string {
  return join(accountRoot, 'work', 'protected-threads')
}

export function protectedWorkRoute(accountRoot: string): 'open' | 'protected' | 'refused' {
  try {
    return statSync(protectedThreadsPath(accountRoot)).isDirectory() ? 'protected' : 'refused'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'open' : 'refused'
  }
}

interface ProtectionPorts {
  origin(): string | undefined
  current(): boolean
  servesProtectedRoute(signal: AbortSignal): Promise<boolean | null>
  route(): 'open' | 'protected' | 'refused'
  signal: AbortSignal
  secret: string
  fetch?: typeof fetch
}

export async function admitConnector(
  caller: Caller,
  protect: boolean,
  ports: ProtectionPorts
): Promise<{ protected: boolean } | undefined> {
  const { admission, threadId, providerSessionId, providerInstanceId } = caller
  const origin = ports.origin()

  if (!admission || !origin || !ports.current()) {
    return undefined
  }

  const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(5_000)])
  const current = () => !signal.aborted && ports.current() && ports.origin() === origin

  try {
    if ((protect && (await ports.servesProtectedRoute(signal)) !== true) || !current()) {
      return undefined
    }

    // T3 revalidates the invocation in the native thread lock and durably fences the thread.
    const response = await (ports.fetch ?? fetch)(new URL('/atum-work/connector/prepare', origin), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${ports.secret}`,
        'x-atum-work-admission': admission,
        'x-atum-work-action': protect ? 'protect' : 'bind',
        'x-atum-work-caller': Buffer.from(JSON.stringify([threadId, providerSessionId, providerInstanceId])).toString('base64url')
      }
    })

    if (!current()) {
      return undefined
    }

    if (response.status === 204 && ports.route() === 'protected') {
      return { protected: true }
    }

    return !protect && response.status === 202 ? { protected: false } : undefined
  } catch {
    return undefined
  }
}
