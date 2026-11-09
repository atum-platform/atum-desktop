import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { deviceSignedBytes, keyId } from './canonical'
import { GrantsStore, type GrantsStoreBackend, type StandingGrant, standingGrantMatches } from './grants-store'

// A throwaway P-256 "approval key" so the test controls both halves and signs like the Secure Enclave.
function approvalKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const spkiB64u = spki.toString('base64url')

  return {
    ref: { kid: keyId(spki), spki: spkiB64u },
    sign(grant: StandingGrant): string {
      return nodeSign('sha256', deviceSignedBytes('StandingGrant', grant), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url')
    }
  }
}

function fakeStore(): GrantsStoreBackend & { data: Map<string, string> } {
  const data = new Map<string, string>()

  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const AGENT = '@agent-t:atumplatform.com'
const OTHER_AGENT = '@another-agent:atumplatform.com'

const grant = (over: Partial<StandingGrant> = {}): StandingGrant => ({
  id: 'sg1',
  capability: 'ssh_agent',
  target: '*',
  label: 'T may use the SSH agent on this MacBook',
  createdAt: 1,
  agent: AGENT,
  ...over
})

describe('standingGrantMatches', () => {
  it('* matches any target of the same capability', () => {
    expect(standingGrantMatches(grant(), 'ssh_agent', 'ssh -T git@github.com', AGENT)).toBe(true)
    expect(standingGrantMatches(grant(), 'keychain', 'anything', AGENT)).toBe(false)
  })
  it('exact and prefix targets', () => {
    expect(standingGrantMatches(grant({ target: 'ssh -T git@github.com' }), 'ssh_agent', 'ssh -T git@github.com', AGENT)).toBe(true)
    expect(standingGrantMatches(grant({ target: 'ssh -T git@github.com' }), 'ssh_agent', 'ssh -T git@gitlab.com', AGENT)).toBe(false)
    expect(
      standingGrantMatches(
        grant({ capability: 'other_agent_write', target: '/home/example/project/*' }),
        'other_agent_write',
        '/home/example/project/a.txt',
        AGENT
      )
    ).toBe(true)
  })
  it("a grant for one agent never matches another", () => {
    expect(standingGrantMatches(grant(), 'ssh_agent', 'ssh -T git@github.com', OTHER_AGENT)).toBe(false)
  })
})

describe('GrantsStore', () => {
  it('adds an approval-key-signed grant and covers() matches it', () => {
    const key = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)
    const g = grant()
    store.add(g, key.ref.kid, key.sign(g))
    expect(store.list().map(x => x.id)).toEqual(['sg1'])
    expect(store.covers('ssh_agent', 'ssh -T git@github.com', AGENT)).toBe(true)
    expect(store.covers('keychain', 'x', AGENT)).toBe(false)
  })

  it('refuses a grant whose signature does not verify (a clicking agent cannot forge one)', () => {
    const key = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)
    expect(() => store.add(grant(), key.ref.kid, 'AAAA')).toThrow('device_standing_grant_unauthorized')
    expect(() => store.add(grant(), 'some-other-kid', key.sign(grant()))).toThrow('device_standing_grant_unauthorized')
    expect(store.list()).toHaveLength(0)
  })

  it('drops a tampered persisted grant on read (signature no longer matches the body)', () => {
    const key = approvalKeyPair()
    const backend = fakeStore()
    const g = grant()
    backend.setItem('device-standing-grants', JSON.stringify([{ grant: g, kid: key.ref.kid, sig: key.sign(g) }]))

    // Tamper the stored body (widen the target) while keeping the old signature.
    const tampered = [{ grant: { ...g, target: '/etc/*' }, kid: key.ref.kid, sig: key.sign(g) }]
    backend.setItem('device-standing-grants', JSON.stringify(tampered))
    const store = new GrantsStore(backend, () => key.ref)
    expect(store.list()).toHaveLength(0)
    expect(store.covers('ssh_agent', 'anything', AGENT)).toBe(false)
  })

  it('drops a legacy grant that names no agent, and says so', () => {
    const key = approvalKeyPair()
    const backend = fakeStore()
    const { agent: _agent, ...agentless } = grant()
    const legacy = agentless as unknown as StandingGrant
    backend.setItem('device-standing-grants', JSON.stringify([{ grant: legacy, kid: key.ref.kid, sig: key.sign(legacy) }]))
    const dropped: string[] = []
    const store = new GrantsStore(backend, () => key.ref, line => void dropped.push(line))

    expect(store.list()).toHaveLength(0)
    expect(store.covers('ssh_agent', 'ssh -T git@github.com', AGENT)).toBe(false)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toContain('standing permission dropped')
    expect(dropped[0]).toContain('sg1')
  })

  it('revoke removes a grant', () => {
    const key = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)
    const g = grant()
    store.add(g, key.ref.kid, key.sign(g))
    store.revoke('sg1')
    expect(store.list()).toHaveLength(0)
  })

  it('with no enrolled approval key, nothing is trusted', () => {
    const store = new GrantsStore(fakeStore(), () => null)
    expect(store.list()).toHaveLength(0)
  })
})

describe('creating a standing grant from Settings', () => {
  const agent = '@agent-t:atumplatform.com'

  it('takes a Touch ID signature over the grant and stores it; it then covers that agent only', async () => {
    const key = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)
    const prompts: string[] = []

    const signer = {
      approve: async (bytes: Uint8Array, reason: string) => {
        prompts.push(reason)
        // The bytes are the grant's device-service signed bytes, as the Secure Enclave signs them.
        const text = Buffer.from(bytes).toString('utf8')
        expect(text.startsWith('atum.device-service.v1\0StandingGrant\0')).toBe(true)
        const grant = JSON.parse(text.slice('atum.device-service.v1\0StandingGrant\0'.length)) as StandingGrant

        return { kid: key.ref.kid, sig: key.sign(grant) }
      }
    }

    const grant = await store.create(
      { id: 'g1', capability: 'ssh_agent', target: '*', label: 'T may use the SSH agent', agent, reason: 'Allow T to use the SSH agent on this Mac' },
      signer,
      1234
    )

    expect(prompts).toEqual(['Allow T to use the SSH agent on this Mac'])
    expect(grant).toMatchObject({ id: 'g1', agent, createdAt: 1234 })
    expect(store.list().map(each => each.id)).toEqual(['g1'])
    expect(store.covers('ssh_agent', 'ssh -T git@github.com', agent)).toBe(true)
    expect(store.covers('ssh_agent', 'ssh -T git@github.com', '@another-agent:atumplatform.com')).toBe(false)
    expect(store.covers('keychain', 'security find-generic-password', agent)).toBe(false)
  })

  it('a cancelled Touch ID stores nothing', async () => {
    const key = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)

    const signer = {
      approve: async () => {
        throw Object.assign(new Error('device_key_approval_denied'), { code: 'approval_denied' })
      }
    }

    await expect(
      store.create({ id: 'g1', capability: 'ssh_agent', target: '*', label: '', agent, reason: 'x' }, signer, 1)
    ).rejects.toThrow('approval_denied')
    expect(store.list()).toEqual([])
  })

  it('a signature by any other key is refused', async () => {
    const key = approvalKeyPair()
    const other = approvalKeyPair()
    const store = new GrantsStore(fakeStore(), () => key.ref)

    const signer = {
      approve: async (bytes: Uint8Array) => {
        const text = Buffer.from(bytes).toString('utf8')
        const grant = JSON.parse(text.slice('atum.device-service.v1\0StandingGrant\0'.length)) as StandingGrant

        return { kid: key.ref.kid, sig: other.sign(grant) }
      }
    }

    await expect(
      store.create({ id: 'g1', capability: 'ssh_agent', target: '*', label: '', agent, reason: 'x' }, signer, 1)
    ).rejects.toThrow('device_standing_grant_unauthorized')
    expect(store.list()).toEqual([])
  })
})
