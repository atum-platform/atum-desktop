import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentHomeView, MatrixAgentView, MatrixUiBridge } from '../../../shared/matrix'
import type {
  MatrixModelDestinationsView,
  MatrixModelDestinationView,
  MatrixModelId
} from '../../../shared/matrix-models'
import { matrixModelRouteId } from '../../../shared/matrix-models'
import { matrixShelfModelView } from '../../../shared/matrix-shelf-models'
import type { MatrixSubscriptionsStatus } from '../../../shared/matrix-subscriptions'
import { writeMatrixModelPickerPreferences } from '../model-picker-preferences'

import { AssistantCardSheet } from './assistant-card'
import { ModelDestinationsRow } from './model-destinations-row'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MAC = 'mac:00000000-0000-4000-8000-b454f82c5857'
const NGUYET = matrixModelRouteId('atum', 'nguyet-thuc')
const NHAT = matrixModelRouteId('atum', 'nhat-thuc')
const THAI = matrixModelRouteId('atum', 'thai-cuc')

const agent = {
  principal: AGENT,
  userId: '@atum:test',
  isDefault: true,
  ready: true,
  hermes: 'ready',
  atumModel: true
} as MatrixAgentView

function choice(overrides: Partial<MatrixModelDestinationView> = {}): MatrixModelDestinationView {
  return {
    id: 'cloud',
    kind: 'cloud',
    current: 'nguyet-thuc',
    recommended: true,
    models: ['nguyet-thuc', 'nhat-thuc'],
    unavailable: [],
    ...overrides
  }
}

function view(
  choices: MatrixModelDestinationView[] = [
    choice(),
    choice({
      id: MAC,
      kind: 'mac',
      deviceName: "Owner's MacBook Air",
      thisMac: true,
      macOrdinal: 1,
      current: 'nhat-thuc',
      recommended: false,
      models: ['nguyet-thuc', 'nhat-thuc']
    })
  ]
): MatrixModelDestinationsView {
  return { recommended: 'nguyet-thuc', here: 'nhat-thuc', choices }
}

function macHome(
  models: NonNullable<MatrixAgentHomeView['placement']>['destinations'][number]['models']
): MatrixAgentHomeView {
  return {
    lives: { kind: 'mac', name: "Owner's MacBook Air", thisMac: true },
    move: null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: MAC,
      reachability: 'reachable',
      currentModel: models[0],
      destinations: [
        {
          id: MAC,
          kind: 'mac',
          name: "Owner's MacBook Air",
          thisMac: true,
          eligibility: 'ready',
          catalogRevision: 1,
          models
        }
      ]
    }
  }
}

let write: ReturnType<typeof vi.fn>
let writeSubscription: ReturnType<typeof vi.fn>
let read: ReturnType<typeof vi.fn>
let chooseHome: ReturnType<typeof vi.fn>

function bridge(
  initial = view(),
  fresh?: MatrixModelDestinationsView,
  subscriptionStatus?: MatrixSubscriptionsStatus,
  freshHome?: MatrixAgentHomeView
) {
  write = vi.fn<(agent: string, destination: string, model: MatrixModelId) => Promise<{ status: 'saved' | 'refused' }>>(
    async () => ({ status: 'saved' })
  )
  read = vi.fn(async () => fresh ?? initial)
  writeSubscription = vi.fn(async () => ({ status: 'saved' as const }))
  chooseHome = vi.fn(async () => ({ status: 'saved' as const }))
  window.atumMatrix = {
    modelDestinations: {
      read,
      write,
      writeSubscription,
      cap: vi.fn(async () => ({ status: 'saved' }))
    },
    agentHome: {
      read: vi.fn(async () => freshHome),
      preflight: vi.fn(async () => ({ ok: false, reason: 'unused' })),
      move: vi.fn(async () => ({ ok: false, reason: 'unused' })),
      cancel: vi.fn(async () => ({ ok: false })),
      model: chooseHome,
      prepare: vi.fn(async () => ({ ok: false, reason: 'unused' }))
    },
    subscriptions: {
      status: vi.fn(
        async () =>
          subscriptionStatus ?? {
            scope: 'account' as const,
            providers: [
              { id: 'openai-codex' as const, connected: true },
              { id: 'opencode-go' as const, connected: false }
            ]
          }
      ),
      catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers: [] })),
      startChatGpt: vi.fn(async () => ({ status: 'cancelled' as const })),
      pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
      cancelChatGpt: vi.fn(async () => undefined),
      disconnectChatGpt: vi.fn(async () => undefined),
      useThisMacForChatGpt: vi.fn(async () => ({ status: 'unavailable' as const })),
      connectOpenCode: vi.fn(async () => ({ status: 'cancelled' as const })),
      disconnectOpenCode: vi.fn(async () => undefined)
    }
  } as unknown as MatrixUiBridge
}

function renderRow(
  value = view(),
  options: {
    withBridge?: boolean
    fresh?: MatrixModelDestinationsView
    freshHome?: MatrixAgentHomeView
    home?: MatrixAgentHomeView
    inSheet?: boolean
    subscriptions?: MatrixSubscriptionsStatus
  } = {}
) {
  const { withBridge = true, fresh, freshHome, home: agentHome, inSheet = false, subscriptions } = options

  if (withBridge) {
    bridge(value, fresh, subscriptions, freshHome)
  } else {
    Reflect.deleteProperty(window, 'atumMatrix')
  }

  return render(rowSurface(value, agentHome, inSheet, withBridge))
}

function rowSurface(
  value: MatrixModelDestinationsView,
  agentHome?: MatrixAgentHomeView,
  inSheet = false,
  withBridge = true
) {
  const rows = (
    <div className="atum-settings-group">
      <ModelDestinationsRow
        agent={{
          ...agent,
          ...(withBridge ? { modelDestinations: value } : {}),
          ...(agentHome ? { home: agentHome } : {})
        }}
        preferenceScope="account:@minh:atum.chat"
      />
    </div>
  )

  return (
    <I18nProvider configClient={null} initialLocale="vi">
      {inSheet ? <SheetHarness>{rows}</SheetHarness> : rows}
    </I18nProvider>
  )
}

function SheetHarness({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true)

  return open ? (
    <AssistantCardSheet compact={false} label="Thẻ trợ lý" onClose={() => setOpen(false)} open>
      {children}
    </AssistantCardSheet>
  ) : null
}

const dialog = () => screen.findByRole('dialog', { name: 'Mô hình' })

const modelRow = (card: HTMLElement, id: string) =>
  card.querySelector<HTMLButtonElement>(`[data-matrix-model-route="${id}"]`)!

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

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

describe('the assistant card’s model rows', () => {
  it('shows an external saved model itself, never the Atum recommendation standing in for it', () => {
    renderRow(
      view([
        choice({
          id: MAC,
          kind: 'mac',
          deviceName: 'Mac mini',
          current: 'nguyet-thuc',
          recommended: true,
          external: {
            source: 'chatgpt_plan',
            providerLabel: 'ChatGPT',
            model: 'gpt-5.6-luna',
            modelLabel: 'GPT-5.6 Luna',
            effort: 'medium'
          }
        })
      ])
    )

    expect(screen.getByText('ChatGPT · GPT-5.6 Luna')).toBeTruthy()
    expect(screen.queryByText('Nguyệt Thực 1.3')).toBeNull()
  })

  it('names a saved OpenRouter shelf model on the cloud row, never Atum’s fallback or “Đề xuất”', async () => {
    const opus = {
      connectionRef: 'conn_atummanaged000001',
      source: 'atum' as const,
      providerLabel: 'OpenRouter',
      model: 'opus',
      modelLabel: 'Claude Opus 5.5',
      effort: 'high' as const,
      efforts: ['low', 'medium', 'high'] as const,
      available: true,
      shelf: matrixShelfModelView({
        alias: 'opus',
        displayName: 'Anthropic: Claude Opus 5.5',
        providerModel: 'anthropic/claude-opus-5.5',
        inputUsdPerMtok: '4',
        outputUsdPerMtok: '20',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high'
      })!
    }

    const home: MatrixAgentHomeView = {
      lives: { kind: 'cloud' },
      move: null,
      targets: [],
      issue: null,
      placement: {
        profile: 'atum.agent-home/2.5',
        moveAvailable: true,
        current: 'cloud',
        reachability: 'reachable',
        currentModel: opus,
        destinations: [
          { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [opus] }
        ]
      }
    }

    renderRow(view([choice({ shelf: 'opus', recommended: false })]), { home })

    const cloud = screen.getByRole('button', { name: /^Đám mây/ })
    expect(within(cloud).getByText('OpenRouter · Claude Opus 5.5')).toBeTruthy()
    expect(within(cloud).queryByText('Đề xuất')).toBeNull()

    fireEvent.click(cloud)
    const card = await dialog()
    expect(modelRow(card, matrixModelRouteId('atum-openrouter', 'opus')).getAttribute('aria-current')).toBe('true')
  })

  it('lists the cloud and each Mac by display name, with the default and “Đề xuất”', async () => {
    renderRow()

    expect(screen.getByText('Mô hình')).toBeTruthy()
    const cloud = screen.getByRole('button', { name: /^Đám mây/ })
    const mac = screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ })

    expect(within(cloud).getByText('Nguyệt Thực 1.3')).toBeTruthy()
    expect(within(cloud).getByText('Đề xuất')).toBeTruthy()
    expect(within(mac).getByText('Nhật Thực 1.1')).toBeTruthy()
    expect(within(mac).queryByText('Đề xuất')).toBeNull()
    await waitFor(() => expect(read).toHaveBeenCalledWith(AGENT))
  })

  it('opens the composer’s same picker for the cloud host, with the line-up descriptors and no cost line', async () => {
    renderRow()

    fireEvent.click(screen.getByRole('button', { name: /^Đám mây/ }))
    const card = await dialog()

    expect(card.querySelector('[data-matrix-model-rail]')).toBeTruthy()
    expect(within(card).getByRole('textbox', { name: 'Tìm mô hình…' })).toBeTruthy()
    expect(
      [...card.querySelectorAll('[data-matrix-model-route]')].filter(row =>
        row.getAttribute('data-matrix-model-route')?.startsWith('atum:')
      )
    ).toHaveLength(3)
    expect(modelRow(card, NGUYET).textContent).toMatch(/Nguyệt Thực 1\.3.*Phù hợp tác vụ hàng ngày/)
    expect(modelRow(card, NHAT).textContent).toMatch(/Nhật Thực 1\.1.*Phù hợp với tác vụ khó khăn/)
    expect(modelRow(card, THAI).textContent).toMatch(/Thái Cực.*Mô hình quyền năng nhất.*Sắp có/)
    expect(card.textContent).not.toMatch(/20×/u)
  })

  it('opens the same picker for a Mac host and writes the chosen Atum model for that destination', async () => {
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    const card = await dialog()

    expect(card.querySelector('[data-matrix-model-rail]')).toBeTruthy()
    expect(modelRow(card, NHAT).getAttribute('aria-current')).toBe('true')

    fireEvent.click(modelRow(card, NGUYET))

    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, MAC, 'nguyet-thuc'))
    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ })).getByText('Nguyệt Thực 1.3')
      ).toBeTruthy()
    )
  })

  it('keeps the shared picker open inside the assistant card while its search, star, and selection are used', async () => {
    renderRow(view(), { inSheet: true })
    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    const card = await dialog()
    expect(card.className).toMatch(/pointer-events-auto/u)
    const search = within(card).getByRole('textbox', { name: 'Tìm mô hình…' })

    fireEvent.pointerDown(search)
    fireEvent.click(search)
    fireEvent.change(search, { target: { value: 'nguyet thuc' } })
    expect(await dialog()).toBe(card)

    const star = card
      .querySelector<HTMLButtonElement>(`[data-matrix-model-route="${NGUYET}"]`)!
      .parentElement!.querySelector<HTMLButtonElement>('[data-matrix-model-favorite]')!
    fireEvent.pointerDown(star)
    fireEvent.click(star)
    expect(await dialog()).toBe(card)

    fireEvent.pointerDown(modelRow(card, NGUYET))
    fireEvent.click(modelRow(card, NGUYET))
    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, MAC, 'nguyet-thuc'))
    expect(await dialog()).toBe(card)
    expect(screen.getByRole('dialog', { name: 'Thẻ trợ lý' })).toBeTruthy()
  })

  it('keeps the shared picker open when the assistant card receives a refreshed model projection', async () => {
    const initial = view()
    const rendered = renderRow(initial, { inSheet: true })
    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    const card = await dialog()

    // Snapshot/model refreshes produce new projection objects even when this destination is
    // unchanged. That background re-render must not tear down an interaction already in flight.
    rendered.rerender(rowSurface(view(initial.choices.map(each => ({ ...each }))), undefined, true))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mô hình' })).toBe(card))

    fireEvent.click(modelRow(card, NGUYET))
    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, MAC, 'nguyet-thuc'))
    expect(screen.getByRole('dialog', { name: 'Mô hình' })).toBe(card)
  })

  it('keeps the cloud to what the server offers: Nhật Thực is “Sắp có” until dispatch serves it', async () => {
    renderRow(view([choice({ models: ['nguyet-thuc'], unavailable: ['nhat-thuc'] })]))
    fireEvent.click(screen.getByRole('button', { name: /^Đám mây/ }))
    const card = await dialog()

    expect(modelRow(card, NHAT).disabled).toBe(true)
    expect(modelRow(card, NHAT).textContent).toMatch(/Sắp có/)
    fireEvent.click(modelRow(card, NHAT))
    expect(write).not.toHaveBeenCalled()
  })

  it('shows connected account subscriptions on the assistant’s Mac and in the cloud', async () => {
    const mac = choice({
      id: MAC,
      kind: 'mac',
      deviceName: "Owner's MacBook Air",
      thisMac: true,
      current: 'nguyet-thuc',
      recommended: true,
      models: ['nguyet-thuc', 'nhat-thuc']
    })

    const subscription = {
      connectionRef: 'chatgpt-1',
      source: 'chatgpt_plan' as const,
      providerLabel: 'ChatGPT',
      model: 'gpt-5.6-luna',
      modelLabel: 'GPT-5.6 Luna',
      effort: 'medium' as const,
      efforts: ['low', 'medium', 'high'] as const,
      available: true
    }

    const atum = {
      connectionRef: 'atum',
      source: 'atum' as const,
      providerLabel: 'Atum',
      model: 'nguyet-thuc',
      modelLabel: 'Nguyệt Thực 1.3',
      effort: 'medium' as const,
      efforts: ['low', 'medium', 'high'] as const,
      available: true
    }

    renderRow(view([mac]), {
      // The roster snapshot predates the account connection; opening the card refreshes the same
      // owner catalog the composer uses and exposes the connected plan to every assistant.
      home: macHome([atum]),
      freshHome: macHome([
        atum,
        {
          ...subscription
        }
      ])
    })

    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    let card = await dialog()
    const chatGptRail = await waitFor(() => {
      const button = card.querySelector<HTMLButtonElement>('[data-matrix-model-rail-item="openai-codex"]')
      expect(button).toBeTruthy()

      return button!
    })
    fireEvent.click(chatGptRail)
    await waitFor(() =>
      expect(modelRow(card, matrixModelRouteId('openai-codex', 'gpt-5.6-luna')).textContent).toContain('GPT-5.6 Luna')
    )
    fireEvent.click(modelRow(card, matrixModelRouteId('openai-codex', 'gpt-5.6-luna')))
    await waitFor(() =>
      expect(chooseHome).toHaveBeenCalledWith(AGENT, expect.objectContaining({ model: 'gpt-5.6-luna' }))
    )
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // A selected relay Mac makes the same ChatGPT plan a real cloud choice (R2).
    cleanup()
    renderRow(view([choice()]), {
      subscriptions: {
        scope: 'account',
        providers: [
          {
            id: 'openai-codex',
            connected: true,
            models: ['gpt-5.6-luna'],
            relay: { state: 'enabled', thisMac: true, revision: 1 }
          },
          { id: 'opencode-go', connected: false }
        ]
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /^Đám mây/ }))
    card = await dialog()
    // Providers are separated: the card opens on Atum; ChatGPT's models are under its own icon.
    const cloudChatGpt = await waitFor(() => {
      const button = card.querySelector<HTMLButtonElement>('[data-matrix-model-rail-item="openai-codex"]')
      expect(button).toBeTruthy()

      return button!
    })
    expect(card.querySelector(`[data-matrix-model-route="${matrixModelRouteId('openai-codex', 'gpt-5.6-luna')}"]`)).toBeNull()
    fireEvent.click(cloudChatGpt)
    await waitFor(() => expect(modelRow(card, matrixModelRouteId('openai-codex', 'gpt-5.6-luna'))).toBeTruthy())
    fireEvent.click(modelRow(card, matrixModelRouteId('openai-codex', 'gpt-5.6-luna')))
    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(AGENT, 'chatgpt_plan', 'gpt-5.6-luna', 'medium'))
    expect(screen.queryByText('Kết nối ChatGPT')).toBeNull()
  })

  it('opens the same account-scoped favorites the composer uses', async () => {
    writeMatrixModelPickerPreferences(window.localStorage, 'account:@minh:atum.chat', {
      favorites: [NGUYET],
      recent: []
    })

    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    const card = await dialog()

    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail-item="favorites"]')!)
    expect(
      [...card.querySelectorAll('[data-matrix-model-route]')].map(row => row.getAttribute('data-matrix-model-route'))
    ).toEqual([NGUYET])
  })

  it('reverts quietly when the server refuses the choice', async () => {
    renderRow()
    write.mockResolvedValueOnce({ status: 'refused' })
    fireEvent.click(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ }))
    const card = await dialog()

    fireEvent.click(modelRow(card, NGUYET))

    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(
      within(screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ })).getByText('Nhật Thực 1.1')
    ).toBeTruthy()
  })

  it('keeps every destination’s value readable while another row’s picker is open', async () => {
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /^Đám mây/ }))
    await dialog()

    const mac = screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ })
    expect(within(mac).getByText('Nhật Thực 1.1')).toBeTruthy()
  })

  it('keeps the server’s daily cap off the assistant card', () => {
    renderRow({
      ...view(),
      dailyCap: {
        dailyProtons: 200000,
        revision: 3,
        spend: { day: '2026-10-18', usedProtons: 42000, state: 'normal', notice: 'none' }
      }
    })

    expect(screen.queryByText('Hạn mức mỗi ngày')).toBeNull()
    expect(screen.queryByText('200.000 Proton')).toBeNull()
    expect(screen.queryByText(/42\.000/)).toBeNull()
  })

  it('draws nothing when the route is off or the window has no bridge', () => {
    const first = renderRow(view([]))
    expect(first.container.textContent).toBe('')
    cleanup()

    renderRow(view([choice()]), { withBridge: false })
    expect(screen.queryByText('Mô hình')).toBeNull()
  })

  it('writes a cloud OpenCode Go pick through atum.model-choice/1.4, not the Mac profile', async () => {
    renderRow(
      view([
        choice({
          recommended: false,
          external: {
            source: 'opencode_go',
            providerLabel: 'OpenCode Go',
            model: 'glm-5.2',
            modelLabel: 'GLM-5.2',
            effort: 'high'
          }
        })
      ]),
      {
        subscriptions: {
          scope: 'account',
          providers: [
            { id: 'openai-codex', connected: false },
            {
              id: 'opencode-go',
              connected: true,
              source: 'platform',
              revision: 1,
              models: ['glm-5.2', 'kimi-k3'],
              modelDetails: [
                { id: 'glm-5.2', displayName: 'GLM-5.2', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
                { id: 'kimi-k3', displayName: 'Kimi K3', efforts: [], defaultEffort: 'medium' }
              ]
            }
          ]
        }
      }
    )

    expect(within(screen.getByRole('button', { name: /^Đám mây/ })).getByText('OpenCode Go · GLM-5.2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Đám mây/ }))
    const card = await dialog()

    fireEvent.click(modelRow(card, matrixModelRouteId('opencode-go', 'kimi-k3')))

    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(AGENT, 'opencode_go', 'kimi-k3', 'medium'))
    expect(chooseHome).not.toHaveBeenCalled()
  })

  it('takes the destination default from the fresh read, not only the snapshot', async () => {
    renderRow(view(), { fresh: view([choice({ current: 'nhat-thuc', recommended: false })]) })

    await waitFor(() =>
      expect(within(screen.getByRole('button', { name: /^Đám mây/ })).getByText('Nhật Thực 1.1')).toBeTruthy()
    )
  })
})
