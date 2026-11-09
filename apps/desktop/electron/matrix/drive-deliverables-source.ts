import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

import { excludedFromWorkspace, validWorkspacePath } from './device/workspace'
import { MAC_DELIVERABLE_LIMITS } from './drive-deliverables-contract'
import type { MacDeliverableFile, MacPreparedDeliverable } from './drive-deliverables-contract'
import { matrixDriveImportPatterns } from './drive-exclusions'

const patterns = matrixDriveImportPatterns().map(rule => ({ ...rule, matcher: new RegExp(rule.expression, 'iu') }))
const inside = (file: string, directory: string) => file === directory || file.startsWith(directory + path.sep)

export function validMacDeliverablePath(value: unknown): value is string {
  return (
    validWorkspacePath(value) &&
    value === value.normalize('NFC') &&
    !excludedFromWorkspace(value) &&
    !patterns.some(rule => rule.matcher.test(value) || (rule.directoryOnly && rule.matcher.test(value + '/')))
  )
}

/** Read only explicit files. The turn must be quiesced by its native owner before collection. */
export async function snapshotMacDeliverables(
  root: string,
  protectedDriveRoots: readonly string[],
  files: readonly MacDeliverableFile[]
): Promise<MacPreparedDeliverable[]> {
  if (
    !['darwin', 'linux'].includes(process.platform) ||
    !path.isAbsolute(root) ||
    files.length < 1 ||
    files.length > MAC_DELIVERABLE_LIMITS.files
  ) {
    throw new Error('mac_deliverables_invalid')
  }

  const normalized = path.resolve(root)

  if (protectedDriveRoots.some(value => !path.isAbsolute(value))) {
    throw new Error('mac_deliverables_invalid')
  }

  const protectedRoots = await Promise.all(
    protectedDriveRoots.map(async value => {
      const resolved = path.resolve(value)

      return await realpath(resolved).catch(() => resolved)
    })
  )

  const rootBefore = await lstat(normalized, { bigint: true })

  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || (await realpath(normalized)) !== normalized) {
    throw new Error('mac_deliverables_invalid')
  }

  if (protectedRoots.some(value => inside(normalized, value))) {
    throw new Error('mac_deliverables_invalid')
  }

  const out: MacPreparedDeliverable[] = []
  let total = 0

  for (const file of files) {
    if (!validMacDeliverablePath(file.path)) {
      throw new Error('mac_deliverables_invalid')
    }

    const source = path.join(normalized, ...file.path.split('/'))

    if (!inside(source, normalized) || protectedRoots.some(value => inside(source, value))) {
      throw new Error('mac_deliverables_invalid')
    }

    const parent = path.dirname(source)

    if ((await realpath(parent)) !== parent) {
      throw new Error('mac_deliverables_invalid')
    }

    const before = await lstat(source, { bigint: true })

    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAC_DELIVERABLE_LIMITS.fileBytes)) {
      throw new Error('mac_deliverables_invalid')
    }

    total += Number(before.size)

    if (total > MAC_DELIVERABLE_LIMITS.totalBytes) {
      throw new Error('mac_deliverables_invalid')
    }

    // O_NONBLOCK prevents a replaced regular file becoming a FIFO that hangs the read.
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)

    try {
      const opened = await handle.stat({ bigint: true })

      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) {
        throw new Error('mac_deliverables_invalid')
      }

      const bytes = Buffer.alloc(Number(before.size))

      for (let offset = 0; offset < bytes.length; ) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)

        if (read.bytesRead === 0) {
          throw new Error('mac_deliverables_invalid')
        }

        offset += read.bytesRead
      }

      const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length)
      const after = await handle.stat({ bigint: true })
      const named = await lstat(source, { bigint: true })
      const rootAfter = await lstat(normalized, { bigint: true })

      if (
        extra.bytesRead ||
        !sameFile(before, after) ||
        !sameFile(before, named) ||
        rootBefore.dev !== rootAfter.dev ||
        rootBefore.ino !== rootAfter.ino ||
        (await realpath(normalized)) !== normalized ||
        (await realpath(parent)) !== parent
      ) {
        throw new Error('mac_deliverables_invalid')
      }

      out.push({
        path: file.path,
        baseEtag: file.baseEtag ?? null,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    } finally {
      await handle.close()
    }
  }

  return out
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}
