import { browserUpdateUrl } from '../../shared/browser/update-restore'

interface BrowserCheckpoint {
  urls: string[]
  selected: number
  open: boolean
}

const key = (scope: string) => `io.atum.browser-update:${scope}`
const maxAge = 30 * 60_000
let checkpoint: (() => void) | undefined

export function registerBrowserUpdateCheckpoint(save: () => void): () => void {
  checkpoint = save

  return () => {if (checkpoint === save) {checkpoint = undefined}}
}

export function checkpointBrowserForUpdate(): void {
  checkpoint?.()
}

export function saveBrowserUpdate(storage: Storage, scope: string, record: BrowserCheckpoint): void {
  if (!record.urls.length) {
    storage.removeItem(key(scope))
    return
  }
  storage.setItem(key(scope), JSON.stringify({ ...record, at: Date.now() }))
}

export function takeBrowserUpdate(storage: Storage, scope: string): BrowserCheckpoint | undefined {
  try {
    const storageKey = key(scope)
    const raw = storage.getItem(storageKey)
    if (!raw) {return}
    storage.removeItem(storageKey)
    const record = JSON.parse(raw)
    const age = Date.now() - record.at
    if (!Number.isFinite(age) || age < 0 || age > maxAge || !Array.isArray(record.urls) || record.urls.length > 32) {return}
    const urls = record.urls.flatMap((value: unknown) => typeof value === 'string' ? browserUpdateUrl(value) ?? [] : [])
    if (urls.length && urls.length === record.urls.length) {
      return { urls, selected: Number.isInteger(record.selected) ? record.selected : -1, open: record.open === true }
    }
  } catch {
    // Optional layout data must never block opening the room.
  }
}
