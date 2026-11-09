import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

import { AtumMessagingHttpClient } from './http-client'

const captured = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../contracts/atum-advisory-history-v1/sql-0099-capture.json', import.meta.url)),
    'utf8'
  )
)

test('real SQL responses cross authenticated HTTP and the Desktop parser with attribution intact', async () => {
  let response = captured.responses.discovery
  const requests: Array<{ authorization: string | undefined; body: unknown }> = []

  const server = createServer(async (request, reply) => {
    let body = ''

    for await (const chunk of request) {
      body += chunk
    }

    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) })
    reply.writeHead(200, { 'content-type': 'application/json' })
    reply.end(JSON.stringify(response))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }

  const client = new AtumMessagingHttpClient(
    {
      current: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        user: { id: 'fixture-owner', displayName: null, handle: null },
        tokens: { accessToken: 'fixture-token', refreshToken: null, expiresAt: null }
      }),
      refresh: async () => null
    },
    fetch
  )

  try {
    for (const raw of Object.values(captured.responses)) {
      response = raw

      const parsed = await client.advisorySearch({
        target_assistant_id: '00000000-0000-4000-8000-a8e68b593357',
        conversation_id: null,
        query: 'decision',
        reference: null,
        limit: 5
      })

      expect(parsed.status).toBe('ok')
      expect(
        parsed.results.flatMap(room => room.messages).map(message => [message.id, message.speaker, message.text])
      ).toEqual(
        response.results
          .flatMap((room: any) => room.messages)
          .map((message: any) => [message.id, message.speaker, message.text])
      )
      expect([...JSON.stringify(parsed)].length).toBeLessThanOrEqual(6000)
    }

    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.authorization === 'Bearer fixture-token')).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})
