export interface OwnerFetch {
  fetch(input: string, init: RequestInit): Promise<Response>
}

export async function workOwnerSocketUrl(origin: string, owner: OwnerFetch, signal?: AbortSignal): Promise<URL | undefined> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(origin)) {return undefined}

  const ticket = await owner.fetch(`${origin}/api/auth/websocket-ticket/rpc`, {
    method: 'POST', credentials: 'include', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000)
  })

  const body = ticket.ok ? await ticket.json() as { ticket?: unknown } : undefined

  if (typeof body?.ticket !== 'string' || !body.ticket) {return undefined}

  const url = new URL('/ws', origin)
  url.protocol = 'ws:'
  url.searchParams.set('orchestrationProtocol', '2')
  url.searchParams.set('wsTicket', body.ticket)

  return url
}

/** Read-only Work owner RPC. The pinned T3 exposes authentication and usage in server.getConfig.
 * The ticket and Effect RPC frame shapes are exercised by fixtures/t3-plan-config.json.
 */
export async function readWorkProviders(origin: string, owner: OwnerFetch): Promise<unknown> {
  try {
    const url = await workOwnerSocketUrl(origin, owner)

    if (!url) {return undefined}

    return await new Promise<unknown>(resolve => {
      const socket = new WebSocket(url)

      const finish = (value?: unknown) => {
        clearTimeout(timer)
        resolve(value)
        socket.close()
      }

      const timer = setTimeout(finish, 2_000)

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] }))
      }, { once: true })
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > 4_000_000) {return finish()}

        try {
          const frame = JSON.parse(event.data) as { _tag?: string; requestId?: string; exit?: { _tag?: string; value?: { providers?: unknown } } }

          if (frame._tag === 'Exit' && frame.requestId === '1') {
            finish(frame.exit?._tag === 'Success' ? frame.exit.value?.providers : undefined)
          }
        } catch {
          finish()
        }
      })
      socket.addEventListener('error', () => finish(), { once: true })
      socket.addEventListener('close', () => finish(), { once: true })
    })

  } catch {
    return undefined
  }
}
