import { atom } from 'nanostores'

import { acknowledgeAgentPlanSelectionForAgent } from '@/matrix/agent-plans-store'

import { type FirstRunLabels, parseFirstRunLabels } from '../../../shared/first-run-labels'
import {
  type FirstRunFacts,
  type FirstRunModel,
  type FirstRunPick,
  firstRunPick,
  type FirstRunProvider
} from '../../../shared/first-run-pick'
import type { MatrixCloudModelChoiceView } from '../../../shared/matrix-models'
import type { MatrixSubscriptionsStatus } from '../../../shared/matrix-subscriptions'
import type { MatrixWorkBridge, WorkAgentPlans } from '../../../shared/matrix-work'
import { WORK_RELAY_PLANS, type WorkRelayPlan, type WorkRelaySelection } from '../../../shared/matrix-work-relay'

import { resetFirstRunAskForTests } from './first-run-controller'
import { grantAccountPlanUse } from './store'

/**
 * First-run automatic pick (owner 2026-11-27): while the launch screen shows, read what this Mac already has, choose the
 * default (shared/first-run-pick.ts) and write it through the existing owner paths, primary assistant first, then the rest of
 * the roster. Nothing here asks: there is no card and no tap. The chip, with its provider mark, is the only signal.
 *
 * Writes reuse what the picker writes:
 * - a plan: the account consent every Connect records (`grantAccountPlanUse`, store.ts), then `work.selectRelay`
 *   (`work_selection_set`, electron/work/surface/relay.ts), acknowledged into the shared picker store;
 * - OpenCode Go: `modelDestinations.writeSubscription(…, 'opencode_go', …)` (`atum.model-choice/1.4`).
 *
 * Never overrides a person's choice:
 * - a model picked by hand in the picker (`noteManualModelPick`) is never touched again;
 * - a plan or OpenCode Go selection this Mac did not write is treated as a person's choice;
 * - a plan whose consent the owner revoked ("Stop using": `grantedAt` survives a revoke) is never re-granted;
 * - the Settings switch off stops all of it.
 * Losing this Mac's local record only makes it more careful (an automatic write then reads as a person's).
 */

export interface FirstRunAgent {
  principal: string
  isDefault: boolean
  /** Only cloud-answering assistants take a relay or cloud selection. */
  cloud: boolean
  cloudModel?: MatrixCloudModelChoiceView
}

type AutoWrite = { kind: 'plan'; plan: WorkRelayPlan; model: string; revision: number } | { kind: 'opencode_go'; model: string }

interface FirstRunRecord {
  enabled: boolean
  manual: string[]
  auto: Record<string, AutoWrite>
}

const STORAGE_PREFIX = 'atum.first-run-auto.v1:'
const EMPTY: FirstRunRecord = { enabled: true, manual: [], auto: {} }

/** This Mac's four connections as T3 reports them; `undefined` before the first read. */
export const $firstRunLabels = atom<FirstRunLabels | undefined>(undefined)
/** The account-wide OpenCode Go key connection, from the subscriptions read. */
export const $firstRunOpenCodeGo = atom<boolean>(false)
/** The last pick the automatic step made (the chip already shows it; kept for the Connections rows and tests). */
export const $firstRunPick = atom<FirstRunPick | undefined>(undefined)
/** Settings › Connections › "Pick the best plan automatically". */
export const $firstRunAutoEnabled = atom<boolean>(true)
/** Rows that just turned Ready after a Connect, for their brief tint. */
export const $firstRunJustReady = atom<ReadonlySet<FirstRunProvider>>(new Set())

let account: string | null = null
let record: FirstRunRecord = { ...EMPTY }

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function load(key: string): FirstRunRecord {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key)
    const parsed = raw ? (JSON.parse(raw) as Partial<FirstRunRecord>) : undefined

    return {
      enabled: parsed?.enabled !== false,
      manual: Array.isArray(parsed?.manual) ? parsed.manual.filter(each => typeof each === 'string') : [],
      auto: parsed?.auto && typeof parsed.auto === 'object' ? parsed.auto : {}
    }
  } catch {
    return { ...EMPTY, manual: [], auto: {} }
  }
}

function save(): void {
  if (!account) {
    return
  }

  try {
    storage()?.setItem(STORAGE_PREFIX + account, JSON.stringify(record))
  } catch {
    // Best effort: without it the next launch is only more careful.
  }
}

/** The signed-in account (its Matrix user ID). A change starts from that account's own record. */
export function bindFirstRunAccount(next: string | null): void {
  if (next === account) {
    return
  }

  account = next
  record = next ? load(next) : { ...EMPTY, manual: [], auto: {} }
  $firstRunAutoEnabled.set(record.enabled)
  $firstRunPick.set(undefined)
}

/** The picker's hand pick for this assistant: the automatic step never touches it again. */
export function noteManualModelPick(agentPrincipal: string | undefined): void {
  if (!agentPrincipal || record.manual.includes(agentPrincipal)) {
    return
  }

  record = { ...record, manual: [...record.manual, agentPrincipal] }
  save()
}

export function setFirstRunAutoEnabled(enabled: boolean): void {
  record = { ...record, enabled }
  $firstRunAutoEnabled.set(enabled)
  save()
}

/** Marks rows that turned Ready since the last read, for a short tint. */
function flagJustReady(before: FirstRunLabels | undefined, after: FirstRunLabels): void {
  if (!before) {
    return
  }

  const turned = (Object.keys(after) as FirstRunProvider[]).filter(
    provider => after[provider]?.state === 'ready' && before[provider]?.state !== 'ready'
  )

  if (!turned.length) {
    return
  }

  $firstRunJustReady.set(new Set([...$firstRunJustReady.get(), ...turned]))
  setTimeout(() => {
    const left = new Set($firstRunJustReady.get())
    turned.forEach(provider => left.delete(provider))
    $firstRunJustReady.set(left)
  }, FIRST_RUN_READY_TINT_MS)
}

export const FIRST_RUN_READY_TINT_MS = 1_600

/** Bumped when a connection changed here (a Connect finished, Settings' switch turned on): the next pass re-picks. */
export const $firstRunRepick = atom(0)

export function requestFirstRunRepick(): void {
  $firstRunRepick.set($firstRunRepick.get() + 1)
}

export type FirstRunWorkBridge = Pick<MatrixWorkBridge, 'readPlanConsent' | 'setPlanConsent'> &
  Partial<Pick<MatrixWorkBridge, 'readPlanLabels' | 'readAgentPlans' | 'selectRelay'>>

/** Read this Mac's four connections (T3's own status). A failed read keeps what is known. */
export async function loadFirstRunLabels(bridge: Partial<Pick<MatrixWorkBridge, 'readPlanLabels'>> | undefined): Promise<FirstRunLabels> {
  if (!bridge?.readPlanLabels) {
    return $firstRunLabels.get() ?? {}
  }

  try {
    const next = parseFirstRunLabels(await bridge.readPlanLabels())
    flagJustReady($firstRunLabels.get(), next)
    $firstRunLabels.set(next)

    return next
  } catch {
    return $firstRunLabels.get() ?? {}
  }
}

export async function loadFirstRunOpenCodeGo(
  subscriptions: { status(): Promise<MatrixSubscriptionsStatus> } | undefined
): Promise<{ connected: boolean; models: FirstRunModel[] }> {
  try {
    const status = subscriptions ? await subscriptions.status() : undefined
    const row = status?.providers.find(each => each.id === 'opencode-go')
    const connected = row?.connected === true

    const models = connected
      ? row?.modelDetails?.map(({ id, displayName }) => ({ id, displayName })) ??
        (row?.models ?? []).map(id => ({ id, displayName: id }))
      : []

    $firstRunOpenCodeGo.set(connected)

    return { connected, models }
  } catch {
    return { connected: $firstRunOpenCodeGo.get(), models: [] }
  }
}

export interface FirstRunAutoPickDeps {
  work: FirstRunWorkBridge | undefined
  subscriptions?: { status(): Promise<MatrixSubscriptionsStatus> }
  writeSubscription?: (
    agentPrincipal: string,
    source: 'opencode_go',
    model: string,
    effort: 'low' | 'medium' | 'high'
  ) => Promise<{ status: 'saved' | 'refused' }>
  agents: readonly FirstRunAgent[]
}

export interface FirstRunAutoPickResult {
  status: 'off' | 'unavailable' | 'done'
  pick?: FirstRunPick
  /** Assistants whose selection this run wrote, in order. */
  wrote: string[]
}

function facts(plans: WorkAgentPlans | null, labels: FirstRunLabels, opencode: FirstRunFacts['opencodeGo']): FirstRunFacts {
  return {
    published: plans?.published === true,
    plans: Object.fromEntries(
      WORK_RELAY_PLANS.map(plan => [
        plan,
        {
          connected: plans?.plans[plan]?.state === 'connected',
          ...(labels[plan]?.label ? { label: labels[plan].label } : {}),
          models: plans?.plans[plan]?.models ?? []
        }
      ])
    ),
    opencodeGo: opencode
  }
}

/** Resolve the pick, recording consent for a plan first. A plan the owner stopped (or that cannot be granted) is skipped. */
async function resolvePick(work: FirstRunWorkBridge, input: FirstRunFacts): Promise<FirstRunPick> {
  const stopped = new Set<FirstRunProvider>()

  for (;;) {
    const pick = firstRunPick(input, stopped)

    if (pick.kind !== 'plan') {
      return pick
    }

    try {
      const consent = await work.readPlanConsent(pick.plan)

      if (consent.state === 'on') {
        return pick
      }

      // A revoke keeps `grantedAt`: the owner pressed Stop using, so it is never re-granted automatically.
      if (consent.grantedAt === undefined && (await grantAccountPlanUse(work, pick.plan))) {
        return pick
      }
    } catch {
      // Unreadable consent: try the next route.
    }

    stopped.add(pick.plan)
  }
}

function ours(agent: string, selection: WorkRelaySelection | null): boolean {
  const mine = record.auto[agent]

  return !selection || (mine?.kind === 'plan' && mine.revision === selection.revision)
}

/** The ordered roster: the primary assistant first, then the rest as the roster lists them. */
export function firstRunOrder(agents: readonly FirstRunAgent[]): FirstRunAgent[] {
  return [...agents.filter(agent => agent.isDefault), ...agents.filter(agent => !agent.isDefault)].filter(agent => agent.cloud)
}

let running: Promise<FirstRunAutoPickResult> | undefined

/** One automatic pass. Concurrent callers share the pass in flight. */
export function runFirstRunAutoPick(deps: FirstRunAutoPickDeps): Promise<FirstRunAutoPickResult> {
  running ??= pass(deps).finally(() => {
    running = undefined
  })

  return running
}

async function pass({ agents, subscriptions, work, writeSubscription }: FirstRunAutoPickDeps): Promise<FirstRunAutoPickResult> {
  const order = firstRunOrder(agents)
  const [labels, opencode] = await Promise.all([loadFirstRunLabels(work), loadFirstRunOpenCodeGo(subscriptions)])

  if (!record.enabled) {
    return { status: 'off', wrote: [] }
  }

  if (!work || !order.length) {
    return { status: 'unavailable', wrote: [] }
  }

  const first = order[0]!
  let firstPlans: WorkAgentPlans | null = null

  try {
    firstPlans = (await work.readAgentPlans?.(first.principal)) ?? null
  } catch {
    firstPlans = null
  }

  const pick = await resolvePick(work, facts(firstPlans, labels, opencode))
  const wrote: string[] = []

  $firstRunPick.set(pick)

  if (pick.kind === 'atum') {
    return { status: 'done', pick, wrote }
  }

  for (const agent of order) {
    if (!record.enabled || record.manual.includes(agent.principal)) {
      continue
    }

    try {
      const plans = agent === first ? firstPlans : ((await work.readAgentPlans?.(agent.principal)) ?? null)
      const selection = plans?.selection ?? null
      const mine = record.auto[agent.principal]
      const subscription = agent.cloudModel?.subscription

      // An OpenCode Go or ChatGPT cloud choice this Mac did not write is a person's.
      const cloudChoiceTheirs =
        subscription !== undefined && !(mine?.kind === 'opencode_go' && subscription.source === 'opencode_go')

      if (!ours(agent.principal, selection) || cloudChoiceTheirs) {
        continue
      }

      if (pick.kind === 'plan') {
        if (!plans?.published || !work.selectRelay || (selection?.plan === pick.plan && selection.model === pick.model)) {
          continue
        }

        const saved = await work.selectRelay(agent.principal, pick.model, pick.plan)
        record = { ...record, auto: { ...record.auto, [agent.principal]: { kind: 'plan', plan: pick.plan, model: pick.model, revision: saved.revision } } }
        save()
        acknowledgeAgentPlanSelectionForAgent(agent.principal, saved)
        wrote.push(agent.principal)
      } else {
        // A plan selection (ours) would win over the cloud choice; leave it rather than clear what the relay holds.
        if (selection || !writeSubscription || (subscription?.source === 'opencode_go' && subscription.model === pick.model)) {
          continue
        }

        const result = await writeSubscription(agent.principal, 'opencode_go', pick.model, 'medium')

        if (result.status === 'saved') {
          record = { ...record, auto: { ...record.auto, [agent.principal]: { kind: 'opencode_go', model: pick.model } } }
          save()
          wrote.push(agent.principal)
        }
      }
    } catch {
      // One assistant failing never stops the rest; its turns answer on Atum's model as before.
    }
  }

  return { status: 'done', pick, wrote }
}

/** Tests only. */
export function resetFirstRunForTests(): void {
  account = null
  record = { ...EMPTY, manual: [], auto: {} }
  running = undefined
  $firstRunLabels.set(undefined)
  $firstRunOpenCodeGo.set(false)
  $firstRunPick.set(undefined)
  $firstRunAutoEnabled.set(true)
  $firstRunJustReady.set(new Set())
  resetFirstRunAskForTests()
}
