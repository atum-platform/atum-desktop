import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixRoom,
  MatrixUiBridge
} from '../../shared/matrix'
import {
  type MatrixCloudModelChoiceView,
  type MatrixConnectedModel,
  type MatrixModelAccount,
  type MatrixModelCatalog,
  type MatrixModelRoute,
  matrixModelRouteId,
  type MatrixModelRouteSelection
} from '../../shared/matrix-models'

import { MatrixModelPicker } from './model-picker'
import { readMatrixModelPickerPreferences, writeMatrixModelPickerPreferences } from './model-picker-preferences'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const ROOM: MatrixRoom = {
  id: '!assistant:test',
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true
}

const CHATGPT: MatrixConnectedModel = { provider: 'openai-codex', model: 'gpt-5.6-luna' }
const CHATGPT_ROUTE = matrixModelRouteId('openai-codex', 'gpt-5.6-luna')
const GPT6_ROUTE = matrixModelRouteId('openai-codex', 'gpt-6-luna')
const SOL_ROUTE = matrixModelRouteId('openai-codex', 'gpt-6-sol')
const KIMI_ROUTE = matrixModelRouteId('opencode-go', 'kimi-k3')
const GLM_ROUTE = matrixModelRouteId('opencode-go', 'glm-5.3')
const MINIMAX_ROUTE = matrixModelRouteId('opencode-go', 'minimax-m3')
const GLM_CLOUD_ROUTE = matrixModelRouteId('opencode-go', 'glm-5.2')
const KIMI_CLOUD_ROUTE = matrixModelRouteId('opencode-go', 'kimi-k3')
const OPENROUTER_ROUTE = matrixModelRouteId('openrouter', 'other/model')
const NGUYET_THUC_ROUTE = matrixModelRouteId('atum', 'nguyet-thuc')
const NHAT_THUC_ROUTE = matrixModelRouteId('atum', 'nhat-thuc')
const THAI_CUC_ROUTE = matrixModelRouteId('atum', 'thai-cuc')

function route(
  id: string,
  provider: string,
  model: string,
  providerLabel: string,
  accountLabel: string,
  options: Partial<MatrixModelRoute> = {}
): MatrixModelRoute {
  return {
    id,
    provider,
    model,
    name: model,
    providerLabel,
    accountLabel,
    connection: provider === 'openrouter' ? 'key' : 'plan',
    target: 'agent_default',
    destination: 'this_mac',
    efforts: [],
    current: false,
    ready: true,
    ...options
  }
}

function account(
  id: string,
  providerLabel: string,
  accountLabel: string,
  options: Partial<MatrixModelAccount> = {}
): MatrixModelAccount {
  return {
    id,
    providerLabel,
    accountLabel,
    connection: 'plan',
    ready: true,
    models: 1,
    ...options
  }
}

const CATALOG: MatrixModelCatalog = {
  destination: 'this_mac',
  agentName: 'Atum',
  current: CHATGPT_ROUTE,
  unavailable: 0,
  routes: [
    route(CHATGPT_ROUTE, 'openai-codex', 'gpt-5.6-luna', 'ChatGPT', 'ChatGPT Plan', {
      efforts: ['low', 'medium', 'high'],
      current: true
    }),
    route(GPT6_ROUTE, 'openai-codex', 'gpt-6-luna', 'ChatGPT', 'ChatGPT Plan', {
      efforts: ['low', 'medium', 'high']
    }),
    route(SOL_ROUTE, 'openai-codex', 'gpt-6-sol', 'ChatGPT', 'ChatGPT Plan', {
      efforts: ['low', 'medium', 'high']
    }),
    route(OPENROUTER_ROUTE, 'openrouter', 'other/model', 'OpenRouter', 'API key', {
      connection: 'key',
      efforts: ['low', 'high']
    })
  ],
  accounts: [
    account('openai-codex', 'ChatGPT', 'ChatGPT Plan', { models: 3 }),
    account('openrouter', 'OpenRouter', 'API key', { connection: 'key' })
  ]
}

function plan(
  extra: {
    catalog?: MatrixModelCatalog | Error
    select?: MatrixUiBridge['selectModelRoute']
  } = {}
) {
  let active = extra.catalog instanceof Error ? undefined : (extra.catalog ?? CATALOG)

  const modelCatalog = vi.fn(async () => {
    if (extra.catalog instanceof Error) {
      throw extra.catalog
    }

    return active!
  })

  const selectModelRoute =
    extra.select ??
    vi.fn(async (_roomId: string, routeId: string) => {
      if (active) {
        active = {
          ...active,
          current: routeId,
          routes: active.routes.map(each => ({ ...each, current: each.id === routeId }))
        }
      }

      return { status: 'applied' as const, current: routeId }
    })

  return { modelCatalog, selectModelRoute }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

const CLOUD_NGUYET: MatrixAgentHomeModelOption = {
  connectionRef: 'conn-atum',
  source: 'atum',
  providerLabel: 'Atum',
  model: 'nguyet-thuc',
  modelLabel: 'Nguyệt Thực 1.3',
  effort: 'medium',
  efforts: ['medium'],
  available: true
}

const CLOUD_NHAT: MatrixAgentHomeModelOption = {
  ...CLOUD_NGUYET,
  model: 'nhat-thuc',
  modelLabel: 'Nhật Thực 1.1'
}

const HOME_GPT: MatrixAgentHomeModelOption = {
  connectionRef: 'conn-chatgpt',
  source: 'chatgpt_plan',
  providerLabel: 'ChatGPT',
  model: 'gpt-5.6-luna',
  modelLabel: 'gpt-5.6-luna',
  effort: 'medium',
  efforts: ['low', 'medium', 'high'],
  available: true
}

const HOME_OPENROUTER: MatrixAgentHomeModelOption = {
  connectionRef: 'conn-openrouter',
  source: 'own_key:openrouter',
  providerLabel: 'OpenRouter',
  model: 'other/model',
  modelLabel: 'other/model',
  effort: 'high',
  efforts: ['low', 'high'],
  available: true
}

function cloudHome(current: MatrixAgentHomeModelOption = CLOUD_NGUYET): MatrixAgentHomeView {
  return {
    lives: { kind: 'cloud' },
    move: null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: 'cloud',
      reachability: 'reachable',
      currentModel: current,
      modelStatus: 'applied',
      destinations: [
        {
          id: 'cloud',
          kind: 'cloud',
          name: '',
          thisMac: false,
          eligibility: 'ready',
          catalogRevision: 0,
          models: [CLOUD_NGUYET, CLOUD_NHAT]
        }
      ]
    }
  }
}

function macHome(current: MatrixAgentHomeModelOption = HOME_GPT): MatrixAgentHomeView {
  return {
    lives: { kind: 'mac', name: 'Mac mini', thisMac: true },
    move: null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: 'mac-mini',
      reachability: 'reachable',
      currentModel: current,
      modelStatus: 'applied',
      destinations: [
        {
          id: 'cloud',
          kind: 'cloud',
          name: '',
          thisMac: false,
          eligibility: 'ready',
          catalogRevision: 0,
          models: [CLOUD_NGUYET, CLOUD_NHAT]
        },
        {
          id: 'mac-mini',
          kind: 'mac',
          name: 'Mac mini',
          thisMac: true,
          eligibility: 'ready',
          catalogRevision: 7,
          models: [CLOUD_NGUYET, CLOUD_NHAT, HOME_GPT, HOME_OPENROUTER]
        }
      ]
    }
  }
}

function homeBridge(
  model: MatrixAgentHomeBridge['model'] = vi.fn(async () => ({ status: 'saved' as const }))
): MatrixAgentHomeBridge {
  return {
    read: vi.fn(async () => undefined),
    preflight: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    move: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    cancel: vi.fn(async () => ({ ok: false })),
    model,
    prepare: vi.fn(async () => ({ ok: false }))
  }
}

interface PickerOptions {
  locale?: 'en' | 'vi'
  bridge?: Partial<MatrixUiBridge>
  preferenceScope?: string
  onAdvanced?: (() => void) | null
  onSubscriptions?: (() => void) | null
  managed?: boolean
  cloud?: boolean
  cloudChoice?: MatrixCloudModelChoiceView
  destinationDefault?: 'nguyet-thuc' | 'nhat-thuc'
  connected?: MatrixConnectedModel
  capability?: unknown
  local?: boolean
  here?: 'cloud' | 'this_mac'
  onBackToAtum?: () => void
  agentPrincipal?: string
  home?: MatrixAgentHomeView
  cloudOnly?: boolean
}

function picker(room: MatrixRoom, options: PickerOptions = {}) {
  const fail = vi.fn()
  const command = options.bridge?.command ?? vi.fn(async () => null)
  const onAdvanced = options.onAdvanced === undefined ? vi.fn() : options.onAdvanced
  const onSubscriptions = options.onSubscriptions === undefined ? vi.fn() : options.onSubscriptions
  let current = options

  const view = (nextRoom: MatrixRoom) => (
    <I18nProvider configClient={null} initialLocale={current.locale ?? 'en'}>
      <MatrixModelPicker
        agentPrincipal={current.agentPrincipal}
        capability={current.capability}
        cloud={current.cloud ?? false}
        cloudChoice={current.cloudChoice}
        cloudOnly={current.cloudOnly}
        connected={current.connected}
        destinationDefault={current.destinationDefault}
        disabled={false}
        fail={fail}
        here={current.here}
        home={current.home}
        local={current.local ?? !(current.managed ?? true)}
        managed={current.managed ?? true}
        onAdvanced={onAdvanced ?? undefined}
        onBackToAtum={current.onBackToAtum}
        onSubscriptions={onSubscriptions ?? undefined}
        preferenceScope={current.preferenceScope}
        room={nextRoom}
      />
    </I18nProvider>
  )

  window.atumMatrix = { ...options.bridge, command } as unknown as MatrixUiBridge
  const rendered = render(view(room))

  return {
    command,
    fail,
    onAdvanced,
    onSubscriptions,
    rerender(nextRoom = room, overrides: Partial<PickerOptions> = {}) {
      current = { ...current, ...overrides }
      window.atumMatrix = { ...current.bridge, command } as unknown as MatrixUiBridge
      rendered.rerender(view(nextRoom))
    }
  }
}

const open = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }))

  return screen.findByRole('dialog', { name: /^(Model|Mô hình)$/ })
}

const rows = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLButtonElement>('[data-matrix-model-route]'))

const rowIds = (card: HTMLElement) => rows(card).map(each => each.dataset.matrixModelRoute)

const row = (card: HTMLElement, id: string) => {
  const found = rows(card).find(each => each.dataset.matrixModelRoute === id)

  if (!found) {
    throw new Error('row not found: ' + id)
  }

  return found
}

const favorite = (card: HTMLElement, id: string) =>
  row(card, id).parentElement!.querySelector<HTMLButtonElement>('[data-matrix-model-favorite]')!

const rail = (card: HTMLElement, id: string) =>
  card.querySelector<HTMLButtonElement>('[data-matrix-model-rail-item="' + id + '"]')!

const selected = (card: HTMLElement) => card.querySelectorAll('[data-matrix-model-route][aria-current="true"]')

const search = (card: HTMLElement, name = 'Search models…') => within(card).getByRole('textbox', { name })

const star = (...ids: string[]) =>
  writeMatrixModelPickerPreferences(window.localStorage, ROOM.id, { favorites: ids, recent: [] })

const favorites = () => readMatrixModelPickerPreferences(window.localStorage, ROOM.id).favorites

describe('the T3-layout conversation model picker', () => {
  it('shows Atum’s line-up in the one provider card when nothing else is connected', async () => {
    picker(ROOM)
    const card = await open('Model: Nguyệt Thực 1.3')

    // Preserve user-visible identity, state and recovery behavior across connection changes.
    expect(card.querySelector('[data-matrix-model-menu]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-panel]')).toBeTruthy()
    expect(rail(card, 'favorites')).toBeTruthy()
    expect(rail(card, 'atum')).toBeTruthy()
    expect(search(card)).toBeTruthy()
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(row(card, NGUYET_THUC_ROUTE).textContent).toMatch(/Nguyệt Thực 1\.3.*Suggested · Good for everyday tasks/)
    expect(row(card, NHAT_THUC_ROUTE).textContent).toMatch(/Nhật Thực 1\.1.*Good for hard tasks/)
    expect(row(card, NHAT_THUC_ROUTE).textContent).not.toMatch(/20×/)
    expect(row(card, THAI_CUC_ROUTE).textContent).toMatch(/Thái Cực.*The most powerful model · Coming soon/)
    expect(row(card, THAI_CUC_ROUTE).disabled).toBe(true)
    expect(selected(card)).toHaveLength(1)
    expect(row(card, NGUYET_THUC_ROUTE).getAttribute('aria-current')).toBe('true')
    // The chip says the model's name; the version lives in the card.
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' }).textContent).toBe('Nguyệt Thực')
  })

  it('says the provider card in Vietnamese', async () => {
    picker(ROOM, { locale: 'vi' })
    const card = await open('Mô hình: Nguyệt Thực 1.3')

    expect(search(card, 'Tìm mô hình…')).toBeTruthy()
    expect(row(card, NGUYET_THUC_ROUTE).textContent).toMatch(/Đề xuất · Phù hợp tác vụ hàng ngày/)
    expect(row(card, NHAT_THUC_ROUTE).textContent).toMatch(/Phù hợp với tác vụ khó khăn/)
    expect(row(card, NHAT_THUC_ROUTE).textContent).not.toMatch(/20×/)
    expect(row(card, THAI_CUC_ROUTE).textContent).toMatch(/Mô hình quyền năng nhất · Sắp có/)
  })

  it('keeps the two-column picker, with its rail, search and tooltip shortcuts, once more than Atum is connected', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')

    await waitFor(() => expect(rows(card)).toHaveLength(3))
    expect(card.querySelector('[data-matrix-model-menu]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-rail]')).toBeTruthy()
    expect(card.querySelector('[data-matrix-model-connect]')).toBeTruthy()
    expect(search(card)).toBeTruthy()
    expect(rows(card).map(each => each.getAttribute('aria-keyshortcuts'))).toEqual(['Meta+1', 'Meta+2', 'Meta+3'])
    expect(card.querySelector('[data-matrix-model-shortcut]')).toBeNull()

    const searchRegion = card.querySelector('[data-matrix-model-search]')!
    const list = card.querySelector('[data-matrix-model-list]')!
    expect(searchRegion.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the composer picker open when async home data changes its model projection', async () => {
    const chooseHome = vi.fn(async () => ({ status: 'saved' as const }))
    const bridge = { ...plan(), agentHome: homeBridge(chooseHome) }

    const rendered = picker(ROOM, {
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      bridge,
      connected: CHATGPT,
      managed: false
    })

    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rowIds(card)).toContain(CHATGPT_ROUTE))

    rendered.rerender(ROOM, { home: macHome() })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Model' })).toBe(card))

    fireEvent.click(rail(card, 'atum'))
    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    await waitFor(() =>
      expect(chooseHome).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-bd7662a5eeb4',
        expect.objectContaining({ model: 'nhat-thuc' })
      )
    )
    expect(screen.getByRole('dialog', { name: 'Model' })).toBe(card)
  })

  it('keeps the Atum mark on the same line as its meta text when the description wraps', async () => {
    picker(ROOM, { managed: true, connected: CHATGPT, bridge: plan(), local: true })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'atum')).toBeTruthy())
    // It answers with its ChatGPT connection, so the card opens there, as the chip says.
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rail(card, 'atum'))
    expect(selected(card)).toHaveLength(0)
    const meta = row(card, NHAT_THUC_ROUTE).querySelector<HTMLElement>('[data-matrix-model-atum-meta]')!

    // The mark and the copy are one nowrap unit, so a long description wraps its text instead of
    // pushing the mark onto a line of its own.
    expect(meta.className).toContain('flex')
    expect(meta.className).not.toContain('flex-wrap')
    expect(meta.querySelector('[data-brand-mark]')).toBeTruthy()
    expect(meta.textContent).toBe('Good for hard tasks')
    expect(meta.textContent).not.toMatch(/Atum|Cloud|Default/u)
  })

  it('filters the flat list from one provider rail item to another', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')

    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, GPT6_ROUTE, SOL_ROUTE])

    fireEvent.click(rail(card, 'openrouter'))
    expect(rail(card, 'openrouter').getAttribute('aria-pressed')).toBe('true')
    expect(rowIds(card)).toEqual([OPENROUTER_ROUTE])
    expect(card.querySelector('[data-matrix-model-section-header]')).toBeNull()
  })

  it('persists favorites and shows them from the star rail', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    let card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    fireEvent.click(favorite(card, GPT6_ROUTE))
    expect(favorites()).toEqual([GPT6_ROUTE])
    fireEvent.click(rail(card, 'favorites'))
    expect(rowIds(card)).toEqual([GPT6_ROUTE])
    expect(favorite(card, GPT6_ROUTE).getAttribute('aria-pressed')).toBe('true')

    cleanup()
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'favorites')).toBeTruthy())
    fireEvent.click(rail(card, 'favorites'))
    expect(rowIds(card)).toEqual([GPT6_ROUTE])
  })

  it('keeps the coming-soon row unselectable in the plain menu', async () => {
    const command = vi.fn(async () => null)
    picker(ROOM, { bridge: { command } })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(row(card, THAI_CUC_ROUTE).disabled).toBe(true)
    fireEvent.click(row(card, THAI_CUC_ROUTE))
    expect(command).not.toHaveBeenCalled()
  })

  it('searches the selected family live', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    fireEvent.change(search(card), { target: { value: 'sol' } })
    expect(rowIds(card)).toEqual([SOL_ROUTE])
    fireEvent.change(search(card), { target: { value: 'khong co' } })
    expect(rows(card)).toHaveLength(0)
    expect(within(card).getByText('No models match this search.')).toBeTruthy()
  })

  it('uses Command+1…9 to choose the corresponding visible row', async () => {
    const bridge = plan()
    picker(ROOM, { managed: false, connected: CHATGPT, bridge })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    fireEvent.keyDown(card, { key: '2', metaKey: true })
    expect(bridge.selectModelRoute).toHaveBeenCalledWith(ROOM.id, GPT6_ROUTE, 'agent_default')
    expect(await screen.findByRole('button', { name: 'Model: ChatGPT · GPT-6 Luna' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)
    expect(row(card, GPT6_ROUTE).getAttribute('aria-current')).toBe('true')
  })

  it('keeps a coming-soon shortcut inert', async () => {
    const command = vi.fn(async () => null)
    picker(ROOM, { bridge: { command } })
    const card = await open('Model: Nguyệt Thực 1.3')

    fireEvent.click(row(card, THAI_CUC_ROUTE))
    fireEvent.keyDown(card, { key: '3', metaKey: true })
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
  })

  it('puts Connect at the end of the rail and opens account subscriptions', async () => {
    const onAdvanced = vi.fn()
    const onSubscriptions = vi.fn()
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan(), onAdvanced, onSubscriptions })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    const connect = await waitFor(() => card.querySelector<HTMLButtonElement>('[data-matrix-model-connect]')!)

    expect(connect).toBeTruthy()
    fireEvent.click(connect)
    expect(onSubscriptions).toHaveBeenCalledOnce()
    expect(onAdvanced).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('lists Atum’s models for a Mac assistant on its own connection; one click switches back AND picks the model', async () => {
    const order: string[] = []
    const command = vi.fn(async (input: unknown) => {
      order.push(`setModel:${(input as { model?: string }).model}`)

      return { status: 'applied' as const }
    })
    let view: ReturnType<typeof picker> | undefined
    const useAtumModel = vi.fn(async () => {
      order.push('useAtumModel')
      // As main does: the assistant is back on Atum's AI, so its projection changes under the card.
      view!.rerender(ROOM, { managed: true, connected: undefined })

      return { state: 'ready' as const }
    })
    const onBackToAtum = vi.fn()

    view = picker(ROOM, { managed: false, connected: CHATGPT, bridge: { ...plan(), command, useAtumModel }, onBackToAtum })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    // It opens on the connection that answers; Atum's rail lists the line-up, with no extra step.
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rail(card, 'atum'))
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(row(card, THAI_CUC_ROUTE).disabled).toBe(true)
    expect(within(card).queryByRole('button', { name: 'Switch back to Atum’s AI' })).toBeNull()
    expect(card.querySelector('[data-matrix-model-back-to-atum]')).toBeNull()
    expect(card.querySelectorAll('[data-matrix-model-check]')).toHaveLength(0)

    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'nhat-thuc' }))
    // Both writes, in order: the provider switch, then the model.
    expect(order).toEqual(['useAtumModel', 'setModel:nhat-thuc'])
    expect(onBackToAtum).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    expect(row(card, NHAT_THUC_ROUTE).querySelector('[data-matrix-model-check]')).toBeTruthy()
  })

  it('says in place when another Mac assistant on its own connection cannot take an Atum model', async () => {
    const command = vi.fn(async () => {
      throw new Error('matrix_model_choice_unavailable')
    })
    const { fail } = picker(ROOM, { managed: false, connected: CHATGPT, bridge: { ...plan(), command } })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'atum')).toBeTruthy())
    fireEvent.click(rail(card, 'atum'))
    fireEvent.click(row(card, NGUYET_THUC_ROUTE))

    await waitFor(() =>
      expect(card.querySelector('[data-matrix-model-problem]')?.textContent).toBe(
        'Couldn’t choose this model for this assistant right now.'
      )
    )
    expect(fail).not.toHaveBeenCalled()
    // Nothing changed: the chip still names the connection.
    expect(screen.getByRole('button', { name: 'Model: ChatGPT · GPT-5.6 Luna' })).toBeTruthy()
  })

  it('puts a check on the saved row only, in every provider’s list', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    const checked = () =>
      [...card.querySelectorAll('[data-matrix-model-check]')].map(each =>
        each.closest('[data-matrix-model-route]')?.getAttribute('data-matrix-model-route')
      )

    expect(checked()).toEqual([CHATGPT_ROUTE])
    fireEvent.click(rail(card, 'atum'))
    expect(checked()).toEqual([])
    fireEvent.click(rail(card, 'favorites'))
    expect(checked()).toEqual([])
  })

  it('selects a local connected route through the existing native contract and updates the chip immediately', async () => {
    const selectedRoute = deferred<MatrixModelRouteSelection>()
    const selectModelRoute = vi.fn(() => selectedRoute.promise)
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan({ select: selectModelRoute }) })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    fireEvent.click(row(card, GPT6_ROUTE))
    expect(selectModelRoute).toHaveBeenCalledWith(ROOM.id, GPT6_ROUTE, 'agent_default')
    expect(screen.getByRole('button', { name: 'Model: ChatGPT · GPT-6 Luna' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)
    expect(row(card, GPT6_ROUTE).getAttribute('aria-current')).toBe('true')

    await act(async () => selectedRoute.resolve({ status: 'applied', current: GPT6_ROUTE }))
  })

  it('does not expose this Mac’s private providers while a legacy cloud agent answers in the cloud', async () => {
    const bridge = plan()
    const command = vi.fn(async () => ({ status: 'applied' as const }))
    picker(ROOM, {
      managed: true,
      cloud: true,
      local: true,
      here: 'cloud',
      cloudChoice: { offered: ['default', 'nhat-thuc'], current: 'default' },
      connected: CHATGPT,
      bridge: { ...bridge, command }
    })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rail(card, 'openai-codex')).toBeFalsy()
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(selected(card)).toHaveLength(1)
    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'nhat-thuc' })
    expect(bridge.selectModelRoute).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
  })

  it('changes a cloud agent’s current-home model through agentHome, with one selection and a matching chip', async () => {
    const model = vi.fn(async () => ({ status: 'saved' as const }))
    const bridge = homeBridge(model)

    const view = picker(ROOM, {
      agentPrincipal: 'agent-luna',
      home: cloudHome(),
      managed: true,
      cloud: true,
      local: true,
      here: 'cloud',
      connected: CHATGPT,
      bridge: { agentHome: bridge }
    })

    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rail(card, 'openai-codex')).toBeFalsy()
    expect(selected(card)).toHaveLength(1)
    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    expect(model).toHaveBeenCalledWith('agent-luna', expect.objectContaining({ model: 'nhat-thuc' }))
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)
    expect(row(card, NHAT_THUC_ROUTE).getAttribute('aria-current')).toBe('true')

    view.rerender(ROOM, { home: cloudHome(CLOUD_NHAT) })
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)
  })

  it('uses the same current-home contract for a Mac and never shows the cloud’s second selection', async () => {
    const model = vi.fn(async () => ({ status: 'saved' as const }))
    picker(ROOM, {
      agentPrincipal: 'agent-luna',
      home: macHome(),
      managed: true,
      cloud: true,
      local: true,
      here: 'this_mac',
      connected: CHATGPT,
      bridge: { agentHome: homeBridge(model) }
    })
    const card = await open('Model: GPT-5.6 Luna')

    expect(rail(card, 'atum')).toBeTruthy()
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    expect(selected(card)).toHaveLength(1)
    fireEvent.click(rail(card, 'openrouter'))
    fireEvent.click(row(card, OPENROUTER_ROUTE))
    expect(model).toHaveBeenCalledWith('agent-luna', expect.objectContaining({ model: 'other/model' }))
    expect(screen.getByRole('button', { name: 'Model: Other Model' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)
  })

  it('rolls a refused current-home write back and offers one short retry line', async () => {
    const model = vi
      .fn<MatrixAgentHomeBridge['model']>()
      .mockResolvedValueOnce({ status: 'refused', reason: 'stale' })
      .mockResolvedValueOnce({ status: 'saved' })

    picker(ROOM, {
      agentPrincipal: 'agent-luna',
      home: cloudHome(),
      managed: true,
      cloud: true,
      here: 'cloud',
      bridge: { agentHome: homeBridge(model) }
    })
    const card = await open('Model: Nguyệt Thực 1.3')

    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    expect((await within(card).findByRole('alert')).textContent).toContain('Couldn’t change the model. Try again')
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
    expect(selected(card)).toHaveLength(1)

    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
    expect(model).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
  })

  it('keeps providers with the same model identity distinct in the rail', async () => {
    const same = 'same-model'
    const first = matrixModelRouteId('openai-codex', same)
    const second = matrixModelRouteId('openrouter', same)

    const catalog: MatrixModelCatalog = {
      ...CATALOG,
      current: first,
      routes: [
        route(first, 'openai-codex', same, 'ChatGPT', 'ChatGPT Plan', { current: true }),
        route(second, 'openrouter', same, 'OpenRouter', 'API key', { connection: 'key' })
      ],
      accounts: [
        account('openai-codex', 'ChatGPT', 'ChatGPT Plan'),
        account('openrouter', 'OpenRouter', 'API key', { connection: 'key' })
      ]
    }

    const bridge = plan({ catalog })
    picker(ROOM, { managed: false, connected: { provider: 'openai-codex', model: same }, bridge })
    const card = await open('Model: ChatGPT · Same Model')
    await waitFor(() => expect(rail(card, 'openrouter')).toBeTruthy())

    expect(rowIds(card)).toEqual([first])
    fireEvent.click(rail(card, 'openrouter'))
    expect(rowIds(card)).toEqual([second])
    fireEvent.click(row(card, second))
    expect(bridge.selectModelRoute).toHaveBeenCalledWith(ROOM.id, second, 'agent_default')
  })

  it('shows a signed-out provider in the rail and leaves recovery to the Connect item', async () => {
    const catalog: MatrixModelCatalog = {
      ...CATALOG,
      current: undefined,
      routes: [],
      accounts: [account('openai-codex', 'ChatGPT', 'ChatGPT Plan', { ready: false, models: 3 })]
    }

    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan({ catalog }) })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')

    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    expect(rail(card, 'openai-codex').className).toMatch(/opacity-45/)
    expect(within(card).getByText('Sign in again for ChatGPT plan in Connections.')).toBeTruthy()
    expect(card.querySelector('[data-matrix-model-connect]')).toBeTruthy()
  })

  it('keeps the existing thinking-level behavior without moving search back to the footer', async () => {
    picker(
      { ...ROOM, effort: 'high' },
      {
        managed: false,
        connected: CHATGPT,
        bridge: plan()
      }
    )
    const card = await open('Model: ChatGPT · GPT-5.6 Luna · Thorough')

    await waitFor(() => expect(within(card).getByRole('slider', { name: 'Thinking' })).toBeTruthy())
    expect(card.querySelector('[data-matrix-model-search]')).toBeTruthy()
    expect(card.querySelector('[data-matrix-model-bar]')).toBeNull()
  })

  it('keeps the current name and Connect affordance on an older build without a native catalog', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')

    // No native catalog: the chip keeps the connection's name, Atum's line-up stays choosable,
    // and Connect stays in the rail.
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(selected(card)).toHaveLength(0)
    expect(card.querySelector('[data-matrix-model-connect]')).toBeTruthy()
  })

  it('retires an in-flight local pick when the card closes', async () => {
    const selectedRoute = deferred<MatrixModelRouteSelection>()
    const selectModelRoute = vi.fn(() => selectedRoute.promise)
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan({ select: selectModelRoute }) })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))
    fireEvent.click(row(card, GPT6_ROUTE))
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await act(async () => selectedRoute.resolve({ status: 'applied', current: GPT6_ROUTE }))
    expect(screen.getByRole('button', { name: 'Model: ChatGPT · GPT-5.6 Luna' })).toBeTruthy()
    expect(readMatrixModelPickerPreferences(window.localStorage, ROOM.id).recent).toEqual([])
  })

  it('starts each open on the current model’s rail and clears the old search', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    let card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))
    fireEvent.click(rail(card, 'openrouter'))
    fireEvent.change(search(card), { target: { value: 'other' } })
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    expect((search(card) as HTMLInputElement).value).toBe('')
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, GPT6_ROUTE, SOL_ROUTE])
  })

  it('reads favorites from the requested account scope instead of leaking another account', async () => {
    star(SOL_ROUTE)
    writeMatrixModelPickerPreferences(window.localStorage, 'account:b', {
      favorites: [GPT6_ROUTE],
      recent: []
    })
    picker(ROOM, {
      managed: false,
      connected: CHATGPT,
      preferenceScope: 'account:b',
      bridge: plan()
    })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'favorites')).toBeTruthy())
    fireEvent.click(rail(card, 'favorites'))
    expect(rowIds(card)).toEqual([GPT6_ROUTE])
  })
})

describe('account subscriptions in the model picker', () => {
  interface SubscriptionState {
    chatgpt?: string[] | false
    opencode?: string[] | false
    /** A saved ChatGPT sign-in that stopped working. */
    chatgptSignedOut?: boolean
  }

  const subscriptionsBridge = ({ chatgpt = false, opencode = false, chatgptSignedOut = false }: SubscriptionState) => {
    const providers = [
      chatgptSignedOut
        ? { id: 'openai-codex' as const, connected: false, needsSignIn: true }
        : chatgpt
        ? {
            id: 'openai-codex' as const,
            connected: true,
            models: chatgpt,
            relay: { state: 'enabled' as const, thisMac: true, revision: 1 }
          }
        : { id: 'openai-codex' as const, connected: false },
      opencode
        ? { id: 'opencode-go' as const, connected: true, models: opencode }
        : { id: 'opencode-go' as const, connected: false }
    ]

    return {
      catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers })),
      status: vi.fn(async () => ({
        scope: 'account' as const,
        providers
      })),
      startChatGpt: vi.fn(async () => ({
        status: 'pending' as const,
        session: 'opaque-session',
        provider: 'openai-codex' as const,
        userCode: 'CODE-123',
        url: 'https://auth.openai.com/codex/device',
        expiresIn: 900,
        pollInterval: 3600
      })),
      pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
      cancelChatGpt: vi.fn(async () => undefined),
      disconnectChatGpt: vi.fn(async () => undefined),
      useThisMacForChatGpt: vi.fn(async () => ({ status: 'applied' as const })),
      connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
      disconnectOpenCode: vi.fn(async () => undefined)
    }
  }

  it('separates providers: Atum’s models first, each plan under its own rail icon, ⌘ numbers per list', async () => {
    const subscriptions = subscriptionsBridge({
      chatgpt: ['gpt-5.6-luna', 'gpt-6-sol'],
      opencode: ['kimi-k3', 'glm-5.3', 'minimax-m3']
    })

    const selectModelRoute = vi.fn(async (_roomId: string, routeId: string) => ({
      status: 'applied' as const,
      current: routeId
    }))

    picker(ROOM, {
      bridge: { selectModelRoute, subscriptions },
      local: true,
      managed: true
    })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'opencode-go')).toBeTruthy())

    // The card opens on the provider of the model that answers now, and shows only its models.
    expect(rail(card, 'atum').getAttribute('aria-pressed')).toBe('true')
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(card.querySelector('[data-matrix-model-group]')).toBeNull()

    const chatGptRail = rail(card, 'openai-codex')
    const openCodeRail = rail(card, 'opencode-go')
    expect(chatGptRail.querySelector('[data-provider-mark="openai"]')).toBeTruthy()
    expect(openCodeRail.querySelector('[data-provider-mark="opencode"]')).toBeTruthy()
    expect(chatGptRail.className).not.toMatch(/opacity-45/u)

    fireEvent.click(chatGptRail)
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, SOL_ROUTE])
    expect(rows(card).map(each => each.getAttribute('aria-keyshortcuts'))).toEqual(['Meta+1', 'Meta+2'])
    expect(row(card, CHATGPT_ROUTE).textContent).toContain('GPT-5.6 Luna')
    expect(row(card, SOL_ROUTE).textContent).toContain('GPT-6 Sol')
    expect(within(card).queryByText('Plan')).toBeNull()

    fireEvent.click(openCodeRail)
    expect(rowIds(card)).toEqual([KIMI_ROUTE, GLM_ROUTE, MINIMAX_ROUTE])
    expect(row(card, KIMI_ROUTE).textContent).toContain('Kimi K3')
    expect(row(card, MINIMAX_ROUTE).textContent).toContain('MiniMax M3')

    fireEvent.click(chatGptRail)
    fireEvent.keyDown(card, { key: '1', metaKey: true })
    await waitFor(() => expect(selectModelRoute).toHaveBeenCalledWith(ROOM.id, CHATGPT_ROUTE, 'agent_default'))
  })

  it('lists a connected ChatGPT plan under its own rail icon, with no rows at the foot of any list', async () => {
    const subscriptions = subscriptionsBridge({ chatgpt: ['gpt-5.6-luna'], opencode: false })
    const onSubscriptions = vi.fn()

    picker(ROOM, { bridge: { subscriptions }, local: true, managed: true, onSubscriptions })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    // OpenCode Go was never linked: no rail entry; connecting goes through the rail's Connect.
    expect(rail(card, 'opencode-go')).toBeFalsy()
    fireEvent.click(rail(card, 'openai-codex'))
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE])
    expect(card.querySelector('[data-matrix-model-list] [data-matrix-model-connect]')).toBeNull()
    expect(within(card).queryByText(/Use your ChatGPT|Connect OpenCode|Open ChatGPT in Settings|Reconnect/)).toBeNull()
  })

  it('stars models across providers, keeps each row’s provider mark in Favorites, and searches within a provider', async () => {
    const subscriptions = subscriptionsBridge({ chatgpt: ['gpt-5.6-luna', 'gpt-6-sol'] })

    const selectModelRoute = vi.fn(async (_roomId: string, routeId: string) => ({
      status: 'applied' as const,
      current: routeId
    }))

    picker(ROOM, { bridge: { selectModelRoute, subscriptions }, local: true, managed: true, onSubscriptions: vi.fn() })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    fireEvent.click(favorite(card, NHAT_THUC_ROUTE))
    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.click(favorite(card, SOL_ROUTE))
    expect(favorites()).toEqual([SOL_ROUTE, NHAT_THUC_ROUTE])

    fireEvent.click(rail(card, 'favorites'))
    // Atum's own stars lead, as in every list; each row keeps its provider's mark.
    expect(rowIds(card)).toEqual([NHAT_THUC_ROUTE, SOL_ROUTE])
    expect(row(card, SOL_ROUTE).querySelector('[data-provider-mark="openai"]')).toBeTruthy()
    expect(row(card, NHAT_THUC_ROUTE).querySelector('[data-matrix-model-atum-meta]')).toBeTruthy()

    // Search stays inside the selected provider.
    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.change(search(card), { target: { value: 'sol' } })
    expect(rowIds(card)).toEqual([SOL_ROUTE])
    fireEvent.change(search(card), { target: { value: 'Nhật' } })
    expect(rowIds(card)).toEqual([])

    fireEvent.change(search(card), { target: { value: '' } })
    fireEvent.click(row(card, SOL_ROUTE))
    await waitFor(() => expect(selectModelRoute).toHaveBeenCalledWith(ROOM.id, SOL_ROUTE, 'agent_default'))
  })

  it('says in ChatGPT’s own list that it needs a new sign-in, with no Reconnect row; the rail’s Connect is the fix', async () => {
    const subscriptions = subscriptionsBridge({ chatgptSignedOut: true })
    const onSubscriptions = vi.fn()

    picker(ROOM, { bridge: { subscriptions }, local: true, managed: true, onSubscriptions })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    // Atum's own models stay choosable, and Atum's list carries no ChatGPT note.
    expect(row(card, NHAT_THUC_ROUTE).disabled).toBe(false)
    expect(card.querySelector('[data-matrix-model-note]')).toBeNull()
    expect(rail(card, 'openai-codex').className).toMatch(/opacity-45/u)

    fireEvent.click(rail(card, 'openai-codex'))
    expect(card.querySelector('[data-matrix-model-note]')!.textContent).toBe('ChatGPT needs you to sign in again.')
    expect(within(card).queryByText('Reconnect ChatGPT')).toBeNull()

    // Connect opens the service chooser in place; ChatGPT there starts its sign-in.
    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail] [data-matrix-model-connect]')!)
    const chooser = await screen.findByRole('dialog', { name: 'Your subscription' })
    expect(within(chooser).getByRole('button', { name: /ChatGPT.*needs you to sign in again/ })).toBeTruthy()
    fireEvent.click(chooser.querySelector<HTMLButtonElement>('[data-matrix-subscription-choice="openai-codex"]')!)
    await waitFor(() => expect(screen.getByText('CODE-123')).toBeTruthy())
    expect(subscriptions.startChatGpt).toHaveBeenCalledOnce()
    expect(onSubscriptions).not.toHaveBeenCalled()
  })

  it('shows no rail entry or row for a plan never linked; the rail’s Connect opens the chooser for every service', async () => {
    const subscriptions = subscriptionsBridge({})
    const onSubscriptions = vi.fn()

    picker(ROOM, { bridge: { subscriptions }, local: true, managed: true, onSubscriptions })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(subscriptions.catalog).toHaveBeenCalled())

    expect(rail(card, 'openai-codex')).toBeFalsy()
    expect(rail(card, 'opencode-go')).toBeFalsy()
    expect(card.querySelector('[data-matrix-model-list] [data-matrix-model-connect]')).toBeNull()
    expect(within(card).queryByText(/Use your ChatGPT|Connect OpenCode|Use your ChatGPT or OpenCode plan/)).toBeNull()

    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail] [data-matrix-model-connect]')!)
    const chooser = within(await screen.findByRole('dialog', { name: 'Your subscription' }))
    expect(chooser.getByRole('button', { name: /ChatGPT/ })).toBeTruthy()
    expect(chooser.getByRole('button', { name: /OpenCode Go/ })).toBeTruthy()

    fireEvent.click(chooser.getByRole('button', { name: /OpenCode Go/ }))
    expect(await screen.findByLabelText('OpenCode Go key')).toBeTruthy()
    expect(subscriptions.startChatGpt).not.toHaveBeenCalled()
    expect(onSubscriptions).not.toHaveBeenCalled()
  })

  it('enables the selected relay Mac’s ChatGPT models for a cloud-hosted agent', async () => {
    const subscriptions = subscriptionsBridge({ chatgpt: ['gpt-5.6-luna'], opencode: false })
    picker(ROOM, { bridge: { subscriptions }, cloud: true, local: true, managed: true })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    fireEvent.click(rail(card, 'openai-codex'))

    expect(card.querySelector('[data-matrix-model-reason]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-connect-kind="settings"]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-list] [data-matrix-model-connect]')).toBeNull()

    const chatgpt = row(card, CHATGPT_ROUTE)
    expect(chatgpt.disabled).toBe(false)
    expect(chatgpt.textContent).toBe('GPT-5.6 LunaChatGPT')
    expect(rows(card).some(each => each.textContent?.includes('OpenCode Go'))).toBe(false)
  })

  it('writes a cloud agent’s ChatGPT pick from ChatGPT’s own list', async () => {
    const subscriptions = subscriptionsBridge({ chatgpt: ['gpt-5.6-luna'] })
    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))
    const agentPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'

    picker(ROOM, {
      agentPrincipal,
      bridge: {
        subscriptions,
        modelDestinations: {
          read: vi.fn(async () => undefined),
          write: vi.fn(async () => ({ status: 'saved' as const })),
          writeSubscription,
          cap: vi.fn(async () => ({ status: 'saved' as const }))
        }
      },
      cloud: true,
      local: true,
      managed: true
    })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))

    fireEvent.click(row(card, CHATGPT_ROUTE))
    await waitFor(() =>
      expect(writeSubscription).toHaveBeenCalledWith(agentPrincipal, 'chatgpt_plan', 'gpt-5.6-luna', 'medium')
    )
  })

  it('keeps ChatGPT’s rail and models after a ChatGPT pick, checks it, then writes and shows an Atum pick (owner 11-08)', async () => {
    const subscriptions = subscriptionsBridge({ chatgpt: ['gpt-5.6-luna', 'gpt-6-sol'] })
    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))
    const command = vi.fn(async () => ({ status: 'applied' as const }))
    const agentPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'
    const bridge = {
      command,
      subscriptions,
      modelDestinations: {
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => ({ status: 'saved' as const })),
        writeSubscription,
        cap: vi.fn(async () => ({ status: 'saved' as const }))
      }
    }
    const atumOnly: MatrixCloudModelChoiceView = { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' }

    const view = picker(ROOM, { agentPrincipal, bridge, cloud: true, cloudChoice: atumOnly, local: true, managed: true })

    let card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.click(row(card, SOL_ROUTE))
    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(agentPrincipal, 'chatgpt_plan', 'gpt-6-sol', 'medium'))

    // The snapshot now says ChatGPT · GPT-6 Sol is the saved cloud choice; the 1.1 row still
    // carries Atum's alias underneath, which is NOT a saved Atum choice.
    const chatgptSaved: MatrixCloudModelChoiceView = {
      ...atumOnly,
      subscription: { source: 'chatgpt_plan', model: 'gpt-6-sol', effort: 'medium', displayName: 'GPT-6 Sol' },
      subscriptionState: 'connected'
    }
    view.rerender(ROOM, { cloudChoice: chatgptSaved })

    // Rail and list stay; the chosen model is checked; nothing says "no models".
    await waitFor(() => expect(rowIds(card)).toEqual([CHATGPT_ROUTE, SOL_ROUTE]))
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    expect(row(card, SOL_ROUTE).getAttribute('aria-current')).toBe('true')
    expect(within(card).queryByText(/No models are available/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Model: GPT-6 Sol' })).toBeTruthy()

    // Back to Nguyệt Thực: the click writes even though the 1.1 alias already says nguyet-thuc.
    fireEvent.click(rail(card, 'atum'))
    expect(row(card, NGUYET_THUC_ROUTE).getAttribute('aria-current')).toBeNull()
    fireEvent.click(row(card, NGUYET_THUC_ROUTE))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'nguyet-thuc' }))

    // The label and the check flip at once and agree.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy())
    expect(row(card, NGUYET_THUC_ROUTE).getAttribute('aria-current')).toBe('true')
    fireEvent.click(rail(card, 'openai-codex'))
    expect(row(card, SOL_ROUTE).getAttribute('aria-current')).toBeNull()

    // The snapshot catches up (plan choice gone): still Nguyệt Thực, still one check.
    view.rerender(ROOM, { cloudChoice: atumOnly })
    card = screen.getByRole('dialog', { name: 'Model' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy())
    expect(selected(card).length).toBeLessThanOrEqual(1)
  })

  it('takes an assistant on this Mac from its ChatGPT connection back to an Atum model in one click', async () => {
    const order: string[] = []
    const command = vi.fn(async (input: unknown) => {
      order.push(`command:${(input as { model?: string }).model}`)

      return { status: 'applied' as const }
    })
    const useAtumModel = vi.fn(async () => {
      order.push('useAtumModel')

      return { state: 'ready' as const }
    })

    picker(ROOM, {
      bridge: { ...plan(), command, useAtumModel },
      connected: CHATGPT,
      local: true,
      managed: true,
      onBackToAtum: vi.fn()
    })

    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'atum')).toBeTruthy())
    fireEvent.click(rail(card, 'atum'))
    // The chip says ChatGPT, so no Atum row is checked.
    expect(selected(card)).toHaveLength(0)

    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'nhat-thuc' }))
    expect(order).toEqual(['useAtumModel', 'command:nhat-thuc'])

    // Label and check agree at once.
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    expect(row(card, NHAT_THUC_ROUTE).getAttribute('aria-current')).toBe('true')
  })

  it('is a no-op only when the clicked Atum model is the SAVED cloud choice', async () => {
    const command = vi.fn(async () => ({ status: 'applied' as const }))

    picker(ROOM, {
      bridge: { command },
      cloud: true,
      cloudChoice: { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' },
      managed: true
    })

    const card = await open('Model: Nguyệt Thực 1.3')
    fireEvent.click(row(card, NGUYET_THUC_ROUTE))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'setModel' }))

    fireEvent.click(row(card, NHAT_THUC_ROUTE))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'nhat-thuc' }))
  })

  it('shows a cloud agent the this-Mac ChatGPT models greyed with the reason, and nothing else in that list', async () => {
    const subscriptions = {
      ...subscriptionsBridge({}),
      status: vi.fn(async () => ({
        scope: 'account' as const,
        providers: [
          {
            id: 'openai-codex' as const,
            connected: true,
            localConnected: true,
            models: ['gpt-5.6-luna', 'gpt-6-sol'],
            relay: { state: 'disabled' as const, thisMac: false, revision: 2 }
          },
          { id: 'opencode-go' as const, connected: false }
        ]
      }))
    }
    const onSubscriptions = vi.fn()

    picker(ROOM, { bridge: { subscriptions }, cloud: true, local: true, managed: true, onSubscriptions })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    // Opens on Atum, the provider that answers now; ChatGPT's entry is quiet until it is ready.
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(rail(card, 'openai-codex').className).toMatch(/opacity-45/u)

    fireEvent.click(rail(card, 'openai-codex'))
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, SOL_ROUTE])

    for (const id of [CHATGPT_ROUTE, SOL_ROUTE]) {
      expect(row(card, id).disabled).toBe(true)
      expect(row(card, id).textContent).toContain('Not ready for your assistants yet')
      expect(row(card, id).parentElement!.querySelector('[data-matrix-model-favorite]')).toBeNull()
    }

    expect(card.querySelector('[data-matrix-model-list] [data-matrix-model-connect]')).toBeNull()
    expect(within(card).queryByText(/Open ChatGPT in Settings|Use your ChatGPT/)).toBeNull()
    expect(subscriptions.startChatGpt).not.toHaveBeenCalled()
  })

  it('hides API-key rows for a cloud assistant while the dormant picker still lists them with the switch off', async () => {
    const options: PickerOptions = {
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      bridge: { agentHome: homeBridge() },
      cloud: true,
      home: cloudHome(HOME_OPENROUTER),
      managed: true
    }

    picker(ROOM, options)
    let card = await open(/Model:/)
    expect(card.querySelector(`[data-matrix-model-route="${OPENROUTER_ROUTE}"]`)).toBeNull()
    expect(card.querySelector('[data-matrix-model-rail-item="openrouter"]')).toBeNull()

    cleanup()
    picker(ROOM, { ...options, cloudOnly: false })
    card = await open(/Model:/)
    expect(row(card, OPENROUTER_ROUTE)).toBeTruthy()
  })

  it('labels a cloud current-model fallback as Cloud, never This Mac', async () => {
    picker(ROOM, { cloud: true, connected: CHATGPT, managed: false, onSubscriptions: null })
    const card = await open(/Model:/)
    const current = card.querySelector<HTMLElement>('[data-matrix-model-current]')!

    expect(current.textContent).toContain('Cloud')
    expect(current.textContent).not.toContain('This Mac')
  })

  it('says ChatGPT is not ready for a cloud agent when no model names are known yet, never a fake model', async () => {
    const subscriptions = {
      ...subscriptionsBridge({}),
      status: vi.fn(async () => ({
        scope: 'account' as const,
        providers: [
          {
            id: 'openai-codex' as const,
            connected: false,
            localConnected: true,
            relay: { state: 'disabled' as const, thisMac: false, revision: 2 }
          },
          { id: 'opencode-go' as const, connected: false }
        ]
      }))
    }
    const staleChatGpt = { ...HOME_GPT, available: false }

    picker(ROOM, {
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      bridge: { agentHome: homeBridge(), subscriptions },
      cloud: true,
      home: cloudHome(staleChatGpt),
      local: true,
      managed: true
    })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    // The stale home model is ChatGPT's, so the card opens on ChatGPT: one note, no fake model.
    await waitFor(() => expect(within(card).getByText('Not ready for your assistants yet')).toBeTruthy())
    expect(rowIds(card)).toEqual([])
    fireEvent.click(rail(card, 'atum'))
    expect(card.querySelector('[data-matrix-model-route*="gpt-5.6-luna"]')).toBeNull()
    expect(rail(card, 'openai-codex').className).toMatch(/opacity-45/u)
  })

  const OPENCODE_MODELS = [
    {
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      efforts: ['low', 'medium', 'high'] as const,
      defaultEffort: 'high' as const
    },
    { id: 'kimi-k3', displayName: 'Kimi K3', efforts: [] as const, defaultEffort: 'medium' as const }
  ]

  const cloudSubscriptions = (connected: boolean) => ({
    ...subscriptionsBridge({}),
    status: vi.fn(async () => ({
      scope: 'account' as const,
      providers: [
        { id: 'openai-codex' as const, connected: false },
        connected
          ? {
              id: 'opencode-go' as const,
              connected: true,
              source: 'platform' as const,
              revision: 1,
              models: OPENCODE_MODELS.map(model => model.id),
              modelDetails: OPENCODE_MODELS
            }
          : { id: 'opencode-go' as const, connected: false, source: 'platform' as const, revision: 2 }
      ]
    }))
  })

  it('offers a cloud agent the connected OpenCode Go models and writes atum.model-choice/1.4', async () => {
    const subscriptions = cloudSubscriptions(true)
    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))
    const agentPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'

    picker(ROOM, {
      agentPrincipal,
      cloud: true,
      local: true,
      managed: true,
      cloudChoice: {
        offered: ['nguyet-thuc'],
        subscription: { source: 'opencode_go', model: 'glm-5.2', effort: 'high', displayName: 'GLM-5.2' },
        subscriptionModels: OPENCODE_MODELS,
        subscriptionState: 'connected'
      },
      bridge: {
        subscriptions,
        modelDestinations: {
          read: vi.fn(async () => undefined),
          write: vi.fn(async () => ({ status: 'saved' as const })),
          writeSubscription,
          cap: vi.fn(async () => ({ status: 'saved' as const }))
        }
      }
    })

    const card = await open('Model: GLM-5.2')
    await waitFor(() => expect(rowIds(card)).toContain(GLM_CLOUD_ROUTE))

    expect(row(card, GLM_CLOUD_ROUTE).textContent).toContain('GLM-5.2')
    expect(row(card, GLM_CLOUD_ROUTE).textContent).toContain('OpenCode Go')
    expect(within(card).queryByText('Reconnect OpenCode Go')).toBeNull()

    fireEvent.click(row(card, KIMI_CLOUD_ROUTE))
    await waitFor(() =>
      expect(writeSubscription).toHaveBeenCalledWith(agentPrincipal, 'opencode_go', 'kimi-k3', 'medium')
    )
  })

  it('notes a revoked OpenCode Go cloud choice in its own list, with no Reconnect row, and never marks Atum current', async () => {
    const subscriptions = cloudSubscriptions(false)
    const onSubscriptions = vi.fn()

    picker(ROOM, {
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      cloud: true,
      local: true,
      managed: true,
      onSubscriptions,
      cloudChoice: {
        offered: ['nguyet-thuc'],
        subscription: { source: 'opencode_go', model: 'glm-5.2', effort: 'high', displayName: 'GLM-5.2' },
        subscriptionModels: OPENCODE_MODELS,
        subscriptionState: 'revoked'
      },
      bridge: { subscriptions }
    })

    const card = await open('Model: Reconnect OpenCode Go')
    await waitFor(() => expect(rail(card, 'opencode-go')).toBeTruthy())

    for (const atum of [NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE]) {
      expect(row(card, atum).getAttribute('aria-current')).toBeNull()
    }

    fireEvent.click(rail(card, 'opencode-go'))
    expect(rowIds(card)).not.toContain(GLM_CLOUD_ROUTE)
    expect(card.querySelector('[data-matrix-model-note]')!.textContent).toBe('This connection needs you to sign in again.')
    expect(within(card).queryByText('Reconnect OpenCode Go', { selector: '[data-matrix-model-list] *' })).toBeNull()
    expect(card.querySelector('[data-matrix-model-route][aria-current="true"]')).toBeNull()
  })

  it('finds subscription models by their display name and their id within their provider', async () => {
    const subscriptions = subscriptionsBridge({
      chatgpt: ['gpt-5.6-luna'],
      opencode: ['kimi-k3', 'glm-5.3']
    })

    picker(ROOM, { bridge: { subscriptions }, local: true, managed: true })

    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'opencode-go')).toBeTruthy())

    fireEvent.click(rail(card, 'opencode-go'))
    fireEvent.change(search(card), { target: { value: 'Kimi K3' } })
    expect(rowIds(card)).toEqual([KIMI_ROUTE])

    fireEvent.change(search(card), { target: { value: 'glm-5.3' } })
    expect(rowIds(card)).toEqual([GLM_ROUTE])

    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.change(search(card), { target: { value: 'gpt-5.6-luna' } })
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE])
  })

})

describe('a plan that cannot answer now (owner 2026-11-11)', () => {
  type Presence = 'online' | 'offline' | 'none' | undefined

  const relayAccount = (presence: Presence, state: 'enabled' | 'disabled' = 'enabled') => ({
    catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers: [] })),
    status: vi.fn(async () => ({
      scope: 'account' as const,
      providers: [
        {
          id: 'openai-codex' as const,
          connected: state === 'enabled',
          localConnected: false,
          models: ['gpt-5.6-luna', 'gpt-6-sol'],
          relay: { state, thisMac: false, revision: 4, ...(presence ? { presence } : {}) }
        },
        { id: 'opencode-go' as const, connected: false }
      ]
    })),
    startChatGpt: vi.fn(async () => ({ status: 'cancelled' as const })),
    pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
    cancelChatGpt: vi.fn(async () => undefined),
    disconnectChatGpt: vi.fn(async () => undefined),
    useThisMacForChatGpt: vi.fn(async () => ({ status: 'applied' as const })),
    connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
    disconnectOpenCode: vi.fn(async () => undefined)
  })

  const destinations = () => ({
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => ({ status: 'saved' as const })),
    writeSubscription: vi.fn(async () => ({ status: 'saved' as const })),
    cap: vi.fn(async () => ({ status: 'saved' as const }))
  })

  const atumChoice: MatrixCloudModelChoiceView = { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' }

  const solChoice = (extra: Partial<MatrixCloudModelChoiceView> = {}): MatrixCloudModelChoiceView => ({
    ...atumChoice,
    subscription: { source: 'chatgpt_plan', model: 'gpt-6-sol', effort: 'medium', displayName: 'GPT-6 Sol' },
    subscriptionState: 'connected',
    ...extra
  })

  const tip = async (element: HTMLElement) => {
    fireEvent.pointerMove(element, { pointerType: 'mouse' })

    return (await screen.findByRole('tooltip')).textContent ?? ''
  }

  const cloudPicker = (
    presence: Presence,
    options: Partial<PickerOptions> & { state?: 'enabled' | 'disabled' } = {}
  ) => {
    const subscriptions = relayAccount(presence, options.state)
    const modelDestinations = destinations()
    const command = vi.fn(async () => ({ status: 'applied' as const }))

    picker(ROOM, {
      agentPrincipal: '00000000-0000-4000-8000-bd7662a5eeb4',
      bridge: { command, subscriptions, modelDestinations },
      cloud: true,
      cloudChoice: atumChoice,
      local: true,
      managed: true,
      ...options
    })

    return { command, modelDestinations, subscriptions }
  }

  it('lists ChatGPT models as choosable while its Mac is online', async () => {
    cloudPicker('online')
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    expect(rail(card, 'openai-codex').className).not.toMatch(/opacity-45/u)
    fireEvent.click(rail(card, 'openai-codex'))
    expect(row(card, SOL_ROUTE).disabled).toBe(false)
    expect(row(card, SOL_ROUTE).textContent).not.toContain('offline')
  })

  it.each([
    ['en', 'Your Mac is offline', 'Open Atum on your Mac to use ChatGPT.'],
    ['vi', 'Máy Mac của bạn đang tắt', 'Mở Atum trên máy Mac để dùng ChatGPT.']
  ] as const)('greys ChatGPT out while its Mac is offline (%s): one line, one action in the tip', async (locale, line, action) => {
    const { modelDestinations } = cloudPicker('offline', { locale })
    const card = await open(/^(Model|Mô hình): Nguyệt Thực 1\.3$/)
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    expect(rail(card, 'openai-codex').className).toMatch(/opacity-45/u)
    fireEvent.click(rail(card, 'openai-codex'))
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, SOL_ROUTE])

    for (const id of [CHATGPT_ROUTE, SOL_ROUTE]) {
      expect(row(card, id).disabled).toBe(true)
      expect(row(card, id).textContent).toContain(line)
    }

    expect(await tip(row(card, SOL_ROUTE).parentElement!)).toContain(action)
    fireEvent.click(row(card, SOL_ROUTE))
    expect(modelDestinations.writeSubscription).not.toHaveBeenCalled()
  })

  it('says no Mac serves ChatGPT yet when none is registered', async () => {
    cloudPicker('none')
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))

    expect(row(card, SOL_ROUTE).disabled).toBe(true)
    expect(row(card, SOL_ROUTE).textContent).toContain('Not ready for your assistants yet')
    expect(await tip(row(card, SOL_ROUTE).parentElement!)).toContain(
      'Open Atum on the Mac where you signed in to ChatGPT.'
    )
  })

  it.each([
    ['en', 'Model: GPT-6 Sol · ChatGPT can’t answer: your Mac is offline', 'Model'],
    ['vi', 'Mô hình: GPT-6 Sol · ChatGPT chưa trả lời được: máy Mac của bạn đang tắt', 'Mô hình']
  ] as const)('marks the chip when the chosen ChatGPT model cannot answer (%s), and opens on what can', async (locale, name, dialog) => {
    const { command, modelDestinations } = cloudPicker('offline', {
      locale,
      cloudChoice: solChoice({ relayPresence: 'offline' })
    })

    const chip = screen.getByRole('button', { name })
    const warning = chip.querySelector<SVGElement>('[data-matrix-model-warning]')!

    expect(warning).toBeTruthy()
    expect(warning.getAttribute('style')).toContain('var(--ak-danger)')
    expect(chip.dataset.matrixModelUnavailable).toBe('mac_offline')
    // The person's pick stays the chip's name: nothing switches it.
    expect(chip.textContent).toContain('GPT-6 Sol')

    fireEvent.click(chip)
    const card = await screen.findByRole('dialog', { name: dialog })
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    expect(rail(card, 'atum').getAttribute('aria-pressed')).toBe('true')
    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(command).not.toHaveBeenCalled()
    expect(modelDestinations.write).not.toHaveBeenCalled()
    expect(modelDestinations.writeSubscription).not.toHaveBeenCalled()
  })

  it('keeps the chip plain while the chosen plan can answer, and for an Atum pick', () => {
    cloudPicker('online', { cloudChoice: solChoice({ relayPresence: 'online' }) })
    const chip = screen.getByRole('button', { name: 'Model: GPT-6 Sol' })
    expect(chip.querySelector('[data-matrix-model-warning]')).toBeNull()

    cleanup()
    cloudPicker('offline')
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' }).querySelector('[data-matrix-model-warning]')).toBeNull()
  })

  it('marks the chip as soon as the open card’s account read says the Mac is offline', async () => {
    cloudPicker('offline', { cloudChoice: solChoice() })
    fireEvent.click(screen.getByRole('button', { name: 'Model: GPT-6 Sol' }))

    const chip = await screen.findByRole('button', { name: 'Model: GPT-6 Sol · ChatGPT can’t answer: your Mac is offline' })
    expect(chip.querySelector('[data-matrix-model-warning]')).toBeTruthy()
  })

  it('never marks a chip that names another model the home answers with', () => {
    cloudPicker('offline', {
      bridge: { agentHome: homeBridge(), subscriptions: relayAccount('offline') },
      cloudChoice: solChoice({ relayPresence: 'offline' }),
      home: cloudHome(CLOUD_NGUYET)
    })

    const chip = screen.getByRole('button', { name: /^Model: Nguyệt Thực/u })
    expect(chip.querySelector('[data-matrix-model-warning]')).toBeNull()
  })

  it('marks a lapsed OpenCode Go pick the same way', () => {
    cloudPicker(undefined, {
      cloudChoice: {
        ...atumChoice,
        subscription: { source: 'opencode_go', model: 'kimi-k3', effort: 'medium', displayName: 'Kimi K3' },
        subscriptionState: 'revoked'
      }
    })

    // Its name already says the fix; the danger glyph marks it like any plan that cannot answer.
    const chip = screen.getByRole('button', { name: 'Model: Reconnect OpenCode Go' })
    expect(chip.dataset.matrixModelUnavailable).toBe('reconnect')
    expect(chip.querySelector('[data-matrix-model-warning]')).toBeTruthy()
  })
})
