import { createHash, randomUUID } from 'node:crypto'

import type { MatrixDriveIssue, MatrixDriveView } from '../../shared/matrix-drive'
import type { EncryptedStore } from '../encrypted-store'

import { MAC_DELIVERABLE_LIMITS } from './drive-deliverables-contract'
import type {
  MacBrokerFence,
  MacBrokerPort,
  MacCommitReply,
  MacDeliverableInput,
  MacWriterContext
} from './drive-deliverables-contract'
import { snapshotMacDeliverables, validMacDeliverablePath } from './drive-deliverables-source'

/** No production construction or signed-config wiring until R1/R2 and the output signal join. */
export const DRIVE_MAC_DELIVERABLES = false

export interface MacDeliverablesResult {
  state:
    | 'disabled'
    | 'blocked'
    | 'invalid'
    | 'unavailable'
    | 'committed'
    | 'committed_with_siblings'
    | 'drive_full'
    | 'unknown'
  placed: number
  siblings: number
  unsaved: number
  issue?: MatrixDriveIssue
}

export interface MacDeliverablesOptions {
  /** Test construction only for now. Normal construction remains disabled. */
  enabled?: boolean
  broker: MacBrokerPort
  store: EncryptedStore
  sourceRoot(): string | null
  driveRoots(): readonly string[]
  context(): MacWriterContext | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const ETAG = /^[!-~]{1,512}$/u
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const result = (state: MacDeliverablesResult['state'], unsaved = 0): MacDeliverablesResult => ({
  state,
  placed: 0,
  siblings: 0,
  unsaved
})

const scopeId = (context: MacWriterContext) => digest([context.accountKey, context.agentPrincipal])

const contextFacts = (value: MacWriterContext) => [
  value.accountKey,
  value.agentPrincipal,
  value.deviceId,
  value.epoch,
  value.generation,
  value.answeringMode,
  value.allowLocalWriter
]

const sameContext = (a: MacWriterContext | null, b: MacWriterContext) =>
  Boolean(a && digest(contextFacts(a)) === digest(contextFacts(b)))

function allowed(context: MacWriterContext | null): context is MacWriterContext {
  return Boolean(
    context &&
    context.answeringMode === 'local' &&
    context.allowLocalWriter === true &&
    [context.accountKey, context.agentPrincipal, context.deviceId].every(
      value => typeof value === 'string' && value.length > 0 && value.length <= 1024
    ) &&
    [context.epoch, context.generation].every(value => Number.isSafeInteger(value) && value >= 0)
  )
}

export function macDeliverablesFence(context: MacWriterContext): MacBrokerFence {
  return {
    scopeId: scopeId(context),
    deviceId: context.deviceId,
    epoch: context.epoch,
    generation: context.generation,
    answeringMode: context.answeringMode,
    allowLocalWriter: context.allowLocalWriter
  }
}

interface Attempt {
  v: 1
  fingerprint: string
  result: MacDeliverablesResult
}

/**
 * One native transaction for a completed, quiesced local turn's explicit files.
 * Main owns the singleton under its userData launch lock. No scan, HTTP, credential or Drive write.
 * The durable attempt key deliberately omits device/writer/account-generation epochs: changing
 * those facts cannot turn a lost acknowledgement into another placement of the same invocation.
 */
export class MacDriveDeliverables {
  private readonly attempts: EncryptedStore

  constructor(private readonly options: MacDeliverablesOptions) {
    this.attempts = options.store.scope('drive-deliverables:')
  }

  async publish(input: MacDeliverableInput): Promise<MacDeliverablesResult> {
    if (!(this.options.enabled ?? DRIVE_MAC_DELIVERABLES)) {
      return result('disabled')
    }

    try {
      return await this.run(input)
    } catch {
      // Pre-side-effect errors are unavailable. All broker calls are caught in run().
      return result('unavailable')
    }
  }

  private async run(input: MacDeliverableInput): Promise<MacDeliverablesResult> {
    const context = this.options.context()

    if (!allowed(context)) {
      return result('blocked')
    }

    // Copy the invocation and authority before any await; callers cannot retarget staged bytes.
    const captured = { ...context }

    if (
      !input ||
      typeof input.taskId !== 'string' ||
      !UUID.test(input.taskId) ||
      !Array.isArray(input.files) ||
      input.files.length < 1 ||
      input.files.length > MAC_DELIVERABLE_LIMITS.files ||
      (input.dependencies !== undefined && !Array.isArray(input.dependencies))
    ) {
      return result('invalid')
    }

    const taskId = input.taskId
    const files = input.files.map(file => ({ path: file?.path, baseEtag: file?.baseEtag ?? null }))
    const dependencies = (input.dependencies ?? []).map(item => ({ path: item?.path, etag: item?.etag }))

    if (
      dependencies.length > MAC_DELIVERABLE_LIMITS.dependencies ||
      files.some(
        file =>
          !validMacDeliverablePath(file.path) ||
          (file.baseEtag !== null && (typeof file.baseEtag !== 'string' || !ETAG.test(file.baseEtag)))
      ) ||
      dependencies.some(
        item => !validMacDeliverablePath(item.path) || typeof item.etag !== 'string' || !ETAG.test(item.etag)
      ) ||
      new Set(files.map(file => file.path.toLowerCase())).size !== files.length ||
      new Set(dependencies.map(item => item.path.toLowerCase())).size !== dependencies.length
    ) {
      return result('invalid', files.length)
    }

    const key = digest([captured.accountKey, captured.agentPrincipal, taskId])
    const fingerprint = digest([files, dependencies])
    const prior = this.previous(key, fingerprint)

    if (prior) {
      return prior
    }

    const root = this.options.sourceRoot()

    if (!root) {
      return result('unavailable', files.length)
    }

    let prepared: Awaited<ReturnType<typeof snapshotMacDeliverables>>

    try {
      prepared = await snapshotMacDeliverables(root, [...this.options.driveRoots()], files)
    } catch {
      return result('invalid', files.length)
    }

    if (!sameContext(this.options.context(), captured)) {
      return result('blocked', files.length)
    }

    // Re-read after source preparation. Concurrent calls/classes on the single main event loop
    // cannot pass this synchronous get/set section twice before the first broker side effect.
    // An overlapping caller may observe unknown until the active attempt records its outcome.
    const concurrent = this.previous(key, fingerprint)

    if (concurrent) {
      return concurrent
    }

    let outcome = result('unknown', files.length)
    this.save(key, fingerprint, outcome)
    const fence = macDeliverablesFence(captured)
    const placements = []

    try {
      for (const file of prepared) {
        if (!sameContext(this.options.context(), captured)) {
          return outcome
        }

        const artifactId = randomUUID()

        const reply = await this.options.broker.stage({
          ...file,
          bytes: Buffer.from(file.bytes),
          fence: { ...fence },
          taskId,
          artifactId
        })

        if (!reply || !('staged' in reply) || reply.staged !== true || reply.artifactId !== artifactId) {
          if (reply && 'reason' in reply && reply.reason === 'drive_full') {
            outcome = {
              ...result('drive_full', files.length),
              issue: { id: taskId, code: 'drive_full', count: files.length }
            }
          } else if (reply && 'reason' in reply && reply.reason === 'fenced') {
            outcome = result('blocked', files.length)
          }

          break
        }

        placements.push({
          path: file.path,
          mode: file.baseEtag === null ? ('create' as const) : ('replace' as const),
          baseEtag: file.baseEtag,
          artifactId,
          sha256: file.sha256
        })
      }

      if (placements.length === prepared.length && sameContext(this.options.context(), captured)) {
        const reply = await this.options.broker.commit({
          fence: { ...fence },
          taskId,
          dependencies: dependencies.map(item => ({ ...item })),
          placements: placements.map(item => ({ ...item }))
        })

        outcome = commitResult(
          reply,
          placements.map(item => item.path),
          taskId
        )
      }
    } catch {
      // A stage or placement might have happened. Never retry after an ambiguous write.
      outcome = result('unknown', files.length)
    }

    try {
      this.save(key, fingerprint, outcome)
    } catch {
      // The pre-call unknown mark survives a failed acknowledgement write.
      return result('unknown', files.length)
    }

    return sameContext(this.options.context(), captured) ? outcome : result('unknown', files.length)
  }

  private previous(key: string, fingerprint: string): MacDeliverablesResult | null {
    const text = this.attempts.getItem(key)

    if (this.attempts.failureCode()) {
      throw new Error('mac_deliverables_history_unavailable')
    }

    if (text === null) {
      return null
    }

    const saved = JSON.parse(text) as Attempt

    if (
      saved.v !== 1 ||
      !saved.result ||
      !['committed', 'committed_with_siblings', 'drive_full', 'unknown', 'blocked'].includes(saved.result.state) ||
      ![saved.result.placed, saved.result.siblings, saved.result.unsaved].every(
        value => Number.isSafeInteger(value) && value >= 0 && value <= MAC_DELIVERABLE_LIMITS.files
      ) ||
      saved.result.placed + saved.result.siblings + saved.result.unsaved > MAC_DELIVERABLE_LIMITS.files ||
      (saved.result.issue &&
        (saved.result.state !== 'drive_full' ||
          saved.result.issue.code !== 'drive_full' ||
          !UUID.test(saved.result.issue.id) ||
          saved.result.issue.count !== saved.result.unsaved))
    ) {
      throw new Error('mac_deliverables_history_unavailable')
    }

    return saved.fingerprint === fingerprint
      ? structuredClone(saved.result)
      : result('unknown', saved.result.placed + saved.result.siblings + saved.result.unsaved)
  }

  private save(key: string, fingerprint: string, outcome: MacDeliverablesResult): void {
    this.attempts.setItem(key, JSON.stringify({ v: 1, fingerprint, result: outcome } satisfies Attempt))
  }
}

function commitResult(reply: MacCommitReply, paths: string[], taskId: string): MacDeliverablesResult {
  const unknown = result('unknown', paths.length)

  if (
    !reply ||
    !Array.isArray(reply.outputs) ||
    reply.outputs.length !== paths.length ||
    new Set(reply.outputs.map(row => row?.path)).size !== paths.length ||
    reply.outputs.some(
      row =>
        !row ||
        !paths.includes(row.path) ||
        !['placed', 'sibling', 'unknown', 'not_attempted'].includes(row.state) ||
        (row.state === 'placed' &&
          (!row.placed ||
            !row.placed.resource ||
            ![row.placed.resource.storage, row.placed.resource.space, row.placed.resource.opaque].every(
              value =>
                typeof value === 'string' &&
                value.length > 0 &&
                value.length <= MAC_DELIVERABLE_LIMITS.resourcePart &&
                /^[!-~]+$/u.test(value)
            ) ||
            typeof row.placed.etag !== 'string' ||
            !ETAG.test(row.placed.etag) ||
            row.siblingPath !== null)) ||
        (row.state === 'sibling' &&
          (row.placed !== null || !validMacDeliverablePath(row.siblingPath) || row.siblingPath === row.path)) ||
        (['unknown', 'not_attempted'].includes(row.state) && (row.placed !== null || row.siblingPath !== null))
    )
  ) {
    return unknown
  }

  const placed = reply.outputs.filter(row => row.state === 'placed').length
  const siblings = reply.outputs.filter(row => row.state === 'sibling').length
  const unsaved = paths.length - placed - siblings

  if (reply.result === 'committed' && placed === paths.length) {
    return { state: 'committed', placed, siblings, unsaved }
  }

  if (reply.result === 'committed_with_siblings' && siblings > 0 && unsaved === 0) {
    return { state: 'committed_with_siblings', placed, siblings, unsaved }
  }

  if (reply.result === 'drive_full' && unsaved > 0 && !reply.outputs.some(row => row.state === 'unknown')) {
    return { state: 'drive_full', placed, siblings, unsaved, issue: { id: taskId, code: 'drive_full', count: unsaved } }
  }

  if (
    reply.result === 'fenced' &&
    placed + siblings === 0 &&
    reply.outputs.every(row => row.state === 'not_attempted')
  ) {
    return result('blocked', paths.length)
  }

  return unknown
}

/** Presentation-only join. Caller must first match the native owner and generation. */
export function projectMacDeliverablesIssue(view: MatrixDriveView, outcome: MacDeliverablesResult): MatrixDriveView {
  if (outcome.state !== 'drive_full' || !outcome.issue || view.issues?.some(issue => issue.code === 'drive_full')) {
    return view
  }

  return { ...view, issues: [...(view.issues ?? []), outcome.issue] }
}
