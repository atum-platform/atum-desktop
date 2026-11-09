/** Sanitised public client contract projection. Pins bind the published fixture bytes; source references are provenance and do not attest a deployment or historical provider acceptance. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_HOME_V25_PIN } from './contract-v25'

export const PACK_V24_ROOT = fileURLToPath(new URL('../../../contracts/atum-agent-home-v2.4/', import.meta.url))
export const PACK_V25_ROOT = fileURLToPath(new URL('../../../contracts/atum-agent-home-v2.5/', import.meta.url))
export const PACK_V25_PIN = AGENT_HOME_V25_PIN

export interface PackV25Fixture {
  file: string
  message?: string
  machine?: string
  expect: 'accept' | 'reject'
}

export interface PackV25 {
  pack_files: string[]
  fixtures: PackV25Fixture[]
}

export const readPackV25Json = <T = unknown>(file: string): T =>
  JSON.parse(fs.readFileSync(path.join(PACK_V25_ROOT, file), 'utf8')) as T

export const packV25 = (): PackV25 => readPackV25Json<PackV25>('contract.json')

export function packV25Digest(): string {
  const hash = createHash('sha256')

  for (const file of packV25().pack_files) {
    const name = Buffer.from(file)
    const body = fs.readFileSync(path.join(PACK_V25_ROOT, file))
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

export const pinnedV25Digest = (): string =>
  fs.readFileSync(path.join(PACK_V25_ROOT, 'PINNED-SHA256'), 'utf8').trim()
