/**
 * Artifact chunks: the only binary frames on the device connection (`atum.device-service/1`
 * README §3.4, `artifact_chunk.header`). A device returns a file (`device_send_file`) as chunks
 * of its Receipt's artifact; the controller reassembles them and accepts the bytes only when their
 * size and SHA-256 equal the artifact the device **signed** in its Receipt. Chunks themselves are
 * unsigned: they ride the authenticated connection, and the signed hash is the integrity check.
 *
 * Frame layout (big-endian):
 *
 *     u16 headerLength || utf8(canonicalJson(header)) || bytes      header.size === bytes.length
 *
 * A whole frame fits the hub's 1 MiB payload; {@link maxChunkBytes} sizes chunks to fit.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical";
import { DEVICE_SERVICE_PARAMETERS } from "./contract-packs";
import { DEVICE_HUB_MAX_PAYLOAD_BYTES, deviceServiceViolations, type B64u, type ReceiptArtifact } from "./messages";

export interface ArtifactChunkHeader {
  commandId: string;
  name: string;
  offset: number;
  size: number;
}

export class ArtifactChunkError extends Error {}

/** The largest file a Receipt artifact may carry (8 MiB, the chat attachment limit). */
export const ARTIFACT_MAX_BYTES = DEVICE_SERVICE_PARAMETERS.artifact_max_bytes;
/** The largest single chunk the header schema allows. */
export const ARTIFACT_CHUNK_MAX_BYTES = 1_048_000;

function headerBytes(header: ArtifactChunkHeader): Buffer {
  return Buffer.from(canonicalJson(header), "utf8");
}

/** The largest chunk whose frame still fits the payload limit for this command and name. */
export function maxChunkBytes(commandId: string, name: string): number {
  const overhead = 2 + headerBytes({ commandId, name, offset: ARTIFACT_MAX_BYTES, size: ARTIFACT_CHUNK_MAX_BYTES }).length;
  return Math.max(1, Math.min(ARTIFACT_CHUNK_MAX_BYTES, DEVICE_HUB_MAX_PAYLOAD_BYTES - overhead));
}

/** One binary chunk frame. Throws {@link ArtifactChunkError} for a header the contract refuses. */
export function encodeArtifactChunk(header: ArtifactChunkHeader, bytes: Uint8Array): Buffer {
  if (deviceServiceViolations("artifact_chunk.header", header).length || header.size !== bytes.byteLength ||
      header.offset + header.size > ARTIFACT_MAX_BYTES) throw new ArtifactChunkError("artifact_chunk_invalid");
  const encoded = headerBytes(header);
  const frame = Buffer.concat([Buffer.from([encoded.length >> 8, encoded.length & 0xff]), encoded, bytes]);
  if (encoded.length > 0xffff || frame.length > DEVICE_HUB_MAX_PAYLOAD_BYTES) throw new ArtifactChunkError("artifact_chunk_too_large");
  return frame;
}

/** Decode and check one binary frame: a canonical header the contract accepts, and exactly its bytes. */
export function decodeArtifactChunk(frame: Uint8Array): { header: ArtifactChunkHeader; bytes: Buffer } {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (buffer.length < 3 || buffer.length > DEVICE_HUB_MAX_PAYLOAD_BYTES) throw new ArtifactChunkError("artifact_chunk_invalid");
  const length = buffer.readUInt16BE(0);
  if (length === 0 || 2 + length > buffer.length) throw new ArtifactChunkError("artifact_chunk_invalid");
  const text = buffer.subarray(2, 2 + length).toString("utf8");
  let header: ArtifactChunkHeader;
  try {
    header = JSON.parse(text) as ArtifactChunkHeader;
  } catch {
    throw new ArtifactChunkError("artifact_chunk_invalid");
  }
  if (deviceServiceViolations("artifact_chunk.header", header).length || canonicalJson(header) !== text) {
    throw new ArtifactChunkError("artifact_chunk_invalid");
  }
  const bytes = buffer.subarray(2 + length);
  if (bytes.length !== header.size || header.offset + header.size > ARTIFACT_MAX_BYTES) throw new ArtifactChunkError("artifact_chunk_invalid");
  return { header, bytes: Buffer.from(bytes) };
}

/** Split a file into chunk frames for one Receipt artifact (the device's side). */
export function artifactChunks(commandId: string, name: string, bytes: Uint8Array): Buffer[] {
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) throw new ArtifactChunkError("artifact_too_large");
  const size = maxChunkBytes(commandId, name);
  const frames: Buffer[] = [];
  // An empty file has no chunks: its Receipt says size 0.
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    frames.push(encodeArtifactChunk({ commandId, name, offset, size: slice.byteLength }, slice));
  }
  return frames;
}

const sha256 = (bytes: Uint8Array): B64u => createHash("sha256").update(bytes).digest("base64url");

/**
 * Reassembles one command's artifacts from its chunks, strictly in order (offset 0 restarts an
 * artifact, as after a reconnect), bounded by the artifact limits, and releases bytes only for an
 * artifact whose size and SHA-256 match what the device signed.
 */
export class ArtifactAssembler {
  private readonly parts = new Map<string, { received: number; chunks: Buffer[] }>();
  private total = 0;

  constructor(readonly commandId: string, private readonly limit = ARTIFACT_MAX_BYTES) {}

  /** Add one chunk. Throws {@link ArtifactChunkError} for a foreign, out-of-order or oversized chunk. */
  add(header: ArtifactChunkHeader, bytes: Uint8Array): void {
    if (header.commandId !== this.commandId || bytes.byteLength !== header.size) throw new ArtifactChunkError("artifact_chunk_foreign");
    let part = this.parts.get(header.name);
    if (header.offset === 0 && part) {
      this.total -= part.received;
      part = undefined;
    }
    if (!part) {
      if (header.offset !== 0) throw new ArtifactChunkError("artifact_chunk_out_of_order");
      if (this.parts.size >= DEVICE_SERVICE_PARAMETERS.artifacts_max && !this.parts.has(header.name)) throw new ArtifactChunkError("artifact_too_many");
      part = { received: 0, chunks: [] };
      this.parts.set(header.name, part);
    }
    if (header.offset !== part.received) throw new ArtifactChunkError("artifact_chunk_out_of_order");
    if (this.total + bytes.byteLength > this.limit || part.received + bytes.byteLength > ARTIFACT_MAX_BYTES) {
      throw new ArtifactChunkError("artifact_too_large");
    }
    part.chunks.push(Buffer.from(bytes));
    part.received += bytes.byteLength;
    this.total += bytes.byteLength;
  }

  /** The artifact's bytes if every byte arrived and they hash to the signed SHA-256; else null. */
  take(expected: ReceiptArtifact): Buffer | null {
    const part = this.parts.get(expected.name);
    if (expected.size === 0 && !part) return sha256(Buffer.alloc(0)) === expected.sha256 ? Buffer.alloc(0) : null;
    if (!part || part.received !== expected.size) return null;
    const bytes = Buffer.concat(part.chunks, part.received);
    return sha256(bytes) === expected.sha256 ? bytes : null;
  }

  /** Bytes held so far, for the hub's memory bound. */
  get bufferedBytes(): number {
    return this.total;
  }
}
