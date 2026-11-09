import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { PlacementConnectionAuth, PlacementConnectionAuthError } from './connection-auth'
import { placementConnectionSignedBytes } from './contract-v25'

const DEVICE = '00000000-0000-4000-8000-b454f82c5857'

class Store {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  failureCode() { return null }
}

describe('the 2.5 Mac/owner signer', () => {
  it('signs all four owner writes with the enrolled identity key and the inherited durable counter', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = keys.publicKey.export({ format: 'der', type: 'spki' })
    const kid = createHash('sha256').update(spki).digest('base64url')
    const store = new Store()
    const auth = new PlacementConnectionAuth({
      key: () => ({
        deviceServiceId: DEVICE,
        enrollmentEpoch: 3,
        identityKid: kid,
        signIdentity: async bytes => ({
          kid,
          sig: sign('sha256', bytes, { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
        })
      }),
      store,
      now: () => 1_800_000_000_000,
      uuid: () => '00000000-0000-4000-8000-f1d11edf5c5c',
      random: () => new Uint8Array(32).fill(7)
    })

    const ownerMessages = [
      'owner.home.move.preflight-request',
      'owner.home.move.request',
      'owner.home.move.cancel',
      'owner.home.model-choice.write'
    ] as const
    const owners = []
    for (const message of ownerMessages) {
      owners.push(await auth.signOwner(message, meta => ({ meta, marker: 'owner' })))
    }
    const mac = await auth.signMac('home.connection-catalog.ingest', meta => ({ meta, marker: 'mac' }))

    for (const [index, owner] of owners.entries()) {
      expect(owner.meta).toMatchObject({
        signer: 'owner_client',
        surface: 'desktop',
        authenticatedChannel: 'desktop',
        signerKeyId: kid
      })
      expect(Object.keys(owner.meta).sort()).toEqual([
        'authenticatedChannel',
        'commandId',
        'expiresAt',
        'issuedAt',
        'nonce',
        'requestId',
        'sequence',
        'signature',
        'signer',
        'signerKeyId',
        'surface'
      ])
      expect(
        verify(
          'sha256',
          placementConnectionSignedBytes(ownerMessages[index]!, owner as never),
          { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(owner.meta.signature, 'base64url')
        )
      ).toBe(true)
    }
    expect(mac.meta).toMatchObject({ signer: 'mac_executor', deviceServiceId: DEVICE, signerKeyId: kid })
    expect(owners[0]!.meta.sequence).toBe(mac.meta.sequence)
    expect([...store.values.keys()].sort()).toEqual([
      `agent-home-v24-mac_executor-sequence-v1:${DEVICE}`,
      `agent-home-v24-owner_client-sequence-v1:${DEVICE}`
    ])
    expect(
      verify(
        'sha256',
        placementConnectionSignedBytes('home.connection-catalog.ingest', mac as never),
        { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(mac.meta.signature, 'base64url')
      )
    ).toBe(true)
  })

  it('fails closed instead of falling back to bearer-only desktop metadata', async () => {
    const auth = new PlacementConnectionAuth({ key: () => null, store: new Store() })

    await expect(
      auth.signOwner('owner.home.move.preflight-request', meta => ({ meta }))
    ).rejects.toEqual(new PlacementConnectionAuthError('device_not_enrolled'))
  })
})
