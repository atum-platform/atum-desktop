import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { BackgroundSweepMacFile } from './background-sweep-evidence'

const MAX_ROOTS = 4
const MAX_VISITED = 500
const MAX_DEPTH = 3
const MAX_RESULTS = 20
const SKIP_DIRECTORY = new Set(['.git', '.svn', 'node_modules', '__pycache__', '.Trash'])
const SENSITIVE_NAME = /^(?:[.]env(?:[.]|$)|id_(?:rsa|ed25519)|.*(?:password|private.?key|credential|secret|token).*)/iu

export interface RecentMacFilesInput {
  /**
   * Roots main has already determined are background-safe. This function never discovers or probes
   * Desktop, Documents or Downloads, because even a permission probe can open a macOS prompt.
   */
  roots: readonly string[]
  since: number
  limit?: number
}

/** Bounded metadata-only scan: regular-file base names and mtimes, with no contents or paths. */
export async function recentMacFileNames(input: RecentMacFilesInput): Promise<BackgroundSweepMacFile[]> {
  const limit = Math.max(0, Math.min(MAX_RESULTS, Math.trunc(input.limit ?? 8)))
  if (!Number.isSafeInteger(input.since) || input.since < 0 || limit === 0) {
    return []
  }

  const files: BackgroundSweepMacFile[] = []
  let visited = 0

  const walk = async (root: string, directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited >= MAX_VISITED) {
      return
    }

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // A root that is not already readable is skipped. Never retry or ask for permission here.
      return
    }

    for (const entry of entries) {
      if (visited++ >= MAX_VISITED) {
        return
      }
      if (entry.name.startsWith('.') || SENSITIVE_NAME.test(entry.name)) {
        continue
      }

      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORY.has(entry.name)) {
          await walk(root, candidate, depth + 1)
        }
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      try {
        const facts = await lstat(candidate)
        const modifiedAt = Math.trunc(facts.mtimeMs)
        if (!facts.isFile() || !Number.isSafeInteger(modifiedAt) || modifiedAt < input.since) {
          continue
        }
        const relative = path.relative(root, candidate).normalize('NFC')
        files.push({
          identity: createHash('sha256').update(`${root}\0${relative}`, 'utf8').digest('hex'),
          name: path.basename(candidate),
          modifiedAt
        })
      } catch {
        // A disappearing or newly unreadable entry does not make the background scan interactive.
      }
    }
  }

  for (const root of [...new Set(input.roots)].slice(0, MAX_ROOTS)) {
    if (typeof root === 'string' && path.isAbsolute(root)) {
      await walk(path.resolve(root), path.resolve(root), 0)
    }
  }

  return files.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name)).slice(0, limit)
}
