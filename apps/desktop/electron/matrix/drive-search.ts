import type { Dir, Stats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface DriveNameMatch {
  path: string
  name: string
  folders: string[]
  stat: Stats
}

interface SearchLimits {
  signal?: AbortSignal
  check?(): void
  results?: number
  entries?: number
  depth?: number
  timeoutMs?: number
}

export function validDriveSearchQuery(query: unknown): query is string {
  return (
    typeof query === 'string' &&
    query.trim().length > 0 &&
    query.length <= 256 &&
    !/[\\/]/u.test(query) &&
    [...query].every(char => char.codePointAt(0)! >= 32 && char.codePointAt(0)! !== 127) &&
    !['.', '..'].includes(query.trim())
  )
}

/** Local names/metadata only. The engine owns its journal; never query it behind its back.
 * Streaming directory reads bound memory even in a huge folder. Every await has an IO deadline;
 * every directory and returned match is canonical, and main rechecks its owner/root and handles.
 */
export async function searchDriveNames(root: string, start: string, query: string, limits: SearchLimits) {
  const inside = (file: string) => file === root || file.startsWith(root + path.sep)

  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !inside(start) ||
    path.resolve(start) !== start ||
    !validDriveSearchQuery(query)
  ) {
    throw new Error('matrix_drive_search_invalid')
  }

  const deadline = Date.now() + Math.min(limits.timeoutMs ?? 5_000, 5_000)
  const maxResults = Math.min(limits.results ?? 500, 500)
  const maxEntries = Math.min(limits.entries ?? 20_000, 20_000)
  const maxDepth = Math.min(limits.depth ?? 32, 32)
  const rows: DriveNameMatch[] = []
  let visited = 0
  let truncated = false

  const check = () => {
    limits.signal?.throwIfAborted()
    limits.check?.()
    limits.signal?.throwIfAborted()

    if (Date.now() >= deadline) {
      throw new Error('matrix_drive_search_timeout')
    }
  }

  const io = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => rejectAbort?.(new Error('matrix_drive_search_cancelled'))
    let rejectAbort: ((error: Error) => void) | undefined

    try {
      check()

      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          rejectAbort = reject
          limits.signal?.addEventListener('abort', abort, { once: true })
          timer = setTimeout(
            () => reject(new Error('matrix_drive_search_timeout')),
            Math.max(0, Math.min(500, deadline - Date.now()))
          )
        })
      ])
    } finally {
      clearTimeout(timer)
      limits.signal?.removeEventListener('abort', abort)
    }
  }

  const canonicalDirectory = async (directory: string) => {
    check()
    const stat = await io(() => lstat(directory))

    if (
      !inside(directory) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (await io(() => realpath(directory))) !== directory
    ) {
      throw new Error('matrix_drive_search_invalid')
    }

    return stat
  }

  // Invalid starting boundaries refuse the entire request, not an apparently empty search.
  if ((limits.timeoutMs ?? 5_000) <= 0) {
    return { rows, truncated: true }
  }

  await canonicalDirectory(root)
  await canonicalDirectory(start)
  const queue = [{ directory: start, depth: 0 }]
  const needle = query.trim().normalize('NFC').toLowerCase()

  try {
    while (queue.length) {
      check()
      const { directory, depth } = queue.shift()!
      let dir: Dir | undefined

      try {
        const before = await canonicalDirectory(directory)
        // If opening times out, close the eventual handle too; no orphan directory leases.
        let abandoned = false

        const opening = () =>
          opendir(directory, { bufferSize: 32 }).then(handle => {
            if (abandoned) {
              void handle.close().catch(() => {})
            }

            return handle
          })

        try {
          dir = await io(opening)
        } catch (error) {
          abandoned = true
          throw error
        }

        const after = await canonicalDirectory(directory)

        if (after.dev !== before.dev || after.ino !== before.ino) {
          throw new Error('matrix_drive_search_invalid')
        }

        for (;;) {
          check()
          const entry = await io(() => dir!.read())

          if (!entry) {
            break
          }

          if (++visited > maxEntries) {
            truncated = true

            break
          }

          if (entry.name.startsWith('.') || (!entry.isFile() && !entry.isDirectory())) {
            continue
          }

          const file = path.join(directory, entry.name)
          const stat = await io(() => lstat(file))

          if (
            stat.isSymbolicLink() ||
            (!stat.isFile() && !stat.isDirectory()) ||
            (await io(() => realpath(file))) !== file
          ) {
            continue
          }

          if (entry.name.normalize('NFC').toLowerCase().includes(needle)) {
            rows.push({
              path: file,
              name: entry.name,
              folders: path.relative(root, directory).split(path.sep).filter(Boolean),
              stat
            })

            if (rows.length >= maxResults) {
              truncated = true

              break
            }
          }

          if (stat.isDirectory()) {
            if (depth < maxDepth) {
              queue.push({ directory: file, depth: depth + 1 })
            } else {
              truncated = true
            }
          }
        }

        // A swapped parent never contributes authority, even if its children looked ordinary.
        const final = await canonicalDirectory(directory)

        if (final.dev !== before.dev || final.ino !== before.ino) {
          throw new Error('matrix_drive_search_invalid')
        }
      } catch (error) {
        check()

        if (error instanceof Error && error.message === 'matrix_drive_search_timeout') {
          throw error
        }

        truncated = true
      } finally {
        if (dir) {
          void dir.close().catch(() => {})
        }
      }

      if (visited > maxEntries || rows.length >= maxResults) {
        break
      }
    }
  } catch (error) {
    limits.signal?.throwIfAborted()

    if (!(error instanceof Error) || error.message !== 'matrix_drive_search_timeout') {
      throw error
    }

    truncated = true
  }

  return { rows, truncated }
}
