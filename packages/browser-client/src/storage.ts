import { BrowserFailure, type DeviceRecord } from './record'

export interface DeviceStore {
  read(): Promise<unknown>
  replace(expected: number | null, record: DeviceRecord): Promise<void>
}

/** Identity, storage key and credentials cross one IndexedDB commit boundary. */
export class IndexedDeviceStore implements DeviceStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<IndexedDeviceStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open('atum-browser-first-device-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('bound-device')
      request.onsuccess = () => resolve(new IndexedDeviceStore(request.result))
      request.onerror = request.onblocked = () => reject(new BrowserFailure('recovery_needed'))
    })
  }

  read(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('bound-device', 'readonly')
      const request = tx.objectStore('bound-device').get('human')
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () => reject(new BrowserFailure('recovery_needed'))
    })
  }

  replace(expected: number | null, record: DeviceRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('bound-device', 'readwrite')
      const store = tx.objectStore('bound-device')
      const request = store.get('human')
      request.onsuccess = () => {
        const current = request.result
        if ((expected === null ? current !== undefined : current?.revision !== expected) || record.revision !== (expected ?? 0) + 1) {
          tx.abort()
          return
        }
        store.put(record, 'human')
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(new BrowserFailure('recovery_needed'))
    })
  }

  close() { this.db.close() }
}

export async function requireCryptoStores(deviceId: string, factory: IDBFactory = indexedDB): Promise<void> {
  const names = new Set((await factory.databases()).map(db => db.name))
  if (!['matrix-sdk-crypto', 'matrix-sdk-crypto-meta'].every(suffix => names.has(`crypto-${deviceId}::${suffix}`))) {
    throw new BrowserFailure('recovery_needed')
  }
}

/** Hold from before persistence is read until the SDK is stopped or the page leaves.
 * No time-based lease: a frozen/background tab must not lose its device to a second writer. */
export async function acquireWriter(locks: LockManager): Promise<() => void> {
  const { DEVICE_LOCK } = await import('./record')
  return new Promise((resolve, reject) => {
    void locks.request(DEVICE_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { reject(new BrowserFailure('device_busy')); return }
      await new Promise<void>(release => resolve(release))
    }).catch(() => reject(new BrowserFailure('device_busy')))
  })
}
