import type {
  MatrixBackgroundSweepSaveResult,
  MatrixBackgroundSweepSetting,
  MatrixBackgroundSweepSettingWrite
} from '../../shared/background-sweep'
import { MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE } from '../../shared/background-sweep'

import { readDomainJson } from './domain'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const RESPONSE_BYTES = 8 * 1024
const CALL_TIMEOUT_MS = 15_000

function strictKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** A setting snapshot from the frozen 0.7.47 contract, or null. */
export function parseMatrixBackgroundSweepSetting(value: unknown): MatrixBackgroundSweepSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  return strictKeys(row, ['profile', 'assistantId', 'enabled', 'revision', 'activeForOwner']) &&
    row.profile === MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE &&
    typeof row.assistantId === 'string' &&
    UUID.test(row.assistantId) &&
    typeof row.enabled === 'boolean' &&
    Number.isSafeInteger(row.revision) &&
    Number(row.revision) >= 1 &&
    typeof row.activeForOwner === 'boolean'
    ? (row as unknown as MatrixBackgroundSweepSetting)
    : null
}

export function validMatrixBackgroundSweepWrite(value: unknown): value is MatrixBackgroundSweepSettingWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    strictKeys(row, ['profile', 'requestId', 'expectedRevision', 'enabled']) &&
    row.profile === MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE &&
    typeof row.requestId === 'string' &&
    UUID.test(row.requestId) &&
    Number.isSafeInteger(row.expectedRevision) &&
    Number(row.expectedRevision) >= 1 &&
    typeof row.enabled === 'boolean'
  )
}

async function request(
  resource: string,
  accessToken: string,
  assistantId: string,
  signal: AbortSignal,
  write?: MatrixBackgroundSweepSettingWrite
): Promise<MatrixBackgroundSweepSetting | MatrixBackgroundSweepSaveResult> {
  if (!UUID.test(assistantId) || (write !== undefined && !validMatrixBackgroundSweepWrite(write))) {
    throw new Error('matrix_background_sweep_invalid')
  }

  const bounded = AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)])
  let response: Response

  try {
    response = await fetch(`${resource}/agents/${encodeURIComponent(assistantId)}/background-sweep`, {
      method: write ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(write ? { 'Content-Type': 'application/json' } : {})
      },
      ...(write ? { body: JSON.stringify(write) } : {}),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: bounded
    })
  } catch {
    signal.throwIfAborted()
    throw new Error('matrix_background_sweep_unavailable')
  }

  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_background_sweep_unavailable')
  }

  let value: unknown

  try {
    value = await readDomainJson(response, RESPONSE_BYTES)
  } catch {
    throw new Error('matrix_background_sweep_unavailable')
  }

  signal.throwIfAborted()

  if (response.status === 200) {
    const setting = parseMatrixBackgroundSweepSetting(value)

    if (!setting || setting.assistantId !== assistantId) {
      throw new Error('matrix_background_sweep_invalid')
    }

    return write ? { status: 'saved', setting } : setting
  }

  if (write && response.status === 409 && value && typeof value === 'object' && !Array.isArray(value)) {
    const current =
      parseMatrixBackgroundSweepSetting(value) ??
      parseMatrixBackgroundSweepSetting((value as { current?: unknown }).current)

    if (current?.assistantId === assistantId) {
      return { status: 'conflict', setting: current }
    }
  }

  throw new Error(
    response.status === 401 || response.status === 403
      ? 'matrix_background_sweep_denied'
      : 'matrix_background_sweep_unavailable'
  )
}

export function readMatrixBackgroundSweepSetting(
  resource: string,
  accessToken: string,
  assistantId: string,
  signal: AbortSignal
): Promise<MatrixBackgroundSweepSetting> {
  return request(resource, accessToken, assistantId, signal) as Promise<MatrixBackgroundSweepSetting>
}

export function writeMatrixBackgroundSweepSetting(
  resource: string,
  accessToken: string,
  assistantId: string,
  write: MatrixBackgroundSweepSettingWrite,
  signal: AbortSignal
): Promise<MatrixBackgroundSweepSaveResult> {
  return request(resource, accessToken, assistantId, signal, write) as Promise<MatrixBackgroundSweepSaveResult>
}
