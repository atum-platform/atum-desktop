import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

import { vi } from 'vitest'

import { MacExecutorAuth } from './agent-home-placement/executor-auth'
import { MacJobsClient, type MacJobsOptions } from './mac-jobs'

export function fixture() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const kid = createHash('sha256').update(keys.publicKey.export({ format: 'der', type: 'spki' })).digest('base64url')
  const store = new Map<string, string>(), deviceServiceId = randomUUID()

  const auth = new MacExecutorAuth({ key: () => ({ deviceServiceId, identityKid: kid, enrollmentEpoch: 1,
    signIdentity: async bytes => ({ kid, sig: sign('sha256', bytes, { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }) }),
    store: { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value) }, failureCode: () => null } })

  const home = { ownerUserId: '@owner:atum.test', agentPrincipal: randomUUID(), homeId: randomUUID(), homeEpoch: 1,
    executorTerm: 2, leaseId: randomUUID(), leaseExpiresAtPlatform: Date.now() + 60_000 }

  const assistantId = randomUUID()
  const sent: { url: string; body: any; headers: any }[] = []
  let result: unknown = { profile: 'atum.controller-job-fire/1', operation: 'claimed', agentPrincipal: home.agentPrincipal, fire: null }, status = 200

  const fetcher = vi.fn(async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })

    return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })
  })

  const authority = vi.fn(async () => home)

  const options: MacJobsOptions = { auth, authority, fetch: fetcher as typeof fetch,
    request: async <T>(send: (token: string, resource: string) => Promise<T>) => send('mas-bearer', 'https://shell.test/api/matrix/v1') }

  return { client: new MacJobsClient(options), options, sent, home, assistantId, keys, auth, authority, fetcher,
    claim: { profile: 'atum.controller-job-fire/1' as const, operation: 'claim' as const, leaseToken: home.leaseId },
    respond: (value: unknown, code = 200) => { result = value; status = code } }
}

