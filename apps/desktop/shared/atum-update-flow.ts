export type AtumUpdateChannel = 'latest' | 'beta'
export type AtumUpdateState = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'preparing' | 'downloaded' | 'restarting' | 'error'
export type AtumUpdateFailureCode = 'disk_space' | 'transport' | 'hash_mismatch' | 'failed'
export type AtumUpdateFailureStage = 'check' | 'download' | 'install'

export interface AtumUpdateFailure {
  code: AtumUpdateFailureCode
  stage: AtumUpdateFailureStage
  /** When stock native staging cannot be cancelled safely, do not offer a dead retry. */
  recovery?: 'manual_download'
  /** A short, plain-text explanation derived from the upstream updater error. */
  message: string
  requiredBytes?: number
}

export interface AtumUpdateStatus {
  armed: boolean
  packaged: boolean
  channel: AtumUpdateChannel
  state: AtumUpdateState
  version: string | null
  checkedAt: number | null
  progress: number | null
  notes: readonly string[]
  error: AtumUpdateFailure | null
  /** Reserved for the cloud rollout projection. */
  requiredBelow: null
}

export interface AtumUpdateNotes {
  v: 1
  version: string
  locale: string
  items: readonly string[]
}
