import { expect, it } from 'vitest'

import { readConnectMcpUrl } from './connect-endpoint'

it('uses the native environment hostname and refuses revoked or absent Connect state', async () => {
  const owner = { fetch: async () => Response.json({ linked: true, tunnelHostname: 'mac.example.test' }) }
  expect(await readConnectMcpUrl('http://127.0.0.1:12345', owner)).toBe('https://mac.example.test/mcp')
  await expect(readConnectMcpUrl('https://external.example.test', owner)).rejects.toThrow()
  await expect(readConnectMcpUrl('http://127.0.0.1:12345', {
    fetch: async () => Response.json({ linked: true, linkRevoked: true, tunnelHostname: 'mac.example.test' })
  })).rejects.toThrow()
})
