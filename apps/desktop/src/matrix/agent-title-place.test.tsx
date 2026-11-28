import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtumMainHeaderSurface } from '@/app/atum/shell-surface'
import { I18nProvider } from '@/i18n'

import type { MatrixAgentHomeBridge, MatrixAgentHomeView, MatrixAgentView, MatrixUiBridge } from '../../shared/matrix'
import type { WorkAgentPlans } from '../../shared/matrix-work'
import type { WorkRelayMachine } from '../../shared/matrix-work-relay'

import { MatrixAgentTitlePlace } from './agent-home-control'
import { resetAgentPlaceReadsForTests } from './agent-place-icon'
import { resetAgentPlansForTests } from './agent-plans-store'

/** The title bar's place icon beside the assistant's name (owner 2026-11-28): one icon, every assistant. */

const owner = '@owner:test'
const mini: WorkRelayMachine = { id: 'svc-mini', name: 'Mac mini', kind: 'mac-mini', online: true }
const air: WorkRelayMachine = { id: 'svc-air', name: 'MacBook Air', kind: 'laptop', online: true }
const MAC = 'mac-mini-home'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

function agent(extra: Partial<MatrixAgentView> = {}): MatrixAgentView {
  return {
    principal: 'luna',
    userId: '@luna:test',
    name: 'Luna',
    title: 'Research',
    isDefault: false,
    ready: true,
    hermes: 'ready',
    atumModel: true,
    answering: 'cloud',
    ...extra
  }
}

const onPlan = (machines: readonly WorkRelayMachine[]): WorkAgentPlans => ({
  published: true,
  plans: { claude: { state: 'connected' } },
  selection: { provider: 'atum-work', plan: 'claude', model: 'claude-opus', revision: 1 },
  machines: { claude: machines }
})

function macHome(moving = false): MatrixAgentHomeView {
  return {
    lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
    move: moving ? { step: 'saving', to: { kind: 'cloud' }, role: 'other' } : null,
    targets: [],
    issue: null,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: true,
      current: MAC,
      reachability: 'reachable',
      modelStatus: 'applied',
      destinations: [
        { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [] },
        { id: MAC, kind: 'mac', name: 'Mac mini', thisMac: false, eligibility: 'ready', catalogRevision: 1, models: [] }
      ]
    }
  } as unknown as MatrixAgentHomeView
}

function homeBridge(view: MatrixAgentHomeView): MatrixAgentHomeBridge {
  return {
    read: vi.fn(async () => view),
    preflight: vi.fn(),
    move: vi.fn(),
    cancel: vi.fn(),
    model: vi.fn(),
    prepare: vi.fn()
  } as unknown as MatrixAgentHomeBridge
}

function plans(value: WorkAgentPlans | null) {
  const readAgentPlans = vi.fn(async () => value)
  window.atumMatrix = { command: vi.fn(async () => undefined), work: { readAgentPlans } } as unknown as MatrixUiBridge

  return readAgentPlans
}

/** The window's real title-bar leaf with the chat's name button, as app.tsx lays it out. */
function titleBar(shown: MatrixAgentView, home?: MatrixAgentHomeBridge) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AtumMainHeaderSurface leadsRow={false} reserveOverlay={false}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5" data-matrix-header-identity>
          <button aria-describedby="matrix-header-agent-place" data-matrix-header-card type="button">
            <span>{shown.name}</span>
          </button>
          <span data-matrix-title-place>
            <MatrixAgentTitlePlace
              accountUserId={owner}
              agent={shown}
              bridge={home}
              cloudOnly
              labelId="matrix-header-agent-place"
            />
          </span>
          <span data-matrix-agent-title>{shown.title}</span>
        </div>
      </AtumMainHeaderSurface>
    </I18nProvider>
  )
}

beforeEach(() => {
  resetAgentPlansForTests()
  resetAgentPlaceReadsForTests()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const slot = () => document.querySelector<HTMLElement>('[data-matrix-title-place]')!

describe('the title bar place icon', () => {
  it('draws the cloud beside a cloud-only assistant’s name and names it to screen readers', async () => {
    plans({ published: true, plans: {}, selection: null })
    titleBar(agent({ home: { lives: { kind: 'cloud' }, move: null, targets: [], issue: null } as MatrixAgentHomeView }), homeBridge(macHome()))

    await waitFor(() => expect(slot().querySelector('[data-agent-place="cloud"]')).toBeTruthy())
    // One icon, no move-era control: the cloud-only hiding (293b202d) no longer hides the place.
    expect(document.querySelectorAll('[data-atum-main-header] svg')).toHaveLength(1)
    expect(document.querySelector('[data-matrix-agent-home]')).toBeNull()
    expect(document.getElementById('matrix-header-agent-place')?.textContent).toBe('Working in the cloud')
    // Right after the name, before the title.
    const card = document.querySelector('[data-matrix-header-card]')!
    expect(card.nextElementSibling).toBe(slot())
    expect(slot().nextElementSibling?.hasAttribute('data-matrix-agent-title')).toBe(true)
  })

  it.each([
    ['Mac mini', mini, 'mac-mini', 'Working on Mac mini'],
    ['MacBook Air', air, 'laptop', 'Working on MacBook Air']
  ])('draws the %s it is working on with the picker’s machine icon', async (_name, machine, kind, label) => {
    plans(onPlan([machine]))
    titleBar(agent())

    await waitFor(() => expect(slot().querySelector(`[data-agent-place-machine="${kind}"]`)).toBeTruthy())
    expect(slot().querySelector('[data-agent-place-online]')?.getAttribute('data-agent-place-online')).toBe('true')
    expect(document.getElementById('matrix-header-agent-place')?.textContent).toBe(label)
  })

  it('dims a Mac that is off and says so', async () => {
    plans(onPlan([{ ...mini, online: false }]))
    titleBar(agent())

    await waitFor(() => expect(slot().querySelector('[data-agent-place-online="false"]')).toBeTruthy())
    expect(slot().querySelector('svg')?.getAttribute('class')).toContain('opacity-40')
    expect(document.getElementById('matrix-header-agent-place')?.textContent).toMatch(/Mac mini, which is off/)
  })

  it('draws nothing while the place is unknown', async () => {
    const read = plans(onPlan([mini, air]))
    titleBar(agent())

    await waitFor(() => expect(read).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(slot().childElementCount).toBe(0)
  })

  it('is the move-era popover trigger for a Mac home, still one icon, with the Mac’s own glyph', async () => {
    plans(null)
    const home = macHome(true)
    titleBar(agent({ home, answering: 'cloud' }), homeBridge(home))

    const trigger = await waitFor(() => {
      const found = slot().querySelector<HTMLElement>('[data-matrix-agent-home]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(document.querySelectorAll('[data-atum-main-header] svg')).toHaveLength(1)
    expect(slot().querySelector('[data-agent-place]')).toBeNull()
    expect(trigger.querySelector('[data-agent-home-moving]')).toBeTruthy()

    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector('[data-agent-home-popover]')).toBeTruthy())
  })
})
