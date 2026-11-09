import type { DeviceRecord } from './record'
import { BrowserFailure } from './record'
import type { DomainRecord, DomainStore } from './domain-record'
import type { DeviceStore } from './storage'

export interface ChatSend {
  id: string
  userId: string
  deviceId: string
  roomId: string
  body: string
  createdAt: number
  credentialEpoch: string
  phase: 'uncertain'
}
export interface ChatDraft {
  userId: string
  principal: string
  body: string
  version: string
}

/** Consumer state is isolated from the old first-device/recovery proof. */
export class ChatStorage {
  private constructor(private readonly db: IDBDatabase) {}
  static open(factory: IDBFactory = indexedDB): Promise<ChatStorage> {
    return new Promise((resolve, reject) => {
      const request = factory.open('atum-browser-chat-v1', 2)
      let failed = false
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('auth')) db.createObjectStore('auth')
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('drafts'))
          db.createObjectStore('drafts', { keyPath: ['userId', 'principal'] }).createIndex('user', 'userId')
      }
      request.onsuccess = () => {
        if (failed) return request.result.close()
        request.result.onversionchange = () => request.result.close()
        resolve(new ChatStorage(request.result))
      }
      request.onerror = request.onblocked = () => {
        failed = true
        reject(new BrowserFailure('operation_failed'))
      }
    })
  }
  private read(key: string): Promise<unknown> {
    return this.transaction('auth', 'readonly', store => store.get(key))
  }
  private replace(key: string, expected: number | null, record: DeviceRecord | DomainRecord): Promise<void> {
    return this.transaction('auth', 'readwrite', store => {
      const request = store.get(key)
      request.onsuccess = () => {
        if (
          (expected === null ? request.result !== undefined : request.result?.revision !== expected) ||
          record.revision !== (expected ?? 0) + 1
        ) {
          store.transaction.abort()
          return
        }
        store.put(record, key)
      }
    })
  }
  readonly device: DeviceStore = {
    read: () => this.read('matrix'),
    replace: (revision, record) => this.replace('matrix', revision, record)
  }
  readonly domain: DomainStore = {
    read: () => this.read('domain'),
    replace: (revision, record) => this.replace('domain', revision, record)
  }

  /** Only after admission has closed and the SDK and token rotations have stopped. */
  clearAuthentication(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['auth', 'drafts', 'outbox'], 'readwrite')
      tx.objectStore('auth').clear()
      // Logout purges browser-local message text as well as credentials. An
      // outbox record is scoped to the old device and cannot be recovered by a
      // later sign-in, so retaining it would keep private text with no UI path.
      tx.objectStore('drafts').clear()
      tx.objectStore('outbox').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(new BrowserFailure('operation_failed'))
    })
  }
  drafts(userId: string): Promise<ChatDraft[]> {
    return this.transaction('drafts', 'readonly', store => store.index('user').getAll(userId))
  }
  putDraft(draft: ChatDraft): Promise<void> {
    return this.transaction('drafts', 'readwrite', store => {
      if (draft.body) store.put(draft)
      else store.delete([draft.userId, draft.principal])
    })
  }
  async sends(userId: string, deviceId: string): Promise<ChatSend[]> {
    const records = await this.transaction<ChatSend[]>('outbox', 'readonly', store => store.getAll())
    return records.filter(record => record.userId === userId && record.deviceId === deviceId)
  }
  putSend(record: ChatSend, draft?: ChatDraft): Promise<void> {
    if (draft) {
      if (draft.userId !== record.userId || draft.body !== record.body)
        return Promise.reject(new BrowserFailure('operation_failed'))
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(['outbox', 'drafts'], 'readwrite')
        tx.objectStore('outbox').put(record)
        const drafts = tx.objectStore('drafts')
        const request = drafts.get([draft.userId, draft.principal])
        request.onsuccess = () => {
          // A newer edit, including identical text with a new version, stays a draft.
          if (request.result?.version === draft.version) drafts.delete([draft.userId, draft.principal])
        }
        tx.oncomplete = () => resolve()
        tx.onerror = tx.onabort = () => reject(new BrowserFailure('operation_failed'))
      })
    }
    return this.transaction('outbox', 'readwrite', store => {
      store.put(record)
    })
  }
  dropSend(id: string): Promise<void> {
    return this.transaction('outbox', 'readwrite', store => {
      store.delete(id)
    })
  }
  private transaction<T = void>(
    name: string,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, mode)
      const request = action(tx.objectStore(name))
      tx.oncomplete = () => resolve(request?.result as T)
      tx.onerror = tx.onabort = () => reject(new BrowserFailure('operation_failed'))
    })
  }
  close() {
    this.db.close()
  }
}
