/**
 * app-view/partitions.ts
 *
 * Per-account app partitions and their complete discovery on disk.
 *
 * An app view's persisted browser state lives in
 * `persist:atum-app-<accountKey>-<app>`, where `accountKey` is the local
 * one-way digest the account-root authority already uses for the account's
 * private directory (`userData/accounts/<accountKey>`). The Atum account id
 * never appears in a partition name, and the name is deterministic, so no
 * registry has to survive for cleanup to be complete: every partition that
 * can exist is derived from the account roots on disk and the app catalog,
 * and every partition that does exist is found by scanning Chromium's
 * `Partitions` directory. The legacy single-namespace `persist:atum-app-<app>`
 * is swept once and never created again.
 *
 * Nothing here touches Electron. Enumeration takes an injected directory
 * reader so the sweep is testable and never follows symlinks.
 */

export const APP_VIEW_PARTITION_PREFIX = 'persist:atum-app-'
/** Chromium stores `persist:<name>` under `userData/Partitions/<name>`. */
const PARTITION_DIRECTORY_PREFIX = 'atum-app-'

const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/
const APP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
/** `atum-app-<64 hex>-<app>` (current) or `atum-app-<app>` (legacy). */
const CURRENT_NAME_PATTERN = /^atum-app-([0-9a-f]{64})-([a-z][a-z0-9_-]{0,63})$/
const LEGACY_NAME_PATTERN = /^atum-app-([a-z][a-z0-9_-]{0,63})$/

export function isAccountKey(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_KEY_PATTERN.test(value)
}

export function isAppId(value: unknown): value is string {
  return typeof value === 'string' && APP_ID_PATTERN.test(value)
}

/** The partition one account's view of one app persists into. */
export function appViewPartition(accountKey: string, app: string): string {
  if (!isAccountKey(accountKey)) {throw new Error('invalid_account_key')}

  if (!isAppId(app)) {throw new Error('invalid_app_id')}

  return `${APP_VIEW_PARTITION_PREFIX}${accountKey}-${app}`
}

/** The pre-slice-3 shared partition, swept at startup and never minted again. */
export function legacyAppPartition(app: string): string {
  if (!isAppId(app)) {throw new Error('invalid_app_id')}

  return `${APP_VIEW_PARTITION_PREFIX}${app}`
}

export interface ParsedAppViewPartition {
  partition: string
  accountKey: string | null
  app: string
}

/** Parse either grammar; anything else is not ours and is never touched. */
export function parseAppViewPartition(partition: unknown): ParsedAppViewPartition | null {
  if (typeof partition !== 'string' || !partition.startsWith(APP_VIEW_PARTITION_PREFIX)) {return null}
  const name = partition.slice('persist:'.length)
  const current = CURRENT_NAME_PATTERN.exec(name)

  if (current) {return { partition, accountKey: current[1], app: current[2] }}
  const legacy = LEGACY_NAME_PATTERN.exec(name)

  return legacy ? { partition, accountKey: null, app: legacy[1] } : null
}

export interface DirectoryEntry {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface PartitionDiscoveryDeps {
  /** `app.getPath('userData')`. */
  userDataPath: string
  /** Durable catalog authority, the same list the consumer browser uses. */
  knownAppIds: readonly string[]
  /**
   * Directory reader that reports symlinks as such. Must throw for an
   * unreadable directory and return `null` for a missing one (`ENOENT`).
   */
  readDirectory: (path: string) => Promise<DirectoryEntry[] | null>
  /** Partitions the running controller knows about, whether or not on disk yet. */
  livePartitions?: Iterable<string>
}

/**
 * Every app partition that may hold state on this machine:
 *
 * 1. `accounts/<accountKey>` × the app catalog — the partitions the current
 *    naming can produce for any account that ever had a root here;
 * 2. `Partitions/atum-app-*` — whatever Chromium actually persisted, including
 *    partitions of apps no longer in the catalog and the legacy namespace;
 * 3. the legacy namespace for every catalogued app, whether or not on disk;
 * 4. the controller's live partitions.
 *
 * Directory names are translated to partition names; a filesystem path is
 * never handed to `session.fromPartition`. An unreadable `accounts` or
 * `Partitions` directory is a failure (cleanup cannot be proven complete); a
 * missing one is the empty set.
 */
export async function discoverAppViewPartitions(deps: PartitionDiscoveryDeps): Promise<string[]> {
  const found = new Set<string>()
  const apps = deps.knownAppIds.filter(isAppId)

  for (const app of apps) {found.add(legacyAppPartition(app))}

  const accountEntries = await deps.readDirectory(`${deps.userDataPath}/accounts`)

  for (const entry of accountEntries ?? []) {
    if (!entry.isDirectory || entry.isSymbolicLink || !isAccountKey(entry.name)) {continue}

    for (const app of apps) {found.add(appViewPartition(entry.name, app))}
  }

  const partitionEntries = await deps.readDirectory(`${deps.userDataPath}/Partitions`)

  for (const entry of partitionEntries ?? []) {
    if (!entry.isDirectory || entry.isSymbolicLink || !entry.name.startsWith(PARTITION_DIRECTORY_PREFIX)) {continue}
    const parsed = parseAppViewPartition(`persist:${entry.name}`)

    if (parsed) {found.add(parsed.partition)}
  }

  for (const partition of deps.livePartitions ?? []) {
    if (parseAppViewPartition(partition)) {found.add(partition)}
  }

  return [...found].sort()
}

/** Run `work` over `items` with at most `limit` in flight; the first failure rejects after the rest settle. */
export async function forEachBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  let failure: unknown = null
  let failed = false

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()

      if (item === undefined) {return}

      try {
        await work(item)
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))

  if (failed) {throw failure}
}
