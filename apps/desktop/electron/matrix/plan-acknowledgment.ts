import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { PlanAcknowledgment } from '../../shared/connection-catalog'

import { matrixAccountCodexScope, type MatrixHermesRuntimeConfig } from './hermes-runtime'

function location(config: Pick<MatrixHermesRuntimeConfig, 'profiles'>, owner: string) {
  const directory = path.dirname(matrixAccountCodexScope(config, owner).authDir)

  return { directory, account: path.basename(directory), file: path.join(directory, 'plan-acknowledgment.json') }
}

/** Main's local account record. Missing consent is normal; unreadable/corrupt
 * storage refuses admission instead of falling back to renderer/global state. */
export function readMatrixPlanAcknowledgment(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string,
  provider: string
): PlanAcknowledgment | undefined {
  const target = location(config, owner)
  let value: unknown

  try {
    value = JSON.parse(readFileSync(target.file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw new Error('provider_terms_blocked')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider_terms_blocked')
  }

  const record = value as Record<string, unknown>

  if (record.account !== target.account || record.provider !== provider) {
    return undefined
  }

  if (typeof record.policyVersion !== 'string' || typeof record.acknowledgedAt !== 'string') {
    throw new Error('provider_terms_blocked')
  }

  return { provider, policyVersion: record.policyVersion, acknowledgedAt: record.acknowledgedAt }
}

/** Called only after native confirmation and a current account/window check.
 * Atomic replacement prevents partial consent from ever admitting a start.
 * Account sign-out already removes this entire directory. */
export function saveMatrixPlanAcknowledgment(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string,
  acknowledgment: PlanAcknowledgment
): void {
  const target = location(config, owner)
  const staging = path.join(target.directory, `.plan-acknowledgment-${randomUUID()}.tmp`)

  try {
    mkdirSync(target.directory, { recursive: true, mode: 0o700 })
    chmodSync(target.directory, 0o700)
    writeFileSync(staging, JSON.stringify({ account: target.account, ...acknowledgment }) + '\n', {
      flag: 'wx',
      mode: 0o600
    })
    renameSync(staging, target.file)
  } catch {
    throw new Error('provider_terms_blocked')
  } finally {
    rmSync(staging, { force: true })
  }
}
