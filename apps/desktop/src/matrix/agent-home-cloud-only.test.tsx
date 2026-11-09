import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import {
  AGENT_HOMES_CLOUD_ONLY,
  cloudOnlyAllowsOrder,
  cloudOnlyLocksSwitch,
  offeredHomeKinds
} from '../../shared/agent-home-cloud-only'
import { parseExecutionPolicySnapshot } from '../../shared/execution-policy'
import savedPolicyFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'
import type { MatrixAgentHomeBridge, MatrixAgentHomeView } from '../../shared/matrix'

import { MatrixAgentHomeRow } from './agent-home-control'
import { MatrixExecutionPolicyEditor } from './execution-policy-editor'

/** Cloud-only policy: what the shipped desktop offers, with the switch as it ships. */

const AGENT = '11111111-1111-4111-8111-111111111111'
const MINI = '22222222-2222-4222-8222-222222222222'
const HERE = '33333333-3333-4333-8333-333333333333'
const MODEL = {
  connectionRef: 'conn_atummanaged000001',
  source: 'atum' as const,
  providerLabel: 'Atum',
  model: 'nguyet-thuc',
  modelLabel: 'Nguyệt Thực 1.3',
  effort: 'medium' as const,
  efforts: ['low', 'medium', 'high'] as const,
  available: true
}

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

afterEach(cleanup)

function view(current: 'cloud' | typeof MINI): MatrixAgentHomeView {
  return {
    lives: current === 'cloud' ? { kind: 'cloud' } : { kind: 'mac', name: 'Mac mini', thisMac: false },
    move: null,
    targets: [{ id: MINI, name: 'Mac mini' }],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current,
      reachability: 'reachable',
      currentModel: MODEL,
      modelStatus: 'applied',
      destinations: [
        { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [MODEL] },
        { id: MINI, kind: 'mac', name: 'Mac mini', thisMac: false, eligibility: 'ready', catalogRevision: 4, models: [MODEL] },
        { id: HERE, kind: 'mac', name: 'MacBook', thisMac: true, eligibility: 'ready', catalogRevision: 2, models: [MODEL], setUp: 'needed' }
      ]
    }
  }
}

function open(shown: MatrixAgentHomeView, cloudOnly?: boolean) {
  const bridge: MatrixAgentHomeBridge = {
    read: vi.fn(async () => shown),
    preflight: vi.fn(async () => ({
      ok: true as const,
      preflightId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      target: 'cloud',
      featureLosses: [],
      lastCheckpointAtPlatform: null,
      checkpointLossRequired: false
    })),
    move: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(async () => ({ ok: true })),
    model: vi.fn(async () => ({ status: 'saved' as const })),
    prepare: vi.fn(async () => ({ ok: true }))
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAgentHomeRow agentName="Luna" agentPrincipal={AGENT} bridge={bridge} cloudOnly={cloudOnly} view={shown} />
    </I18nProvider>
  )
  fireEvent.click(document.querySelector('[data-assistant-card-home]')!)

  return { bridge }
}

const popover = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-agent-home-popover]')
    expect(found).toBeTruthy()

    return found!
  })

describe('cloud-only S0', () => {
  it('ships on, with the cloud as the only place a home surface offers', () => {
    // Ship gate: turning cloud-only off is a release decision, not a refactor.
    expect(AGENT_HOMES_CLOUD_ONLY).toBe(true)
    expect([...offeredHomeKinds()]).toEqual(['cloud'])
    expect([...offeredHomeKinds(false)].sort()).toEqual(['cloud', 'mac'])
  })

  it('a cloud assistant is offered no Mac and no move at all', async () => {
    const { bridge } = open(view('cloud'))
    const shown = await popover()
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith(AGENT))

    expect(shown.querySelector('[data-agent-home-current]')!.textContent).toBe('The cloud')
    expect(shown.querySelector('[data-agent-home-destination]')).toBeNull()
    expect(shown.querySelector('[data-agent-home-move-options]')).toBeNull()
    expect(shown.querySelector('[data-agent-home-no-place]')).toBeNull()
    expect(shown.querySelector('[data-agent-home-line]')).toBeNull()
    expect(shown.textContent).not.toMatch(/Mac/)
    expect(bridge.prepare).not.toHaveBeenCalled()
  })

  it('an assistant on a Mac gets one quiet line and one action, Move to the cloud, and no other Mac', async () => {
    const { bridge } = open(view(MINI))
    const shown = await popover()

    expect(shown.querySelector('[data-agent-home-current]')!.textContent).toBe('Mac mini')
    expect(shown.querySelector('[data-agent-home-mac-note]')!.textContent).toBe('Assistants now live in the cloud.')
    const places = [...shown.querySelectorAll('[data-agent-home-destination]')]
    expect(places.map(each => each.getAttribute('data-agent-home-destination'))).toEqual(['cloud'])
    expect(within(shown).queryByRole('button', { name: /this Mac|MacBook/ })).toBeNull()

    const cloud = within(shown).getByRole('button', { name: 'Move to the cloud' })
    expect(cloud.textContent).toBe('Move to the cloud')
    fireEvent.click(cloud)

    await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, 'cloud', MODEL))
    await waitFor(() => expect(bridge.move).toHaveBeenCalledWith(AGENT, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false))
    expect(bridge.prepare).not.toHaveBeenCalled()
  })

  it('the dormant switch still offers the Macs (tests only)', async () => {
    open(view('cloud'), false)
    const shown = await popover()

    expect([...shown.querySelectorAll('[data-agent-home-destination]')].map(each => each.getAttribute('data-agent-home-destination'))).toEqual([
      MINI,
      HERE
    ])
    expect(shown.querySelector('[data-agent-home-line]')!.textContent).toBe('Home · moves are manual')
  })
})

describe('cloud-only S0, the legacy priority list (F1)', () => {
  it('never lets a reorder push the cloud behind a Mac, but lets it move up', () => {
    const macA = 'mac:a'
    const macB = 'mac:b'

    expect(cloudOnlyAllowsOrder(['cloud', macA, macB], [macA, 'cloud', macB])).toBe(false)
    expect(cloudOnlyAllowsOrder(['cloud', macA, macB], ['cloud', macB, macA])).toBe(true)
    expect(cloudOnlyAllowsOrder([macA, 'cloud', macB], ['cloud', macA, macB])).toBe(true)
    expect(cloudOnlyAllowsOrder([macA, 'cloud', macB], [macA, macB, 'cloud'])).toBe(false)
    expect(cloudOnlyAllowsOrder(['cloud', macA], [macA, 'cloud'], false)).toBe(true)
  })

  it('draws a turned-off Mac and a turned-on cloud as switches that cannot change', () => {
    // The fixture: a Mac first (on), then the cloud (on), then a Mac that is off.
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixExecutionPolicyEditor
          onRefresh={() => undefined}
          policy={parseExecutionPolicySnapshot(savedPolicyFixture)!}
          save={vi.fn()}
        />
      </I18nProvider>
    )

    const rows = [...document.querySelectorAll<HTMLElement>('li[data-destination-kind]')]
    const locked = rows.map(each => {
      const toggle = within(each).getByRole('switch')

      return [each.getAttribute('data-destination-kind'), each.getAttribute('data-enabled'), toggle.hasAttribute('disabled')]
    })

    expect(locked).toEqual([
      ['mac', 'true', false],
      ['cloud', 'true', true],
      ['mac', 'false', true]
    ])
  })

  it('locks only the switches that would hand the assistant to a Mac', () => {
    expect(cloudOnlyLocksSwitch('mac', false)).toBe(true)
    expect(cloudOnlyLocksSwitch('mac', true)).toBe(false)
    expect(cloudOnlyLocksSwitch('cloud', true)).toBe(true)
    expect(cloudOnlyLocksSwitch('cloud', false)).toBe(false)
    expect(cloudOnlyLocksSwitch('mac', false, false)).toBe(false)
  })
})
