import type { MatrixPetDisplayPreferences } from '../../shared/matrix-pet-display'

interface DisplayStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KEY = 'matrix-pet-display'

/** Device-local main-owned display state; no platform preference or account sync. */
export class MatrixPetDisplay {
  constructor(private readonly store: DisplayStore) {}

  read(): MatrixPetDisplayPreferences {
    try {
      return { showReplyExcerpt: JSON.parse(this.store.getItem(KEY) ?? '{}')?.showReplyExcerpt === true }
    } catch {
      return { showReplyExcerpt: false }
    }
  }

  write(value: unknown): MatrixPetDisplayPreferences {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as MatrixPetDisplayPreferences).showReplyExcerpt !== 'boolean'
    ) {
      throw new Error('matrix_pet_display_invalid')
    }

    const preferences = { showReplyExcerpt: (value as MatrixPetDisplayPreferences).showReplyExcerpt }
    this.store.setItem(KEY, JSON.stringify(preferences))

    return preferences
  }

  position(agentKey: string): { x: number; y: number } | undefined {
    try {
      const value = JSON.parse(this.store.getItem(`matrix-pet-position:${agentKey}`) ?? 'null')

      return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : undefined
    } catch {
      return undefined
    }
  }

  remember(agentKey: string, point: { x: number; y: number }) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      this.store.setItem(`matrix-pet-position:${agentKey}`, JSON.stringify({ x: point.x, y: point.y }))
    }
  }
}
