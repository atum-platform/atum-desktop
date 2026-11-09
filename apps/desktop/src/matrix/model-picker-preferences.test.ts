import { describe, expect, it, vi } from 'vitest'

import { type MatrixModelRoute, matrixModelRouteId } from '../../shared/matrix-models'

import {
  MATRIX_MODEL_FAVORITES_MAX,
  MATRIX_MODEL_RECENT_MAX,
  matrixModelEffortReconciliation,
  matrixModelFavoriteToggle,
  matrixModelRecentAdd,
  matrixModelRouteMatches,
  matrixModelRoutesForFacet,
  readMatrixModelPickerPreferences,
  writeMatrixModelPickerPreferences
} from './model-picker-preferences'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}

function route(model: string, options: Partial<MatrixModelRoute> = {}): MatrixModelRoute {
  return {
    id: matrixModelRouteId('openai-codex', model),
    provider: 'openai-codex',
    model,
    name: model,
    providerLabel: 'ChatGPT',
    accountLabel: 'ChatGPT Plan',
    connection: 'plan',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: [],
    current: false,
    ready: true,
    ...options
  }
}

describe('model-picker presentation preferences', () => {
  it('keeps favorites stable across catalog generations and scopes them to the account/device key', () => {
    const store = storage()
    const preferences = { favorites: [matrixModelRouteId('openai-codex', 'gpt-6-luna')], recent: [] }

    writeMatrixModelPickerPreferences(store, 'account:@me:test', preferences)

    expect(readMatrixModelPickerPreferences(store, 'account:@me:test')).toEqual(preferences)
    expect(readMatrixModelPickerPreferences(store, 'account:@other:test')).toEqual({ favorites: [], recent: [] })
    // A different generation of the same catalog does not erase the star: only the current
    // routes are shown, and an absent route is simply not rendered.
    expect(
      matrixModelRoutesForFacet([route('gpt-6-luna', { current: true })], 'favorites', preferences).map(each => each.id)
    ).toEqual(preferences.favorites)
    expect(matrixModelRoutesForFacet([route('gpt-5.6-luna')], 'favorites', preferences)).toEqual([])
  })

  it('caps and de-duplicates malformed or hostile stored values', () => {
    const favorites = Array.from({ length: MATRIX_MODEL_FAVORITES_MAX + 10 }, (_, index) =>
      matrixModelRouteId('openai-codex', `model-${index}`)
    )

    const store = storage({
      'atum.model-picker.v1:scope': JSON.stringify({
        favorites: [...favorites, favorites[0], 'not a route', 42],
        recent: Array.from({ length: MATRIX_MODEL_RECENT_MAX + 4 }, (_, index) =>
          matrixModelRouteId('openrouter', `recent-${index}`)
        )
      })
    })

    const parsed = readMatrixModelPickerPreferences(store, 'scope')
    expect(parsed.favorites).toHaveLength(MATRIX_MODEL_FAVORITES_MAX)
    expect(parsed.favorites).toEqual(favorites.slice(0, MATRIX_MODEL_FAVORITES_MAX))
    expect(parsed.recent).toHaveLength(MATRIX_MODEL_RECENT_MAX)
  })

  it('toggles favorites and keeps recents newest-first without duplicates', () => {
    const first = matrixModelRouteId('openai-codex', 'first')
    const second = matrixModelRouteId('openai-codex', 'second')
    let preferences = { favorites: [] as string[], recent: [] as string[] }

    preferences = matrixModelFavoriteToggle(preferences, first)
    preferences = matrixModelFavoriteToggle(preferences, second)
    expect(preferences.favorites).toEqual([second, first])
    preferences = matrixModelFavoriteToggle(preferences, second)
    expect(preferences.favorites).toEqual([first])

    preferences = matrixModelRecentAdd(preferences, first)
    preferences = matrixModelRecentAdd(preferences, second)
    preferences = matrixModelRecentAdd(preferences, first)
    expect(preferences.recent).toEqual([first, second])
  })

  it('searches model, provider and account labels accent-insensitively', () => {
    const item = route('Nguyệt-Thực', { name: 'Nguyệt Thực', providerLabel: 'Atum', accountLabel: 'Gói Atum' })

    expect(matrixModelRouteMatches(item, 'nguyet')).toBe(true)
    expect(matrixModelRouteMatches(item, 'ATUM')).toBe(true)
    expect(matrixModelRouteMatches(item, 'goi atum')).toBe(true)
    expect(matrixModelRouteMatches(item, 'openrouter')).toBe(false)
    expect(matrixModelRouteMatches(item, '  ')).toBe(true)
  })

  it('reconciles an unsupported saved effort visibly, preferring Balanced', () => {
    expect(matrixModelEffortReconciliation(['low'], undefined)).toEqual({ supported: true })
    expect(matrixModelEffortReconciliation(['low', 'medium', 'high'], 'high')).toEqual({ supported: true })
    expect(matrixModelEffortReconciliation(['low', 'high'], 'medium')).toEqual({
      supported: false,
      suggested: 'low'
    })
    expect(matrixModelEffortReconciliation(['high'], 'medium')).toEqual({
      supported: false,
      suggested: 'high'
    })
    expect(matrixModelEffortReconciliation([], 'medium')).toEqual({ supported: false })
  })

  it('survives a storage that throws (private browsing or a full disk)', () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('full')
      })
    }

    expect(readMatrixModelPickerPreferences(broken, 'scope')).toEqual({ favorites: [], recent: [] })
    expect(() => writeMatrixModelPickerPreferences(broken, 'scope', { favorites: ['x'], recent: [] })).not.toThrow()
  })
})
