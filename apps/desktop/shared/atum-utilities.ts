/** Main-owned connection facts. Provider credentials and native calendar IDs never cross into the renderer. */
export type UtilityKind = 'email' | 'calendar' | 'drive'
export type UtilityProvider = 'google' | 'apple-calendar'
export type UtilityError = 'unavailable' | 'cancelled' | 'timeout' | 'denied' | 'reconnect' | 'network' | 'storage' | 'account_changed' | 'invalid_input' | 'conflict' | 'unsupported' | 'outcome_unknown'

/** Mailbox-control failures: they reach the assistant's tool answer only, never Settings. */
export type UtilityMailError = 'scope_missing' | 'not_found' | 'label_not_found' | 'too_large' | 'message_too_large' | 'response_invalid'

export interface UtilitySource {
  id: string
  kind: UtilityKind
  provider: UtilityProvider
  accountKey: string | null
  label: string
  detail?: string
  primary?: boolean
  state: 'connected' | 'reconnect'
  enabled: boolean
  writable?: boolean
  /** Email only: the grant includes mailbox control (labels, archive, read/star, trash, drafts). */
  manageable?: boolean
}

export interface UtilityStatus {
  accountId: string
  generation: number
  sources: UtilitySource[]
  available: Record<UtilityProvider, boolean>
  degraded?: boolean
  appleConnected?: boolean
  calendarSelectionRequired?: boolean
  workspaceProtected?: boolean
}

export type UtilityConnectInput = { provider: 'google'; service?: 'email-calendar' | 'drive' | 'google' } | { provider: 'apple-calendar' }
export type UtilityDisconnectInput = { provider: 'google'; accountKey: string } | { provider: 'apple-calendar' }

export interface UtilitySourcePreference {
  id: string
  enabled: boolean
}

export interface UtilityResult {
  status: UtilityStatus | null
  error?: UtilityError
}

export interface UtilityBridge {
  status(): Promise<UtilityResult>
  connect(input: UtilityConnectInput): Promise<UtilityResult>
  disconnect(input: UtilityDisconnectInput): Promise<UtilityResult>
  setEnabled(preferences: UtilitySourcePreference[]): Promise<UtilityResult>
  cancel(): Promise<void>
}

export const UTILITY_IPC = {
  status: 'atum:utilities:status',
  connect: 'atum:utilities:connect',
  disconnect: 'atum:utilities:disconnect',
  setEnabled: 'atum:utilities:set-enabled',
  cancel: 'atum:utilities:cancel'
} as const
