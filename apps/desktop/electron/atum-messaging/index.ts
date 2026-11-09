export type { AdvisorySearchRequest, AdvisorySearchResult } from '../../shared/atum-advisory-search'
export { AtumAccountAuthController, resolveAtumAccountConfig, SupabaseAtumAccountClient } from './account-auth'
export type {
  AtumAccountAuthStatus,
  AtumAccountConfig,
  AtumAccountProviders,
  AtumPasswordSignInInput
} from './account-auth'
export { assertTrustedAtumAccountSender, registerAtumAccountIpc } from './account-ipc'
export { ACCOUNT_ROOT_AT_REST_POSTURE, accountKeyFor, AccountRootAuthority } from './account-roots'
export type {
  AccountRootAtRestPosture,
  AccountScopedPaths,
  CommittedAccountRoot,
  LegacyAccountDataDisposition
} from './account-roots'
export { AtumAppSurfacesClient, CONNECT_CANDIDATE_MAX_PROBES } from './app-surfaces'
export type {
  ConnectCandidate,
  ConnectCandidateStatus,
  IntakeFieldOption,
  IntakeFieldSpec,
  IntakeFieldType,
  IntakeStatus
} from './app-surfaces'
export { ATUM_APP_SURFACE_IPC_CHANNELS, registerAtumAppSurfaceIpc } from './app-surfaces-ipc'
export type { AppSurfaceFailure, AppSurfaceResult } from './app-surfaces-ipc'
export {
  ATUM_AUTH_CALLBACK_HOST,
  ATUM_AUTH_CALLBACK_TTL_MS,
  ATUM_AUTH_SCHEME,
  AtumAuthCallbackBroker,
  atumAuthRedirectUrl,
  isAtumAuthScheme,
  parseAtumAuthCallback
} from './auth-deep-link'
export type { AtumAuthCallback, AtumAuthDelivery, AtumAuthDeliveryOutcome } from './auth-deep-link'
export { SafeStorageAuthStorage, safeStorageAvailability } from './credential-vault'
export { AtumMessagingHttpClient, MessagingHttpError } from './http-client'
export { registerAtumMessagingIpc } from './ipc'
export { applyMessagingMigrations, MESSAGING_MIGRATIONS } from './migrations'
export {
  resolveAtumProductDefaultModel,
  resolveAtumPublicAccountConfig,
  resolveAtumUpdateFeedUrl
} from './public-config'
export { AtumMessagingRuntime } from './runtime'
export { AtumMessagingStore, openAtumMessagingStore } from './store'
export { cursorHintIsAhead, MessagingSyncCoordinator } from './sync-coordinator'
export { AtumMessagingSyncEngine } from './sync-engine'
export type {
  CanonicalizeMessageInput,
  CanonicalMessage,
  ConnectivityState,
  ConversationDraft,
  DirectMessagingClientBoundary,
  DirectMessagingStoreBoundary,
  MessagingAccountSession,
  MessagingClientBoundary,
  MessagingConversation,
  MessagingSessionTokens,
  MessagingStoreBoundary,
  MessagingSyncStatus,
  MessagingTransportStatus,
  MessagingUser,
  MutationFailure,
  MutationState,
  OpenMessagingStoreOptions,
  PendingMutation,
  QueueSendInput,
  SaveDraftInput,
  StoredMessage,
  SyncCursor
} from './types'
