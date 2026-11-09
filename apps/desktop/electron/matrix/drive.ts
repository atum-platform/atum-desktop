import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync
} from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type {
  MatrixDriveIssue,
  MatrixDrivePreview,
  MatrixDriveProblem,
  MatrixDriveProgress,
  MatrixDriveQuota,
  MatrixDriveState,
  MatrixDriveView
} from '../../shared/matrix-drive'
import { consumerFileImageMime, consumerFileOpenKind } from '../atum-consumer-files'
import type { EncryptedStore } from '../encrypted-store'

import { MATRIX_DRIVE_CHAIN_WAIT_MS } from './drive-chain'
import { type MatrixDriveEngine, spawnMatrixDriveEngine } from './drive-engine'
import {
  MATRIX_DRIVE_FACT_FEATURES,
  type MatrixDriveEngineFeature,
  matrixDriveFrameFeatures,
  MatrixDriveFrameReader,
  type MatrixDriveSync,
  validateMatrixDriveFrame
} from './drive-engine-frames'
import {
  matrixDriveChosenRoot,
  type MatrixDriveFolderChoice,
  matrixDriveFolderIssue,
  matrixDriveFolderProblem,
  matrixDrivePrepareFolder,
  matrixDriveResolveDirectory,
  matrixDriveRootEnrolled,
  openMatrixDriveMarker
} from './drive-folder'

/**
 * `manual` is the person's "Turn on"; `launch` is the launch reconnect of a Drive the person turned
 * on, which never opens the browser by itself; `choose` is their "Choose another folder…", the only
 * way to the folder picker; `automatic` is Atum setting Drive up by itself (`autoConnect`); `retry`
 * is an automatic retry while Drive is being set up; `chained` is the same automatic path while its
 * authorize URL can continue an existing account browser trip.
 */
type ConnectMode = 'manual' | 'launch' | 'choose' | 'automatic' | 'retry' | 'chained'

/** The person turned Drive on: now (Turn on, Choose another folder…) or before (the launch
 * reconnect carries their earlier Turn on). */
function turnedOn(mode: ConnectMode): boolean {
  return mode === 'manual' || mode === 'launch' || mode === 'choose'
}

interface ChainedAuthorization {
  key: string
  revision: number
  resolve(url: string | undefined): void
  settled: boolean
  timedOut: boolean
  timer: ReturnType<typeof setTimeout>
}

/**
 * How long an automatic connect waits for its browser sign-in before it stops, says so and leaves
 * the next try to the next launch. Since 2026-10-07 MAS skips its Continue page for Drive (one of
 * Atum's own apps), so a browser that still has the Atum sign-in comes straight back; this only
 * runs out when the person has to sign in there and doesn't.
 */
export const MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS = 10 * 60_000

/** Where a folder lives, for the person to read: `~/…` inside the home folder, only the folder's
 * name elsewhere. Never an absolute path (no user name, no volume layout) in the window. */
export function matrixDriveFolderLocation(root: string, home: string = homedir()): string {
  const relative = path.relative(home, root)

  return !relative || relative.startsWith('..') || path.isAbsolute(relative)
    ? path.basename(root)
    : '~/' + relative.split(path.sep).join('/')
}

/**
 * How far one connect got with the engine, for the failure it explains: `hello` before the
 * engine answered, `start` after it got the folder and before it reached the network,
 * `authorizing` while it looks up Drive and sign-in, `authorize` once the browser was opened,
 * `connected` once it reported an account state.
 */
type ConnectStage = 'hello' | 'start' | 'authorizing' | 'authorize' | 'connected'

/**
 * How long Drive's server holds a person's first request while it creates their Drive (the
 * ingress's `provisionWaitMs`, 45 s) before it answers "still being set up". A first connect
 * that stops sooner than this after sign-in was not that wait: the server turned the account
 * away (not open for it yet).
 */
export const MATRIX_DRIVE_SETUP_HOLD_MS = 45_000

/**
 * Where a first connect's stop is classed as "being set up" rather than "not open": earlier than
 * the hold, because the server gives up when its next 2 s poll would pass the 45 s (its 503 comes
 * about 43.75–44.5 s after the request reached it), and a retry's sign-in can come straight back
 * with no click. Every refusal is immediate, so 40 s leaves room on both sides.
 */
export const MATRIX_DRIVE_SETUP_CLASSIFY_MS = 40_000

/** Past this after the sign-in page opened, a stop is a sign-in that was never finished. */
const signInWindowMs = MATRIX_DRIVE_SETUP_HOLD_MS + 180_000

/** How long an automatic setup waits before asking again whether Drive is open to every account
 * (now a reachability probe; a transient failure must not leave Drive off for an hour). */
export const MATRIX_DRIVE_OPEN_RECHECK_MS = 60_000

/** Automatic retries while Drive is being set up; the server asks for 10 s and sets up within ~10 s. */
export const MATRIX_DRIVE_SETUP_RETRY_MS = [15_000, 30_000, 60_000] as const

/**
 * How long the engine must hold `ready` or `syncing` after a renewal before the budget is
 * restored. The engine reports its state every 2 s, and a refused token still yields `offline`
 * (not signed out, no sync): counting that as success would rotate the person's grant forever.
 */
export const MATRIX_DRIVE_RENEWAL_SETTLED_MS = 5_000

/**
 * Why a first connect (nothing enrolled yet) stopped once it reached the network, from what the
 * desktop can know without the engine's credential: whether Drive's server answers at all, and
 * how long after sign-in (or after start, when no sign-in page opened) the stop came. The
 * server's refusals are fast (403 `not_allowed`, `not_provisioned`, `suspended`); its only slow
 * answer is the 503 `provisioning` after the 45 s hold.
 */
export function matrixDriveFirstConnectProblem(
  stage: 'authorizing' | 'authorize' | 'connected',
  reachable: boolean,
  elapsedMs: number
): MatrixDriveProblem {
  if (!reachable) {
    return 'network'
  }

  if (elapsedMs >= MATRIX_DRIVE_SETUP_CLASSIFY_MS && (stage !== 'authorize' || elapsedMs <= signInWindowMs)) {
    return 'setting_up'
  }

  if (stage === 'authorizing') {
    // Before sign-in only anonymous lookups run; Drive answering doesn't make them reachable.
    return 'network'
  }

  return stage === 'authorize' && elapsedMs > signInWindowMs ? 'sign_in' : 'not_allowed'
}

/**
 * Whether Drive's server answers at all: one anonymous `GET /status.php` (the one route Drive
 * serves without a sign-in), no credential, no redirect. Tells a real network problem from a
 * server that is up and refused this account.
 */
export async function matrixDriveReachable(origin: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(new URL('/status.php', origin), {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000)
    })

    await response.body?.cancel().catch(() => {})

    return response.ok
  } catch {
    return false
  }
}

/**
 * Whether Drive is open to every account: the server's anonymous `GET /atum/open`
 * (`{"open": true}` only while its allowlist is everyone), no credential, no redirect. Anything
 * else (owner-only, an older server without the route, no answer) is "not open": the first run
 * then waits instead of sending the person to a sign-in that would end in "not open".
 */
export async function matrixDriveOpen(origin: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(new URL('/atum/open', origin), {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000)
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})

      return false
    }

    const answer = (await response.json()) as { open?: unknown }

    return answer?.open === true
  } catch {
    return false
  }
}

/**
 * Why Drive no longer turns itself on for an account on this Mac (`drive-auto:<owner>`): the
 * person turned it off here (`off`, an earlier build's Cancel/Turn off), Drive refused the account
 * (`refused`), or `~/Atum/Drive` holds files that aren't Drive's (`folder`). A retry clears it.
 */
type AutomaticStop = 'off' | 'refused' | 'folder'

const automaticStopped = new Set<string>(['off', 'refused', 'folder'] satisfies AutomaticStop[])

/** `off` is an earlier build's control, not a stop: Drive is automatic, with no button to undo it. */
function setupStopped(value: string | null): boolean {
  return value !== 'off' && automaticStopped.has(value ?? '')
}

/** The most one {@link MatrixDrive.manifestFor} call spends asking the engine. */
const MANIFEST_BUDGET_MS = 60_000

interface Owner {
  issuer: string
  subject: string
  generation: number
}
interface Binding {
  root: string
  dev: number
  ino: number
}
interface Row {
  path: string
  kind: 'file' | 'folder'
  dev: number
  ino: number
}
interface PreviewLease {
  row: Row
  kind: MatrixDrivePreview['kind']
}
type MetadataMode = 'read' | 'replace' | 'create'
interface MetadataResult {
  resource: {
    storage: string
    space: string
    opaque: string
  }
  etag?: string
  size?: number
}
interface PendingMetadata {
  resolve: (result: MetadataResult) => void
  reject: () => void
  timer: ReturnType<typeof setTimeout>
  revision: number
  process: ChildProcessWithoutNullStreams
  /** The view row's ID, or null for a root-relative path from {@link MatrixDrive.manifestFor}. */
  id: string | null
  mode: MetadataMode
  row: Row
  root: Binding
  personalSpace: string
}

const maxTaskFileBytes = 5 * 1024 * 1024
const maxPreviewImageBytes = 16 * 1024 * 1024
const maxPreviewTextBytes = 512 * 1024

/** `root()` refusing a saved root whose approved identity or owner marker no longer holds. */
function isRootChanged(error: unknown): boolean {
  return error instanceof Error && error.message === 'matrix_drive_root_changed'
}

function printable(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every(character => character.charCodeAt(0) >= 0x21 && character.charCodeAt(0) <= 0x7e)
  )
}

const states = new Set<MatrixDriveState>([
  'disconnected',
  'authorizing',
  'connecting',
  'syncing',
  'ready',
  'offline',
  'paused',
  'reauthenticate',
  'error',
  'cleanup_failed'
])

/** One owner's native sync process and local directory. No renderer-selected paths. */
export class MatrixDrive {
  private owner: Owner | null = null
  private key = ''
  private revision = 0
  private recoveryDue = false
  private recoveryAt = 0

  private state: MatrixDriveState = 'disconnected'
  private offlineSince?: number
  private offlineTimer?: ReturnType<typeof setTimeout>
  private problem?: MatrixDriveProblem
  private binding?: Binding
  private folder = ''
  private rows = new Map<string, Row>()
  private previews = new Map<string, PreviewLease>()
  private process?: ChildProcessWithoutNullStreams
  private taskFiles = false
  private metadataPending = new Map<string, PendingMetadata>()
  private view: MatrixDriveView = { state: 'disconnected', revision: 0, rows: [], canGoBack: false, truncated: false }
  private busy = false
  private listing = 0
  private cleanup: Promise<boolean> = Promise.resolve(true)
  private disconnecting?: Promise<MatrixDriveView>
  /** Whether the disconnect now running began while the saved folder was waiting as changed. */
  private disconnectBeganChanged = false
  /** Automatic retries spent while Drive is being set up; reset by a manual connect or success. */
  private setupRetries = 0
  private setupTimer?: ReturnType<typeof setTimeout>
  /** Bumped to drop a first-connect check that no longer applies. */
  private diagnosis = 0
  /** The account whose automatic connect was already decided in this launch (main asks on every
   * snapshot). */
  private autoDecided = ''
  /** The same-tab Drive hop. After its short deadline, this same automatic connect falls back to
   * opening the browser normally; it stays here until it connects, fails or is cancelled. */
  private chained?: ChainedAuthorization
  /** Set the moment the app quits: a quit is not a sign-out, so nothing after it withdraws Drive. */
  private disposed = false
  /** While Drive isn't open to every account: the account asked for, and when to ask again. */
  private autoWaiting = { key: '', until: 0 }
  /** A reachability probe that failed: ask again shortly, even if no snapshot wakes us. */
  private autoRetryTimer?: ReturnType<typeof setTimeout>
  /** The engine's sign-in page while it waits for the browser: main-only, for "Open again". */
  private signInUrl?: string
  /** This engine's app-credential token (`start.credential`), when the app handed one over:
   * no browser sign-in runs, and a new token is pushed when the engine asks. */
  private credential?: { accessToken: string; expiresAt?: number }
  /** Automatic default-folder rebinds since Drive last worked: one per working period, so a root
   * that keeps changing cannot silently re-adopt itself in a loop. */
  private rootRebinds = 0
  /** The engine's sign-in page is ready but was never opened: a connect nobody pressed anything
   * for (the launch reconnect, or Drive set up here before turning itself back on) found that the
   * saved sign-in can't be reused. The browser opens only on the person's Sign in. */
  private signInHeld = false
  /** This connect, and the "being set up" retries that continue it, started with nobody pressing
   * anything for a Drive this Mac already had (the launch reconnect, or an automatic connect into
   * a folder set up here before). A retry's sign-in page waits for the person just the same. */
  private unattended = false
  /** Engine SyncResult time when negotiated; interim main time for legacy engines. */
  private lastSyncAt?: number
  private acceptedFeatures: MatrixDriveEngineFeature[] = []
  private facts: {
    progress?: MatrixDriveProgress
    sync?: MatrixDriveSync
    quota?: MatrixDriveQuota
    exclusions?: string[]
  } = {}
  private displayedProgress?: MatrixDriveProgress
  private progressTimer?: ReturnType<typeof setTimeout>
  private progressPublishedAt = Number.NEGATIVE_INFINITY
  private issueIds = new Map<MatrixDriveIssue['code'], string>()

  constructor(
    private readonly options: {
      owner(): Owner | null
      engine?: MatrixDriveEngine
      store: Pick<EncryptedStore, 'getItem' | 'setItem'>
      userData: string
      chooseFolder(): Promise<string | undefined>
      /** `~/Atum/Drive`: the folder a first connect uses, made when missing, when it can be Drive. */
      defaultFolder?: string
      /** Whether Drive's server answers at all (anonymous, no credential). Without it a stopped
       * first connect is explained by its stage alone. */
      reachable?(): Promise<boolean>
      /** Whether Drive is open to every account (`matrixDriveOpen`). The first run connects on its
       * own only when it says so; without it (tests) the first run doesn't ask. */
      open?(): Promise<boolean>
      openExternal(url: string): Promise<unknown>
      /** The browser sign-in this connect opened came back: Atum comes to the front, as it does
       * after the Atum sign-in. */
      returned?(): void
      /** The person's own short-lived Atum account token for the engine, main-only
       * (`atum.drive-app-credential/1`). `refused` is the token the engine just had refused:
       * rotate only while it is still the current grant, so two callers cannot rotate twice.
       * `owner` is the identity the engine pinned at `start`, for a renewal: a handed-over
       * token must still resolve to it. Never a refresh token: the app remains its only
       * custodian. */
      credential?(
        refused: string | undefined,
        owner?: { issuer: string; subject: string }
      ): Promise<{ accessToken: string; expiresAt?: number } | null>
      openPath(file: string): Promise<string>
      /** Native PDF views are main-owned and must end with their Drive lease. */
      closeNativePreview?(token: string): void
      changed(view: MatrixDriveView): void
      spawn?: typeof spawnMatrixDriveEngine
      /** One diagnostic line per connect step or failure: closed codes only, never a path,
       * URL, subject or engine output. */
      log?(line: string): void
    }
  ) {}

  private log(line: string): void {
    this.options.log?.(`[Matrix] drive ${line}`)
  }

  private identity(): { issuer: string; subject: string; origin: string } {
    return { issuer: this.owner!.issuer, subject: this.owner!.subject, origin: this.options.engine!.origin }
  }

  /** Why the saved folder can't become a new Drive folder; undefined when it still can. */
  private savedFolderProblem(): MatrixDriveProblem | undefined {
    try {
      return matrixDriveFolderProblem(this.root(false), this.identity())
    } catch {
      return 'folder_unavailable'
    }
  }

  private savedFolderEnrolled(): boolean {
    return Boolean(this.binding && matrixDriveRootEnrolled(this.binding.root, this.identity()))
  }

  /** A valid owner marker at the saved path never overrides the filesystem identity the person
   * approved. A replacement carrying a copied marker waits for explicit re-selection instead. */
  private savedFolderIdentityChanged(): boolean {
    if (!this.binding || !this.owner || !this.options.engine || !this.savedFolderEnrolled()) {
      return false
    }

    try {
      this.root(false)

      return false
    } catch {
      return true
    }
  }

  /** Why the saved root no longer validates: its directory was replaced (`identity`), is gone
   * (`missing`), or its owner marker no longer belongs to this root (`marker`). Undefined while
   * the approved identity and marker still hold. */
  private savedRootChange(): 'identity' | 'missing' | 'marker' | undefined {
    const binding = this.binding
    const owner = this.owner

    if (!binding || !owner || !this.options.engine) {
      return undefined
    }

    let stat: ReturnType<typeof lstatSync>

    try {
      stat = lstatSync(binding.root)
    } catch {
      return 'missing'
    }

    try {
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== binding.dev ||
        stat.ino !== binding.ino ||
        realpathSync(binding.root) !== binding.root
      ) {
        return 'identity'
      }
    } catch {
      return 'missing'
    }

    try {
      this.bindingSpace(binding, owner)
    } catch {
      return 'marker'
    }

    return undefined
  }

  /** True when the saved root's approved filesystem identity no longer holds, or the directory is
   * gone. A marker that is simply missing keeps its own, plainer outcome; a marker that was
   * replaced or now belongs to another root is a changed folder like a moved directory. */
  private savedRootChanged(): boolean {
    const change = this.savedRootChange()

    if (change === 'marker') {
      return !this.onlyMarkerMissing()
    }

    return change === 'identity' || change === 'missing'
  }

  /**
   * The app's own default folder (`~/Atum/Drive`) is the one folder no person chose: when its
   * directory is replaced under a running install (an app update may re-create it), its current
   * device/inode is adopted without asking. Every other root, and any change to the folder's
   * owner marker, keeps the person in charge. At most one automatic rebind per working period:
   * a root that changes again before Drive reaches a working state waits for the person.
   */
  private rebindOwnDefaultFolder(): boolean {
    const binding = this.binding
    const folder = this.options.defaultFolder

    if (
      !binding ||
      !folder ||
      this.rootRebinds > 0 ||
      binding.root !== path.resolve(folder) ||
      this.savedRootChange() !== 'identity'
    ) {
      return false
    }

    const directory = matrixDriveResolveDirectory(folder)

    if (!directory || directory.root !== binding.root) {
      return false
    }

    this.binding = { root: directory.root, dev: directory.dev, ino: directory.ino }
    this.rootRebinds += 1
    this.options.store.setItem('drive-root:' + this.key, JSON.stringify(this.binding))

    return true
  }

  /** A default folder rebound at runtime is reconnected by the same app, with no person involved. */
  private reconnectAfterRebind(): void {
    const revision = this.revision

    queueMicrotask(() => {
      if (!this.current(revision) || this.busy || this.disconnecting || this.state !== 'disconnected' || this.problem) {
        return
      }

      void this.connect('automatic').catch(() => {
        if (this.current(revision)) {
          this.state = 'error'
          this.publish()
        }
      })
    })
  }

  /** Withdraw every capability backed by a changed root, but keep its binding long enough for the
   * person to re-select or forget it. The app's own default folder is rebound instead. Neither
   * path ever changes files in that folder. Returns whether the folder was rebound. */
  private waitForFolderRecovery(source: 'launch' | 'connect' | 'runtime'): boolean {
    const change = this.savedRootChange()
    const rebound = change === 'identity' && this.rebindOwnDefaultFolder()
    const first = !rebound && this.problem !== 'folder_changed'
    this.clearLocalBrowseState()
    this.clearFacts()
    const child = this.process
    this.cancelMetadata(child)
    this.process = undefined
    this.taskFiles = false
    this.state = 'disconnected'

    if (rebound) {
      this.problem = undefined
      this.log(`saved default folder rebound automatically source=${source} reason=${change}`)
    } else {
      this.problem = 'folder_changed'

      if (first) {
        this.log(`saved folder changed source=${source}; waiting for the person reason=${change ?? 'unknown'}`)
      }
    }

    child?.kill('SIGTERM')

    if (rebound && source === 'runtime') {
      this.reconnectAfterRebind()
    }

    return rebound
  }

  /**
   * A folder Drive can't use is never kept: the next Connect asks for another one. Only a folder
   * that was never enrolled gets here, so nothing synced is at stake; any account the engine kept
   * for it is deleted before another folder is bound (the same cleanup Disconnect runs). A picker
   * choice that is refused leaves whatever folder was saved before as it was.
   */
  private refuseFolder(
    problem: MatrixDriveProblem,
    source: 'picker' | 'default' | 'saved' | 'engine'
  ): MatrixDriveView {
    if (source !== 'picker') {
      this.forgetSavedFolder()
    }

    this.folder = ''
    this.problem = problem
    this.state = 'disconnected'
    this.log(`folder refused problem=${problem} source=${source}`)

    return this.publish()
  }

  /**
   * Stops using the saved folder (its files stay where they are): nothing reconnects into it, and
   * an account the engine kept for it is deleted before another folder is bound.
   */
  private forgetSavedFolder(): void {
    if (!this.binding) {
      return
    }

    this.clearLocalBrowseState()
    this.binding = undefined
    this.clearFacts()
    this.options.store.setItem('drive-root:' + this.key, '')
    this.options.store.setItem('drive-enabled:' + this.key, '')

    const configDir = path.join(this.options.userData, 'drive-engine', this.key)

    try {
      if (existsSync(configDir) && readdirSync(configDir).length > 0) {
        this.options.store.setItem('drive-cleanup:' + this.key, 'pending')
      }
    } catch {
      this.options.store.setItem('drive-cleanup:' + this.key, 'pending')
    }
  }

  /** Called synchronously when the canonical account changes or signs out. */
  activate(active = true): void {
    // At quit main's owner() is already null, but quitting is not signing out: Drive keeps its
    // sign-in and reconnects at the next launch. Nothing after dispose() withdraws or cleans up.
    if (this.disposed) {
      return
    }

    const next = active ? this.options.owner() : null

    const key = next
      ? createHash('sha256')
          .update(JSON.stringify([next.issuer, next.subject]))
          .digest('hex')
      : ''

    if (key === this.key && next?.generation === this.owner?.generation) {
      return
    }

    if (key && key === this.key && next && this.owner) {
      // The same person, a new generation of their Atum sign-in (a sign-in step cancelled, the
      // Atum account connected again): not an account change. Drive's engine holds its own
      // sign-in, so nothing is withdrawn and nothing is cleaned up.
      this.owner = next

      return
    }

    if (this.chained) {
      this.settleChained(this.chained)
    }

    this.revision++
    this.autoDecided = ''
    this.rootRebinds = 0
    this.cancelMetadata()
    this.stopSetupRetry()
    this.setupRetries = 0
    const previousOwner = this.owner
    const previousKey = this.key
    const child = this.process
    this.process = undefined
    this.taskFiles = false

    // Withdraw renderer authority immediately; cleanup remains bound to the old owner.
    if (previousOwner && previousKey) {
      const stopped = child
        ? new Promise<void>(resolve => {
            child.once('close', () => resolve())

            const timer = setTimeout(() => {
              child.kill('SIGKILL')
              resolve()
            }, 12_000).unref()

            child.once('close', () => clearTimeout(timer))
            child.kill('SIGTERM')
          })
        : Promise.resolve()

      // An explicit disconnect already owns the old credential deletion. It
      // must finish before reconnect; account withdrawal only stops its child.
      const needsCleanup =
        child ||
        this.options.store.getItem('drive-enabled:' + previousKey) ||
        this.options.store.getItem('drive-cleanup:' + previousKey)

      if (!this.disconnecting && needsCleanup) {
        this.options.store.setItem('drive-enabled:' + previousKey, '')
        this.options.store.setItem('drive-cleanup:' + previousKey, 'pending')
        this.cleanup = this.cleanup
          .then(async () => {
            await stopped
            const clean = await this.forgetStored(previousOwner, previousKey)

            if (clean) {
              this.options.store.setItem('drive-cleanup:' + previousKey, '')
            }

            return clean
          })
          .catch(() => false)
      } else {
        this.cleanup = this.cleanup.then(async clean => {
          await stopped

          return clean
        })
      }
    }

    this.owner = next
    this.key = key
    this.clearLocalBrowseState()
    this.binding = undefined
    this.problem = undefined
    this.signInUrl = undefined
    this.signInHeld = false
    this.clearFacts()
    this.lastSyncAt = undefined
    this.state = this.options.engine && next ? 'disconnected' : 'unavailable'

    if (key) {
      try {
        const raw = this.options.store.getItem('drive-root:' + key)

        if (raw) {
          const binding = JSON.parse(raw) as Binding

          if (
            typeof binding.root !== 'string' ||
            !path.isAbsolute(binding.root) ||
            !Number.isSafeInteger(binding.dev) ||
            !Number.isSafeInteger(binding.ino)
          ) {
            throw new Error()
          }

          this.binding = binding
        }
      } catch {
        this.state = 'error'
      }

      // A first run that ended (a quit, a crash) before Drive set the folder up leaves nothing
      // bound: nothing reconnects into it, and an empty ~/Atum/Drive is not left behind.
      if (this.binding && this.options.store.getItem('drive-enabled:' + key) !== 'yes') {
        this.releaseUnusedDefault()
      }

      if (this.binding && this.savedFolderIdentityChanged()) {
        this.waitForFolderRecovery('launch')
      }

      if (this.options.engine) {
        this.restoreAutomaticStop()
      }
    }

    this.publish()
    const revision = this.revision

    if (
      this.binding &&
      this.options.engine &&
      this.state !== 'error' &&
      !this.problem &&
      this.options.store.getItem('drive-enabled:' + key) === 'yes'
    ) {
      queueMicrotask(() => {
        if (!this.current(revision) || this.busy || this.disconnecting || this.state !== 'disconnected') {
          return
        }

        // connect() logs why it stopped; the panel offers Try again.
        void this.connect('launch').catch(() => {
          if (this.current(revision)) {
            this.state = 'error'
            this.publish()
          }
        })
      })
    }
  }

  /**
   * Drive turns itself on, with no Turn on to press: once the account is ready, and again at every
   * launch until Drive reports an account (from then on the launch reconnect in `activate` keeps
   * it on). It runs when this Mac already has this account's Drive folder (set up here before:
   * nothing to ask), or when Drive's server says it is open to every account. Into the saved folder
   * or `~/Atum/Drive`; the engine opens its one browser sign-in when it has none, which comes
   * straight back while the browser still holds the Atum sign-in. Never after the person turned
   * Drive off here (Cancel, Turn off Drive), after Drive refused the account, or over a
   * `~/Atum/Drive` that already holds someone else's files: those wait for the person's Turn on.
   * At most once per launch.
   */
  autoConnect(): void {
    this.activate()
    const key = this.key

    if (
      !key ||
      this.disposed ||
      this.autoDecided === key ||
      !this.owner ||
      !this.options.engine ||
      !this.options.defaultFolder ||
      this.busy ||
      this.disconnecting ||
      this.state !== 'disconnected' ||
      this.problem
    ) {
      return
    }

    // Earlier builds' `drive-auto: yes` (a first run tried once) no longer stops anything;
    // `drive-enabled` means the launch reconnect already has it.
    if (
      setupStopped(this.options.store.getItem('drive-auto:' + key)) ||
      this.options.store.getItem('drive-enabled:' + key) === 'yes'
    ) {
      this.autoDecided = key

      return
    }

    const revision = this.revision

    const start = (why: string) => {
      this.autoDecided = key
      if (this.autoRetryTimer) {
        clearTimeout(this.autoRetryTimer)
        this.autoRetryTimer = undefined
      }
      this.log(`connect started automatically: ${why}`)

      void this.connect('automatic').catch(() => {
        if (this.current(revision)) {
          this.state = 'error'
          this.publish()
        }
      })
    }

    if (this.enrolledHere()) {
      start('set up here before')

      return
    }

    if (this.autoWaiting.key === key && Date.now() < this.autoWaiting.until) {
      return
    }

    // One question in flight per account; asked again shortly while the probe keeps failing.
    this.autoWaiting = { key, until: Date.now() + MATRIX_DRIVE_OPEN_RECHECK_MS }
    const open = this.options.open ? this.options.open().catch(() => false) : Promise.resolve(true)

    void open.then(isOpen => {
      if (!isOpen) {
        // A transient probe failure must not leave automatic Drive off until the next snapshot:
        // ask again shortly unless setup was decided or withdrawn meanwhile.
        this.log("first connect waits: Drive's server has not answered yet")

        if (!this.disposed && this.autoDecided !== key) {
          this.autoRetryTimer = setTimeout(() => {
            this.autoRetryTimer = undefined
            this.autoConnect()
          }, MATRIX_DRIVE_OPEN_RECHECK_MS)
          this.autoRetryTimer.unref?.()
        }

        return
      }

      if (
        !this.current(revision) ||
        this.disposed ||
        this.autoDecided === key ||
        this.busy ||
        this.disconnecting ||
        this.state !== 'disconnected' ||
        this.problem ||
        setupStopped(this.options.store.getItem('drive-auto:' + key)) ||
        this.options.store.getItem('drive-enabled:' + key) === 'yes'
      ) {
        return
      }

      start('Drive is open')
    })
  }

  /**
   * Prepare Drive's authorization as the next URL in the account's existing browser tab. The
   * normal automatic-connect path does all folder and engine work; this method only captures its
   * first safe authorize frame. If the three-second continuation window closes, the same connect
   * carries on and opens the browser normally when it is ready.
   */
  async prepareChainedAuthorization(): Promise<string | undefined> {
    this.activate()
    const key = this.key

    if (
      !key ||
      this.disposed ||
      this.autoDecided === key ||
      !this.owner ||
      !this.options.engine ||
      !this.options.defaultFolder ||
      !this.options.open ||
      this.busy ||
      this.disconnecting ||
      this.state !== 'disconnected' ||
      this.problem ||
      automaticStopped.has(this.options.store.getItem('drive-auto:' + key) ?? '') ||
      this.options.store.getItem('drive-enabled:' + key) === 'yes'
    ) {
      return undefined
    }

    const revision = this.revision
    const deadline = Date.now() + MATRIX_DRIVE_CHAIN_WAIT_MS
    let openTimer: ReturnType<typeof setTimeout> | undefined

    const open = await Promise.race([
      this.options.open().catch(() => false),
      new Promise<false>(resolve => (openTimer = setTimeout(() => resolve(false), MATRIX_DRIVE_CHAIN_WAIT_MS)))
    ])

    clearTimeout(openTimer)

    if (
      !open ||
      !this.current(revision) ||
      this.disposed ||
      this.autoDecided === key ||
      this.busy ||
      this.disconnecting ||
      this.state !== 'disconnected' ||
      this.problem ||
      automaticStopped.has(this.options.store.getItem('drive-auto:' + key) ?? '') ||
      this.options.store.getItem('drive-enabled:' + key) === 'yes'
    ) {
      return undefined
    }

    this.autoDecided = key
    this.log('connect started in the sign-in trip')

    return new Promise<string | undefined>(resolve => {
      const attempt: ChainedAuthorization = {
        key,
        revision,
        resolve,
        settled: false,
        timedOut: false,
        timer: setTimeout(
          () => {
            if (this.chained !== attempt || attempt.settled) {
              return
            }

            attempt.timedOut = true
            this.settleChained(attempt, undefined, true)
            this.log('sign-in trip timed out; continuing automatically')
          },
          Math.max(0, deadline - Date.now())
        )
      }

      attempt.timer.unref?.()
      this.chained = attempt

      void this.connect('chained').catch(() => {
        this.settleChained(attempt)

        if (this.current(revision)) {
          this.state = 'error'
          this.endFirstConnect()
          this.publish()
        }
      })
    })
  }

  /** Cancel only the Drive hop owned by the current account browser trip. */
  cancelChainedAuthorization(): void {
    const attempt = this.chained

    if (!attempt) {
      return
    }

    this.settleChained(attempt)
    this.autoDecided = attempt.key

    void this.disconnect()
      .then(view => {
        if (view.state === 'disconnected' && !this.disconnecting) {
          this.endFirstConnect()
          this.publish()
        }
      })
      .catch(() => {})
  }

  private settleChained(attempt: ChainedAuthorization, url?: string, keep = false): void {
    if (!attempt.settled) {
      attempt.settled = true
      clearTimeout(attempt.timer)
      attempt.resolve(url)
    }

    if (!keep && this.chained === attempt) {
      this.chained = undefined
    }
  }

  /**
   * Whether Drive was set up on this Mac for this account before: the saved folder, or
   * `~/Atum/Drive` when none is saved, carries the engine's binding for this owner and Drive. Only
   * says whether to try; the connect checks the folder again before it binds or starts anything.
   */
  private enrolledHere(): boolean {
    if (this.binding) {
      return this.savedFolderEnrolled()
    }

    const folder = this.options.defaultFolder

    try {
      return Boolean(
        folder &&
        path.isAbsolute(folder) &&
        !lstatSync(folder).isSymbolicLink() &&
        matrixDriveRootEnrolled(realpathSync(folder), this.identity())
      )
    } catch {
      return false
    }
  }

  /** Nothing turns Drive on by itself again here until the person's own Turn on. The reason that
   * stopped it is kept beside it: it is what the status row says after a relaunch. */
  private stopAutomatic(reason: AutomaticStop): void {
    if (!this.key) {
      return
    }

    this.options.store.setItem('drive-auto:' + this.key, reason)

    if (reason !== 'off' && this.problem && (this.problem === 'not_allowed' || matrixDriveFolderIssue(this.problem))) {
      this.options.store.setItem('drive-stop:' + this.key, this.problem)
    } else {
      this.options.store.setItem('drive-stop:' + this.key, '')
    }
  }

  private clearAutomaticStop(): void {
    if (!this.key) {
      return
    }

    this.options.store.setItem('drive-auto:' + this.key, '')
    this.options.store.setItem('drive-stop:' + this.key, '')
  }

  /**
   * A stop that outlived the process (`drive-auto` is `refused` or `folder`) is shown again as
   * its status row with Try again. `problem` is only in memory, so without this a relaunch over a
   * persisted stop sits on "Getting ready" for good: `autoConnect` returns early on the stop and
   * nothing ever sets a problem again. The stop stands even when the folder that caused it has
   * become usable: a folder conflict is retried by the person's Try again, not by the next launch.
   */
  private restoreAutomaticStop(): void {
    if (!this.key || !this.options.engine || this.state !== 'disconnected' || this.problem) {
      return
    }

    if (this.options.store.getItem('drive-enabled:' + this.key) === 'yes') {
      return
    }

    const stop = this.options.store.getItem('drive-auto:' + this.key)

    if (stop !== 'refused' && stop !== 'folder') {
      return
    }

    const stored = this.options.store.getItem('drive-stop:' + this.key)

    if (stored === 'not_allowed' || (stored && matrixDriveFolderIssue(stored as MatrixDriveProblem))) {
      this.problem = stored as MatrixDriveProblem
      this.log(`automatic stop restored ${stop} problem=${stored}`)

      return
    }

    if (stop === 'refused') {
      // The only stop stored as `refused` is a first connect Drive turned away (`not_allowed`).
      this.problem = 'not_allowed'
      this.log('automatic stop restored refused problem=not_allowed')

      return
    }

    // An older folder stop has no stored reason. Its folder is still the one the person should
    // look at, so say that; choosing another (or Try again) clears the stop as before.
    this.problem = 'folder_refused'
    this.log('automatic stop restored folder problem=folder_refused')
  }

  /**
   * A first connect that ended before Drive set the folder up, with nothing that will reconnect
   * into it (an automatic run, or a refusal), frees the default folder: removed while still empty
   * (rmdir refuses anything else), and unbound. The next Connect makes it again.
   */
  private releaseUnusedDefault(): void {
    const binding = this.binding
    const folder = this.options.defaultFolder

    if (!binding || !folder || !path.isAbsolute(folder) || !this.owner || !this.key || !this.options.engine) {
      return
    }

    try {
      if (this.savedFolderEnrolled()) {
        return
      }

      const stat = lstatSync(folder)

      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        realpathSync(folder) !== binding.root ||
        stat.dev !== binding.dev ||
        stat.ino !== binding.ino
      ) {
        return
      }

      rmdirSync(folder)
    } catch {
      return
    }

    this.binding = undefined
    this.clearFacts()
    this.options.store.setItem('drive-root:' + this.key, '')
    this.log('default folder released')
  }

  private stopSetupRetry(): void {
    this.diagnosis++

    if (this.setupTimer) {
      clearTimeout(this.setupTimer)
      this.setupTimer = undefined
    }
  }

  private current(revision: number): boolean {
    const next = this.options.owner()

    // The same person, whatever generation their Atum sign-in is on (activate adopts a new one):
    // the engine's frames keep counting in between. A sign-out or another person is a change.
    return (
      revision === this.revision &&
      Boolean(next && this.owner && next.issuer === this.owner.issuer && next.subject === this.owner.subject)
    )
  }

  private clearFacts(): void {
    clearTimeout(this.offlineTimer)
    this.offlineTimer = undefined
    this.offlineSince = undefined

    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
    }

    this.progressTimer = undefined

    if (this.acceptedFeatures.includes('sync')) {
      this.lastSyncAt = undefined
    }

    this.acceptedFeatures = []
    this.facts = {}
    this.displayedProgress = undefined
    this.progressPublishedAt = Number.NEGATIVE_INFINITY
    this.issueIds.clear()
  }

  /** Presentation changes keep the directory's existing capability handles intact. */
  private publishFacts(): void {
    const view = { ...this.view }

    for (const key of ['progress', 'quota', 'issues', 'factsStale', 'lastSyncAt'] as const) {
      delete view[key]
    }

    if (this.lastSyncAt) {
      view.lastSyncAt = this.lastSyncAt
    }

    if (this.acceptedFeatures.length) {
      if (this.displayedProgress) {
        view.progress = structuredClone(this.displayedProgress)
      }

      if (this.facts.quota) {
        view.quota = { ...this.facts.quota }
      }

      const issues: MatrixDriveIssue[] = []

      const add = (code: MatrixDriveIssue['code'], count?: number) => {
        if (!this.issueIds.has(code)) {
          this.issueIds.set(code, randomUUID())
        }

        issues.push({ id: this.issueIds.get(code)!, code, ...(count ? { count } : {}) })
      }

      if (this.facts.quota?.state === 'exceeded') {
        add('drive_full')
      }

      if (this.facts.sync?.conflicts) {
        add('conflicts', this.facts.sync.conflicts)
      }

      if (this.facts.sync?.errors) {
        add('errors', this.facts.sync.errors)
      }

      if (this.facts.sync?.excluded) {
        add('excluded', this.facts.sync.excluded)
      }

      if (this.state === 'reauthenticate') {
        add('signed_out')
      }

      view.issues = issues

      if (!this.process || !['ready', 'syncing'].includes(this.state)) {
        view.factsStale = true
      }
    }

    this.view = view
    this.options.changed(view)
  }

  private receiveFact(child: ChildProcessWithoutNullStreams, revision: number, message: Record<string, unknown>): void {
    validateMatrixDriveFrame(message, {
      phase: 'started',
      offered: this.acceptedFeatures,
      accepted: this.acceptedFeatures,
      issuer: this.owner!.issuer,
      origin: this.options.engine!.origin,
      previousProgress: this.facts.progress,
      lastSyncAt: this.facts.sync?.lastSyncAt
    })
    this.root()

    if (message.kind === 'progress') {
      const { active, files, bytes, etaSeconds, direction } = message as unknown as MatrixDriveProgress
      this.facts.progress = { active, files: { ...files }, bytes: { ...bytes }, etaSeconds, direction }

      const flush = () => {
        this.progressTimer = undefined

        if (!this.current(revision) || this.process !== child) {
          return
        }

        try {
          this.root()
        } catch (error) {
          if (isRootChanged(error)) {
            // The folder being synced is no longer the one the person approved: the same recovery
            // as every other path, whether or not its files were ever listed.
            this.waitForFolderRecovery('runtime')
            this.publish()

            return
          }

          this.clearFacts()
          this.cancelMetadata(child)
          this.process = undefined
          this.taskFiles = false
          this.state = 'error'
          child.kill('SIGTERM')
          this.publish()

          return
        }

        this.displayedProgress = this.facts.progress
        this.progressPublishedAt = Date.now()
        this.publishFacts()
      }

      const wait = Math.max(0, 500 - (Date.now() - this.progressPublishedAt))

      if (!wait) {
        flush()
      } else if (!this.progressTimer) {
        this.progressTimer = setTimeout(flush, wait).unref()
      }
    } else if (message.kind === 'sync') {
      const { lastSyncAt, conflicts, errors, excluded } = message as unknown as MatrixDriveSync
      this.facts.sync = { lastSyncAt, conflicts, errors, excluded }
      this.lastSyncAt = lastSyncAt || undefined
      this.publishFacts()
    } else if (message.kind === 'quota') {
      const { total, used, remaining, state } = message as unknown as MatrixDriveQuota
      this.facts.quota = { total, used, remaining, state }
      this.publishFacts()
    } else if (message.kind === 'exclusions') {
      this.facts.exclusions = [...(message.patterns as string[])]
    }
  }

  /** Native import callers receive only current enrolled facts, never stale presentation data. */
  importQuota(): MatrixDriveQuota | undefined {
    return this.importTarget() && this.process && ['ready', 'syncing'].includes(this.state) && this.facts.quota
      ? { ...this.facts.quota }
      : undefined
  }

  importExclusions(): readonly string[] | undefined {
    return this.importTarget() && this.process && ['ready', 'syncing'].includes(this.state) && this.facts.exclusions
      ? [...this.facts.exclusions]
      : undefined
  }

  private publish(): MatrixDriveView {
    const localRoot = this.localBrowseRoot()

    const signIn =
      Boolean(this.signInUrl && this.process) && ['authorizing', 'connecting', 'reauthenticate'].includes(this.state)

    this.view = {
      ...this.view,
      // Raw engine state still gates imports and stale facts during the grace period.
      state: this.state === 'offline' && this.offlineSince !== undefined &&
        Date.now() - this.offlineSince < 10_000 ? 'connecting' : this.state,
      revision: this.revision,
      problem: this.problem,
      rootLabel: this.binding ? path.basename(this.binding.root) : undefined,
      rootLocation: this.binding ? matrixDriveFolderLocation(this.binding.root) : undefined,
      folderLabel: this.folder ? path.basename(this.folder) : undefined,
      canGoBack: Boolean(this.folder),
      // The engine state is presentation-only here. A verified enrolled root remains a usable
      // local cache while its sync process reconnects, asks to sign in, or reports an error.
      canBrowseLocally: Boolean(localRoot),
      listingStatus: localRoot ? (this.view.listingStatus ?? 'loading') : undefined,
      listedAt: localRoot ? this.view.listedAt : undefined,
      rows: localRoot ? this.view.rows : [],
      truncated: localRoot ? this.view.truncated : false,
      waitingForBrowser: signIn && !this.signInHeld ? true : undefined,
      signInNeeded: signIn && this.signInHeld ? true : undefined,
      lastSyncAt: this.lastSyncAt
    }

    for (const key of [
      'problem',
      'rootLabel',
      'rootLocation',
      'listingStatus',
      'listedAt',
      'waitingForBrowser',
      'signInNeeded',
      'lastSyncAt'
    ] as const) {
      if (this.view[key] === undefined) {
        delete this.view[key]
      }
    }

    this.publishFacts()

    return this.view
  }

  private bindingSpace(binding: Binding, owner: Owner): string {
    // A marker that is not a regular file (a FIFO, a link, a directory), or that cannot be
    // opened at all (a missing marker), is a boundary that no longer holds; it is never opened
    // loosely, so it cannot block this process.
    let handle: number | null

    try {
      handle = openMatrixDriveMarker(binding.root)
    } catch {
      throw new Error('matrix_drive_root_changed')
    }

    if (handle === null) {
      throw new Error('matrix_drive_root_changed')
    }

    let marker: Record<string, unknown>

    try {
      const stat = fstatSync(handle)

      if (!stat.isFile() || stat.size > 16_384) {
        throw new Error('matrix_drive_root_changed')
      }

      const bytes = Buffer.alloc(16_385)
      const length = readSync(handle, bytes, 0, bytes.length, 0)

      if (length > 16_384) {
        throw new Error('matrix_drive_root_changed')
      }

      marker = JSON.parse(bytes.subarray(0, length).toString('utf8')) as Record<string, unknown>
    } finally {
      closeSync(handle)
    }

    if (
      marker.version !== 1 ||
      marker.canonicalRoot !== binding.root ||
      marker.issuer !== owner.issuer ||
      marker.subject !== owner.subject ||
      marker.origin !== this.options.engine?.origin ||
      marker.journal !== '.atum-drive-journal.db' ||
      typeof marker.space !== 'string' ||
      !marker.space.includes('$')
    ) {
      throw new Error('matrix_drive_root_changed')
    }

    return marker.space
  }

  private root(enrolled = true): string {
    const binding = this.binding
    const owner = this.owner

    if (!binding || !owner || !this.current(this.revision)) {
      throw new Error('matrix_drive_unavailable')
    }

    const stat = lstatSync(binding.root)

    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== binding.dev ||
      stat.ino !== binding.ino ||
      realpathSync(binding.root) !== binding.root
    ) {
      throw new Error('matrix_drive_root_changed')
    }

    if (enrolled) {
      this.bindingSpace(binding, owner)
    }

    return binding.root
  }

  /**
   * Local browsing has a distinct authority from the sync child. The marker, owner and root
   * identity are checked on every native entry point; sync status alone never grants it.
   */
  private localBrowseRoot(): string | undefined {
    if (
      !this.binding ||
      !this.owner ||
      !['authorizing', 'connecting', 'syncing', 'ready', 'offline', 'paused', 'reauthenticate', 'error'].includes(
        this.state
      )
    ) {
      return undefined
    }

    try {
      return this.root()
    } catch {
      // A binding that was never enrolled is expected while first connecting. Once it has backed
      // a displayed list, however, a broken marker/root is a capability withdrawal, not a stale
      // listing failure.
      if (this.view.canBrowseLocally || this.rows.size) {
        this.invalidateLocalRoot()
      } else {
        // Nothing was ever listed from this root, but a folder the person had stepped into must
        // not outlive the root that held it: no stale label or Back button in the next view.
        this.folder = ''
      }

      return undefined
    }
  }

  /** Withdraw local handles when their owner/root boundary no longer validates. */
  private clearLocalBrowseState(): void {
    this.listing++
    this.folder = ''
    this.rows.clear()
    this.closePreviews()
    this.view = {
      ...this.view,
      canBrowseLocally: false,
      rows: [],
      truncated: false,
      canGoBack: false
    }
    delete this.view.folderLabel
    delete this.view.listingStatus
    delete this.view.listedAt
  }

  /** A replaced/symlinked root or owner-bound marker needs explicit root recovery, not a list retry. */
  private invalidateLocalRoot(): void {
    if (this.onlyMarkerMissing()) {
      // The folder is the one the person chose; only its hidden owner marker is gone. Asking them
      // to "choose that folder again" would nest a new folder inside it, so this stays the plain
      // error it always was. The engine cannot re-enroll a non-empty folder, so the next connect
      // is refused with `folder_not_empty` and releases the saved folder (its files stay): the
      // person then chooses another folder or leaves Drive off. Nothing re-adopts this folder.
      this.clearLocalBrowseState()
      this.clearFacts()
      const child = this.process
      this.cancelMetadata(child)
      this.process = undefined
      this.taskFiles = false
      this.state = 'error'
      child?.kill('SIGTERM')

      return
    }

    this.waitForFolderRecovery('runtime')
  }

  /** The person picked the saved folder itself while only its owner marker is missing. */
  private pickedSavedRootWithoutMarker(selected: string): boolean {
    if (!this.binding || !this.onlyMarkerMissing()) {
      return false
    }

    try {
      return realpathSync(selected) === this.binding.root
    } catch {
      return false
    }
  }

  /** The saved root still has its approved identity and its owner marker simply does not exist. */
  private onlyMarkerMissing(): boolean {
    if (!this.binding) {
      return false
    }

    try {
      this.root(false)
    } catch {
      return false
    }

    try {
      lstatSync(path.join(this.binding.root, '.atum-drive-binding.json'))

      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  /** Recheck the local capability at every native action. A normal withdrawn/off state simply
   * refuses; a previously valid root whose boundary changed is withdrawn by `localBrowseRoot`. */
  private requiredLocalBrowseRoot(): string {
    const wasBrowsable = Boolean(this.view.canBrowseLocally || this.rows.size)
    const root = this.localBrowseRoot()

    if (!root) {
      if (wasBrowsable) {
        this.publish()
      }

      throw new Error('matrix_drive_file_unavailable')
    }

    return root
  }

  private cancelMetadata(process?: ChildProcessWithoutNullStreams): void {
    for (const [requestId, pending] of this.metadataPending) {
      if (process && pending.process !== process) {
        continue
      }

      this.metadataPending.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject()
    }
  }

  private receiveMetadata(process: ChildProcessWithoutNullStreams, message: Record<string, unknown>): boolean {
    const requestId = message.requestId

    if (!this.taskFiles || !printable(requestId, 36)) {
      return false
    }

    const pending = this.metadataPending.get(requestId)

    if (!pending || pending.process !== process) {
      return false
    }

    const unavailable =
      message.state === 'unavailable' &&
      Object.keys(message).length === 3 &&
      Object.keys(message).every(key => ['kind', 'requestId', 'state'].includes(key))

    const ready = message.state === 'ready'

    const expectedKeys =
      pending.mode === 'create'
        ? ['kind', 'requestId', 'state', 'resource']
        : ['kind', 'requestId', 'state', 'resource', 'etag', 'size']

    if (
      !unavailable &&
      (!ready ||
        Object.keys(message).length !== expectedKeys.length ||
        Object.keys(message).some(key => !expectedKeys.includes(key)))
    ) {
      return false
    }

    this.metadataPending.delete(requestId)
    clearTimeout(pending.timer)

    if (unavailable) {
      pending.reject()

      return true
    }

    try {
      if (
        !this.current(pending.revision) ||
        this.process !== process ||
        this.state !== 'ready' ||
        !this.binding ||
        !this.owner
      ) {
        throw new Error()
      }

      const root = this.requiredLocalBrowseRoot()

      if (
        this.binding.root !== pending.root.root ||
        this.binding.dev !== pending.root.dev ||
        this.binding.ino !== pending.root.ino ||
        this.bindingSpace(this.binding, this.owner) !== pending.personalSpace
      ) {
        throw new Error()
      }

      const row = pending.id === null ? this.recheck(pending.row) : this.resolve(pending.id)

      if (
        row.path !== pending.row.path ||
        row.kind !== pending.row.kind ||
        row.dev !== pending.row.dev ||
        row.ino !== pending.row.ino
      ) {
        throw new Error()
      }

      const resource = message.resource

      if (
        !resource ||
        typeof resource !== 'object' ||
        Array.isArray(resource) ||
        Object.keys(resource).length !== 3 ||
        Object.keys(resource).some(key => !['storage', 'space', 'opaque'].includes(key))
      ) {
        throw new Error()
      }

      const values = resource as Record<string, unknown>

      if (
        !printable(values.storage, 255) ||
        !printable(values.space, 255) ||
        !printable(values.opaque, 255) ||
        values.storage + '$' + values.space !== pending.personalSpace ||
        !row.path.startsWith(root + path.sep)
      ) {
        throw new Error()
      }

      if (pending.mode === 'create') {
        if (row.kind !== 'folder') {
          throw new Error()
        }

        pending.resolve({ resource: { storage: values.storage, space: values.space, opaque: values.opaque } })
      } else {
        const size = typeof message.size === 'number' ? message.size : Number.NaN

        if (
          row.kind !== 'file' ||
          !printable(message.etag, 512) ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > maxTaskFileBytes
        ) {
          throw new Error()
        }

        const stat = lstatSync(row.path)

        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) {
          throw new Error()
        }

        pending.resolve({
          resource: { storage: values.storage, space: values.space, opaque: values.opaque },
          etag: message.etag,
          size
        })
      }
    } catch {
      pending.reject()
    }

    return true
  }

  /** Main-only verified import destination; no native path enters the renderer bridge. */
  importTarget(): { root: string; dev: number; ino: number; ownerKey: string } | undefined {
    this.activate()

    if (
      this.disconnecting ||
      !this.binding ||
      !this.owner ||
      !this.key ||
      !['ready', 'syncing'].includes(this.state)
    ) {
      return undefined
    }

    try {
      const root = this.requiredLocalBrowseRoot()

      return { root, dev: this.binding.dev, ino: this.binding.ino, ownerKey: this.key + ':' + this.owner.generation }
    } catch {
      return undefined
    }
  }

  async read(): Promise<MatrixDriveView> {
    this.activate()
    const revision = this.revision
    const listing = ++this.listing

    const wasBrowsable = Boolean(this.view.canBrowseLocally || this.rows.size)
    const root = this.localBrowseRoot()

    if (!root) {
      if (wasBrowsable) {
        this.publish()
      }

      return this.view
    }

    // Keep a warm directory visible while its next local scan is in flight. This is a local
    // freshness marker; it deliberately says nothing about the remote Drive state.
    this.view = { ...this.view, canBrowseLocally: true, listingStatus: 'loading' }
    this.options.changed(this.view)

    try {
      const directory = this.folder ? path.join(root, this.folder) : root

      if ((await realpath(directory)) !== directory || !this.current(revision)) {
        throw new Error('matrix_drive_listing_unavailable')
      }

      const entries = await readdir(directory, { withFileTypes: true })
      const rows: MatrixDriveView['rows'] = []
      const handles = new Map<string, Row>()
      let partial = false

      // A bounded page, with no hidden engine journal, custody, symlink or device rows.
      const visible = entries
        .filter(entry => !entry.name.startsWith('.') && (entry.isFile() || entry.isDirectory()))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

      for (const entry of visible.slice(0, 500)) {
        const file = path.join(directory, entry.name)
        let stat

        try {
          // A child may disappear or become unreadable after `readdir`. It has no bearing on the
          // root's custody or on the sync child, so omit it from this scan only.
          stat = await lstat(file)
        } catch {
          partial = true

          continue
        }

        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          continue
        }

        const existing = [...this.rows].find(
          ([, row]) => row.path === file && row.dev === stat.dev && row.ino === stat.ino
        )

        const id = existing?.[0] ?? randomUUID()
        const kind = stat.isDirectory() ? 'folder' : 'file'
        handles.set(id, { path: file, kind, dev: stat.dev, ino: stat.ino })
        rows.push({ id, name: entry.name, kind, size: stat.size, modifiedAt: stat.mtimeMs })
      }

      if (!this.current(revision) || listing !== this.listing) {
        return this.view
      }

      try {
        this.root()
      } catch {
        this.invalidateLocalRoot()
        this.publish()

        return this.view
      }

      this.rows = handles
      this.view = {
        ...this.view,
        canBrowseLocally: true,
        listingStatus: partial ? 'partial' : 'current',
        listedAt: Date.now(),
        rows,
        truncated: visible.length > 500,
        folderLabel: this.folder ? path.basename(this.folder) : undefined,
        canGoBack: Boolean(this.folder)
      }
      this.options.changed(this.view)
    } catch {
      if (this.current(revision) && listing === this.listing) {
        // A directory scan can fail while the validated root remains intact (for example a
        // disappeared current folder or a transient permissions failure). Retain the last good
        // rows and handles; actions repeat their own filesystem checks.
        try {
          this.root()
          this.view = { ...this.view, canBrowseLocally: true, listingStatus: 'stale' }
          this.options.changed(this.view)
        } catch {
          this.invalidateLocalRoot()
          this.publish()
        }
      }
    }

    return this.view
  }

  /** Retry only a failed transport/credential read of an already enrolled folder. Never
   * reconnect a live engine or override a folder refusal or the owner's Turn off. */
  recoverConnectivity(immediate = false): void {
    if (!this.recoveryDue || this.disposed || this.busy || this.disconnecting ||
      this.state !== 'error' || !this.key || !this.savedFolderEnrolled() ||
      this.options.store.getItem('drive-enabled:' + this.key) !== 'yes' ||
      (!immediate && Date.now() < this.recoveryAt)) {return}
    this.recoveryAt = Date.now() + 15_000
    void this.connect('launch').catch(() => {})
  }

  /** Turn Drive on: `~/Atum/Drive` (made when missing), never a folder picker. */
  async connect(mode: ConnectMode = 'manual'): Promise<MatrixDriveView | { cancelled: true }> {
    this.recoveryDue = false
    if (mode !== 'retry') {
      this.stopSetupRetry()
      // A retry carries on the connect it retries; any other connect says for itself.
      this.unattended = mode === 'launch' || (mode === 'automatic' && this.savedFolderEnrolled())
    }

    if (turnedOn(mode)) {
      this.setupRetries = 0
    }

    try {
      return await this.connectOnce(mode)
    } catch (error) {
      const code = error instanceof Error && /^matrix_drive_[a-z_]+$/.test(error.message) ? error.message : 'unexpected'

      if (code !== 'matrix_drive_cancelled') {
        this.log(`connect failed stage=prepare reason=${code}`)
      }

      throw error
    }
  }

  /** The person's "Choose another folder…": the folder picker, then the same connect. */
  chooseFolder(): Promise<MatrixDriveView | { cancelled: true }> {
    return this.connect('choose')
  }

  /**
   * The engine's sign-in page in the browser: "Open again" while Drive waits for it, or the
   * person's Sign in when a connect at launch held it back (the only way that page opens).
   */
  async reopenSignIn(): Promise<MatrixDriveView> {
    this.activate()
    const url = this.signInUrl
    const child = this.process

    if (!url || !child || !(this.view.waitingForBrowser || this.view.signInNeeded)) {
      throw new Error('matrix_drive_unavailable')
    }

    const held = this.signInHeld
    this.log(held ? 'sign-in opened in the browser by the person' : 'sign-in opened again in the browser')
    await this.options.openExternal(url)

    // From here Drive waits for the browser, as after a Turn on.
    if (held && this.signInHeld && this.process === child && this.signInUrl === url) {
      this.signInHeld = false

      return this.publish()
    }

    return this.view
  }

  /**
   * "Cancel" while Drive waits for the browser: the same as Disconnect (the engine stops and keeps
   * no account), and a `~/Atum/Drive` that Drive never set up goes again while it is still empty.
   */
  async cancelSignIn(): Promise<MatrixDriveView> {
    this.activate()

    if (!this.view.waitingForBrowser) {
      return this.view
    }

    this.log('sign-in cancelled')
    // The person's no: the browser isn't opened again at the next launch.
    this.stopAutomatic('off')
    const view = await this.disconnect()

    if (view.state !== 'disconnected' || this.disconnecting) {
      return view
    }

    this.endFirstConnect()

    return this.publish()
  }

  /**
   * The folder this connect binds when none is saved. Turn on (and the first run) use
   * `~/Atum/Drive`, made empty and private (0700) when missing; when it can't be Drive the person's
   * Turn on says why and the first run just waits. Only "Choose another folder…" opens the picker,
   * where a folder with files gets an "Atum Drive" folder inside it (`matrixDriveChosenRoot`).
   */
  private defaultChoice(): MatrixDriveFolderChoice {
    const folder = this.options.defaultFolder

    if (!folder || !path.isAbsolute(folder)) {
      return { problem: 'folder_unavailable' }
    }

    const prepared = matrixDrivePrepareFolder(folder, this.identity(), { parents: true })

    if ('problem' in prepared) {
      this.log(`default folder skipped problem=${prepared.problem}`)

      return { problem: prepared.problem }
    }

    if (prepared.created) {
      this.log('default folder made')
    }

    return { root: prepared.root }
  }

  private async connectOnce(mode: ConnectMode): Promise<MatrixDriveView | { cancelled: true }> {
    this.activate()

    // Another folder is chosen only while Drive is off: a running engine keeps its own folder.
    if (
      this.disposed ||
      !this.owner ||
      !this.options.engine ||
      this.busy ||
      this.disconnecting ||
      (mode === 'choose' && this.process)
    ) {
      throw new Error('matrix_drive_unavailable')
    }

    if (this.binding && this.savedFolderIdentityChanged()) {
      this.waitForFolderRecovery('connect')
    }

    const recoveringChangedFolder = this.problem === 'folder_changed'

    // A changed inode is never accepted by retrying. The person's only safe continuations are an
    // explicit picker choice (including deliberately choosing the same path again) or Disconnect.
    if (recoveringChangedFolder && mode !== 'choose') {
      return this.publish()
    }

    if (turnedOn(mode)) {
      // The person's own Turn on: Drive may turn itself on here again from now on.
      this.clearAutomaticStop()
    }

    this.busy = true
    const revision = this.revision
    // The identity the engine pins in its start frame; a renewed token must still resolve to it.
    const pinnedOwner = { issuer: this.owner.issuer, subject: this.owner.subject }

    try {
      await this.cleanup

      if (!this.current(revision)) {
        throw new Error('matrix_drive_cancelled')
      }

      let chosen: string | undefined

      if (mode === 'choose') {
        const selected = await this.options.chooseFolder()

        if (!this.current(revision)) {
          throw new Error('matrix_drive_cancelled')
        }

        if (!selected) {
          // Nothing chosen: whatever was there before still stands.
          return { cancelled: true }
        }

        if (!path.isAbsolute(selected)) {
          throw new Error('matrix_drive_folder_invalid')
        }

        // Checked before anything is saved or started: a folder the engine would refuse is never
        // bound, and the page says what to choose instead.
        if (this.pickedSavedRootWithoutMarker(selected) && this.savedFolderProblem() === 'folder_not_empty') {
          // The saved folder itself, holding the files Drive already syncs, with only its hidden
          // owner marker missing. The engine takes only an empty folder, so a nested "Atum Drive"
          // inside it would sync a different, empty folder while these files stayed behind. The
          // choice is refused before anything is created, and the saved folder stays as it was.
          return this.refuseFolder('folder_not_empty', 'picker')
        }

        const choice = matrixDriveChosenRoot(selected, this.identity(), { defaultFolder: this.options.defaultFolder })

        if ('problem' in choice) {
          if (recoveringChangedFolder) {
            // The stale binding still needs the same explicit recovery after a refused choice.
            this.log(`folder refused problem=${choice.problem} source=picker`)

            return this.publish()
          }

          return this.refuseFolder(choice.problem, 'picker')
        }

        chosen = choice.root

        if (this.binding && (this.binding.root !== chosen || recoveringChangedFolder)) {
          // The old binding is released while every file stays where it is. An explicit choice of
          // the same path records its current identity; another choice moves Drive to that root.
          this.forgetSavedFolder()
          this.log(
            recoveringChangedFolder
              ? 'changed saved folder explicitly rebound by the person'
              : 'saved folder replaced by a chosen folder'
          )
        }
      } else if (this.binding && !this.savedFolderEnrolled() && this.savedFolderProblem() === 'folder_unavailable') {
        // The saved folder is gone (deleted, moved, or never made on this Mac): Drive goes back to
        // its own `~/Atum/Drive` instead of asking for a folder.
        this.forgetSavedFolder()
        this.log('saved folder unavailable; using the default folder')
      }

      if (this.options.store.getItem('drive-cleanup:' + this.key)) {
        const cleaned = await this.forgetStored(this.owner!, this.key)

        if (!cleaned || !this.current(revision)) {
          throw new Error('matrix_drive_cleanup_pending')
        }

        this.options.store.setItem('drive-cleanup:' + this.key, '')
      }

      this.problem = undefined

      if (!this.binding) {
        let root = chosen

        if (!root) {
          const choice = this.defaultChoice()

          if ('problem' in choice) {
            if (mode === 'automatic' || mode === 'retry' || mode === 'chained') {
              // Nobody asked: the reason is shown as a status row with Try again, and a folder
              // with someone else's files is never taken over by a later launch either.
              this.problem = choice.problem
              this.stopAutomatic('folder')
              this.log('first connect waits for a folder')
              this.publish()

              return { cancelled: true }
            }

            return this.refuseFolder(choice.problem, 'default')
          }

          root = choice.root
        }

        // The identity bound is the one of the directory that was validated: a path swapped
        // between the checks is refused, never bound with the inode it had before.
        const directory = matrixDriveResolveDirectory(root)

        if (directory?.root !== root) {
          return this.refuseFolder('folder_unavailable', mode === 'choose' ? 'picker' : 'default')
        }

        // A rebind can happen without an account/revision change. Its old opaque handles must
        // never survive into the new root.
        this.clearLocalBrowseState()
        this.binding = { root, dev: directory.dev, ino: directory.ino }
        this.options.store.setItem('drive-root:' + this.key, JSON.stringify(this.binding))
      } else if (!this.savedFolderEnrolled()) {
        // A folder saved by an earlier build, or one that changed since: never enrolled, so a
        // refusal frees it rather than retrying the same folder forever.
        const problem = this.savedFolderProblem()

        if (problem) {
          return this.refuseFolder(problem, 'saved')
        }
      }

      this.root(false)
      await this.stop(false)

      if (!this.current(revision)) {
        throw new Error('matrix_drive_cancelled')
      }

      // The person's own Atum account token: the engine presents it to Drive and never runs its
      // browser sign-in. If the app owns the handoff but cannot produce a token (no account grant,
      // the platform unreachable), fail closed: Drive never falls back to a browser.
      const credential = this.options.credential
        ? await this.options.credential(undefined).catch(() => undefined)
        : undefined

      if (!this.current(revision)) {
        throw new Error('matrix_drive_cancelled')
      }

      if (this.options.credential && !credential) {
        this.recoveryDue = true
        this.problem = 'network'
        this.state = 'error'
        this.log('connect failed stage=prepare reason=matrix_drive_credential_unavailable')
        this.endFirstConnect()
        this.publish()

        return { cancelled: true }
      }

      const configDir = path.join(this.options.userData, 'drive-engine', this.key)
      mkdirSync(configDir, { recursive: true, mode: 0o700 })

      if (lstatSync(configDir).isSymbolicLink() || realpathSync(configDir) !== configDir) {
        throw new Error('matrix_drive_custody_invalid')
      }

      const child = (this.options.spawn ?? spawnMatrixDriveEngine)(this.options.engine)
      this.clearFacts()
      this.process = child
      this.taskFiles = false
      this.signInUrl = undefined
      this.signInHeld = false
      this.credential = credential

      // The person's own Turn on reconnects at every launch from now on. An automatic run (the
      // first run, or a retry of it) waits until Drive reports an account: a consent ignored or
      // closed is never reopened at the next launch.
      if (turnedOn(mode)) {
        this.options.store.setItem('drive-enabled:' + this.key, 'yes')
      }

      this.state = 'connecting'
      this.publish()
      // A saved, enrolled root is the offline source of truth. Populate it immediately instead
      // of waiting for the engine's first network-dependent state frame.
      void this.read()
      const reader = new MatrixDriveFrameReader()
      let hello = false
      let stage: ConnectStage = 'hello'
      const spawned = Date.now()
      // When the engine got the folder and when it opened the sign-in page: how long a first
      // connect ran before it stopped tells Drive's slow "being set up" from a refusal.
      let started = spawned
      let authorized: number | undefined
      // Whether this engine ever reported an account: a later sign-in it asks for is "Sign in
      // again", never the automatic connect's unfinished first sign-in.
      let reached = false
      // A renewal's working-state hold (see `settleRenewals`).
      let settledRenewals: ReturnType<typeof setTimeout> | undefined
      this.log('engine started')

      // The first failure of this process explains it; later echoes find it detached.
      const fail = (reason: string, exit?: string) => {
        if (!this.current(revision) || this.process !== child) {
          return
        }

        if (settledRenewals) {
          clearTimeout(settledRenewals)
          settledRenewals = undefined
        }

        if (this.chained?.revision === revision) {
          this.settleChained(this.chained)
        }

        this.cancelMetadata(child)
        this.taskFiles = false
        this.process = undefined
        child.kill('SIGTERM')
        this.explain(stage, reason, exit, authorized ?? started)
      }

      // The engine asks for a fresh app token at expiry or after Drive refused its token.
      // This process only ever hands over access tokens; the refresh token never leaves it.
      let renewing = false

      // Two attempts without the engine reaching a working account is a refusal (a deployment
      // that does not accept the app's client, a revoke that persists): stop, never loop rotating.
      let renewals = 0

      // A renewal that could not produce a token: one transient failure waits for the engine's
      // next ask, a second consecutive one stops the connect.
      let renewalFailures = 0

      // `ready`/`syncing` only repays the budget after it holds for a few seconds. The engine
      // reports every 2 s and a refused token still gives `offline`, which is not success: a
      // token that resolves offline forever must not reset the cap on every report.
      const settleRenewals = (next: MatrixDriveState) => {
        if (next !== 'ready' && next !== 'syncing') {
          if (settledRenewals) {
            clearTimeout(settledRenewals)
            settledRenewals = undefined
          }

          return
        }

        if (settledRenewals || renewals === 0) {
          return
        }

        settledRenewals = setTimeout(() => {
          settledRenewals = undefined

          if (this.process === child && (this.state === 'ready' || this.state === 'syncing')) {
            renewals = 0
            renewalFailures = 0
            this.log('credential renewal budget restored')
          }
        }, MATRIX_DRIVE_RENEWAL_SETTLED_MS)
        settledRenewals.unref?.()
      }

      const renewCredential = async () => {
        if (!this.options.credential || renewing) {
          return
        }

        if (renewals >= 2) {
          this.log('credential renewal budget spent; stopping')
          fail(renewalFailures > 0 ? 'credential_unavailable' : 'credential_refused')

          return
        }

        renewing = true
        renewals += 1

        try {
          // Only the token the engine just had refused may be rotated: if another caller on this
          // Mac rotated meanwhile, the current grant is the better token and is handed over as is.
          const next = await this.options
            .credential(this.credential?.accessToken, pinnedOwner)
            .catch(() => undefined)

          if (!this.current(revision) || this.process !== child) {
            return
          }

          if (!next) {
            // A renewal can fail transiently (the platform's token endpoint or `/me` did not
            // answer). The engine keeps its working token until expiry and asks again after its
            // cool-down: one failure is not a lost sign-in, and the bounded budget below still
            // stops a grant that is really gone.
            renewalFailures += 1

            if (renewalFailures >= 2) {
              fail('credential_unavailable')
            } else {
              this.log('credential renewal unavailable; waiting for the next request')
            }

            return
          }

          renewalFailures = 0

          if (settledRenewals) {
            clearTimeout(settledRenewals)
            settledRenewals = undefined
          }

          const rotated = next.accessToken !== this.credential?.accessToken
          this.credential = next
          child.stdin.write(
            JSON.stringify({
              kind: 'credential',
              accessToken: next.accessToken,
              ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {})
            }) + '\n'
          )
          settleRenewals(this.state)
          // The engine asks at its five-minute cap as well as after a refusal, so every request
          // rotates the grant: say whether the person's sign-in was actually rotated, not just
          // handed back.
          this.log(rotated ? 'credential renewed' : 'credential handed over unchanged')
        } finally {
          renewing = false
        }
      }

      child.stderr.resume() // Diagnostics may include OAuth details; never relay or log them.
      child.on('error', (error: NodeJS.ErrnoException) =>
        fail('spawn_failed', /^E[A-Z]+$/.test(error?.code ?? '') ? `code=${error.code}` : undefined)
      )
      child.stdin.on('error', () => fail('io'))
      child.stdout.on('error', () => fail('io'))
      child.stderr.on('error', () => fail('io'))
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!this.current(revision) || this.process !== child) {
          return
        }

        if (this.chained?.revision === revision) {
          this.settleChained(this.chained)
        }

        if (settledRenewals) {
          clearTimeout(settledRenewals)
          settledRenewals = undefined
        }

        this.cancelMetadata(child)
        this.process = undefined
        this.taskFiles = false

        if (this.state !== 'disconnected' && this.state !== 'cleanup_failed') {
          this.explain(stage, 'exit', signal ? `signal=${signal}` : `code=${code}`, authorized ?? started)

          return
        }

        this.publish()
      })

      const timer = setTimeout(() => {
        if (!hello) {
          fail('hello_timeout')
        }
      }, 10_000).unref()

      child.stdout.on('data', (chunk: Buffer) => {
        if (!this.current(revision) || this.process !== child) {
          return
        }

        try {
          for (const message of reader.push(chunk)) {
            if (!this.current(revision) || this.process !== child) {
              return
            }

            if (
              !hello &&
              message.kind === 'hello' &&
              message.protocol === 1 &&
              message.issuer === this.owner!.issuer &&
              typeof message.origin === 'string' &&
              message.origin.replace(/\/$/, '') === this.options.engine!.origin
            ) {
              validateMatrixDriveFrame(message, {
                phase: 'awaiting_hello',
                offered: [],
                accepted: [],
                issuer: this.owner!.issuer,
                origin: this.options.engine!.origin
              })

              const offered = Object.hasOwn(message, 'features')
                ? matrixDriveFrameFeatures(message.features)
                : undefined

              this.acceptedFeatures =
                offered?.filter(feature =>
                  MATRIX_DRIVE_FACT_FEATURES.includes(feature as (typeof MATRIX_DRIVE_FACT_FEATURES)[number])
                ) ?? []

              if (this.acceptedFeatures.includes('sync')) {
                this.lastSyncAt = undefined
              }

              hello = true
              this.taskFiles = message.taskFiles === true
              clearTimeout(timer)
              this.log(`engine answered ms=${Date.now() - spawned}`)
              stage = 'start'
              started = Date.now()
              child.stdin.write(
                JSON.stringify({
                  kind: 'start',
                  issuer: this.owner!.issuer,
                  subject: this.owner!.subject,
                  root: this.root(false),
                  configDir,
                  ...(this.credential
                    ? {
                        credential: {
                          accessToken: this.credential.accessToken,
                          ...(this.credential.expiresAt !== undefined
                            ? { expiresAt: this.credential.expiresAt }
                            : {})
                        }
                      }
                    : {}),
                  ...(mode === 'chained' ? { chained: true } : {}),
                  ...(offered ? { features: this.acceptedFeatures } : {})
                }) + '\n'
              )
            } else if (hello && message.kind === 'hello') {
              throw new Error('protocol')
            } else if (!hello) {
              throw new Error(message.kind === 'hello' ? 'hello_mismatch' : 'protocol')
            } else if (
              MATRIX_DRIVE_FACT_FEATURES.includes(message.kind as (typeof MATRIX_DRIVE_FACT_FEATURES)[number])
            ) {
              this.receiveFact(child, revision, message)
            } else if (message.kind === 'credential_request') {
              // The engine only asks in app-credential mode; anything else is a protocol slip.
              if (Object.keys(message).length !== 1 || !this.credential) {
                throw new Error('protocol')
              }

              void renewCredential()
            } else if (message.kind === 'authorize' && typeof message.url === 'string') {
              const url = new URL(message.url)

              if (
                url.origin !== new URL(this.owner!.issuer).origin ||
                url.protocol !== 'https:' ||
                url.username ||
                url.password
              ) {
                throw new Error('authorize_invalid')
              }

              // An engine that ignores the app's own token is older than the handoff: fail closed.
              // Without the credential option (a legacy caller), the engine's own page is used.
              if (this.credential) {
                throw new Error('credential_refused')
              }

              const first = authorized === undefined

              // Nobody pressed anything and this Mac already had this Drive (the launch reconnect,
              // or a folder set up here before turning itself back on): its saved sign-in can't be
              // reused, and the browser never opens by itself for that. The page waits for the
              // person's Sign in; only a first run's one sign-in opens on its own. A "being set up"
              // retry of such a connect holds it too.
              const hold =
                this.signInHeld ||
                (first &&
                  (mode === 'launch' ||
                    (mode === 'automatic' && this.savedFolderEnrolled()) ||
                    (mode === 'retry' && this.unattended)))

              if (first && !hold && (mode === 'automatic' || mode === 'retry' || mode === 'chained')) {
                // Nobody pressed anything: a sign-in the browser doesn't finish is not left
                // waiting all session. It stops, says so, and the next launch tries again.
                setTimeout(() => {
                  if (stage === 'authorize' && !reached) {
                    fail('sign_in_timeout')
                  }
                }, MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS).unref()
              }

              stage = 'authorize'
              authorized ??= Date.now()
              this.signInUrl = url.href
              const chained = mode === 'chained' ? this.chained : undefined

              if (hold) {
                if (!this.signInHeld) {
                  this.signInHeld = true
                  // Why the saved sign-in can't be reused (a Keychain read that failed, a refresh
                  // Drive refused) isn't in the engine's frames; whether it kept an account is.
                  this.log(
                    `sign-in needed at launch; browser waits for the person account=${this.savedFolderEnrolled() ? 'kept' : 'none'}`
                  )
                }
              } else if (chained && chained.revision === revision && !chained.timedOut) {
                this.log('sign-in continued in the existing browser tab')
                this.settleChained(chained, url.href, true)
              } else {
                this.log('sign-in opened in the browser')
                void this.options.openExternal(url.href).catch(() => fail('browser'))
              }

              this.publish()
            } else if (message.kind === 'file_metadata') {
              if (!this.receiveMetadata(child, message)) {
                throw new Error('protocol')
              }
            } else if (
              message.kind === 'state' &&
              typeof message.state === 'string' &&
              states.has(message.state as MatrixDriveState)
            ) {
              const next = message.state as MatrixDriveState
              const wasConnected = stage === 'connected'
              const previousState = this.state

              // Only a held `ready`/`syncing` repays the renewal budget: `offline` right after a
              // handed-over token is the refused-token case, not a working account.
              settleRenewals(next)

              // Before an account exists, or before its first enrollment of the folder, the engine
              // can't recover from an error on its own: say why, stop it, and start a fresh one.
              if (next === 'error' && (stage !== 'connected' || !this.savedFolderEnrolled())) {
                throw new Error('engine_error')
              }

              if (next === 'authorizing') {
                if (stage === 'start') {
                  stage = 'authorizing'
                  this.log('engine looking up Drive and sign-in')
                }
              } else if (
                ['connecting', 'syncing', 'ready', 'offline', 'paused'].includes(next) &&
                stage !== 'connected'
              ) {
                // An account exists from here on; `reauthenticate` (a kept account signed out)
                // leaves the sign-in stages as they are.
                stage = 'connected'
                reached = true
                this.log(`engine connected state=${next}`)
                this.options.store.setItem('drive-enabled:' + this.key, 'yes')

                if (this.chained?.revision === revision) {
                  this.settleChained(this.chained)
                }

                if (authorized !== undefined) {
                  // Back from the browser: "Atum OAuth, then right back to Atum".
                  this.options.returned?.()
                }
              }

              // An account state ends the wait for the browser (a kept account that is asked to
              // sign in again reports `reauthenticate`, which keeps waiting).
              if (['connecting', 'syncing', 'ready', 'offline', 'paused'].includes(next)) {
                this.signInUrl = undefined
                this.signInHeld = false
              }

              // "Up to date · 14:32": the moment a sync finished, until the engine reports its own.
              if (!this.acceptedFeatures.includes('sync') && this.state === 'syncing' && next === 'ready') {
                this.lastSyncAt = Date.now()
              }

              const unchanged =
                this.state === next && !((this.view.waitingForBrowser || this.view.signInNeeded) && !this.signInUrl)

              if (next === 'offline') {
                if (this.offlineSince === undefined) {
                  this.offlineSince = Date.now()
                  this.offlineTimer = setTimeout(() => {
                    this.offlineTimer = undefined

                    if (this.process === child && this.state === 'offline') { this.publish() }
                  }, 10_000)
                  this.offlineTimer.unref()
                }
              } else {
                clearTimeout(this.offlineTimer)
                this.offlineTimer = undefined
                this.offlineSince = undefined
              }

              this.state = next

              // The first account state is already reported above ("engine connected state=…").
              // Later changes are not: without them a transient first `offline` looks permanent.
              if (wasConnected && previousState !== next) {
                this.log(`engine state=${next}`)
              }

              if (next === 'ready' || next === 'syncing') {
                this.rootRebinds = 0
              }

              if (!['ready', 'syncing'].includes(next)) {
                if (this.progressTimer) {
                  clearTimeout(this.progressTimer)
                }

                this.progressTimer = undefined
                this.displayedProgress = undefined
              }

              if (this.state !== 'ready') {
                this.cancelMetadata(child)
              }

              if (['ready', 'syncing', 'paused', 'offline'].includes(this.state)) {
                this.root()
                this.setupRetries = 0
              }

              if (!unchanged) {
                this.publish()
              }

              void this.read()
            } else {
              throw new Error('protocol')
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : ''
          const legacy = ['hello_mismatch', 'authorize_invalid', 'engine_error', 'credential_refused']

          if (reason.startsWith('matrix_drive_')) {
            this.clearFacts()
          }

          fail(reason.startsWith('matrix_drive_') ? 'root_changed' : legacy.includes(reason) ? reason : 'protocol')
        }
      })

      return this.view
    } finally {
      this.busy = false
    }
  }

  /**
   * The one diagnosis of a failed connect: a log line, a problem the panel can put in words, and,
   * when the engine refused a folder that was never enrolled, a fresh folder choice next time.
   * `since` is when the engine opened the sign-in page, or got the folder when it opened none.
   */
  private explain(stage: ConnectStage, reason: string, exit?: string, since?: number): void {
    // The folder this engine was syncing stopped being the one the person approved (replaced,
    // moved, someone else's marker). That is the folder recovery, never the generic stop, whether
    // or not its files were ever listed. Only a folder the engine had enrolled counts: a first
    // connect that never got that far keeps the diagnosis below, which releases the folder.
    if (reason === 'root_changed' && (stage === 'connected' || this.savedFolderEnrolled()) && this.savedRootChanged()) {
      const rebound = this.waitForFolderRecovery('runtime')
      this.log(`connect failed stage=${stage} reason=${reason} problem=${rebound ? 'none' : 'folder_changed'}`)
      this.publish()

      return
    }

    const failedAt = Date.now()
    const unenrolled = stage === 'start' && Boolean(this.binding) && !this.savedFolderEnrolled()

    // Refused before the network: the folder is the likely cause. Our own check names it; the
    // engine's further rules (another app's sync folder, an account kept for another folder)
    // come back as a plain refusal of an explicit error.
    const folder = unenrolled
      ? (this.savedFolderProblem() ?? (reason === 'engine_error' ? 'folder_refused' : undefined))
      : undefined

    // A first connect (the folder not enrolled yet) that the engine itself called failed after it
    // reached the network: Drive's server may be up and have refused this account, or still be
    // setting it up. Asked, not guessed. Local faults (no browser, a crash, a protocol slip) keep
    // the stage's own explanation below.
    // An engine that is refused and just exits (code 0) at the sign-in or account stage is read
    // the same way as one that reports an error.
    const refusedOrFailed =
      reason === 'engine_error' ||
      (reason === 'exit' && exit === 'code=0' && (stage === 'authorize' || stage === 'connected'))

    if (
      !folder &&
      refusedOrFailed &&
      this.options.reachable &&
      (stage === 'authorizing' || stage === 'authorize' || stage === 'connected') &&
      this.binding &&
      !this.savedFolderEnrolled()
    ) {
      this.log(`connect failed stage=${stage} reason=${reason}${exit ? ' ' + exit : ''} problem=checking`)
      this.checkFirstConnect(stage, failedAt - (since ?? failedAt))

      return
    }

    const problem: MatrixDriveProblem | undefined =
      folder ??
      (stage === 'hello' || stage === 'start'
        ? 'engine'
        : stage === 'authorizing'
          ? 'network'
          : stage === 'authorize'
            ? 'sign_in'
            : undefined)

    this.log(`connect failed stage=${stage} reason=${reason}${exit ? ' ' + exit : ''} problem=${problem ?? 'none'}`)

    if (folder && matrixDriveFolderIssue(folder)) {
      this.refuseFolder(folder, 'engine')

      return
    }

    this.recoveryDue = reason === 'credential_unavailable' || reason === 'network'
    this.problem = problem
    this.state = 'error'
    this.endFirstConnect()
    this.publish()
  }

  /** A first connect is over without a folder set up: free the default folder unless something
   * will reconnect into it (the person's own Connect left `drive-enabled` on). */
  private endFirstConnect(): void {
    if (this.binding && this.options.store.getItem('drive-enabled:' + this.key) !== 'yes') {
      this.releaseUnusedDefault()
    }
  }

  /**
   * Whether Drive's server answers decides `network` (it doesn't) from a refusal; then the stop's
   * timing names the refusal (see `matrixDriveFirstConnectProblem`). "Being set up" retries on its
   * own with backoff; "not open for this account" stops the launch reconnect and the automatic
   * connect, so a refused account isn't sent to the browser at every launch (Connect still tries
   * again).
   */
  private checkFirstConnect(stage: 'authorizing' | 'authorize' | 'connected', elapsedMs: number): void {
    this.stopSetupRetry()
    const token = this.diagnosis
    const revision = this.revision
    const key = this.key

    // Until the check answers, the page keeps saying it is connecting.
    this.problem = undefined
    this.state = 'connecting'
    this.publish()

    void this.options.reachable!()
      .catch(() => false)
      .then(reachable => {
        if (token !== this.diagnosis || !this.current(revision) || this.process || this.busy || this.disconnecting) {
          return
        }

        const problem = matrixDriveFirstConnectProblem(stage, reachable, elapsedMs)
        const retry = problem === 'setting_up' ? MATRIX_DRIVE_SETUP_RETRY_MS[this.setupRetries] : undefined

        this.log(
          `drive check reachable=${reachable ? 'yes' : 'no'} after=${Math.round(elapsedMs / 1000)}s problem=${problem}` +
            (retry ? ` retry_in=${retry / 1000}s` : '')
        )

        this.problem = problem

        if (problem === 'not_allowed') {
          // Neither the launch reconnect nor an automatic connect sends a refused account to the
          // browser again; the person's Try again still does.
          this.options.store.setItem('drive-enabled:' + key, '')
          this.stopAutomatic('refused')
        }

        if (retry === undefined) {
          this.state = 'error'
          this.endFirstConnect()
          this.publish()

          return
        }

        this.setupRetries++
        this.state = 'connecting'
        this.publish()
        this.setupTimer = setTimeout(() => {
          this.setupTimer = undefined

          if (token !== this.diagnosis || !this.current(revision) || this.process || this.busy || this.disconnecting) {
            return
          }

          void this.connect('retry').catch(() => {
            if (this.current(revision)) {
              this.state = 'error'
              this.publish()
            }
          })
        }, retry)
        this.setupTimer.unref?.()
      })
  }

  private async stop(forget: boolean): Promise<boolean> {
    const child = this.process

    if (!child) {
      return !forget
    }

    this.cancelMetadata(child)
    this.process = undefined
    this.taskFiles = false
    this.clearFacts()

    return new Promise<boolean>(resolve => {
      let acknowledged = !forget
      const reader = new MatrixDriveFrameReader()

      const receive = (chunk: Buffer) => {
        try {
          for (const message of reader.push(chunk)) {
            if (message.kind === 'state' && message.state === 'disconnected') {
              acknowledged = true
            }
          }
        } catch {
          child.kill('SIGTERM')
        }
      }

      child.stdout.on('data', receive)

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, forget ? 45_000 : 12_000).unref()

      child.once('close', code => {
        clearTimeout(timer)
        child.stdout.removeListener('data', receive)
        resolve(acknowledged && code === 0)
      })
      child.stdin.write(JSON.stringify({ kind: forget ? 'forget' : 'stop' }) + '\n', error => {
        if (error) {
          child.kill('SIGTERM')
        }
      })
    })
  }

  /** Credential cleanup is independent of a missing or moved local root. */
  private async forgetStored(owner: Owner, key: string): Promise<boolean> {
    if (!this.options.engine) {
      return false
    }

    const engine = this.options.engine
    const configDir = path.join(this.options.userData, 'drive-engine', key)

    if (!existsSync(configDir)) {
      return true
    }

    const stat = lstatSync(configDir)

    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(configDir) !== configDir) {
      return false
    }

    const child = (this.options.spawn ?? spawnMatrixDriveEngine)(engine)

    return new Promise<boolean>(resolve => {
      const reader = new MatrixDriveFrameReader()
      let hello = false
      let acknowledged = false

      // Keychain deletion has its own 30-second bound in the companion.
      // Allow completion and clean exit; ordinary process shutdown stays shorter.
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 45_000).unref()

      child.stderr.resume()

      const failed = () => {
        clearTimeout(timer)
        child.kill('SIGTERM')
        resolve(false)
      }

      child.on('error', failed)
      child.stdin.on('error', failed)
      child.stdout.on('error', failed)
      child.stderr.on('error', failed)
      child.on('close', code => {
        clearTimeout(timer)
        resolve(acknowledged && code === 0)
      })
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          for (const message of reader.push(chunk)) {
            if (
              !hello &&
              message.kind === 'hello' &&
              message.protocol === 1 &&
              message.issuer === owner.issuer &&
              typeof message.origin === 'string' &&
              message.origin.replace(/\/$/, '') === engine.origin
            ) {
              validateMatrixDriveFrame(message, {
                phase: 'awaiting_hello',
                offered: [],
                accepted: [],
                issuer: owner.issuer,
                origin: engine.origin
              })
              hello = true
              child.stdin.write(
                JSON.stringify({ kind: 'cleanup', issuer: owner.issuer, subject: owner.subject, configDir }) + '\n'
              )
            } else if (hello && message.kind === 'state' && message.state === 'disconnected') {
              acknowledged = true
            } else if (!hello || message.kind !== 'state') {
              child.kill('SIGTERM')
            }
          }
        } catch {
          child.kill('SIGTERM')
        }
      })
    })
  }

  /** The person's "Turn off Drive": Disconnect, and Drive stays off on this Mac (no automatic
   * connect) until their own Turn on. A sign-out disconnects without this. */
  turnOff(): Promise<MatrixDriveView> {
    this.activate()
    this.stopAutomatic('off')

    return this.disconnect(true)
  }

  /**
   * Only the person's own Turn off passes `forgetChangedFolder`: a saved folder that was replaced is
   * then released. A sign-out or a cancelled sign-in keeps the saved folder, so the next sign-in
   * asks about it again instead of silently starting on another one.
   */
  disconnect(forgetChangedFolder = false): Promise<MatrixDriveView> {
    if (this.disconnecting) {
      const running = this.disconnecting
      const key = this.key

      if (!forgetChangedFolder) {
        return running
      }

      // A disconnect (a sign-out) already started and cleared the problem; the person's Turn off
      // that arrives meanwhile still releases the folder that was waiting as changed.
      return running.then(view => {
        if (this.disconnectBeganChanged && this.binding && this.key === key) {
          this.forgetSavedFolder()
          this.log('changed saved folder forgotten by the person')

          return this.publish()
        }

        return view
      })
    }

    this.disconnecting = this.disconnectOnce(forgetChangedFolder).finally(() => {
      this.disconnecting = undefined
    })

    return this.disconnecting
  }

  private async disconnectOnce(forgetRequested: boolean): Promise<MatrixDriveView> {
    this.activate()
    const owner = this.owner
    const key = this.key
    const forgetChangedFolder = forgetRequested && this.problem === 'folder_changed'
    this.disconnectBeganChanged = this.problem === 'folder_changed'
    const revision = ++this.revision
    this.cancelMetadata()
    this.stopSetupRetry()
    this.setupRetries = 0
    this.signInUrl = undefined
    this.clearLocalBrowseState()
    this.state = 'disconnected'
    this.problem = undefined
    this.clearFacts()

    if (forgetChangedFolder) {
      this.forgetSavedFolder()
      this.log('changed saved folder forgotten by the person')
    }

    this.publish()

    if (!owner || !key) {
      await this.cleanup

      return this.view
    }

    this.options.store.setItem('drive-enabled:' + key, '')
    this.options.store.setItem('drive-cleanup:' + key, 'pending')
    await this.cleanup
    let cleaned = this.process ? await this.stop(true) : false

    // Account withdrawal may append a child-exit barrier while we await cleanup.
    await this.cleanup

    if (!cleaned) {
      cleaned = await this.forgetStored(owner, key)
    }

    if (cleaned) {
      this.options.store.setItem('drive-cleanup:' + key, '')
    }

    if (!this.current(revision)) {
      return this.view
    }

    this.state = cleaned ? 'disconnected' : 'cleanup_failed'

    return this.publish()
  }

  /**
   * The app quits. Quitting is not signing out: the engine stops, and its sign-in, the folder and
   * `drive-enabled` stay, so the next launch reconnects with no browser. Main calls this before it
   * marks itself closing; from here on `activate` changes nothing.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.closePreviews()
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer)
      this.autoRetryTimer = undefined
    }

    if (this.chained) {
      this.settleChained(this.chained)
    }

    this.stopSetupRetry()
    await this.stop(false)
    await this.cleanup
    // Quit during an automatic first run (nothing set to reconnect): the folder Drive never set
    // up goes, while it is still empty. At quit main's owner() is already null: this instance's
    // last owner is the one that counts.
    this.endFirstConnect()
  }

  private resolve(id: string): Row {
    return this.recheck(this.rows.get(id), this.requiredLocalBrowseRoot())
  }

  /** The row is still the same local file or folder, inside the root, reached without a symlink. */
  private recheck(row: Row | undefined, verifiedRoot?: string): Row {
    if (!row) {
      throw new Error('matrix_drive_file_unavailable')
    }

    try {
      const stat = lstatSync(row.path)
      const root = verifiedRoot ?? this.requiredLocalBrowseRoot()

      if (
        stat.isSymbolicLink() ||
        stat.dev !== row.dev ||
        stat.ino !== row.ino ||
        realpathSync(row.path) !== row.path ||
        !row.path.startsWith(root + path.sep)
      ) {
        throw new Error('matrix_drive_file_unavailable')
      }
    } catch {
      throw new Error('matrix_drive_file_unavailable')
    }

    return row
  }

  /** Main-only remote facts for a row that has already passed local containment checks. */
  taskFilesReady(expectedRevision?: number): boolean {
    this.activate()

    if (
      !this.taskFiles ||
      this.state !== 'ready' ||
      !this.process ||
      (expectedRevision !== undefined && expectedRevision !== this.revision) ||
      !this.current(this.revision)
    ) {
      return false
    }

    try {
      this.requiredLocalBrowseRoot()

      return true
    } catch {
      return false
    }
  }

  metadata(id: string, mode: MetadataMode, expectedRevision: number): Promise<MetadataResult> {
    this.activate()

    if (
      !['read', 'replace', 'create'].includes(mode) ||
      expectedRevision !== this.revision ||
      this.state !== 'ready' ||
      !this.process ||
      !this.taskFiles ||
      this.metadataPending.size >= 4 ||
      this.disconnecting ||
      !this.binding ||
      !this.owner
    ) {
      return Promise.reject(new Error('matrix_drive_file_unavailable'))
    }

    let row: Row
    let root: string
    let relativePath: string
    let personalSpace: string

    try {
      row = this.resolve(id)

      if ((mode === 'create' && row.kind !== 'folder') || (mode !== 'create' && row.kind !== 'file')) {
        throw new Error()
      }

      root = this.root()
      relativePath = path.relative(root, row.path).split(path.sep).join('/')

      if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.split('/').some(part => !part || part === '.' || part === '..')
      ) {
        throw new Error()
      }

      personalSpace = this.bindingSpace(this.binding, this.owner)
    } catch {
      return Promise.reject(new Error('matrix_drive_file_unavailable'))
    }

    return this.request(id, row, mode, relativePath, personalSpace)
  }

  /**
   * Main-only, for a cloud agent's working copies on this Mac (S1 build plan §4 WS-5; never
   * reachable from the renderer, never by a view row): the Drive root and, for files under it
   * (paths relative to the root), what the engine's journal says. A file whose local bytes match
   * its journal record (clean) gets its server resource, ETag and size; anything else — a local
   * edit not yet synced, a new file, a file over the engine's metadata limit, a symlink, an engine
   * that is not ready — gets null, so nothing treats a local version as a server version. Null
   * when Drive is not set up and enrolled on this Mac.
   */
  async manifestFor(relativePaths: readonly string[]): Promise<{ root: string; files: Map<string, MetadataResult | null> } | null> {
    this.activate()
    let root: string

    try {
      root = this.root()
    } catch {
      return null
    }

    if (!Array.isArray(relativePaths) || relativePaths.length > 5_000) {
      throw new Error('matrix_drive_file_unavailable')
    }

    const files = new Map<string, MetadataResult | null>()
    // One budget for the whole list: an engine that stops answering costs each request its 10 s
    // timeout, and 2,000 of them would hold a device turn for hours. A file asked after the budget
    // is null (no server version), which only makes an output over it a sibling.
    const deadline = Date.now() + MANIFEST_BUDGET_MS

    for (const relativePath of relativePaths) {
      if (!files.has(relativePath)) {
        // One at a time, beside the selected-file requests' bound of four.
        files.set(relativePath, Date.now() < deadline ? await this.journalFacts(root, relativePath, deadline) : null)
      }
    }

    return { root, files }
  }

  /** Main-only: the folder Drive is bound to on this account, connected or not (never a renderer path). */
  savedRoot(): string | null {
    const root = this.binding?.root

    return typeof root === 'string' && path.isAbsolute(root) ? root : null
  }

  private async journalFacts(root: string, relativePath: string, deadline: number): Promise<MetadataResult | null> {
    if (
      typeof relativePath !== 'string' ||
      !relativePath ||
      Buffer.byteLength(relativePath, 'utf8') > 1024 ||
      [...relativePath].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f || character === '\\') ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..')
    ) {
      return null
    }

    let row: Row

    try {
      const file = path.join(root, ...relativePath.split('/'))
      const stat = lstatSync(file)

      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file || !file.startsWith(root + path.sep)) {
        return null
      }

      row = { path: file, kind: 'file', dev: stat.dev, ino: stat.ino }
    } catch {
      return null
    }

    // The queue wait and the request both spend the caller's budget, so the list ends at it.
    for (let waited = 0; this.metadataPending.size >= 4 && waited < 10_000 && Date.now() < deadline; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    if (Date.now() >= deadline || !this.taskFilesReady() || this.metadataPending.size >= 4 || this.disconnecting || !this.binding || !this.owner) {
      return null
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const answer = this.request(null, row, 'read', relativePath, this.bindingSpace(this.binding, this.owner))
      // A late answer is dropped; the request's own 10 s timeout still clears its pending entry.
      answer.catch(() => undefined)

      return await Promise.race([answer, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())) })])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** One `file_metadata` request to the engine; its answer is checked by receiveMetadata. */
  private request(id: string | null, row: Row, mode: MetadataMode, relativePath: string, personalSpace: string): Promise<MetadataResult> {
    const process = this.process
    const requestId = randomUUID()
    const revision = this.revision
    const binding = { ...this.binding }
    const rowBinding = { ...row }

    return new Promise<MetadataResult>((resolve, reject) => {
      const rejectUnavailable = () => reject(new Error('matrix_drive_file_unavailable'))

      const timer = setTimeout(() => {
        const pending = this.metadataPending.get(requestId)

        if (pending?.process === process) {
          this.metadataPending.delete(requestId)
          rejectUnavailable()
        }
      }, 10_000).unref()

      this.metadataPending.set(requestId, {
        resolve,
        reject: rejectUnavailable,
        timer,
        revision,
        process,
        id,
        mode,
        row: rowBinding,
        root: binding,
        personalSpace
      })

      try {
        process.stdin.write(JSON.stringify({ kind: 'file_metadata', requestId, mode, relativePath }) + '\n', error => {
          if (error) {
            const pending = this.metadataPending.get(requestId)

            if (pending?.process === process) {
              this.metadataPending.delete(requestId)
              clearTimeout(pending.timer)
              pending.reject()
            }
          }
        })
      } catch {
        const pending = this.metadataPending.get(requestId)

        if (pending?.process === process) {
          this.metadataPending.delete(requestId)
          clearTimeout(pending.timer)
          pending.reject()
        }
      }
    })
  }

  async enter(id: string): Promise<MatrixDriveView> {
    this.activate()
    const row = this.resolve(id)

    if (row.kind !== 'folder') {
      throw new Error('matrix_drive_file_unavailable')
    }

    this.folder = path.relative(this.requiredLocalBrowseRoot(), row.path)

    return this.read()
  }

  async back(): Promise<MatrixDriveView> {
    this.activate()
    this.folder = this.folder ? path.dirname(this.folder) : ''

    if (this.folder === '.') {
      this.folder = ''
    }

    return this.read()
  }

  async open(id: string): Promise<void> {
    this.activate()
    const row = this.resolve(id)

    if (row.kind !== 'file') {
      throw new Error('matrix_drive_file_unavailable')
    }

    if (await this.options.openPath(row.path)) {
      throw new Error('matrix_drive_open_failed')
    }
  }

  /** Open one bounded read-only snapshot for an opaque native row. The renderer receives no path. */
  preview(id: string): MatrixDrivePreview {
    this.activate()
    const row = this.resolve(id)

    if (row.kind !== 'file') {
      throw new Error('matrix_drive_file_unavailable')
    }

    this.closePreviews()
    const token = randomUUID()
    const name = path.basename(row.path)
    const openKind = consumerFileOpenKind(name)
    let handle: number

    try {
      handle = openSync(row.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch {
      throw new Error('matrix_drive_file_unavailable')
    }

    try {
      const stat = fstatSync(handle)

      if (!stat.isFile() || stat.dev !== row.dev || stat.ino !== row.ino) {
        throw new Error('matrix_drive_file_unavailable')
      }

      const base = { token, name, size: stat.size, modifiedAt: stat.mtimeMs }
      const kind: MatrixDrivePreview['kind'] =
        openKind === 'pdf' ? 'pdf' : openKind === 'image' ? 'image' : openKind === 'text' ? 'text' : 'unsupported'
      this.previews.set(token, { row: { ...row }, kind })

      if (kind === 'pdf') {
        return { ...base, kind }
      }

      if (
        kind === 'unsupported' ||
        (kind === 'image' && stat.size > maxPreviewImageBytes) ||
        (kind === 'text' && stat.size > maxPreviewTextBytes)
      ) {
        this.previews.set(token, { row: { ...row }, kind: 'unsupported' })

        return { ...base, kind: 'unsupported' }
      }

      const bytes = Buffer.alloc(stat.size)
      let offset = 0

      while (offset < bytes.length) {
        const length = readSync(handle, bytes, offset, bytes.length - offset, offset)

        if (!length) {
          throw new Error('matrix_drive_file_unavailable')
        }

        offset += length
      }

      if (kind === 'image') {
        const mime = consumerFileImageMime(name)

        if (!mime) {
          throw new Error('matrix_drive_file_unavailable')
        }

        return { ...base, kind, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
      }

      if (bytes.includes(0)) {
        this.previews.set(token, { row: { ...row }, kind: 'unsupported' })

        return { ...base, kind: 'unsupported' }
      }

      try {
        return { ...base, kind, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      } catch {
        this.previews.set(token, { row: { ...row }, kind: 'unsupported' })

        return { ...base, kind: 'unsupported' }
      }
    } catch {
      this.closePreview(token)
      throw new Error('matrix_drive_file_unavailable')
    } finally {
      closeSync(handle)
    }
  }

  /** Main-only PDF resolver. It revalidates root custody and the leased inode on every use. */
  resolvePreview(token: string): string | null {
    const preview = this.previews.get(token)

    if (!preview || preview.kind !== 'pdf') {
      return null
    }

    try {
      return this.recheck(preview.row, this.requiredLocalBrowseRoot()).path
    } catch {
      this.closePreview(token)

      return null
    }
  }

  closePreview(token: string): void {
    if (this.previews.delete(token)) {
      this.options.closeNativePreview?.(token)
    }
  }

  private closePreviews(): void {
    for (const token of [...this.previews.keys()]) {
      this.closePreview(token)
    }
  }

  async reveal(): Promise<void> {
    this.activate()

    if (await this.options.openPath(this.requiredLocalBrowseRoot())) {
      throw new Error('matrix_drive_open_failed')
    }
  }
}
