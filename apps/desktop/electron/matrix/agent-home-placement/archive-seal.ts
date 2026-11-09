/**
 * The seal on a checkpoint archive: AES-256-GCM, streamed, with the home and the generation bound as
 * associated data. This is the pattern of the cloud controller's home store
 * (`packages/cloud-controller/src/agent/home-store.ts`: "sealed under a per-agent subkey, with the
 * object kind and digest as associated data, so an object moved to another agent, kind or digest
 * fails to open"), done with Node's `crypto` and no format of our own beyond a fixed header:
 *
 *     "ATUM-AHS1\n"  magic, 10 bytes
 *     keyId          43 bytes, ASCII (which data key sealed it)
 *     nonce          12 bytes, random per seal
 *     ciphertext     the plaintext archive, streamed
 *     tag            16 bytes
 *
 * `openFile` writes the plaintext only after the tag verifies: it decrypts into a `.part` file and
 * renames it on success, so a damaged or substituted object never leaves readable plaintext behind.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, open, rename, rm, stat } from 'node:fs/promises'

export const SEAL_MAGIC = 'ATUM-AHS1\n'
const KEY_ID_BYTES = 43
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = SEAL_MAGIC.length + KEY_ID_BYTES + NONCE_BYTES
const CHUNK_BYTES = 1 << 20
const NUL = String.fromCharCode(0)

export interface SealKey {
  /** An opaque 43-character id for the data key, written in the header and checked on open. */
  keyId: string
  /** 32 random bytes. */
  key: Buffer
}

export type SealFailure = 'seal_key_invalid' | 'seal_key_mismatch' | 'seal_format_invalid' | 'seal_open_failed'

export class SealError extends Error {
  constructor(readonly code: SealFailure) {
    super(code)
    this.name = 'SealError'
  }
}

/** What the tag authenticates besides the bytes: the object cannot be moved to another home or generation. */
export function sealAad(homeId: string, generation: number): Buffer {
  return Buffer.from(`atum.agent-home/2.1${NUL}archive${NUL}${homeId}${NUL}${generation}`, 'utf8')
}

function checkedKey(key: SealKey): void {
  if (!Buffer.isBuffer(key.key) || key.key.length !== 32 || !/^[A-Za-z0-9_-]{43}$/u.test(key.keyId)) {
    throw new SealError('seal_key_invalid')
  }
}

export async function sealFile(input: {
  plain: string
  sealed: string
  key: SealKey
  homeId: string
  generation: number
  random?(size: number): Buffer
}): Promise<{ bytes: number; sha256: string }> {
  checkedKey(input.key)

  const nonce = (input.random ?? randomBytes)(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', input.key.key, nonce)
  cipher.setAAD(sealAad(input.homeId, input.generation))
  const digest = createHash('sha256')
  const source = await open(input.plain, 'r')
  let target
  // Only a file this call created is ever removed on failure: `wx` fails on one that is already there.
  let created = false

  try {
    target = await open(input.sealed, 'wx', 0o600)
    created = true
    let bytes = 0

    const write = async (chunk: Buffer) => {
      if (chunk.length === 0) {
        return
      }

      digest.update(chunk)
      bytes += chunk.length
      await target!.write(chunk)
    }

    await write(Buffer.concat([Buffer.from(SEAL_MAGIC, 'utf8'), Buffer.from(input.key.keyId, 'ascii'), nonce]))
    const buffer = Buffer.alloc(CHUNK_BYTES)

    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, CHUNK_BYTES, null)

      if (bytesRead === 0) {
        break
      }

      await write(cipher.update(buffer.subarray(0, bytesRead)))
    }

    await write(cipher.final())
    await write(cipher.getAuthTag())
    await target.sync()

    return { bytes, sha256: digest.digest('hex') }
  } catch (error) {
    await target?.close().catch(() => {})
    target = undefined

    if (created) {
      await rm(input.sealed, { force: true })
    }

    throw error
  } finally {
    await source.close()
    await target?.close().catch(() => {})
  }
}

export async function openFile(input: {
  sealed: string
  plain: string
  key: SealKey
  homeId: string
  generation: number
}): Promise<{ bytes: number }> {
  checkedKey(input.key)

  const size = (await stat(input.sealed)).size

  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new SealError('seal_format_invalid')
  }

  const source = await open(input.sealed, 'r')
  const part = `${input.plain}.part`
  let target

  try {
    const header = Buffer.alloc(HEADER_BYTES)
    await source.read(header, 0, HEADER_BYTES, 0)

    if (header.subarray(0, SEAL_MAGIC.length).toString('utf8') !== SEAL_MAGIC) {
      throw new SealError('seal_format_invalid')
    }

    const keyId = header.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + KEY_ID_BYTES).toString('ascii')

    if (keyId !== input.key.keyId) {
      throw new SealError('seal_key_mismatch')
    }

    const nonce = header.subarray(SEAL_MAGIC.length + KEY_ID_BYTES)
    const tag = Buffer.alloc(TAG_BYTES)
    await source.read(tag, 0, TAG_BYTES, size - TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', input.key.key, nonce)
    decipher.setAAD(sealAad(input.homeId, input.generation))
    decipher.setAuthTag(tag)

    target = await open(part, 'wx', 0o600)
    const end = size - TAG_BYTES
    const buffer = Buffer.alloc(CHUNK_BYTES)
    let position = HEADER_BYTES
    let bytes = 0

    while (position < end) {
      const length = Math.min(CHUNK_BYTES, end - position)
      const { bytesRead } = await source.read(buffer, 0, length, position)

      if (bytesRead === 0) {
        throw new SealError('seal_format_invalid')
      }

      const plain = decipher.update(buffer.subarray(0, bytesRead))
      bytes += plain.length
      position += bytesRead
      await target.write(plain)
    }

    const last = decipher.final()
    bytes += last.length
    await target.write(last)
    await target.sync()
    await target.close()
    target = undefined
    await chmod(part, 0o600)
    await rename(part, input.plain)

    return { bytes }
  } catch (error) {
    await target?.close().catch(() => {})
    await rm(part, { force: true })

    if (error instanceof SealError) {
      throw error
    }

    // A tag that does not verify: damaged, substituted, or sealed for another home or generation.
    throw new SealError('seal_open_failed')
  } finally {
    await source.close()
  }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** The one sealing root there is (atum-platform `AGENT_HOME_SEALING_ROOT_VERSION`). */
export const SEALING_ROOT_VERSION = 1

/**
 * The name the platform gives the data key of one owner's agent home: `agentHomeSealKeyId` in atum-platform's
 * `apps/shell/src/lib/agent-home-archive.ts`, character for character. It is the unpadded base64url of the SHA-256 of
 * the root version as one byte, then `atum.agent-home/2.1`, `owner_agent_home`, the owner's principal, the agent's
 * principal and the home id, each after a NUL. It is NOT a digest of the key, so it cannot be recomputed from what the
 * platform sends: a Mac that knows who the owner is, which agent and which home it asked about recomputes it and
 * refuses a key the platform named for any other tuple, before it seals or opens anything with that key.
 * The platform throws for anything that is not a UUID or a root other than 1; so does this.
 */
export function agentHomeSealKeyId(rootVersion: number, owner: string, agent: string, homeId: string): string {
  if (rootVersion !== SEALING_ROOT_VERSION || !UUID_TEXT.test(owner) || !UUID_TEXT.test(agent) || !UUID_TEXT.test(homeId)) {
    throw new SealError('seal_key_invalid')
  }

  return createHash('sha256')
    .update(Buffer.from([rootVersion]))
    .update(`atum.agent-home/2.1${NUL}owner_agent_home${NUL}${owner}${NUL}${agent}${NUL}${homeId}`, 'utf8')
    .digest('base64url')
}

/** A fresh data key (what a key source hands out the first time a home needs one). */
export function newSealKey(random: (size: number) => Buffer = randomBytes): SealKey {
  const key = random(32)

  return { key, keyId: createHash('sha256').update(key).update('atum.agent-home/2.1 seal key id').digest('base64url') }
}
