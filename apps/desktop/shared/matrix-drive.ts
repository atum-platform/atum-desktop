/** Presentation facts only. Native paths, OAuth grants and engine commands stay in main. */
export { MATRIX_DRIVE_IMPORT_LABELS } from './matrix-drive-import-copy'

export type MatrixDriveState =
  | 'unavailable'
  | 'disconnected'
  | 'authorizing'
  | 'connecting'
  | 'syncing'
  | 'ready'
  | 'offline'
  | 'paused'
  | 'reauthenticate'
  | 'error'
  | 'cleanup_failed'

/**
 * Why connecting stopped, as a closed code for plain-language copy. Most `folder_*` problems come
 * from the chosen folder (choosing another fixes it, and that folder is never kept);
 * `folder_changed` means the saved path no longer has the filesystem identity the person approved
 * and requires an explicit rebind or forget; `folder_nested_taken` is a chosen folder that already
 * holds an "Atum Drive" folder with other files in it; the rest are the helper not starting
 * (`engine`), Drive or sign-in not answering (`network`), a browser
 * sign-in that did not finish (`sign_in`), and, on a first connect with Drive's server up,
 * this account's Drive still being created (`setting_up`, retried automatically) or Drive not
 * open for this account (`not_allowed`).
 */
export type MatrixDriveProblem =
  | 'folder_not_empty'
  | 'folder_home'
  | 'folder_protected'
  | 'folder_in_drive'
  | 'folder_other_drive'
  | 'folder_unavailable'
  | 'folder_changed'
  | 'folder_refused'
  | 'folder_nested_taken'
  | 'engine'
  | 'network'
  | 'sign_in'
  | 'setting_up'
  | 'not_allowed'

export interface MatrixDriveRow {
  id: string
  name: string
  kind: 'file' | 'folder'
  size: number
  modifiedAt: number
  /** Present only when main's current exclusion rules keep this item local. */
  localOnly?: true
  /** Negotiated engine facts only; never inferred from Drive-wide counters. */
  syncStatus?: 'conflict' | 'error' | 'uploading'
  /** Search results' parent folder names from Drive's root, never a native path. */
  folders?: string[]
}

export interface MatrixDriveSearchResult {
  revision: number
  query: string
  rows: MatrixDriveRow[]
  truncated: boolean
}

/** One bounded, main-owned preview lease. Native paths never cross this contract. */
export type MatrixDrivePreview = {
  token: string
  name: string
  size: number
  modifiedAt: number
} & ({ kind: 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'pdf' } | { kind: 'unsupported' })

export interface MatrixDriveProgress {
  active: boolean
  files: { done: number; total: number }
  bytes: { done: number; total: number }
  etaSeconds: number | null
  direction: 'up' | 'down' | 'mixed'
}
export interface MatrixDriveQuota {
  total: number
  used: number
  remaining: number
  state: 'normal' | 'nearing' | 'critical' | 'exceeded'
}
export interface MatrixDriveIssue {
  id: string
  code: 'drive_full' | 'conflicts' | 'errors' | 'excluded' | 'signed_out'
  count?: number
}

export interface MatrixDriveView {
  state: MatrixDriveState
  revision: number
  /** Main verified that this signed-in owner still owns the same enrolled local root. This
   * presentation fact never grants remote metadata or sync authority; native actions recheck it. */
  canBrowseLocally?: boolean
  /** Freshness of the local directory listing only. It says nothing about server freshness. */
  listingStatus?: 'loading' | 'current' | 'partial' | 'stale'
  /** Epoch milliseconds of the last completed local scan. Preserved when a refresh fails. */
  listedAt?: number
  /** Set with `disconnected` (a folder problem) or `error`, until the next connect; and with
   * `connecting` (`setting_up`) while Atum waits to try again on its own. */
  problem?: MatrixDriveProblem
  rootLabel?: string
  /** Where the Drive folder lives, for the person to read: `~/…` inside the home folder, just
   * the folder's name elsewhere; never an absolute path. Never sent back to main. */
  rootLocation?: string
  folderLabel?: string
  canGoBack: boolean
  rows: MatrixDriveRow[]
  truncated: boolean
  /** The engine's sign-in page is open in the browser and the engine is waiting for it. The URL
   * itself stays in main: "Open again" asks main to reopen it. */
  waitingForBrowser?: true
  /** A connect at launch (nobody pressed anything) found that Drive's saved sign-in can't be
   * reused. The engine's sign-in page is ready but not opened, and Drive never opens it: a
   * legacy engine that asks for a browser fails closed instead. Never set together with
   * `waitingForBrowser`. */
  signInNeeded?: true
  /** When Drive last finished syncing (epoch ms), from the engine's syncing → ready step, kept in
   * main for this account so a reload or another view says the same time. */
  lastSyncAt?: number
  progress?: MatrixDriveProgress
  quota?: MatrixDriveQuota
  issues?: MatrixDriveIssue[]
  /** Prior engine facts may be presented, but cannot authorize operations while stale. */
  factsStale?: true
  fileStatusAvailable?: true
  /** Live presentation facts for the active, separately leased search. Never a folder listing. */
  searchResult?: MatrixDriveSearchResult & { requestId: string }
}

/** Explicit owner intent. IDs are opaque native row handles, never paths or remote IDs. */
export type MatrixDriveSelection =
  | { id: string; mode: 'read' | 'replace' }
  | { id: string; mode: 'create'; leafName: string }

export interface MatrixDriveTaskInput {
  roomId: string
  body: string
  revision: number
  selections: MatrixDriveSelection[]
}

export type MatrixDriveImportSkip = 'private' | 'code' | 'excluded' | 'shortcuts' | 'special' | 'unreadable'

/** Counts and opaque intent only: native selection paths never enter this object. */
export type MatrixDriveImportPlan =
  | { state: 'cancelled' }
  | {
      state: 'refused'
      reason:
        | 'home'
        | 'protected'
        | 'in_drive'
        | 'unavailable'
        | 'too_many'
        | 'timeout'
        | 'quota_unknown'
        | 'staging_volume'
        | 'busy'
        | 'empty'
    }
  | {
      state: 'ready' | 'warning' | 'blocked'
      planId: string
      expiresAt: number
      files: number
      folders: number
      bytes: number
      skipped: Record<MatrixDriveImportSkip, number>
      space: { total: number; used: number; remainingAfter: number; estimated: boolean }
    }

export interface MatrixDriveImportResult {
  state: 'completed' | 'cancelled' | 'expired' | 'changed' | 'no_room' | 'unavailable'
  /** Only confirmed exclusive placements. Already placed files stay when the rest is cancelled. */
  added: number
}

/** Once sending starts an ambiguous response must not invite a second event. */
export type MatrixDriveTaskResult =
  | { state: 'not_sent' }
  | { state: 'sent'; eventId: string }
  | { state: 'grant_failed_after_ack'; eventId: string }
  | { state: 'send_unknown' }

export interface MatrixDriveBridge {
  read(): Promise<MatrixDriveView>
  /** Main searches names under its own enrolled root/current folder. No renderer-selected path. */
  search?(query: string, scope: 'drive' | 'folder', requestId: string): Promise<MatrixDriveSearchResult>
  cancelSearch?(requestId: string): Promise<void>
  /** Turn Drive on in `~/Atum/Drive` (made when missing): never a folder picker. */
  connect(): Promise<MatrixDriveView | { cancelled: true }>
  /** The person's "Choose another folder…": the only way to the folder picker. */
  chooseFolder(): Promise<MatrixDriveView | { cancelled: true }>
  /** Stop waiting for the browser sign-in and turn Drive off again. */
  cancelSignIn(): Promise<MatrixDriveView>
  disconnect(): Promise<MatrixDriveView>
  enter(id: string): Promise<MatrixDriveView>
  back(): Promise<MatrixDriveView>
  /** Optional while the renderer and main process can be upgraded on separate clocks. */
  preview?(id: string): Promise<MatrixDrivePreview>
  closePreview?(token: string): Promise<void>
  open(id: string): Promise<void>
  reveal(): Promise<void>
  taskStatus(roomId: string): Promise<{ state: 'ready' | 'unavailable' }>
  sendTask(input: MatrixDriveTaskInput): Promise<MatrixDriveTaskResult>
  /** Optional until the owned native import composition is present; absent hides its entry. */
  importPlan?(): Promise<MatrixDriveImportPlan>
  importRun?(planId: string): Promise<MatrixDriveImportResult>
  importCancel?(planId: string): Promise<MatrixDriveImportResult>
  subscribe(listener: (view: MatrixDriveView) => void): () => void
}

export const MATRIX_DRIVE_IPC = {
  request: 'matrix:drive:request',
  changed: 'matrix:drive:changed'
} as const
