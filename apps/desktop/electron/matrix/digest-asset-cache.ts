import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DIGEST = /^[a-f0-9]{64}$/u

export interface DigestAssetCache {
  read(sha256: string): Promise<{ mime: string; bytes: Buffer } | null>
  write(sha256: string, mime: string, bytes: Buffer): Promise<void>
}

export interface DigestAssetCacheOptions {
  mimeExtensions: Readonly<Record<string, string>>
  maxAssetBytes: number
  maxEntries: number
  maxBytes: number
}

export const assetDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Per-account, content-addressed LRU used by both app icons and look assets.
 * Reads re-verify bytes, writes are atomic/private, and a path component is
 * accepted only when it is itself a SHA-256 digest.
 */
export class DigestAssetDiskCache {
  constructor(
    private readonly root: string,
    private readonly options: DigestAssetCacheOptions
  ) {}

  forAccount(accountKey: string): DigestAssetCache | null {
    if (!DIGEST.test(accountKey)) {
      return null
    }

    const directory = path.join(this.root, accountKey)

    return {
      read: sha256 => this.read(directory, sha256),
      write: (sha256, mime, bytes) => this.write(directory, sha256, mime, bytes)
    }
  }

  private async read(directory: string, sha256: string): Promise<{ mime: string; bytes: Buffer } | null> {
    if (!DIGEST.test(sha256)) {
      return null
    }

    for (const [mime, extension] of Object.entries(this.options.mimeExtensions)) {
      const file = path.join(directory, `${sha256}.${extension}`)
      let bytes: Buffer

      try {
        bytes = await readFile(file)
      } catch {
        continue
      }

      if (bytes.byteLength > this.options.maxAssetBytes || assetDigest(bytes) !== sha256) {
        await rm(file, { force: true }).catch(() => {})

        continue
      }

      const now = new Date()
      await utimes(file, now, now).catch(() => {})

      return { mime, bytes }
    }

    return null
  }

  private async write(directory: string, sha256: string, mime: string, bytes: Buffer): Promise<void> {
    const extension = this.options.mimeExtensions[mime]

    if (
      !DIGEST.test(sha256) ||
      !extension ||
      bytes.byteLength > this.options.maxAssetBytes ||
      assetDigest(bytes) !== sha256
    ) {
      return
    }

    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, `${sha256}.${extension}`)
    const partial = path.join(directory, `.${randomUUID()}.partial`)

    try {
      await writeFile(partial, bytes, { mode: 0o600 })
      await rename(partial, file)
    } finally {
      await rm(partial, { force: true }).catch(() => {})
    }

    await this.trim(directory)
  }

  private async trim(directory: string): Promise<void> {
    const entries: { file: string; size: number; used: number }[] = []

    for (const name of await readdir(directory)) {
      const file = path.join(directory, name)

      try {
        const info = await stat(file)

        if (info.isFile()) {
          entries.push({ file, size: info.size, used: info.mtimeMs })
        }
      } catch {
        // Removed meanwhile.
      }
    }

    entries.sort((left, right) => right.used - left.used)
    let total = 0

    for (const [index, entry] of entries.entries()) {
      total += entry.size

      if (index >= this.options.maxEntries || total > this.options.maxBytes) {
        await rm(entry.file, { force: true }).catch(() => {})
      }
    }
  }
}
