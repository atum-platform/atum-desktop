import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { Caller } from './contract'
import type { ConnectorService } from './service'
export class ConnectorHttp {
  private server?: Server
  constructor(
    private readonly service: ConnectorService,
    private readonly secret: string
  ) {}
  async start(): Promise<string> {
    const secret = Buffer.from(`Bearer ${this.secret}`)

    const server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '')
      res.setHeader('cache-control', 'no-store')

      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }

      if (auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
        reply(401, { error: 'unauthorized' })

        return
      }

      if (req.method !== 'POST' || req.url !== '/ask' || req.headers.origin) {
        reply(404, { error: 'unavailable' })

        return
      }

      try {
        let body = ''

        for await (const chunk of req) {
          body += chunk.toString()

          if (Buffer.byteLength(body) > 16_384) {
            reply(413, { error: 'invalid_request' })

            return
          }
        }

        const value = JSON.parse(body) as { caller?: Caller; question?: unknown; admission?: unknown }
        const caller = value.caller

        if (
          !caller ||
          Object.keys(caller).some(k => !['threadId', 'providerSessionId', 'providerInstanceId'].includes(k)) ||
          ![caller.threadId, caller.providerSessionId, caller.providerInstanceId].every(
            v => typeof v === 'string' && v.length > 0 && v.length <= 256
          )
        ) {
          reply(400, { error: 'invalid_request' })

          return
        }

        const admission = value.admission

        if (typeof admission !== 'string' || !/^[0-9a-f-]{36}$/u.test(admission)) {
          reply(400, { error: 'invalid_request' })

          return
        }

        reply(
          200,
          await this.service.ask({ ...caller, admission }, value.question)
        )
      } catch {
        reply(400, { error: 'work_question_unavailable' })
      }
    })

    server.requestTimeout = 55_000
    server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.server = server
    const address = server.address()

    if (!address || typeof address === 'string') {
      throw new Error('connector_unavailable')
    }

    return `http://127.0.0.1:${address.port}/ask`
  }
  async close(): Promise<void> {
    this.service.cancel()
    const server = this.server
    this.server = undefined

    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
