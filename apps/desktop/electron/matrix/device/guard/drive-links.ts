/**
 * Hard links inside the owner's Drive (the review's P1 "precondition").
 *
 * Seatbelt matches the path a process names, not the inode. A regular file under a writable Drive
 * root that is ALSO another name for a protected file (`~/.ssh/id_ed25519`, `~/.zshrc`, a vault
 * file) would be readable and writable through its Drive spelling. The sandbox itself cannot
 * create such a link (`ln <protected> <Drive>/x` is refused by the kernel; proven in
 * `drive-guard.boundary.test.ts`), so the precondition is a link made OUTSIDE the sandbox, by
 * the owner or another program.
 *
 * Mitigation within reason: each profile build advances a bounded, resumable walk of every
 * writable Drive root and denies, by literal path, any regular file with `nlink > 1` it has found
 * (the old working-copy path rejected `nlink !== 1` too). The walk is bounded per call by entries
 * AND wall time, checked for every entry: one directory of a million files is read a slice at a
 * time through an `opendir` handle kept open between calls, never drained in one. A large Drive is
 * therefore covered over the next few commands, not by blocking one; a finished walk is repeated
 * after {@link RESCAN_AFTER_MS}. What it cannot promise, and the session log records: a hard link
 * created outside the sandbox and used before the walk reaches its directory is not yet denied.
 *
 * The profile must not grow without bound (a pnpm store holds thousands of linked files), but a
 * cap must never leave a protected link writable. So past {@link MAX_DENIED} files the walk keeps
 * going and denies the FOLDER that holds each further link, as a whole subtree (read and write), and
 * stops walking inside it; folders are capped too ({@link MAX_FOLDERS}) by folding them into their
 * parents, and in the limit the Drive root itself is denied. Engine-excluded trees (`node_modules`,
 * `.git`, …) are walked like any other.
 *
 * A walk belongs to the directory it began in. A root removed and recreated at the same path is a new
 * tree and is walked from scratch; "the same directory" is `drive-root-identity.ts`'s answer (device,
 * inode and creation time, or the binding marker), because a filesystem may hand the old inode number
 * to the new directory.
 */
import { type Dir, type Dirent, lstatSync, opendirSync } from 'node:fs'
import path from 'node:path'

import { readRootIdentity, type RootIdentity, sameRoot, type StatFn } from '../drive-root-identity'

/** Entries examined and wall time spent by one {@link DriveLinkScanner.step} call. */
export const STEP_ENTRIES = 4000
export const STEP_MS = 40
/** Linked files listed one by one; the next ones are denied as the folder that holds them. */
export const MAX_DENIED = 256
export const MAX_FOLDERS = 64
export const RESCAN_AFTER_MS = 10 * 60_000

interface Found {
  /** Multiply linked files, by literal path (up to the file cap). */
  files: Set<string>
  /** Folders denied as a whole subtree because a link was found in them past the file cap. */
  folders: Set<string>
}

interface RootScan {
  root: string
  /** The directory this walk began in; the walk is dropped when the root stops being it. */
  identity: RootIdentity
  /** Directories not yet opened (depth first). */
  pending: string[]
  /** The directory being read and its handle, kept open between steps. */
  open: { directory: string; handle: Dir } | null
  /** What the last COMPLETE walk found, plus what the walk in progress has found so far on a first pass. */
  found: Found
  /** What the walk in progress has found; becomes `found` when it finishes (a link removed since stops being denied). */
  next: Found
  finishedAt: number | null
}

export interface DriveLinkScannerOptions {
  now?(): number
  stepEntries?: number
  stepMs?: number
  maxDenied?: number
  maxFolders?: number
  rescanAfterMs?: number
  /** Test seam: how a root is looked at to tell it from a replacement (default: `lstatSync`). */
  stat?: StatFn
}

const emptyFound = (): Found => ({ files: new Set(), folders: new Set() })

const within = (candidate: string, folder: string) => candidate === folder || candidate.startsWith(folder + path.sep)

export class DriveLinkScanner {
  private readonly scans = new Map<string, RootScan>()
  /** Directory entries read in all steps so far (what the step budget bounds). */
  examined = 0

  constructor(private readonly options: DriveLinkScannerOptions = {}) {}

  /** Advance the walk of each root by one bounded step; return every path to deny so far (linked files, then folders). */
  step(roots: readonly string[]): string[] {
    const now = this.options.now ?? Date.now
    const denied: string[] = []

    // A root that is no longer writable (signed out, switched) is no longer walked, and its handle is closed.
    for (const known of [...this.scans.keys()]) {
      if (!roots.includes(known)) {
        this.forget(known)
      }
    }

    for (const root of roots) {
      // Gone, unreadable, not a directory or a link: nothing to walk.
      const identity = readRootIdentity(root, this.options.stat)

      if (!identity) {
        this.forget(root)

        continue
      }

      let scan = this.scans.get(root)

      if (!scan || !sameRoot(scan.identity, identity)) {
        this.forget(root)
        const first = emptyFound()
        scan = { root, identity, pending: [root], open: null, found: first, next: first, finishedAt: null }
        this.scans.set(root, scan)
      } else if (scan.finishedAt !== null && now() - scan.finishedAt >= (this.options.rescanAfterMs ?? RESCAN_AFTER_MS)) {
        scan.pending = [root]
        scan.next = emptyFound()
        scan.finishedAt = null
      }

      if (scan.pending.length || scan.open) {
        this.advance(scan, now)
      }

      denied.push(...scan.found.files, ...scan.found.folders)
    }

    return [...new Set(denied)]
  }

  /** Close every open directory (a scanner is dropped, or its Drive signed out). */
  dispose(): void {
    for (const root of [...this.scans.keys()]) {
      this.forget(root)
    }
  }

  private forget(root: string): void {
    const scan = this.scans.get(root)

    if (scan) {
      this.closeOpen(scan)
      this.scans.delete(root)
    }
  }

  private closeOpen(scan: RootScan): void {
    const open = scan.open

    scan.open = null

    try {
      open?.handle.closeSync()
    } catch {
      // Already closed.
    }
  }

  private advance(scan: RootScan, now: () => number): void {
    const stop = now() + (this.options.stepMs ?? STEP_MS)
    let budget = this.options.stepEntries ?? STEP_ENTRIES

    // The budget and the clock are checked for EVERY entry, so a directory with a million entries
    // is read a slice at a time and its handle stays open for the next step.
    while (budget > 0 && now() < stop) {
      if (!scan.open) {
        const directory = scan.pending.pop()

        if (directory === undefined) {
          break
        }

        // A folder already denied as a whole is not walked.
        if ([...scan.next.folders].some(folder => within(directory, folder))) {
          continue
        }

        try {
          scan.open = { directory, handle: opendirSync(directory) }
        } catch {
          continue
        }
      }

      let entry: Dirent | null

      try {
        entry = scan.open.handle.readSync()
      } catch {
        // An unreadable directory is skipped.
        entry = null
      }

      if (!entry) {
        this.closeOpen(scan)

        continue
      }

      budget -= 1
      this.examined += 1
      const directory = scan.open.directory
      const child = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        scan.pending.push(child)
      } else if (entry.isFile()) {
        try {
          if (lstatSync(child).nlink > 1) {
            this.record(scan, child, directory)
          }
        } catch {
          // Gone while walking.
        }
      }
    }

    if (!scan.pending.length && !scan.open) {
      scan.found = scan.next
      scan.finishedAt = now()
    }
  }

  /** A multiply linked file: listed itself, or - past the cap - its folder is denied as a whole. */
  private record(scan: RootScan, file: string, directory: string): void {
    const next = scan.next

    if ([...next.folders].some(folder => within(file, folder))) {
      return
    }

    if (next.files.size < (this.options.maxDenied ?? MAX_DENIED)) {
      next.files.add(file)

      return
    }

    this.denyFolder(scan, directory)
  }

  private denyFolder(scan: RootScan, folder: string): void {
    const next = scan.next
    next.folders.add(folder)
    const maxFolders = this.options.maxFolders ?? MAX_FOLDERS

    // Past the folder cap, fold folders into their parents until they fit; at the limit that is the root.
    while (next.folders.size > maxFolders && [...next.folders].some(candidate => candidate !== scan.root)) {
      const parents = [...next.folders].map(candidate => (candidate === scan.root ? candidate : path.dirname(candidate)))
      next.folders.clear()

      for (const parent of parents) {
        next.folders.add(parent)
      }
    }

    // A folder covers what is under it: drop the narrower entries (this frees the file cap) and stop reading inside it.
    for (const covered of [...next.folders]) {
      if ([...next.folders].some(other => other !== covered && within(covered, other))) {
        next.folders.delete(covered)
      }
    }

    for (const file of [...next.files]) {
      if ([...next.folders].some(covering => within(file, covering))) {
        next.files.delete(file)
      }
    }

    if (scan.open && [...next.folders].some(covering => within(scan.open!.directory, covering))) {
      this.closeOpen(scan)
    }
  }
}
