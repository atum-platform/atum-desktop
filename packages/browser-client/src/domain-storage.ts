import { BrowserFailure } from './record'
import type { DomainRecord, DomainStore } from './domain-record'

/** Separate key/CAS in the existing database; no version upgrade or human/crypto rewrite. */
export class IndexedDomainStore implements DomainStore {
  private constructor(private readonly db: IDBDatabase) {}
  static async open(factory: IDBFactory = indexedDB): Promise<IndexedDomainStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open('atum-browser-first-device-v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('bound-device')
      request.onsuccess = () => resolve(new IndexedDomainStore(request.result))
      request.onerror = request.onblocked = () => reject(new BrowserFailure('recovery_needed'))
    })
  }
  read(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('bound-device', 'readonly')
      const request = tx.objectStore('bound-device').get('domain')
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () => reject(new BrowserFailure('recovery_needed'))
    })
  }
  replace(expected: number | null, record: DomainRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('bound-device', 'readwrite')
      const store = tx.objectStore('bound-device')
      const request = store.get('domain')
      request.onsuccess = () => {
        const current = request.result
        if ((expected === null ? current !== undefined : current?.revision !== expected) || record.revision !== (expected ?? 0) + 1) {
          tx.abort(); return
        }
        store.put(record, 'domain')
      }
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(new BrowserFailure('recovery_needed'))
    })
  }
  close() { this.db.close() }
}
