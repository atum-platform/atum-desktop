import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { ConnectorHttp } from './http'
import { ConnectorService } from './service'
it('authenticates the private channel and rejects browser and forged caller input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-http-'))

  const service = new ConnectorService(join(dir, 'receipts'), {
    current: () => true,
    resolve: async () => undefined,
    send: async () => '$never',
    read: async () => undefined,
    release: async () => true
  })

  const http = new ConnectorHttp(service, 'fixture-secret')
  const endpoint = await http.start()

  try {
    expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer fixture-secret', origin: 'https://example.invalid' }
        })
      ).status
    ).toBe(404)
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: 'Bearer fixture-secret' },
          body: JSON.stringify({
            caller: { threadId: 't', providerSessionId: 's', providerInstanceId: 'p', owner: 'forged' }
          })
        })
      ).status
    ).toBe(400)
  } finally {
    await http.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
