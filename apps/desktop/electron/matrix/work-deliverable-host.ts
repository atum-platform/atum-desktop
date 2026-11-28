import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { readJson, writeFileDurably } from '../work/session/files'
import { workSessionPaths } from '../work/session/paths'
import { Serial } from '../work/session/serial'
import {
  parseWorkDeliverableId,
  type WorkDeliverableId,
  type WorkDeliverableReply,
  type WorkDeliverableStatus
} from '../work/sidecar/deliverable-contract'

import { parseWorkDeliverableResult, type WorkDeliverableResult, type WorkDeliverables, type WorkDeliverableScope } from './work-deliverable'

interface WorkDeliverableRecord extends WorkDeliverableId {
  ownerKey: string
  outputRoot: string
  scope?: WorkDeliverableScope
  result?: WorkDeliverableResult
  status?: WorkDeliverableStatus
}

interface WorkDeliverableOwner {
  key: string
  root: string
}

function recordPath(owner: WorkDeliverableOwner, artifactId: string) {
  return path.join(workSessionPaths(owner).work, 'deliverable-receipts', artifactId + '.json')
}

function readRecord(owner: WorkDeliverableOwner, id: WorkDeliverableId): WorkDeliverableRecord | undefined {
  const record = readJson(recordPath(owner, id.artifactId)) as WorkDeliverableRecord | undefined

  if (record && (record.ownerKey !== owner.key || record.artifactId !== id.artifactId ||
      record.threadId !== id.threadId || record.runId !== id.runId)) {
    throw new Error('work_deliverable_identity_changed')
  }

  return record
}

function privateOutputRoot(owner: WorkDeliverableOwner, artifactId: string, value: unknown): string | undefined {
  const scratch = path.join(workSessionPaths(owner).home, 'scratch')

  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      path.dirname(path.dirname(value)) !== scratch || path.basename(value) !== '.work-output-' + artifactId) {
    return undefined
  }

  const stat = lstatSync(value)

  if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && realpathSync(value) === value) {
    return value
  }
}

/** Owns admission and replay for the current Work account's private sidecar. */
export class WorkDeliverableHost {
  private readonly serial = new Serial()

  constructor(
    private readonly receiver: WorkDeliverables | undefined,
    private readonly eligibleAgents: () => Promise<string[]>
  ) {}

  message(
    owner: WorkDeliverableOwner, value: unknown, current: () => boolean, signal: AbortSignal
  ): Promise<WorkDeliverableReply | undefined> {
    const id = parseWorkDeliverableId(value)

    if (!id || !value || typeof value !== 'object' || !('type' in value)) {return Promise.resolve(undefined)}
    const { artifactId } = id

    switch (value.type) {
      case 'work-deliverable-pin':
        return this.serial.run(async () => {
          if (!current() || !('outputRoot' in value)) {return false}
          const outputRoot = privateOutputRoot(owner, artifactId, value.outputRoot)

          if (!outputRoot) {return false}
          const record = readRecord(owner, id)

          if (record) {return record.outputRoot === outputRoot && Boolean(record.scope)}

          const agents = [...new Set(await this.eligibleAgents())]

          if (!current()) {return false}
          // Standalone S1 has no bound assistant. A sole active assistant is the only implicit destination.
          const scope = agents.length === 1 ? await this.receiver?.pin(artifactId, agents[0], outputRoot) : undefined

          if (!current()) {return false}
          writeFileDurably(recordPath(owner, artifactId), JSON.stringify({ ...id, ownerKey: owner.key, outputRoot, scope }))

          return Boolean(scope)
        }).catch(() => false).then(accepted => ({ type: 'work-deliverable-pinned', artifactId, accepted }))

      case 'work-deliverable-settled':
        return this.serial.run<WorkDeliverableStatus>(async () => {
          if (!current()) {return { state: 'cancelled' }}
          const record = readRecord(owner, id)
          const result = 'result' in value ? parseWorkDeliverableResult(value.result) : undefined

          if (!record || !result || (record.result && record.result.path !== result.path)) {return { state: 'invalid' }}

          const file = recordPath(owner, artifactId)

          if (!record.result) {writeFileDurably(file, JSON.stringify({ ...record, result }))}

          const status = record.scope && this.receiver
            ? await this.receiver.receive(record.scope, result, signal, current)
            : { state: 'drive_unavailable' as const }

          if (current()) {writeFileDurably(file, JSON.stringify({ ...record, result, status }))}

          return status
        }).catch(() => ({ state: 'retry' as const })).then(status => ({ type: 'work-deliverable-ack', artifactId, status }))

      default:
        return Promise.resolve(undefined)
    }
  }

  status(owner: WorkDeliverableOwner, value: unknown): Promise<WorkDeliverableStatus | null> {
    const id = parseWorkDeliverableId(value)

    if (!id) {return Promise.resolve(null)}

    return this.serial.run<WorkDeliverableStatus | null>(async () => {
      const record = readRecord(owner, id)

      if (!record?.result) {return null}

      if (!this.receiver || !record.scope) {return { state: 'drive_unavailable' }}
      const status = await this.receiver.status(record.scope, record.result)

      return status.state === 'retry' && record.status?.state === 'no_room' ? record.status : status
    }).catch(() => null)
  }

  learningDocument(owner: WorkDeliverableOwner, value: unknown): string | undefined {
    const id = parseWorkDeliverableId(value)
    if (!id) {return undefined}

    try {
      const record = readRecord(owner, id)
      if (!record?.result || privateOutputRoot(owner, id.artifactId, record.outputRoot) === undefined) {
        return undefined
      }
      const result = path.join(record.outputRoot, record.result.path)
      if (result.startsWith(record.outputRoot + path.sep) &&
          realpathSync(result) === result && lstatSync(result).isFile()) {
        return result
      }
    } catch {
      return undefined
    }
  }

  async open(owner: WorkDeliverableOwner, value: unknown, current: () => boolean): Promise<boolean> {
    const id = parseWorkDeliverableId(value)

    if (!id || !current()) {return false}

    try {
      const record = readRecord(owner, id)

      if (!this.receiver || !record?.scope || !record.result) {return false}
      const preview = Boolean(value && typeof value === 'object' && 'asset' in value && value.asset === 'preview')
      await this.receiver.open(record.scope, record.result, current, preview)

      return true
    } catch {
      return false
    }
  }
}
