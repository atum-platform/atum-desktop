import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, type Stats, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

interface WorkspaceLocation {
  version: 1
  name: string
  identity: string
}

const locationFile = (accountRoot: string) => join(accountRoot, 'workspace-location.json')
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`

function statIfPresent(path: string): Stats | null {
  try {return lstatSync(path)} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
    throw error
  }
}

function readLocation(accountRoot: string): WorkspaceLocation | null {
  let raw: string

  try {raw = readFileSync(locationFile(accountRoot), 'utf8')} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
    throw error
  }

  let value: Partial<WorkspaceLocation> | null

  try {value = JSON.parse(raw) as Partial<WorkspaceLocation>} catch {throw new Error('workspace_location_invalid')}

  if (!value || value.version !== 1 || typeof value.name !== 'string' || !/^Atum(?: \([2-9][0-9]*\)| \(1[0-9]+\))?$/u.test(value.name) ||
    typeof value.identity !== 'string' || !/^[0-9]+:[0-9]+$/u.test(value.identity)) {
    throw new Error('workspace_location_invalid')
  }

  return value as WorkspaceLocation
}

/** Read-only resolution: private account state stores the chosen visible name. */
export function accountWorkspacePath(accountRoot: string, home: string): string {
  try {
    const location = readLocation(accountRoot)

    return location ? join(home, location.name) : join(accountRoot, 'workspace')
  } catch {
    // Workspace metadata must not make auth/database/cache paths unreadable.
    // Preparation validates or repairs it before granting any workspace access.
    return join(accountRoot, 'workspace')
  }
}

function saveLocation(accountRoot: string, location: WorkspaceLocation): void {
  const temporary = `${locationFile(accountRoot)}.tmp`
  writeFileSync(temporary, JSON.stringify(location), { mode: 0o600 })
  renameSync(temporary, locationFile(accountRoot))
}

/** Explicit native recovery choice. Removes only metadata for an absent folder. */
export function forgetLostWorkspace(accountRoot: string, home: string): void {
  let location: WorkspaceLocation | null = null

  try {location = readLocation(accountRoot)} catch { /* Invalid metadata cannot identify a destination. */ }

  if (location && statIfPresent(join(home, location.name))) {throw new Error('workspace_still_present')}
  const legacy = join(accountRoot, 'workspace')
  const alias = statIfPresent(legacy)

  if (alias) {
    if (!alias.isSymbolicLink()) {throw new Error('workspace_still_present')}

    try {
      statSync(legacy)
      throw new Error('workspace_still_present')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error}
    }

    unlinkSync(legacy)
  }

  rmSync(locationFile(accountRoot), { force: true })
}

/** A native picker may restore the original directory, never an unrelated one. */
export function restoreMovedWorkspace(accountRoot: string, home: string, selected: string): void {
  const location = readLocation(accountRoot)
  const source = statIfPresent(selected)

  if (!location || !source?.isDirectory() || source.isSymbolicLink() || identity(source) !== location.identity) {
    throw new Error('workspace_restore_wrong_folder')
  }

  const destination = join(home, location.name)

  if (resolve(selected) === resolve(destination)) {return}

  if (statIfPresent(destination)) {throw new Error('workspace_restore_destination_occupied')}
  renameSync(selected, destination)
}

/**
 * Called only after the account's backends have stopped. Rename preserves the
 * entire directory (including checkpoints); the old path remains an alias for
 * saved chat references. The private intent and inode make an interrupted move
 * resumable without guessing whether an existing destination belongs to us.
 */
export function prepareAccountWorkspace(accountRoot: string, home: string): void {
  const legacy = join(accountRoot, 'workspace')
  mkdirSync(home, { recursive: true })
  let location: WorkspaceLocation | null = null
  let damagedLocation = false

  try {location = readLocation(accountRoot)} catch {damagedLocation = true}

  if (damagedLocation || (!location && statIfPresent(legacy)?.isSymbolicLink())) {
    // A completed move's private alias is an independent ownership record.
    // Repair damaged location metadata only from that existing directory.
    const alias = statIfPresent(legacy)
    const target = alias?.isSymbolicLink() ? resolve(accountRoot, readlinkSync(legacy)) : null
    const name = target ? basename(target) : null
    const owned = target ? statIfPresent(target) : null

    if (target && name && /^Atum(?: \([2-9][0-9]*\)| \(1[0-9]+\))?$/u.test(name) &&
      target === join(resolve(home), name) && owned?.isDirectory() && !owned.isSymbolicLink()) {
      location = { version: 1, name, identity: identity(owned) }
      saveLocation(accountRoot, location)
    } else {throw new Error('workspace_location_invalid')}
  }

  if (!location) {
    const source = statIfPresent(legacy)

    if (source && (!source.isDirectory() || source.isSymbolicLink())) {throw new Error('workspace_source_invalid')}

    if (!source) {mkdirSync(legacy, { mode: 0o700 })}
    let name = 'Atum'
    let suffix = 2

    while (statIfPresent(join(home, name))) {name = `Atum (${suffix++})`}
    location = { version: 1, name, identity: identity(lstatSync(legacy)) }
    saveLocation(accountRoot, location)
  }

  const destination = join(home, location.name)
  let target = statIfPresent(destination)

  if (!target) {
    const source = statIfPresent(legacy)

    if (!source?.isDirectory() || source.isSymbolicLink() || identity(source) !== location.identity) {
      throw new Error('workspace_source_missing')
    }

    // No copy/delete fallback: EXDEV or any other failure preserves the source.
    renameSync(legacy, destination)
    target = lstatSync(destination)
  }

  if (!target.isDirectory() || target.isSymbolicLink() || identity(target) !== location.identity) {
    throw new Error('workspace_destination_changed')
  }

  const old = statIfPresent(legacy)

  if (old) {
    if (!old.isSymbolicLink() || realpathSync(legacy) !== realpathSync(destination)) {
      throw new Error('workspace_legacy_path_changed')
    }
  } else {
    // Windows junctions need no Developer Mode/admin symlink privilege.
    symlinkSync(resolve(destination), legacy, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
