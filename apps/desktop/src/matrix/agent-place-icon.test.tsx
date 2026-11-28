import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import type { WorkAgentPlans } from '../../shared/matrix-work'
import type { WorkRelayMachine } from '../../shared/matrix-work-relay'

import { AgentPlaceFor, agentPlacePlansKey, resetAgentPlaceReadsForTests } from './agent-place-icon'
import {
  $agentPlans,
  beginAgentPlansRead,
  bindAgentPlansAccount,
  resetAgentPlansForTests,
  settleAgentPlansRead
} from './agent-plans-store'
import { MatrixRosterConversations } from './roster-conversations'

const owner = '@owner:test'
const mini: WorkRelayMachine = { id: 'svc-mini', name: 'Mac mini', kind: 'mac-mini', online: true }
const air: WorkRelayMachine = { id: 'svc-air', name: 'MacBook Air', kind: 'laptop', online: true }

function plansFor(selection: WorkAgentPlans['selection'], machines: readonly WorkRelayMachine[]): WorkAgentPlans {
  return { published: true, plans: { claude: { state: 'connected' } }, selection, machines: { claude: machines } }
}

const onPlan = (model: string): WorkAgentPlans['selection'] => ({ provider: 'atum-work', plan: 'claude', model, revision: 1 })

function agent(principal: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView {
  return { principal, userId: `@${principal}:test`, name: principal, isDefault: false, ready: true, hermes: 'ready', atumModel: true, answering: 'cloud', ...extra }
}

function bridge(readAgentPlans: (principal: string) => Promise<WorkAgentPlans | null>) {
  window.atumMatrix = { command: vi.fn(async () => undefined), work: { readAgentPlans } } as unknown as MatrixUiBridge
}

beforeEach(() => {
  resetAgentPlansForTests()
  resetAgentPlaceReadsForTests()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const wrap = (node: React.ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {node}
  </I18nProvider>
)

describe('AgentPlaceFor', () => {
  it('draws the cloud with its label for an agent on an Atum model', async () => {
    bridge(async () => plansFor(null, [mini]))
    const view = render(wrap(<AgentPlaceFor accountUserId={owner} agent={agent('moon')} labelId="place" />))

    await waitFor(() => expect(view.container.querySelector('[data-agent-place="cloud"]')).toBeTruthy())
    expect(view.container.querySelector('#place')?.textContent).toBe('Working in the cloud')
  })

  it('draws the serving Mac with the picker’s machine icon, dimmed while it is off', async () => {
    bridge(async () => plansFor(onPlan('opus'), [{ ...mini, online: false }]))
    const view = render(wrap(<AgentPlaceFor accountUserId={owner} agent={agent('moon')} labelId="place" />))

    const icon = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-agent-place="mac"]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(icon.dataset.agentPlaceMachine).toBe('mac-mini')
    expect(icon.dataset.agentPlaceOnline).toBe('false')
    expect(icon.querySelector('svg')?.getAttribute('class')).toContain('opacity-40')
    expect(view.container.querySelector('#place')?.textContent).toBe('Works on Mac mini, which is off')
  })

  it('draws nothing while unknown: before the read, after a failed read, with two Macs on', async () => {
    let settle: (value: WorkAgentPlans | null) => void = () => undefined
    bridge(() => new Promise(resolve => (settle = resolve)))
    const view = render(wrap(<AgentPlaceFor accountUserId={owner} agent={agent('moon')} />))

    expect(view.container.querySelector('[data-agent-place]')).toBeNull()
    await act(async () => settle(plansFor(onPlan('opus'), [mini, air])))
    expect(view.container.querySelector('[data-agent-place]')).toBeNull()
    expect(view.container.textContent).toBe('')
  })

  it('reuses the pickers’ shared entry and reads once for many surfaces', async () => {
    const read = vi.fn(async () => plansFor(null, []))
    bridge(read)
    const key = agentPlacePlansKey(owner, 'moon')
    const started = beginAgentPlansRead(key)
    settleAgentPlansRead(started, plansFor(onPlan('opus'), [air]))

    const view = render(
      wrap(
        <>
          <AgentPlaceFor accountUserId={owner} agent={agent('moon')} />
          <AgentPlaceFor accountUserId={owner} agent={agent('moon')} />
        </>
      )
    )

    // The entry already says MacBook Air; the one background read then settles (cloud here).
    expect(read).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(view.container.querySelectorAll('[data-agent-place="cloud"]')).toHaveLength(2))
    expect(Object.keys($agentPlans.get())).toEqual([key])
  })

  it('reads again when the account is bound after its first read began, and draws the place', async () => {
    // The window's first rows can read before the snapshot binds the account; the binding retires that read.
    let first: (value: WorkAgentPlans) => void = () => {}
    const read = vi
      .fn<(principal: string) => Promise<WorkAgentPlans | null>>()
      .mockImplementationOnce(() => new Promise(resolve => (first = resolve)))
      .mockImplementation(async () => plansFor(null, [mini]))
    bridge(read)
    const view = render(wrap(<AgentPlaceFor accountUserId={owner} agent={agent('moon')} />))

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    act(() => bindAgentPlansAccount(owner))
    await act(async () => first(plansFor(null, [mini])))

    await waitFor(() => expect(view.container.querySelector('[data-agent-place="cloud"]')).toBeTruthy())
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads nothing for an agent this Mac answers for and draws nothing', () => {
    const read = vi.fn(async () => plansFor(null, []))
    bridge(read)
    const view = render(wrap(<AgentPlaceFor accountUserId={owner} agent={agent('moon', { macRole: 'answering' })} />))

    expect(read).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-agent-place]')).toBeNull()
  })
})

describe('the roster row', () => {
  function snapshot(): MatrixSnapshot {
    return {
      state: 'ready',
      identity: { userId: owner, deviceId: 'OWNER' },
      ownProfile: { userId: owner, displayName: 'Owner', avatarMxc: null },
      agents: [agent('sky', { name: 'Sky' }), agent('mini', { name: 'Mini' }), agent('lap', { name: 'Lap' })],
      rooms: ['sky', 'mini', 'lap'].map(principal => ({
        id: `!${principal}:test`,
        name: principal,
        membership: 'join' as const,
        encrypted: true,
        roomType: MATRIX_ASSISTANT_ROOM_TYPE,
        agentPrincipal: principal,
        participants: [
          { userId: owner, membership: 'join' as const },
          { userId: `@${principal}:test`, membership: 'join' as const }
        ]
      }))
    } as MatrixSnapshot
  }

  it('shows each assistant’s place after its name and names it to screen readers', async () => {
    bridge(async principal =>
      principal === 'sky'
        ? plansFor(null, [mini])
        : principal === 'mini'
          ? plansFor(onPlan('opus'), [mini])
          : plansFor(onPlan('opus'), [{ ...mini, online: false }, air])
    )

    const view = render(
      wrap(
        <MatrixRosterConversations
          assistantOpening={false}
          cloudOnly
          fail={vi.fn()}
          onOpen={vi.fn()}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          snapshot={snapshot()}
        />
      )
    )

    const row = (principal: string) => view.container.querySelector<HTMLElement>(`[data-matrix-agent="${principal}"]`)!

    await waitFor(() => expect(row('lap').querySelector('[data-agent-place]')).toBeTruthy())
    expect(row('sky').querySelector('[data-roster-name] [data-agent-place]')?.getAttribute('data-agent-place')).toBe('cloud')
    expect(row('mini').querySelector('[data-agent-place]')?.getAttribute('data-agent-place-machine')).toBe('mac-mini')
    expect(row('lap').querySelector('[data-agent-place]')?.getAttribute('data-agent-place-machine')).toBe('laptop')

    const button = row('mini').querySelector<HTMLElement>('[data-roster-row]')!
    const described = (button.getAttribute('aria-describedby') ?? '').split(' ').map(id => window.document.getElementById(id)?.textContent)
    expect(described).toContain('Working on Mac mini')
    // Icon only: the words are for screen readers, never shown in the row.
    expect(row('mini').querySelector('[data-roster-name] .sr-only')?.textContent).toBe('Working on Mac mini')
  })
})
