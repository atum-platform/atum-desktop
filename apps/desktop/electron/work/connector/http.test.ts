import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { ConnectorHttp } from './http'
import { ConnectorService } from './service'
it('authenticates the private channel and rejects browser and forged caller input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-http-'))

  const service = new ConnectorService(join(dir, 'receipts'), {
    current: () => true,
    resolve: async () => undefined,
    send: async () => '$never',
    read: async () => undefined,
    admit: async () => true
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

it('retires the old credential and fails closed across a replacement on the same account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-replacement-'))
  let reads = 0
  let unblockRead!: () => void

  const pendingRead = new Promise<void>(resolve => {
    unblockRead = resolve
  })

  let reading!: () => void

  const readStarted = new Promise<void>(resolve => {
    reading = resolve
  })

  let generation = 1
  const send = vi.fn(async () => '$question')

  const make = (bound: number, secret: string) =>
    new ConnectorHttp(
      new ConnectorService(join(dir, 'receipts'), {
        current: () => generation === bound,
        resolve: async () => ({ room: '!room:test', agent: '@agent:test' }),
        send,
        async read() {
          reads++

          if (bound === 1) {
            reading()
            await pendingRead
          }

          return { dataClass: 'non_google', body: 'answer' }
        },
        admit: async () => true
      }),
      secret
    )

  const old = make(1, 'old-fixture-secret')
  let replacement: ConnectorHttp | undefined
  const question = { agent: 'owned', question: 'hello', request_id: '6465392c-2c68-4b3b-ac27-9fdfdd9ddc82' }

  const ask = (endpoint: string, secret: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        caller: { threadId: 'thread', providerSessionId: 'native', providerInstanceId: 'provider' },
        question,
        admission: 'e3aae2b0-4bed-4eda-8b16-61c8f593e031'
      })
    })

  try {
    const oldEndpoint = await old.start()
    const stale = ask(oldEndpoint, 'old-fixture-secret')
    await readStarted
    generation = 2
    unblockRead()
    expect(await (await stale).json()).toMatchObject({ state: 'cancelled' })
    await old.close()

    replacement = make(2, 'new-fixture-secret')
    const endpoint = await replacement.start()
    expect((await ask(endpoint, 'old-fixture-secret')).status).toBe(401)
    expect(await (await ask(endpoint, 'new-fixture-secret')).json()).toMatchObject({
      state: 'answered',
      answer: 'answer'
    })
    expect(reads).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    unblockRead()
    await old.close()
    await replacement?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
