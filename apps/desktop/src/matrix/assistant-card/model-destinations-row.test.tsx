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
import { cardModelChoice, ModelDestinationsRow } from './model-destinations-row'

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
  atumModel: true,
  answering: 'cloud'
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
    cloudOnly?: boolean
  } = {}
) {
  const { withBridge = true, fresh, freshHome, home: agentHome, inSheet = false, subscriptions, cloudOnly } = options

  if (withBridge) {
    bridge(value, fresh, subscriptions, freshHome)
  } else {
    Reflect.deleteProperty(window, 'atumMatrix')
  }

  return render(rowSurface(value, agentHome, inSheet, withBridge, cloudOnly))
}

function rowSurface(
  value: MatrixModelDestinationsView,
  agentHome?: MatrixAgentHomeView,
  inSheet = false,
  withBridge = true,
  cloudOnly?: boolean
) {
  const rows = (
    <div className="atum-settings-group">
      <ModelDestinationsRow
        agent={{
          ...agent,
          ...(withBridge ? { modelDestinations: value } : {}),
          ...(agentHome ? { home: agentHome } : {})
        }}
        cloudOnly={cloudOnly}
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

const destinationButton = (kind: 'cloud' | 'mac') =>
  window.document.querySelector<HTMLButtonElement>(`[data-assistant-card-model-destination="${kind}"]`)!

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
  it('projects one cloud row, or the current Mac row for a not-yet-moved assistant', () => {
    const all = view()

    expect(cardModelChoice(all, { answering: 'cloud' }, 'cloud')).toEqual([all.choices[0]])
    expect(cardModelChoice(all, agent, MAC)).toEqual([all.choices[1]])
    expect(cardModelChoice(all, agent, 'cloud', false)).toEqual(all.choices)
  })

  it('uses this Mac for a local assistant whose old snapshot has no placement', () => {
    const all = view()

    expect(cardModelChoice(all, {}, undefined)).toEqual([all.choices[1]])
    expect(cardModelChoice(all, { answering: 'cloud', macRole: 'standby' }, undefined)).toEqual([all.choices[0]])
  })

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
      ]),
      { cloudOnly: false }
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

    const cloud = screen.getByRole('button', { name: /^Mô hình/ })
    expect(within(cloud).getByText('OpenRouter · Claude Opus 5.5')).toBeTruthy()
    expect(within(cloud).queryByText('Đề xuất')).toBeNull()

    fireEvent.click(cloud)
    const card = await dialog()
    expect(modelRow(card, matrixModelRouteId('atum-openrouter', 'opus')).getAttribute('aria-current')).toBe('true')
  })

  it('shows exactly one Model row for a cloud assistant, with no Mac names or recommendation badge', async () => {
    renderRow()

    const rows = screen.getAllByRole('button', { name: /^Mô hình/ })
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Nguyệt Thực 1.3')).toBeTruthy()
    expect(rows[0].textContent).not.toContain('Đề xuất')
    expect(screen.queryByText(/MacBook Air/)).toBeNull()
    await waitFor(() => expect(read).toHaveBeenCalledWith(AGENT))
  })

  it('restores the heading, destination names and Suggested badge when cloud-only is off', () => {
    renderRow(view(), { cloudOnly: false })

    expect(document.querySelector('[data-assistant-card-model-heading]')?.textContent).toBe('Mô hình')
    const cloud = screen.getByRole('button', { name: /^Đám mây/ })
    const mac = screen.getByRole('button', { name: /^MacBook Air \(máy này\)/ })

    expect(within(cloud).getByText('Đề xuất')).toBeTruthy()
    expect(within(mac).queryByText('Đề xuất')).toBeNull()
  })

  it('shows one Model row with the answering Mac model for a not-yet-moved assistant', () => {
    renderRow(view(), { home: macHome([]) })

    const rows = screen.getAllByRole('button', { name: /^Mô hình/ })
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Nhật Thực 1.1')).toBeTruthy()
    expect(screen.queryByText('Nguyệt Thực 1.3')).toBeNull()
  })

  it('opens the composer’s same picker for the cloud host, with the line-up descriptors and no cost line', async () => {
    renderRow()

    fireEvent.click(screen.getByRole('button', { name: /^Mô hình/ }))
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

    fireEvent.click(modelRow(card, NHAT))
    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, 'cloud', 'nhat-thuc'))
  })

  it('does not expose a connected API-key provider in the cloud card picker', async () => {
    const ownKey = {
      connectionRef: 'conn-openrouter', source: 'own_key:openrouter' as const, providerLabel: 'OpenRouter',
      model: 'private/model', modelLabel: 'Private Model', effort: 'high' as const, efforts: ['high'] as const,
      available: true
    }

    const home: MatrixAgentHomeView = {
      lives: { kind: 'cloud' }, move: null, targets: [], issue: null,
      placement: {
        profile: 'atum.agent-home/2.5', moveAvailable: false, current: 'cloud', reachability: 'reachable',
        currentModel: ownKey,
        destinations: [{ id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 1, models: [ownKey] }]
      }
    }

    renderRow(view([choice()]), { home })
    fireEvent.click(screen.getByRole('button', { name: /^Mô hình/ }))
    const card = await dialog()

    expect(card.querySelector('[data-matrix-model-rail-item="openrouter"]')).toBeNull()
    expect(card.textContent).not.toContain('Private Model')
  })

  it('opens the same picker for a Mac host and writes the chosen Atum model for that destination', async () => {
    renderRow(view(), { cloudOnly: false })
    fireEvent.click(destinationButton('mac'))
    const card = await dialog()

    expect(card.querySelector('[data-matrix-model-rail]')).toBeTruthy()
    expect(modelRow(card, NHAT).getAttribute('aria-current')).toBe('true')

    fireEvent.click(modelRow(card, NGUYET))

    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, MAC, 'nguyet-thuc'))
    await waitFor(() =>
      expect(
        within(destinationButton('mac')).getByText('Nguyệt Thực 1.3')
      ).toBeTruthy()
    )
  })

  it('keeps the shared picker open inside the assistant card while its search, star, and selection are used', async () => {
    renderRow(view(), { inSheet: true, cloudOnly: false })
    fireEvent.click(destinationButton('mac'))
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
    const rendered = renderRow(initial, { inSheet: true, cloudOnly: false })
    fireEvent.click(destinationButton('mac'))
    const card = await dialog()

    // Snapshot/model refreshes produce new projection objects even when this destination is
    // unchanged. That background re-render must not tear down an interaction already in flight.
    rendered.rerender(rowSurface(view(initial.choices.map(each => ({ ...each }))), undefined, true, true, false))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mô hình' })).toBe(card))

    fireEvent.click(modelRow(card, NGUYET))
    await waitFor(() => expect(write).toHaveBeenCalledWith(AGENT, MAC, 'nguyet-thuc'))
    expect(screen.getByRole('dialog', { name: 'Mô hình' })).toBe(card)
  })

  it('keeps the cloud to what the server offers: Nhật Thực is “Sắp có” until dispatch serves it', async () => {
    renderRow(view([choice({ models: ['nguyet-thuc'], unavailable: ['nhat-thuc'] })]))
    fireEvent.click(screen.getByRole('button', { name: /^Mô hình/ }))
    const card = await dialog()

    expect(modelRow(card, NHAT).disabled).toBe(true)
    expect(modelRow(card, NHAT).textContent).toMatch(/Sắp có/)
    fireEvent.click(modelRow(card, NHAT))
    expect(write).not.toHaveBeenCalled()
  })

  it('shows connected account subscriptions in the cloud through the native model choice', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /^Mô hình/ }))
    const card = await dialog()

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

    renderRow(view(), { cloudOnly: false })
    fireEvent.click(destinationButton('mac'))
    const card = await dialog()

    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail-item="favorites"]')!)
    expect(
      [...card.querySelectorAll('[data-matrix-model-route]')].map(row => row.getAttribute('data-matrix-model-route'))
    ).toEqual([NGUYET])
  })

  it('reverts quietly when the server refuses the choice', async () => {
    renderRow(view(), { cloudOnly: false })
    write.mockResolvedValueOnce({ status: 'refused' })
    fireEvent.click(destinationButton('mac'))
    const card = await dialog()

    fireEvent.click(modelRow(card, NGUYET))

    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(
      within(destinationButton('mac')).getByText('Nhật Thực 1.1')
    ).toBeTruthy()
  })

  it('keeps every destination’s value readable while another row’s picker is open', async () => {
    renderRow(view(), { cloudOnly: false })
    fireEvent.click(destinationButton('cloud'))
    await dialog()

    const mac = destinationButton('mac')
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

    expect(within(screen.getByRole('button', { name: /^Mô hình/ })).getByText('OpenCode Go · GLM-5.2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Mô hình/ }))
    const card = await dialog()

    fireEvent.click(modelRow(card, matrixModelRouteId('opencode-go', 'kimi-k3')))

    await waitFor(() => expect(writeSubscription).toHaveBeenCalledWith(AGENT, 'opencode_go', 'kimi-k3', 'medium'))
    expect(chooseHome).not.toHaveBeenCalled()
  })

  it('takes the destination default from the fresh read, not only the snapshot', async () => {
    renderRow(view(), { fresh: view([choice({ current: 'nhat-thuc', recommended: false })]) })

    await waitFor(() =>
      expect(within(screen.getByRole('button', { name: /^Mô hình/ })).getByText('Nhật Thực 1.1')).toBeTruthy()
    )
  })
})
