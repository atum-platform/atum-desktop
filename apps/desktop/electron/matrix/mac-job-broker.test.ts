import { randomUUID } from 'node:crypto'

import { expect, it } from 'vitest'

import { openMacJobBroker } from './mac-job-broker'
import { fixture } from './mac-jobs.fixture'

it.each(['revoked', 'lease_loss'])('checks every call and refuses %s without another completion', async reason => {
  const f = fixture()
  const stop = new AbortController()
  const reservationId = randomUUID()
  const occurrenceId = randomUUID()

  const model = { token: 'g'.repeat(43), expiresAt: Date.now() + 60000, aliases: ['atum'], alias: 'atum', model: 'private-model',
    ceilingMicroProtons: 1000, funding: 'trial' as const, contextBudget: 10000, outputBudget: 1000,
    maxTurnMicroProtons: 1000, effort: 'low', policyDigest: 'a'.repeat(64) }

  let checks = 0, completions = 0, revoked = false

  const broker = await openMacJobBroker({ ...f.options, assistantId: f.assistantId, baseUrl: 'https://gateway.test/v1',
    signal: stop.signal, occurrence: { occurrenceId, state: 'dispatched', scheduleId: 'routine', occurrenceAt: 1000,
      agentPrincipal: f.home.agentPrincipal, executorId: randomUUID(), roomId: '!home:test',
      budget: { reservationId, funding: 'trial', ceilingMicroProtons: 1000, computeSeconds: 10, firstAdmission: true }, grants: { model } },
    fetch: async (url, init) => {
      if (String(url).endsWith('/jobs/grant')) {
        checks++
        expect(JSON.parse(String(init?.body)).request.token).toBe(model.token)
        const { token: _token, ...active } = model

        return Response.json(revoked ? { state: 'revoked' } : { ...active, state: 'active',
          owner: randomUUID(), agentPrincipal: f.home.agentPrincipal, reservationId })
      }

      completions++
      expect(new Headers(init?.headers).get('x-atum-model-grant')).toBe(model.token)
      expect(new Headers(init?.headers).has('x-atum-controller')).toBe(false)

      return Response.json({ id: 'completion', object: 'chat.completion', created: 1, model: 'private-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] })
    } })

  try {
    expect(broker.key).not.toBe(model.token)

    const post = () => fetch(`${broker.baseUrl}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${broker.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'atum', messages: [{ role: 'user', content: 'run' }] }) })

    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    revoked = reason === 'revoked'

    if (reason === 'lease_loss') {f.authority.mockResolvedValueOnce(null as never)}
    expect((await post()).status).not.toBe(200)
    expect(checks).toBe(reason === 'revoked' ? 3 : 2)
    expect(completions).toBe(2)
    stop.abort()
    await broker.stop()
    await expect(post()).rejects.toThrow()
  } finally { await broker.stop() }
})
