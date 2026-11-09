/** Sanitised public client contract projection. Pins bind the published fixture bytes; source references are provenance and do not attest a deployment or historical provider acceptance. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACK_ROOT = fileURLToPath(new URL('../../../contracts/atum-agent-home-v2.1/', import.meta.url))

export const PACK_PIN = 'c1e817b95be77f6570ac40b303f27acc6bddf9e82a17824d847651fdcf731435'

export interface PackFixture {
  file: string
  message?: string
  machine?: string
  expect: 'accept' | 'reject'
}

export interface Pack {
  pack_files: string[]
  fixtures: PackFixture[]
}

export const readPackJson = <T = unknown>(file: string): T =>
  JSON.parse(fs.readFileSync(path.join(PACK_ROOT, file), 'utf8')) as T

export const pack = (): Pack => readPackJson<Pack>('contract.json')

/** The framed digest the platform's `contract_pack` tool pins: each file's name and bytes, length-prefixed. */
export function packDigest(): string {
  const hash = createHash('sha256')

  for (const file of pack().pack_files) {
    const name = Buffer.from(file)
    const body = fs.readFileSync(path.join(PACK_ROOT, file))
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

export const pinnedDigest = (): string => fs.readFileSync(path.join(PACK_ROOT, 'PINNED-SHA256'), 'utf8').trim()
