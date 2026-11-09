import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Main-owned factory used by the real Matrix composition and real-file tests. */
export function matrixDocumentRecoveryRoot(userData: string, accountId: string, deviceId: string, roomId: string): string {
  try {
    const root = realpathSync(userData)
    const listed = lstatSync(root)

    if (!listed.isDirectory() || listed.isSymbolicLink() || !/^[a-zA-Z0-9_-]{1,128}$/u.test(accountId) || !deviceId || !roomId.startsWith('!')) {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    const scope = createHash('sha256').update(JSON.stringify([deviceId, roomId])).digest('hex')
    let current = root

    // Create one level at a time. Validate before chmod so a pre-existing
    // symlink can never redirect the private directory's creation or mode.
    for (const segment of ['matrix-documents', accountId, scope, 'document-recovery']) {
      current = path.join(current, segment)

      try {mkdirSync(current, { mode: 0o700 })} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
      }

      const entry = lstatSync(current)

      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(current) !== current) {
        throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
      }

      chmodSync(current, 0o700)
    }

    return current
  } catch {throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')}
}
