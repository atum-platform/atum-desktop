import { beforeEach, describe, expect, it } from 'vitest'

import type { WorkAgentPlans } from '../../shared/matrix-work'

import {
  $agentPlans,
  acknowledgeAgentPlanCleared,
  acknowledgeAgentPlanSelection,
  agentPlansKey,
  agentPlansShownSelection,
  beginAgentPlansRead,
  beginAgentPlansWrite,
  bindAgentPlansAccount,
  failAgentPlansWrite,
  resetAgentPlansForTests,
  settleAgentPlansRead
} from './agent-plans-store'

const KEY = agentPlansKey('account:@owner:test', 'agent-1')

const opus = (revision: number) => ({ provider: 'atum-work' as const, plan: 'claude' as const, model: 'claude-opus-5-5', revision })
const astra = (revision: number) => ({ provider: 'atum-work' as const, plan: 'codex' as const, model: 'gpt-6.2-astra', revision })

const plans = (selection: WorkAgentPlans['selection']): WorkAgentPlans => ({
  published: true,
  plans: { claude: { state: 'connected' }, codex: { state: 'connected' } },
  selection
})

const selection = () => $agentPlans.get()[KEY]?.value?.selection

beforeEach(() => {
  resetAgentPlansForTests()
  bindAgentPlansAccount('@owner:test')
})

describe('the shared Mac-plan view', () => {
  it('keeps the plan cleared when an older plan acknowledgement arrives after the Atum write that cleared it', () => {
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(astra(1)))

    // A pick of Opus starts, then an Atum pick starts; the Atum write is acknowledged first.
    const pick = beginAgentPlansWrite(KEY)
    const atum = beginAgentPlansWrite(KEY)
    acknowledgeAgentPlanCleared(atum)
    expect(selection()).toBeNull()

    acknowledgeAgentPlanSelection(pick, opus(2))
    expect(selection()).toBeNull()
  })

  it('lets no read at or below the cleared revision resurrect the plan, and shows a newer pick', () => {
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
    acknowledgeAgentPlanCleared(beginAgentPlansWrite(KEY))
    expect(selection()).toBeNull()

    // A read begun after the clear still answers with the old selection (a lagging replica).
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
    expect(selection()).toBeNull()

    // A real new pick has a higher revision on the server.
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(astra(3)))
    expect(selection()).toEqual(astra(3))
  })

  it('drops a read begun before an acknowledged write, whichever picker started either', () => {
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
    const read = beginAgentPlansRead(KEY)
    acknowledgeAgentPlanCleared(beginAgentPlansWrite(KEY))
    settleAgentPlansRead(read, plans(opus(2)))
    expect(selection()).toBeNull()
  })

  it('empties on sign-out and ignores reads and writes begun in the earlier session, even for the same person', () => {
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
    const read = beginAgentPlansRead(KEY)
    const write = beginAgentPlansWrite(KEY)

    bindAgentPlansAccount(null)
    expect($agentPlans.get()).toEqual({})

    bindAgentPlansAccount('@owner:test')
    settleAgentPlansRead(read, plans(opus(2)))
    acknowledgeAgentPlanSelection(write, opus(3))
    expect($agentPlans.get()[KEY]).toBeUndefined()

    // The new session's own read is kept.
    settleAgentPlansRead(beginAgentPlansRead(KEY), plans(astra(4)))
    expect(selection()).toEqual(astra(4))
  })

  describe('a write in flight (owner 2026-11-27: closing the picker flashed the old model)', () => {
    const shown = () => agentPlansShownSelection($agentPlans.get()[KEY])

    it('names the pick from the moment it starts, and drops a read that settles while it is out', () => {
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(null))
      const write = beginAgentPlansWrite(KEY, { kind: 'select', plan: 'claude', model: 'claude-opus-5-5' })
      expect(shown()).toMatchObject({ plan: 'claude', model: 'claude-opus-5-5' })

      // The picker closing re-reads after the write started; the server still answers with no plan.
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(null))
      expect(shown()).toMatchObject({ model: 'claude-opus-5-5' })

      acknowledgeAgentPlanSelection(write, opus(1))
      expect(shown()).toEqual(opus(1))
      expect($agentPlans.get()[KEY]?.pending).toBeUndefined()
    })

    it('drops a read begun before the write even when it settles after the acknowledgement', () => {
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(null))
      const late = beginAgentPlansRead(KEY)
      const write = beginAgentPlansWrite(KEY, { kind: 'select', plan: 'codex', model: 'gpt-6.2-astra' })
      acknowledgeAgentPlanSelection(write, astra(1))
      settleAgentPlansRead(late, plans(null))
      expect(shown()).toEqual(astra(1))
    })

    it('shows what the server last said again when the write fails', () => {
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
      const write = beginAgentPlansWrite(KEY, { kind: 'select', plan: 'codex', model: 'gpt-6.2-astra' })
      expect(shown()).toMatchObject({ model: 'gpt-6.2-astra' })
      failAgentPlansWrite(write)
      expect(shown()).toEqual(opus(2))

      // Nothing is in flight any more, so reads apply again.
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(astra(3)))
      expect(shown()).toEqual(astra(3))
    })

    it('names no plan while an Atum write that clears it is in flight, and the latest-started write wins', () => {
      settleAgentPlansRead(beginAgentPlansRead(KEY), plans(opus(2)))
      const pick = beginAgentPlansWrite(KEY, { kind: 'select', plan: 'codex', model: 'gpt-6.2-astra' })
      const clear = beginAgentPlansWrite(KEY, { kind: 'clear' })
      expect(shown()).toBeNull()

      acknowledgeAgentPlanCleared(clear)
      acknowledgeAgentPlanSelection(pick, astra(3))
      expect(shown()).toBeNull()
      expect($agentPlans.get()[KEY]?.pending).toBeUndefined()
    })
  })
})
