/**
 * Canonical document identity for Atum Office Phase 0.
 *
 * One helper shared by document creation (workspace start page), the composer
 * auto-context chip, and agent-edit review state, so every surface agrees on
 * what "the same file" and "inside this chat's workspace" mean. Pure string
 * work — it runs in the renderer, where Node's `path` is unavailable.
 *
 * Paths are normalized to forward slashes with `.`/`..` segments resolved and
 * no trailing separator. Windows drive letters compare case-insensitively.
 */

export interface DocumentIdentity {
  /** Normalized absolute path — the key for review state and suppression memory. */
  path: string
  /** Posix-style path relative to the workspace root, or null when outside it. */
  relativePath: string | null
  /** Display name (file name only). */
  name: string
  inWorkspace: boolean
}

const TEXT_DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

const DRIVE_RE = /^[A-Za-z]:(?=\/|$)/u

function hasDrive(value: string) {
  return DRIVE_RE.test(value)
}

/** Collapse separators, resolve `.`/`..`, drop the trailing slash. */
export function normalizeFsPath(raw: string): string {
  let value = raw.trim().replace(/\\/gu, '/')

  if (!value) {
    return ''
  }

  const drive = hasDrive(value) ? value.slice(0, 2).toUpperCase() : ''

  if (drive) {
    value = value.slice(2)
  }

  const absolute = value.startsWith('/')
  const out: string[] = []

  for (const part of value.split('/')) {
    if (!part || part === '.') {
      continue
    }

    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!absolute) {
        out.push('..')
      }

      continue
    }

    out.push(part)
  }

  const body = out.join('/')

  if (drive) {
    return `${drive}/${body}`
  }

  return absolute ? `/${body}` : body
}

export function isAbsoluteFsPath(raw: string): boolean {
  const value = raw.trim().replace(/\\/gu, '/')

  return value.startsWith('/') || hasDrive(value)
}

/** `file://` preview sources back to a filesystem path; other values pass through normalization. */
export function fsPathFromSource(source: string): string {
  const trimmed = source.trim()

  if (/^file:\/\//iu.test(trimmed)) {
    let rest = trimmed.replace(/^file:\/\/(localhost)?/iu, '')

    try {
      rest = decodeURIComponent(rest)
    } catch {
      /* keep raw */
    }

    // `file:///C:/x` → `C:/x`
    if (/^\/[A-Za-z]:/u.test(rest)) {
      rest = rest.slice(1)
    }

    return normalizeFsPath(rest)
  }

  return normalizeFsPath(trimmed)
}

function comparable(value: string) {
  return hasDrive(value) ? value.toLowerCase() : value
}

/** Posix-style relative path when `path` is inside `workspaceRoot`, else null. Root itself is not a document. */
export function workspaceRelativePath(path: string, workspaceRoot: null | string | undefined): string | null {
  if (!workspaceRoot) {
    return null
  }

  const file = normalizeFsPath(path)
  const root = normalizeFsPath(workspaceRoot)

  if (!file || !root || !isAbsoluteFsPath(file) || !isAbsoluteFsPath(root)) {
    return null
  }

  const prefix = root.endsWith('/') ? root : `${root}/`

  if (!comparable(file).startsWith(comparable(prefix))) {
    return null
  }

  const rel = file.slice(prefix.length)

  return rel || null
}

export function isInsideWorkspace(path: string, workspaceRoot: null | string | undefined): boolean {
  return workspaceRelativePath(path, workspaceRoot) !== null
}

export function documentDisplayName(path: string): string {
  const normalized = normalizeFsPath(path)

  return normalized.split('/').filter(Boolean).pop() || normalized
}

export function documentExtension(path: string): string {
  const name = documentDisplayName(path)
  const idx = name.lastIndexOf('.')

  return idx > 0 ? name.slice(idx).toLowerCase() : ''
}

/** Phase 0 documents are plain-text/Markdown files; everything else is a preview, not a document. */
export function isTextDocumentPath(path: string): boolean {
  return TEXT_DOCUMENT_EXTENSIONS.has(documentExtension(path))
}

export function documentIdentity(path: string, workspaceRoot: null | string | undefined): DocumentIdentity {
  const normalized = normalizeFsPath(path)
  const relativePath = workspaceRelativePath(normalized, workspaceRoot)

  return { inWorkspace: relativePath !== null, name: documentDisplayName(normalized), path: normalized, relativePath }
}

export const DEFAULT_DOCUMENT_BASENAME = 'Tài liệu'

/**
 * First collision-free `Tài liệu N.md` (N from 1) given the names already in
 * the target folder. Comparison is case-insensitive so macOS/Windows folders
 * never receive a name that differs only by case.
 */
export function nextDocumentName(
  existingNames: Iterable<string>,
  base = DEFAULT_DOCUMENT_BASENAME,
  extension = '.md'
): string {
  const taken = new Set<string>()

  for (const name of existingNames) {
    taken.add(documentDisplayName(name).toLowerCase())
  }

  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${base} ${n}${extension}`

    if (!taken.has(candidate.toLowerCase())) {
      return candidate
    }
  }

  return `${base} ${Date.now()}${extension}`
}

/** Join a workspace root and a relative name into a normalized absolute path. */
export function joinWorkspacePath(workspaceRoot: string, relative: string): string {
  return normalizeFsPath(`${workspaceRoot.replace(/[\\/]+$/u, '')}/${relative}`)
}
