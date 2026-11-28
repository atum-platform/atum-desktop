import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $agentPlans, agentPlansKey, beginAgentPlansRead, resetAgentPlansForTests, settleAgentPlansRead } from '@/matrix/agent-plans-store'

import type { FirstRunLabels } from '../../../shared/first-run-labels'
import type { MatrixWorkPlanConsent, WorkAgentPlans } from '../../../shared/matrix-work'
import type { WorkRelayPlan, WorkRelaySelection } from '../../../shared/matrix-work-relay'

import {
  $firstRunJustReady,
  $firstRunLabels,
  $firstRunPick,
  bindFirstRunAccount,
  type FirstRunAgent,
  firstRunOrder,
  noteManualModelPick,
  resetFirstRunForTests,
  runFirstRunAutoPick,
  setFirstRunAutoEnabled
} from './first-run-store'

const MAC = { id: 'mac-1', name: 'MacBook', thisMac: true, named: true }
const PRIMARY = 'agent-primary'
const SECOND = 'agent-second'
const LOCAL = 'agent-local'

const CLAUDE_MODELS = [{ id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }]
const CODEX_MODELS = [{ id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' }]

function consent(state: 'on' | 'off', grantedAt?: number): MatrixWorkPlanConsent {
  return { state, agents: [], eligible: [PRIMARY, SECOND], macs: [MAC], alsoWhenScheduled: true, ...(grantedAt ? { grantedAt } : {}) }
}

/** A fake Work bridge: this Mac's plans, per-agent selections and the account consent per plan. */
function fakeWork(input: {
  labels: FirstRunLabels
  connected: Partial<Record<WorkRelayPlan, readonly { id: string; displayName: string }[]>>
  selections?: Record<string, WorkRelaySelection | null>
  consents?: Partial<Record<WorkRelayPlan, MatrixWorkPlanConsent>>
}) {
  const selections: Record<string, WorkRelaySelection | null> = { ...(input.selections ?? {}) }
  const consents: Partial<Record<WorkRelayPlan, MatrixWorkPlanConsent>> = { ...(input.consents ?? {}) }
  let revision = 10

  const plans = (principal: string): WorkAgentPlans => ({
    published: true,
    plans: Object.fromEntries(
      (['codex', 'claude', 'antigravity'] as const).map(plan => [
        plan,
        input.connected[plan] ? { state: 'connected' as const, models: input.connected[plan] } : { state: 'disconnected' as const }
      ])
    ),
    selection: selections[principal] ?? null
  })

  const bridge = {
    readPlanLabels: vi.fn(async () => input.labels),
    readAgentPlans: vi.fn(async (principal: string) => plans(principal)),
    selectRelay: vi.fn(async (principal: string, model: string, plan: WorkRelayPlan = 'codex') => {
      revision += 1
      const saved: WorkRelaySelection = { provider: 'atum-work', plan, model, revision }
      selections[principal] = saved

      return saved
    }),
    readPlanConsent: vi.fn(async (plan?: WorkRelayPlan) => consents[plan ?? 'codex'] ?? consent('off')),
    setPlanConsent: vi.fn(async (_input: unknown, plan?: WorkRelayPlan) => {
      consents[plan ?? 'codex'] = consent('on', 1)

      return consents[plan ?? 'codex']!
    })
  }

  return { bridge, selections, consents, input }
}

const AGENTS: FirstRunAgent[] = [
  { principal: SECOND, isDefault: false, cloud: true },
  { principal: LOCAL, isDefault: false, cloud: false },
  { principal: PRIMARY, isDefault: true, cloud: true }
]

beforeEach(() => {
  resetFirstRunForTests()
  resetAgentPlansForTests()
  window.localStorage.clear()
  bindFirstRunAccount('@an:atum.chat')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('first-run automatic pick', () => {
  it('orders the primary assistant first, then the cloud roster', () => {
    expect(firstRunOrder(AGENTS).map(agent => agent.principal)).toEqual([PRIMARY, SECOND])
  })

  it('picks Claude Sonnet per the table, records consent, and writes the primary before the roster', async () => {
    const work = fakeWork({ labels: { claude: { state: 'ready', label: 'Claude Pro' } }, connected: { claude: CLAUDE_MODELS } })

    const result = await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect(result).toMatchObject({ status: 'done', pick: { kind: 'plan', plan: 'claude', model: 'claude-sonnet-5-5' }, wrote: [PRIMARY, SECOND] })
    expect(work.bridge.setPlanConsent).toHaveBeenCalledWith({ agents: [PRIMARY, SECOND], macs: ['mac-1'], alsoWhenScheduled: true }, 'claude')
    expect(work.bridge.selectRelay.mock.calls.map(call => call[0])).toEqual([PRIMARY, SECOND])
    expect($firstRunPick.get()).toEqual({ kind: 'plan', plan: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('moves every mounted picker chip for the agent at once', async () => {
    const key = agentPlansKey('room-1', PRIMARY)
    settleAgentPlansRead(beginAgentPlansRead(key), { published: true, plans: {}, selection: null })
    const work = fakeWork({ labels: { claude: { state: 'ready', label: 'Claude Pro' } }, connected: { claude: CLAUDE_MODELS } })

    await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect($agentPlans.get()[key]?.value?.selection).toMatchObject({ plan: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('never overrides a hand pick or a selection this Mac did not write', async () => {
    noteManualModelPick(PRIMARY)

    const work = fakeWork({
      labels: { claude: { state: 'ready', label: 'Claude Max' } },
      connected: { claude: CLAUDE_MODELS, codex: CODEX_MODELS },
      selections: { [SECOND]: { provider: 'atum-work', plan: 'codex', model: 'gpt-6.2-sol', revision: 3 } }
    })

    const result = await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect(result.wrote).toEqual([])
    expect(work.bridge.selectRelay).not.toHaveBeenCalled()
  })

  it('leaves an OpenCode Go or ChatGPT cloud choice someone made', async () => {
    const work = fakeWork({ labels: { claude: { state: 'ready' } }, connected: { claude: CLAUDE_MODELS } })

    const agents: FirstRunAgent[] = [
      { principal: PRIMARY, isDefault: true, cloud: true, cloudModel: { offered: [], subscription: { source: 'opencode_go', model: 'x', effort: 'medium', displayName: 'X' } } }
    ]

    expect((await runFirstRunAutoPick({ work: work.bridge, agents })).wrote).toEqual([])
  })

  it('never re-grants a plan the owner stopped using; the next plan wins', async () => {
    const work = fakeWork({
      labels: { claude: { state: 'ready', label: 'Claude Pro' }, codex: { state: 'ready', label: 'ChatGPT Plus' } },
      connected: { claude: CLAUDE_MODELS, codex: CODEX_MODELS },
      consents: { claude: consent('off', 1_700_000_000_000) }
    })

    const result = await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect(result.pick).toEqual({ kind: 'plan', plan: 'codex', model: 'gpt-6.2-sol' })
    expect(work.bridge.setPlanConsent).toHaveBeenCalledTimes(1)
    expect(work.bridge.setPlanConsent.mock.calls[0]?.[1]).toBe('codex')
  })

  it('does nothing with the switch off', async () => {
    setFirstRunAutoEnabled(false)
    const work = fakeWork({ labels: { claude: { state: 'ready' } }, connected: { claude: CLAUDE_MODELS } })

    expect((await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })).status).toBe('off')
    expect(work.bridge.selectRelay).not.toHaveBeenCalled()
  })

  it('after Connect: the row turns Ready and the default re-picks over its own earlier pick', async () => {
    vi.useFakeTimers()
    const work = fakeWork({ labels: { codex: { state: 'ready', label: 'ChatGPT Plus' } }, connected: { codex: CODEX_MODELS } })

    await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })
    expect(work.selections[PRIMARY]).toMatchObject({ plan: 'codex' })

    // The person connects Claude: T3 now reports it signed in.
    work.input.labels.claude = { state: 'ready', label: 'Claude Pro' }
    work.input.connected.claude = CLAUDE_MODELS
    const result = await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect($firstRunLabels.get()?.claude?.state).toBe('ready')
    expect($firstRunJustReady.get().has('claude')).toBe(true)
    expect(result.wrote).toEqual([PRIMARY, SECOND])
    expect(work.selections[PRIMARY]).toMatchObject({ plan: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('writes OpenCode Go through the cloud model choice when it is the only paid connection', async () => {
    const work = fakeWork({ labels: {}, connected: {} })
    const writeSubscription = vi.fn(async (_agent: string, _source: 'opencode_go', _model: string, _effort: 'low' | 'medium' | 'high') => ({ status: 'saved' as const }))

    const subscriptions = {
      status: async () => ({
        scope: 'account' as const,
        providers: [{ id: 'opencode-go' as const, connected: true, models: ['deepseek-v4.1-flash', 'muse-spark-1.3'] }]
      })
    }

    const result = await runFirstRunAutoPick({ work: work.bridge, subscriptions, writeSubscription, agents: AGENTS })

    expect(result.pick).toEqual({ kind: 'opencode_go', model: 'deepseek-v4.1-flash' })
    expect(writeSubscription.mock.calls.map(call => call[0])).toEqual([PRIMARY, SECOND])
  })

  it('keeps Atum when nothing usable is connected (free plan only)', async () => {
    const work = fakeWork({ labels: { codex: { state: 'ready', label: 'ChatGPT Free' } }, connected: { codex: CODEX_MODELS } })

    const result = await runFirstRunAutoPick({ work: work.bridge, agents: AGENTS })

    expect(result).toMatchObject({ status: 'done', pick: { kind: 'atum' }, wrote: [] })
  })
})
