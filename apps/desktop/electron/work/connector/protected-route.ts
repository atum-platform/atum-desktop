import { statSync } from 'node:fs'
import { join } from 'node:path'

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

export async function admitProtectedAnswer(admission: string | undefined, ports: ProtectionPorts): Promise<boolean> {
  const origin = ports.origin()

  if (!admission || !origin || !ports.current()) {
    return false
  }

  const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(5_000)])
  const current = () => !signal.aborted && ports.current() && ports.origin() === origin

  try {
    if ((await ports.servesProtectedRoute(signal)) !== true || !current()) {
      return false
    }

    // T3 revalidates the invocation in the native thread lock and durably fences the thread.
    const response = await (ports.fetch ?? fetch)(new URL('/atum-work/connector/prepare', origin), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${ports.secret}`,
        'x-atum-work-admission': admission
      }
    })

    return response.status === 204 && current() && ports.route() === 'protected'
  } catch {
    return false
  }
}
