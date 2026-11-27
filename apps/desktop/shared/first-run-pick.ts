import type { WorkRelayPlan } from './matrix-work-relay'

/**
 * First-run automatic plan pick (owner 2026-11-27: "Always default to auto if we can"; Claude Sonnet first, then ChatGPT Sol).
 * Pure: from what this Mac's native T3 status and the account's OpenCode Go connection say, to the one default every assistant
 * starts on. The table is docs/plans/2026-11-27-first-run-subscriptions.md › Default picks (atum-app, docs/first-run-subs-plan).
 *
 * - Chats: Claude paid → Sonnet; else ChatGPT paid → Sol; else Antigravity paid → Gemini Flash; else OpenCode Go → DeepSeek
 *   V4.1 Flash; else Atum's own model (GPT-6 Luna).
 * - A free or unknown plan never wins chats (it serves small tasks; the plan says an unknown plan cannot win).
 * - A plan the relay does not carry yet (`published` false), a family the plan does not advertise, or a plan the owner pressed
 *   Stop using on cannot win; the next route is tried.
 */

/** The four connections the first chat lists, in the owner's order. */
export const FIRST_RUN_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode'] as const
export type FirstRunProvider = (typeof FIRST_RUN_PROVIDERS)[number]

export type FirstRunTier = 'paid' | 'free' | 'unknown'

export interface FirstRunModel {
  id: string
  displayName: string
}

export interface FirstRunPlanFact {
  connected: boolean
  /** T3's own plan name (`auth.label`, e.g. "Claude Pro", "ChatGPT Plus"). Absent when T3 does not say. */
  label?: string
  models: readonly FirstRunModel[]
}

export interface FirstRunFacts {
  /** The relay carries this Mac's plans to cloud assistants (`WorkAgentPlans.published`). */
  published: boolean
  plans: Partial<Record<WorkRelayPlan, FirstRunPlanFact>>
  /** The account-wide OpenCode Go key connection (cloud custody, existing key sheet). */
  opencodeGo: { connected: boolean; models: readonly FirstRunModel[] }
}

export type FirstRunPick =
  | { kind: 'plan'; plan: WorkRelayPlan; model: string }
  | { kind: 'opencode_go'; model: string }
  | { kind: 'atum' }

const FREE = /\bfree\b/iu
const PAID = /\b(plus|pro|max|team|business|enterprise|edu|ultra|premium|go|paid|subscription)\b/iu
const UNSTABLE = /(preview|experimental|\bexp\b|beta|alpha)/iu

/**
 * The plan's tier from T3's own name for it. Claude is paid whenever it is signed in on a plan login: Claude Code needs an
 * eligible paid Claude plan (Free has no Claude Code access), so a working Claude login is a paid one unless T3 names Free.
 */
export function firstRunTier(plan: WorkRelayPlan | 'opencode', label: string | undefined): FirstRunTier {
  if (label && FREE.test(label)) {
    return 'free'
  }

  if (label && PAID.test(label)) {
    return 'paid'
  }

  return plan === 'claude' ? 'paid' : 'unknown'
}

function version(id: string): number[] {
  return (id.match(/\d+/gu) ?? []).map(Number)
}

function newer(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

/** The newest stable model of a family the plan advertises, by the version numbers in its id. */
export function newestInFamily(models: readonly FirstRunModel[], family: RegExp, exclude?: RegExp): string | undefined {
  return models
    .filter(model => family.test(model.id) && !UNSTABLE.test(model.id) && !(exclude?.test(model.id) ?? false))
    .map(model => model.id)
    .sort((left, right) => newer(version(left), version(right)))[0]
}

const FAMILY: Record<WorkRelayPlan, { family: RegExp; exclude?: RegExp }> = {
  claude: { family: /sonnet/iu },
  codex: { family: /\bsol\b/iu },
  antigravity: { family: /gemini.*flash/iu, exclude: /lite/iu }
}

const PLAN_ORDER: readonly WorkRelayPlan[] = ['claude', 'codex', 'antigravity']

export function firstRunPick(facts: FirstRunFacts, stopped: ReadonlySet<FirstRunProvider> = new Set()): FirstRunPick {
  if (facts.published) {
    for (const plan of PLAN_ORDER) {
      const fact = facts.plans[plan]

      if (!fact?.connected || stopped.has(plan) || firstRunTier(plan, fact.label) !== 'paid') {
        continue
      }

      const model = newestInFamily(fact.models, FAMILY[plan].family, FAMILY[plan].exclude)

      if (model) {
        return { kind: 'plan', plan, model }
      }
    }
  }

  if (facts.opencodeGo.connected && !stopped.has('opencode')) {
    const model = newestInFamily(facts.opencodeGo.models, /deepseek.*flash/iu, /free/iu)

    if (model) {
      return { kind: 'opencode_go', model }
    }
  }

  return { kind: 'atum' }
}

/** Two picks name the same route. */
export function sameFirstRunPick(left: FirstRunPick, right: FirstRunPick): boolean {
  if (left.kind !== right.kind) {
    return false
  }

  if (left.kind === 'plan' && right.kind === 'plan') {
    return left.plan === right.plan && left.model === right.model
  }

  if (left.kind === 'opencode_go' && right.kind === 'opencode_go') {
    return left.model === right.model
  }

  return true
}
