import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixRoom,
  MatrixUiBridge
} from '../../shared/matrix'
import { type MatrixCloudModelChoiceView, matrixModelRouteId } from '../../shared/matrix-models'
import { matrixShelfModelView, type MatrixShelfModelView } from '../../shared/matrix-shelf-models'

import { MatrixModelPicker } from './model-picker'

/**
 * The OpenRouter shelf in the one model picker (owner 2026-11-09/11-10): its own rail entry, only
 * the platform's active rows, each with its Proton price, and a pick through the cloud's own write.
 */

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

const ROOM: MatrixRoom = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
const RAIL = 'atum-openrouter'
const OPUS_ROUTE = matrixModelRouteId(RAIL, 'opus')
const GLM_ROUTE = matrixModelRouteId(RAIL, 'glm')
const NGUYET_THUC_ROUTE = matrixModelRouteId('atum', 'nguyet-thuc')

const shelf = (
  alias: string,
  displayName: string,
  providerModel: string,
  input: string,
  output: string,
  efforts: string[] = ['low', 'medium', 'high']
): MatrixShelfModelView =>
  matrixShelfModelView({
    alias,
    displayName,
    providerModel,
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    efforts,
    defaultEffort: 'high'
  })!

const OPUS = shelf('opus', 'Anthropic: Claude Opus 5.5', 'anthropic/claude-opus-5.5', '4', '20')
const GLM = shelf('glm', 'Z.ai: GLM 5.3 Flash', 'z-ai/glm-5.3-flash', '0.0335', '0.083', ['low', 'high'])

const offer = (current = 'default', models: MatrixShelfModelView[] = [OPUS, GLM]): MatrixCloudModelChoiceView => ({
  offered: ['default', 'nhat-thuc', ...models.map(each => each.alias)],
  current,
  ...(models.length ? { shelf: models } : {})
})

function picker(
  options: {
    cloudChoice?: MatrixCloudModelChoiceView
    here?: 'cloud' | 'this_mac'
    home?: MatrixAgentHomeView
    agentHome?: MatrixAgentHomeBridge
    command?: MatrixUiBridge['command']
    locale?: 'en' | 'vi'
  } = {}
) {
  const command = options.command ?? vi.fn(async () => ({ status: 'applied' as const }))
  window.atumMatrix = {
    command,
    ...(options.agentHome ? { agentHome: options.agentHome } : {})
  } as unknown as MatrixUiBridge

  const view = (cloudChoice = options.cloudChoice) => (
    <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
      <MatrixModelPicker
        agentPrincipal={options.home ? 'agent-luna' : undefined}
        cloud
        cloudChoice={cloudChoice}
        disabled={false}
        fail={vi.fn()}
        here={options.here ?? 'cloud'}
        home={options.home}
        local={false}
        managed
        room={ROOM}
      />
    </I18nProvider>
  )

  const rendered = render(view())

  return { command, rerender: (cloudChoice: MatrixCloudModelChoiceView) => rendered.rerender(view(cloudChoice)) }
}

const open = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }))

  return screen.findByRole('dialog', { name: /^(Model|Mô hình)$/ })
}

const rail = (card: HTMLElement, id: string) =>
  card.querySelector<HTMLButtonElement>(`[data-matrix-model-rail-item="${id}"]`)

const rowIds = (card: HTMLElement) =>
  Array.from(card.querySelectorAll<HTMLButtonElement>('[data-matrix-model-route]')).map(
    each => each.dataset.matrixModelRoute
  )

const row = (card: HTMLElement, id: string) =>
  card.querySelector<HTMLButtonElement>(`[data-matrix-model-route="${id}"]`)!

describe('the OpenRouter shelf in the model picker', () => {
  it('has no OpenRouter rail or row while the platform offers no active shelf model (prod today)', async () => {
    picker({ cloudChoice: offer('default', []) })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rail(card, RAIL)).toBeNull()
    expect(rowIds(card).some(id => id?.startsWith(`${RAIL}:`))).toBe(false)
    expect(card.querySelector('[data-matrix-model-shelf-price]')).toBeNull()
  })

  it('lists only the active shelf models under their own rail, each with its Proton price', async () => {
    picker({ cloudChoice: offer() })
    const card = await open('Model: Nguyệt Thực 1.3')

    // The card opens on Atum's own list: shelf models never mix into it.
    expect(rowIds(card).every(id => id?.startsWith('atum:'))).toBe(true)
    expect(rail(card, RAIL)?.getAttribute('aria-label')).toMatch(/OpenRouter/)

    fireEvent.click(rail(card, RAIL)!)
    expect(rowIds(card)).toEqual([OPUS_ROUTE, GLM_ROUTE])
    expect(row(card, OPUS_ROUTE).textContent).toContain('Claude Opus 5.5')
    expect(row(card, OPUS_ROUTE).textContent).toContain('Anthropic · 162,000 / 810,000 Protons')
    expect(row(card, GLM_ROUTE).textContent).toContain('Z.ai · 1,357 / 3,362 Protons')
  })

  it('labels a model that costs more than Nhật Thực, with no confirmation step', async () => {
    const { command } = picker({ cloudChoice: offer() })
    const card = await open('Model: Nguyệt Thực 1.3')

    fireEvent.click(rail(card, RAIL)!)
    expect(row(card, OPUS_ROUTE).querySelector('[data-matrix-model-shelf-costly]')?.textContent).toBe('Costs more')
    expect(row(card, GLM_ROUTE).querySelector('[data-matrix-model-shelf-costly]')).toBeNull()
    expect(row(card, OPUS_ROUTE).getAttribute('aria-label')).toMatch(/Costs more/)

    // One click writes the choice; nothing asks again.
    fireEvent.click(row(card, OPUS_ROUTE))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'opus' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('writes a pick through the cloud’s own model choice and names it on the chip', async () => {
    const { command, rerender } = picker({ cloudChoice: offer() })
    const card = await open('Model: Nguyệt Thực 1.3')

    fireEvent.click(rail(card, RAIL)!)
    fireEvent.click(row(card, GLM_ROUTE))

    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'setModel', roomId: ROOM.id, model: 'glm' }))
    expect(screen.getByRole('button', { name: 'Model: GLM 5.3 Flash' })).toBeTruthy()
    expect(row(card, GLM_ROUTE).getAttribute('aria-current')).toBe('true')

    // The server's snapshot catches up: still one current row, and it is the shelf model.
    rerender(offer('glm'))
    expect(card.querySelectorAll('[data-matrix-model-route][aria-current="true"]')).toHaveLength(1)
    expect(row(card, GLM_ROUTE).getAttribute('aria-current')).toBe('true')
  })

  it('opens on the OpenRouter list when a shelf model is the saved cloud choice, with no Atum row checked', async () => {
    picker({ cloudChoice: offer('opus') })
    const card = await open('Model: Claude Opus 5.5')

    expect(rail(card, RAIL)?.getAttribute('aria-pressed')).toBe('true')
    expect(row(card, OPUS_ROUTE).getAttribute('aria-current')).toBe('true')

    fireEvent.click(rail(card, 'atum')!)
    expect(row(card, NGUYET_THUC_ROUTE).getAttribute('aria-current')).toBeNull()
  })

  it('offers no shelf model where this Mac answers: shelf models run in the cloud only', async () => {
    picker({ cloudChoice: offer(), here: 'this_mac' })
    const card = await open(/^Model/)

    expect(rail(card, RAIL)).toBeNull()
  })

  it('says the price the Vietnamese way', async () => {
    picker({ cloudChoice: offer(), locale: 'vi' })
    const card = await open(/^Mô hình: Nguyệt Thực/)

    fireEvent.click(rail(card, RAIL)!)
    expect(row(card, OPUS_ROUTE).textContent).toContain('Anthropic · 162.000 / 810.000 Proton')
    expect(row(card, OPUS_ROUTE).querySelector('[data-matrix-model-shelf-costly]')?.textContent).toBe('Giá cao')
  })
})

describe('the OpenRouter shelf on a cloud home (atum.agent-home/2.5)', () => {
  const atum: MatrixAgentHomeModelOption = {
    connectionRef: 'conn_atummanaged000001',
    source: 'atum',
    providerLabel: 'Atum',
    model: 'nguyet-thuc',
    modelLabel: 'Nguyệt Thực 1.3',
    effort: 'medium',
    efforts: ['medium'],
    available: true
  }

  const opus: MatrixAgentHomeModelOption = {
    ...atum,
    providerLabel: 'OpenRouter',
    model: 'opus',
    modelLabel: 'Claude Opus 5.5',
    effort: 'high',
    efforts: ['low', 'medium', 'high'],
    shelf: OPUS
  }

  const home = (models: MatrixAgentHomeModelOption[]): MatrixAgentHomeView => ({
    lives: { kind: 'cloud' },
    move: null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: 'cloud',
      reachability: 'reachable',
      currentModel: atum,
      modelStatus: 'applied',
      destinations: [
        { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models }
      ]
    }
  })

  const bridge = (model: MatrixAgentHomeBridge['model']): MatrixAgentHomeBridge => ({
    read: vi.fn(async () => undefined),
    preflight: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    move: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    cancel: vi.fn(async () => ({ ok: false })),
    model,
    prepare: vi.fn(async () => ({ ok: false }))
  })

  it('has no OpenRouter rail when the home lists no shelf model', async () => {
    picker({ home: home([atum]), agentHome: bridge(vi.fn(async () => ({ status: 'saved' as const }))) })
    const card = await open('Model: Nguyệt Thực 1.3')

    expect(rail(card, RAIL)).toBeNull()
  })

  it('chooses a shelf model through the same current-home write as Atum’s line-up', async () => {
    const model = vi.fn(async () => ({ status: 'saved' as const }))
    const { command } = picker({ home: home([atum, opus]), agentHome: bridge(model) })
    const card = await open('Model: Nguyệt Thực 1.3')

    fireEvent.click(rail(card, RAIL)!)
    expect(rowIds(card)).toEqual([OPUS_ROUTE])
    expect(row(card, OPUS_ROUTE).textContent).toContain('162,000 / 810,000 Protons')

    fireEvent.click(row(card, OPUS_ROUTE))
    expect(model).toHaveBeenCalledWith('agent-luna', expect.objectContaining({ model: 'opus', source: 'atum' }))
    expect(command).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Model: Claude Opus 5.5' })).toBeTruthy()
  })
})
