import { expect, it } from 'vitest'

import { decodeMigrationChunk, encodeMigrationChunk, MigrationChunkError, validMigrationChunk } from '../migration-chunk'
import { DEVICE_HUB_MAX_PAYLOAD_BYTES } from '../messages'

const header = { migrationId: '00000000-0000-4000-8000-44875ad14494', offset: 0, size: 3 }

it('round-trips the canonical device-service/1.1 migration chunk format', () => {
  const bytes = Buffer.from('abc')
  const frame = encodeMigrationChunk(header, bytes)

  expect(decodeMigrationChunk(frame)).toEqual({ header, bytes })
  expect(validMigrationChunk(header, bytes)).toBe(true)
  expect(frame.length).toBeLessThanOrEqual(DEVICE_HUB_MAX_PAYLOAD_BYTES)
})

it('refuses noncanonical headers, length mismatches, and frames beyond the hub bound', () => {
  const frame = encodeMigrationChunk(header, Buffer.from('abc'))
  const loose = Buffer.from(JSON.stringify({ size: 3, migrationId: header.migrationId, offset: 0 }))
  const length = Buffer.alloc(2)
  length.writeUInt16BE(loose.length)

  expect(() => decodeMigrationChunk(Buffer.concat([length, loose, Buffer.from('abc')]))).toThrow(MigrationChunkError)
  expect(() => decodeMigrationChunk(frame.subarray(0, frame.length - 1))).toThrow('migration_chunk_invalid')
  expect(() => encodeMigrationChunk({ ...header, size: 2 }, Buffer.from('abc'))).toThrow('migration_chunk_invalid')
  expect(() => decodeMigrationChunk(Buffer.alloc(DEVICE_HUB_MAX_PAYLOAD_BYTES + 1))).toThrow('migration_chunk_invalid')
})
