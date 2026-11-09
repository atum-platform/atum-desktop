import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountWorkspacePath, forgetLostWorkspace, prepareAccountWorkspace, restoreMovedWorkspace } from './workspace-home'

const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/u
const ACCOUNT_ROOT_VERSION = 1

export interface AccountScopedPaths {
  accountKey: string
  root: string
  hermesStateRoot: string
  hermesProfile: string
  workspaceRoot: string
  messagingDatabase: string
  authStorage: string
  cacheRoot: string
  browserNamespace: string
  capabilityAuditLog: string
  documentThemes: string
}

export interface CommittedAccountRoot {
  version: 1
  accountKey: string
  generation: number
  committedAt: string
}

export interface RecoveredCommittedAccountRoot {
  committed: { marker: CommittedAccountRoot; paths: AccountScopedPaths } | null
  recoveredInvalidMarker: boolean
}

export interface AccountRootAtRestPosture {
  accountDirectories: '0700'
  credentialAndMarkerFiles: '0600'
  authCredentials: 'electron-safeStorage-encrypted'
  messagingProjection: 'plaintext-sqlite-private-account-root'
  legacyGlobalData: 'preserved-unclaimed'
}

export interface LegacyAccountDataDisposition {
  authStorage: string
  messagingDatabase: string
  disposition: 'preserved-unclaimed'
}

export const ACCOUNT_ROOT_AT_REST_POSTURE: AccountRootAtRestPosture = {
  accountDirectories: '0700',
  credentialAndMarkerFiles: '0600',
  authCredentials: 'electron-safeStorage-encrypted',
  messagingProjection: 'plaintext-sqlite-private-account-root',
  legacyGlobalData: 'preserved-unclaimed'
}

export function accountKeyFor(accountId: string): string {
  if (!accountId || accountId.length > 512) {
    throw new Error('invalid_account_id')
  }

  return createHash('sha256').update('atum-account-root-v1\0', 'utf8').update(accountId, 'utf8').digest('hex')
}

/**
 * Main-process authority for physical account roots. Remote account ids never
 * appear in path components; a stable one-way digest selects the private root.
 * The global marker contains only that digest and is replaced atomically after
 * every participating account resource has opened successfully.
 */
export class AccountRootAuthority {
  private readonly accountsRoot: string
  private readonly markerPath: string

  constructor(private readonly userDataPath: string, private readonly workspaceHome?: string) {
    this.accountsRoot = join(userDataPath, 'accounts')
    this.markerPath = join(userDataPath, 'atum-account-context', 'active.json')
  }

  pathsForAccount(accountId: string): AccountScopedPaths {
    return this.pathsForKey(accountKeyFor(accountId))
  }

  prepare(accountId: string): AccountScopedPaths {
    const paths = this.pathsForAccount(accountId)

    for (const directory of [
      this.accountsRoot,
      paths.root,
      dirname(paths.messagingDatabase),
      dirname(paths.authStorage)
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }

    return paths
  }

  /** Activate the user-facing folder only once execution has quiesced. */
  prepareWorkspace(accountId: string): AccountScopedPaths {
    const paths = this.prepare(accountId)

    if (this.workspaceHome) {prepareAccountWorkspace(paths.root, this.workspaceHome)}

    return this.pathsForAccount(accountId)
  }

  restoreWorkspace(accountId: string, selected: string): void {
    if (!this.workspaceHome) {throw new Error('workspace_home_unavailable')}
    restoreMovedWorkspace(this.pathsForAccount(accountId).root, this.workspaceHome, selected)
  }

  forgetWorkspace(accountId: string): void {
    if (!this.workspaceHome) {throw new Error('workspace_home_unavailable')}
    forgetLostWorkspace(this.pathsForAccount(accountId).root, this.workspaceHome)
  }

  committed(): { marker: CommittedAccountRoot; paths: AccountScopedPaths } | null {
    let raw: string

    try {
      raw = readFileSync(this.markerPath, 'utf8')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

      if (code === 'ENOENT') {
        return null
      }
      throw new Error('account_context_read_failed')
    }

    let parsed: Partial<CommittedAccountRoot>

    try {
      parsed = JSON.parse(raw) as Partial<CommittedAccountRoot>
    } catch {
      throw new Error('account_context_corrupt')
    }

    if (
      parsed.version !== ACCOUNT_ROOT_VERSION ||
      typeof parsed.accountKey !== 'string' ||
      !ACCOUNT_KEY_PATTERN.test(parsed.accountKey) ||
      !Number.isSafeInteger(parsed.generation) ||
      Number(parsed.generation) < 1 ||
      typeof parsed.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.committedAt))
    ) {
      throw new Error('account_context_corrupt')
    }

    const marker = parsed as CommittedAccountRoot

    return { marker, paths: this.pathsForKey(marker.accountKey) }
  }

  /** Boot-only recovery: invalid marker state is authority, never app configuration. */
  recoverCommitted(): RecoveredCommittedAccountRoot {
    try {
      return { committed: this.committed(), recoveredInvalidMarker: false }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'account_context_corrupt') {
        throw error
      }
      this.clearCommit()

      return { committed: null, recoveredInvalidMarker: true }
    }
  }

  assertCommittedAccount(accountId: string): void {
    const committed = this.committed()

    if (!committed || committed.marker.accountKey !== accountKeyFor(accountId)) {
      throw new Error('account_context_mismatch')
    }
  }

  commit(accountId: string, generation: number): CommittedAccountRoot {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('invalid_account_generation')
    }
    const paths = this.prepare(accountId)
    const marker: CommittedAccountRoot = {
      version: ACCOUNT_ROOT_VERSION,
      accountKey: paths.accountKey,
      generation,
      committedAt: new Date().toISOString()
    }

    this.writeMarker(marker)

    return marker
  }

  rollbackIfCurrent(accountKey: string, previous: CommittedAccountRoot | null): void {
    const current = this.committed()

    if (!current || current.marker.accountKey !== accountKey) {
      return
    }

    if (previous) {
      this.writeMarker(previous)
    } else {
      this.clearCommit()
    }
  }

  private writeMarker(marker: CommittedAccountRoot): void {
    mkdirSync(dirname(this.markerPath), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.markerPath), 0o700)
    const temporary = `${this.markerPath}.tmp`
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.markerPath)
    chmodSync(this.markerPath, 0o600)
  }

  clearCommit(): void {
    try {
      unlinkSync(this.markerPath)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

      if (code !== 'ENOENT') {
        throw new Error('account_context_clear_failed')
      }
    }
  }

  legacyDisposition(): LegacyAccountDataDisposition {
    return {
      authStorage: join(this.userDataPath, 'atum-auth', 'official-session.json'),
      messagingDatabase: join(this.userDataPath, 'atum-messaging', 'messaging.sqlite3'),
      disposition: 'preserved-unclaimed'
    }
  }

  private pathsForKey(accountKey: string): AccountScopedPaths {
    if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
      throw new Error('invalid_account_key')
    }
    const root = join(this.accountsRoot, accountKey)

    return {
      accountKey,
      root,
      hermesStateRoot: join(root, 'hermes'),
      hermesProfile: `atum-${accountKey.slice(0, 16)}`,
      workspaceRoot: this.workspaceHome ? accountWorkspacePath(root, this.workspaceHome) : join(root, 'workspace'),
      messagingDatabase: join(root, 'messaging', 'messaging.sqlite3'),
      authStorage: join(root, 'auth', 'official-session.json'),
      cacheRoot: join(root, 'cache'),
      browserNamespace: `persist:atum-account-${accountKey}`,
      capabilityAuditLog: join(root, 'audit', 'capabilities.jsonl'),
      documentThemes: join(root, 'office', 'document-themes.json')
    }
  }
}
