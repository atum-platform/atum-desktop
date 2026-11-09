import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { type FileHandle, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface UserSelectedFileSaveOptions {
  /** Test seam for forcing short writes or a failure after real bytes reach the temp file. */
  writeChunk?: (file: FileHandle, bytes: Buffer, offset: number) => Promise<number>
}

async function writeChunk(file: FileHandle, bytes: Buffer, offset: number): Promise<number> {
  const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null)

  return bytesWritten
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null

  try {
    handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
    await handle.sync()
  } catch {
    // The file is already fsync'd and rename is atomic. Directory fsync is a
    // best-effort durability improvement on platforms that support it.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Publish bytes at a user-approved destination without ever opening the
 * destination for writing. The exclusive sibling is fully written and flushed
 * before one same-directory rename replaces the selected entry.
 */
export async function saveUserSelectedFile(
  targetPath: string,
  input: Uint8Array,
  options: UserSelectedFileSaveOptions = {}
): Promise<void> {
  const directory = path.dirname(targetPath)
  const temporary = path.join(directory, `.atum-save-${randomBytes(16).toString('hex')}.tmp`)
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const write = options.writeChunk ?? writeChunk
  let handle: FileHandle | null = null
  let ownsTemporary = false

  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    )
    ownsTemporary = true

    let offset = 0

    while (offset < bytes.byteLength) {
      const written = await write(handle, bytes, offset)

      if (!Number.isInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
        throw new Error('USER_SELECTED_FILE_WRITE_INCOMPLETE')
      }

      offset += written
    }

    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, targetPath)
    ownsTemporary = false
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})

    if (ownsTemporary) {
      await unlink(temporary).catch(() => {})
    }

    throw error
  }
}
