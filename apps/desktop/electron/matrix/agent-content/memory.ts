import { isDeepStrictEqual } from 'node:util'

import { type AtumCloudMemory, type AtumMemorySnapshot, parseMemorySnapshot } from '../../../shared/atum-agent-content'
import { MatrixAgentDefinitionError } from '../agent-definition'
import type { MatrixHermesRuntimeConfig } from '../hermes-runtime'

import { type MatrixAgentContentHelper, runMatrixAgentContentHelper } from './helper'

export type MatrixAgentMemoryState = 'synced' | 'disabled' | 'conflict' | 'unavailable' | 'local_only'

export interface MatrixAgentMemoryTarget {
  home: string
  runtime: MatrixHermesRuntimeConfig
  live(): boolean
  memoryAllowed?(): boolean
  memory(signal: AbortSignal): Promise<AtumCloudMemory>
  writeMemory(
    input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
    signal: AbortSignal
  ): Promise<AtumCloudMemory>
}

interface MemoryReceipt {
  revision: number
  snapshot: AtumMemorySnapshot
}

const emptyMemory = (): AtumMemorySnapshot => ({ memory: [], user: [] })
const equal = isDeepStrictEqual

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('matrix_agent_memory_invalid')
  }

  return value as Record<string, unknown>
}

function readResult(value: unknown): { snapshot: AtumMemorySnapshot; receipt?: MemoryReceipt } {
  const result = row(value)

  if (result.ok !== true) {
    throw new Error('matrix_agent_memory_invalid')
  }

  const snapshot = parseMemorySnapshot(result.snapshot)

  if (result.receipt === null || result.receipt === undefined) {
    return { snapshot }
  }

  const receipt = row(result.receipt)

  if (!Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1) {
    throw new Error('matrix_agent_memory_invalid')
  }

  return {
    snapshot,
    receipt: { revision: Number(receipt.revision), snapshot: parseMemorySnapshot(receipt.snapshot) }
  }
}

function applied(value: unknown, desired: AtumMemorySnapshot): boolean {
  const response = row(value)
  const result = row(response.result)

  return response.ok === true && result.success === true && equal(parseMemorySnapshot(result.snapshot), desired)
}

/**
 * Conservative three-way sync through the account's revisioned memory relay. Ambiguous edits
 * on both Macs remain untouched and report `conflict`; no last-write-wins path exists.
 */
export async function syncMatrixAgentMemory(
  target: MatrixAgentMemoryTarget,
  signal: AbortSignal,
  helper: MatrixAgentContentHelper = runMatrixAgentContentHelper
): Promise<MatrixAgentMemoryState> {
  try {
    const allowed = () => target.memoryAllowed?.() !== false
    signal.throwIfAborted()

    if (!target.live()) {
      return 'unavailable'
    }

    // A Google-latched home may contain protected provider data. It stays local under the
    // same sticky boundary as AtumAgentSync; no helper read or account request is attempted.
    if (!allowed()) {
      return 'local_only'
    }

    let cloud = await target.memory(signal)

    if (!allowed()) {
      return 'local_only'
    }

    // Disabled always means disabled, including a revision-zero response. The platform route
    // represents an absent row as revision zero with enabled=true; never turn an ambiguous
    // zero/disabled response on from the Mac.
    if (!cloud.enabled) {
      return 'disabled'
    }

    const local = readResult(await helper(target.runtime, target.home, 'memory-read', {}, signal))
    signal.throwIfAborted()

    if (!allowed()) {
      return 'local_only'
    }

    // Revision zero plus enabled=true is the platform's explicit no-row state. Seed it once
    // from this local home; every disabled response above remains disabled.
    if (cloud.revision === 0) {
      cloud = await target.writeMemory({ expected_revision: 0, enabled: true, snapshot: local.snapshot }, signal)
    }

    const base = local.receipt && local.receipt.revision <= cloud.revision ? local.receipt.snapshot : undefined
    const desired = emptyMemory()

    for (const kind of ['memory', 'user'] as const) {
      if (equal(local.snapshot[kind], cloud.snapshot[kind])) {
        desired[kind] = local.snapshot[kind]
      } else if (base && equal(local.snapshot[kind], base[kind])) {
        desired[kind] = cloud.snapshot[kind]
      } else if (base && equal(cloud.snapshot[kind], base[kind])) {
        desired[kind] = local.snapshot[kind]
      } else if (!base && local.snapshot[kind].length === 0) {
        desired[kind] = cloud.snapshot[kind]
      } else {
        return 'conflict'
      }
    }

    if (!equal(cloud.snapshot, desired)) {
      if (!allowed()) {
        return 'local_only'
      }

      cloud = await target.writeMemory({ expected_revision: cloud.revision, enabled: true, snapshot: desired }, signal)
    }

    signal.throwIfAborted()

    if (!allowed()) {
      return 'local_only'
    }

    const result = await helper(
      target.runtime,
      target.home,
      'memory-apply',
      { expected_snapshot: local.snapshot, snapshot: desired, revision: cloud.revision },
      signal
    )

    return applied(result, desired) ? 'synced' : 'conflict'
  } catch (error) {
    signal.throwIfAborted()

    return error instanceof MatrixAgentDefinitionError && error.code === 'conflict' ? 'conflict' : 'unavailable'
  }
}
