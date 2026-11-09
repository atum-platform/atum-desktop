/**
 * What a hired Store assistant does on its own (docs/shelf, `detail.schedules`), shared by
 * the app's main process and the window.
 *
 * Each paid assistant's jobs are bundled in the app for the 2026-10-07 launch (a launch
 * decision: no cross-home contract change). The follow-up moves these specs into the Store
 * catalog contract (DR-3), so a new assistant's jobs need no app release. Every table here
 * is keyed by the Store's item ID (`agent/<slug>`, what entitlements carry), never the shelf
 * listing's own ID. The specs are
 * written from the shelf's blueprint frontmatter by scripts/generate-matrix-store-schedules.mjs;
 * matrix-store-schedules.test.ts holds the two in step. A job's prompt names its paid skill,
 * whose body reaches the model only through Atum's AI (the Store binding), never this app.
 */
import type { MatrixStoreEntitlement, MatrixStoreKind } from './matrix-store'

export interface MatrixStoreScheduleSpec {
  /** Stable within its item: the blueprint skill's name without `atum-`. */
  id: string
  /** Five-field cron, in the Mac's local time (Hermes's scheduler). */
  cron: string
  prompt: string
}

/**
 * The Store jobs' model alias, which each job's own model name extends
 * (`matrixStoreRunModel`). The app's loopback proxy (managed-model.ts) knows a call carrying
 * one is a scheduled run of a paid assistant: it binds the call to the Store on the Mac that
 * holds the assistant's answering lease, once per household for that job's scheduled slot,
 * and answers `[SILENT]` (never forwarded, never charged) everywhere else. It is then sent on
 * the assistant's own Atum model.
 */
export const MATRIX_STORE_RUN_MODEL_ALIAS = 'atum-store-run'

/** Every Store job's name starts with this; nothing else may. */
export const MATRIX_STORE_JOB_PREFIX = 'atum-store/'

export const matrixStoreJobName = (itemId: string, scheduleId: string) =>
  `${MATRIX_STORE_JOB_PREFIX}${itemId}/${scheduleId}`

/** One Store job of a hire: its item and its spec. */
export interface MatrixStoreRunJob {
  itemId: string
  scheduleId: string
}

/** How the Store-run ledger names a job (shared/matrix-store-runs.ts): `<item>/<schedule>`. */
export const matrixStoreRunJobKey = (job: MatrixStoreRunJob) => `${job.itemId}/${job.scheduleId}`

/**
 * A Store job's own model name: the run alias and the job it runs
 * (`atum-store-run-researcher-weekly-digest`). The app's proxy reads it back
 * (`matrixStoreRunJob`), so each job's scheduled slot is claimed on its own: a Mac catching
 * up one job another Mac already ran repeats nothing, whatever the assistant's other jobs did.
 */
export const matrixStoreRunModel = (job: MatrixStoreRunJob) =>
  `${MATRIX_STORE_RUN_MODEL_ALIAS}-${job.itemId.replace(/^agent\//, '').replace(/[^a-z0-9-]/g, '-')}-${job.scheduleId}`

/**
 * The Store job a model name runs, read back from the bundled specs. Undefined: the name is
 * no Store run's. Null: it is one this build does not know (a job another build wrote, or
 * the bare alias); such a run is never bound, so it stays silent and is never charged.
 */
export function matrixStoreRunJob(model: unknown): MatrixStoreRunJob | null | undefined {
  if (
    typeof model !== 'string' ||
    (model !== MATRIX_STORE_RUN_MODEL_ALIAS && !model.startsWith(`${MATRIX_STORE_RUN_MODEL_ALIAS}-`))
  ) {
    return undefined
  }

  for (const [itemId, specs] of Object.entries(MATRIX_STORE_SCHEDULES)) {
    for (const spec of specs) {
      if (matrixStoreRunModel({ itemId, scheduleId: spec.id }) === model) {
        return { itemId, scheduleId: spec.id }
      }
    }
  }

  return null
}

/**
 * Optional Hermes skills a hire installs before its first turn (so no conversation's
 * cached prompt changes under it), by item. Bundled skills a listing names need no
 * install: every Hermes home has them.
 */
export const MATRIX_STORE_HIRE_SKILLS: Readonly<Record<string, readonly { identifier: string; name: string }[]>> = {
  'agent/english-coach': [{ identifier: 'official/productivity/memento-flashcards', name: 'memento-flashcards' }],
  'agent/shop-assistant': [{ identifier: 'official/finance/excel-author', name: 'excel-author' }]
}

/**
 * Whether an entitlement is in force now: granted and not revoked, and for a monthly item
 * its subscription is active, or cancelled with the paid month still running. Lapsed, or
 * cancelled past `renewAt`, is not.
 */
export function matrixStoreEntitlementInForce(entitlement: MatrixStoreEntitlement, now = Date.now()): boolean {
  if (entitlement.state !== 'active') {
    return false
  }

  const subscription = entitlement.subscription

  return (
    !subscription ||
    subscription.state === 'active' ||
    (subscription.state === 'cancelled' && Date.parse(subscription.renewAt) > now)
  )
}

/** The items in force for one assistant, of these kinds. */
function inForceFor(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now: number,
  kinds: readonly MatrixStoreKind[]
): MatrixStoreEntitlement[] {
  return assistantId
    ? entitlements.filter(
        entitlement =>
          kinds.includes(entitlement.kind) &&
          entitlement.assistantId === assistantId &&
          matrixStoreEntitlementInForce(entitlement, now)
      )
    : []
}

/**
 * Whether an assistant holds paid content in force (a skill taught to it, or its hire)
 * that reaches the model only through Atum's AI: with its own model it stops working.
 */
export function matrixStoreHoldsCloudItems(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): boolean {
  return inForceFor(entitlements, assistantId, now, ['skill', 'agent']).some(
    entitlement => entitlement.delivery === 'cloud'
  )
}

/** Whether an assistant is a paid hire in force: its scheduled runs carry the Store binding. */
export function matrixStoreHireInForce(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): boolean {
  return inForceFor(entitlements, assistantId, now, ['agent']).length > 0
}

/** The hired items in force for this assistant (normally its one hire). */
export function matrixStoreHiredItems(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): string[] {
  return [
    ...new Set(inForceFor(entitlements, assistantId, now, ['agent']).map(entitlement => entitlement.itemId))
  ].sort()
}

/** The hired items whose jobs this assistant should have now. */
export function matrixStoreScheduledItems(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): string[] {
  return matrixStoreHiredItems(entitlements, assistantId, now).filter(itemId => MATRIX_STORE_SCHEDULES[itemId]?.length)
}

/**
 * Whether one of the assistant's subscriptions (or an account-wide one) has reached its
 * renewal date. Only the server knows whether it renewed: read the Store again before a
 * paid call, as a turn does.
 */
export function matrixStoreRenewalDue(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): boolean {
  return entitlements.some(
    entitlement =>
      (entitlement.assistantId === null || entitlement.assistantId === assistantId) &&
      Boolean(entitlement.subscription) &&
      Date.parse(entitlement.subscription!.renewAt) <= now
  )
}

/**
 * The hired items a scheduled run may be bound to now: in force, with their paid period
 * still running (the server binds nothing to an active subscription past `renewAt`, so a
 * run then would be charged without its paid skill), and with jobs. Stricter than
 * `matrixStoreScheduledItems`, which keeps the jobs through the renewal gap.
 */
export function matrixStoreBindableItems(
  entitlements: readonly MatrixStoreEntitlement[],
  assistantId: string | undefined,
  now = Date.now()
): string[] {
  return [
    ...new Set(
      inForceFor(entitlements, assistantId, now, ['agent'])
        .filter(entitlement => !entitlement.subscription || Date.parse(entitlement.subscription.renewAt) > now)
        .map(entitlement => entitlement.itemId)
    )
  ]
    .filter(itemId => MATRIX_STORE_SCHEDULES[itemId]?.length)
    .sort()
}

// BEGIN GENERATED SPECS (scripts/generate-matrix-store-schedules.mjs)
export const MATRIX_STORE_SCHEDULES: Readonly<Record<string, readonly MatrixStoreScheduleSpec[]>> = {
  'agent/english-coach': [
    {
      id: 'daily-lesson',
      cron: '0 20 * * *',
      prompt: "Prepare today's English lesson with the atum-daily-lesson skill."
    }
  ],
  'agent/marketer': [
    {
      id: 'competitor-report',
      cron: '0 9 * * 1',
      prompt: "Write this week's competitor report with the atum-competitor-report skill."
    }
  ],
  'agent/personal-assistant': [
    { id: 'morning-brief', cron: '30 7 * * *', prompt: "Send today's brief with the atum-morning-brief skill." }
  ],
  'agent/researcher': [
    {
      id: 'weekly-digest',
      cron: '0 8 * * 1',
      prompt: "Write this week's topic digest with the atum-weekly-digest skill."
    }
  ],
  'agent/shop-assistant': [
    {
      id: 'daily-sales',
      cron: '30 8 * * *',
      prompt: "Summarise yesterday's sales with the atum-daily-sales skill, if there is a new export."
    },
    { id: 'price-check', cron: '0 10 * * 1', prompt: 'Check competitor listings with the atum-price-check skill.' }
  ]
}
// END GENERATED SPECS
