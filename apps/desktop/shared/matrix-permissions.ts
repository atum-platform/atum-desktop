/** Local OS facts for the primary Matrix UI. No agent or document authority. */
export const MATRIX_PERMISSIONS_IPC = {
  status: 'matrix:permissions:status',
  settings: 'matrix:permissions:settings',
  relaunch: 'matrix:permissions:relaunch'
} as const

export type MatrixPermission =
  | 'accessibility'
  | 'screen'
  | 'microphone'
  | 'automation'
  | 'files'
  | 'fullDisk'
  | 'location'
export type MatrixPermissionStatus =
  | 'granted'
  | 'not-granted'
  | 'not-determined'
  | 'denied'
  | 'restricted'
  | 'unknown'
  | 'manual-check'

export interface MatrixPermissionsSnapshot {
  platform: 'macos' | 'unsupported'
  /** TCC identity of this running application, never CuaDriver or another executor. */
  permissions: Record<MatrixPermission, MatrixPermissionStatus>
}

export interface MatrixPermissionsBridge {
  status(): Promise<MatrixPermissionsSnapshot>
  /** Opens a fixed OS pane; does not request or claim a grant. */
  openSettings(permission: MatrixPermission): Promise<void>
  /** Passive 1.5 s status checks while the caller's permission card is visible. */
  watch?(listener: (snapshot: MatrixPermissionsSnapshot) => void): () => void
  /** Relaunches this app after a newly granted permission needs a fresh process. */
  relaunch?(): Promise<void>
}
