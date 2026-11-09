import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { AwarenessStore } from './types'

/** RT supplies a private, account-isolated directory on its encrypted storage.
 * One owning process only; process supervision/locking belongs to RT. This file
 * contains receipt/control metadata, never event plaintext, tokens or keys.
 * Existing directories are not chmodded. Corruption/permission errors propagate;
 * only a genuinely absent file is a fresh reader. */
export function awarenessFileStore(file: string): AwarenessStore {
  if (!path.isAbsolute(file)) {
    throw new Error('awareness_store_invalid')
  }

  const directory = path.dirname(file)

  const checkDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)

    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('awareness_store_directory_not_private')
    }
  }

  return {
    async read() {
      await checkDirectory()
      let handle

      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }

        throw new Error('awareness_store_unavailable')
      }

      try {
        const stat = await handle.stat()

        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) {
          throw new Error('awareness_store_invalid')
        }

        return JSON.parse(await handle.readFile('utf8'))
      } catch {
        throw new Error('awareness_store_invalid')
      } finally {
        await handle.close()
      }
    },
    async write(value) {
      await checkDirectory()
      const body = JSON.stringify(value)

      if (Buffer.byteLength(body, 'utf8') > 16 * 1024 * 1024) {
        throw new Error('awareness_store_full')
      }

      const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)

      try {
        await handle.writeFile(body, 'utf8')
        await handle.sync()
        await handle.close()
        await rename(temporary, file)
        const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)

        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      } catch {
        await handle.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw new Error('awareness_store_unavailable')
      }
    }
  }
}
