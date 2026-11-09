import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import type { DomainPending } from '../src/domain-record'
import { IndexedDomainStore } from '../src/domain-storage'
import type { DeviceSession } from '../src/record'
import { IndexedDeviceStore } from '../src/storage'

const human = (): DeviceSession => ({
  issuer: 'https://mas.localhost/', baseUrl: 'https://matrix.localhost', clientId: 'matrix-public-client', redirectUri: 'http://localhost:4317/callback',
  version: 1, revision: 1, kind: 'session', phase: 'active', deviceId: 'MATRIX_DEVICE_123456', userId: '@human:localhost',
  subject: 'human-subject', storageKey: btoa('x'.repeat(32)), scope: 'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:MATRIX_DEVICE_123456',
  accessToken: 'matrix-access', refreshToken: 'matrix-refresh', expiresAt: 4102444800000,
})
const pending = (revision = 1): DomainPending => ({
  issuer: 'https://mas.localhost/', matrixBaseUrl: 'https://matrix.localhost', apiBaseUrl: 'https://api.localhost', clientId: 'domain-public-client',
  redirectUri: 'http://localhost:4317/callback', matrix: { issuer: 'https://mas.localhost/', subject: 'human-subject', userId: '@human:localhost', deviceId: 'MATRIX_DEVICE_123456' },
  version: 1, revision, kind: 'domain-login', phase: 'pending', verifier: 'v'.repeat(43), state: `state-${revision}`, nonce: `nonce-${revision}`, createdAt: Date.now(),
})

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('material')
    request.onsuccess = () => resolve(request.result)
    request.onerror = request.onblocked = () => reject(request.error)
  })
}
function put(db: IDBDatabase, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('material', 'readwrite')
    tx.objectStore('material').put(value, 'fixture')
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}
function get(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('material', 'readonly')
    const request = tx.objectStore('material').get('fixture')
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

describe('domain IndexedDB custody', () => {
  it('uses a separate domain key without changing the human record, crypto material, or database version', async () => {
    const factory = new IDBFactory()
    const humanStore = await IndexedDeviceStore.open(factory)
    const persistedHuman = human()
    await humanStore.replace(null, persistedHuman)
    const humanBytes = JSON.stringify(await humanStore.read())
    const crypto = await open(factory, 'crypto-MATRIX_DEVICE_123456::matrix-sdk-crypto')
    const cryptoMaterial = { key: 'sdk-owned-material', revision: 7 }
    await put(crypto, cryptoMaterial)
    const before = await factory.databases()

    const domain = await IndexedDomainStore.open(factory)
    expect(await domain.read()).toBeUndefined()
    const next = pending()
    await domain.replace(null, next)

    expect(JSON.stringify(await humanStore.read())).toBe(humanBytes)
    expect(await domain.read()).toEqual(next)
    expect(await get(crypto)).toEqual(cryptoMaterial)
    expect(await factory.databases()).toEqual(before)

    domain.close()
    crypto.close()
    humanStore.close()
  })

  it('uses revision CAS across stale domain-store handles without changing either adjacent key', async () => {
    const factory = new IDBFactory()
    const humanStore = await IndexedDeviceStore.open(factory)
    await humanStore.replace(null, human())
    const humanBytes = JSON.stringify(await humanStore.read())
    const first = await IndexedDomainStore.open(factory)
    const stale = await IndexedDomainStore.open(factory)

    const initial = pending()
    await first.replace(null, initial)
    await expect(stale.replace(null, initial)).rejects.toThrow('recovery_needed')
    const advanced = pending(2)
    await first.replace(1, advanced)
    await expect(stale.replace(1, pending(2))).rejects.toThrow('recovery_needed')

    expect(await first.read()).toEqual(advanced)
    expect(JSON.stringify(await humanStore.read())).toBe(humanBytes)
    first.close()
    stale.close()
    humanStore.close()
  })
})
