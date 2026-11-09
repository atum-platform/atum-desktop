import { createHash } from 'node:crypto'

import type {
  MacBrokerFence,
  MacBrokerPort,
  MacCommitReply,
  MacCommitRequest,
  MacPlacementReply,
  MacStageRequest
} from './drive-deliverables-contract'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export interface FakeMacDriveFile {
  bytes: Buffer
  etag: string
}

export interface FakeMacDriveSeed {
  bytes: Buffer | string
  etag: string
}

export interface FakeMacDriveBrokerOptions {
  /** The native owner supplies its current fence; the broker checks it at both boundaries. */
  current: () => MacBrokerFence
  files?: Readonly<Record<string, Buffer | string | FakeMacDriveSeed>>
  /** The total capacity of this synthetic Drive. Omit it for an unbounded broker. */
  quotaBytes?: number
  /** Kept fixed so frozen placement vectors can assert their exact sibling names. */
  date?: string
  /** Simulates a write which reached Drive but whose acknowledgement was lost. */
  loseAckAfterPlacement?: boolean
  /** Small failure hooks for boundary tests, deliberately not a general transport simulator. */
  stageFailure?: 'fenced' | 'drive_full' | 'failed'
  commitFailure?: 'unknown' | 'drive_full'
}

interface Staged extends MacStageRequest {
  bytes: Buffer
}

const cloneFence = (value: MacBrokerFence): MacBrokerFence => ({ ...value })

const cloneStage = (value: MacStageRequest): MacStageRequest => ({
  ...value,
  bytes: Buffer.from(value.bytes),
  fence: cloneFence(value.fence)
})

const cloneCommit = (value: MacCommitRequest): MacCommitRequest => ({
  ...value,
  fence: cloneFence(value.fence),
  dependencies: value.dependencies.map(dependency => ({ ...dependency })),
  placements: value.placements.map(placement => ({ ...placement }))
})

const sameFence = (left: MacBrokerFence, right: MacBrokerFence): boolean =>
  left.scopeId === right.scopeId &&
  left.deviceId === right.deviceId &&
  left.epoch === right.epoch &&
  left.generation === right.generation &&
  left.answeringMode === right.answeringMode &&
  left.allowLocalWriter === right.allowLocalWriter

function siblingPath(path: string, date: string, taskId: string): string {
  const slash = path.lastIndexOf('/')
  const directory = slash < 0 ? '' : path.slice(0, slash + 1)
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''

  return `${directory}${stem} (T ${date} ${taskId.slice(0, 8)})${extension}`
}

function cloneReply(reply: MacCommitReply): MacCommitReply {
  return {
    result: reply.result,
    outputs: reply.outputs.map(output => ({
      ...output,
      placed: output.placed === null ? null : { etag: output.placed.etag, resource: { ...output.placed.resource } }
    }))
  }
}

/**
 * In-memory native Drive peer for the macOS delivery tests. It models the facts the publisher
 * must handle (conditional writes, sibling preservation, quota, fencing and lost acknowledgements)
 * without providing a cloud API or accepting credentials.
 */
export class FakeMacDriveBroker implements MacBrokerPort {
  readonly files = new Map<string, FakeMacDriveFile>()
  readonly stageCalls: MacStageRequest[] = []
  readonly commitCalls: MacCommitRequest[] = []
  placementCount = 0

  private readonly staged = new Map<string, Staged>()
  private readonly memo = new Map<string, MacCommitReply>()
  private readonly scopeId: string
  private etagSequence = 0

  constructor(private readonly options: FakeMacDriveBrokerOptions) {
    // The fake represents one native broker endpoint. A later dynamic context cannot retarget its
    // in-memory remote into another account or agent scope.
    this.scopeId = options.current().scopeId

    for (const [file, value] of Object.entries(options.files ?? {})) {
      if (typeof value === 'string' || Buffer.isBuffer(value)) {
        this.seed(file, value)
      } else {
        this.seed(file, value.bytes, value.etag)
      }
    }
  }

  /** Seed or inspect the synthetic remote without making it part of the broker protocol. */
  seed(path: string, value: Buffer | string, etag = this.nextEtag()): void {
    this.files.set(path, { bytes: Buffer.from(value), etag })
  }

  async stage(
    request: MacStageRequest
  ): Promise<{ staged: true; artifactId: string } | { reason: 'fenced' | 'drive_full' | 'failed' }> {
    this.stageCalls.push(cloneStage(request))

    if (!this.accepts(request.fence)) {
      return { reason: 'fenced' }
    }

    if (this.options.stageFailure) {
      return { reason: this.options.stageFailure }
    }

    if (!UUID.test(request.artifactId) || createHash('sha256').update(request.bytes).digest('hex') !== request.sha256) {
      return { reason: 'failed' }
    }

    const staged: Staged = { ...cloneStage(request), bytes: Buffer.from(request.bytes) }
    const previous = this.staged.get(request.artifactId)

    if (
      previous &&
      (previous.taskId !== staged.taskId ||
        previous.path !== staged.path ||
        previous.baseEtag !== staged.baseEtag ||
        previous.sha256 !== staged.sha256 ||
        !previous.bytes.equals(staged.bytes))
    ) {
      return { reason: 'failed' }
    }

    this.staged.set(request.artifactId, staged)

    return { staged: true, artifactId: request.artifactId }
  }

  async commit(request: MacCommitRequest): Promise<MacCommitReply> {
    this.commitCalls.push(cloneCommit(request))

    const notAttempted = (): MacCommitReply => ({
      result: 'fenced',
      outputs: request.placements.map(placement => ({
        path: placement.path,
        state: 'not_attempted',
        placed: null,
        siblingPath: null
      }))
    })

    if (!this.accepts(request.fence)) {
      return notAttempted()
    }

    const memoKey = `${request.fence.scopeId}\u0000${request.taskId}`
    const known = this.memo.get(memoKey)

    if (known) {
      return cloneReply(known)
    }

    if (this.options.commitFailure === 'unknown') {
      return this.remember(memoKey, {
        result: 'unknown',
        outputs: request.placements.map(placement => this.notAttempted(placement.path))
      })
    }

    if (this.options.commitFailure === 'drive_full') {
      return this.remember(memoKey, {
        result: 'drive_full',
        outputs: request.placements.map(placement => this.notAttempted(placement.path))
      })
    }

    const invalid = request.placements.some(placement => {
      const staged = this.staged.get(placement.artifactId)

      return (
        !staged ||
        staged.taskId !== request.taskId ||
        !sameFence(staged.fence, request.fence) ||
        staged.path !== placement.path ||
        staged.baseEtag !== placement.baseEtag ||
        staged.sha256 !== placement.sha256 ||
        createHash('sha256').update(staged.bytes).digest('hex') !== placement.sha256
      )
    })

    if (invalid || new Set(request.placements.map(placement => placement.path)).size !== request.placements.length) {
      return this.remember(memoKey, {
        result: 'unknown',
        outputs: request.placements.map(placement => this.notAttempted(placement.path))
      })
    }

    const dependenciesChanged = request.dependencies.some(
      dependency => this.files.get(dependency.path)?.etag !== dependency.etag
    )

    const date = this.options.date ?? '2026-10-04'

    const writes = request.placements.map(placement => {
      const current = this.files.get(placement.path)

      const sibling =
        dependenciesChanged ||
        (placement.mode === 'create' && current !== undefined) ||
        (placement.mode === 'replace' && (current === undefined || current.etag !== placement.baseEtag))

      return {
        placement,
        staged: this.staged.get(placement.artifactId)!,
        target: sibling ? siblingPath(placement.path, date, request.taskId) : placement.path,
        sibling
      }
    })

    // Sibling writes are exclusive: a collision means this transaction has not attempted any output.
    const targetNames = new Set<string>()

    if (
      writes.some(
        write =>
          targetNames.has(write.target) ||
          (write.sibling && this.files.has(write.target)) ||
          (targetNames.add(write.target), false)
      )
    ) {
      return this.remember(memoKey, {
        result: 'unknown',
        outputs: request.placements.map(placement => this.notAttempted(placement.path))
      })
    }

    const used = [...this.files.values()].reduce((total, file) => total + file.bytes.length, 0)

    const delta = writes.reduce(
      (total, write) => total + write.staged.bytes.length - (this.files.get(write.target)?.bytes.length ?? 0),
      0
    )

    if (used + delta > (this.options.quotaBytes ?? Number.POSITIVE_INFINITY)) {
      return this.remember(memoKey, {
        result: 'drive_full',
        outputs: request.placements.map(placement => this.notAttempted(placement.path))
      })
    }

    const outputs: MacPlacementReply[] = writes.map(write => {
      this.files.set(write.target, { bytes: Buffer.from(write.staged.bytes), etag: this.nextEtag() })
      this.placementCount += 1

      if (write.sibling) {
        return { path: write.placement.path, state: 'sibling', placed: null, siblingPath: write.target }
      }

      const saved = this.files.get(write.target)!

      return {
        path: write.placement.path,
        state: 'placed',
        placed: {
          resource: { storage: 'fake', space: 'fake', opaque: createHash('sha256').update(write.target).digest('hex') },
          etag: saved.etag
        },
        siblingPath: null
      }
    })

    const result = writes.some(write => write.sibling) ? 'committed_with_siblings' : 'committed'

    if (this.options.loseAckAfterPlacement) {
      return this.remember(memoKey, {
        result: 'unknown',
        outputs: request.placements.map(placement => ({
          path: placement.path,
          state: 'unknown',
          placed: null,
          siblingPath: null
        }))
      })
    }

    return this.remember(memoKey, { result, outputs })
  }

  private notAttempted(path: string): MacPlacementReply {
    return { path, state: 'not_attempted', placed: null, siblingPath: null }
  }

  private accepts(fence: MacBrokerFence): boolean {
    const current = this.options.current()

    return (
      fence.scopeId === this.scopeId &&
      fence.answeringMode === 'local' &&
      fence.allowLocalWriter &&
      sameFence(fence, current) &&
      current.scopeId === this.scopeId &&
      current.answeringMode === 'local' &&
      current.allowLocalWriter
    )
  }

  private nextEtag(): string {
    this.etagSequence += 1

    return `"fake-${this.etagSequence}"`
  }

  private remember(key: string, reply: MacCommitReply): MacCommitReply {
    const frozen = cloneReply(reply)
    this.memo.set(key, frozen)

    return cloneReply(frozen)
  }
}
