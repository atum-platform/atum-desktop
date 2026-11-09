import path from 'node:path'

import type { EncryptedStore } from '../encrypted-store'

/** Read-only owner seam; keys are namespace-relative and filtered before decrypting. */
export interface MatrixWorkspaceDriveBindings extends Pick<EncryptedStore, 'getItem' | 'failureCode'> {
  keys(prefix: string): readonly string[]
}

/** Main-only roots, including legacy bindings before identity or device startup. */
export function readMatrixWorkspaceDriveRoots(
  store: Pick<EncryptedStore, 'getItem' | 'failureCode'>,
  bindings: MatrixWorkspaceDriveBindings,
  live: readonly string[] = [],
  previous: readonly string[] = []
): string[] {
  try {
    const raw = store.getItem('roots')

    if (store.failureCode()) {
      throw new Error('unavailable')
    }

    const stored: unknown = JSON.parse(raw ?? '[]')

    if (!Array.isArray(stored)) {
      throw new Error('malformed')
    }

    const legacy: unknown[] = []

    for (const key of bindings.keys('drive-root:')) {
      if (!key.startsWith('drive-root:')) {
        throw new Error('malformed')
      }

      const rawBinding = bindings.getItem(key)

      if (bindings.failureCode() || rawBinding === null) {
        throw new Error('unavailable')
      }

      // Disconnect writes an empty binding tombstone. It is not a failed decode.
      if (rawBinding === '') {
        continue
      }

      const binding: unknown = JSON.parse(rawBinding)

      if (
        !binding ||
        typeof binding !== 'object' ||
        !('root' in binding) ||
        !('dev' in binding) ||
        !('ino' in binding) ||
        !Number.isSafeInteger(binding.dev) ||
        !Number.isSafeInteger(binding.ino)
      ) {
        throw new Error('malformed')
      }

      legacy.push(binding.root)
    }

    if (bindings.failureCode()) {
      throw new Error('unavailable')
    }

    const roots: unknown[] = [...previous, ...stored, ...legacy, ...live]

    if (!roots.every(root => typeof root === 'string' && path.isAbsolute(root) && !root.includes('\0'))) {
      throw new Error('malformed')
    }

    return [...new Set(roots as string[])]
  } catch {
    // JSON/OS/decryption messages can contain paths or record contents. Only this code leaves.
    throw new Error('workspace_layout_deferred')
  }
}
