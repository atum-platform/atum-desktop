import { describe, expect, it } from 'vitest'

import type { MatrixAgentHomeView } from '../../shared/matrix'
import type { WorkAgentPlans } from '../../shared/matrix-work'
import type { WorkRelayMachine, WorkRelaySelection } from '../../shared/matrix-work-relay'

import { agentPlace } from './agent-place'
import { agentPlaceLabel } from './agent-place-copy'

const cloudAgent = { answering: 'cloud' as const }

const mini: WorkRelayMachine = { id: 'svc-mini', name: 'Mac mini', kind: 'mac-mini', online: true }
const air: WorkRelayMachine = { id: 'svc-air', name: 'MacBook Air', kind: 'laptop', online: true }

function plans(machines: readonly WorkRelayMachine[], plan: 'codex' | 'claude' = 'claude'): WorkAgentPlans {
  return { published: true, plans: { [plan]: { state: 'connected' } }, selection: null, machines: { [plan]: machines } }
}

const onClaude: WorkRelaySelection = { provider: 'atum-work', plan: 'claude', model: 'claude-opus', revision: 3 }

describe('agentPlace', () => {
  it('is the cloud for a cloud agent on an Atum or connected model (no plan selection)', () => {
    expect(agentPlace({ agent: cloudAgent, plans: plans([mini]), selection: null })).toEqual({ kind: 'cloud' })
  })

  it('is the one Mac that serves the selected plan model', () => {
    expect(agentPlace({ agent: cloudAgent, plans: plans([mini]), selection: onClaude })).toEqual({
      kind: 'mac',
      name: 'Mac mini',
      machine: 'mac-mini',
      online: true
    })
  })

  it('picks the Mac that is on when another serving Mac is off', () => {
    const place = agentPlace({ agent: cloudAgent, plans: plans([{ ...mini, online: false }, air]), selection: onClaude })

    expect(place).toEqual({ kind: 'mac', name: 'MacBook Air', machine: 'laptop', online: true })
  })

  it('skips a Mac that lists models without the selected one', () => {
    const place = agentPlace({ agent: cloudAgent, plans: plans([{ ...mini, models: ['claude-haiku'] }, air]), selection: onClaude })

    expect(place).toMatchObject({ kind: 'mac', name: 'MacBook Air' })
  })

  it('names the only serving Mac, dimmed, while it is off', () => {
    expect(agentPlace({ agent: cloudAgent, plans: plans([{ ...mini, online: false }]), selection: onClaude })).toEqual({
      kind: 'mac',
      name: 'Mac mini',
      machine: 'mac-mini',
      online: false
    })
  })

  it('is unknown, never a guess, when two serving Macs are on (the cloud picks one per turn)', () => {
    expect(agentPlace({ agent: cloudAgent, plans: plans([mini, air]), selection: onClaude })).toBeUndefined()
  })

  it('is unknown when no Mac reports the selected plan, or the account read carried no Macs', () => {
    expect(agentPlace({ agent: cloudAgent, plans: plans([mini], 'codex'), selection: onClaude })).toBeUndefined()
    expect(
      agentPlace({ agent: cloudAgent, plans: { published: true, plans: {}, selection: onClaude }, selection: onClaude })
    ).toBeUndefined()
  })

  it('is unknown before the plan read settles and when it failed', () => {
    expect(agentPlace({ agent: cloudAgent, plans: undefined, selection: null })).toBeUndefined()
    expect(agentPlace({ agent: cloudAgent, plans: null, selection: null })).toBeUndefined()
  })

  it('is unknown for an agent this Mac answers for, or one off the cloud route', () => {
    expect(agentPlace({ agent: { answering: 'cloud', macRole: 'answering' }, plans: plans([mini]), selection: null })).toBeUndefined()
    expect(agentPlace({ agent: {}, plans: plans([mini]), selection: null })).toBeUndefined()
  })

  it('is the Mac an agent lives on (agent home), dimmed while that Mac sleeps', () => {
    const home = (reachability?: 'reachable' | 'asleep' | 'offline') =>
      ({
        lives: { kind: 'mac', name: 'MacBook Pro', thisMac: false },
        ...(reachability ? { placement: { reachability } } : {})
      }) as unknown as MatrixAgentHomeView

    expect(agentPlace({ agent: { home: home('reachable') }, plans: undefined, selection: null })).toEqual({
      kind: 'mac',
      name: 'MacBook Pro',
      machine: 'laptop',
      online: true
    })
    expect(agentPlace({ agent: { home: home('asleep') }, plans: undefined, selection: null })).toMatchObject({ online: false })
  })
})

describe('agentPlaceLabel', () => {
  it('says where in words, for the tooltip and screen readers', () => {
    expect(agentPlaceLabel({ kind: 'cloud' }, 'en')).toBe('Working in the cloud')
    expect(agentPlaceLabel({ kind: 'mac', name: 'Mac mini', machine: 'mac-mini', online: true }, 'en')).toBe('Working on Mac mini')
    expect(agentPlaceLabel({ kind: 'mac', name: 'Mac mini', machine: 'mac-mini', online: false }, 'en')).toBe(
      'Works on Mac mini, which is off'
    )
    expect(agentPlaceLabel({ kind: 'mac', name: '', machine: 'desktop', online: true }, 'en')).toBe('Working on a Mac')
    expect(agentPlaceLabel({ kind: 'cloud' }, 'vi')).toBe('Đang làm việc trên đám mây')
  })
})
