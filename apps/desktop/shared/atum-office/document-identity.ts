/**
 * The durable identity of a workspace document.
 *
 * Two facts drive this module.
 *
 * First, the lease reference (`fileRef`) is 32 random bytes minted per open and
 * dead on release or main-process restart. It is liveness, not identity, and
 * must never key durable metadata.
 *
 * Second, `workspaceRelativePath` is *not* computed by the lease provider — it
 * is passed in verbatim by whichever code opened the file, and today the
 * producers disagree: one emits POSIX separators, another emits platform
 * separators, and only some apply NFC normalisation. Rather than trusting any
 * of them, every durable lookup is normalised here. Callers may hand us any of
 * those spellings of the same document and get the same key.
 *
 * Account scoping is deliberately absent from the key: each account's metadata
 * lives in its own account-private file under its own `accountKey` directory,
 * so isolation is structural rather than something a key prefix has to enforce.
 * Account *generation* is likewise excluded — it is a revocation epoch that
 * changes on every sign-in, so folding it in would silently discard a person's
 * choices each time they signed back in.
 */

export type DocumentIdentityPlatform = 'darwin' | 'win32' | 'linux' | string

/**
 * Case-folds on the platforms whose filesystems are case-insensitive, matching
 * the comparison rule the filesystem authority already uses for confinement.
 * Two spellings that name the same file therefore share one theme.
 */
function caseFold(value: string, platform: DocumentIdentityPlatform): string {
  return platform === 'darwin' || platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
}

/**
 * Normalise a workspace-relative path into a durable metadata key.
 *
 * Returns null for anything that cannot safely name a document inside the
 * workspace: an empty value, an absolute path, a Windows drive or UNC prefix,
 * or any path that walks upward. A null result means "no durable identity",
 * and every caller treats that as "use the default and store nothing" rather
 * than inventing a key.
 */
export function normalizeDocumentKey(
  workspaceRelativePath: unknown,
  platform: DocumentIdentityPlatform = process.platform
): string | null {
  if (typeof workspaceRelativePath !== 'string') {
    return null
  }

  // Unicode first: 'ạ' composed and decomposed must not become two documents.
  const unified = workspaceRelativePath.normalize('NFC').replace(/\\/gu, '/')

  if (unified.length === 0 || unified.startsWith('/')) {
    return null
  }

  // A drive letter or UNC share is an absolute path wearing a relative coat.
  if (/^[a-z]:/iu.test(unified)) {
    return null
  }

  const segments: string[] = []

  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      return null
    }

    // A NUL byte would truncate the path at any syscall that later saw it.
    if (segment.includes('\u0000')) {
      return null
    }

    segments.push(segment)
  }

  if (segments.length === 0) {
    return null
  }

  return caseFold(segments.join('/'), platform)
}

/**
 * True when `key` names `prefix` itself or anything beneath it. Used to move a
 * whole subtree's metadata when a folder is renamed.
 */
export function documentKeyIsWithin(prefix: string, key: string): boolean {
  return key === prefix || key.startsWith(`${prefix}/`)
}

/** Re-root `key` from `fromPrefix` onto `toPrefix`. */
export function reparentDocumentKey(key: string, fromPrefix: string, toPrefix: string): string {
  if (key === fromPrefix) {
    return toPrefix
  }

  return `${toPrefix}${key.slice(fromPrefix.length)}`
}
