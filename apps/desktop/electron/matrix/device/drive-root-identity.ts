/**
 * Which directory a Drive root is (review round 3, 2026-10-24).
 *
 * Two places ask whether the folder at a Drive root's path is still the folder they looked at: the
 * check that a root may be WRITTEN (`DriveWorkspaceCopies.writableDriveRoots`) and the hard-link
 * walk (`guard/drive-links.ts`). Device and inode alone cannot answer it: Linux filesystems (ext4,
 * overlay) hand a freed inode number to the next directory made, so a root removed and recreated at
 * the same path looks unchanged. An identity is therefore also the directory's creation time
 * (`birthtimeMs`: APFS, HFS+ and ext4 keep one), and where the filesystem keeps none, the binding
 * marker's own identity (its inode and creation, else modification, time): a recreated root with a
 * recreated marker is a different file even when the numbers repeat.
 *
 * Every doubt is a difference, and callers fail closed on a difference. No creation time and no
 * marker on either side means "cannot tell", which is not "same".
 *
 * It relies on Node reporting the real creation time where the filesystem has one (statx on Linux,
 * APFS and HFS+ on macOS). Where Node can only fall back to the change time (statx blocked by a
 * container's seccomp profile), a root looks different after ANY change inside it: the root is not
 * writable and a link walk restarts until the next vouching. That is the safe direction, not a hole.
 *
 * What it cannot see: a root removed and recreated, with its marker, inside one tick of the
 * filesystem's timestamp clock (a few milliseconds on Linux; nanoseconds on APFS) AND given the same
 * inode number back. That is a deliberate swap by a program running as the owner outside the
 * sandbox (the sandbox pins the root and cannot remove it) timed to the millisecond; the engine's
 * next vouching (`refresh()`) re-reads the identity in any case.
 */
import { lstatSync } from 'node:fs'
import path from 'node:path'

/** The engine's binding marker at a Drive root: what makes the folder this account's Drive. */
export const DRIVE_BINDING_MARKER = '.atum-drive-binding.json'

/** The part of `fs.Stats` an identity reads. A test passes its own `stat` to play a filesystem that reuses inode numbers. */
export interface StatFacts {
  readonly dev: number
  readonly ino: number
  readonly birthtimeMs: number
  readonly mtimeMs: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** How a path is looked at without following a link (default: `lstatSync`). Throws when it cannot be. */
export type StatFn = (file: string) => StatFacts

export interface RootIdentity {
  readonly dev: number
  readonly ino: number
  /** When the directory was created; 0 when the filesystem keeps no creation time. */
  readonly birthtimeMs: number
  /** The binding marker, as a regular file: its inode and creation (else modification) time. Null when it is missing or is not one. */
  readonly marker: { readonly ino: number; readonly stampMs: number } | null
}

const lstat: StatFn = file => lstatSync(file)

/** A creation time counts only when the filesystem recorded one (Node reports 0, the epoch, when it did not). */
const created = (facts: StatFacts) => (Number.isFinite(facts.birthtimeMs) && facts.birthtimeMs > 0 ? facts.birthtimeMs : 0)

/** The identity of the directory at `root`, or null when there is none there: gone, unreadable, not a directory, or a link. */
export function readRootIdentity(root: string, stat: StatFn = lstat): RootIdentity | null {
  let facts: StatFacts

  try {
    facts = stat(root)
  } catch {
    return null
  }

  if (facts.isSymbolicLink() || !facts.isDirectory()) {
    return null
  }

  let marker: RootIdentity['marker'] = null

  try {
    const found = stat(path.join(root, DRIVE_BINDING_MARKER))

    if (found.isFile()) {
      marker = { ino: found.ino, stampMs: created(found) || found.mtimeMs }
    }
  } catch {
    // No marker: the root is not vouched for by it, and has nothing to tell it apart by.
  }

  return { dev: facts.dev, ino: facts.ino, birthtimeMs: created(facts), marker }
}

/** True only when `now` is certainly the directory `known` described. */
export function sameRoot(known: RootIdentity, now: RootIdentity): boolean {
  if (known.dev !== now.dev || known.ino !== now.ino || known.birthtimeMs !== now.birthtimeMs) {
    return false
  }

  if (known.birthtimeMs > 0) {
    return true
  }

  // The filesystem keeps no creation time, so a reused inode number says nothing: the marker is the witness.
  return known.marker !== null && now.marker !== null && known.marker.ino === now.marker.ino && known.marker.stampMs === now.marker.stampMs
}
