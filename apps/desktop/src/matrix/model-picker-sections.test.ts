import { describe, expect, it } from 'vitest'

import { type MatrixModelRoute, matrixModelRouteId } from '../../shared/matrix-models'

import {
  NO_PICKER_FILTER,
  PICKER_DEFAULTS_SECTION,
  pickerFilterActive,
  pickerProviderSectionId,
  type PickerRoute,
  pickerSections,
  type PickerSectionsInput
} from './model-picker-sections'

function route(provider: string, model: string, options: Partial<MatrixModelRoute> = {}): PickerRoute {
  return {
    route: {
      id: matrixModelRouteId(provider, model),
      provider,
      model,
      name: model,
      providerLabel: provider === 'openrouter' ? 'OpenRouter' : provider === 'anthropic' ? 'Anthropic' : 'ChatGPT',
      accountLabel: provider === 'openrouter' ? 'API key' : 'ChatGPT Plan',
      connection: provider === 'openrouter' ? 'key' : 'plan',
      target: 'agent_default',
      destination: 'this_mac',
      efforts: [],
      current: false,
      ready: true,
      ...options
    }
  }
}

const NGUYET = route('atum', 'nguyet-thuc', { name: 'Nguyệt Thực 1.3', providerLabel: 'Atum' })
const NHAT = route('atum', 'nhat-thuc', { name: 'Nhật Thực 1.1', providerLabel: 'Atum' })
const LUNA = route('openai-codex', 'gpt-5.6-luna', { current: true })
const GPT6 = route('openai-codex', 'gpt-6-luna')
const SOL = route('openai-codex', 'gpt-6-sol')
const OTHER = route('openrouter', 'other/model')
const OPUS = route('anthropic', 'claude-opus-5-5')

const PROVIDERS = [
  { id: 'openai-codex', label: 'ChatGPT' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'anthropic', label: 'Anthropic' }
]

function sections(overrides: Partial<PickerSectionsInput> = {}) {
  return pickerSections({
    atum: [],
    connected: [LUNA, GPT6, SOL, OTHER, OPUS],
    providers: PROVIDERS,
    favorites: [],
    query: '',
    filter: NO_PICKER_FILTER,
    isCurrent: each => each.current,
    ...overrides
  })
}

const ids = (list: ReturnType<typeof sections>) => list.map(each => each.id)
const models = (list: ReturnType<typeof sections>, id: string) =>
  list.find(each => each.id === id)?.rows.map(each => each.route.model)

describe('the model card’s sections', () => {
  it('draws Atum’s models and every star first, then each connection’s other models', () => {
    const list = sections({ atum: [NGUYET, NHAT], favorites: [SOL.route.id, OPUS.route.id] })

    expect(ids(list)).toEqual([
      PICKER_DEFAULTS_SECTION,
      pickerProviderSectionId('openai-codex'),
      pickerProviderSectionId('openrouter')
    ])

    // Atum's in line-up order, then the stars newest first (the order they are kept in).
    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['nguyet-thuc', 'nhat-thuc', 'gpt-6-sol', 'claude-opus-5-5'])
    expect(list[0].provider).toBeUndefined()
  })

  it('puts the Subscriptions group after Atum’s rows and stars, and before the provider sections', () => {
    const luna = { ...LUNA, subscription: true }

    const list = sections({
      atum: [NGUYET],
      subscriptions: [luna],
      favorites: [GPT6.route.id]
    })

    expect(ids(list)).toEqual([
      PICKER_DEFAULTS_SECTION,
      'subscriptions',
      pickerProviderSectionId('openai-codex'),
      pickerProviderSectionId('openrouter'),
      pickerProviderSectionId('anthropic')
    ])
    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['nguyet-thuc', 'gpt-6-luna'])
    expect(models(list, 'subscriptions')).toEqual(['gpt-5.6-luna'])
    // The subscription model is not drawn again under its provider.
    expect(models(list, pickerProviderSectionId('openai-codex'))).toEqual(['gpt-6-sol'])
  })

  it('draws a starred subscription route once even when the home catalog also carries it', () => {
    const luna = { ...LUNA, subscription: true }
    const list = sections({
      atum: [NGUYET],
      connected: [LUNA, GPT6],
      subscriptions: [luna],
      favorites: [LUNA.route.id]
    })

    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['nguyet-thuc', 'gpt-5.6-luna'])
    expect(ids(list)).not.toContain('subscriptions')
    expect(
      ids(list)
        .flatMap(id => models(list, id))
        .filter(model => model === 'gpt-5.6-luna')
    ).toHaveLength(1)
  })

  it('keeps a subscription’s note in that provider’s own list only, and draws no connect rows', () => {
    const note = (filter: { favoritesOnly: boolean; source?: string }) =>
      sections({
        connected: [],
        providers: [],
        subscriptions: [],
        subscriptionNote: 'ChatGPT needs you to sign in again.',
        subscriptionNoteFor: 'openai-codex',
        filter
      }).flatMap(each => (each.note ? [each.note] : []))

    expect(note({ favoritesOnly: false, source: 'openai-codex' })).toEqual(['ChatGPT needs you to sign in again.'])
    expect(note({ favoritesOnly: false, source: 'opencode-go' })).toEqual([])
    expect(note({ favoritesOnly: false, source: 'atum' })).toEqual([])
    expect(note({ favoritesOnly: true })).toEqual([])
  })

  it('puts a starred model in the top section only, and draws no section for a connection with nothing left', () => {
    const list = sections({ favorites: [OTHER.route.id, GPT6.route.id] })

    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['other/model', 'gpt-6-luna'])
    // OpenRouter's one model is starred: the connection has no section; ChatGPT keeps its others.
    expect(ids(list)).toEqual([
      PICKER_DEFAULTS_SECTION,
      pickerProviderSectionId('openai-codex'),
      pickerProviderSectionId('anthropic')
    ])

    expect(models(list, pickerProviderSectionId('openai-codex'))).toEqual(['gpt-5.6-luna', 'gpt-6-sol'])
  })

  it('draws no top section when there is nothing to put in it', () => {
    expect(ids(sections())).toEqual([
      pickerProviderSectionId('openai-codex'),
      pickerProviderSectionId('openrouter'),
      pickerProviderSectionId('anthropic')
    ])

    expect(sections({ connected: [], providers: [] })).toEqual([])
  })

  it('follows the connections’ order, and gives a connection the catalog did not name its own section', () => {
    const stray = route('mystery', 'm1', { providerLabel: 'Mystery' })
    const list = sections({ connected: [stray, OTHER, LUNA], providers: [PROVIDERS[0], PROVIDERS[1]] })

    // The named ones in their order, then the stray one, with the label its own routes carry.
    expect(ids(list)).toEqual([
      pickerProviderSectionId('openai-codex'),
      pickerProviderSectionId('openrouter'),
      pickerProviderSectionId('mystery')
    ])

    expect(list[2].provider).toEqual({ id: 'mystery', label: 'Mystery' })
  })

  it('draws a star the catalog no longer lists as nothing, and keeps one that cannot be chosen', () => {
    const gone = matrixModelRouteId('openai-codex', 'retired-model')
    const unavailable = route('openai-codex', 'two words', { ready: false })
    const list = sections({ connected: [LUNA, unavailable], favorites: [gone, unavailable.route.id] })

    // The route that left the catalog is not drawn (its star is kept elsewhere); the one that is
    // present but not selectable is still shown, so a person sees why it cannot be picked.
    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['two words'])
    expect(list[0].rows[0].route.ready).toBe(false)
  })

  it('searches every section at once, ignoring accents and case, and drops the sections with no match', () => {
    const list = sections({ atum: [NGUYET, NHAT], favorites: [SOL.route.id], query: 'GPT-6' })

    expect(ids(list)).toEqual([PICKER_DEFAULTS_SECTION, pickerProviderSectionId('openai-codex')])
    expect(models(list, PICKER_DEFAULTS_SECTION)).toEqual(['gpt-6-sol'])
    expect(models(list, pickerProviderSectionId('openai-codex'))).toEqual(['gpt-6-luna'])

    // Atum's own models, by their accented names, and more than one word narrows.
    expect(models(sections({ atum: [NGUYET, NHAT], query: 'nhat thuc' }), PICKER_DEFAULTS_SECTION)).toEqual([
      'nhat-thuc'
    ])

    expect(models(sections({ query: 'openrouter other' }), pickerProviderSectionId('openrouter'))).toEqual([
      'other/model'
    ])

    expect(sections({ atum: [NGUYET], query: 'zzz' })).toEqual([])
  })

  it('narrows to one connection, defaults and stars included, or to favorites only', () => {
    const byConnection = sections({
      atum: [NGUYET],
      favorites: [SOL.route.id, OTHER.route.id],
      filter: { favoritesOnly: false, source: 'openai-codex' }
    })

    expect(ids(byConnection)).toEqual([PICKER_DEFAULTS_SECTION, pickerProviderSectionId('openai-codex')])
    expect(models(byConnection, PICKER_DEFAULTS_SECTION)).toEqual(['gpt-6-sol'])

    // Atum's own rows are a connection of their own.
    const atum = sections({ atum: [NGUYET, NHAT], filter: { favoritesOnly: false, source: 'atum' } })
    expect(ids(atum)).toEqual([PICKER_DEFAULTS_SECTION])
    expect(models(atum, PICKER_DEFAULTS_SECTION)).toEqual(['nguyet-thuc', 'nhat-thuc'])

    const starred = sections({
      atum: [NGUYET],
      favorites: [SOL.route.id, OTHER.route.id],
      filter: { favoritesOnly: true }
    })

    expect(ids(starred)).toEqual([PICKER_DEFAULTS_SECTION])
    expect(models(starred, PICKER_DEFAULTS_SECTION)).toEqual(['gpt-6-sol', 'other/model'])

    // Filter and search both apply.
    expect(
      ids(
        sections({
          favorites: [SOL.route.id, OTHER.route.id],
          filter: { favoritesOnly: true },
          query: 'other'
        })
      )
    ).toEqual([PICKER_DEFAULTS_SECTION])

    expect(sections({ filter: { favoritesOnly: true } })).toEqual([])
  })

  it('says which section holds the current selection', () => {
    const open = sections({ atum: [NGUYET] })
    expect(open.map(each => [each.id, each.current])).toEqual([
      [PICKER_DEFAULTS_SECTION, false],
      [pickerProviderSectionId('openai-codex'), true],
      [pickerProviderSectionId('openrouter'), false],
      [pickerProviderSectionId('anthropic'), false]
    ])

    // A starred current model is in the top section, so no connection holds it.
    const starred = sections({ favorites: [LUNA.route.id] })
    expect(starred.map(each => [each.id, each.current])).toEqual([
      [PICKER_DEFAULTS_SECTION, true],
      [pickerProviderSectionId('openai-codex'), false],
      [pickerProviderSectionId('openrouter'), false],
      [pickerProviderSectionId('anthropic'), false]
    ])

    // Each destination can name its own current route.
    const both = sections({
      atum: [NGUYET, NHAT],
      isCurrent: each => each.provider === 'atum' && each.model === 'nhat-thuc'
    })
    expect(both.filter(each => each.current).map(each => each.id)).toEqual([PICKER_DEFAULTS_SECTION])
  })

  it('names the filter as active only when it narrows something', () => {
    expect(pickerFilterActive(NO_PICKER_FILTER)).toBe(false)
    expect(pickerFilterActive({ favoritesOnly: true })).toBe(true)
    expect(pickerFilterActive({ favoritesOnly: false, source: 'openrouter' })).toBe(true)
  })
})
