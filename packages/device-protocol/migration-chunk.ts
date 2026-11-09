/**
 * Canonical binary migration chunks for `atum.device-service/1.1`.
 *
 * A chunk is unsigned because it travels on an authenticated device connection; the signed
 * MigrationOffer commits to the complete archive size and digest. The codec is shared by the Mac
 * device service and the controller hub so neither side can drift from the frozen wire layout.
 */
import { canonicalJson } from './canonical'
import { DEVICE_HUB_MAX_PAYLOAD_BYTES, deviceServiceViolations } from './messages'

export interface MigrationChunkHeader {
  migrationId: string
  offset: number
  size: number
}

export class MigrationChunkError extends Error {}

const invalid = (): never => { throw new MigrationChunkError('migration_chunk_invalid') }

/** Validate the header and bytes received over either IPC or the device socket. */
export function validMigrationChunk(header: unknown, bytes: unknown): header is MigrationChunkHeader {
  if (!(bytes instanceof Uint8Array) || deviceServiceViolations('migration_chunk.header', header).length) return false
  const typed = header as MigrationChunkHeader
  if (typed.size !== bytes.byteLength) return false
  const encoded = Buffer.from(canonicalJson(typed), 'utf8')
  return encoded.length > 0 && encoded.length <= 0xffff && 2 + encoded.length + bytes.byteLength <= DEVICE_HUB_MAX_PAYLOAD_BYTES
}

/** Encode the frozen `u16 headerLength || canonical JSON header || bytes` migration frame. */
export function encodeMigrationChunk(header: MigrationChunkHeader, bytes: Uint8Array): Buffer {
  if (!validMigrationChunk(header, bytes)) invalid()
  const encoded = Buffer.from(canonicalJson(header), 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(encoded.length)
  return Buffer.concat([length, encoded, bytes])
}

/** Decode one complete canonical migration frame, bounded by the hub's one MiB payload. */
export function decodeMigrationChunk(frame: Uint8Array): { header: MigrationChunkHeader; bytes: Buffer } {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  if (buffer.length < 3 || buffer.length > DEVICE_HUB_MAX_PAYLOAD_BYTES) invalid()
  const headerLength = buffer.readUInt16BE(0)
  if (!headerLength || 2 + headerLength > buffer.length) invalid()
  const text = buffer.subarray(2, 2 + headerLength).toString('utf8')
  let header: unknown
  try {
    header = JSON.parse(text)
  } catch {
    return invalid()
  }
  const bytes = buffer.subarray(2 + headerLength)
  if (!validMigrationChunk(header, bytes)) invalid()
  const validHeader = header as MigrationChunkHeader
  if (canonicalJson(validHeader) !== text) invalid()
  return { header: validHeader, bytes: Buffer.from(bytes) }
}
