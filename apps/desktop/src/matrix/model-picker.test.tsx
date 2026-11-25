import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $accountConnect, $accountConnections, resetAccountConnectionsForTest } from '@/app/connections/store'
import { $work, $workActive, resetWorkStoreForTests } from '@/app/work/store'
import { I18nProvider } from '@/i18n'

import ownerSnapshotFixture from '../../contracts/atum-agent-home-v2.5/fixtures/owner.placement.snapshot.json'
import { ownerHomeViewFor } from '../../electron/matrix/agent-home-placement/view'
import { ACCOUNT_CONNECTIONS_FIXTURE } from '../../shared/account-connections'
import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixRoom,
  MatrixSubscriptionsBridge,
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
import type { MatrixSubscriptionFallback } from '../../shared/matrix-subscription-fallback'
import type { MatrixChatGptTrainingStatus } from '../../shared/matrix-subscriptions'
import type { WorkAgentPlans } from '../../shared/matrix-work'

import { MatrixModelPicker, type MatrixModelPickerRelay } from './model-picker'
import { readMatrixModelPickerPreferences, writeMatrixModelPickerPreferences } from './model-picker-preferences'

beforeEach(() => {
  resetAccountConnectionsForTest()
  resetWorkStoreForTests()
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
  connectionRef: 'conn_atummanaged000001',
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
  lastFallback?: MatrixSubscriptionFallback
  workRelay?: readonly MatrixModelPickerRelay[]
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
        lastFallback={current.lastFallback}
        local={current.local ?? !(current.managed ?? true)}
        managed={current.managed ?? true}
        onAdvanced={onAdvanced ?? undefined}
        onBackToAtum={current.onBackToAtum}
        onSubscriptions={onSubscriptions ?? undefined}
        preferenceScope={current.preferenceScope}
        room={nextRoom}
        workRelay={current.workRelay}
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

  it('keeps the rail and search, and shows each row’s shortcut beside it, once more than Atum is connected', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')

    await waitFor(() => expect(rows(card)).toHaveLength(3))
    expect(card.querySelector('[data-matrix-model-menu]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-rail]')).toBeTruthy()
    expect(card.querySelector('[data-matrix-model-connect]')).toBeTruthy()
    expect(search(card)).toBeTruthy()
    expect(rows(card).map(each => each.getAttribute('aria-keyshortcuts'))).toEqual(['Meta+1', 'Meta+2', 'Meta+3'])
    // As in T3 Code, the shortcut sits on the row itself.
    expect(rows(card).map(each => each.parentElement?.querySelector('[data-matrix-model-shortcut]')?.textContent)).toEqual([
      '⌘1',
      '⌘2',
      '⌘3'
    ])

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

  it('draws Atum’s mark before the name and its description after it, on one line', async () => {
    picker(ROOM, { managed: true, connected: CHATGPT, bridge: plan(), local: true })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rail(card, 'atum')).toBeTruthy())
    // It answers with its ChatGPT connection, so the card opens there, as the chip says.
    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(rail(card, 'atum'))
    expect(selected(card)).toHaveLength(0)
    const nhat = row(card, NHAT_THUC_ROUTE)
    const meta = nhat.querySelector<HTMLElement>('[data-matrix-model-atum-meta]')!
    const name = nhat.querySelector<HTMLElement>('[data-matrix-model-name]')!

    // The mark comes first, then the name, then the description: one line, no second row.
    expect(nhat.firstElementChild?.getAttribute('data-matrix-model-mark')).toBe('atum')
    expect(name.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(meta.parentElement).toBe(name.parentElement)
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

    // The account's plans always have a rail entry; with none connected each mark is hollow and nothing of this Mac is listed.
    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')
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

    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')
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
    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')
    expect(within(card).getByText('Sign in again for ChatGPT plan in Connections.')).toBeTruthy()
    expect(card.querySelector('[data-matrix-model-connect]')).toBeTruthy()
  })

  it('shows the current model’s thinking levels in a column beside the list and saves a new one', async () => {
    const { command } = picker(
      { ...ROOM, effort: 'high' },
      {
        managed: false,
        connected: CHATGPT,
        bridge: plan()
      }
    )

    const card = await open('Model: ChatGPT · GPT-5.6 Luna · Thorough')

    const levels = await waitFor(() => within(card).getByRole('radiogroup', { name: /^Thinking: / }))
    const radios = within(levels).getAllByRole('radio')
    expect(radios.map(each => each.getAttribute('data-matrix-model-effort-level'))).toEqual(['low', 'medium', 'high'])
    expect(within(levels).getByRole('radio', { checked: true }).textContent).toContain('Thorough')
    // The model's default carries its word when it is not the saved one.
    expect(within(levels).getByRole('radio', { name: /Balanced/ }).textContent).toContain('Default')
    expect(card.querySelector('[data-matrix-model-search]')).toBeTruthy()

    fireEvent.click(within(levels).getByRole('radio', { name: /Quick/ }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, effort: 'low' }))
  })

  it('moves between the list and the thinking column with the arrow keys', async () => {
    picker({ ...ROOM, effort: 'high' }, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna · Thorough')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    row(card, GPT6_ROUTE).focus()
    fireEvent.keyDown(row(card, GPT6_ROUTE), { key: 'ArrowRight' })
    const high = card.querySelector<HTMLElement>('[data-matrix-model-effort-level="high"]')!
    expect(window.document.activeElement).toBe(high)

    fireEvent.keyDown(high, { key: 'ArrowUp' })
    expect(window.document.activeElement?.getAttribute('data-matrix-model-effort-level')).toBe('medium')

    // Left goes back to the model that answers now.
    fireEvent.keyDown(window.document.activeElement!, { key: 'ArrowLeft' })
    expect(window.document.activeElement).toBe(row(card, CHATGPT_ROUTE))
  })

  it('starts a search when the person types on the opened card', async () => {
    picker(ROOM, { managed: false, connected: CHATGPT, bridge: plan() })
    const card = await open('Model: ChatGPT · GPT-5.6 Luna')
    await waitFor(() => expect(rows(card)).toHaveLength(3))

    card.focus()
    fireEvent.keyDown(card, { key: 's' })
    expect((search(card) as HTMLInputElement).value).toBe('s')
    expect(window.document.activeElement).toBe(search(card))
    expect(rowIds(card)).toEqual([SOL_ROUTE])
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

describe('the thinking column only where a level can be chosen', () => {
  it('has no thinking column and no speed toggle for Atum’s own models, which take one level', async () => {
    picker(ROOM, { managed: true })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(card.querySelector('[data-matrix-model-effort-column]')).toBeNull()
    expect(within(card).queryByRole('radiogroup')).toBeNull()
    // No backend accepts a speed (fast/standard) choice yet, so there is no control for one.
    expect(within(card).queryByText(/^(Fast|Standard)$/u)).toBeNull()
  })

  it('keeps the managed card compact while the home advertises one level', async () => {
    picker(ROOM, {
      agentPrincipal: 'agent-luna',
      home: cloudHome(),
      managed: true,
      cloud: true,
      local: true,
      here: 'cloud',
      bridge: { agentHome: homeBridge() }
    })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rowIds(card)).toEqual([NGUYET_THUC_ROUTE, NHAT_THUC_ROUTE, THAI_CUC_ROUTE])
    expect(card.querySelector('[data-matrix-model-effort-column]')).toBeNull()
    expect(card.className).not.toContain('--mp-effort-w')
  })

  it('offers a placed home’s advertised levels and saves the new one through the placement path', async () => {
    const multi = { ...CLOUD_NGUYET, efforts: ['low', 'medium', 'high'] as const }
    const home = cloudHome(multi)
    home.placement!.destinations = home.placement!.destinations.map(destination => ({
      ...destination,
      models: destination.models.map(model => (model.model === 'nguyet-thuc' ? multi : model))
    }))
    const model = vi.fn(async () => ({ status: 'saved' as const }))
    picker(ROOM, {
      agentPrincipal: 'agent-luna',
      home,
      managed: true,
      cloud: true,
      local: true,
      here: 'cloud',
      bridge: { agentHome: homeBridge(model) }
    })
    const card = await open('Model: Nguyệt Thực 1.3')

    const column = card.querySelector('[data-matrix-model-effort-column]')!
    expect(
      [...column.querySelectorAll('[data-matrix-model-effort-level]')].map(each =>
        each.getAttribute('data-matrix-model-effort-level')
      )
    ).toEqual(['low', 'medium', 'high'])
    expect(card.className).toContain('--mp-effort-w')

    fireEvent.click(column.querySelector<HTMLElement>('[data-matrix-model-effort-level="high"]')!)
    await waitFor(() =>
      expect(model).toHaveBeenCalledWith(
        'agent-luna',
        expect.objectContaining({ model: 'nguyet-thuc', effort: 'high' })
      )
    )
  })
  it('clears a refused home effort and waits for the saved effort projection independently of conversation effort', async () => {
    const multi = { ...CLOUD_NGUYET, efforts: ['low', 'medium', 'high'] as const }
    const home = cloudHome(multi)
    home.placement!.destinations = home.placement!.destinations.map(destination => ({
      ...destination, models: destination.models.map(option => option.model === multi.model ? multi : option)
    }))

    const model = vi.fn().mockResolvedValueOnce({ status: 'refused', reason: 'connection_unavailable' })
      .mockResolvedValue({ status: 'saved' })

    const view = picker(ROOM, {
      agentPrincipal: 'agent-luna', home, managed: true, cloud: true, local: true, here: 'cloud',
      cloudChoice: { offered: ['nguyet-thuc'], current: 'nguyet-thuc', effort: 'low',
        models: [{ alias: 'nguyet-thuc', efforts: ['low', 'high'] }] },
      bridge: { agentHome: homeBridge(model) }
    })

    const card = await open('Model: Nguyệt Thực 1.3')
    const high = () => card.querySelector<HTMLButtonElement>('[data-matrix-model-effort-level="high"]')!
    fireEvent.click(high())
    await waitFor(() => expect(view.fail).toHaveBeenCalledOnce())
    expect(high().disabled).toBe(false)
    fireEvent.click(high())
    await waitFor(() => expect(model).toHaveBeenCalledTimes(2))
    expect(high().disabled).toBe(true)
    expect(view.command).not.toHaveBeenCalled()

    const refreshedHome = ownerHomeViewFor(cloudHome(multi), {
      snapshot: ownerSnapshotFixture as Parameters<typeof ownerHomeViewFor>[1]['snapshot'], catalogs: {}
    }, null, null, { source: 'atum', model: multi.model, effort: 'high' }, [
      { alias: multi.model, efforts: multi.efforts, defaultEffort: 'medium', eligible: true }
    ])

    view.rerender(ROOM, { home: refreshedHome })
    await waitFor(() => expect(high().disabled).toBe(false))
    expect(high().getAttribute('aria-checked')).toBe('true')
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
    expect(chatGptRail.dataset.matrixModelRailSignedOut).toBeUndefined()

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
    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')

    fireEvent.click(rail(card, 'openai-codex'))
    expect(card.querySelector('[data-matrix-model-note]')!.textContent).toBe('ChatGPT needs you to sign in again.')
    expect(within(card).queryByText('Reconnect ChatGPT')).toBeNull()

    // Connect opens the service chooser in place; ChatGPT there opens the one account connect sheet, never a device code.
    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail] [data-matrix-model-connect]')!)
    const chooser = await screen.findByRole('dialog', { name: 'Subscriptions' })
    fireEvent.click(chooser.querySelector<HTMLButtonElement>('[data-matrix-subscription-choice="codex"]')!)
    expect($accountConnect.get()).toEqual({ plan: 'codex', mode: 'connect' })
    expect(subscriptions.startChatGpt).not.toHaveBeenCalled()
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
    const chooser = within(await screen.findByRole('dialog', { name: 'Subscriptions' }))

    for (const name of [/ChatGPT/, /Claude/, /Antigravity/, /OpenCode Go/]) {
      expect(chooser.getByRole('button', { name })).toBeTruthy()
    }

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
    // The logo names the provider, so the row is the model's name alone (the provider stays in its
    // accessible name).
    expect(chatgpt.textContent).toBe('GPT-5.6 Luna')
    expect(chatgpt.querySelector('[data-provider-mark="openai"]')).toBeTruthy()
    expect(chatgpt.getAttribute('aria-label')).toContain('ChatGPT')
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

  it('shows a cloud agent the this-Mac ChatGPT models greyed with one line (D6), and nothing else in that list', async () => {
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
    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')

    fireEvent.click(rail(card, 'openai-codex'))
    expect(rowIds(card)).toEqual([CHATGPT_ROUTE, SOL_ROUTE])

    for (const id of [CHATGPT_ROUTE, SOL_ROUTE]) {
      expect(row(card, id).disabled).toBe(true)
      expect(row(card, id).parentElement!.querySelector('[data-matrix-model-favorite]')).toBeNull()
    }

    // One line for the list, not one per row; no Work on this Mac, so no action beside it.
    expect(within(card).getAllByText('Your plan works in Work on your Mac')).toHaveLength(1)
    expect(card.querySelector('[data-matrix-model-note-action]')).toBeNull()

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

  it('lists unavailable account plans without a loading suffix when no relay can read them', async () => {
    $accountConnections.set(ACCOUNT_CONNECTIONS_FIXTURE)
    picker(ROOM, { cloud: true, here: 'cloud', local: true, managed: true, cloudChoice: { offered: ['default'], current: 'default' } })
    const card = await open('Model: Nguyệt Thực 1.3')

    // Atum first, connected plans next, the plan to connect last; its mark is hollow.
    const items = [...card.querySelectorAll('[data-matrix-model-rail-item]')].map(item => item.getAttribute('data-matrix-model-rail-item'))
    expect(items.indexOf('atum')).toBeLessThan(items.indexOf('claude-plan'))
    expect(items.indexOf('claude-plan')).toBeLessThan(items.indexOf('antigravity'))
    expect(rail(card, 'antigravity').dataset.matrixModelRailSignedOut).toBe('true')

    fireEvent.click(rail(card, 'claude-plan'))
    const claude = card.querySelector<HTMLButtonElement>('[data-matrix-model-route="claude-plan:claude-sonnet-5-5"]')!
    expect(claude.disabled).toBe(true)
    expect(card.textContent).toContain('Couldn’t reach this assistant’s connections.')
    expect(card.textContent).not.toContain('Loading models…')
    expect(card.textContent).not.toContain('Works in Work for now')

    fireEvent.click(rail(card, 'antigravity'))
    const connect = card.querySelector('[data-atum-picker-connect="antigravity"]')!
    expect(connect.textContent).toContain('Use your Antigravity plan')
    fireEvent.click(within(connect as HTMLElement).getByRole('button', { name: 'Connect' }))
    expect($accountConnect.get()).toEqual({ plan: 'antigravity', mode: 'connect' })
    // No price, limit, relay or Mac text in the picker.
    expect(card.textContent ?? '').not.toMatch(/relay|offline|Protons|% used/iu)
  })

  const nativePlanAgent = '00000000-0000-4000-8000-bd7662a5eeb4'

  it.each([
    [false, 'connected', 'Plan unavailable. Connect this Mac to Atum Work.'],
    [true, 'disconnected', 'Not connected on any of your Macs']
  ] as const)('disables a plan when publication is %s and Codex is %s', async (published, state, note) => {
    const selectRelay = vi.fn()
    picker(ROOM, {
      cloud: true, here: 'cloud', agentPrincipal: nativePlanAgent,
      cloudChoice: { offered: ['default'], current: 'default', revision: 7 },
      bridge: { work: {
        readAgentPlans: async () => ({
          published, plans: { codex: { state, models: [{ id: 'gpt-6-sol', displayName: 'GPT-6 Sol' }] } }, selection: null
        }),
        selectRelay
      } as unknown as NonNullable<MatrixUiBridge['work']> }
    })
    const card = await open(/Model:/)
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))

    expect(row(card, SOL_ROUTE).disabled).toBe(true)
    expect(card.textContent).toContain(note)
    fireEvent.click(row(card, SOL_ROUTE))
    expect(selectRelay).not.toHaveBeenCalled()
  })

  it.each([ROOM.id, 'assistant-card:agent:cloud'])('selects native Codex models through the existing Work write (%s)', async id => {
    $accountConnections.set(ACCOUNT_CONNECTIONS_FIXTURE)
    const read = deferred<WorkAgentPlans>()
    const selectRelay = vi.fn(async () => ({ provider: 'atum-work' as const, plan: 'codex' as const, model: 'gpt-6-sol', revision: 8 }))
    const readPlanConsent = vi.fn(async () => { throw new Error('legacy gate offline') })
    picker({ ...ROOM, id }, {
      cloud: true, here: 'cloud', agentPrincipal: nativePlanAgent, preferenceScope: 'account:test',
      cloudChoice: { offered: ['default'], current: 'default', revision: 1 },
      bridge: { work: { readAgentPlans: vi.fn(() => read.promise), readPlanConsent, selectRelay } as unknown as NonNullable<MatrixUiBridge['work']> }
    })
    const card = await open(/Model:/)
    await act(async () => read.resolve({
      published: true,
      plans: { codex: { state: 'connected', models: [{ id: 'gpt-6-sol', displayName: 'Native GPT-6 Sol' }] } },
      selection: { provider: 'atum-work', plan: 'codex', model: 'previous-native-model', revision: 7 }
    }))
    fireEvent.click(rail(card, 'openai-codex'))

    const model = row(card, SOL_ROUTE)
    expect(rowIds(card)).toEqual([SOL_ROUTE])
    expect(model.disabled).toBe(false)
    expect(model.textContent).toContain('Native GPT-6 Sol')

    fireEvent.click(model)
    await waitFor(() => expect(selectRelay).toHaveBeenCalledWith(nativePlanAgent, 7, 'gpt-6-sol', 'codex'))
    expect(readPlanConsent).not.toHaveBeenCalled()
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
    await waitFor(() => expect(within(card).getByText('Your plan works in Work on your Mac')).toBeTruthy())
    expect(rowIds(card)).toEqual([])
    fireEvent.click(rail(card, 'atum'))
    expect(card.querySelector('[data-matrix-model-route*="gpt-5.6-luna"]')).toBeNull()
    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')
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
    expect(row(card, GLM_CLOUD_ROUTE).querySelector('[data-provider-mark="opencode"]')).toBeTruthy()
    expect(row(card, GLM_CLOUD_ROUTE).getAttribute('aria-label')).toContain('OpenCode Go')
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

  const cloudPlanBridge = (subscriptions: ReturnType<typeof subscriptionsBridge>) => {
    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))
    const command = vi.fn(async () => ({ status: 'applied' as const }))

    return {
      writeSubscription,
      command,
      bridge: {
        command,
        subscriptions,
        modelDestinations: {
          read: vi.fn(async () => undefined),
          write: vi.fn(async () => ({ status: 'saved' as const })),
          writeSubscription,
          cap: vi.fn(async () => ({ status: 'saved' as const }))
        }
      }
    }
  }

  it('gives the cloud ChatGPT model a thinking column and saves a level with the same plan choice', async () => {
    const agentPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'
    const { bridge, writeSubscription, command } = cloudPlanBridge(subscriptionsBridge({ chatgpt: ['gpt-6-sol'] }))

    const chatgptSaved: MatrixCloudModelChoiceView = {
      offered: ['nguyet-thuc', 'nhat-thuc'],
      current: 'nguyet-thuc',
      subscription: { source: 'chatgpt_plan', model: 'gpt-6-sol', effort: 'medium', displayName: 'GPT-6 Sol' },
      subscriptionState: 'connected'
    }

    picker(ROOM, { agentPrincipal, bridge, cloud: true, cloudChoice: chatgptSaved, local: true, managed: true })
    const card = await open(/^Model: GPT-6 Sol/)
    await waitFor(() => expect(row(card, SOL_ROUTE)).toBeTruthy())

    const levels = await waitFor(() => within(card).getByRole('radiogroup', { name: 'Thinking: GPT-6 Sol' }))
    expect(within(levels).getByRole('radio', { checked: true }).textContent).toContain('Balanced')

    fireEvent.click(within(levels).getByRole('radio', { name: /Thorough/ }))
    await waitFor(() =>
      expect(writeSubscription).toHaveBeenCalledWith(agentPrincipal, 'chatgpt_plan', 'gpt-6-sol', 'high')
    )
    // The level is the plan's, not a conversation setting.
    expect(command).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(within(levels).getByRole('radio', { checked: true }).textContent).toContain('Thorough')
    )

    // The column belongs to the current model's own list: Atum's list must not show GPT-6 Sol's levels.
    fireEvent.click(rail(card, 'atum'))
    expect(within(card).queryByRole('radiogroup', { name: /^Thinking:/ })).toBeNull()
    fireEvent.click(rail(card, 'openai-codex'))
    expect(within(card).getByRole('radiogroup', { name: 'Thinking: GPT-6 Sol' })).toBeTruthy()
  })

  it('keeps each provider’s list apart: one model id under ChatGPT and OpenCode Go is two choices', async () => {
    const agentPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'

    const { bridge, writeSubscription, command } = cloudPlanBridge(
      subscriptionsBridge({ chatgpt: ['gpt-6-sol'], opencode: ['gpt-6-sol'] })
    )

    const atumOnly: MatrixCloudModelChoiceView = { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' }

    picker(ROOM, { agentPrincipal, bridge, cloud: true, cloudChoice: atumOnly, local: true, managed: true })
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'opencode-go')).toBeTruthy())

    const opencodeSol = matrixModelRouteId('opencode-go', 'gpt-6-sol')
    expect(opencodeSol).not.toBe(SOL_ROUTE)

    // Each rail lists only its own provider's row, whatever the model is called.
    fireEvent.click(rail(card, 'openai-codex'))
    expect(rowIds(card)).toEqual([SOL_ROUTE])
    fireEvent.click(rail(card, 'opencode-go'))
    expect(rowIds(card)).toEqual([opencodeSol])

    fireEvent.click(row(card, opencodeSol))
    await waitFor(() => expect(writeSubscription).toHaveBeenCalledTimes(1))
    expect(writeSubscription).toHaveBeenCalledWith(agentPrincipal, 'opencode_go', 'gpt-6-sol', expect.any(String))
    // Never read as Atum's model of the same name.
    expect(command).not.toHaveBeenCalled()
  })
})

describe('a plan that cannot answer now (owner 2026-11-11)', () => {
  type Presence = 'online' | 'offline' | 'none' | undefined

  const relayAccount = (presence: Presence, state: 'enabled' | 'disabled' | 'carried' = 'enabled') => ({
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
    options: Partial<PickerOptions> & { state?: 'enabled' | 'disabled' | 'carried' } = {}
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

  it('shows the saved ChatGPT model’s thinking levels read only while its Mac is offline', async () => {
    const { modelDestinations } = cloudPicker('offline', { cloudChoice: solChoice() })
    const card = await open(/^Model: GPT-6 Sol/)

    const levels = await waitFor(() => within(card).getByRole('radiogroup', { name: 'Thinking: GPT-6 Sol' }))
    const radios = within(levels).getAllByRole('radio') as HTMLButtonElement[]
    expect(radios.every(each => each.disabled)).toBe(true)
    fireEvent.click(within(levels).getByRole('radio', { name: /Thorough/ }))
    expect(modelDestinations.writeSubscription).not.toHaveBeenCalled()
  })

  it('lists ChatGPT models as choosable while its Mac is online', async () => {
    cloudPicker('online')
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBeUndefined()
    fireEvent.click(rail(card, 'openai-codex'))
    expect(row(card, SOL_ROUTE).disabled).toBe(false)
    expect(row(card, SOL_ROUTE).textContent).not.toContain('offline')
  })

  it.each([
    ['en', 'offline', 'Your plan works in Work on your Mac', 'Open Work'],
    ['vi', 'offline', 'Gói của bạn dùng trong Work trên máy Mac', 'Mở Work'],
    ['en', 'none', 'Your plan works in Work on your Mac', 'Open Work']
  ] as const)('greys ChatGPT for an assistant (%s, Mac %s) with one line and one action, Open Work (D6)', async (locale, presence, line, action) => {
    resetWorkStoreForTests()
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok' })

    try {
      const { modelDestinations } = cloudPicker(presence, { locale })
      const card = await open(/^(Model|Mô hình): Nguyệt Thực 1\.3$/)
      await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

      expect(rail(card, 'openai-codex').dataset.matrixModelRailSignedOut).toBe('true')
      fireEvent.click(rail(card, 'openai-codex'))

      for (const id of rowIds(card).filter((each): each is string => Boolean(each))) {
        expect(row(card, id).disabled).toBe(true)
        expect(row(card, id).textContent).not.toContain(line)
      }

      expect(within(card).getAllByText(line)).toHaveLength(1)
      // Never a cost, a relay or a Mac to wake: the plan is for Work, not for the assistant's answers.
      expect(within(card).queryByText(/offline|Proton|relay|Not ready/u)).toBeNull()
      fireEvent.click(row(card, SOL_ROUTE))
      expect(modelDestinations.writeSubscription).not.toHaveBeenCalled()

      fireEvent.click(within(card).getByRole('button', { name: action }))
      expect($workActive.get()).toBe(true)
    } finally {
      resetWorkStoreForTests()
    }
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

  it.each([
    ['en', 'Model: GPT-6 Sol · ChatGPT was offline', 'ChatGPT was offline'],
    ['vi', 'Mô hình: GPT-6 Sol · Lúc đó ChatGPT không kết nối được', 'Lúc đó ChatGPT không kết nối được']
  ] as const)('marks the chip when the last turn fell back (%s): the same red glyph, one line, never a cost', async (locale, name, why) => {
    const { command, modelDestinations } = cloudPicker('online', {
      locale,
      cloudChoice: solChoice({ relayPresence: 'online' }),
      lastFallback: { plan: 'chatgpt', reason: 'offline', servedBy: 'nguyet-thuc' }
    })

    const chip = screen.getByRole('button', { name })
    const warning = chip.querySelector<SVGElement>('[data-matrix-model-warning]')!

    expect(warning.getAttribute('style')).toContain('var(--ak-danger)')
    expect(chip.dataset.matrixModelUnavailable).toBe('fell_back')
    expect(chip.textContent).toContain('GPT-6 Sol')
    const said = await tip(chip)
    expect(said).toContain(why)
    expect(said).not.toMatch(/Proton|\d/u)
    expect(command).not.toHaveBeenCalled()
    expect(modelDestinations.writeSubscription).not.toHaveBeenCalled()
  })

  it('keeps the chip plain when the fallback was for another plan, or the chip names Atum', () => {
    cloudPicker('online', {
      cloudChoice: solChoice({ relayPresence: 'online' }),
      lastFallback: { plan: 'opencode_go', reason: 'rate_limited', servedBy: 'nguyet-thuc' }
    })
    expect(screen.getByRole('button', { name: 'Model: GPT-6 Sol' }).querySelector('[data-matrix-model-warning]')).toBeNull()

    cleanup()
    cloudPicker('online', { lastFallback: { plan: 'chatgpt', reason: 'offline', servedBy: 'nguyet-thuc' } })
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

describe('ChatGPT with Google data: the one-time confirmation inside the picker (owner 2026-11-16)', () => {
  const CONNECTION = '0a1b2c3d-0000-4000-8000-00000000000a'
  const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'

  const training = (value: Partial<MatrixChatGptTrainingStatus> = {}): MatrixChatGptTrainingStatus => ({
    required: true,
    current: false,
    connectionId: CONNECTION,
    confirmedAt: null,
    ...value
  })

  const setup = (
    status: MatrixChatGptTrainingStatus,
    confirm: MatrixSubscriptionsBridge['confirmChatGptTraining'] = vi.fn(async () => ({
      status: 'confirmed' as const,
      training: training({ current: true, confirmedAt: 1 })
    })),
    locale: 'en' | 'vi' = 'en'
  ) => {
    const providers = [
      {
        id: 'openai-codex' as const,
        connected: true,
        models: ['gpt-5.6-luna', 'gpt-6-sol'],
        relay: { state: 'enabled' as const, thisMac: true, revision: 1, presence: 'online' as const }
      },
      { id: 'opencode-go' as const, connected: false }
    ]

    const subscriptions = {
      catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers })),
      status: vi.fn(async () => ({ scope: 'account' as const, providers })),
      startChatGpt: vi.fn(async () => ({ status: 'cancelled' as const })),
      pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
      cancelChatGpt: vi.fn(async () => undefined),
      disconnectChatGpt: vi.fn(async () => undefined),
      connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
      disconnectOpenCode: vi.fn(async () => undefined),
      chatGptTraining: vi.fn<() => Promise<MatrixChatGptTrainingStatus>>(async () => status),
      confirmChatGptTraining: confirm,
      revokeChatGptTraining: vi.fn(async () => ({ status: 'unavailable' as const }))
    }

    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))

    picker(ROOM, {
      agentPrincipal: AGENT,
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
      cloudChoice: { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' },
      local: true,
      locale,
      managed: true
    })

    return { confirm, subscriptions, writeSubscription }
  }

  const pickSol = async (name: string | RegExp = 'Model: Nguyệt Thực 1.3') => {
    const card = await open(name)
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.click(row(card, SOL_ROUTE))

    return card
  }

  it('asks inside the same card, with Confirm disabled until the box is ticked, then saves the pick', async () => {
    const { confirm, writeSubscription } = setup(training())
    const card = await pickSol()

    const step = await waitFor(() => card.querySelector<HTMLElement>('[data-matrix-chatgpt-training]')!)
    // One card, one focus: the list column is replaced, no second dialog or picker opens.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(card.querySelector('[data-matrix-model-list]')).toBeNull()
    expect(step.textContent).toContain(
      'I turned off ‘Improve the model for everyone’ in ChatGPT → Settings → Data controls.'
    )
    expect(step.textContent).toContain(
      'This lets this assistant use your ChatGPT plan with Google data. Keep it off. If you turn it back on, revoke this confirmation in Connections.'
    )
    expect(step.textContent).toContain('Send this assistant’s Google data to OpenAI to answer your requests.')

    const box = within(step).getByRole('checkbox')
    const primary = within(step).getByRole('button', { name: 'Confirm and use ChatGPT' })
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(box)
    expect((primary as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(primary)
    expect(confirm).not.toHaveBeenCalled()

    fireEvent.click(box)
    expect((primary as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(primary)

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(CONNECTION))
    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(AGENT, 'chatgpt_plan', 'gpt-6-sol', 'medium'))
    expect(card.querySelector('[data-matrix-chatgpt-training]')).toBeNull()
  })

  it('Keep protected model returns to the list and leaves the saved model as it is', async () => {
    const { confirm, writeSubscription } = setup(training())
    const card = await pickSol()

    const step = await waitFor(() => card.querySelector<HTMLElement>('[data-matrix-chatgpt-training]')!)
    fireEvent.click(within(step).getByRole('button', { name: 'Keep protected model' }))

    expect(card.querySelector('[data-matrix-chatgpt-training]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-list]')).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    expect(writeSubscription).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
  })

  it.each([
    ['already confirmed for this wording', training({ current: true, confirmedAt: 1 })],
    ['an account whose assistants never touch Google', training({ required: false })]
  ])('does not ask when %s', async (_name, status) => {
    const { confirm, writeSubscription } = setup(status)
    const card = await pickSol()

    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(AGENT, 'chatgpt_plan', 'gpt-6-sol', 'medium'))
    expect(card.querySelector('[data-matrix-chatgpt-training]')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a changed relay connection re-reads, unticks and asks again for the new one; a failure stays calm', async () => {
    const NEXT = '0a1b2c3d-0000-4000-8000-00000000000b'

    const confirm = vi.fn<NonNullable<MatrixSubscriptionsBridge['confirmChatGptTraining']>>()
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({ status: 'unavailable' })

    const { subscriptions, writeSubscription } = setup(training(), confirm)
    const card = await pickSol()

    const step = await waitFor(() => card.querySelector<HTMLElement>('[data-matrix-chatgpt-training]')!)
    subscriptions.chatGptTraining.mockResolvedValue(training({ connectionId: NEXT }))
    fireEvent.click(within(step).getByRole('checkbox'))
    fireEvent.click(within(step).getByRole('button', { name: 'Confirm and use ChatGPT' }))

    await waitFor(() => expect(step.querySelector('[data-matrix-chatgpt-training-notice="stale"]')).toBeTruthy())
    expect(within(step).getByRole('checkbox').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(within(step).getByRole('checkbox'))
    fireEvent.click(within(step).getByRole('button', { name: 'Confirm and use ChatGPT' }))
    await waitFor(() => expect(confirm).toHaveBeenLastCalledWith(NEXT))
    await waitFor(() => expect(step.querySelector('[data-matrix-chatgpt-training-notice="failed"]')).toBeTruthy())
    expect(step.textContent).toContain('Your model hasn’t changed.')
    expect(writeSubscription).not.toHaveBeenCalled()
  })

  it('a failed read asks for nothing and offers the existing retry, never a silent pick', async () => {
    const { writeSubscription, subscriptions } = setup(training())
    subscriptions.chatGptTraining.mockRejectedValue(new Error('offline'))
    const card = await pickSol()

    await waitFor(() => expect(card.querySelector('[data-matrix-model-retry]')).toBeTruthy())
    expect(card.querySelector('[data-matrix-chatgpt-training]')).toBeNull()
    expect(writeSubscription).not.toHaveBeenCalled()
  })

  it('reads the exact Vietnamese wording', async () => {
    setup(training(), undefined, 'vi')
    const card = await pickSol(/^Mô hình: Nguyệt Thực 1\.3$/)

    const step = await waitFor(() => card.querySelector<HTMLElement>('[data-matrix-chatgpt-training]')!)
    expect(step.textContent).toContain('Tôi đã tắt ‘Improve the model for everyone’ trong ChatGPT → Settings → Data controls.')
    expect(step.textContent).toContain(
      'Việc này cho phép trợ lý dùng gói ChatGPT của bạn với dữ liệu Google. Hãy giữ cài đặt này ở trạng thái tắt. Nếu bật lại, hãy thu hồi xác nhận trong Kết nối.'
    )
    expect(step.textContent).toContain('Gửi dữ liệu Google của trợ lý này đến OpenAI để trả lời yêu cầu của bạn.')
    expect(within(step).getByRole('button', { name: 'Xác nhận và dùng ChatGPT' })).toBeTruthy()
    expect(within(step).getByRole('button', { name: 'Giữ mô hình được bảo vệ' })).toBeTruthy()
  })
})

describe('standard managed cloud conversation effort', () => {
  it.each(['nguyet-thuc', 'nhat-thuc'] as const)('uses the cloud offer and saves effort without a placed home: %s', async model => {
    const { command } = picker({ ...ROOM, effort: 'low' }, {
      managed: true, cloud: true, here: 'cloud',
      cloudChoice: { offered: ['nguyet-thuc', 'nhat-thuc'], current: model, effort: 'medium',
        models: [{ alias: model, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] }
    })

    const card = await open(model === 'nguyet-thuc' ? 'Model: Nguyệt Thực 1.3' : 'Model: Nhật Thực 1.1')
    const column = card.querySelector('[data-matrix-model-effort-column]')!
    expect(column).not.toBeNull()
    expect(column.querySelector('[data-matrix-model-effort-level="medium"]')?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(column.querySelector<HTMLElement>('[data-matrix-model-effort-level="high"]')!)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, effort: 'high' }))
    expect(column.querySelector('[data-matrix-model-effort-level="high"]')?.getAttribute('aria-checked')).toBe('true')
  })
})

it('undoes a refused managed cloud effort write', async () => {
  const command = vi.fn(async () => ({ status: 'refused' }))
  picker(ROOM, { managed: true, cloud: true, here: 'cloud', bridge: { command },
    cloudChoice: { offered: ['nguyet-thuc'], current: 'nguyet-thuc', effort: 'low',
      models: [{ alias: 'nguyet-thuc', efforts: ['low', 'high'] }] } })
  const card = await open('Model: Nguyệt Thực 1.3')
  fireEvent.click(card.querySelector<HTMLElement>('[data-matrix-model-effort-level="high"]')!)
  await waitFor(() => expect(command).toHaveBeenCalled())
  await waitFor(() => expect(card.querySelector('[data-matrix-model-effort-level="low"]')?.getAttribute('aria-checked')).toBe('true'))
  expect(card.querySelector('[data-matrix-model-effort-level="medium"]')).toBeNull()
})

describe('relay R1: plan rows from the relay view-model (lane U1)', () => {
  const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'

  const account = (presence: 'online' | 'offline') => ({
    catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers: [] })),
    status: vi.fn(async () => ({
      scope: 'account' as const,
      providers: [
        {
          id: 'openai-codex' as const,
          connected: true,
          localConnected: false,
          models: ['gpt-6-sol'],
          relay: { state: 'enabled' as const, thisMac: false, revision: 4, presence }
        },
        { id: 'opencode-go' as const, connected: false }
      ]
    })),
    startChatGpt: vi.fn(async () => ({ status: 'cancelled' as const })),
    pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
    cancelChatGpt: vi.fn(async () => undefined),
    disconnectChatGpt: vi.fn(async () => undefined),
    connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
    disconnectOpenCode: vi.fn(async () => undefined)
  })

  const relayPicker = (view: MatrixModelPickerRelay['view'], presence: 'online' | 'offline' = 'offline') => {
    const select = vi.fn(async (_model: string) => ({ status: 'saved' }))
    const fix = vi.fn()
    const writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))

    picker(ROOM, {
      agentPrincipal: AGENT,
      bridge: {
        subscriptions: account(presence),
        modelDestinations: {
          read: vi.fn(async () => undefined),
          write: vi.fn(async () => ({ status: 'saved' as const })),
          writeSubscription,
          cap: vi.fn(async () => ({ status: 'saved' as const }))
        }
      } as unknown as Partial<MatrixUiBridge>,
      cloud: true,
      cloudChoice: { offered: ['nguyet-thuc', 'nhat-thuc'], current: 'nguyet-thuc' },
      local: true,
      managed: true,
      workRelay: [{ view, select, fix, models: [{ id: 'gpt-6-sol', displayName: 'GPT-6 Sol' }] }]
    })

    return { fix, select, writeSubscription }
  }

  it('lets the owner pick a plan model while its Mac is offline (RT4), through the relay selection only', async () => {
    const { select, writeSubscription } = relayPicker({ plan: 'codex', rows: 'selectable' }, 'offline')
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())

    fireEvent.click(rail(card, 'openai-codex'))
    expect(row(card, SOL_ROUTE).disabled).toBe(false)
    expect(within(card).queryByText(/offline|Proton|relay|Your plan works in Work/u)).toBeNull()

    fireEvent.click(row(card, SOL_ROUTE))
    await waitFor(() => expect(select).toHaveBeenCalledWith('gpt-6-sol'))
    expect(writeSubscription).not.toHaveBeenCalled()
  })

  it.each([
    ['connect', 'Not connected on any of your Macs', 'Connect'],
    ['allow', 'Not allowed for this assistant yet', 'Allow']
  ] as const)('greys the rows when no Mac can serve the plan (%s): one line, the one fixing action', async (greyed, line, action) => {
    const { fix, select } = relayPicker({ plan: 'codex', rows: 'greyed', greyed, fix: greyed })
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))

    expect(row(card, SOL_ROUTE).disabled).toBe(true)
    expect(within(card).getAllByText(line)).toHaveLength(1)
    fireEvent.click(row(card, SOL_ROUTE))
    expect(select).not.toHaveBeenCalled()

    fireEvent.click(within(card).getByRole('button', { name: action }))
    expect(fix).toHaveBeenCalledWith(greyed)
  })

  it('greys an assistant that holds Google with one line and no action (O1)', async () => {
    relayPicker({ plan: 'codex', rows: 'greyed', greyed: 'google' })
    const card = await open('Model: Nguyệt Thực 1.3')
    await waitFor(() => expect(rail(card, 'openai-codex')).toBeTruthy())
    fireEvent.click(rail(card, 'openai-codex'))

    const note = card.querySelector<HTMLElement>('[data-matrix-model-note]')!
    expect(note.textContent).toBe('Not yet for assistants that use Google')
    expect(note.querySelector('[data-matrix-model-note-action]')).toBeNull()
  })

  it('names the selected plan model on the chip and warns in red at its limit, never with a cost', () => {
    relayPicker({ plan: 'codex', rows: 'selectable', currentModel: 'gpt-6-sol', chip: { kind: 'limit' } })

    const chip = screen.getByRole('button', { name: 'Model: GPT-6 Sol · ChatGPT limit reached' })
    expect(chip.querySelector('[data-matrix-model-warning]')?.getAttribute('style')).toContain('var(--ak-danger)')
    expect(chip.dataset.matrixModelUnavailable).toBe('relay_limit')
    expect(chip.textContent).not.toMatch(/Proton|\$/u)
  })

  it('keeps the chip plain while the selected plan can answer', () => {
    relayPicker({ plan: 'codex', rows: 'selectable', currentModel: 'gpt-6-sol' })
    const chip = screen.getByRole('button', { name: 'Model: GPT-6 Sol' })
    expect(chip.querySelector('[data-matrix-model-warning]')).toBeNull()
  })
})
