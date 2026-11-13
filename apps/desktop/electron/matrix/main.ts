import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Separate composition root: importing legacy main.ts would start its writers.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  autoUpdater as nativeAutoUpdater,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  WebContentsView
} from 'electron'
import { autoUpdater as appUpdater } from 'electron-updater'

import {
  type AgentSourceSweepSnapshot,
  fitAgentSourceSweepSnapshot
} from '../../../shared/src/agent-source-sweep'
import {
  fitFollowupSweepSnapshot,
  fitWarmupNudgeSnapshot,
  type FollowupSweepEvidenceInput,
  type FollowupSweepEvidenceSnapshot,
  followupSweepInsideNormalWindow,
  followupSweepNeedsModel,
  followupSweepNeedsSuggestion,
  followupSweepPrompt,
  type FollowupSweepPromptSnapshot,
  followupSweepResultFingerprint,
  followupSweepSuggestionHistory,
  validateFollowupSweepResult,
  validateFollowupSweepSuggestion,
  validateWarmupNudgeResult,
  warmupNudgePrompt
} from '../../../shared/src/followup-sweep'
import {
  admitPrivateConversationPublication,
  CONVERSATION_PLAIN_FLOOR,
  ConversationUnavailableError,
  EarlierConversationError,
  firstRunConversationRoom,
  requireAssistantConversation,
  taskFilesConversationStatus
} from '../../shared/agent-conversation'
import { earlierConversationNotice } from '../../shared/agent-conversation/copy'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { ConversationCandidateRead, MatrixConversationView } from '../../shared/agent-conversation/view'
import { agentAppsDiscovery, agentStoreDiscovery } from '../../shared/agent-discovery'
import type {
  AgentProfileDetail,
  AgentProfileRequest,
  AgentProfileResult
} from '../../shared/agent-profile-management'
import {
  type AgentTaskBinding,
  type AgentTaskEvent,
  agentTaskMessage,
  MATRIX_AGENT_TASK_WATCH_ID
} from '../../shared/agent-task'
import { manageMatrixAgentTask } from '../../shared/agent-task-management'
import { appBotGuestReady, parseAppBotStatus } from '../../shared/app-bot-status'
import {
  APP_BOT_CONSENT_LOCALES,
  type AppBotDescriptor,
  appBotDisclosureVersion,
  appCatalogNames,
  type AppDescriptor,
  appLocalizedCopy
} from '../../shared/app-catalog'
import { parseAppIntakeStatus } from '../../shared/app-intake'
import { AppSurfaceError, appViewTransportFailure } from '../../shared/app-view/protocol'
import { type AtumPersonalPet, parsePetBundle } from '../../shared/atum-account-pets'
import type { AtumPetBinding } from '../../shared/atum-account-preferences'
import { ATUM_AGENT_PORTABILITY_SCHEMA_VERSION } from '../../shared/atum-agent-portability'
import type { AtumDocumentRecoveryWriteInput } from '../../shared/atum-office/document-recovery'
import type { MatrixBackgroundSweepSettingWrite } from '../../shared/background-sweep'
import { isBotApiRoomForApp } from '../../shared/bot-api-room'
import {
  DEFAULT_DESKTOP_LOCALE,
  type DesktopLocale,
  desktopLocaleFor,
  isDesktopLocale
} from '../../shared/desktop-locale'
import {
  MATRIX_CHANNELS as channel,
  MATRIX_MAX_FILE_BYTES,
  MATRIX_PLAIN_SENDER_DEVICE,
  type MatrixAgentHomeView,
  type MatrixAgentServiceStatus,
  type MatrixAgentTurnView,
  type MatrixAgentView,
  type MatrixCloudAccess,
  type MatrixCloudAgentStatus,
  type MatrixCloudMoveOutcome,
  type MatrixCloudStopOutcome,
  type MatrixCloudTrialAccepted,
  type MatrixCloudTrialOffer,
  type MatrixCommand,
  type MatrixDevicePresence,
  type MatrixEnrollment,
  type MatrixGroupRoomRead,
  type MatrixIdentity,
  type MatrixInvocationMessage,
  type MatrixInvocationWatch,
  type MatrixLocalTurnNotice,
  type MatrixMessage,
  type MatrixNewSignIn,
  type MatrixOriginAssertion,
  type MatrixOwnerReaderStatus,
  matrixOwnerWireType,
  type MatrixReadiness,
  type MatrixSdkCommand,
  type MatrixSnapshot,
  type MatrixTurnLookup
} from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import { MATRIX_AGENT_SOURCES_IPC } from '../../shared/matrix-agent-sources'
import { matrixAgentStatusText, matrixCheckingLine } from '../../shared/matrix-agent-status-copy'
import { appBotTurnRefusal } from '../../shared/matrix-app-bot-failure'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import { matrixApprovalCopy } from '../../shared/matrix-approval-copy'
import { checkAssistantName, isAssistantNameLocked } from '../../shared/matrix-assistant-name'
import { isAssistantRoom, usableAgentRoom } from '../../shared/matrix-assistant-room'
import { matrixAuxiliaryConfirmationCopy } from '../../shared/matrix-auxiliary-copy'
import {
  MATRIX_CHECK_IN_JOB_ID,
  matrixCheckInCost,
  matrixCheckInEnvelope,
  type MatrixCheckInNudge,
  type MatrixCheckInsState,
  matrixCheckInStopRequested
} from '../../shared/matrix-check-ins'
import { matrixMaintenanceConfirmationCopy } from '../../shared/matrix-command-center-ops-copy'
import { isTeamSpaceRoom, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import type { MatrixCompanyFileRef, MatrixCompanyFileRefV2 } from '../../shared/matrix-company-files'
import { isTrustedPayOSUrl } from '../../shared/matrix-company-funding'
import type { CompanyConversationDirectory15Response } from '../../shared/matrix-company-team-space'
import { matrixComputerUseGrantConfirmationCopy } from '../../shared/matrix-computer-use-grant-copy'
import { MATRIX_CONTINUITY, type MatrixContinuityRead, type MatrixContinuityTarget } from '../../shared/matrix-continuity'
import { matrixCuratorConfirmation } from '../../shared/matrix-curator-copy'
import { matrixDebugConfirmationCopy } from '../../shared/matrix-debug-share-copy'
import { MATRIX_DESKTOP_SERVICES } from '../../shared/matrix-desktop-services'
import type { MatrixDeviceIsolation } from '../../shared/matrix-device-isolation'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'
import { MATRIX_DRIVE_IPC } from '../../shared/matrix-drive'
import { MATRIX_DRIVE_IMPORT_LABELS } from '../../shared/matrix-drive-import-copy'
import {
  MATRIX_FIRST_LEARNING_JOB_ID,
  type MatrixFirstLearningProgress,
  matrixFirstLearningStarting
} from '../../shared/matrix-first-learning'
import { matrixFirstRunPlace } from '../../shared/matrix-first-run-place'
import { MATRIX_GOOGLE_CONNECTION_IPC } from '../../shared/matrix-google-connections'
import { MATRIX_GOOGLE_PROTECTED_MODEL } from '../../shared/matrix-google-tools'
import { matrixGroupAudience, matrixGroupMode } from '../../shared/matrix-group-room'
import { formatMatrixHandleDiagnostic } from '../../shared/matrix-handle-diagnostic'
import { MatrixInterimMessages } from '../../shared/matrix-interim-messages'
import {
  isMatrixInviteDeepLinkCandidate,
  MATRIX_INVITE_LINK_IPC
} from '../../shared/matrix-invite-link'
import { MATRIX_KEEP_AWAKE } from '../../shared/matrix-keep-awake'
import { matrixManagementConfirmationCopy } from '../../shared/matrix-management-copy'
import type { MatrixMcpConfirmation } from '../../shared/matrix-mcp-settings'
import {
  isMatrixMessageLinkCandidate,
  MATRIX_MESSAGE_LINK_IPC,
  type MatrixMessageLinkTarget
} from '../../shared/matrix-message-link'
import { matrixModelDisplayName } from '../../shared/matrix-model-display-name'
import {
  MATRIX_ATUM_PROVIDER,
  MATRIX_CHECK_IN_MODEL_ALIAS,
  MATRIX_CONNECTED_MODEL_ERRORS,
  MATRIX_DEFAULT_MODEL,
  type MatrixConnectedModel,
  matrixConnectedModelEfforts,
  type MatrixEffort,
  type MatrixModelId,
  type MatrixModelRoute,
  matrixTurnEffort,
  matrixTurnModel,
  parseMatrixConnectedModel,
  parseMatrixModelRouteId
} from '../../shared/matrix-models'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import type { MatrixNoticeEdit } from '../../shared/matrix-notice-edit'
import { MATRIX_PAGE_IDS, matrixPagesHubAllowed } from '../../shared/matrix-pages'
import {
  matrixPagesArchiveCopy,
  matrixPagesInstallCopy,
  matrixPagesScanCopy,
  matrixPagesUpdateCopy
} from '../../shared/matrix-pages-copy'
import {
  type MatrixPetDraft,
  type MatrixPetGenerateInput,
  type MatrixPetHatchInput,
  type MatrixPetHatchProgress,
  type MatrixPetHatchQuote,
  matrixPetHatchQuoteMatches,
  type MatrixPetPhoto,
  type MatrixPetTarget,
  type MatrixPetView
} from '../../shared/matrix-pet'
import { MATRIX_PET_DISPLAY_ACTION } from '../../shared/matrix-pet-display'
import { MATRIX_PET_INTENT_PLAYBACK, matrixPetIntentEnvelope } from '../../shared/matrix-pet-intent'
import type { MatrixSeenProof } from '../../shared/matrix-presentation-signals'
import { type MatrixProfileMetadata, matrixProfileMxc, matrixProfilePhoto } from '../../shared/matrix-profile'
import { MatrixProgressLine } from '../../shared/matrix-progress-line'
import { matrixInterimTransaction, matrixProgressNoticeTransaction } from '../../shared/matrix-progress-transaction'
import type {
  MatrixProviderConfirmation,
  MatrixProviderOAuthResult,
  MatrixProviderOAuthSession,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'
import { matrixRuntimeConfirmationCopy } from '../../shared/matrix-runtime-copy'
import type {
  MatrixOwnDevices,
  MatrixOwnerRestore,
  MatrixOwnerStatus,
  MatrixRecoveryCheck,
  MatrixSecurity
} from '../../shared/matrix-security'
import { parseMatrixShelfModel } from '../../shared/matrix-shelf-models'
import { matrixStatusAsk } from '../../shared/matrix-status-ask'
import { MatrixStatusLine } from '../../shared/matrix-status-line'
import { matrixProgressCopy, matrixStatusLineCopy } from '../../shared/matrix-status-line-copy'
import type { MatrixStoreRunLedger } from '../../shared/matrix-store-runs'
import { matrixStoreHiredItems, matrixStoreScheduledItems } from '../../shared/matrix-store-schedules'
import { MATRIX_CHATGPT_SIGN_IN_URL, parseMatrixSubscriptionProvider } from '../../shared/matrix-subscriptions'
import type { MatrixHermesTerminalEvent, TerminalReadOptions } from '../../shared/matrix-terminal'
import { matrixToolSettingsConfirmationCopy } from '../../shared/matrix-tool-settings-copy'
import { MATRIX_FIND_TURN, matrixCronTransaction, matrixTurnContent } from '../../shared/matrix-turn'
import { MatrixTurnVoice } from '../../shared/matrix-turn-voice'
import { MATRIX_VOICE_IPC } from '../../shared/matrix-voice'
import { matrixVoiceSettingsConfirmationCopy } from '../../shared/matrix-voice-settings-copy'
import { MATRIX_WINDOW_CHANNELS } from '../../shared/matrix-window'
import { formatMatrixWindowFailureDiagnostic } from '../../shared/matrix-window-failure'
import type { MatrixWebPreviewTarget } from '../../shared/matrix-workbench-preview'
import { DEFAULT_CONTEXT_LIMITS, effectiveMode } from '../../shared/room-participation'
import type { GroupRecentTarget } from '../../shared/room-participation/recent'
import { publicGroupRoutingRole } from '../../shared/room-participation/relevance'
import { resolveProjectedConversation } from '../../src/matrix/conversation-marker'
import { matrixSdkCommandTimeout } from '../../src/matrix/sdk-host-queue'
import { type AppViewController, createAppViewController } from '../app-view/controller'
import { AtumConsumerFilesService } from '../atum-consumer-files'
import { AtumPdfViewController, clearPdfViewSessionStorage, hardenPdfViewSession } from '../atum-pdf-view'
import { createReportingSink } from '../atum-reporting-sinks'
import { cleanStaleStages, confirmHealthyStart } from '../atum-staged-swap/cleanup'
import { recoverAtStartup } from '../atum-staged-swap/recovery'
import { ATUM_BUNDLE_ID as STAGED_APP_ID } from '../atum-staged-swap/state'
import { consumeFailureNotice, markStarted, stagedSwapEnabled, stageRoot } from '../atum-staged-swap/store'
import { StagedMacUpdater } from '../atum-staged-swap/updater'
import { readGoogleClient } from '../atum-utilities'
import { createConsumerBrowserController } from '../consumer-browser/controller'
import { EncryptedStore } from '../encrypted-store'
import { createNativeAppInventory } from '../native-app-inventory'
import { createNativeAppWindows, nativeAppPresentation, nativeWordAutomationAllowed } from '../native-app-window'
import { NativeAppsController } from '../native-apps'
import { ownedBackgroundChildren } from '../owned-background-children'
import { createAtumKeepAwake } from '../power-save'
import { reportBackendExit, reportChildProcessGone, reportRendererGone } from '../process-exit-reports'
import { createUpdateHandoff, restoredUpdateBounds, type UpdateHandoff, type UpdateHandoffResult } from '../update-handoff'
import { saveUserSelectedFile } from '../user-selected-file-save'
import { createWordMacAdapter } from '../word-companion-mac'
import { createWordLiveMacAdapter } from '../word-live-mac'

import { MatrixAccount } from './account'
import { matrixAccountLogLine } from './account-events'
import {
  finishMatrixSubscriptionChatGptPoll,
  matrixSubscriptionAccountAvailable,
  MatrixSubscriptionFollowUpRepair,
  matrixSubscriptionHostExecutor,
  matrixSubscriptionHostHome,
  matrixSubscriptionPlanSignInGate,
  matrixSubscriptionsWithChatGptRelay
} from './account-subscription-flow'
import {
  forgetSubscriptionChatGpt,
  matrixChatGptGrant,
  matrixSubscriptionEnvironment,
  matrixSubscriptionKeyStore,
  type MatrixSubscriptionKeyStore,
  matrixSubscriptionsStatus
} from './account-subscriptions'
import { MatrixAgentActionsLog } from './agent-actions-log'
import { MatrixAgentAvatarProjection } from './agent-avatar'
import {
  type MatrixAgentChatsBinding,
  requestBoundMatrixAgentChats
} from './agent-chats'
import { MatrixAgentContent } from './agent-content'
import {
  MatrixAgentDefinitionError,
  type MatrixAgentDefinitionRecord,
  type MatrixAgentDefinitionSnapshot
} from './agent-definition'
import { markMatrixAgentHosted, matrixAgentHosted, matrixRuntimeHome, reconcileMatrixAgentHome } from './agent-home'
import { type AgentHomeApp, createAgentHomeApp } from './agent-home-placement/app'
import { agentAtRest, agentHoldWrites } from './agent-home-placement/at-rest'
import type { HomeSignedAction, PublicationEnvelope } from './agent-home-placement/contract'
import { type AgentHomeOwnerMovePreflightV25, placementConnectionSignedBytes } from './agent-home-placement/contract-v25'
import { fenceFromLease, withOperation } from './agent-home-placement/fence'
import { handleAgentHomeOwnerRequest } from './agent-home-placement/owner-ipc'
import type { MacAgentHandle } from './agent-home-placement/runtime-adapter'
import { waitForAgentSetup } from './agent-home-placement/setup-wait'
import { homeViewFor, type MacNames, ownerHomeReadFallback, ownerHomeViewFor } from './agent-home-placement/view'
import {
  markMatrixAgentSoulApplied,
  MATRIX_AGENT_CREATIONS,
  MATRIX_AGENT_RETIREMENTS,
  MatrixAgentCreationRefused,
  MatrixAgentLifecycle,
  matrixAgentSoulText,
  type MatrixCreatedAgent,
  reconcileMatrixAgentSoul,
  replaceMatrixAgentSoul,
  seedMatrixAgentSoul
} from './agent-lifecycle'
import { matrixAgentModelView } from './agent-model-view'
import { manageMatrixAgentProfile } from './agent-profile-management'
import {
  carryMatrixHermesHome,
  MatrixAgentReenrollments,
  matrixReenrollKey,
  type MatrixReenrollReason,
  reenrollMatrixAgent
} from './agent-reenroll'
import { MatrixAgentRoutines, registerMatrixAgentRoutinesIpc } from './agent-routines'
import {
  matrixAgentHomeRoom,
  matrixDefaultAgent,
  matrixDefaultRuntime,
  matrixRetiredRootCustody,
  matrixRetirementTarget,
  matrixRoomAgent,
  matrixRootEnrollmentPrincipal,
  matrixRosterChanges,
  matrixTurnAgent,
  matrixTurnsNeedingHost,
  matrixTurnsUsing
} from './agent-routing'
import {
  MATRIX_AGENT_SCOPES,
  matrixAgentAtRest,
  matrixAgentQuiet,
  MatrixAgentRuntime,
  matrixAgentScope,
  matrixBackendRestartable,
  matrixMissingTickerRestartable,
  matrixTurnOwnsHeldLease,
  type MatrixTurnSlot,
  matrixUnheldTickerRestartable,
  reconcileMatrixAgentLease
} from './agent-runtime'
import { MatrixAgentSignals, matrixWorkingAsk } from './agent-signals'
import {
  MatrixAgentSourceSettings,
  registerMatrixAgentSourcesIpc
} from './agent-source-settings'
import { MatrixAgentTaskControls } from './agent-task-controls'
import { hasStoredMatrixAgentTaskOutcome, invokeMatrixAgentTask } from './agent-task-invocation'
import { backgroundAgentTrust, prepareMatrixAgentTrust, resumeAfterAgentTrust } from './agent-trust'
import { switchAnsweringToCloud } from './answering-switch'
import { openAppAuthSheet } from './app-auth-sheet'
import { appBotIntakeAuthorized, appBotPinRequired, appBotSendAuthorized } from './app-bots/authority'
import { canRetireLegacyAppCopy } from './app-bots/legacy-retirement'
import {
  appBotChatHiddenLine,
  appBotChatHideFailedLine,
  appBotChatSelectedLine,
  localAppChatRoom,
  logAppChatFailures,
  startAppChat
} from './app-bots/open-chat'
import { platformAppChatRoom } from './app-bots/platform-room'
import { appBotPinFailure, type AppBotTrustRecord, appBotTrustState, pinAppBotDevice } from './app-bots/trust'
import { connectAppRoom, createAppConversation } from './app-conversation'
import { AppIconDiskCache } from './app-icon'
import { applyMatrixAppIdentity } from './app-identity'
import { appBotStatusLogLine, appLinkLogLine, type AppLinkOutcome, appMenuFailedLogLine } from './app-link-log'
import {
  closeMatrixDevToolsInShippedBuild,
  createMatrixAppMenu,
  MATRIX_MENU_WEBSITE,
  matrixAppMenuLocale,
  matrixRemoteControlSwitches,
  matrixUpdateCheckMessage
} from './app-menu'
import { createMatrixApps } from './app-workspace'
import { MatrixAssistantCards, registerMatrixAssistantCardsIpc } from './assistant-card'
import { matrixAssistantNameEntries, MatrixAssistantNameSync } from './assistant-name-sync'
import {
  assistantBlocked,
  assistantCommand,
  assistantInviteAdoptionEnabled,
  assistantInviteCoexistences,
  assistantRoomInvalidated,
  matrixExplicitInvocationRefusal,
  MatrixInvocationFlights,
  projectAssistantRooms
} from './assistant-policy'
import { sendAssistantMessage } from './assistant-send'
import {
  matrixAssistantSetupRosterRetry,
  matrixAssistantSetupRunsLocally,
  matrixLocalExecutorRequired
} from './assistant-setup'
import { matrixPrimarySoulFallback } from './atum-soul'
import {
  AGENT_SWEEP_PROFILE,
  AGENT_SWEEP_PROFILE_V2,
  AGENT_SWEEP_PROFILE_V11,
  type BackgroundSweepCandidate,
  type BackgroundSweepLease,
  backgroundSweepOwnerEvent,
  MatrixBackgroundSweeps
} from './background-sweep'
import {
  backgroundSweepCalendarEvidence,
  backgroundSweepChatEvidence,
  backgroundSweepConversationEvidence,
  backgroundSweepDriveEvidence,
  backgroundSweepMacFileEvidence,
  backgroundSweepMailEvidence,
  backgroundSweepMemoryEvidence,
  selectBackgroundSweepChats,
  selectBackgroundSweepMail,
  sweepCarryKey,
  sweepHash,
  sweepWatermark,
  sweepWatermarkAt,
  sweepWatermarkCarry,
  sweepWatermarkDigest
} from './background-sweep-evidence'
import { recentMacFileNames } from './background-sweep-files'
import {
  backgroundSweepReportedUsage,
  MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS,
  MatrixBackgroundSweepModelCalls
} from './background-sweep-model'
import {
  MATRIX_BACKGROUND_SWEEP_SIGNATURE_ACTION,
  ShellBackgroundSweepPlatform
} from './background-sweep-platform'
import { MatrixBackgroundSweepPublication } from './background-sweep-publication'
import {
  type BackgroundSweepSourceRead,
  BackgroundSweepSourceRegistry,
  collectBackgroundSweepSources,
  collectLegacyBackgroundSweepSources,
  NATIVE_AGENT_SOURCE_OPERATIONS
} from './background-sweep-sources'
import { MatrixBackgroundSweepSuggestions } from './background-sweep-suggestions'
import { MatrixBackgroundVerifications, MatrixLaunchSummary } from './background-verification'
import { appBotPhotoForRenderer } from './bot-api-media'
import { createBrowserImport } from './browser-import/compose'
import { registerBrowserImportIpc } from './browser-import/ipc'
import { MatrixChatGptRelay, requestMatrixChatGptRelay } from './chatgpt-relay-client'
import { type MatrixCheckInLeaseHold, MatrixCheckIns, refuseMatrixCheckIns } from './check-ins'
import { FileCheckoutJournal, MatrixCheckoutController } from './checkout'
import { registerMatrixClipboard } from './clipboard'
import {
  matrixAgentAnswerReady,
  matrixAgentJobsPlan,
  type MatrixAgentJobsPlan,
  matrixCloudAgentAnswersInCloud,
  matrixCloudAgentMacRole,
  type MatrixCloudAgentMacRole,
  matrixCloudAgentNeedsLocalReadiness,
  matrixCloudAgentReadinessForUser,
  matrixCloudAgentSetupForUser,
  MatrixPlacedAgents,
  matrixPlacedCloudOnly
} from './cloud-agent-placement'
import {
  cloudHomeMemoryNote,
  cloudHomeReadApplies,
  type CloudHomeSync,
  MatrixCloudHomeReader,
  requestCloudHome
} from './cloud-home-read'
import {
  MatrixCloudModelChoices,
  requestMatrixCloudModelChoice
} from './cloud-model-choice'
import { matrixSharedCodexHere } from './codex-accounts'
import { openMatrixCompanyBoardAttachment } from './company-board-attachment'
import { CompanyConversationConfirmations } from './company-conversation-confirmations'
import { readCompanyChannelDirectory } from './company-directory'
import { resolveCompanyFileAuthorityV2 } from './company-file-authority-v2'
import {
  type MatrixCompanyFileControllerPorts,
  readCompanyFile,
  recoverCompanyFile,
  sendCompanyFile
} from './company-file-controller'
import { readCompanyFileV2, sendCompanyFileV2 } from './company-file-controller-v2'
import { MatrixCompanyPrivateCosNotificationAuthority } from './company-private-cos-notification-authority'
import { createPresentationDispatch, createRoomCommandGuard } from './company-room-dispatch'
import { CompanyChannelConfirmations, companyChannelOpenFailedLine, companyChannelSelectedLine } from './company-room-guard'
import { FileCompanyStoreJournal, requestMatrixCompanyStore } from './company-store'
import { MatrixCompanyStoreBridgeController } from './company-store-bridge'
import { matrixConfigurationKey, matrixGoogleFullPower } from './config'
import {
  listMatrixModelCatalog,
  type MatrixConnectedModelsAgent,
  parseMatrixConnectedModelRequest,
  selectMatrixModelRoute
} from './connected-models'
import { continuityDiagnostic, readContinuityResult } from './continuity'
import { type ContinuousListeningPreference, MatrixContinuousListening } from './continuous-listening'
import {
  conversationBackgroundAction,
  ConversationRequestActivity,
  requireConversationSnapshot
} from './conversation/activity'
import { conversationMacFleetReady } from './conversation/app-version'
import { postEarlierConversationNotice } from './conversation/earlier'
import { conversationJobOrigins } from './conversation/jobs'
import { parseConversationMigrationJournal } from './conversation/migrate'
import { conversationRemovalAllowed } from './conversation/removal'
import { conversationRuntimeFence } from './conversation/runtime-fence'
import { type ConversationMigrationAction, ConversationMigrationService } from './conversation/service'
import {
  MATRIX_CREDENTIAL_RENEWAL,
  MatrixCredentialRenewal,
  matrixRenewedWatchEnd,
  renewMatrixAgentHost
} from './credential-renewal'
import { MatrixCronDelivery, type MatrixCronPost } from './cron-delivery'
import { applyMatrixJobsHold, MatrixCronHolds, matrixJobsTickerMissing, reconcileMatrixJobsHold } from './cron-hold'
import { installMatrixDesktopServicesIpc, matrixAfterClose, MatrixDesktopServices } from './desktop-services'
import { MatrixDeviceApproval } from './device-approval'
import { MatrixDeviceIsolationPolicy } from './device-isolation'
import { MatrixDeviceLedger } from './device-ledger'
import { matrixDeviceName, readMatrixMacModel } from './device-name'
import {
  type DeviceLaunch,
  deviceLaunchFrom,
  DeviceServiceBootstrap,
  fenceDeviceBeforeOperationLock
} from './device/bootstrap'
import { runChatGptRelayProcess } from './device/chatgpt-relay-process'
import {
  acceptCloudTrial,
  CloudAccessLog,
  CloudAgentEnrollment,
  type CloudTrialOffer,
  deviceEnrollmentCode,
  type DeviceOwnerRefusal,
  deviceRegistryTransport,
  hasEnrolledCloudMac,
  macComputerName,
  MacDeviceIdentity,
  MATRIX_CLOUD_AGENT_UNSUPPORTED,
  parseAgentServiceStatus,
  parseCloudAccess,
  parseCloudTrial,
  requestS1,
  resolveDeviceOwner,
  type S1Resource,
  s1Route,
  sameCloudTrial,
  setAgentAnswering,
  shownCloudTrial,
  workspaceLabelFor
} from './device/cloud-agent'
import { requestHostStop } from './device/host-stop'
import { stopCloudTurn } from './device/cloud-stop'
import { deviceHubUrl } from './device/connection'
import { verifyControllerSignature } from './device/device-key'
import { type DeviceEnrollmentOwner, DeviceRegistryError } from './device/enrollment'
import { resolveDisclaimLauncher } from './device/launcher'
import {
  AgentMigration,
  exportAgentHome,
  fileSha256,
  migrationConfirmCopy,
  type MigrationOutcome
} from './device/migration'
import { DesktopHomeMigration, type MigrationLocalAgent } from './device/migration-client'
import { confirmMigrationReport } from './device/migration-confirmation'
import { MigrationWriterHolds } from './device/migration-hold'
import { createDeviceNativeUi } from './device/native-ui'
import { appBundleOf } from './device/protected-paths'
import { createDeviceRuntime, type DeviceRuntime } from './device/runtime'
import { servedAgentUsers } from './device/served-agents'
import { cloudTrialConfirmCopy } from './device/trial-copy'
import { ConflictCopyRelay, DriveWorkspaceCopies } from './device/workspace'
import { type MatrixDiskHealth, matrixFreeBytes, watchMatrixDisk } from './disk-health'
import { matrixDiskReserve } from './disk-reserve'
import { applyMatrixDisplayZoom, requireMatrixDisplayIdentity } from './display-preferences'
import { MatrixDocumentClose } from './document-close'
import { matrixDocumentRecoveryRoot } from './document-recovery-root'
import { MatrixRoomDocuments } from './documents'
import { PendingMatrixDrafts } from './draft-pending'
import { MatrixDrive, matrixDriveOpen, matrixDriveReachable } from './drive'
import { DRIVE_CHAINED_SIGN_IN, matrixDriveChain } from './drive-chain'
import { selectMatrixDriveEngine } from './drive-engine'
import { matrixDriveFolderPrompt } from './drive-folder'
import { MatrixDriveImport } from './drive-import'
import { registerMatrixDriveIpc } from './drive-ipc'
import { sendDriveTask } from './drive-task'
import { MatrixEnrollmentRateLimited, sameMatrixEnrollment } from './enrollment'
import { executionDeviceNamesProjectionChanged, MatrixExecutionDeviceNames } from './execution-device-names'
import {
  MatrixExecutionPolicyController,
  matrixExecutionPolicyHasLocalDestination,
  matrixExecutionPolicyLeaseIntent,
  matrixExecutionPolicyListeningAction,
  matrixExecutionPolicyLocalMode,
  matrixExecutionPolicyStartsLocalReadiness,
  requestMatrixExecutionPolicy
} from './execution-policy'
import { installMatrixExitBarrier } from './exit-barrier'
import {
  MatrixFirstRun,
  matrixFirstRunAvailable,
  matrixFirstRunOpen,
  matrixFirstRunToolAllowed
} from './first-run'
import { MatrixFirstRunGoogleValue } from './first-run-google'
import { matrixFirstRunNamingContext, matrixFirstRunNamingForIncoming } from './first-run-naming'
import { MatrixFirstRunWelcome } from './first-run-welcome'
import { folderAccessPolicyFile, MatrixFolderAccess, registerMatrixFolderAccessIpc } from './folder-access'
import {
  createMatrixFounderChat,
  FOUNDER_CHAT_COMMAND_MS,
  handleMatrixFounderContact,
  matrixFounderView
} from './founder-chat'
import { ensureMatrixFullHermes } from './full-hermes'
import { createMatrixGoogleConnectionIpcHandler, publishMatrixGoogleFence, requestMatrixGoogleAccountConnect, requestMatrixGoogleAccountStatus } from './google-connection-boundary'
import { type MatrixGoogleConnectionOwner, MatrixGoogleConnections } from './google-connections'
import {
  MatrixGoogleFenceNotices,
  type MatrixGoogleFenceOwner,
  matrixGoogleFenceSender,
  matrixGoogleFenceSenderRefused
} from './google-fence'
import { MatrixGoogleFenceLog } from './google-fence-log'
import { matrixGoogleToolResult, MatrixGoogleTools, matrixGoogleUtilityInput } from './google-tools'
import { matrixGoogleWriteCopy } from './google-write-copy'
import { matrixGroupHint, matrixGroupLease, type MatrixGroupTurn, matrixGroupTurnInvalidated } from './group-turns'
import { groupPausedCopy } from './groups/budget'
import { prepareGroupChain } from './groups/chain'
import { groupCorrectionTarget, GroupTurnCorrections, publishCurrentGroupTurn } from './groups/correction'
import { groupDisclosureEpoch, publishDisclosedGroupAnswer } from './groups/disclosure'
import { GroupRoomQueue, prepareGroupFloor, requireGroupOwnerEvent } from './groups/floor'
import { publishPausedGroupNotice } from './groups/paused-notice'
import { requireGroupPolicyRead } from './groups/policy-read'
import { requireGroupRecentRead } from './groups/recent'
import { GroupRelevanceRouter } from './groups/routing'
import { migrateMatrixCodexAccounts } from './hermes-codex-migration'
import { MatrixHermesExecutor, type MatrixHermesTurnLifecycle } from './hermes-executor'
import { MatrixHermesListener, type MatrixTurnLine } from './hermes-listener'
import { MatrixHermesPrompts } from './hermes-prompts'
import {
  clearMatrixAccountChatGpt,
  clearMatrixHermesCredentials,
  forgetMatrixAccountCodex,
  forgetMatrixAccountCodexSignIn,
  MATRIX_ATUM_FOLDER,
  matrixAccountCodexScope,
  type MatrixHermesConnection,
  matrixHermesEnvironment,
  matrixHermesHome,
  type MatrixHermesRuntimeConfig,
  openMatrixHermes,
  withMatrixHermes
} from './hermes-runtime'
import {
  applyMatrixFullHermes,
  configureMatrixHermes,
  configureMatrixManagedModel,
  finishMatrixAtumModelSwitch,
  MATRIX_HERMES_ENDPOINT,
  MATRIX_MANAGED_ENDPOINT,
  MATRIX_MODEL_CHECK_WRITES,
  matrixAtumModelSwitchBlocked,
  matrixHermesReadiness,
  matrixSetupBlock,
  parseMatrixHermesModel,
  prepareMatrixHermesModel
} from './hermes-setup'
import { matrixHostEndsTurns, matrixHostLiveness, matrixHostsTakeNewClaims, matrixLeaseHostAction } from './host-health'
import { MatrixICloudKeychain, matrixKeychainHelper } from './icloud-keychain'
import { MatrixInviteLinkBroker } from './invite-link-broker'
import {
  invokeMatrixApp,
  invokeMatrixHermes,
  matrixConversationKey,
  matrixGrant,
  matrixHeldReplyLocale,
  matrixHermesReader,
  matrixInvocationResult,
  matrixTransientReadFailure
} from './invocation'
import {
  matrixAppViewCommandAllowed,
  matrixExternalLink,
  matrixOpenLink,
  matrixPdfBelowTitlebar,
  parseMatrixCommand,
  parseMatrixNewSignInDismiss,
  parseMatrixSignInMethod,
  parseMatrixTurnReply,
  parseMatrixUseAtumModel,
  requireMatrixCaller
} from './ipc-policy'
import {
  MATRIX_BUNDLED_CONFIG_NAME,
  matrixLaunchConfigurationErrorCopy,
  readMatrixLaunchConfig
} from './launch-config'
import { MatrixExecutorLease } from './lease'
import { MatrixLeaseHandover } from './lease-handover'
import { matrixListeningArmCode, matrixListeningFollow, matrixListeningRefusedEverywhere } from './listening-room'
import { LOCAL_TURN_LIMIT_MS, localInvocationRecords } from './local-authority'
import { MatrixLocalBrain } from './local-brain'
import { type MatrixLocalTurn, MatrixLocalTurns, matrixTurnPrompt, matrixTurnQuestion } from './local-turn'
import { fileLoginStartupMemory, MatrixLoginStartup, registerMatrixLoginStartupIpc } from './login-startup'
import { LookAssetDiskCache, MatrixLookAssets } from './look-asset'
import { projectMacFleet } from './mac-fleet'
import { assertMacJobDeliveryHome, completeMacJobDelivery, drainMacJobs, settleMacJobDelivery } from './mac-job-delivery'
import { macJobAuthority, MacJobLifecycle } from './mac-job-lifecycle'
import { runMacJobs } from './mac-job-runner'
import { macJobsTickerPlan } from './mac-job-startup'
import { MacJobsClient, MacJobTransportError } from './mac-jobs'
import {
  MacLocationProvider,
  macSourceConsentScope,
  macSourceGateEnabled,
  macSourceGates,
  MacSourcesConsentStore,
  MacSourcesService,
  probeFullDiskAccess,
  registerMatrixMacSourcesIpc,
  writeMacSourcesPolicy
} from './mac-sources'
import { MacSourceReadiness, nativeMacSourceStatus } from './mac-sources/readiness'
import { RemoteMacSourcesService } from './mac-sources/remote'
import { matrixMainAgentContentTarget } from './main-agent-content'
import { handleMatrixAliasPending, handleMatrixAliasRequest } from './main-aliases'
import {
  handleMatrixCompanyCommand,
  handleMatrixCompanyNativeCommand,
  handleMatrixCompanyPending
} from './main-company'
import { handleMatrixCompanyDesktop } from './main-company-desktop'
import { handleMatrixCompanySearch, handleMatrixCompanySearchOpen } from './main-company-search'
import {
  admitMatrixEnrollmentSetup,
  matrixEnrollmentAuthority,
  projectMatrixEnrollmentReadiness,
  readMatrixAgentPresentation
} from './main-enrollment'
import { isMatrixGoogleAgentRole, MATRIX_GOOGLE_ASSISTANT_ROLE, MatrixGoogleAssistant } from './main-google'
import { registerMatrixLinkPreviewIpc } from './main-link-previews'
import { mirrorTaggedConsole } from './main-log'
import { handleMatrixModelDestinationsRequest } from './main-model-destinations'
import { handleMatrixPeoplePrivacy, handleMatrixPeopleSearch } from './main-people-search'
import {
  matrixMainProfileHost,
  matrixMemberAvatarRoom,
  registerMatrixMemberAvatarIpc,
  registerMatrixProfilesIpc
} from './main-profiles'
import { matrixManagedAgentPrincipal, MatrixManagedModel } from './managed-model'
import { dispatchMatrixCommand } from './message-dispatch'
import { MatrixMessageLinkBroker } from './message-link-broker'
import {
  forgetMatrixModelCheck,
  type MatrixModelCheckContext,
  type MatrixModelCheckRun,
  runMatrixModelCheck
} from './model-check'
import { MatrixModelDestinations, requestMatrixModelDestinations, writeMatrixCloudAtumChoice } from './model-destinations'
import { requireMatrixSessionChoice } from './model-session'
import { readMatrixNativeAppReadiness, registerMatrixNativeApps } from './native-apps'
import {
  MatrixNewSignInLedger,
  matrixNewSignInSameScope,
  matrixNewSignInScope,
  matrixNewSignInView
} from './new-sign-in-alert'
import { logNotesSelfOpenFailures } from './notes-self-log'
import { createMatrixNotifications } from './notifications'
import { MatrixOfficialAccountsController } from './official-accounts'
import { createMatrixOpenSourceNotices, MATRIX_NOTICES_DIRECTORY } from './open-source-notices'
import {
  nodeOperatorFiles,
  OPERATOR_MOVE_TICK_MS,
  operatorMoveDirectory,
  operatorMoveTicker
} from './operator-move'
import { MatrixOwnerDeviceRepair, matrixOwnerRepairError, matrixOwnerRepairPreservesWork } from './owner-device-repair'
import {
  forgetMatrixOwnerKey,
  keptMatrixOwnerKey,
  type MatrixOwnerBinding,
  type MatrixOwnerKey,
  type MatrixOwnerKeyLegacy,
  matrixOwnerKeyMirrors,
  type MatrixOwnerKeyRetain,
  matrixOwnerKeyRetention,
  MatrixOwnerKeys,
  retainMatrixOwnerKey
} from './owner-keys'
import { createOwnerReaderTrustPoller, prepareOwnerReaderControls } from './owner-reader-poll'
import { compareCurrentOwnerReader, crossSignCurrentOwnerReader } from './owner-reader-trust'
import { ensureMatrixOwnerRecovery } from './owner-recovery'
import { matrixMayAskOtherDevices, type MatrixOwnerUnlock, unlockMatrixOwner } from './owner-unlock'
import { isMatrixAuxiliaryRequest, MatrixPagesAuxiliaryScope } from './pages-auxiliary'
import { forwardMatrixPagesRequest, readMatrixPagesMedia, selectMatrixPagesAgent } from './pages-bridge'
import { isMatrixCommandCenterRequest, MatrixPagesCommandCenterScope } from './pages-command-center'
import { isMatrixCommandCenterOpsRequest, MatrixPagesCommandCenterOpsScope } from './pages-command-center-ops'
import { createMatrixPagesComputerUseScope, isMatrixComputerUseRequest } from './pages-computer-use'
import { createMatrixPagesComputerUseGrantScope, isMatrixComputerUseGrantRequest } from './pages-computer-use-grant'
import { MatrixPagesController, type Scope as MatrixPagesScope } from './pages-controller'
import { isMatrixCuratorRequest, MatrixPagesCuratorScope } from './pages-curator'
import { isMatrixDebugShareRequest, MatrixPagesDebugShareScope } from './pages-debug-share'
import { createMatrixPagesHubScope, type MatrixPagesHubScope } from './pages-hub'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { isMatrixMcpRequest, MatrixPagesMcpScope } from './pages-mcp'
import { matrixPagesOpenLogLine } from './pages-open-log'
import { isMatrixProvidersRequest, MatrixPagesProvidersScope } from './pages-providers'
import { createMatrixPagesRuntimeScope, isMatrixRuntimeRequest } from './pages-runtime'
import { isMatrixStarmapRequest, MatrixPagesStarmapScope } from './pages-starmap'
import { isMatrixToolSettingsRequest, MatrixPagesToolSettingsScope } from './pages-tool-settings'
import { isMatrixVoiceSettingsRequest, MatrixPagesVoiceSettingsScope } from './pages-voice-settings'
import { registerMatrixPermissions } from './permissions'
import {
  cachedBundledPetReader,
  MatrixPersonalPetCache,
  readCachedMatrixPersonalPet,
  readCachedMatrixPersonalPetById,
  readMatrixBundledPet,
  readMatrixPersonalPet
} from './pet-assets'
import { MatrixPetChatError, parsePetChatHistoryIpcInput, parsePetChatIpcInput } from './pet-chat-client'
import { MatrixPetDiagnosticLog } from './pet-diagnostic-log'
import {
  matrixPetHatchScale,
  matrixPetPublicationNeedsAttention,
  MatrixPetRecoveryFlights,
  quarantineMatrixPetRecord,
  recoverMatrixPetCredit
} from './pet-hatch-recovery'
import {
  matrixPetHatchTarget as resolvePetHatchTarget,
  matrixPetRecoveryTarget as resolvePetRecoveryTarget
} from './pet-hatch-target'
import { readMatrixPetIntentSurface } from './pet-intent-surface'
import { MatrixPetDisplay } from './pet-overlay-preferences'
import { MatrixPetOverlayService } from './pet-overlay-service'
import { MatrixPets } from './pets'
import { readMatrixPlanAcknowledgment, saveMatrixPlanAcknowledgment } from './plan-acknowledgment'
import { createMatrixPresenceLifecycle } from './presence-lifecycle'
import { MatrixProfiles } from './profile'
import { installMatrixProfileImport, publishMatrixProfileImport, readMatrixProfileImport } from './profile-import'
import {
  MatrixProviderConnections,
  matrixSubscriptionsWithProviderConnections,
  requestMatrixProviderConnections
} from './provider-connections'
import { createMatrixQuitHandler } from './quit'
import {
  matrixCloudOnlyReadiness,
  matrixLaunchExclusionLine,
  type MatrixReadinessCheck,
  MatrixReadinessMonitor,
  restartMatrixReadinessAfterExpiry
} from './readiness'
import { fetchMatrixReporting } from './reporting-transport'
import { recoverMatrixResult } from './result-recovery'
import { MatrixRetiredAgentRooms } from './retired-agent-rooms'
import { MatrixRosterRecovery, type MatrixRosterScope, refreshMatrixRosterOnWake } from './roster-recovery'
import { drainMatrixRuntimes, MATRIX_RUNTIME_DRAIN_TIMEOUT_MS } from './runtime-drain'
import { matrixRuntimeFailureCode, selectMatrixHermesRuntime, selectMatrixLocalBrainProcess } from './runtime-selection'
import {
  appHostDisposition,
  boundSdkConfiguration,
  matrixAgentRenews,
  matrixAgentSdkRefresh,
  matrixHostAgent,
  matrixHostApp,
  type MatrixHostRole,
  matrixHumanSdkReady,
  MatrixSdkHost,
  matrixSdkRendererRestartable,
  stopSdkWithApps
} from './sdk-host'
import { MatrixSdkRendererRecovery } from './sdk-renderer-recovery'
import {
  matrixChatTokenRefused,
  matrixSessionAction,
  matrixSessionChecks,
  matrixSessionEndedSnapshot
} from './session-route'
import { matrixEmailSignInState } from './sign-in-entry'
import {
  readMatrixSourceGatesV2,
  writeMatrixSourceGates
} from './source-gates'
import { MatrixAccountSourceGates } from './source-gates-v2'
import { matrixStarterNotice, requireMatrixStarterAcknowledgement } from './starter-notice'
import { endMatrixStartup, trackMatrixQuit } from './startup-end'
import { FileStoreJournal, matrixScopedHireTargetLive, MatrixStoreController } from './store'
import { prepareMatrixStoreContext } from './store-context'
import {
  matrixStoreHireInstallable,
  matrixStoreRunItems,
  MatrixStoreRuns,
  MatrixStoreSchedules,
  prepareMatrixStoreHire
} from './store-schedules'
import { MatrixSubscriptionAuthLifecycle } from './subscription-auth-lifecycle'
import {
  atumChatGptModelVisible,
  listMatrixSubscriptionCatalog,
  matrixSubscriptionCatalogWithGrant
} from './subscriptions'
import { MatrixTerminals } from './terminals'
import { MatrixTextDocument } from './text-document'
import { currentIanaTimeZone } from './time-zone'
import { MATRIX_TURN_STOPPED } from './turn-failure'
import { MatrixHermesTurnLock } from './turn-lock'
import { matrixRoomLogHash, MatrixUndecryptableLog } from './undecryptable-log'
import { MatrixUnverifiedDevices } from './unverified-devices'
import { parseMatrixVoiceRequest } from './voice'
import { bindMatrixVoice, matrixVoiceFramePermission, type MatrixVoiceSource } from './voice-binding'
import { MatrixWalletController, matrixWalletCursor } from './wallet'
import { installMatrixWindow, matrixWindowOptions } from './window'
import { matrixEndedSession, matrixHumanSnapshot, matrixSavedIdentity, matrixWindowChoice } from './window-launch'
import { MatrixWindowedLog } from './windowed-log'
import { MatrixWordDocument } from './word-document'
import { MatrixWebPreviewOffers } from './workbench-preview'
import { readMatrixWorkspaceDriveRoots } from './workspace-root-facts'
import { MatrixWorkspaceStartup } from './workspace-startup'

// A shipped build takes only its own switches (app-menu.ts `matrixRemoteControlSwitches`): never
// another program's remote control (remote debugging, the Node inspector) or another program in
// place of its own child processes. Refused before anything of the person's opens, on every
// launch, not only on an update's relaunch (update-relaunch.ts drops some there too).
const remoteControl = app.isPackaged
  ? matrixRemoteControlSwitches(process.argv.slice(1), name => app.commandLine.hasSwitch(name))
  : []

if (remoteControl.length) {
  console.error(`matrix_remote_control_refused switches=${remoteControl.join(',')}`)
  app.exit(1)
  process.exit(1)
}

const assets = path.dirname(fileURLToPath(import.meta.url))
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

// Settings › General › Legal › Open-source licences: the notice packaged in Resources/licenses
// (scripts/third-party-notices.mjs). A development run names a folder with --matrix-licenses=.
const openSourceNotices = createMatrixOpenSourceNotices({
  directory: app.isPackaged ? path.join(process.resourcesPath, MATRIX_NOTICES_DIRECTORY) : option('matrix-licenses'),
  create: options => new BrowserWindow(options)
})

const profile = option('matrix-profile') ?? 'candidate'

if (!/^[a-z0-9-]{1,48}$/.test(profile)) {
  throw new Error('matrix_profile_invalid')
}

const config = (() => {
  try {
    // A packaged app carries the production configuration in its Resources: a fresh
    // install opens with it, and an operator file in Application Support still wins.
    return readMatrixLaunchConfig(
      app.getPath('appData'),
      option('matrix-config'),
      app.isPackaged ? path.join(process.resourcesPath, MATRIX_BUNDLED_CONFIG_NAME) : undefined
    )
  } catch (error) {
    console.error(
      error instanceof Error && error.message === 'matrix_public_configuration_missing'
        ? 'matrix_public_configuration_missing'
        : 'matrix_public_configuration_invalid'
    )
    const copy = matrixLaunchConfigurationErrorCopy()
    dialog.showErrorBox(copy.title, copy.message)
    app.exit(1)

    return undefined
  }
})()

if (!config) {
  process.exit(1)
}

// People see "Atum"; the app keeps running under its identity name, so the Keychain key,
// data and logs of installed copies stay where they are (app-identity.ts).
applyMatrixAppIdentity(app, { profile, configurationKey: matrixConfigurationKey(config) })
// Developer tools stay in development builds only (FR31): no menu item or shortcut opens
// them in a shipped build, and any window, view or guest that tries closes them again.
app.on('web-contents-created', (_event, contents) => closeMatrixDevToolsInShippedBuild(app.isPackaged, contents))
protocol.registerSchemesAsPrivileged([
  { scheme: 'atum-matrix', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'atum-look', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
const UI_URL = 'atum-matrix://ui/matrix.html'
const SDK_URL = 'atum-matrix://sdk/matrix-sdk.html'
const lookAssets = config.domain
  ? new MatrixLookAssets(
      config.domain.resource,
      new LookAssetDiskCache(path.join(app.getPath('userData'), 'look-assets'))
    )
  : undefined
let ui: BrowserWindow | undefined
let microphoneConsent: (() => boolean) | undefined
const messageLinks = new MatrixMessageLinkBroker()
const inviteLinks = new MatrixInviteLinkBroker()

function publishMatrixMessageLink(target: MatrixMessageLinkTarget): void {
  if (ui && !ui.isDestroyed()) {
    ui.webContents.send(MATRIX_MESSAGE_LINK_IPC.opened, target)
    if (ui.isMinimized()) {ui.restore()}
    ui.show()
    ui.focus()
  }
}

/** Consume only `atum://message`; malformed attempts are dropped without payload logging. */
function deliverMatrixMessageLink(value: unknown): boolean {
  const outcome = messageLinks.deliver(value, publishMatrixMessageLink)
  if (outcome !== 'not_message_link') {
    console.warn(`[Matrix] message link ${outcome}`)
  }

  return outcome !== 'not_message_link'
}

function publishMatrixInviteLink(token: string): void {
  if (ui && !ui.isDestroyed()) {
    ui.webContents.send(MATRIX_INVITE_LINK_IPC.opened, token)
    if (ui.isMinimized()) {ui.restore()}
    ui.show()
    ui.focus()
  }
}

/** Consume only `atum://join`; the static outcome log never contains the bearer token or URL. */
function deliverMatrixInviteLink(value: unknown): boolean {
  const outcome = inviteLinks.deliver(value, publishMatrixInviteLink)
  if (outcome !== 'not_invite_link') {
    console.warn(`[Matrix] invite link ${outcome}`)
  }

  return outcome !== 'not_invite_link'
}

function matrixMessageLinkArg(argv: readonly string[]): string | undefined {
  return argv.find(value => isMatrixMessageLinkCandidate(value))
}

function registerMatrixMessageLinkProtocol(): void {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('atum', process.execPath, [path.resolve(process.argv[1]!)])
    } else {
      app.setAsDefaultProtocolClient('atum')
    }
  } catch {
    console.warn('[Matrix] message link protocol registration failed')
  }
}

registerMatrixMessageLinkProtocol()
const coldMessageLink = matrixMessageLinkArg(process.argv)
if (coldMessageLink) {deliverMatrixMessageLink(coldMessageLink)}
const coldInviteLink = process.argv.find(value => isMatrixInviteDeepLinkCandidate(value))
if (coldInviteLink) {deliverMatrixInviteLink(coldInviteLink)}
// macOS can deliver before `whenReady`; the broker retains the validated target for the renderer.
app.on('open-url', (event, url) => {
  if (isMatrixMessageLinkCandidate(url) || isMatrixInviteDeepLinkCandidate(url)) {
    event.preventDefault()
    if (!deliverMatrixMessageLink(url)) {deliverMatrixInviteLink(url)}
  }
})

const matrixConsumerBrowser = createConsumerBrowserController({
  app,
  // Matrix has two renderer windows. The SDK is deliberately not a browser
  // host, even if it can obtain an IPC channel name.
  browserWindowFromWebContents: contents => (contents === ui?.webContents ? ui : null),
  ipcMain,
  knownAppIds: [],
  // Matrix's consumer tabs are ephemeral and never inherit an app/account
  // partition or the legacy app-partition cleanup capability.
  consumerOnly: true,
  sessionFromPartition: partition => session.fromPartition(partition),
  // A browser tab's download asks where to save (FR27), starting in Downloads.
  downloads: {
    directory: () => app.getPath('downloads'),
    finished: file => {
      if (process.platform === 'darwin') {
        app.dock?.downloadFinished(file)
      }
    }
  }
})

type Host = {
  deviceIsolation: MatrixDeviceIsolation
  window: BrowserWindow
  queue: MatrixSdkHost
  identity: MatrixIdentity
  profile?: MatrixProfileMetadata
  expiry?: ReturnType<typeof setTimeout>
  /** Ends the host when its credential expires: the backstop when no renewal landed. */
  expire?: () => void
  /** The credential's expiry the host's end is armed for (armHostExpiry). */
  expiresAt?: number
  ready?: boolean
  /** Ready, but its sync is reconnecting or failing within its grace (host-health.ts): what it
   * carries goes on, and it takes no new claim until the sync is back. Any host, the person's too. */
  degraded?: boolean
  /** An agent host's: renews its executor credential ahead of expiry (credential-renewal.ts). */
  renewal?: MatrixCredentialRenewal
  /** An agent host's refresh handle: its SDK asks main for the renewed token with it. */
  refreshHandle?: string
  /** A digest of the token this agent host holds (matrixAgentSdkRefresh). */
  holds?: string
  /** The renewal in flight, which a refresh of the old token waits for. */
  renewing?: Promise<void>
}
const hosts = new Map<MatrixHostRole, Host>()
const trustedAgents = new WeakMap<Host, Host>()
/** Main's own handshakes with agents, kept out of the window (background-verification.ts). */
const backgroundVerifications = new MatrixBackgroundVerifications(line => console.warn(line))
/** The launch's one log line in place of anything on screen (background-verification.ts). */
const launchSummary = new MatrixLaunchSummary(line => console.warn(line))
let securityWork: Promise<unknown> = Promise.resolve()
let securityPending = 0
let isolationPolicy: MatrixDeviceIsolationPolicy | undefined

function serializeSecurity<T>(work: () => Promise<T>): Promise<T> {
  securityPending++

  const next = securityWork.then(work, work).finally(() => {
    securityPending--

    if (isolationPolicy) {
      publish(state)
    }
  })

  securityWork = next.catch(() => {})

  return next
}

/** The person's recovery key on this Mac (owner-keys.ts): kept for the person, not for one
 * sign-in, so signing in again unlocks by itself. Opened with the account. */
let ownerKeys: MatrixOwnerKeys | undefined
/** The keys this Mac's own devices had when last ready (device-ledger.ts). */
let deviceLedger: MatrixDeviceLedger | undefined
/** The person's device on this Mac whose keys changed under its ID: only a new sign-in mends
 * it (`deviceDamaged` in the snapshot). */
let ownDeviceDamaged: string | undefined
/** This Mac's disk filling up (disk-health.ts), for the window's notice. */
let diskHealth: MatrixDiskHealth | undefined
/** This Mac's device-trust bookkeeping (device-trust.json): replacements, the device ledger, and
 * whether the key is kept in iCloud Keychain. */
let deviceTrustStore: EncryptedStore | undefined
/** The recovery key's copy in iCloud Keychain (icloud-keychain.ts), in a build that has the
 * Atum Keys helper; `icloudAvailable` once its probe answered. */
let icloudKeychain: MatrixICloudKeychain | undefined
let icloudAvailable: boolean | undefined
/** The key last copied to iCloud this launch (a digest), so it is written once. */
let icloudMirrored: string | undefined

/** Whether the person turned iCloud Keychain off (Settings), read from the vault once: publish
 * runs on every sync and must not decrypt each time. */
let icloudPreference: 'on' | 'off' | undefined

/** iCloud Keychain is on unless the person turned it off (Settings), and the helper works. */
function icloudOn(): boolean {
  if (icloudPreference === undefined) {
    try {
      icloudPreference = deviceTrustStore?.getItem('icloud-keychain') === 'off' ? 'off' : 'on'
    } catch {
      icloudPreference = 'on'
    }
  }

  return icloudAvailable === true && icloudPreference !== 'off'
}

/** Copies the key kept for the person to iCloud Keychain, once per key and launch. Never a key
 * another device sent after an approval (owner-keys.ts `matrixOwnerKeyMirrors`): every Mac on the
 * Apple ID that keeps no key would adopt it without a tap. */
function mirrorOwnerKeyToICloud(identity: MatrixIdentity) {
  if (!icloudOn() || !icloudKeychain) {
    return
  }

  const kept = keptOwnerKey(identity)

  if (!kept || !matrixOwnerKeyMirrors(kept)) {
    return
  }

  const digest = createHash('sha256')
    .update(`${identity.userId}\n${kept.key}\n${kept.keyId ?? ''}`)
    .digest('hex')

  if (icloudMirrored === digest) {
    return
  }

  icloudMirrored = digest
  void icloudKeychain.write(identity.userId, kept.key, kept.keyId).then(ok => {
    if (!ok && icloudMirrored === digest) {
      icloudMirrored = undefined
    }
  })
}

/** Compares the person's device key with the last one seen here (device-ledger.ts). */
function observeOwnDevice(identity: MatrixIdentity, ownKey: unknown) {
  if (!deviceLedger || typeof ownKey !== 'string') {
    return
  }

  if (
    deviceLedger.observe(identity, ownKey) === 'replaced' &&
    ownDeviceDamaged !== `${identity.userId}\n${identity.deviceId}`
  ) {
    ownDeviceDamaged = `${identity.userId}\n${identity.deviceId}`
    console.warn('[Matrix] this Mac’s own device keys changed under its ID: a new sign-in mends it')
    publish(state)
  }
}

/** Whose key: the account's sign-in server and subject, and its Matrix user. */
function ownerBinding(identity: MatrixIdentity | null | undefined): MatrixOwnerBinding | undefined {
  const owner = identity && account ? account.driveOwner() : null

  return owner && identity ? { issuer: owner.issuer, subject: owner.subject, userId: identity.userId } : undefined
}

/** The account record's copy of 0.18.1 and earlier, for this account device. */
function ownerKeyLegacy(identity: MatrixIdentity): MatrixOwnerKeyLegacy {
  return {
    read: () => {
      const key = account.recoveryKey(identity)

      return key ? { key, ...(account.recoveryCustody(identity) ? { custody: 'device' as const } : {}) } : undefined
    },
    write: (key, custody) => void account.recoveryKey(identity, key, custody),
    written: () => account.recoveryWritten(identity),
    forget: () => account.forgetRecoveryKey(identity)
  }
}

/** The key this Mac keeps for the person signed in as `identity`, if any. Main-only. */
function keptOwnerKey(identity: MatrixIdentity | null | undefined): MatrixOwnerKey | undefined {
  const binding = ownerBinding(identity)

  return binding && ownerKeys && identity ? keptMatrixOwnerKey(ownerKeys, binding, ownerKeyLegacy(identity)) : undefined
}

/** Keeps a key for the person (and, for one release, in the account record too). Only a typed key
 * replaces a kept key: owner-keys.ts enforces it for every path here (`matrix_recovery_kept`). */
function retainOwnerKey(identity: MatrixIdentity, key: string, options: MatrixOwnerKeyRetain): MatrixOwnerKey {
  const binding = ownerBinding(identity)

  if (!binding || !ownerKeys) {
    throw new Error('matrix_recovery_stale')
  }

  const kept = retainMatrixOwnerKey(ownerKeys, binding, ownerKeyLegacy(identity), key, options)
  setOwnerRecoveryCustody(identity, kept)

  if (options.source !== 'icloud') {
    mirrorOwnerKeyToICloud(identity)
  }

  return kept
}

/** What the person's window may know of the kept key (never the key): whether this Mac keeps
 * one, and whether it was made quietly and not written down. Read from the vault once per
 * account device and change: publish runs on every sync and must not decrypt each time. */
let recoveryCustody: { owner: string; kept: boolean; custody?: 'device' } | undefined

function ownerRecoveryCustody(identity: MatrixIdentity | null | undefined): { kept: boolean; custody?: 'device' } {
  if (!identity || !account) {
    return { kept: false }
  }

  const owner = `${identity.userId}\n${identity.deviceId}`

  if (recoveryCustody?.owner !== owner) {
    let kept: MatrixOwnerKey | undefined

    try {
      kept = keptOwnerKey(identity)
    } catch {
      kept = undefined
    }

    recoveryCustody = { owner, kept: Boolean(kept), ...(kept?.custody ? { custody: kept.custody } : {}) }
  }

  return { kept: recoveryCustody.kept, ...(recoveryCustody.custody ? { custody: recoveryCustody.custody } : {}) }
}

function setOwnerRecoveryCustody(identity: MatrixIdentity, kept?: MatrixOwnerKey) {
  recoveryCustody = {
    owner: `${identity.userId}\n${identity.deviceId}`,
    kept: Boolean(kept),
    ...(kept?.custody ? { custody: kept.custody } : {})
  }
}

/** The SDK's security facts plus this Mac's custody marks (display only, never the key). */
function securityView(
  security: MatrixSecurity | undefined,
  identity: MatrixIdentity | null
): MatrixSecurity | undefined {
  if (!security) {
    return security
  }

  const {
    custody: _previous,
    kept: _kept,
    keyStale: _stale,
    unverifiedDevices: _unverified,
    verification: shown,
    ...rest
  } = security

  // Main's own check of an agent never shows; the person's verifications always do.
  const verification = backgroundVerifications.view(shown)
  const facts = verification ? { ...rest, verification } : rest
  const custody = ownerRecoveryCustody(identity)

  const approval = identity ? deviceApproval.view() : undefined
  const icloud = identity && icloudAvailable === true ? (icloudOn() ? ('on' as const) : ('off' as const)) : undefined
  const humanHost = hosts.get('human')

  // The kept key no longer opens the account's recovery: the key form says it was changed elsewhere.
  const keyStale =
    identity &&
    humanHost?.identity.userId === identity.userId &&
    humanHost.identity.deviceId === identity.deviceId &&
    ownerUnlock?.host === humanHost &&
    ownerUnlock.result.state === 'needs_key' &&
    ownerUnlock.result.reason === 'stale'

  // The person's own unverified devices are no longer listed for a reminder (0.20: plain chats,
  // nobody refuses a device there); `unverifiedDevices` keeps them only for an assistant's
  // refusal in an encrypted room made before, which starts the comparison itself.
  return {
    ...facts,
    ...(icloud ? { icloud } : {}),
    ...(custody.kept ? { kept: true as const } : {}),
    ...(custody.custody ? { custody: custody.custody } : {}),
    ...(keyStale ? { keyStale: true as const } : {}),
    ...(approval ? { approval } : {})
  }
}

/** The last silent unlock of the person's device (owner-unlock.ts), per human host: agents'
 * trust steps reuse an `unlocked` answer instead of asking the SDK again, until the identity this
 * device verified is replaced while Atum runs (`identity`: the SDK's count of those it saw). */
let ownerDeviceRepair: MatrixOwnerDeviceRepair | undefined
let deviceControlOwner: MatrixIdentity | undefined
let deviceControlScope: string | undefined
let deviceControlLastAttempt = 0
let deviceControlReadyFlight: Promise<void> | undefined
let deviceControlFlightScope: string | undefined
const DEVICE_CONTROL_RETRY_MS = 15_000
const DEVICE_CONTROL_VERIFY_MS = 5 * 60_000

function ownerRepairPreservesWork(): boolean {
  return matrixOwnerRepairPreservesWork(ownerDeviceRepair, state, closing)
}

/** Sign-in, account switches and the retry cadence all meet here. One account-scoped flight checks
 * server truth and silently enrolls or repairs this Mac; failure stays a reconnecting status. */
function reconcileDeviceControl(force = false): Promise<void> {
  const identity = state.identity

  if (!identity || closing || ownerRepairPreservesWork() || !deviceIdentity) { return Promise.resolve() }
  const scope = `${identity.userId}\n${identity.deviceId}`
  const now = Date.now()

  if (deviceControlReadyFlight) {
    return deviceControlFlightScope === scope
      ? deviceControlReadyFlight
      : deviceControlReadyFlight.then(() => reconcileDeviceControl(true))
  }
  const interval = deviceControlOwner ? DEVICE_CONTROL_RETRY_MS : DEVICE_CONTROL_VERIFY_MS
  if (!force && deviceControlScope === scope && now - deviceControlLastAttempt < interval) {
    return Promise.resolve()
  }

  deviceControlScope = scope
  deviceControlLastAttempt = now
  deviceControlFlightScope = scope
  deviceControlOwner = identity
  publish(state)

  deviceControlReadyFlight = deviceIdentity
    .activate()
    .then(presence => {
      if (closing || state.identity?.userId !== identity.userId || state.identity?.deviceId !== identity.deviceId) {
        return
      }

      deviceControlOwner = presence.state === 'enrolled' ? undefined : identity
      if (presence.state === 'enrolled') {
        executionDeviceNames.invalidate()
        executionPolicies?.refreshAll()
        scheduleExecutionPolicyReconcile()
        scheduleContinuousListening()
      }
      publish(state)
    })
    .catch(() => {
      if (!closing && state.identity?.userId === identity.userId && state.identity?.deviceId === identity.deviceId) {
        deviceControlOwner = identity
        publish(state)
      }
      console.warn('[Device] device service reconnect pending')
    })
    .finally(() => {
      deviceControlReadyFlight = undefined
      deviceControlFlightScope = undefined
    })

  return deviceControlReadyFlight
}

function resetDeviceControlReadyChecks(): void {
  deviceControlScope = undefined
  deviceControlLastAttempt = 0
  deviceControlReadyFlight = undefined
  deviceControlFlightScope = undefined
}

function ownerRepairController(): MatrixOwnerDeviceRepair {
  return ownerDeviceRepair ??= new MatrixOwnerDeviceRepair({
    account,
    damaged: owner => ownDeviceDamaged === `${owner.userId}\n${owner.deviceId}`,
    changed: () => publish(state),
    log: line => console.warn(line),
    resume: async replaced => {
      const current = account.identity()

      if (!current || current.userId !== replaced.userId || current.deviceId === replaced.deviceId || closing) {
        throw new Error('matrix_owner_repair_stale')
      }

      const previous = hosts.get('human')

      if (previous && (previous.identity.userId !== current.userId || previous.identity.deviceId !== current.deviceId ||
          !matrixHumanSdkReady(state.state, previous))) {
        // Host-only disposal: stopHost also clears native apps and aborts agent turns.
        sdkRendererRecovery.cancel('human')
        clearTimeout(previous.expiry)
        previous.renewal?.stop()
        await previous.queue.stop()

        if (hosts.get('human') === previous) { hosts.delete('human') }
        humanPrepared = false
        resetDeviceControlReadyChecks()
        ownerUnlock = undefined
        ownerUnlockRetryAt = 0
        sessionRestartedAt = undefined
      }

      if (!hosts.has('human')) { await startHost('human', { preserveRuntime: true }) }
      const host = hosts.get('human')

      if (!host || host.identity.userId !== current.userId || host.identity.deviceId !== current.deviceId) {
        throw new Error('matrix_owner_repair_stale')
      }

      const ready = await waitUntil(
        () => !closing && hosts.get('human') === host && state.state === 'ready' &&
          state.identity?.userId === current.userId && state.identity?.deviceId === current.deviceId,
        30_000,
        AbortSignal.timeout(31_000)
      )

      if (!ready) { throw new Error('matrix_not_ready') }
      const unlocked = await unlockOwner('owner_repair')

      if (unlocked?.state !== 'unlocked' || !unlocked.signed || !unlocked.backup) {
        throw new Error('matrix_owner_repair_restore_pending')
      }

      if (hosts.get('human') !== host || account.identity()?.deviceId !== current.deviceId ||
          account.identity()?.userId !== current.userId || closing) {
        throw new Error('matrix_owner_repair_stale')
      }

      ownDeviceDamaged = undefined
      await clearDevice(replaced).catch(() => console.warn('[Matrix] repaired owner old-device cleanup pending'))
      deviceLedger?.forget(replaced)
      scheduleContinuousListening()

      // Trust existing ready agents; never provision/re-enroll one as part of repair.
      for (const each of allAgents()) {
        if (hosts.get(each.role)?.ready) {
          backgroundAgentTrust(() => ensureAgentTrust(each), 'readiness', line => console.warn(line))
        }
      }

      return { signed: unlocked.signed, backup: unlocked.backup }
    }
  })
}

let ownerUnlock: { host: Host; result: MatrixOwnerUnlock; identity: number } | undefined
let ownerUnlockRunning: Promise<MatrixOwnerUnlock | undefined> | undefined
/** After a failed unlock (offline), the next sync-triggered one waits this long. */
let ownerUnlockRetryAt = 0
/** The human host this Mac already asked the person's other devices for (device-approval.ts). */
let approvalAsked: Host | undefined
/** The human host whose device was given its name (device-name.ts), once per sign-in. */
let deviceNamed: Host | undefined
/** This Mac's model, read once when first needed (device-name.ts). */
let macModel: Promise<string | undefined> | undefined

/** One silent unlock, inside serializeSecurity (never nested in another one). */
async function unlockOwnerNow(humanHost: Host, assertCurrent: () => void): Promise<MatrixOwnerUnlock> {
  // The identity this device verified was replaced since the last unlock (reset from another
  // device or sign-in): checked again, so a kept key gone stale shows now, not at the next launch.
  const identityChanges = ownerIdentityChanges(humanHost)

  const previous =
    ownerUnlock?.host === humanHost && ownerUnlock.identity === identityChanges ? ownerUnlock.result : undefined

  if (previous?.state === 'unlocked') {
    return previous
  }

  const identity = humanHost.identity

  const result = await unlockMatrixOwner({
    status: async () => {
      const status = (await humanHost.queue.command({ kind: 'ownerStatus' }, 60_000)) as MatrixOwnerStatus
      observeOwnDevice(identity, status?.ownKey)

      return status
    },
    kept: () => keptOwnerKey(identity),
    check: key => humanHost.queue.command({ kind: 'recoveryCheck', key }, 60_000) as Promise<MatrixRecoveryCheck>,
    icloud: async () => (icloudOn() && icloudKeychain ? (await icloudKeychain.read(identity.userId))?.key : undefined),
    restore: key => humanHost.queue.command({ kind: 'ownerRestore', key }, 120_000) as Promise<MatrixOwnerRestore>,
    retain: (key, options) => {
      const binding = ownerBinding(identity)

      if (!binding || !ownerKeys) {
        return
      }

      if (options.source === 'icloud') {
        retainOwnerKey(identity, key, options)
      } else if (options.keyId) {
        ownerKeys.noteKeyId(binding, options.keyId)
      }
    },
    assertCurrent: () => {
      assertCurrent()

      if (closing || hosts.get('human') !== humanHost || !account.identity()) {
        throw new Error('matrix_recovery_stale')
      }
    },
    log: line => console.warn(line)
  })

  ownerUnlock = { host: humanHost, result, identity: identityChanges }

  // The key went stale (kept here, or iCloud Keychain's copy), maybe while an approval was running
  // (the iCloud poll on a new Mac): only a typed key unlocks this Mac now. Its request is cancelled
  // before "I picked them" can confirm whichever device answered, and its waiting marker goes.
  if (result.state === 'needs_key' && !matrixMayAskOtherDevices(result)) {
    deviceApproval.stale(state.security)
  }

  // No key on this Mac: ask the person's other devices, once per sign-in (device-approval.ts),
  // and look in iCloud Keychain again while its copy may still be syncing (two minutes). A key
  // gone stale (kept here, or iCloud's copy) was changed elsewhere (Atum never replaces a
  // recovery): no device is asked and iCloud is not polled, since either could only let this Mac
  // into whatever the server serves now; the person types their key (only a typed key replaces a
  // kept key).
  if (result.state === 'needs_key' && approvalAsked !== humanHost) {
    approvalAsked = humanHost

    if (matrixMayAskOtherDevices(result)) {
      setImmediate(() => askOtherDevices(humanHost))

      if (icloudOn()) {
        pollICloudForKey(humanHost)
      }
    }
  }

  if (result.state === 'unlocked') {
    mirrorOwnerKeyToICloud(identity)
    // However the key came, this Mac no longer waits: its marker goes.
    deviceApproval.unlocked(state.security)
  }

  if (result.state === 'unlocked') {
    // Unlocked now (restored here, or already complete with a key that just arrived): every
    // assistant held on this Mac's key starts again now (the gate's own check reuses this
    // answer); the history restores in the background.
    setImmediate(() => {
      for (const each of allAgents()) {
        if (each.readiness?.current.code === 'recovery_required') {
          each.readiness.start()
        }
      }
    })
  }

  publish(state)

  return result
}

/**
 * Asks the person's other devices to approve this Mac (device-approval.ts), and once more 30 s
 * later when none could be asked yet, while this Mac still has no key: otherwise the person would
 * see only the key form.
 */
function askOtherDevices(humanHost: Host) {
  void deviceApproval.requestSoon(
    () =>
      !closing &&
      hosts.get('human') === humanHost &&
      ownerUnlock?.host === humanHost &&
      matrixMayAskOtherDevices(ownerUnlock.result)
  )
}

/** A new Mac on the same Apple ID: iCloud Keychain's copy can take a minute or two to arrive.
 * Looks every 10 s for two minutes, while this device never had a key (a stale one stops it). */
function pollICloudForKey(humanHost: Host, attempt = 0) {
  if (attempt >= 12) {
    return
  }

  setTimeout(() => {
    if (
      closing ||
      hosts.get('human') !== humanHost ||
      ownerUnlock?.host !== humanHost ||
      !matrixMayAskOtherDevices(ownerUnlock.result)
    ) {
      return
    }

    void unlockOwner('icloud').then(result => {
      if (matrixMayAskOtherDevices(result)) {
        pollICloudForKey(humanHost, attempt + 1)
      }
    })
  }, 10_000).unref?.()
}

/** How many times the person's SDK saw the identity it verified replaced (security.ts), for
 * `ownerUnlock`. */
function ownerIdentityChanges(humanHost: Host): number {
  return (hosts.get('human') === humanHost ? state.security?.identityChanges : undefined) ?? 0
}

/** The silent unlock after the person's first sync, or when a key arrives: one at a time. */
function unlockOwner(reason: string): Promise<MatrixOwnerUnlock | undefined> {
  const humanHost = hosts.get('human')

  if (!humanHost || closing) {
    return Promise.resolve(undefined)
  }

  if (ownerUnlockRunning) {
    return ownerUnlockRunning
  }

  const running = serializeSecurity(() => unlockOwnerNow(humanHost, () => {}))
    .catch(error => {
      const code = error instanceof Error && /^matrix_[a-z0-9_]+$/.test(error.message) ? error.message : 'unexpected'
      console.warn(`[Matrix] owner unlock reason=${reason} ok=false code=${code}`)
      ownerUnlockRetryAt = Date.now() + 30_000

      return undefined
    })
    .finally(() => {
      if (ownerUnlockRunning === running) {
        ownerUnlockRunning = undefined
      }
    })

  ownerUnlockRunning = running

  return running
}

/** The window's language, for a native notification (the person's choice, else the system's). */
function windowLocale(): DesktopLocale {
  const chosen = state.displayPreferences?.language?.value

  return isDesktopLocale(chosen)
    ? chosen
    : (desktopLocaleFor(app.getPreferredSystemLanguages()) ?? DEFAULT_DESKTOP_LOCALE)
}

/** The person's own unverified devices (unverified-devices.ts): an assistant's refusal of one in an
 * encrypted room made before 0.20 starts Matrix's comparison with it. Nothing is shown for them. */
const unverifiedDevices = new MatrixUnverifiedDevices<Host>({
  read: host => host.queue.command({ kind: 'ownDevices' }, 30_000) as Promise<MatrixOwnDevices | null>,
  changed: () => observeNewSignIn(),
  verify: (host, deviceId) =>
    host.queue.command({ kind: 'verificationStart', userId: host.identity.userId, deviceId }, 30_000) as Promise<void>
})

/** One-tap approval between the person's devices (device-approval.ts). */
const deviceApproval = new MatrixDeviceApproval({
  me: () => (humanPrepared ? hosts.get('human')?.identity : undefined),
  command: (value, timeoutMs) => {
    const humanHost = hosts.get('human')

    return humanHost ? humanHost.queue.command(value, timeoutMs) : Promise.reject(new Error('matrix_not_ready'))
  },
  grantable: () => {
    const humanHost = hosts.get('human')

    if (!humanHost || ownerUnlock?.host !== humanHost || ownerUnlock.result.state !== 'unlocked') {
      return undefined
    }

    const kept = keptOwnerKey(humanHost.identity)

    return kept?.keyId && kept.key === ownerUnlock.result.key ? { key: kept.key, keyId: kept.keyId } : undefined
  },
  // Only a Mac that never had a key: one whose key went stale takes only a typed key, so no
  // comparison may let another device in (and "I picked them" is refused: `confirmPicked`).
  needsKey: () => ownerUnlock?.host === hosts.get('human') && matrixMayAskOtherDevices(ownerUnlock?.result),
  received: async (key, keyId) => {
    const humanHost = hosts.get('human')

    if (!humanHost) {
      return false
    }

    // In the security queue: never beside another recovery step of this SDK.
    const check = (await serializeSecurity(() =>
      humanHost.queue.command({ kind: 'recoveryCheck', key }, 60_000)
    )) as MatrixRecoveryCheck | null

    if (!check?.valid || check.keyId !== keyId || hosts.get('human') !== humanHost) {
      return false
    }

    // Only a typed key replaces a kept key. An approval never replaces one this Mac keeps, even
    // one gone stale, nor lands on a Mac whose iCloud Keychain copy went stale: a stale key means
    // the recovery was changed elsewhere, and a key that opens the new one says nothing about who
    // changed it. (owner-keys.ts refuses it again when keeping.)
    if (
      ownerUnlock?.host === humanHost &&
      ownerUnlock.result.state === 'needs_key' &&
      ownerUnlock.result.reason === 'stale'
    ) {
      console.warn('[Matrix] approval: a key arrived, but this Mac’s key went stale; only a typed key replaces it')

      return false
    }

    let kept: MatrixOwnerKey | undefined

    try {
      kept = keptOwnerKey(humanHost.identity)
    } catch {
      return false
    }

    const retention = matrixOwnerKeyRetention(kept, key, { source: 'approved' })

    if (retention === 'refuse') {
      console.warn('[Matrix] approval: a key arrived, but this Mac keeps another; only a typed key replaces it')

      return false
    }

    // The same key may already be here (iCloud Keychain's copy arrived first): nothing to keep.
    if (retention === 'keep') {
      retainOwnerKey(humanHost.identity, key, { source: 'approved', keyId })
    }

    ownerKeyChanged()
    // An unlock already running began before this key was kept: let it finish, then unlock.
    await ownerUnlockRunning?.catch(() => undefined)
    const unlocked = await unlockOwner('approved')

    return unlocked?.state === 'unlocked'
  },
  notify: deviceName => {
    if (!Notification.isSupported()) {
      return
    }

    const copy = matrixApprovalCopy(windowLocale())

    const notice = new Notification({
      title: copy.notifyTitle,
      body: deviceName ? `${deviceName} · ${copy.notifyBody}` : copy.notifyBody
    })

    notice.on('click', () => {
      ui?.show()
      ui?.focus()
    })
    notice.show()
  },
  changed: () => publish(state),
  log: line => console.warn(line),
  // Wrong rows, refusals and the hourly prompt budget outlive a restart (device-trust.json).
  ledger: {
    read: () => deviceTrustStore?.getItem('device-approval') ?? null,
    write: value => deviceTrustStore?.setItem('device-approval', value)
  }
})

/** The device "This wasn't me" (or a wrong row) was about, for its sign-out (never sent to the
 * window). */
let declinedDevice: string | undefined

/** The new sign-in banner's ledger (device-trust.json): baselines and dismissals per account
 * sign-in, so a dismissed device never raises again after a restart (G13). */
const newSignInLedger = new MatrixNewSignInLedger({
  read: () => deviceTrustStore?.getItem('new-sign-in') ?? null,
  write: value => deviceTrustStore?.setItem('new-sign-in', value)
})

/** The sign-in on another device the window shows, and the account sign-in it belongs to. */
let newSignIn: MatrixNewSignIn | undefined
let newSignInFor: string | undefined

/** A key arrived (typed, approved, from iCloud): the next unlock looks again. */
function ownerKeyChanged() {
  ownerUnlock = undefined
  ownerUnlockRetryAt = 0
}

let account: MatrixAccount
/** The root encrypted credential file; subscription keys take an account-scoped view of it. */
let credentialStore: EncryptedStore | undefined
let drive: MatrixDrive | undefined
let driveImport: MatrixDriveImport | undefined
let localBrain: MatrixLocalBrain | undefined
// WS-4 device-service stop fence. The device-service bootstrap (A-2) assigns this to the real
// DeviceStopFence.fence; until then it is a no-op. It MUST be callable synchronously as the first
// statement of sign-out/account-switch/sleep so a racing device Execute is refused before any await,
// and it is never gated by `matrix_operation_pending`.
let matrixDeviceStopFence: ((reason: 'local_stop' | 'sign_out' | 'account_switch' | 'sleep') => void) | null = null

/** The device-service bootstrap (A-2) calls this once it has built the DeviceStopFence, so the
 * sign-out/suspend/quit paths can fence the device synchronously. A no-op until then. */
export function registerMatrixDeviceStopFence(
  fence: ((reason: 'local_stop' | 'sign_out' | 'account_switch' | 'sleep') => void) | null
): void {
  matrixDeviceStopFence = fence
}

let googleFenceNotices: MatrixGoogleFenceNotices | undefined
/** One line per distinct fence failure per 10 minutes (google-fence.ts). */
const googleFenceLog = new MatrixGoogleFenceLog(line => console.warn(line))
/** One line per host kind, room and reason a message could not be decrypted, per 10 minutes. */
const undecryptableLog = new MatrixUndecryptableLog(line => console.warn(line))
/** The chat companion's restarts and what she is doing, already rate-limited by the window. */
const petDiagnosticLog = new MatrixPetDiagnosticLog(line => console.warn(line))
/** One line per assistant when what the window offers for it changes (Q4, agent-actions-log.ts). */
const agentActionsLog = new MatrixAgentActionsLog(line => console.warn(line))
/** A controller invite and its already-joined main can repeat on every sync; retain only a closed,
 * payload-free diagnostic and coalesce repeats. */
const assistantInviteCoexistenceLog = new MatrixWindowedLog(line => console.warn(line))
let hiddenAssistantSelectionMove: string | undefined
let googleConnections: MatrixGoogleConnections | undefined
/** The default assistant's local Google broker (google-tools.ts), governed by main-google.ts. */
let googleTools: MatrixGoogleTools | undefined
/** What the default assistant's running Hermes was launched with; compared with what the
 * Google policy wants now, to restart it when idle (google-tools only at launch: prompt caching). */
const googleLaunched = new Map<string, { tools: boolean; fence: boolean }>()

const googleAssistant = new MatrixGoogleAssistant({
  store: () => outcomeStore,
  agentPrincipal: () => {
    try {
      return enrollmentOf(defaultAgent).identity?.agentPrincipal ?? defaultAgent.agentPrincipal
    } catch {
      return defaultAgent.agentPrincipal
    }
  },
  executorId: () => {
    try {
      return enrollmentOf(defaultAgent).identity?.executorId
    } catch {
      return undefined
    }
  },
  ownModel: () => Boolean(defaultAgent.ownModel),
  connections: () => googleConnections,
  sourceEnabled: () => macSourceGateEnabled(macSourcesConsentStore().read(), 'google'),
  servesProtected: signal => managedModel?.servesModel(MATRIX_GOOGLE_PROTECTED_MODEL, signal) ?? Promise.resolve(null),
  proxyBaseUrl: () => managedModel?.baseUrl,
  tools: () => googleTools,
  // Public-launch decision 2026-10-25: on unless configuration says `googleFullPower: false`.
  fullPower: () => matrixGoogleFullPower(config)
})

let brainActive = false
let brainOwner: string | null | undefined

function googleConnectionOwner(): MatrixGoogleConnectionOwner | null {
  if (closing || !account || state.state !== 'ready') {
    return null
  }

  const host = hosts.get('human')
  const identity = account.identity()
  const scope = account.appScope()

  if (
    !host ||
    !matrixHumanSdkReady(state.state, host) ||
    !identity ||
    !scope ||
    host.identity.userId !== identity.userId ||
    host.identity.deviceId !== identity.deviceId
  ) {
    return null
  }

  return { ...scope, userId: identity.userId, deviceId: identity.deviceId, host }
}

/** Native identity plus the exact human host; observations carry no authority. */
function googleFenceOwner(): MatrixGoogleFenceOwner | null {
  if (!brainActive || closing || !account) {
    return null
  }

  try {
    const host = hosts.get('human')
    const identity = account.identity()
    const scope = account.appScope()

    if (
      !host ||
      !identity ||
      !scope ||
      host.identity.userId !== identity.userId ||
      host.identity.deviceId !== identity.deviceId
    ) {
      return null
    }

    return { ...scope, identity, host }
  } catch {
    return null
  }
}

/** Main-owned account activation. A failed attempt waits for an explicit SDK retry. */
function syncLocalBrain(identity: MatrixIdentity | null = state.identity, retry = false) {
  if (!localBrain || !account) {
    return
  }

  const owner = brainActive && !closing && identity ? account.appScope() : null
  const key = owner ? `${owner.accountKey}:${owner.generation}` : null

  if (!retry && key === brainOwner) {
    return
  }

  brainOwner = key
  void localBrain
    .activate(owner)
    .then(() => googleFenceNotices?.reconcile().catch(error => googleFenceLog.failure(error)))
    .catch(() => console.warn('[Matrix] local_brain_unavailable'))
}

let appViews: AppViewController
let hermesPages: MatrixPagesController | undefined
let nativeApps: NativeAppsController | undefined
let desktopServices: MatrixDesktopServices | undefined
/** Restart-to-update continuity: the progress window, the saved place, and what the last Restart left. */
let stagedRecoveryFailed = false
let updateHandoff: UpdateHandoff | null = null
let previousRestart: UpdateHandoffResult | null = null
let matrixApps: ReturnType<typeof createMatrixApps> | undefined
let appLoadHost: Host | undefined
let outcomeStore: EncryptedStore
let pendingMatrixDrafts: PendingMatrixDrafts | undefined
let documents: MatrixRoomDocuments
const documentClose = new MatrixDocumentClose()
let documentCloseFailed = false

async function prepareDocumentClose(): Promise<void> {
  const window = ui

  if (!window || window.isDestroyed() || !documents?.hasTextPreview()) {
    return
  }

  await documentClose.prepare(
    id => window.webContents.send(MATRIX_WINDOW_CHANNELS.prepareDocumentClose, id),
    () => ui === window && !window.isDestroyed() && !closing && state.state === 'ready'
  )
}

let pdf: AtumPdfViewController
let clearPdfSession = () => Promise.resolve(false)
let runtime: MatrixHermesRuntimeConfig | undefined
let runtimeInvalid = false
let workspaceStartup: MatrixWorkspaceStartup | undefined
let workspaceKnownDriveRoots: string[] = []

/** Read native sealed history; unreadable/malformed facts never authorize import, move or launch. */
function matrixWorkspaceDriveRoots(): string[] {
  const store = new EncryptedStore(path.join(app.getPath('userData'), 'device', 'drive-roots.json'), safeStorage)

  const live = [drive?.importTarget()?.root, drive?.savedRoot(), ...(deviceWorkspace?.driveRoots() ?? [])].filter(
    (root): root is string => typeof root === 'string'
  )

  workspaceKnownDriveRoots = readMatrixWorkspaceDriveRoots(
    store,
    new EncryptedStore(path.join(app.getPath('userData'), 'drive.json'), safeStorage),
    live,
    workspaceKnownDriveRoots
  )

  return [...workspaceKnownDriveRoots]
}

let pets: MatrixPets | undefined
let petOverlays: MatrixPetOverlayService | undefined
// Every focus re-reads the companion; the house dog's picture is decoded once.
const readBundledPet = cachedBundledPetReader(readMatrixBundledPet)
let personalPetCache: MatrixPersonalPetCache | undefined
let wallet: MatrixWalletController | undefined
/** The default assistant's check-ins (check-ins.ts), and its live backend for the job. */
let checkIns: MatrixCheckIns | undefined
let checkInGateway: MatrixHermesConnection['gateway'] | undefined
let backgroundSweeps: MatrixBackgroundSweeps | undefined
let sourceGateSync: MatrixAccountSourceGates | undefined
// Coordinator-only activation after CX + U1 + X1; presentation alone never enables reads.
const REMOTE_MAC_SOURCE_READS_ENABLED = false
const sourceReadiness = new MacSourceReadiness()
const backgroundSweepModelCalls = new MatrixBackgroundSweepModelCalls()
let backgroundSweepPublications: MatrixBackgroundSweepPublication | undefined
let backgroundSweepSuggestionStore: MatrixBackgroundSweepSuggestions | undefined
let companyStore: MatrixCompanyStoreBridgeController | undefined
let store: MatrixStoreController | undefined
let checkout: MatrixCheckoutController | undefined
/** The platform's official accounts and the person's Founder chat (founder-chat.ts). */
let officialAccounts: MatrixOfficialAccountsController | undefined
let founderChat: ReturnType<typeof createMatrixFounderChat> | undefined

// ------------------------------------------------------------------------------------------------
// S1 WS-3b: agents whose typed questions route through the cloud handoff, and this Mac's device
// service (one agent everywhere, ). Legacy cloud agents have
// no local writer here. A saved H-F policy may keep a Mac executor ready, but the exact lease still
// gates every local answer and scheduled jobs stay off. The roster remains the handoff route.
// ------------------------------------------------------------------------------------------------

let deviceIdentity: MacDeviceIdentity | undefined
let deviceBootstrap: DeviceServiceBootstrap | undefined
let deviceNativeUi: ReturnType<typeof createDeviceNativeUi> | undefined
let deviceWorkspace: DriveWorkspaceCopies | undefined
let deviceLaunch: DeviceLaunch = 'interactive'
let cloudEnrollments: CloudAgentEnrollment | undefined
let executionPolicies: MatrixExecutionPolicyController | undefined
let cloudModelChoices: MatrixCloudModelChoices | undefined
let providerConnections: MatrixProviderConnections | undefined
let chatGptRelay: MatrixChatGptRelay | undefined
let modelDestinations: MatrixModelDestinations | undefined
let cloudHomeReader: MatrixCloudHomeReader | undefined
/** The agents the roster says answer in the cloud, by principal (atum.cloud-answering/1). */
const cloudAgents = new Set<string>()
const hostRuntimeAgents = new Set<string>()
/** Agents the create answer placed in the cloud this session (placed/pending_trust), until the
 * roster shows `answering: 'cloud'`: the platform owns them while their row still says local. */
const placedAgents = new MatrixPlacedAgents()
/** Agents being moved to the cloud right now: their local turns wait, nothing runs here. */
const movingAgents = new Set<string>()
/** The agent-home model (atum.agent-home/2.1): which Mac an agent lives on, and a manual move between the
 * owner's Macs. It holds an agent off here exactly while this Mac is not its home (`isMovingAgent`), and
 * leaves every agent the platform has not placed under it as it was. Built with the device identity. */
let agentHome: AgentHomeApp | undefined
const agentHomePreflights = new Map<
  string,
  { scope: string; preflight: AgentHomeOwnerMovePreflightV25 }
>()
/** The owner's names for their Macs, as the agent settings show them (a short cache of the registry read). */
let agentHomeNames: { at: number; names: MacNames; superseded: readonly string[] } | undefined
const agentMoves = new Map<string, AgentMigration>()

let homeMigration:
  | { owner: string; generation: number; holds: MigrationWriterHolds; client: DesktopHomeMigration }
  | undefined

let migrationTickRunning = false
/** Each move's abort: sign-out ends it before the switch (nothing moves for a signed-out owner). */
const moveAborts = new Set<AbortController>()
/** Bumped at sign-out: a move from before it never touches the agents again, not even to restore. */
let moveGeneration = 0
/** This Mac's Matrix device fingerprints (a device's never changes). */
const deviceFingerprints = new Map<string, string>()

function cloudPrincipal(agentRuntime: MatrixAgentRuntime | undefined): string | undefined {
  return agentRuntime?.agentPrincipal ?? agentRuntime?.principal
}

/** The agent's main chat is a plain room (0.20): the one its routines post into. */
function agentMainRoomPlain(agentRuntime: MatrixAgentRuntime): boolean {
  const owner = account.identity()

  const main =
    (owner && agentRuntime.userId
      ? resolveProjectedConversation(state.rooms, owner.userId, agentRuntime.userId).main
      : undefined) ?? agentRuntime.homeRoom

  return Boolean(main && state.rooms.find(room => room.id === main)?.plainAgent)
}

function isCloudAgent(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  const principal = cloudPrincipal(agentRuntime)

  return Boolean(principal && cloudAgents.has(principal))
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
function macPowerEligible(): boolean {
  return atumKeepAwake.isEligible()
}

function executionPolicyLocal(agentRuntime: MatrixAgentRuntime | undefined) {
  const principal = cloudPrincipal(agentRuntime)
  const presence = deviceIdentity?.presence()
  const deviceServiceId = presence?.state === 'enrolled' ? presence.deviceServiceId : undefined

  return principal
    ? matrixExecutionPolicyLocalMode(executionPolicies?.snapshot(principal), deviceServiceId, macPowerEligible())
    : 'off'
}

function executionPolicyLocalAuthority(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  const principal = cloudPrincipal(agentRuntime)
  const presence = deviceIdentity?.presence()
  const deviceServiceId = presence?.state === 'enrolled' ? presence.deviceServiceId : undefined

  return matrixExecutionPolicyHasLocalDestination(
    principal ? executionPolicies?.snapshot(principal) : undefined,
    deviceServiceId
  )
}

/** The platform keeps a saved execution policy for this agent (the Mac's cached view says so):
 * where it answers then follows that policy, and the legacy answering switch is refused
 * (answering-switch.ts). */
function agentHasSavedExecutionPolicy(principal: string): boolean {
  return executionPolicies?.snapshot(principal)?.policy.source === 'saved'
}

/** The owner's names for the Macs in a failover policy (§9.4 "Real names"): one shared registry
 * read (execution-device-names.ts) serves every agent's 30 s policy refresh, refreshed on an
 * interval or when this Mac enrolls. A registry failure never stales a policy: the controller
 * keeps the stable ordinal names. */
const executionDeviceNames = new MatrixExecutionDeviceNames({
  list: signal => deviceRegistryTransport(s1Call).list(signal),
  own: () => deviceIdentity?.enrollment()?.deviceServiceId,
  model: () => (macModel ??= readMatrixMacModel()),
  // The registry belongs to one signed-in account: a switch must never reuse its names.
  scope: () => account?.appScope() ?? null
})

/** The account generation the device-name cache currently belongs to. */
let executionDeviceNamesScope: string | undefined

/** Drop the cached names when the signed-in account (or its generation) changed. */
function syncExecutionDeviceNamesScope(): void {
  const scope = account?.appScope()
  const key = scope ? `${scope.accountKey}\n${scope.generation}` : undefined

  if (key !== executionDeviceNamesScope) {
    executionDeviceNamesScope = key
    executionDeviceNames.invalidate()
  }
}

/** What this Mac is for a cloud-roster agent (cloud-agent-placement.ts): `answering` while it
 * holds the term, `standby` while only a fresh saved policy keeps its runtime, otherwise none.
 * The lease remains the execution authority; cache state never fabricates it. */
function cloudAgentMacRole(agentRuntime: MatrixAgentRuntime | undefined): MatrixCloudAgentMacRole | undefined {
  const principal = cloudPrincipal(agentRuntime)

  if (!agentRuntime || !principal || !isCloudAgent(agentRuntime)) {
    return undefined
  }

  const presence = deviceIdentity?.presence()

  return matrixCloudAgentMacRole({
    view: executionPolicies?.snapshot(principal),
    deviceServiceId: presence?.state === 'enrolled' ? presence.deviceServiceId : undefined,
    leaseState: agentRuntime.lease?.current.state,
    powerEligible: macPowerEligible()
  })
}

/** A cloud-roster agent may keep this Mac only under a fresh saved policy or an exact term that
 * is already draining. */
function cloudAgentRunsLocally(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  return cloudAgentMacRole(agentRuntime) !== undefined
}

function isCloudOnlyAgent(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  return (
    matrixPlacedCloudOnly({
      principal: cloudPrincipal(agentRuntime),
      placed: placedAgents,
      cloudRoster: cloudAgents
    }) || (isCloudAgent(agentRuntime) && !cloudAgentRunsLocally(agentRuntime))
  )
}

/** The create answer put this agent in the cloud (`placed`/`pending_trust`): this Mac sets up
 * no local executor, room or profile for it. The roster row still answers `local` until the
 * controller trusts the enrollment, so the id is remembered until `applyAnswering` sees the
 * switch (or the agent is retired/signed out). A roster read is requested so the switch lands
 * as soon as the platform makes it. */
function rememberPlacedCloudAgent(principal: string): void {
  placedAgents.add(principal)
  // Its local gate has nothing to set up (isCloudOnlyAgent passes the local steps), so the
  // assistant reads as ready now rather than as a setup still in progress.
  agents.get(principal)?.readiness?.start()
  agentRoster.request()
  void syncAgents()
  publish(state)
}

/** A stand-down fences local execution, not the owner's messages to the agent's new home. */
function isActivelyMovingAgent(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  const principal = cloudPrincipal(agentRuntime)

  if (!principal) {
    return false
  }

  try {
    // isHeld seeds durable holds before reading their reasons.
    const held = agentHome?.isHeld(principal)

    return (
      movingAgents.has(principal) ||
      Boolean(homeMigrationForOwner()?.holds.held(principal)) ||
      Boolean(held && agentHome.holds.reasons(principal).some(reason => reason !== 'standDown'))
    )
  } catch {
    return true
  }
}

/** Being moved to the cloud from this Mac: its local writers stay off until the move ends. */
function isMovingAgent(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  const principal = cloudPrincipal(agentRuntime)

  if (!principal) {
    return false
  }

  try {
    return (
      movingAgents.has(principal) ||
      Boolean(homeMigrationForOwner()?.holds.held(principal)) ||
      // This Mac is not the home of an agent the placement model manages (or is moving it): nothing runs here.
      Boolean(agentHome?.isHeld(principal))
    )
  } catch {
    return true
  } // An unreadable writer hold can never restart the agent.
}

function homeMigrationForOwner() {
  const owner = account?.identity()?.userId

  if (!owner || !deviceIdentity) {
    return undefined
  }

  if (homeMigration?.owner === owner && homeMigration.generation === moveGeneration) {
    return homeMigration
  }

  const holds = new MigrationWriterHolds({ ownerUserId: owner, store: deviceIdentity.store })

  const client = new DesktopHomeMigration({
    connection: () => deviceIdentity?.connection() ?? null,
    holds,
    agent: (principal, userId) => migrationLocalAgent(principal, userId),
    confirm: async (agent, model) => {
      if (!agent.current()) {
        return null
      }

      return confirmMigrationReport(deviceLocale(), model, async options => {
        if (!agent.current()) {
          return options.cancelId
        }

        const result =
          ui && !ui.isDestroyed()
            ? await dialog.showMessageBox(ui, { ...options, type: 'question' })
            : await dialog.showMessageBox({ ...options, type: 'question' })

        return agent.current() ? result.response : options.cancelId
      })
    },
    changed: () => {
      for (const agent of allAgents()) {
        agent.readiness?.recheck()
        agent.localTurns?.kick()
      }

      publish(state)
    }
  })

  homeMigration = { owner, generation: moveGeneration, holds, client }
  deviceIdentity.attachMigration(client)

  return homeMigration
}

function migrationLocalAgent(principal: string, userId: string): MigrationLocalAgent | null {
  if (!config.cloudMigrationTestAgents?.includes(principal)) {
    return null
  }

  const agent = allAgents().find(each => cloudPrincipal(each) === principal && each.userId === userId)

  const owner = account?.identity()?.userId,
    generation = moveGeneration

  if (!owner || !agent || agent.closed) {
    return null
  }

  const current = () => generation === moveGeneration && account?.identity()?.userId === owner && !agent.closed

  const home = () => {
    if (!current() || !runtime) {
      return null
    }

    const identity = enrollmentOf(agent).identity

    return identity ? agentHermesHome(agent, identity, runtime) : (account.retainedAgentHermes(principal)?.home ?? null)
  }

  let continuousRoom: string | undefined

  return {
    principal,
    userId,
    current,
    hasHome: () => Boolean(home()),
    quiesce: async () => {
      if (!current()) {
        throw Error('matrix_migration_account_changed')
      }

      continuousRoom = agent.continuous?.enabled ? agent.continuous.roomId : undefined
      await quiesceForCloud(agent)
      await requireConversationSnapshot(conversations.get(agent)?.activity, () => conversationPending(agent))
    },
    snapshot: async migrationId => {
      const sourceHome = home(),
        selectedRuntime = runtime

      if (!sourceHome || !selectedRuntime) {
        throw Error('matrix_migration_no_local_home')
      }

      const directory = path.join(app.getPath('userData'), 'device', 'migration')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const archive = path.join(directory, `${migrationId}.atum-home`)
      const exported = await exportAgentHome(selectedRuntime, sourceHome, archive)
      await chmod(archive, 0o600)

      return { archive, files: exported.files, bytes: (await stat(archive)).size, sha256: await fileSha256(archive) }
    },
    restore: async () => {
      if (!current() || isCloudAgent(agent) || isMovingAgent(agent)) {
        return
      }

      const binding = continuousRoom ? continuousBinding(continuousRoom, agent) : undefined

      if (binding && continuousRoom) {
        agent.continuous?.enable(binding, continuousRoom)
      }

      // The quiesce stopped its host; a recheck of a ready agent only runs the watch.
      agent.readiness?.start()
      agent.localTurns?.kick()
      publish(state)
    },
    switchToCloud: async () => {
      if (!current()) {
        throw Error('matrix_migration_account_changed')
      }

      await switchAnsweringToCloud({
        savedPolicy: agentHasSavedExecutionPolicy(principal),
        switchAnswering: () =>
          setAgentAnswering(
            s1Call,
            { agentPrincipal: principal, mode: 'cloud', expectedMode: 'local' },
            AbortSignal.timeout(30_000)
          )
      })

      if (!current()) {
        return
      }

      cloudAgents.add(principal)
      agentRoster.request()
    }
  }
}

/** Local-only capabilities require this Mac to be an enabled policy destination. */
function refuseCloudAgent(agentRuntime: MatrixAgentRuntime | undefined): void {
  if (isMovingAgent(agentRuntime)) {
    throw new Error('matrix_agent_unavailable')
  }

  if (isCloudOnlyAgent(agentRuntime)) {
    throw new Error(MATRIX_CLOUD_AGENT_UNSUPPORTED)
  }
}

/** One S1 owner route: the native grant where the route needs it (device/cloud-agent.ts). */
function s1Call(resource: S1Resource, signal: AbortSignal): Promise<unknown> {
  if (!config.domain) {
    return Promise.reject(new DeviceRegistryError(503))
  }

  return s1Route(resource).bearer
    ? account.s1Request((token, base, requestSignal) => requestS1(base, resource, token, requestSignal, fetch,
      resource.kind === 'source-authority' ? account.sdkConfiguration().accessToken : undefined), signal)
    : requestS1(config.domain.resource, resource, null, signal)
}

/**
 * The owner's Matrix device on this Mac and its ed25519 fingerprint, from its own SDK. The human
 * SDK's readiness is the snapshot's (`host.ready` is never set for the human host).
 */
function deviceOwner(): Promise<DeviceEnrollmentOwner | DeviceOwnerRefusal> {
  const host = hosts.get('human')

  return resolveDeviceOwner({
    human: account?.identity(),
    sdkState: state.state,
    host,
    devices: userId =>
      host?.queue.command({ kind: 'devices', userId }, 20_000) ?? Promise.reject(new Error('matrix_sdk_unavailable')),
    fingerprints: deviceFingerprints
  })
}

function deviceLocale(): string | undefined {
  return state.displayPreferences?.language?.value
}

function createDeviceIdentity(): MacDeviceIdentity {
  const helper =
    process.platform === 'darwin'
      ? path.join(assets, 'atum-device-key').replace('app.asar/', 'app.asar.unpacked/')
      : null

  let computer: string | undefined

  return new MacDeviceIdentity({
    userData: app.getPath('userData'),
    safeStorage,
    helper: helper && existsSync(helper) ? helper : null,
    // Production builds dial only the production hub; a build compiled with a loopback hub (the
    // local tunnel fallback) may dial it instead (connection.ts deviceHubUrl).
    hubUrl: deviceHubUrl(process.env.ATUM_DEVICE_HUB_URL),
    call: s1Call,
    owner: deviceOwner,
    // Until the device runtime (WS-4) attaches, this Mac offers nothing and says so.
    hello: () => ({
      policyVersion: 1,
      appVersion: app.getVersion(),
      capabilities: {
        terminal: false,
        files: false,
        computer: { available: false, reason: 'device runtime not installed' }
      }
    }),
    locale: deviceLocale,
    displayName: () => (computer ??= macComputerName()),
    osVersion: () => process.getSystemVersion(),
    onEnrolled: () => {
      deviceControlOwner = undefined
      publish(state)
    },
    log: line => console.warn(line)
  })
}

/** Main owns native authority; the runtime receives only live account facts and sealed storage. */
function buildDeviceRuntime(): DeviceRuntime {
  const home = app.getPath('home')
  const native = (deviceNativeUi ??= createDeviceNativeUi({ locale: deviceLocale, parent: () => ui }))
  const rootStore = new EncryptedStore(path.join(app.getPath('userData'), 'device', 'drive-roots.json'), safeStorage)
  let knownDriveRoots: string[] = []

  try {
    const stored: unknown = JSON.parse(rootStore.getItem('roots') ?? '[]')

    if (Array.isArray(stored) && stored.every(root => typeof root === 'string')) {
      knownDriveRoots = stored
    }
  } catch {
    // No trusted root facts: the runtime gives no write access outside a working copy.
  }

  const workspaceLabel = async (agentPrincipal: string) => {
    const owner = account?.appScope()

    if (
      !owner ||
      closing ||
      !allAgents().some(agent => !agent.closed && isCloudAgent(agent) && cloudPrincipal(agent) === agentPrincipal)
    ) {
      return null
    }

    const answer = await s1Call({ kind: 'workspace', agentPrincipal }, AbortSignal.timeout(15_000))
    const current = account?.appScope()

    return current?.accountKey === owner.accountKey && current.generation === owner.generation && !closing
      ? workspaceLabelFor(answer, agentPrincipal)
      : null
  }

  deviceWorkspace = new DriveWorkspaceCopies({
    drive: {
      savedRoot: () => drive?.savedRoot() ?? null,
      manifestFor: paths => drive?.manifestFor(paths) ?? Promise.resolve(null)
    },
    workspaceLabel,
    tasksRoot: path.join(home, 'Atum Tasks'),
    artifactsRoot: path.join(app.getPath('userData'), 'device', 'workspace-artifacts'),
    knownDriveRoots,
    rememberDriveRoots: roots => rootStore.setItem('roots', JSON.stringify(roots))
  })

  const conflictStore = new EncryptedStore(
    path.join(app.getPath('userData'), 'device', 'conflict-copies.json'),
    safeStorage
  )

  const conflictAuthority = () => {
    const owner = account?.appScope()

    return [
      owner?.accountKey ?? '',
      owner?.generation ?? 0,
      deviceIdentity?.enrollment()?.deviceServiceId ?? '',
      deviceIdentity?.epochs.accountEpoch() ?? 0
    ].join(':')
  }

  const conflictCopies = new ConflictCopyRelay({
    authority: conflictAuthority,
    drive: { manifestFor: paths => drive?.manifestFor(paths) ?? Promise.resolve(null) },
    folders: async () => {
      const folders: Array<{ agentPrincipal: string; label: string }> = []

      for (const agent of allAgents().filter(each => !each.closed && isCloudAgent(each))) {
        const agentPrincipal = cloudPrincipal(agent)
        const label = agentPrincipal ? await workspaceLabel(agentPrincipal) : null

        if (agentPrincipal && label) {
          folders.push({ agentPrincipal, label })
        }
      }

      return folders
    },
    store: {
      get: () => {
        try {
          const keys: unknown = JSON.parse(conflictStore.getItem(conflictAuthority()) ?? '[]')

          return Array.isArray(keys)
            ? keys.filter((key): key is string => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)).slice(-4000)
            : []
        } catch {
          return []
        }
      },
      set: keys => conflictStore.setItem(conflictAuthority(), JSON.stringify(keys))
    },
    artifactsRoot: path.join(app.getPath('userData'), 'device', 'workspace-artifacts')
  })

  const driverCandidates = [
    path.join(home, '.local', 'bin', 'cua-driver'),
    path.join(home, '.cargo', 'bin', 'cua-driver'),
    '/opt/homebrew/bin/cua-driver',
    '/usr/local/bin/cua-driver'
  ]

  const device = createDeviceRuntime({
    // Native + Matrix proof transport is wired; coordinator enables only after U1 disclosure and installed proof.
    macSource: (args, grant, signal) => new RemoteMacSourcesService({
      enabled: remoteMacSourceReadsEnabled,
      scope: () => {
        const scope = account.appScope()
        return scope ? `${scope.accountKey}:${scope.generation}` : null
      },
      allowed: source => macSourcesConsentStore().read()[source],
      ownerPrincipal: grant => {
        const identity = account?.enrollment().identity
        return identity?.userId === grant.ownerUserId ? identity.principal : null
      },
      authority: (query, signal) => s1Call({ kind: 'source-authority', agentPrincipal: query.agentPrincipal,
        gate: query.gate, expectedRevision: query.expectedRevision }, signal),
      request: (payload, context, readSignal) => macSourcesService().request(payload, context, readSignal)
    }).request(args, grant, signal),
    platform: process.platform,
    userData: app.getPath('userData'),
    home,
    appExecutable: process.execPath,
    launcherPath: resolveDisclaimLauncher({ resourcesPath: process.resourcesPath, appRoot: app.getAppPath() }).path,
    hermes: runtime ? { python: runtime.python, source: runtime.source } : null,
    cuaDriverSocket: path.join(home, 'Library', 'Caches', 'cua-driver', 'cua-driver.sock'),
    cuaDriverAvailable: () => process.platform === 'darwin' && driverCandidates.some(file => existsSync(file)),
    store: new EncryptedStore(path.join(app.getPath('userData'), 'device', 'runtime.json'), safeStorage),
    locale: deviceLocale,
    sshAuthSock: () => process.env.SSH_AUTH_SOCK,
    onProtectedFolderDenied: noteProtectedFolderDenied,
    closedFolders: () => matrixFolderAccess().closedFolders(),
    sharedInsideClosedFolders: () => matrixFolderAccess().sharedInsideClosedFolders(),
    identity: () => {
      const owner = account?.identity()
      const hello = device.hello()

      return owner
        ? {
            ownerUserId: owner.userId,
            signedIn: !closing && !account.sessionEnded() && !account.signOutPending(),
            // Every active agent of the owner, not only those answering in the cloud (device/served-agents.ts).
            cloudAgents: servedAgentUsers(
              allAgents().map(each => ({
                userId: each.userId,
                closed: each.closed || (each === defaultAgent && unusedRoot())
              }))
            ),
            localScopes: [
              ...(hello.terminal ? ['terminal' as const] : []),
              ...(hello.files ? ['files' as const, 'send_file' as const] : []),
              ...(hello.computer.available ? ['computer' as const] : [])
            ]
          }
        : null
    },
    originLog: () => deviceIdentity?.originLog() ?? [],
    send: (type, body) => deviceIdentity?.connection()?.send(type, body) ?? Promise.resolve(false),
    sendArtifact: (commandId, artifact) => deviceIdentity?.sendArtifact(commandId, artifact) ?? Promise.resolve(false),
    accountEpoch: () => deviceIdentity?.epochs.accountEpoch() ?? 0,
    signer: () => deviceIdentity?.approvalSigner() ?? null,
    approvalKey: () => deviceIdentity?.approvalKey() ?? null,
    deviceServiceId: () => deviceIdentity?.enrollment()?.deviceServiceId ?? null,
    chatGptRelay: {
      authority: () => {
        const ownerPrincipal = account?.enrollment().identity?.principal
        const deviceServiceId = deviceIdentity?.enrollment()?.deviceServiceId

        if (!ownerPrincipal || !deviceServiceId || closing || account.sessionEnded() || account.signOutPending()) {
          return null
        }

        return {
          ownerPrincipal,
          deviceServiceId,
          agentPrincipals: allAgents().flatMap(agent => {
            const identity = enrollmentOf(agent).identity
            return !agent.closed && identity?.principal === ownerPrincipal && identity.agentPrincipal
              ? [identity.agentPrincipal]
              : []
          })
        }
      },
      authorize: async (request, signal) => {
        signal.throwIfAborted()
        const selected = await chatGptRelay?.refresh()
        signal.throwIfAborted()
        return selected?.state === 'enabled' && selected.deviceServiceId === request.deviceServiceId &&
          selected.revision === request.relayRevision
      },
      call: async (input, signal) => {
        const ownerPrincipal = account?.enrollment().identity?.principal

        if (!runtime || !ownerPrincipal || closing) {
          throw new Error('chatgpt_relay_unavailable')
        }

        const relayHome = matrixHermesHome(runtime, ownerPrincipal, 'chatgpt-relay')
        mkdirSync(relayHome, { recursive: true, mode: 0o700 })
        return runChatGptRelayProcess({
          python: runtime.python,
          source: runtime.source,
          env: {
            ...matrixHermesEnvironment(runtime, relayHome, app.getPath('home'), process.env,
              sharedCodexHere() ? null : matrixAccountCodexScope(runtime, ownerPrincipal)),
            // The relay answers on the account's plan: the same auth root as every assistant.
            ...matrixSubscriptionEnvironment(undefined, subscriptionAuthHome())
          },
          ...input,
          signal
        })
      }
    },
    agentName: userId => allAgents().find(each => each.matrixUser === userId || each.userId === userId)?.name ?? 'Atum',
    deviceName: () => macComputerName(),
    tray: native.tray,
    promptPassword: native.promptPassword,
    chooseApproval: native.chooseApproval,
    ownApp: () => ({
      bundlePath: appBundleOf(process.execPath)?.bundle,
      bundleId: 'com.atum.matrix-candidate',
      pids: [
        process.pid,
        ...BrowserWindow.getAllWindows()
          .filter(window => !window.isDestroyed())
          .map(window => window.webContents.getOSProcessId())
      ]
    }),
    driveRoot: () => deviceWorkspace?.driveRoot() ?? null,
    workspaceCopies: deviceWorkspace,
    conflictCopies,
    log: line => console.warn(line)
  })

  // Attach before activate/enroll/originFor can create or dial a connection.
  deviceIdentity?.attach(device.service, () => ({
    policyVersion: 1,
    appVersion: app.getVersion(),
    capabilities: device.hello(),
    sourceProtocol: 1 as const,
    sources: currentMacSourceReadiness(),
    ...(device.workspaceProtocol?.() === 1 ? { workspaceProtocol: 1 as const } : {})
  }))

  return device
}

function createCloudEnrollments(): CloudAgentEnrollment {
  const humanHost = () => {
    const human = account?.identity()
    const host = hosts.get('human')

    if (!human || !host || host.identity.deviceId !== human.deviceId) {
      throw new Error('matrix_sdk_unavailable')
    }

    return host
  }

  return new CloudAgentEnrollment({
    call: s1Call,
    ownerDevice: () => {
      const human = account?.identity()

      return human && hosts.get('human')?.identity.deviceId === human.deviceId ? human.deviceId : null
    },
    roster: () => account.agents(AbortSignal.timeout(15_000)),
    receive: sender => humanHost().queue.command({ kind: 'agentIdentityToDeviceRead', sender, limit: 32 }, 30_000),
    send: async (recipient, event) => {
      await humanHost().queue.command(
        { kind: 'agentIdentityToDeviceSend', recipient, event } as Parameters<Host['queue']['command']>[0],
        30_000
      )
    },
    recoveryKey: async (userId, key) => {
      const host = humanHost()
      const ownerKey = account.recoveryKey(host.identity)

      if (!ownerKey) {
        throw new Error('matrix_owner_recovery_required')
      }

      return (await host.queue.command(
        { kind: 'agentRecoveryKey', userId, ownerKey, ...(key ? { key } : {}) },
        120_000
      )) as string | null
    },
    log: line => console.warn(line)
  })
}

/** Stops every local writer of an agent that now answers in the cloud (or is moving there). */
async function quiesceForCloud(agentRuntime: MatrixAgentRuntime): Promise<void> {
  // Its writer hold prevents new changes; drain a prior job/home change before snapshotting.
  await conversations.get(agentRuntime)?.activity.settled()
  forgetContinuousListening(agentRuntime)
  stopListening('cancelled', agentRuntime)
  agentRuntime.listener.clear()
  agentRuntime.cronListening?.()
  agentRuntime.cronListening = undefined
  await agentRuntime.lease?.stop()
  await stopHermesExecutor(agentRuntime)
  // A launch already in flight must finish closing before a home can be snapshotted.
  await agentRuntime.starting
  await stopHermesExecutor(agentRuntime)
  // Its own Matrix device here is being revoked (the switch revokes local executors' sessions).
  await stopHost(agentRuntime.role)
  agentRuntime.localTurns?.kick()
  publish(state)
}

/** Policy disable/fail-closed keeps the person's listening preference but stops every local
 * writer after an exact active term has drained. Re-enabling can therefore resume without
 * rewriting intent; the platform lease still decides whether this Mac actually answers. */
async function quiesceForExecutionPolicy(agentRuntime: MatrixAgentRuntime): Promise<void> {
  agentRuntime.continuous?.pause('offline')
  stopListening('cancelled', agentRuntime)
  agentRuntime.listener.clear()
  agentRuntime.cronListening?.()
  agentRuntime.cronListening = undefined
  await agentRuntime.lease?.stop()
  await stopHermesExecutor(agentRuntime)
  await agentRuntime.starting
  await stopHermesExecutor(agentRuntime)
  await stopHost(agentRuntime.role)
  agentRuntime.localTurns?.kick()
  publish(state)
}

/** The owner's Macs by name, read through the one shared registry read (a short cache; failures keep the last). */
function refreshAgentHomeNames(): Promise<void> {
  if (agentHomeNames && Date.now() - agentHomeNames.at < 60_000) {
    return Promise.resolve()
  }

  return executionDeviceNames.read().then(
    names => {
      const next: MacNames = Object.fromEntries(
        Object.entries(names).map(([id, each]) => [id, { displayName: each.displayName, thisMac: each.thisMac }])
      )

      const superseded = executionDeviceNames.superseded()
      const changed = executionDeviceNamesProjectionChanged(agentHomeNames, next, superseded)
      agentHomeNames = { at: Date.now(), names: next, superseded }

      if (changed) {
        publish(state)
      }
    },
    () => undefined
  )
}

/** The placement model governs this agent (atum.agent-home/2.1): its results reach a room only through the
 * platform's outbox and its turns are on the platform's ledger. An agent it has not taken over is unchanged. */
function isMigratedAgent(agentRuntime: MatrixAgentRuntime | undefined): boolean {
  const principal = cloudPrincipal(agentRuntime)

  return Boolean(principal && agentHome?.isMigrated(principal))
}

/** The platform's outbox sent this invocation's result: its ledger recorded the event, so nothing is acknowledged. */
function outboxedResult(agentRuntime: MatrixAgentRuntime, invocationId: string): boolean {
  const principal = cloudPrincipal(agentRuntime)

  return Boolean(principal && agentHome?.outboxed(principal, invocationId))
}

/** Where the agent lives and a move in plain steps, for its settings; absent while the platform has no placement for it. */
function agentHomeView(principal: string): MatrixAgentHomeView | undefined {
  const view = agentHome?.service.view(principal)

  if (!agentHomeNames || Date.now() - agentHomeNames.at >= 60_000) {
    void refreshAgentHomeNames()
  }

  const presence = deviceIdentity?.presence()

  const me = presence?.state === 'enrolled' ? presence.deviceServiceId : null
  const owner = agentHome?.owner.state(principal)
  const ownerFailure = agentHome?.owner.failure(principal)
  const base = homeViewFor(view ?? null, agentHomeNames?.names ?? null, me) ?? (owner
    ? {
        lives:
          owner.snapshot.placement.location.kind === 'cloud'
            ? { kind: 'cloud' as const }
            : {
                kind: 'mac' as const,
                name: agentHomeNames?.names?.[owner.snapshot.placement.location.deviceServiceId]?.displayName ?? '',
                thisMac: owner.snapshot.placement.location.deviceServiceId === me
              },
        move: null,
        targets: [],
        issue: null
      }
    : ownerHomeReadFallback(
        ownerFailure,
        Boolean(allAgents().some(agent => cloudPrincipal(agent) === principal && isCloudAgent(agent)))
      ))
  const application = agentHome?.participant?.projection(principal)
  if (base && application?.status === 'unavailable' && (!base.issue || base.issue === 'model_unavailable')) {
    base.issue = application.reason
  }
  // The SAVED cloud choice, never the recommended fallback: a ChatGPT/OpenCode Go choice is
  // the current model as itself, so an Atum row is not mistaken for the one already chosen.
  const cloudDestinationChoice = modelDestinations?.view(principal)?.choices.find(choice => choice.kind === 'cloud')
  const cloudModel = cloudDestinationChoice?.external
    ? cloudDestinationChoice.external.source === 'chatgpt_plan' || cloudDestinationChoice.external.source === 'opencode_go'
      ? {
          source: cloudDestinationChoice.external.source,
          model: cloudDestinationChoice.external.model,
          modelLabel: cloudDestinationChoice.external.modelLabel,
          providerLabel: cloudDestinationChoice.external.providerLabel,
          effort: cloudDestinationChoice.external.effort
        }
      : undefined
    : (cloudDestinationChoice?.shelf ?? cloudDestinationChoice?.current)

  return base && owner
    ? ownerHomeViewFor(
        base,
        owner,
        agentHomeNames?.names ?? null,
        me,
        cloudModel,
        cloudHomeOffers(principal),
        agentHomeNames?.superseded
      )
    : base && ownerFailure
      ? { ...base, issue: ownerFailure.kind === 'unsupported' ? 'platform_unsupported' : 'placement_unavailable' }
      : base
}

/** The cloud models the platform serves this agent now (`atum.model-choice/1.1`); absent until an offer was read. */
function cloudHomeOffers(principal: string) {
  return cloudModelChoices?.offer(principal)?.models
}

/** Whether this Mac already holds the agent: an enrollment that names it and a Hermes home that exists. */
function agentHomeCustody(principal: string): boolean {
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)
  const home = agentRuntime ? agentHomeDir(agentRuntime) : null

  return Boolean(home && existsSync(home))
}

function agentHomeOwnerScope(): string | null {
  const scope = account?.appScope()
  return scope ? `${scope.accountKey}:${scope.generation}` : null
}

function createAgentHome(device: MacDeviceIdentity): AgentHomeApp {
  const base = path.join(app.getPath('userData'), 'device', 'agent-home')

  return createAgentHomeApp({
    request: (send, signal) => account.s1Request(send, signal),
    key: () => device.executorKey(),
    verifyController: (message, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false
      }

      const row = value as Record<string, unknown>
      const common = row.common && typeof row.common === 'object' && !Array.isArray(row.common)
        ? row.common as Record<string, unknown>
        : undefined
      const meta = (row.meta ?? common?.meta) as Record<string, unknown> | undefined

      if (!meta || typeof meta.signerKeyId !== 'string' || typeof meta.signature !== 'string') {
        return false
      }

      const enrollment = device.enrollment()
      const key = enrollment?.controllerKeys.find(
        candidate =>
          candidate.kid === meta.signerKeyId &&
          enrollment.pinnedControllerKeys.includes(candidate.kid)
      )

      return Boolean(
        key &&
        verifyControllerSignature(
          key.publicKey,
          placementConnectionSignedBytes(message, row),
          meta.signature
        )
      )
    },
    store: device.store,
    runtime: () => runtime,
    dirs: { work: path.join(base, 'work'), backups: path.join(base, 'backups'), quarantine: path.join(base, 'quarantine') },
    handle: agentHomeHandle,
    materialize: materializeAgentHomeTarget,
    custody: agentHomeCustody,
    connections: {
      catalog: placementConnectionCatalog,
      apply: applyPlacementConnectionChoice,
      keepExecutor: keepAgentHomeExecutor
    },
    // Where the event bytes handed to the platform are kept: the agent's own encrypted store, beside its outcomes.
    publicationStore: principal => allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)?.store ?? null,
    // Every active owner agent is reconciled. A cloud-home agent may need this Mac to materialize
    // target custody and publish its catalog before a move exists.
    agents: () =>
      allAgents().flatMap(each => {
        const principal = cloudPrincipal(each)

        return principal && !each.closed ? [principal] : []
      }),
    ready: () => !closing && Boolean(account?.identity()) && Boolean(config.domain),
    scope: () => account?.identity()?.userId ?? null,
    // Who the platform says this sign-in is (its `/me` answer, never a guess from the Matrix id): a data key is taken only
    // under the name the platform derives for this owner, and "not readable now" takes no key.
    ownerPrincipal: async () => {
      try {
        return (await account.readDomain(false)).principal
      } catch {
        return null
      }
    },
    changed: () => {
      for (const agent of macJobs.keys()) {reconcileMacJobs(agent)}
      void refreshAgentHomeNames()
      publish(state)
    },
    log: line => console.warn(line)
  })
}

/**
 * Holds every writer of an agent's Hermes home still for the agent-home model (agent-home-placement/): the
 * turn in flight is waited for, never cut; the executor and scheduled jobs stop. With `keepLease` the answering
 * lease stays held and renewing, because a drain acknowledgement and a checkpoint are signed with it; without
 * it (this Mac is no longer the home) the lease, the listening and the agent's own host go too.
 */
async function quiesceForHome(agentRuntime: MatrixAgentRuntime, keepLease: boolean): Promise<void> {
  await agentRuntime.invocation?.pending.catch(() => undefined)
  await conversations.get(agentRuntime)?.activity.settled()
  agentRuntime.cronListening?.()
  agentRuntime.cronListening = undefined

  if (keepLease) {
    stopListening('cancelled', agentRuntime)
  } else {
    // The person's listening preference is kept; it comes back with the agent if the agent comes back.
    agentRuntime.continuous?.pause('offline')
    stopListening('cancelled', agentRuntime)
    agentRuntime.listener.clear()
    await agentRuntime.lease?.stop()
  }

  await stopHermesExecutor(agentRuntime)
  await agentRuntime.starting
  await stopHermesExecutor(agentRuntime)

  if (!keepLease) {
    await stopHost(agentRuntime.role)
  }

  agentRuntime.localTurns?.kick()
  publish(state)
}

/** The Hermes home path is known only once an enrollment names the agent on this Mac. */
function agentHomeDir(agentRuntime: MatrixAgentRuntime): string | null {
  if (!runtime) {
    return null
  }

  const identity = enrollmentOf(agentRuntime).identity

  if (identity) {
    return agentHermesHome(agentRuntime, identity, runtime)
  }

  try {
    return agentRuntime.principal ? (account.retainedAgentHermes(agentRuntime.principal)?.home ?? null) : null
  } catch {
    return null
  }
}

/** One agent's runtime on this Mac, as the agent-home model works through it (runtime-adapter.ts). */
function agentHomeHandle(principal: string): MacAgentHandle | null {
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)

  if (!agentRuntime) {
    return null
  }

  const usable = () => agentRuntime.readiness?.current.phase === 'ready' && Boolean(agentRuntime.executor?.connected)

  const appFacts = () => ({
    busy: Boolean(operation || domainOperation),
    closing,
    conversationPending: conversationPending(agentRuntime)
  })

  /** Nothing of this agent's own is writing its home, by the app's facts (agent-runtime.ts). */
  const resting = () => matrixAgentAtRest(agentRuntime, appFacts())

  /**
   * The same facts without the turn lock, and with the agent's content sync (which writes its persona, skills and memories into
   * the home): what the barrier asks once it holds the lock itself (`agentHoldWrites`).
   */
  const quiet = () => matrixAgentQuiet(agentRuntime, appFacts()) && !agentContent.writing(principal)

  return {
    home: () => agentHomeDir(agentRuntime),
    leaseFacts: () => {
      const identity = enrollmentOf(agentRuntime).identity

      return identity ? (agentRuntime.lease?.fenceFacts(identity.executorId) ?? null) : null
    },
    drain: async deadline => {
      // No new target is admitted; the one admitted finishes and says its piece. The lease is not touched.
      // Managed jobs drain beside the turn: admission stops, then this home publishes and settles its pending
      // deliveries until the deadline. Past it the move proceeds and they stay this home's (drainMacJobs).
      const jobs = drainMacJobs({ lifecycle: macJobs.get(agentRuntime)?.lifecycle, delivery: agentRuntime.cron,
        deadline: deadline ?? AbortSignal.timeout(90_000), log: line => console.warn(line) })

      agentRuntime.listener.drainAndStop('cancelled')
      await agentRuntime.invocation?.pending.catch(() => undefined)
      await conversations.get(agentRuntime)?.activity.settled()
      await jobs
    },
    // A move's drain and final checkpoint, and a restore: the agent is leaving or arriving, so its executor is stopped.
    // The checkpoint cadence never comes here: it captures beside the running agent (`atRest`).
    stopWriters: ({ keepLease }) => quiesceForHome(agentRuntime, keepLease),
    restart: () => {
      // The gate starts the agent the way it starts any agent: host, executor, lease, listening.
      agentRuntime.readiness?.start()
      agentRuntime.localTurns?.kick()
      scheduleContinuousListening()
      publish(state)
    },
    beginHere: () => {
      // The Hermes sessions on this Mac are older than the room; a fresh one per conversation is rebuilt
      // from the room's history by the turn that opens it (hermes-executor.ts).
      for (const key of agentRuntime.store.keys('matrix-conversation-')) {
        agentRuntime.store.removeItem(key)
      }

      markAgentHostedHere(agentRuntime)
    },
    running: (ms, signal) => waitUntil(usable, ms, signal),
    // In the middle of a turn, a task, a claim or an operation: the checkpoint cadence waits for it to end.
    busy: () => !resting(),
    // A good moment to capture beside the agent: the app's facts, and Hermes's own word that the review of the last
    // answer has finished (`runtime.quiesce` with no wait). It takes no lock, stops nothing and waits for nothing, so a
    // reply is never held up by it (at-rest.ts); the capture itself is proved afterwards (checkpoint.ts).
    atRest: () =>
      agentAtRest({
        resting,
        hermes: () => agentRuntime.executor?.connected?.gateway,
        log: line => console.warn(line)
      }),
    // The checkpoint's barrier, for the moment a snapshot of the home takes: the agent's turn lock (every path that starts
    // Hermes on this agent waits for it: a local turn, the listening watch, an explicit run, a model change), then the app's
    // facts and Hermes's own word. Nothing is stopped; a turn that arrives meanwhile waits that moment (at-rest.ts).
    holdWrites: () =>
      agentHoldWrites({
        lock: () => agentRuntime.lock.tryAcquire('home', 'checkpoint'),
        resting: quiet,
        hermes: () => agentRuntime.executor?.connected?.gateway,
        log: line => console.warn(line)
      }),
    readiness: () => {
      const home = agentHomeDir(agentRuntime)
      const host = hosts.get(agentRuntime.role)

      return {
        homeAccessible: Boolean(home && existsSync(home)),
        runtimeUsable: usable(),
        matrixIntakeWorking: Boolean(host?.ready) && !host?.degraded
      }
    }
  }
}

/**
 * Create target custody for an agent whose authoritative home may still be cloud. This does
 * not start a host, lease, listener or turn; placement continues to deny work until commit.
 */
async function materializeAgentHomeTarget(principal: string, signal: AbortSignal): Promise<void> {
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)
  const selectedRuntime = runtime

  if (!agentRuntime || !selectedRuntime || closing || agentRuntime.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  await waitForAgentSetup(agentRuntime.setup, signal)
  signal.throwIfAborted()

  if (closing || agentRuntime.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  let enrollment = enrollmentOf(agentRuntime)

  if (enrollment.state !== 'ready' || !enrollment.identity) {
    if (agentRuntime.operation || !account.identity()) {throw new Error('matrix_agent_busy')}
    agentRuntime.operation = true
    try {
      await account.enrollAgent(principal)
    } finally {
      agentRuntime.operation = false
    }
    signal.throwIfAborted()
    enrollment = enrollmentOf(agentRuntime)
  }

  const identity = enrollment.identity
  if (enrollment.state !== 'ready' || !identity || closing || agentRuntime.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  const home = reconcileAgentHome(agentRuntime, principal, identity, selectedRuntime)
  await mkdir(home, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
}

/**
 * Keeps this Mac's executor for an agent it holds without running answerable, so the platform still lists this Mac as a place
 * the agent can move to (a Mac the owner set up for it, or the target of a move). The credential lasts an hour and only a
 * running host renews it (credential-renewal.ts), so with no host it is rotated half an hour ahead of its expiry, and enrolled
 * again once it lapsed. `force` rotates now (the platform refused this Mac's catalog for lack of an active executor). Starts no
 * host, lease, listener or turn.
 */
async function keepAgentHomeExecutor(principal: string, signal: AbortSignal, force: boolean): Promise<void> {
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)

  if (!agentRuntime || closing || agentRuntime.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  // A running host renews its own executor (createCredentialRenewal).
  if (hosts.get(agentRuntime.role)) {
    return
  }

  const enrollment = enrollmentOf(agentRuntime)

  if (enrollment.state !== 'ready' || !enrollment.identity) {
    await materializeAgentHomeTarget(principal, signal)

    return
  }

  if (!force && enrollment.identity.expiresAt - Date.now() > MATRIX_CREDENTIAL_RENEWAL.leadMs) {
    return
  }

  signal.throwIfAborted()
  await account.renewAgentExecutor(principal)
}

/** True only when this process is opening the agent's authoritative Mac home. */
function atumInstructionsForMacHome(agentRuntime: MatrixAgentRuntime): boolean {
  const principal = cloudPrincipal(agentRuntime)
  const placement = principal ? agentHome?.service.view(principal) : null

  if (placement) {
    return placement.lives.kind === 'mac' && placement.lives.thisMac
  }

  return !isCloudAgent(agentRuntime) && agentHostedHere(agentRuntime) !== false
}

function placementConnectedModelAgent(
  agentRuntime: MatrixAgentRuntime,
  identity: NonNullable<MatrixEnrollment['identity']>,
  connection: MatrixHermesConnection
): MatrixConnectedModelsAgent {
  return {
    connected: agentRuntime.connectedModel ?? { provider: MATRIX_ATUM_PROVIDER, model: MATRIX_DEFAULT_MODEL },
    allowManagedCurrent: true,
    ...(agentRuntime.name ? { agentName: agentRuntime.name } : {}),
    forward: request => {
      if (!connection.pages || connection.signal.aborted) {throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)}
      return connection.pages(request)
    },
    isCurrent: () =>
      !closing &&
      !agentRuntime.closed &&
      enrollmentOf(agentRuntime).identity?.executorId === identity.executorId &&
      !connection.signal.aborted,
    // A background participant may never put a dialog on an unattended Mac. Any provider
    // requiring extra confirmation remains unavailable until the owner acts on that Mac.
    confirmCost: () => false,
    selected: model => {
      const own = model.provider !== MATRIX_MANAGED_ENDPOINT.id
      rememberOwnModel(identity.executorId, own, agentRuntime, own ? model : undefined)
      publish(state)
    }
  }
}

async function withPlacementConnection<T>(
  principal: string,
  signal: AbortSignal,
  write: boolean,
  run: (agent: MatrixConnectedModelsAgent, connection: MatrixHermesConnection) => Promise<T>
): Promise<T> {
  // Reads a connection catalog from what this Mac already holds; custody is created only for an agent this Mac is
  // (about to be) the home of, by the placement model's own materialize step.
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)
  const selectedRuntime = runtime
  const identity = agentRuntime ? enrollmentOf(agentRuntime).identity : undefined

  if (!agentRuntime || !selectedRuntime || !identity || agentRuntime.invocation || agentRuntime.setup) {
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.busy)
  }

  const execute = (connection: MatrixHermesConnection) =>
    run(placementConnectedModelAgent(agentRuntime, identity, connection), connection)
  const existing = agentRuntime.executor?.connected

  if (!write && existing?.pages && !existing.signal.aborted) {return execute(existing)}

  const release = await agentRuntime.lock.acquire('*', 'management', signal)
  try {
    signal.throwIfAborted()
    if (agentRuntime.invocation || agentRuntime.setup) {throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.busy)}

    const live = agentRuntime.executor?.connected
    if (live?.pages && !live.signal.aborted) {return execute(live)}

    return withMatrixHermes(
      selectedRuntime,
      {
        owner: identity.principal,
        executorId: identity.executorId,
        signal,
        home: agentHermesHome(agentRuntime, identity, selectedRuntime),
        sharedCodex: sharedCodexHere(),
        atumInstructions: atumInstructionsForMacHome(agentRuntime)
      },
      execute
    )
  } finally {
    release()
  }
}

async function placementConnectionCatalog(principal: string, signal: AbortSignal) {
  // The agent's own launch-time set-up holds the same backend slot as a management read; waiting
  // for it keeps an owner's "set this Mac up" from failing as busy for a few seconds after launch.
  const agentRuntime = allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)

  if (agentRuntime) {
    await waitForAgentSetup(agentRuntime.setup, signal)
    signal.throwIfAborted()
  }

  return withPlacementConnection(principal, signal, false, agent => listMatrixModelCatalog(agent))
}

async function applyPlacementConnectionChoice(
  principal: string,
  route: MatrixModelRoute,
  effort: 'low' | 'medium' | 'high' | 'max',
  signal: AbortSignal
) {
  return withPlacementConnection(principal, signal, true, async (agent, connection) => {
    const selected = await selectMatrixModelRoute(agent, route.id)
    if (selected.status !== 'applied') {
      return { status: 'unavailable' as const, reason: 'connection_needs_attention' as const }
    }

    await connection.api('/api/config', {
      config: { agent: { reasoning_effort: effort, atum_instructions: true } }
    })
    const readback = await listMatrixModelCatalog(agent)
    const current = readback.routes.find(candidate => candidate.current)

    return current?.id === route.id
      ? { status: 'applied' as const, provider: current.provider, model: current.model }
      : { status: 'unavailable' as const, reason: 'model_unavailable' as const }
  })
}

const executionPolicyLocalStates = new Map<string, boolean>()
const executionPolicyReenrollments = new Map<string, number>()
const executionPolicyRuntimeRestarts = new Set<string>()
const executionPolicyRuntimeRestarting = new Set<string>()
let executionPolicyReconcileScheduled = false

async function restartForExecutionPolicy(agent: MatrixAgentRuntime, principal: string): Promise<void> {
  holdOperation(agent, true)

  try {
    agent.continuous?.pause('offline')
    await stopHermesExecutor(agent)
    executionPolicyRuntimeRestarts.delete(principal)

    if (!closing && !agent.closed && executionPolicyLocal(agent) === 'enabled' && !isMovingAgent(agent)) {
      await startAssistantHermes(agent)
    }
  } finally {
    executionPolicyRuntimeRestarts.delete(principal)
    executionPolicyRuntimeRestarting.delete(principal)
    holdOperation(agent, false)
    scheduleExecutionPolicyReconcile()
    publish(state)
  }
}

function scheduleExecutionPolicyReconcile(): void {
  if (executionPolicyReconcileScheduled || closing) {
    return
  }

  executionPolicyReconcileScheduled = true
  setImmediate(() => {
    executionPolicyReconcileScheduled = false

    if (closing) {
      return
    }

    for (const agent of allAgents()) {
      const principal = cloudPrincipal(agent)

      if (!principal || !isCloudAgent(agent)) {
        continue
      }

      reconcileJobsHold(agent)

      const local = cloudAgentRunsLocally(agent)
      const previous = executionPolicyLocalStates.get(principal)
      executionPolicyLocalStates.set(principal, local)

      if (local) {
        const view = executionPolicies?.snapshot(principal)
        const enrollment = enrollmentOf(agent)

        if (
          executionPolicyLocal(agent) === 'enabled' &&
          enrollment.state === 'withdrawn' &&
          !agent.reenrolling &&
          view?.policy.source === 'saved' &&
          executionPolicyReenrollments.get(principal) !== view.policy.revision
        ) {
          executionPolicyReenrollments.set(principal, view.policy.revision)
          void reenrollAgent(agent, 'policy').then(result => {
            if (result !== 'started' && executionPolicyReenrollments.get(principal) === view.policy.revision) {
              executionPolicyReenrollments.delete(principal)
            }
          })
        } else if (executionPolicyRuntimeRestarts.has(principal)) {
          const busy = Boolean(
            agent.invocation ||
              agent.operation ||
              agent.starting ||
              agent.lock.holder ||
              agent.groupDemand > 0 ||
              agent.backgroundDemand > 0 ||
              agent.checkInDemand > 0
          )

          if (!busy && !executionPolicyRuntimeRestarting.has(principal)) {
            executionPolicyRuntimeRestarting.add(principal)
            void restartForExecutionPolicy(agent, principal).catch(() =>
              console.warn('[Matrix] execution policy: local runtime not restarted')
            )
          }
        } else if (matrixExecutionPolicyStartsLocalReadiness(previous, local)) {
          agent.readiness?.start()
        }

        agent.localTurns?.kick()
      } else if (previous !== false && (!executionPolicyLocalAuthority(agent) || !agent.invocation)) {
        void quiesceForExecutionPolicy(agent).catch(() =>
          console.warn('[Matrix] execution policy: local writers not stopped')
        )
      }
    }

    scheduleContinuousListening()
    publish(state)
  })
}

/**
 * The roster preserves the cloud handoff route. Legacy cloud agents lose their local writers;
 * saved H-F policy agents keep only the Mac path selected by the provider's exact lease.
 */
function applyAnswering(roster: MatrixAgentDefinitionRecord[]): void {
  // A placed create that the platform retired, removed or tombstoned never reaches the switch:
  // the read drops it instead of keeping the id until sign-out.
  placedAgents.retain(roster)
  hostRuntimeAgents.clear()
  for (const agent of roster) {
    if (agent.status === 'active' && agent.runtime === 'hermes') hostRuntimeAgents.add(agent.principal)
  }

  const next = new Set(
    roster.filter(agent => agent.status === 'active' && agent.answering === 'cloud').map(agent => agent.principal)
  )

  // The roster now shows the switch a placed create was waiting for: the ordinary saved-policy
  // and lease decision owns it again (cloud-agent-placement.ts `matrixPlacedCloudOnly`).
  for (const principal of next) {
    placedAgents.delete(principal)
  }

  const added = [...next].filter(principal => !cloudAgents.has(principal))
  const removed = [...cloudAgents].filter(principal => !next.has(principal))

  for (const principal of removed) {
    placedAgents.delete(principal)
    cloudAgents.delete(principal)
    executionPolicyLocalStates.delete(principal)
    executionPolicyReenrollments.delete(principal)
    executionPolicyRuntimeRestarts.delete(principal)

    const agentRuntime = allAgents().find(each => cloudPrincipal(each) === principal)
    const listening = agentRuntime ? executionPolicyListening.get(agentRuntime) : undefined
    listening?.opening?.abort()

    // Back to a plain local agent (the off switch, or a move home): its jobs are no longer held.
    if (agentRuntime) {
      reconcileJobsHold(agentRuntime)
    }

    // The off switch deletes the saved policy, and revisions restart at 0 for the default one. The
    // cache never accepts a read that regresses a revision, so it forgets this agent's history and
    // reads the platform's answer fresh (this device's own off already replaced the entry).
    if (executionPolicies) {
      executionPolicies.reset(principal)
      void executionPolicies.refresh(principal, true)
    }

    if (listening?.retry) {
      clearTimeout(listening.retry)
    }

    if (agentRuntime) {
      executionPolicyListening.delete(agentRuntime)
      agentRuntime.listener.drainAndStop('cancelled')
      void hosts.get(agentRuntime.role)?.queue.command({ kind: 'watchInvocations', watch: null }).catch(() => {})
    }
  }

  for (const principal of added) {
    cloudAgents.add(principal)
    const agentRuntime = allAgents().find(each => cloudPrincipal(each) === principal)

    // Its running backend may keep a ticker from before: held until this Mac answers for it.
    if (agentRuntime) {
      reconcileJobsHold(agentRuntime)
    }

    const local = cloudAgentRunsLocally(agentRuntime)
    executionPolicyLocalStates.set(principal, local)

    if (agentRuntime && !local) {
      void quiesceForCloud(agentRuntime).catch(() => console.warn('[Matrix] cloud agent: local writers not stopped'))
    } else if (agentRuntime) {
      agentRuntime.listener.drainAndStop('cancelled')
      void hosts.get(agentRuntime.role)?.queue.command({ kind: 'watchInvocations', watch: null }).catch(() => {})

      if (agentRuntime.executor || agentRuntime.starting) {
        executionPolicyRuntimeRestarts.add(principal)
        agentRuntime.cronListening?.()
        agentRuntime.cronListening = undefined
        agentRuntime.checkInListening?.()
        agentRuntime.checkInListening = undefined

        if (agentRuntime === defaultAgent) {
          checkInGateway = undefined
        }
      }

      agentRuntime.readiness?.recheck()
    }
  }

  for (const principal of [...added, ...removed]) {
    allAgents()
      .find(each => cloudPrincipal(each) === principal)
      ?.readiness?.recheck()
  }

  if (next.size) {
    void deviceIdentity
      ?.activate()
      .then(() => {
        // Activation re-reads this Mac's enrollment, so the registry may have changed.
        executionDeviceNames.invalidate()
        executionPolicies?.refreshAll()
        scheduleExecutionPolicyReconcile()
        scheduleContinuousListening()
      })
      .catch(() => console.warn('[Device] device service not started'))
  }

  scheduleContinuousListening()
}

/** A cloud question's origin assertion while this Mac is already enrolled for the device service.
 * A Mac that is not enrolled sends the question without one: sign-in must not ask for Touch ID,
 * and a Mac action that needs the device service asks when it is actually requested. */
async function cloudOrigin(
  command: ReturnType<typeof matrixTurnQuestion>,
  agentRuntime: MatrixAgentRuntime
): Promise<MatrixOriginAssertion | undefined> {
  const agentUserId = agentRuntime.userId

  if (!deviceIdentity || !agentUserId) {
    return undefined
  }

  const content = matrixTurnContent({
    body: command.body,
    turnId: command.turnId,
    ...(command.handoff ? { handoff: true as const } : {}),
    ...(command.replyTo ? { replyTo: command.replyTo } : {})
  })

  const origin = await deviceIdentity.originFor(
    { transactionId: command.transactionId, roomId: command.roomId, agentUserId, content },
    { enroll: false }
  )

  return origin ?? undefined
}

/** Moves one agent to the cloud from this Mac, with the owner's confirmation (migration.ts). */
/** The trial offer main last read and showed, for the account it was read for (trialAccept). */
let trialShown: { owner: string; offer: CloudTrialOffer } | undefined
/** The last access fact logged per account, so the line appears when the fact changes. */
const lastCloudAccess = new CloudAccessLog()

function moveAgentToCloud(agentRuntime: MatrixAgentRuntime): Promise<MigrationOutcome> {
  const principal = cloudPrincipal(agentRuntime)

  // The default assistant uses the same owner-bound, multi-Mac home migration as every other
  // agent. Keeping it local would make the first assistant the only one that disappears when the
  // person's Macs sleep.
  if (!principal || !cloudEnrollments || isCloudAgent(agentRuntime)) {
    return Promise.reject(new Error('matrix_agent_unavailable'))
  }

  if (config.cloudMigrationTestAgents?.includes(principal)) {
    const abort = new AbortController(),
      generation = moveGeneration

    moveAborts.add(abort)
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(90 * 60_000)])

    return (async (): Promise<MigrationOutcome> => {
      // Nothing has stopped here yet: a refusal (no entitlement, a declined Touch ID) is an outcome
      // that leaves the agent on this Mac, so the renderer can say so and offer the trial.
      try {
        await deviceIdentity!.enroll(signal)
        await cloudEnrollments!.begin(principal, signal)
        await cloudEnrollments!.waitTrusted(principal, signal)
      } catch (error) {
        const code = deviceEnrollmentCode(error)
        console.warn(`[Device] move of ${principal.slice(0, 8)} stopped at cloud enrollment: ${code}`)

        return { state: 'failed', step: 'cloud_enrollment', code }
      }

      const deadline = Date.now() + 30_000

      while (!deviceIdentity!.connection()?.session()) {
        signal.throwIfAborted()

        if (generation !== moveGeneration || Date.now() > deadline) {
          throw Error('matrix_migration_device_offline')
        }

        await new Promise(resolve => setTimeout(resolve, 100))
      }

      signal.throwIfAborted()
      const local = migrationLocalAgent(principal, agentRuntime.userId ?? '')

      if (!local || generation !== moveGeneration) {
        throw Error('matrix_migration_account_changed')
      }

      return homeMigrationForOwner()!.client.start(local, signal)
    })().finally(() => {
      moveAborts.delete(abort)
    })
  }

  let move = agentMoves.get(principal)

  if (!move) {
    /** The room continuous listening was on in, put back if the move does not happen. */
    let continuousRoom: string | undefined
    const generation = moveGeneration

    move = new AgentMigration({
      agentPrincipal: principal,
      agentName: agentRuntime.name ?? 'Atum',
      writers: () => ({
        executor: enrollmentOf(agentRuntime).state === 'ready',
        cron: runsJobsHere(),
        lease: Boolean(agentRuntime.lease && agentRuntime.lease.current.state !== 'stopped'),
        listening: Boolean(agentRuntime.continuous?.enabled) || agentRuntime.listener.snapshot()?.state === 'listening',
        gateways: []
      }),
      quiesce: async () => {
        continuousRoom = agentRuntime.continuous?.enabled ? agentRuntime.continuous.roomId : undefined
        movingAgents.add(principal)
        await quiesceForCloud(agentRuntime)
        await requireConversationSnapshot(conversations.get(agentRuntime)?.activity, () =>
          conversationPending(agentRuntime)
        )
      },
      restore: async () => {
        // Signed out meanwhile: the agents are gone with the account; nothing to put back.
        if (generation !== moveGeneration || agentRuntime.closed) {
          return
        }

        movingAgents.delete(principal)
        const binding = continuousRoom ? continuousBinding(continuousRoom, agentRuntime) : undefined

        // Continuous listening comes back as the owner left it (the quiesce turned it off).
        if (continuousRoom && binding && !agentRuntime.closed) {
          try {
            agentRuntime.continuous?.enable(binding, continuousRoom)
          } catch {
            console.warn('[Matrix] cloud move: continuous listening not restored')
          }
        }

        // Its host, lease and turns come back through the gate (setUpAgent restarts the host). A
        // recheck of a ready agent only runs the watch, so the gate is started again.
        agentRuntime.readiness?.start()
        agentRuntime.localTurns?.kick()
        publish(state)
      },
      hermesHome: () => {
        const identity = enrollmentOf(agentRuntime).identity

        if (!runtime) {
          return null
        }

        if (identity) {
          return agentHermesHome(agentRuntime, identity, runtime)
        }

        try {
          return agentRuntime.principal ? (account.retainedAgentHermes(agentRuntime.principal)?.home ?? null) : null
        } catch {
          return null
        }
      },
      exportHome: (home, archive) => {
        if (!runtime) {
          return Promise.reject(new Error('matrix_runtime_unavailable'))
        }

        return exportAgentHome(runtime, home, archive)
      },
      beginCloudEnrollment: async signal => {
        const attempt = await cloudEnrollments!.beginAttempt(principal, signal)

        return { enrollmentId: attempt.enrollment.enrollmentId, created: attempt.created }
      },
      waitCloudEnrollment: async signal => {
        await cloudEnrollments!.waitTrusted(principal, signal)
      },
      revokeCloudEnrollment: enrollmentId =>
        cloudEnrollments!.revoke(enrollmentId, AbortSignal.timeout(30_000)).then(() => undefined),
      confirm: async plan => {
        const copy = migrationConfirmCopy(deviceLocale(), plan)

        const options = {
          type: 'question' as const,
          buttons: [copy.move, copy.cancel],
          defaultId: 1,
          cancelId: 1,
          message: copy.title,
          detail: copy.detail
        }

        const { response } =
          ui && !ui.isDestroyed() ? await dialog.showMessageBox(ui, options) : await dialog.showMessageBox(options)

        return response === 0
      },
      switchToCloud: async signal => {
        await switchAnsweringToCloud({
          savedPolicy: agentHasSavedExecutionPolicy(principal),
          switchAnswering: () =>
            setAgentAnswering(s1Call, { agentPrincipal: principal, mode: 'cloud', expectedMode: 'local' }, signal)
        })

        // Signed out meanwhile: the next sign-in reads it from the roster.
        if (generation !== moveGeneration) {
          return
        }

        // Effective now, before the roster says so: nothing local may start for it again.
        cloudAgents.add(principal)
        movingAgents.delete(principal)
        agentRoster.request()
      },
      stagingDir: path.join(app.getPath('userData'), 'device', 'migration'),
      store: outcomeStore,
      log: line => console.warn(line)
    })

    agentMoves.set(principal, move)
  }

  const abort = new AbortController()
  moveAborts.add(abort)

  return move.run(AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60_000)])).finally(() => {
    moveAborts.delete(abort)
  })
}

/**
 * The cloud-agent requests main answers (renderer: Settings › Device and the agent menu): this
 * Mac's device service, enrolling it (Touch ID), and moving an agent to the cloud.
 */
async function cloudAgentRequest(request: {
  action?: unknown
  principal?: unknown
  roomId?: unknown
  eventId?: unknown
  offerVersion?: unknown
  disclosureVersion?: unknown
}): Promise<
  | MatrixAgentServiceStatus
  | MatrixCloudAgentStatus
  | { device: MatrixDevicePresence }
  | MatrixCloudMoveOutcome
  | MatrixCloudStopOutcome
  | MatrixOwnerReaderStatus
  | MatrixCloudTrialOffer
  | MatrixCloudTrialAccepted
  | MatrixCloudAccess
  | null
> {
  if (request.action === 'serviceStatus') {
    if (closing || !account.identity() || typeof request.principal !== 'string') {
      throw new Error('matrix_not_ready')
    }

    const scope = account.appScope()

    if (!scope) {
      throw new Error('matrix_not_ready')
    }

    const status = parseAgentServiceStatus(
      await s1Call({ kind: 'agent-service-status', agentPrincipal: request.principal }, AbortSignal.timeout(15_000)),
      request.principal
    )

    const current = account.appScope()

    if (closing || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_not_ready')
    }

    return status
  }

  if (request.action === 'cloudAccess') {
    const owner = account.identity()?.userId

    if (closing || !owner) {
      throw new Error('matrix_not_ready')
    }

    const access = parseCloudAccess(await s1Call({ kind: 'cloud-status' }, AbortSignal.timeout(15_000)))

    if (lastCloudAccess.changed(owner, access)) {
      console.warn(
        `[Cloud] access effective=${access.effective}${access.effective === 'none' ? ` reason=${access.reason ?? 'unknown'}` : ''}`
      )
    }

    return access
  }

  if (!deviceIdentity || !cloudEnrollments || closing || !account.identity()) {
    throw new Error('matrix_not_ready')
  }

  if (request.action === 'status') {
    const scope = account.appScope()
    let hasEnrolledMac: boolean | undefined

    if (cloudAgents.size) {
      try {
        hasEnrolledMac = await hasEnrolledCloudMac(s1Call, AbortSignal.timeout(10_000))
      } catch {
        // Unknown is not "no Mac". The local device controls remain usable.
      }
    }

    const current = account.appScope()

    if (closing || !scope || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_not_ready')
    }

    return {
      device: deviceIdentity.presence(),
      cloudAgents: [...cloudAgents],
      ...(hasEnrolledMac === undefined ? {} : { hasEnrolledMac })
    }
  }

  if (request.action === 'readerStatus' || request.action === 'readerEnroll') {
    const scope = account.appScope()
    let reader: MatrixOwnerReaderStatus['state']

    try {
      reader =
        request.action === 'readerEnroll'
          ? await cloudEnrollments.enrollReader(AbortSignal.timeout(30_000))
          : await cloudEnrollments.reader(AbortSignal.timeout(15_000))
    } catch (error) {
      if (request.action === 'readerEnroll') {
        console.warn(`[Cloud] owner reader not enrolled: ${deviceEnrollmentCode(error)}`)
      }

      throw error
    }

    const current = account.appScope()

    if (closing || !scope || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_not_ready')
    }

    // Just made (or found pending): the trust poll checks often from now on, hands the window to
    // this Mac, cross-signs the reader and compares its SAS (checkOwnerReaderTrust).
    if (request.action === 'readerEnroll' && (reader === 'provisioning' || reader === 'awaiting_trust')) {
      refreshOwnerReaderTrust()
    }

    return { state: reader }
  }

  if (request.action === 'trialOffer') {
    const owner = account.identity()?.userId
    const offer = parseCloudTrial(await s1Call({ kind: 'cloud-status' }, AbortSignal.timeout(15_000)))
    trialShown = owner && offer ? { owner, offer } : undefined

    return offer ? shownCloudTrial(offer) : null
  }

  if (request.action === 'trialAccept') {
    const owner = account.identity()
    const { offerVersion, disclosureVersion } = request

    if (
      !owner ||
      !Number.isSafeInteger(offerVersion) ||
      !Number.isSafeInteger(disclosureVersion) ||
      (offerVersion as number) < 1 ||
      (disclosureVersion as number) < 1
    ) {
      throw new Error('matrix_command_invalid')
    }

    try {
      // Only the offer main itself read and showed this account, still offered now term for term,
      // and confirmed in main's own dialog: the window's versions alone never accept terms.
      const shown = trialShown

      if (
        !shown ||
        shown.owner !== owner.userId ||
        shown.offer.offerVersion !== offerVersion ||
        shown.offer.disclosureVersion !== disclosureVersion
      ) {
        throw new Error('cloud_trial_offer_changed')
      }

      const current = parseCloudTrial(await s1Call({ kind: 'cloud-status' }, AbortSignal.timeout(15_000)))

      if (
        !current ||
        !sameCloudTrial(current, shown.offer) ||
        !current.startableNow ||
        (current.status !== 'eligible' && current.status !== 'declined')
      ) {
        throw new Error('cloud_trial_offer_changed')
      }

      const copy = cloudTrialConfirmCopy(deviceLocale(), current)

      const options = {
        type: 'question' as const,
        buttons: [copy.start, copy.cancel],
        defaultId: 1,
        cancelId: 1,
        message: copy.title,
        detail: copy.detail
      }

      const { response } =
        ui && !ui.isDestroyed() ? await dialog.showMessageBox(ui, options) : await dialog.showMessageBox(options)

      if (response !== 0 || account.identity()?.userId !== owner.userId) {
        return { status: 'cancelled' as const }
      }

      const status = await acceptCloudTrial(
        s1Call,
        { ownerUserId: owner.userId, offerVersion: current.offerVersion, disclosureVersion: current.disclosureVersion },
        AbortSignal.timeout(30_000)
      )

      trialShown = undefined
      console.warn(`[Cloud] trial accepted: ${status}`)

      return { status }
    } catch (error) {
      console.warn(`[Cloud] trial not started: ${deviceEnrollmentCode(error)}`)
      throw error
    }
  }

  if (request.action === 'stopTurn' && typeof request.roomId === 'string' && typeof request.eventId === 'string') {
    const scope = account.appScope()
    const agent = requireRoomAgent(request.roomId)
    const principal = cloudPrincipal(agent)

    if (!isCloudAgent(agent) || !principal) {
      throw new Error('matrix_agent_unavailable')
    }

    const outcome = hostRuntimeAgents.has(principal)
      ? await requestHostStop(config.domain!.resource, principal, request.roomId, request.eventId,
          AbortSignal.timeout(30_000), (url, init) => session.defaultSession.fetch(url, init))
      : await stopCloudTurn(s1Call, principal, request.roomId, request.eventId, AbortSignal.timeout(30_000))
    const current = account.appScope()

    if (closing || !scope || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_not_ready')
    }

    return outcome
  }

  if (request.action === 'moveToCloud' && typeof request.principal === 'string') {
    const agentRuntime = allAgents().find(each => cloudPrincipal(each) === request.principal)

    if (!agentRuntime) {
      throw new Error('matrix_agent_unavailable')
    }

    return moveAgentToCloud(agentRuntime)
  }

  throw new Error('matrix_command_invalid')
}

function petScopeToken() {
  const scope = account?.appScope()

  return scope ? `${scope.accountKey}:${scope.generation}` : undefined
}

async function privatePetIntentSurface(
  agentRuntime: MatrixAgentRuntime,
  roomId: string,
  humanHost: Host,
  agentHost: Host,
  signal: AbortSignal,
  excluded = false
): Promise<boolean> {
  if (!MATRIX_PET_INTENT_PLAYBACK || excluded) {
    return false
  }

  await requireAssistantRoom(roomId, humanHost, agentHost)
  signal.throwIfAborted()
  const scope = petScopeToken()
  const enrolled = enrollmentOf(agentRuntime).identity

  if (
    !scope ||
    !pets ||
    !enrolled ||
    !agentRuntime.assistantId ||
    enrolled.agentPrincipal !== agentRuntime.agentPrincipal
  ) {
    return false
  }

  const current = () =>
    !signal.aborted &&
    !closing &&
    state.state === 'ready' &&
    petScopeToken() === scope &&
    hosts.get('human') === humanHost &&
    hosts.get(agentRuntime.role) === agentHost &&
    !agentRuntime.closed &&
    enrollmentOf(agentRuntime).identity?.executorId === enrolled.executorId

  const petSurface = await readMatrixPetIntentSurface({
    owner: enrolled.principal,
    target: { scope, agent: enrolled.agentPrincipal },
    privateRoom: true,
    current,
    read: target => pets.read(target)
  })

  signal.throwIfAborted()

  if (!current()) {
    throw new Error('matrix_agent_unavailable')
  }

  await requireAssistantRoom(roomId, humanHost, agentHost)

  return petSurface
}

const MATRIX_PET_HATCH_PROGRESS = 'matrix:pet:hatch-progress'
const MATRIX_PET_OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MATRIX_PET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MATRIX_PET_HATCH_INTENT = 'matrix-pet-hatch:'
const MATRIX_PET_HATCH_QUARANTINE = 'matrix-pet-hatch-quarantine:'

interface MatrixPetHatchIntent {
  version: 1
  accountKey: string
  target: MatrixPetTarget
  operationId: string
  displayName: string
  description: string
  bundle: ReturnType<typeof parsePetBundle>
  offerId: string
  offerVersion: number
  purchaseKey?: string
  creditEntitlementId?: string
  expectedRevision: number
  desiredScale: number
  bindingConflict?: true
  parked?: true
}
interface MatrixPetHatchRun {
  abort: AbortController
  accountKey: string
  role: string
  proxyKey: string
  token?: string
  connection?: MatrixHermesConnection
}
const matrixPetHatches = new Map<string, MatrixPetHatchRun>()
const matrixPetHatchKeys = new Map<string, MatrixPetHatchRun>()
const matrixPetHatchTargets = new Set<string>()
const matrixPetRecoveries = new MatrixPetRecoveryFlights<MatrixPetView>()
const matrixPetQuarantines = new Set<string>()

function petTargetFacts() {
  return {
    scope: account.appScope(),
    token: petScopeToken(),
    agents: allAgents(),
    identity: (agent: MatrixAgentRuntime) => enrollmentOf(agent).identity
  }
}

/** A hatch, or resuming one: the agent must be idle, with its Hermes runtime and Atum's model. */
function matrixPetHatchTarget(target: MatrixPetTarget) {
  return resolvePetHatchTarget(target, { ...petTargetFacts(), runtime, managedModel: Boolean(managedModel) })
}

/** Reading or discarding this Mac's record of an unfinished hatch starts nothing: it answers
 * while the agent runs its launch model check (pet-hatch-target.ts). */
function matrixPetRecoveryTarget(target: MatrixPetTarget) {
  return resolvePetRecoveryTarget(target, petTargetFacts())
}

function petHatchIntentKey(accountKey: string) {
  return `${MATRIX_PET_HATCH_INTENT}${accountKey}`
}

function validMatrixPetText(
  value: unknown,
  maximumCharacters: number,
  maximumBytes: number,
  required: boolean
): value is string {
  if (
    typeof value !== 'string' ||
    (required && !value.trim()) ||
    value.includes('\0') ||
    value.length > maximumCharacters ||
    (maximumCharacters === 100 && Array.from(value).some(character => character.charCodeAt(0) < 32))
  ) {
    return false
  }

  const encoded = new TextEncoder().encode(value)

  if (encoded.byteLength > maximumBytes) {
    return false
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(encoded) === value
  } catch {
    return false
  }
}

function validMatrixPetPhoto(value: unknown): value is MatrixPetPhoto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const photo = value as MatrixPetPhoto

  if (!['image/png', 'image/jpeg', 'image/webp'].includes(photo.mimeType) || typeof photo.dataUrl !== 'string') {
    return false
  }

  const prefix = `data:${photo.mimeType};base64,`

  if (!photo.dataUrl.startsWith(prefix)) {
    return false
  }

  const encoded = photo.dataUrl.slice(prefix.length)

  if (!encoded || encoded.length > 4_194_304 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    return false
  }

  const bytes = Buffer.from(encoded, 'base64')

  if (!bytes.length || bytes.length > 3 * 1_024 * 1_024 || bytes.toString('base64') !== encoded) {
    return false
  }

  const image = nativeImage.createFromBuffer(bytes)
  const size = image.getSize()

  return !image.isEmpty() && size.width > 0 && size.height > 0 && size.width <= 4096 && size.height <= 4096
}

function saveMatrixPetHatchIntent(intent: MatrixPetHatchIntent) {
  if (!outcomeStore) {
    throw new Error('matrix_pet_unavailable')
  }

  outcomeStore.setItem(petHatchIntentKey(intent.accountKey), JSON.stringify(intent))
}

function readMatrixPetHatchIntent(accountKey: string): MatrixPetHatchIntent | undefined {
  if (!outcomeStore) {
    return undefined
  }

  const raw = outcomeStore.getItem(petHatchIntentKey(accountKey))

  if (!raw) {
    return undefined
  }

  try {
    const value = JSON.parse(raw) as MatrixPetHatchIntent

    if (
      value.version !== 1 ||
      value.accountKey !== accountKey ||
      !MATRIX_PET_OPERATION.test(value.operationId) ||
      !value.target ||
      typeof value.target.scope !== 'string' ||
      typeof value.target.agent !== 'string' ||
      typeof value.displayName !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.offerId !== 'string' ||
      !Number.isSafeInteger(value.offerVersion) ||
      value.offerVersion < 0 ||
      !(value.purchaseKey === undefined || MATRIX_PET_OPERATION.test(value.purchaseKey)) ||
      !(value.creditEntitlementId === undefined || MATRIX_PET_UUID.test(value.creditEntitlementId)) ||
      (value.creditEntitlementId === undefined && (!value.offerId || value.offerVersion < 1)) ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 ||
      typeof value.desiredScale !== 'number' ||
      !Number.isFinite(value.desiredScale) ||
      value.desiredScale < 0.1 ||
      value.desiredScale > 3 ||
      !(value.bindingConflict === undefined || value.bindingConflict === true) ||
      !(value.parked === undefined || value.parked === true)
    ) {
      throw new Error()
    }

    return { ...value, bundle: parsePetBundle(value.bundle) }
  } catch {
    throw new Error('matrix_pet_recovery_invalid')
  }
}

function clearMatrixPetHatchIntent(accountKey: string) {
  outcomeStore?.removeItem(petHatchIntentKey(accountKey))
}

function quarantineMatrixPetHatchIntent(accountKey: string) {
  matrixPetQuarantines.add(accountKey)
  quarantineMatrixPetRecord(outcomeStore, petHatchIntentKey(accountKey), `${MATRIX_PET_HATCH_QUARANTINE}${accountKey}`)
}

/** Opens a single-use local Hermes gateway solely for a hatch. The managed
 * proxy key remains main-process-only; neither the renderer nor the persisted
 * hatch intent can address the proxy. */
async function withMatrixPetHatchGateway<T>(
  target: MatrixPetTarget,
  operationId: string,
  run: (
    connection: MatrixHermesConnection,
    managedHatch: { baseUrl: string; apiKey: string; operationId: string },
    signal: AbortSignal
  ) => Promise<T>
): Promise<T> {
  if (!MATRIX_PET_OPERATION.test(operationId) || matrixPetHatches.has(operationId)) {
    throw new Error('matrix_pet_invalid')
  }

  const targetInfo = matrixPetHatchTarget(target)
  const targetKey = `${targetInfo.scope.accountKey}:${target.agent}`

  if (matrixPetHatchTargets.has(targetKey)) {
    throw new Error('matrix_pet_busy')
  }

  const abort = new AbortController()

  const record: MatrixPetHatchRun = {
    abort,
    accountKey: targetInfo.scope.accountKey,
    role: targetInfo.agent.role,
    proxyKey: randomUUID()
  }

  matrixPetHatches.set(operationId, record)
  matrixPetHatchKeys.set(record.proxyKey, record)
  matrixPetHatchTargets.add(targetKey)

  try {
    return await withMatrixHermes(
      targetInfo.selectedRuntime,
      {
        owner: targetInfo.identity.principal,
        executorId: targetInfo.identity.executorId,
        signal: abort.signal,
        home: agentHermesHome(targetInfo.agent, targetInfo.identity, targetInfo.selectedRuntime),
        sharedCodex: sharedCodexHere()
      },
      async connection => {
        record.connection = connection

        const emit = (progress: MatrixPetHatchProgress) => {
          if (!closing && ui && !abort.signal.aborted) {
            ui.webContents.send(MATRIX_PET_HATCH_PROGRESS, progress)
          }
        }

        const generateEvents = connection.gateway.on<{
          token?: unknown
          count?: unknown
          phase?: unknown
          opId?: unknown
          index?: unknown
        }>('pet.generate.progress', event => {
          const value = event.payload

          if (!value || value.opId !== operationId) {
            return
          }

          if (typeof value.token === 'string') {
            record.token = value.token
          }

          if (['designing', 'rendering_previews', 'ready'].includes(value.phase as string)) {
            emit({
              operationId,
              phase: value.phase as MatrixPetHatchProgress['phase'],
              ...(Number.isSafeInteger(value.index) ? { index: value.index as number } : {}),
              ...(Number.isSafeInteger(value.count) ? { count: value.count as number } : {})
            })
          }
        })

        const hatchEvents = connection.gateway.on<{ event?: unknown; phase?: unknown; cancelToken?: unknown }>(
          'pet.hatch.progress',
          event => {
            const value = event.payload

            if (
              !value ||
              value.cancelToken !== operationId ||
              !['rendering', 'validating', 'publishing'].includes(value.phase as string)
            ) {
              return
            }

            emit({ operationId, phase: value.phase as MatrixPetHatchProgress['phase'] })
          }
        )

        try {
          return await run(
            connection,
            { baseUrl: managedModel!.baseUrl, apiKey: record.proxyKey, operationId },
            abort.signal
          )
        } catch (error) {
          emit({ operationId, phase: 'failed' })
          throw error
        } finally {
          generateEvents()
          hatchEvents()
          record.connection = undefined
        }
      }
    )
  } finally {
    matrixPetHatches.delete(operationId)
    matrixPetHatchKeys.delete(record.proxyKey)
    matrixPetHatchTargets.delete(targetKey)
  }
}

async function completeMatrixPetHatch(
  intent: MatrixPetHatchIntent,
  explicitAdopt = false,
  allowPurchase = false
): Promise<MatrixPetView> {
  const scope = account.appScope()

  if (!scope || scope.accountKey !== intent.accountKey || !pets || !store) {
    throw new Error('matrix_pet_recovering')
  }

  const target = { scope: petScopeToken() ?? '', agent: intent.target.agent }

  if (!target.scope) {
    throw new Error('matrix_pet_recovering')
  }

  try {
    intent = await recoverMatrixPetCredit(
      intent,
      {
        save: saveMatrixPetHatchIntent,
        clear: clearMatrixPetHatchIntent,
        resume: (key, terms) => store!.resumePrepared(key, terms)
      },
      allowPurchase
    )
  } catch (error) {
    if (String(error).includes('matrix_pet_recovery_needs_confirmation')) {
      saveMatrixPetHatchIntent({ ...intent, parked: true })
    }

    throw error
  }

  const creditEntitlementId = intent.creditEntitlementId!

  let created: AtumPersonalPet

  try {
    created = await account.publishPersonalPet(
      {
        requestId: intent.operationId,
        creditEntitlementId,
        displayName: intent.displayName,
        description: intent.description,
        bundle: intent.bundle
      },
      AbortSignal.timeout(60_000)
    )
  } catch (error) {
    // The Store result is terminal and the credit is now durable. Never start
    // another purchase from lifecycle recovery; retain the artifact for an
    // explicit foreground retry instead.
    if (matrixPetPublicationNeedsAttention(error)) {
      saveMatrixPetHatchIntent({ ...intent, parked: true })
    }

    throw error
  }

  // This is intentionally the revision observed at the person's confirmation,
  // not a fresh read after upload. A second device's later explicit choice must
  // win; publication remains in their private library for an explicit adopt.
  let revision = intent.expectedRevision
  let scale = intent.desiredScale

  if (explicitAdopt) {
    const current = await pets.read(target)

    if (current.freshness !== 'current') {
      throw new Error('matrix_pet_unavailable')
    }

    revision = current.selection.revision
    scale = current.selection.pet?.scale ?? scale
  }

  let result: MatrixPetView

  try {
    result = await pets.write(target, revision, {
      ref: { kind: 'personal', pet_id: created.pet_id },
      enabled: true,
      scale
    })
  } catch (error) {
    if (String(error).includes('conflict')) {
      const current = await pets.read(target).catch(() => undefined)

      if (current?.selection.pet?.ref?.kind === 'personal' && current.selection.pet.ref.pet_id === created.pet_id) {
        clearMatrixPetHatchIntent(intent.accountKey)

        return current
      }

      saveMatrixPetHatchIntent({ ...intent, bindingConflict: true })
    }

    throw error
  }

  clearMatrixPetHatchIntent(intent.accountKey)

  return result
}

/** A paid hatch is never abandoned because the UI closed. Store's own journal
 * settles the debit; this encrypted artifact record resumes only publishing
 * and the explicit agent binding on the next authenticated foreground. */
function resumeMatrixPetHatch(): Promise<void> {
  const scope = account.appScope()
  let intent: MatrixPetHatchIntent | undefined

  try {
    intent = scope && readMatrixPetHatchIntent(scope.accountKey)
  } catch {
    if (scope) {
      quarantineMatrixPetHatchIntent(scope.accountKey)
    }

    return Promise.resolve()
  }

  if (!intent || intent.bindingConflict || intent.parked) {
    return Promise.resolve()
  }

  return matrixPetRecoveries.background(intent.accountKey, () => completeMatrixPetHatch(intent))
}

function runMatrixPetHatch(intent: MatrixPetHatchIntent, explicitAdopt = false, allowPurchase = false) {
  return matrixPetRecoveries.run(intent.accountKey, () => completeMatrixPetHatch(intent, explicitAdopt, allowPurchase))
}

/** The original/root custody runtime: its executor, lease, turn lock, local turns, listener,
 * scheduled posts and view state (agent-runtime.ts). Its own-model flag is kept per
 * executor across launches, read once per model check and never on a publish. */
const defaultAgent = new MatrixAgentRuntime('agent')

/** Cached authenticated platform role, not a preference or a storage selector. */
let productDefaultPrincipal: string | undefined

function productAgent(): MatrixAgentRuntime | undefined {
  // A domain account needs its authoritative role before a no-room action can
  // target anyone. A failed cold roster read must not silently choose the old root.
  if (productDefaultPrincipal === undefined && account?.appScope()) {
    return undefined
  }

  return matrixDefaultRuntime(productDefaultPrincipal, defaultAgent, allAgents())
}

function requireProductAgent(): MatrixAgentRuntime {
  const selected = productAgent()

  if (!selected || selected.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  return selected
}

/** A runtime's enrollment: the account's own for the default agent, its agent slot otherwise. */
function enrollmentOf(runtime: MatrixAgentRuntime): MatrixEnrollment {
  if (!account) {
    return { state: 'absent', identity: null }
  }

  return runtime.principal === undefined ? account.enrollment() : account.agentEnrollment(runtime.principal)
}

/** Published execution readiness never revives a withdrawn enrollment from a
 * cached ready host or a watch that has not reached its next probe yet. */
function readinessOf(agentRuntime: MatrixAgentRuntime) {
  const previous = state.agents?.find(agent => agent.principal === agentRuntime.agentPrincipal)?.readiness

  return projectMatrixEnrollmentReadiness(enrollmentOf(agentRuntime), agentRuntime.readiness?.current, previous)
}

/** The person's other agents on this Mac, by agent principal, each with its own runtime
 * ( §2.1). The default agent is never in it. */
const agents = new Map<string, MatrixAgentRuntime>()
const agentTaskControls = new WeakMap<MatrixAgentRuntime, MatrixAgentTaskControls>()

const agentAvatars = new MatrixAgentAvatarProjection<MatrixAgentRuntime>({
  allowLocal: !app.isPackaged,
  changed: () => publish(state)
})

function controlsForAgentTask(agentRuntime: MatrixAgentRuntime): MatrixAgentTaskControls {
  let controls = agentTaskControls.get(agentRuntime)

  if (!controls) {
    controls = new MatrixAgentTaskControls(agentRuntime.store)
    agentTaskControls.set(agentRuntime, controls)
  }

  return controls
}

/** Every agent runtime, the default first. */
function allAgents(): MatrixAgentRuntime[] {
  return [defaultAgent, ...agents.values()]
}

/** The agent runtime an SDK host role belongs to; none for the human and app hosts. */
function agentOfRole(role: MatrixHostRole): MatrixAgentRuntime | undefined {
  const principal = matrixHostAgent(role)

  return role === 'agent' ? defaultAgent : principal === undefined ? undefined : agents.get(principal)
}

/** The agent a room belongs to: the one that is the other member of the owner's private
 * room with it (§2.4). Display state only picks the runtime; every turn re-reads the room
 * (requireAssistantRoom) before it acts. */
function agentOfRoom(
  roomId: string,
  rooms: MatrixSnapshot['rooms'] = state.rooms,
  ownerId: string | undefined = state.identity?.userId
): MatrixAgentRuntime | undefined {
  return matrixRoomAgent(rooms, roomId, ownerId, allAgents())
}

function requireRoomAgent(roomId: string): MatrixAgentRuntime {
  const selected = agentOfRoom(roomId)

  if (!selected || selected.closed) {
    throw new Error('matrix_agent_unavailable')
  }

  return selected
}

/** The signed-in Atum account's subscription credentials (opencode-go at present). */
/** The account's sign-in home: where its ChatGPT plan sign-in lives, and the auth root every
 * Mac-hosted assistant of the account borrows it from (`ATUM_ACCOUNT_AUTH_HOME`). Not gated on the
 * account being ready: an assistant launched during start-up must see the same root. */
function subscriptionAuthHome(): string | undefined {
  try {
    const accountKey = account?.appScope()?.accountKey
    const owner = account?.enrollment().identity?.principal ?? account?.identity()?.userId

    return runtime && accountKey && owner ? matrixSubscriptionHostHome(runtime, owner, accountKey) : undefined
  } catch {
    return undefined
  }
}

function subscriptionKeys(): MatrixSubscriptionKeyStore | undefined {
  const accountKey = account?.appScope()?.accountKey

  return accountKey && credentialStore ? matrixSubscriptionKeyStore(credentialStore, accountKey) : undefined
}

/** The signed-in account Settings › Connections uses for its short-lived credential helper.
 * No assistant is selected: zero assistant hosts may be running, busy or even enrolled here. */
function requireSubscriptionAccount(): {
  owner: string
  accountKey: string
  generation: number
} {
  const scope = account?.appScope()
  const identity = account?.identity()
  // Preserve the existing account auth folder where an owner enrollment has named it; a
  // hostless cloud account falls back to its signed-in Matrix identity, exactly as status does.
  const owner = account?.enrollment().identity?.principal ?? identity?.userId

  if (!matrixSubscriptionAccountAvailable({
    owner: Boolean(scope && owner),
    runtime: Boolean(runtime),
    identity: Boolean(identity),
    closing,
    accountReady: state.state === 'ready'
  })) {
    throw new Error('matrix_subscriptions_unavailable')
  }

  return { owner, accountKey: scope!.accountKey, generation: scope!.generation }
}

interface SubscriptionProviders {
  diagnostics: { current?: MatrixSubscriptionAuthLifecycle }
  scope: MatrixPagesProvidersScope
  transport: MatrixPagesManagementTransport
  close(): Promise<void>
}

let subscriptionProviders: ({ key: string } & SubscriptionProviders) | undefined
const subscriptionLock = new MatrixHermesTurnLock()

/** One short-lived management Hermes for the account flow, pinned to the account it started on.
 * Its home, lock and sign-in hold are account-owned, so assistant hosts and turns are irrelevant. */
function subscriptionProvidersFor(authLifecycle?: MatrixSubscriptionAuthLifecycle): SubscriptionProviders {
  const current = requireSubscriptionAccount()
  const { owner, accountKey, generation } = current
  const accountUserId = account!.identity()!.userId
  const key = `${accountKey}:${generation}:${owner}`

  if (subscriptionProviders?.key === key) {
    if (authLifecycle) {
      subscriptionProviders.diagnostics.current = authLifecycle
    }

    return subscriptionProviders
  }

  if (subscriptionProviders) {
    void subscriptionProviders.close()
    subscriptionProviders = undefined
  }

  const selectedRuntime = runtime!
  const lifetime = new AbortController()
  const diagnostics: SubscriptionProviders['diagnostics'] = { current: authLifecycle }
  let connection: MatrixHermesConnection | undefined
  let opening: Promise<MatrixHermesConnection> | undefined

  const connect = async () => {
    const launchLifecycle = diagnostics.current

    opening ??= openMatrixHermes(selectedRuntime, {
      owner,
      executorId: matrixSubscriptionHostExecutor(accountKey),
      signal: lifetime.signal,
      home: matrixSubscriptionHostHome(selectedRuntime, owner, accountKey),
      sharedCodex: sharedCodexHere(),
      diagnostics: {
        spawned: () => launchLifecycle?.hermesSpawned(),
        portReady: elapsedMs => launchLifecycle?.hermesPortReady(elapsedMs),
        exit: exit => launchLifecycle?.hermesExit(exit)
      }
    })
    connection = await opening
  }

  const transport = new MatrixPagesManagementTransport({
    isCurrent: () => {
      const scope = account?.appScope()

      return (
        !closing &&
        !lifetime.signal.aborted &&
        scope?.accountKey === accountKey &&
        scope.generation === generation &&
        account?.identity()?.userId === accountUserId
      )
    },
    connection: () => connection,
    connect,
    lock: subscriptionLock,
    // Optional account credentials neither wait on nor interrupt assistant work.
    busy: () => false
  })

  const scope = new MatrixPagesProvidersScope({
    surface: 'connections',
    readPlanAcknowledgment: provider => readMatrixPlanAcknowledgment(runtime!, owner, provider),
    savePlanAcknowledgment: acknowledgment =>
      saveMatrixPlanAcknowledgment(runtime!, owner, acknowledgment),
    forward: request => transport.forward(request),
    isCurrent: () => transport.current(),
    confirm: request =>
      oneDialogAtATime(async () => {
        if (!transport.current() || !ui) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        const copy = matrixManagementConfirmationCopy(windowLocale(), 'Atum', request)

        const result = await dialog.showMessageBox(ui, {
          type: 'question',
          title: copy.title,
          message: copy.title,
          detail: copy.detail,
          buttons: [copy.cancel, copy.apply],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })

        return result.response === 1 && transport.current()
      }),
    openExternal: url => shell.openExternal(url),
    cancelOAuth: sessionId => transport.cancelOAuth(sessionId),
    // The account helper itself stays alive through the terminal poll; no assistant host needs a
    // sign-in hold, and optional credentials never hold assistant work.
    signingIn: () => undefined,
    signedIn: provider => {
      console.warn(`[Matrix] account plan sign-in saved provider=${provider}`)

      for (const each of allAgents()) {
        if (each.planSignIn && each.readiness?.current.phase === 'blocked') {
          each.readiness.recheck()
        }
      }
    },
    authLifecycle: () => diagnostics.current
  })

  let closingProviders: Promise<void> | undefined
  const close = () => {
    closingProviders ??= (async () => {
      await scope.stop()
      transport.retire()
      lifetime.abort()
      const active = connection ?? (await opening?.catch(() => undefined))
      connection = undefined
      await active?.close().catch(() => undefined)
    })()

    return closingProviders
  }

  subscriptionProviders = { key, diagnostics, scope, transport, close }

  return subscriptionProviders
}

async function retireSubscriptionProviders(): Promise<void> {
  const current = subscriptionProviders
  subscriptionProviders = undefined
  await current?.close()
}

/** The ChatGPT plan's models as this Mac last read them for relay publication, per account. Shown,
 * disabled, to cloud assistants while the relay is not up yet; ids and effort levels only. */
let chatGptLocalModels: { accountKey: string; models: ReturnType<typeof chatGptRelayModelRows> } | undefined

function chatGptRelayModelRows(models: readonly string[]) {
  return models.filter(atumChatGptModelVisible).map(model => ({
    id: model,
    displayName: matrixModelDisplayName(model),
    efforts: ['low', 'medium', 'high'] as const,
    defaultEffort: 'medium' as const,
    contextBudget: 128_000,
    outputBudget: 16_384
  }))
}

async function chatGptRelayModels() {
  const { transport } = subscriptionProvidersFor()
  const catalog = await listMatrixSubscriptionCatalog({
    forward: value => transport.forward(value),
    isCurrent: () => transport.current()
  })
  const chatgpt = catalog.providers.find(provider => provider.id === 'openai-codex')

  if (!chatgpt?.connected || !chatgpt.models?.length) {
    throw new Error('matrix_subscriptions_unavailable')
  }

  // The desktop-safe provider snapshot deliberately exposes model ids and effort levels only; the
  // richer Python runtime catalogue (including live context metadata) is not an Electron contract.
  // Publish conservative relay ceilings instead of claiming provider maxima: 128K is the lowest
  // known Codex-OAuth context in Hermes's existing fallback catalogue, while 16K is the bounded
  // completion ceiling this relay version already enforces. The shared formatter supplies the
  // readable name without inventing a second model-name catalogue here.
  const rows = chatGptRelayModelRows(chatgpt.models)
  const accountKey = account?.appScope()?.accountKey

  chatGptLocalModels = accountKey ? { accountKey, models: rows } : undefined

  return rows
}

/** Select/clear this enrolled Mac as the account relay. Disable fences the local handler first,
 * then revokes platform grants; enable publishes safe model metadata before opening locally. */
async function configureThisMacAsChatGptRelay(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    deviceBootstrap?.configureChatGptRelay(false)
    return chatGptRelay ? chatGptRelay.disable() : true
  }

  if (!chatGptRelay || !deviceIdentity || !deviceBootstrap) {
    return false
  }

  await reconcileDeviceControl()
  const deviceServiceId = deviceIdentity.enrollment()?.deviceServiceId

  if (!deviceServiceId) {
    return false
  }

  const models = await chatGptRelayModels()

  if (!(await chatGptRelay.enable(deviceServiceId, models))) {
    return false
  }

  deviceBootstrap.configureChatGptRelay(true, models.map(model => model.id))
  return true
}

/** A subscription changed: idle assistants restart so their next turn sees it. A running turn is
 * never interrupted for a new connection; an explicit Disconnect forces every assistant down, so
 * the credential and its models are gone at once. */
async function refreshSubscriptionAgents(force = false): Promise<void> {
  for (const each of allAgents()) {
    if (
      each.closed ||
      (!force &&
        (each.operation ||
          each.invocation ||
          each.setup ||
          each.holdsSignIn ||
          each.localTurns?.executionPending ||
          each.lock.holder ||
          each.lock.waiting))
    ) {
      continue
    }

    try {
      await stopHost(each.role)
    } catch {
      // Another launch may race this one; its next start still reads the account store.
    }
  }

  // The assistant settings used may have been restarted: its pinned transport is stale.
  await retireSubscriptionProviders()
  recheckAgents()
}

let subscriptionFollowUpRepair: {
  key: string
  repair: MatrixSubscriptionFollowUpRepair
} | undefined

function stopSubscriptionFollowUpRepair(): void {
  subscriptionFollowUpRepair?.repair.stop()
  subscriptionFollowUpRepair = undefined
}

/** Repair publication for the current account only. The first attempt remains part of the
 * connection flow; transient publication or refresh failures continue on the bounded background
 * ladder owned by MatrixSubscriptionFollowUpRepair. */
function repairChatGptSubscription(
  diagnostics: MatrixSubscriptionAuthLifecycle = new MatrixSubscriptionAuthLifecycle()
): MatrixSubscriptionFollowUpRepair {
  const subscription = requireSubscriptionAccount()
  const key = `${subscription.accountKey}:${subscription.generation}:${subscription.owner}`

  if (subscriptionFollowUpRepair?.key === key) {
    return subscriptionFollowUpRepair.repair
  }

  stopSubscriptionFollowUpRepair()
  const repair = new MatrixSubscriptionFollowUpRepair({
    registerRelay: () => configureThisMacAsChatGptRelay(true),
    refresh: () => refreshSubscriptionAgents(),
    outcome: (stage, status) => diagnostics.followUp(stage, status),
    current: () => {
      try {
        const current = requireSubscriptionAccount()
        if (`${current.accountKey}:${current.generation}:${current.owner}` !== key) {
          return false
        }

        return matrixSubscriptionsStatus({
          accountAuthHome: matrixSubscriptionHostHome(runtime!, current.owner, current.accountKey),
          keys: subscriptionKeys()
        }).providers.some(provider => provider.id === 'openai-codex' && provider.connected)
      } catch {
        return false
      }
    }
  })
  subscriptionFollowUpRepair = { key, repair }
  return repair
}

function subscriptionSession(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100 || /[\p{Cc}]/u.test(value)) {
    throw new Error('matrix_subscriptions_invalid')
  }

  return value
}

function subscriptionKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 16_384 ||
    /[\p{Cc}]/u.test(value)
  ) {
    throw new Error('matrix_subscriptions_invalid')
  }

  return value
}

/** An agent's own operation (a send, a consent, a connection, a picker): it holds up that
 * agent's turns and the account-wide operations, never another agent's turns. */
function holdOperation(agentRuntime: MatrixAgentRuntime, held: boolean) {
  agentRuntime.operation = held

  if (!held) {
    scheduleContinuousListening()
  }
}

/** Native dialogs on the window, one at a time across agents. */
let dialogs: Promise<unknown> = Promise.resolve()

function oneDialogAtATime<T>(show: () => Promise<T>): Promise<T> {
  const shown = dialogs.then(show, show)
  dialogs = shown.catch(() => {})

  return shown
}

/** Any operation in progress, the account's or any agent's. What waited on the one global
 * guard before several agents still waits, so nothing changes for one agent. */
let profileSelection = false

function anyOperation(): boolean {
  return operation || profileSelection || lifecycle?.busy || allAgents().some(each => each.operation)
}

function isolationBusy(): boolean {
  const verification = state.security?.verification?.state

  return Boolean(
    anyOperation() ||
    domainOperation ||
    securityPending ||
    closing ||
    isolationPolicy?.changing ||
    state.security?.recovery === 'working' ||
    (verification && verification !== 'done' && verification !== 'cancelled') ||
    allAgents().some(each => each.invocation || each.localTurns?.executionPending)
  )
}

function isolationView(): MatrixSnapshot['deviceIsolation'] {
  if (!isolationPolicy) {
    return undefined
  }

  try {
    return { value: isolationPolicy.value(), writable: Boolean(state.identity) && !isolationBusy() }
  } catch {
    return undefined
  }
}

const ownModelKey = (executorId: string) => `matrix-own-model:${executorId}`
const connectedModelKey = (executorId: string) => `matrix-connected-model:${executorId}`

function readOwnModel(executorId: string, agentRuntime: MatrixAgentRuntime = defaultAgent): boolean {
  try {
    const own = agentRuntime.store.getItem(ownModelKey(executorId)) === '1'
    const saved = own ? agentRuntime.store.getItem(connectedModelKey(executorId)) : null
    agentRuntime.connectedModel = saved ? parseMatrixConnectedModel(JSON.parse(saved)) : undefined

    return own
  } catch {
    agentRuntime.connectedModel = undefined

    return false
  }
}

/** Each executor's profile gets Hermes's defaults and the old app's approval posture once
 * (full-hermes.ts); best effort, so it never fails setup. */
function ensureFullHermes(
  connection: MatrixHermesConnection,
  executorId: string,
  signal: AbortSignal,
  agentRuntime: MatrixAgentRuntime = defaultAgent
) {
  return ensureMatrixFullHermes({
    store: agentRuntime.store,
    executorId,
    apply: () => applyMatrixFullHermes(connection, signal),
    signal,
    log: line => console.warn(line)
  })
}

/** Display only: a vault failure here never fails setup; the picker is then shown or
 * hidden wrongly until the next setup. */
function rememberOwnModel(
  executorId: string,
  own: boolean,
  agentRuntime: MatrixAgentRuntime = defaultAgent,
  connected?: MatrixConnectedModel
) {
  agentRuntime.ownModel = own
  // A connection whose model is not known keeps what was known only if it is the same one.
  const known = own ? (connected ?? agentRuntime.connectedModel) : undefined
  agentRuntime.connectedModel = known

  if (agentRuntime.closed) {
    return
  }

  try {
    if (own) {
      agentRuntime.store.setItem(ownModelKey(executorId), '1')

      if (known) {
        agentRuntime.store.setItem(connectedModelKey(executorId), JSON.stringify(known))
      } else {
        agentRuntime.store.removeItem(connectedModelKey(executorId))
      }
    } else {
      agentRuntime.store.removeItem(ownModelKey(executorId))
      agentRuntime.store.removeItem(connectedModelKey(executorId))
    }
  } catch (error) {
    console.warn('[Matrix] could not remember the model source:', setupFailureDetail(error))
  }
}

/** The owner's model for a conversation (its private room account data), else the default. */
function roomModel(roomId: string, agentRuntime: MatrixAgentRuntime): MatrixModelId {
  requireMatrixSessionChoice(
    state.rooms.find(room => room.id === roomId),
    agentRuntime.agentPrincipal ?? enrollmentOf(agentRuntime).identity?.agentPrincipal
  )

  return matrixTurnModel(state.rooms, roomId)
}

/** The owner's thinking level for a conversation, if they chose one. */
function roomEffort(roomId: string, agentRuntime: MatrixAgentRuntime): MatrixEffort | undefined {
  requireMatrixSessionChoice(
    state.rooms.find(room => room.id === roomId),
    agentRuntime.agentPrincipal ?? enrollmentOf(agentRuntime).identity?.agentPrincipal
  )

  return matrixTurnEffort(state.rooms, roomId)
}

/**
 * The model this agent's profile answers with now, which a resumed conversation is switched
 * to at its next turn (hermes-turn.ts, `matrixSessionModelSwitch`). Unknown own models are
 * left alone: a guess could switch a conversation to the wrong model.
 */
function sessionModelOf(agentRuntime: MatrixAgentRuntime): MatrixConnectedModel | undefined {
  if (agentRuntime.ownModel) {
    return agentRuntime.connectedModel
  }

  return managedModel ? { provider: MATRIX_ATUM_PROVIDER, model: MATRIX_DEFAULT_MODEL } : undefined
}

let managedModel: MatrixManagedModel | undefined
let assistantSetupState: MatrixSnapshot['assistantSetup']
// What the window waits on at launch (see MatrixStartupScreen). Set before the SDK
// reports ready so the window never flashes an unprepared app.
let startupState: MatrixSnapshot['startup']
/** The complete-roster launch barrier. `agents` is not authoritative until this says ready;
 * otherwise a slow/failed roster request can look like "only the default assistant" and let
 * the loading screen open before the remaining agents have even been discovered. */
let agentRosterReadiness: MatrixSnapshot['agentRoster']

function setAgentRosterReadiness(next: NonNullable<MatrixSnapshot['agentRoster']>['state']): void {
  if (agentRosterReadiness?.state !== next) {
    agentRosterReadiness = { state: next, since: Date.now() }
  }
}

// The human host has been ready once (from its cache or initial sync) since it started.
let humanPrepared = false
// The next gate may open the browser once for the domain grant (right after sign-in).
let gateInteractive = false
let operation = false
let domainOperation = false
/** The official bots whose chat is being opened (`appChat`), each with the human host it was asked of.
 * An open ends by waiting for its room to sync, up to a quarter of a minute (app-bot-room-wait.ts), so
 * it is not an account operation: nothing else waits for it, and the person can switch chats, send, or
 * sign out meanwhile (the SDK drops a stale selection, and its stop ends the wait). One open per app at
 * a time; an entry for a host that has since been replaced does not hold the app. */
const openingAppChats = new Map<string, Host>()
// The messages being run in place right now (invokeHermes): one run per message at a time.
const explicitInvocations = new MatrixInvocationFlights()
let closing = false
// The stamped build (a commit), or 'development'; set once at start.
let buildRevision = 'development'
let agentCleanupRequired = false
/** Set once this launch, or this sign-in, has tried to finish an old sign-out's revocations. */
let orphanedEnrollmentsTried = false
let state: MatrixSnapshot = { state: 'signed_out', identity: null, rooms: [], roomId: null, messages: [], error: null }
let protectedFolderDeniedOwner: string | undefined

function noteProtectedFolderDenied(): void {
  const owner = account?.identity()

  if (owner && protectedFolderDeniedOwner !== owner.userId) {
    protectedFolderDeniedOwner = owner.userId
    publish(state)
  }
}
/** The person's engine's last error code logged (`chat engine error`), so each is one line. */
let humanEngineError: string | null = null
/** Main's question to the sign-in server after a refused token, and its last engine restart. */
let sessionCheck: Promise<void> | undefined
let sessionRestartedAt: number | undefined
let sessionEnding: Promise<void> | undefined

/** A refused chat token, or a saved rotation, that came while a command held main
 * (`operation`): handled once the command ends (session-route.ts). */
const sessionChecks = matrixSessionChecks<Host>({
  busy: () => operation,
  current: () => (closing || !state.identity ? undefined : hosts.get('human')),
  check: host => void confirmChatSession(host),
  resume: () => void resumeChatAfterSave().catch(() => console.warn('[Matrix] chat engine restart failed'))
})

/** A snapshot's error, as main.log may carry it: our own codes only. */
function matrixLogCode(error: string | null): string | null {
  return error === null ? null : /^matrix_[a-z_]{1,64}$/.test(error) ? error : 'unexpected'
}

// Which ways in the sign-in window offers: email only when the server takes it.
const emailSignIn = matrixEmailSignInState({
  probe: () => account.emailSignIn(),
  onChange: () => {
    if (!closing && !state.identity) {
      publish(state)
    }
  }
})

/** Retired agents' chats leave the chat list: the human host leaves and forgets each. */
const retiredAgentRooms = new MatrixRetiredAgentRooms({
  forget: input => {
    // As the person's own Delete chat does: a preview of the open chat's document closes with it.
    if (input.roomId === state.roomId) {
      documents?.closePreviews()
    }

    return command({ kind: 'forgetAgentRoom', ...input }, 60_000)
  },
  log: line => console.warn(line)
})

/** Pins are encrypted at rest and remain scoped to this desktop account.  The SDK still
 * verifies the current catalog device before every bot operation. */
const appBotPins = new Map<string, AppBotTrustRecord>()
const retiredLegacyAppEnrollments = new Set<string>()
let appBotTrustStore: EncryptedStore | undefined
const appBotDisplayEvidence = new Map<string, Promise<MatrixMessage['appBot'] | null>>()

function storedAppBotPin(appId: string): AppBotTrustRecord | null {
  const stored = appBotTrustStore?.getItem(`app-bot-pin:${appId}`)

  if (!stored) {
    return null
  }

  try {
    const value = JSON.parse(stored) as Partial<AppBotTrustRecord>

    if (
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      typeof value.deviceId !== 'string' ||
      typeof value.fingerprint !== 'string' ||
      typeof value.curve25519 !== 'string' ||
      !Array.isArray(value.retired) ||
      value.retired.some(
        item =>
          !item ||
          typeof item.deviceId !== 'string' ||
          typeof item.fingerprint !== 'string' ||
          !(typeof item.curve25519 === 'string' || item.curve25519 === null) ||
          !Number.isSafeInteger(item.retiredAt)
      )
    ) {
      return null
    }

    return value as AppBotTrustRecord
  } catch {
    return null
  }
}

async function pinOfficialAppBot(appId: string, bot: AppBotDescriptor, human: Host) {
  // A device this Mac cannot pin is refused as `untrusted`, which the window explains.
  return pinAppBotDevice(
    appId,
    bot,
    {
      command: command => human.queue.command(command),
      botRoomIds: async userId =>
        state.rooms
          .filter(
            room =>
              room.encrypted &&
              room.participants?.some(member => member.userId === userId && member.membership === 'join')
          )
          .map(room => room.id)
    },
    {
      read: async id => appBotPins.get(id) ?? storedAppBotPin(id),
      write: async (id, record) => {
        if (!appBotTrustStore) {
          throw new Error('app_bot_trust_store_unavailable')
        }

        appBotTrustStore.setItem(`app-bot-pin:${id}`, JSON.stringify(record))
        appBotPins.set(id, record)
      }
    }
  ).catch(error => {
    throw appBotPinFailure(error, bot)
  })
}

function appBotEvidenceDevices(record: AppBotTrustRecord) {
  return [
    { deviceId: record.deviceId, ed25519: record.fingerprint, curve25519: record.curve25519, retiredAt: null },
    ...record.retired.flatMap(device =>
      device.curve25519
        ? [
            {
              deviceId: device.deviceId,
              ed25519: device.fingerprint,
              curve25519: device.curve25519,
              retiredAt: device.retiredAt
            }
          ]
        : []
    )
  ]
}

function authenticatedAppBotDisplay(
  host: Host,
  descriptor: AppDescriptor,
  roomId: string,
  eventId: string
): Promise<MatrixMessage['appBot'] | null> {
  const bot = descriptor.bot
  const pin = bot && (appBotPins.get(descriptor.app_id) ?? storedAppBotPin(descriptor.app_id))
  const scope = account.appScope()
  // A plain chat (every bot chat 0.20 makes) has no device to check: the homeserver's sender is
  // the bot. Only an encrypted one needs the pinned device, as before.
  const encrypted = appBotPinRequired(state.rooms.find(room => room.id === roomId))

  if (!scope || !bot || bot.state !== 'active' || (encrypted && (!pin || appBotTrustState(bot, pin) !== 'active'))) {
    return Promise.resolve(null)
  }

  const key = `${scope.accountKey}:${scope.generation}:${descriptor.app_id}:${roomId}:${eventId}:${pin?.generation ?? 0}`
  const cached = appBotDisplayEvidence.get(key)

  if (cached) {
    return cached
  }

  if (appBotDisplayEvidence.size >= 512) {
    appBotDisplayEvidence.clear()
  }

  const proof = host.queue
    .command({
      kind: 'appBotDisplayEvidence',
      appId: descriptor.app_id,
      app: descriptor.app,
      guest: bot.guest_enabled === true,
      userId: bot.user_id,
      roomId,
      eventId,
      devices: encrypted && pin ? appBotEvidenceDevices(pin) : []
    })
    .then(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
      }

      const candidate = value as MatrixMessage['appBot']

      return candidate.authenticated === true &&
        candidate.appId === descriptor.app_id &&
        (candidate.kind === 'notice' || candidate.kind === 'reply' || candidate.kind === 'bot_api')
        ? candidate
        : null
    })
    .catch(() => null)

  appBotDisplayEvidence.set(key, proof)

  return proof
}

async function enrichAppBotDisplay(snapshot: MatrixSnapshot, host: Host): Promise<MatrixSnapshot> {
  const catalog = matrixApps?.snapshot().apps ?? []
  const byUser = new Map(catalog.filter(app => app.bot).map(app => [app.bot!.user_id, app]))

  const candidates = snapshot.messages
    .slice(-200)
    .filter(message => !message.own && !message.appBot && byUser.has(message.sender))

  if (!candidates.length) {
    return snapshot
  }

  const evidence = await Promise.all(
    candidates.map(async message => {
      const descriptor = byUser.get(message.sender)!

      return [
        message.id,
        await authenticatedAppBotDisplay(host, descriptor, snapshot.roomId ?? '', message.id)
      ] as const
    })
  )

  const trusted = new Map(
    evidence.filter((entry): entry is [string, NonNullable<MatrixMessage['appBot']>] => entry[1] !== null)
  )

  if (!trusted.size) {
    return snapshot
  }

  return {
    ...snapshot,
    messages: snapshot.messages.map(message =>
      trusted.has(message.id) ? { ...message, appBot: trusted.get(message.id) } : message
    )
  }
}

async function retireLegacyAppCopyAfterOfficialAnswer(
  descriptor: AppDescriptor,
  roomId: string,
  eventId: string,
  outcome: unknown
) {
  const rawOutcome = outcome !== null && typeof outcome === 'object' ? (outcome as Record<string, unknown>) : null

  if (rawOutcome?.profile !== 'atum.app-bot-outcome/1' || rawOutcome.state !== 'answered' || !descriptor.bot) {
    return
  }

  const status = await account.appBotRequest(descriptor.app, 'read')
  const rawStatus = status !== null && typeof status === 'object' ? (status as Record<string, unknown>) : null

  const consent =
    rawStatus?.consent !== null && typeof rawStatus?.consent === 'object'
      ? (rawStatus.consent as Record<string, unknown>)
      : null

  const link =
    rawStatus?.link !== null && typeof rawStatus?.link === 'object' ? (rawStatus.link as Record<string, unknown>) : null

  const human = hosts.get('human')
  const ownerId = state.identity?.userId

  if (!human || !ownerId) {
    return
  }

  // A convenient-looking direct room is never sufficient: only the SDK can
  // validate the owner pointer, the owner's marker and the room's current members
  // (src/matrix/app-bot-dm.ts) without trusting this display projection.
  const official = await human.queue.command({
    kind: 'isOfficialAppBotDm',
    appId: descriptor.app_id,
    userId: ownerId,
    roomId
  })

  if (official !== true) {
    return
  }

  const answer = state.messages.find(
    message =>
      !message.own && !message.notice && message.sender === descriptor.bot!.user_id && message.replyTo === eventId
  )

  if (!answer || (await authenticatedAppBotDisplay(human, descriptor, roomId, answer.id)) === null) {
    return
  }

  const enrollment = account.appEnrollment(descriptor.app)
  const incarnation = `${descriptor.app_id}:${descriptor.app_version_id}:${enrollment.identity?.executorId ?? ''}`

  if (retiredLegacyAppEnrollments.has(incarnation)) {
    return
  }

  // The catalog's own state: the official chat is plain, so no pin decides whether the bot is up.
  const ready = canRetireLegacyAppCopy({
    botState: descriptor.bot.state,
    officialDmExists: true,
    botJoinedOfficialDm: true,
    consentAccepted: consent?.state === 'accepted',
    linkReady: link?.state === 'linked' && link?.ready === true && link?.available === true,
    firstBotAnswerReceived: true
  })

  if (!ready || enrollment.state !== 'ready') {
    return
  }

  // The marker is durable and idempotent for this app incarnation.  It goes on
  // the old room before removing the local host, so a restart or a failed
  // withdrawal leaves the legacy copy available and the next confirmed answer
  // can finish the same retirement safely.
  await human.queue.command({
    kind: 'retireLegacyAppBotRoom',
    appId: descriptor.app_id,
    userId: ownerId,
    roomId,
    movedAt: Date.now()
  })
  await Promise.all([stopAppHosts(descriptor.app), account.revokeApp(descriptor.app)])
  retiredLegacyAppEnrollments.add(incarnation)
  publish(state)
}

/** The primary assistant's one first-learning run (first-run.ts), on its current local/cloud home. */
let firstRunProgress: MatrixFirstLearningProgress = {}

const firstRun = new MatrixFirstRun({
  room: preferred => {
    const human = account?.identity()
    const primary = productAgent()

    if (
      !human ||
      !primary ||
      primary.closed ||
      !primary.localTurns ||
      closing
    ) {
      return undefined
    }

    // Its own private chats with the person, never one with a linked document.
    const usable = state.rooms.filter(
      room =>
        usableAgentRoom(room) &&
        agentOfRoom(room.id, state.rooms, human.userId) === primary &&
        !documents?.describe({ userId: human.userId, roomId: room.id })
    )

    const main = resolveProjectedConversation(state.rooms, human.userId, enrollmentOf(primary).identity?.userId).main

    return firstRunConversationRoom(usable, main, preferred)?.id
  },
  acceptHidden: (roomId, text, context) => {
    const primary = productAgent()

    if (!primary?.localTurns) {
      throw new Error('matrix_not_ready')
    }

    primary.localTurns.accept(roomId, text, undefined, context, 'first_learning')
  },
  folders: () => matrixFolderAccess().awareness(),
  claim: async locale => {
    const capturedScope = account.appScope()
    const capturedOwner = hosts.get('human')
    const assistantId = defaultAgent.assistantId

    if (!assistantId || !capturedScope || !capturedOwner) {
      return 'unavailable'
    }

    const authority = await account.firstRunGoogleAuthority(assistantId).catch(() => undefined)

    return firstRunGoogleValue.claim({
      locale,
      scope: () => account.appScope(),
      authority: () => authority,
      owner: () => hosts.get('human'),
      local: () => {
        const primary = productAgent()
        const enrolled = primary ? enrollmentOf(primary).identity : undefined

        return Boolean(
          primary === defaultAgent &&
            !isCloudAgent(primary) &&
            enrolled &&
            primary.lease?.held(enrolled.executorId)
        )
      },
      eligible: () => Boolean(
        !closing &&
          state.state === 'ready' &&
          state.firstRunMarker === 'unseen' &&
          productAgent() === defaultAgent &&
          account.appScope()?.generation === capturedScope.generation &&
          hosts.get('human') === capturedOwner
      )
    })
  },
  answer: async (folders, welcome) => {
    const human = hosts.get('human')

    if (!human || closing) {
      throw new Error('matrix_first_run_stale')
    }

    await human.queue.command({ kind: 'firstRunAnswered', identity: human.identity, answer: folders, welcome })
  },
  changed: () => publish(state),
  log: line => console.warn(line)
})

/** The welcome's first evaluation (first-run-welcome.ts): once per account, from what it already holds. */
const firstRunWelcome = new MatrixFirstRunWelcome({
  write: async (identity, welcome) => {
    const human = hosts.get('human')

    if (
      !human ||
      closing ||
      human.identity.userId !== identity.userId ||
      human.identity.deviceId !== identity.deviceId
    ) {
      throw new Error('matrix_first_run_stale')
    }

    await human.queue.command({ kind: 'firstRunWelcome', identity: human.identity, state: welcome })
  },
  log: line => console.warn(line)
})

/** Provider-confirmed Google or a card skip asks the account's durable one-shot authority
 * for the comprehensive first-learning run; this class owns only the native lifecycle fence. */
const firstRunGoogleValue = new MatrixFirstRunGoogleValue({
  log: line => console.warn(line)
})

const webPreviews = new MatrixWebPreviewOffers()

const terminals = new MatrixTerminals(
  () => publish(state),
  value => {
    if (!closing && value.scope === webPreviewScope(state) && !ui?.isDestroyed()) {
      ui?.webContents.send(channel.terminal, value)
    }
  }
)

function webPreviewScope(snapshot: MatrixSnapshot): string {
  return snapshot.state === 'ready' && snapshot.identity && snapshot.roomId
    ? `${snapshot.identity.userId}\0${snapshot.identity.deviceId}\0${snapshot.roomId}`
    : ''
}

function webPreviewReceiver(agentRuntime: MatrixAgentRuntime, roomId: string, abort: AbortController) {
  const human = account.identity()
  const humanHost = hosts.get('human')
  const agentHost = hosts.get(agentRuntime.role)

  return (target: MatrixWebPreviewTarget) => {
    if (
      !human ||
      !humanHost ||
      !agentHost ||
      closing ||
      abort.signal.aborted ||
      agentRuntime.invocation?.abort !== abort ||
      state.roomId !== roomId ||
      state.state !== 'ready' ||
      hosts.get('human') !== humanHost ||
      hosts.get(agentRuntime.role) !== agentHost
    ) {
      return
    }

    const connection = agentRuntime.executor?.connected

    if (!connection) {
      return
    }

    webPreviews.receive(
      webPreviewScope(state),
      target,
      () =>
        !closing &&
        !abort.signal.aborted &&
        account.identity()?.userId === human.userId &&
        account.identity()?.deviceId === human.deviceId &&
        hosts.get('human') === humanHost &&
        hosts.get(agentRuntime.role) === agentHost &&
        agentRuntime.executor?.connected === connection
    )
    publish(state)
  }
}

function terminalReceiver(agentRuntime: MatrixAgentRuntime, roomId: string) {
  const human = account.identity()
  const humanHost = hosts.get('human')
  const agentHost = hosts.get(agentRuntime.role)
  const scope = human ? `${human.userId}\0${human.deviceId}\0${roomId}` : ''
  let connection: MatrixHermesConnection | undefined

  const alive = () => {
    connection ??= agentRuntime.executor?.connected

    return Boolean(
      human &&
      humanHost &&
      agentHost &&
      connection &&
      !closing &&
      account.identity()?.userId === human.userId &&
      account.identity()?.deviceId === human.deviceId &&
      hosts.get('human') === humanHost &&
      hosts.get(agentRuntime.role) === agentHost &&
      state.rooms.some(room => room.id === roomId && usableAgentRoom(room)) &&
      agentRuntime.executor?.connected === connection
    )
  }

  return {
    receive: (event: MatrixHermesTerminalEvent) => {
      if (!alive()) {
        return false
      }

      terminals.receive(scope, event, alive)

      return true
    },
    read: (options: TerminalReadOptions, signal: AbortSignal) =>
      terminals.readPane(scope, options, () => alive() && webPreviewScope(state) === scope, signal)
  }
}

const privateCosNotificationAuthority = new MatrixCompanyPrivateCosNotificationAuthority()

const privateCosNotificationRoomIds = () =>
  privateCosNotificationAuthority.roomIds(account?.appScope())

async function syncPrivateCosNotificationRooms(): Promise<void> {
  const host = hosts.get('human')
  const identity = account?.identity()

  if (!host || !identity || host.identity.userId !== identity.userId || host.identity.deviceId !== identity.deviceId) {
    return
  }

  await host.queue.command({
    kind: 'companyPrivateCosNotificationRooms',
    roomIds: privateCosNotificationRoomIds()
  })
}

async function requestCompanyPrivateCos(value: unknown): Promise<unknown> {
  const result = await account.companyPrivateCos(value, AbortSignal.timeout(15_000))

  if (privateCosNotificationAuthority.observe(account.appScope(), result)) {
    await syncPrivateCosNotificationRooms().catch(() => {})
  }

  return result
}

const notifications = createMatrixNotifications<Host>({
  // Only what the window itself would be shown: a room that claims to be a company conversation the platform does not
  // list raises no notification.
  current: () => ({ host: hosts.get('human'), snapshot: companyProjection(state), focused: Boolean(ui?.isFocused()), closing }),
  create: options => (Notification.isSupported() ? new Notification(options) : undefined),
  privateCosBoundRoom: roomId => privateCosNotificationAuthority.has(account?.appScope(), roomId),
  open: (host, roomId) => {
    ui?.show()
    ui?.focus()
    void host.queue.command({ kind: 'select', roomId }).catch(() => {})
  }
})

const ownPresence = createMatrixPresenceLifecycle({
  current: () => {
    const host = hosts.get('human')

    return host?.ready && state.identity && state.state === 'ready' && !closing
      ? {
          scope: `${state.identity.userId}\0${state.identity.deviceId}`,
          focused: Boolean(ui?.isFocused()),
          idleSeconds: powerMonitor.getSystemIdleTime(),
          closing
        }
      : undefined
  },
  send: async presence => {
    const host = hosts.get('human')

    if (!host?.ready || !state.identity || host.identity.userId !== state.identity.userId ||
        host.identity.deviceId !== state.identity.deviceId) {
      throw new Error('matrix_presence_unavailable')
    }

    await host.queue.command({ kind: 'setOwnPresence', presence }, 5_000)
  }
})

// The menu bar says Atum (Electron's default menu would print the identity name).
const appMenu = createMatrixAppMenu({
  menu: Menu,
  platform: process.platform,
  ready: () => app.isReady(),
  systemLanguages: () => app.getPreferredSystemLanguages(),
  log: message => console.warn(message),
  // A shipped build has no Reload or developer tools (FR31); Check for Updates… only where
  // this copy can update itself (the desktop services' own condition).
  packaged: app.isPackaged,
  updates: app.isPackaged && process.platform === 'darwin' && process.arch === 'arm64',
  checkForUpdates: locale => void checkForUpdatesFromMenu(locale),
  website: () => void shell.openExternal(MATRIX_MENU_WEBSITE)
})

/**
 * A Mac that cannot finish an agent's turns hands its answering over (lease-handover.ts): two
 * unanswered turns in a row and it releases that agent's lease and sits out three minutes, so
 * another awake Mac (or the cloud) takes the agent over; then it competes again. Per agent.
 */
const leaseHandover = new MatrixLeaseHandover<MatrixAgentRuntime>({
  // The lease reconcile releases a held-off agent, but keeps a lease a message typed here or the
  // owner's group message waiting on this Mac needs (the turn lock is FIFO and global).
  release: agentRuntime => reconcileLease(agentRuntime),
  resume: () => {
    scheduleContinuousListening()
    publish(state)
  },
  label: agentRuntime => agentRuntime.principal?.slice(0, 8) ?? 'default',
  log: line => console.warn(line)
})

/** An agent's server-path room watch: its own turns, its own host. Each turn that ends without
 * an answer reaches the lease handover through the listener's `onTrouble` (020 shared contract). */
function createListener(agentRuntime: MatrixAgentRuntime): MatrixHermesListener {
  const listener = new MatrixHermesListener(
    (hint, watch, signal, line) => runHermes(hint, undefined, watch, signal, agentRuntime, undefined, line),
    () => {
      agentRuntime.continuous?.listenerChanged()

      if (listener.snapshot()?.state === 'stopped') {
        void hosts
          .get(agentRuntime.role)
          ?.queue.command({ kind: 'watchInvocations', watch: null })
          .catch(() => {})
      }

      scheduleExecutionPolicyReconcile()
      scheduleContinuousListening()
      publish(state)
    },
    {
      onTrouble: event => {
        try {
          if (leaseHandover.trouble(agentRuntime, event)) {
            publish(state)
          }
        } catch {
          // Never into the listener's thread; the next reconcile looks again.
        }
      }
    }
  )

  return listener
}

defaultAgent.listener = createListener(defaultAgent)

function stopListening(
  reason: 'cancelled' | 'unavailable' | 'expired' = 'cancelled',
  agentRuntime: MatrixAgentRuntime = defaultAgent
) {
  agentRuntime.listeningConsent?.abort()

  if (agentRuntime.continuous?.enabled) {
    agentRuntime.continuous.pause(reason === 'expired' ? 'renewing' : reason === 'unavailable' ? 'offline' : 'busy')
  } else {
    agentRuntime.listener.stop(reason)
  }
}

interface MatrixKeepAwakePreference {
  on: boolean
  noticeShown: boolean
}

let keepAwakePreference: MatrixKeepAwakePreference = { on: true, noticeShown: true }
let keepAwakeRegistered = false
let keepAwakeConnection: ReturnType<MacDeviceIdentity['connection']> = null
let stopWatchingKeepAwakeConnection: (() => void) | undefined

const keepAwakeNotice: Record<DesktopLocale, string> = {
  en: 'Atum now keeps this Mac awake so your assistants can keep working while you are away. You can turn this off in Settings.',
  vi: 'Giờ Atum giữ máy Mac này thức để trợ lý vẫn làm việc khi bạn đi vắng. Bạn có thể tắt trong Cài đặt.',
  ja: '外出中もアシスタントが作業を続けられるよう、Atum がこの Mac をスリープさせない設定になりました。設定でオフにできます。',
  zh: 'Atum 现在会让这台 Mac 保持唤醒，以便助手在你离开时继续工作。你可以在设置中关闭此功能。',
  'zh-hant': 'Atum 現在會讓這台 Mac 保持喚醒，讓助理在你離開時繼續工作。你可以在設定中關閉此功能。'
}

const atumKeepAwake = createAtumKeepAwake(powerSaveBlocker, {
  onTransition: (active, reason) => {
    console.warn(`[keep-awake] state=${active ? 'on' : 'off'} reason=${reason}`)

    if (active && !keepAwakePreference.noticeShown) {
      keepAwakePreference = { ...keepAwakePreference, noticeShown: true }
      writeMatrixKeepAwakePreference()

      if (Notification.isSupported()) {
        new Notification({ title: 'Atum', body: keepAwakeNotice[windowLocale()] }).show()
      }
    }
  }
})

function matrixKeepAwakePath(): string {
  return path.join(app.getPath('userData'), 'keep-awake.json')
}

function readMatrixKeepAwakePreference(): MatrixKeepAwakePreference {
  try {
    const value = JSON.parse(readFileSync(matrixKeepAwakePath(), 'utf8')) as Record<string, unknown>

    return {
      on: typeof value.on === 'boolean' ? value.on : true,
      // An older Atum build may have written only `on`; that is an existing choice, not a new default.
      noticeShown: typeof value.noticeShown === 'boolean' ? value.noticeShown : true
    }
  } catch {
    return { on: true, noticeShown: false }
  }
}

function writeMatrixKeepAwakePreference(): void {
  try {
    writeFileSync(matrixKeepAwakePath(), JSON.stringify(keepAwakePreference, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
  } catch (error) {
    console.warn(`[keep-awake] preference write failed: ${error instanceof Error ? error.message : 'unexpected'}`)
  }
}

function registerAtumKeepAwake(): void {
  if (keepAwakeRegistered) {
    return
  }

  keepAwakeRegistered = true
  keepAwakePreference = readMatrixKeepAwakePreference()
  // Persist the once-per-Mac default before applying it. A crash may delay the notice, never the choice.
  writeMatrixKeepAwakePreference()
  atumKeepAwake.setEnabled(keepAwakePreference.on)
  atumKeepAwake.setOnBattery(powerMonitor.isOnBatteryPower())

  ipcMain.handle(MATRIX_KEEP_AWAKE.status, event => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)

    return keepAwakePreference.on
  })
  ipcMain.handle(MATRIX_KEEP_AWAKE.enabled, (event, on: unknown) => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)

    if (typeof on !== 'boolean') {
      throw new Error('matrix_keep_awake_invalid')
    }

    const enabled = on
    keepAwakePreference = {
      on: enabled,
      // Turning the default off before it first holds is itself an informed choice; do not nag later.
      noticeShown: keepAwakePreference.noticeShown || !enabled
    }
    writeMatrixKeepAwakePreference()
    atumKeepAwake.setEnabled(enabled)
    // The row off takes this Mac out of every chain; on puts it back (FC D3, power-save.ts).
    scheduleExecutionPolicyReconcile()
    scheduleContinuousListening()

    return keepAwakePreference.on
  })

  // FC D3: a power change moves this Mac in or out of every cloud agent's failover chain at once.
  powerMonitor.on('on-battery', () => {
    atumKeepAwake.setOnBattery(true)
    scheduleExecutionPolicyReconcile()
    scheduleContinuousListening()
  })
  powerMonitor.on('on-ac', () => {
    atumKeepAwake.setOnBattery(false)
    scheduleExecutionPolicyReconcile()
    scheduleContinuousListening()
  })
}

/** armHermesWatch's failure line (0.20.1): a refusal retries for as long as the lease is held. */
const listeningArmLog = new MatrixWindowedLog(line => console.warn(line))

let continuousScheduled = false

function continuousBinding(roomId: string, agent: MatrixAgentRuntime): string | undefined {
  const human = state.identity
  const identity = enrollmentOf(agent).identity

  if (!human || !identity) {
    return undefined
  }

  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.issuer,
        identity.principal,
        identity.agentPrincipal,
        identity.executorId,
        human.userId,
        human.deviceId,
        roomId
      ])
    )
    .digest('hex')
}

interface MatrixExecutionPolicyListening {
  opening?: AbortController
  retry?: ReturnType<typeof setTimeout>
  roomId?: string
}

const executionPolicyListening = new Map<MatrixAgentRuntime, MatrixExecutionPolicyListening>()

/** How long a Mac that has just taken a cloud agent's term may spend reading the cloud home before
 * it answers anyway, saying so (cloud-home-read.ts). A failover must not wait on a slow read. */
const CLOUD_HOME_READ_MS = 20_000

interface CloudHomeTakeover {
  /** The term this read is for: a new term reads again. */
  token: string
  abort: AbortController
  result?: CloudHomeSync
}

const cloudHomeTakeovers = new Map<MatrixAgentRuntime, CloudHomeTakeover>()

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
function cloudHomeGate(agent: MatrixAgentRuntime, token: string): 'pending' | 'settled' {
  const principal = cloudPrincipal(agent)
  const view = principal ? executionPolicies?.snapshot(principal) : undefined

  if (!cloudHomeReader || !principal || !cloudHomeReadApplies(view)) {
    return 'settled'
  }

  const existing = cloudHomeTakeovers.get(agent)

  if (existing?.token === token) {
    return existing.result ? 'settled' : 'pending'
  }

  existing?.abort.abort()
  const takeover: CloudHomeTakeover = { token, abort: new AbortController() }
  cloudHomeTakeovers.set(agent, takeover)
  void runCloudHomeRead(agent, principal, takeover)

  return 'pending'
}

async function runCloudHomeRead(
  agent: MatrixAgentRuntime,
  principal: string,
  takeover: CloudHomeTakeover
): Promise<void> {
  const signal = AbortSignal.any([takeover.abort.signal, AbortSignal.timeout(CLOUD_HOME_READ_MS)])
  let result: CloudHomeSync = { state: 'unavailable' }

  try {
    const identity = enrollmentOf(agent).identity

    // No live cloud enrollment: the agent has no cloud home, so there is nothing to read.
    if (!(await cloudEnrollments?.current(principal, signal))) {
      result = { state: 'none' }
    } else if (identity && runtime && cloudHomeReader) {
      result = await cloudHomeReader.sync({
        agentPrincipal: principal,
        home: agentHermesHome(agent, { principal: identity.principal, executorId: identity.executorId }, runtime),
        signal
      })
    }
  } catch {
    result = { state: 'unavailable' }
  }

  if (cloudHomeTakeovers.get(agent) !== takeover || takeover.abort.signal.aborted) {
    return
  }

  takeover.result = result
  console.warn(
    `[Matrix] cloud home read agent=${principal.slice(0, 8)} state=${result.state}` +
      (result.state === 'fresh'
        ? ` generation=${result.generation} files=${result.files} changed=${result.changed} skipped=${result.skipped}` +
          // Paths only, never content; a long list is cut.
          ` kept=${result.kept.length}${result.kept.length ? `[${result.kept.slice(0, 20).join(',')}${result.kept.length > 20 ? ',…' : ''}]` : ''}`
        : '')
  )
  scheduleContinuousListening()
  publish(state)
}

/** The Mac that answers for a cloud agent says what happened to its memory (cloud-home-read.ts). */
function cloudHomeAgentMemoryNote(agent: MatrixAgentRuntime): 'local_saved' | 'without_recent' | undefined {
  return cloudHomeMemoryNote(cloudHomeTakeovers.get(agent)?.result)
}

/** H-F's own-chat watch is in memory only. It neither reads nor writes the person's persistent
 * keep-listening preference; the saved execution policy and exact lease are its authority. */
function reconcileExecutionPolicyListening(agent: MatrixAgentRuntime): void {
  const principal = cloudPrincipal(agent)
  const view = principal ? executionPolicies?.snapshot(principal) : undefined
  const presence = deviceIdentity?.presence()
  const deviceServiceId = presence?.state === 'enrolled' ? presence.deviceServiceId : undefined
  const enrollment = enrollmentOf(agent)
  const identity = enrollment.state === 'ready' ? enrollment.identity : undefined
  const held = identity ? agent.lease?.held(identity.executorId) : null
  const roomId = assistantHomeRoom(agent)
  const listeningState = executionPolicyListening.get(agent) ?? {}
  const listening = agent.listener.snapshot()
  executionPolicyListening.set(agent, listeningState)

  const runtimeReady = Boolean(
    isCloudAgent(agent) &&
      roomId &&
      !agent.operation &&
      !agent.starting &&
      agent.executor?.connected &&
      agent.readiness?.current.phase === 'ready' &&
      hosts.get(agent.role)?.ready === true
  )

  const action = matrixExecutionPolicyListeningAction(
    view,
    deviceServiceId,
    agent.lease?.current.state,
    Boolean(held?.leaseToken),
    runtimeReady,
    macPowerEligible()
  )

  // A watch already armed keeps listening through a reconnecting sync; a new one waits until the
  // hosts are live again (host-health.ts). The change back reconciles at once.
  if (action === 'arm' && listening?.state !== 'listening' && !hostsTakeNewClaims(agent)) {
    return
  }

  // The term was just taken: read the cloud home before the first reply (bounded, then it answers
  // and says so). Losing the term forgets the read, so the next term reads again.
  if (action === 'arm' && listening?.state !== 'listening' && held?.leaseToken) {
    if (cloudHomeGate(agent, held.leaseToken) === 'pending') {
      return
    }
  } else if (!held?.leaseToken) {
    cloudHomeTakeovers.get(agent)?.abort.abort()
    cloudHomeTakeovers.delete(agent)
  }

  if (action !== 'arm' || !roomId) {
    listeningState.opening?.abort()
    listeningState.opening = undefined

    if (listeningState.retry) {
      clearTimeout(listeningState.retry)
      listeningState.retry = undefined
    }

    const hadWatch = Boolean(
      listeningState.opening || listeningState.retry || listeningState.roomId || listening?.state === 'listening'
    )

    if (action === 'drain') {
      agent.listener.drainAndStop('cancelled')
    } else {
      agent.listener.stop('cancelled')
    }

    if (hadWatch) {
      void hosts.get(agent.role)?.queue.command({ kind: 'watchInvocations', watch: null }).catch(() => {})
    }

    listeningState.roomId = undefined

    return
  }

  if (listening?.state === 'listening' && listening.roomId === roomId) {
    listeningState.roomId = roomId

    return
  }

  if (listeningState.opening || listeningState.retry) {
    return
  }

  const abort = new AbortController()
  listeningState.opening = abort
  listeningState.roomId = roomId
  void armHermesWatch(agent, roomId, abort.signal, { policy: true })
    .then(() => leaseHandover.armed(agent))
    .catch(error => {
      if (!abort.signal.aborted && isCloudAgent(agent) && executionPolicyLocal(agent) === 'enabled') {
        if (!matrixListeningRefusedEverywhere(error) && leaseHandover.recovering(agent, 'unavailable')) {
          publish(state)
        }

        listeningState.retry = setTimeout(() => {
          listeningState.retry = undefined
          scheduleContinuousListening()
        }, 10_000)
        listeningState.retry.unref?.()
      }
    })
    .finally(() => {
      if (listeningState.opening === abort) {
        listeningState.opening = undefined
      }

      scheduleContinuousListening()
    })
}

/** New claims (a watch armed, a lease started) need this agent's host and the person's both live;
 * either one's sync reconnecting holds them back, never what is already running (host-health.ts). */
function hostsTakeNewClaims(agent: MatrixAgentRuntime): boolean {
  return matrixHostsTakeNewClaims([hosts.get(agent.role), { ready: true, degraded: hosts.get('human')?.degraded }])
}

function createContinuousListening(agent: MatrixAgentRuntime): MatrixContinuousListening {
  return new MatrixContinuousListening({
    automatic: true,
    store: agent.store,
    listener: () => agent.listener.snapshot(),
    changed: () => {
      reconcileLease(agent)
      scheduleExecutionPolicyReconcile()
      publish(state)
    },
    stop: () => {
      agent.listeningConsent?.abort()
      agent.listener.stop()
      void hosts
        .get(agent.role)
        ?.queue.command({ kind: 'watchInvocations', watch: null })
        .catch(() => {})
    },
    // A watch already armed keeps listening through a reconnecting sync; a new one waits for it.
    holdArm: () => !hostsTakeNewClaims(agent),
    context: preference => {
      // The agent's home is moving, or is elsewhere: nothing new is armed. A watch still listening is
      // left to end on its own (the drain lets the turn it admitted finish), so a turn is never cut.
      const homePrincipal = cloudPrincipal(agent)

      if (homePrincipal && agentHome?.isHeld(homePrincipal)) {
        return agent.listener.snapshot()?.state === 'listening'
          ? { state: 'ready' }
          : { state: 'waiting', reason: 'unavailable' }
      }

      // Human readiness belongs to state.state; host.ready is populated only
      // for agent/app SDK hosts. Requiring it on human would pause forever.
      if (closing || agent.closed || !state.identity || !matrixHumanSdkReady(state.state, hosts.get('human'))) {
        return { state: 'waiting', reason: 'offline' }
      }

      const binding = continuousBinding(preference.roomId, agent)

      if (binding && binding !== preference.binding) {
        return { state: 'foreign' }
      }

      const enrollment = enrollmentOf(agent)

      if (!matrixEnrollmentAuthority(enrollment).ok) {
        return { state: 'waiting', reason: 'unavailable' }
      }

      if (enrollment.state !== 'ready' || !enrollment.identity || !hosts.get(agent.role)?.ready) {
        return { state: 'waiting', reason: 'renewing' }
      }

      const room = state.rooms.find(item => item.id === preference.roomId)

      if (!room || !isAssistantRoom(room, state.identity.userId, enrollment.identity.userId)) {
        return { state: 'foreign' }
      }

      if (documents.describe({ userId: state.identity.userId, roomId: preference.roomId })) {
        return { state: 'waiting', reason: 'document' }
      }

      if (!agent.lease?.held(enrollment.identity.executorId)) {
        // Handing the agent over (lease-handover.ts) is another device answering, too.
        return {
          state: 'waiting',
          reason:
            agent.lease?.current.state === 'elsewhere' || !leaseHandover.competes(agent)
              ? 'lease_elsewhere'
              : 'unavailable'
        }
      }

      if (
        operation ||
        domainOperation ||
        agent.operation ||
        agent.readiness?.current.phase !== 'ready' ||
        (agent.invocation && agent.listener.snapshot()?.state !== 'listening')
      ) {
        return { state: 'waiting', reason: 'busy' }
      }

      return { state: 'ready' }
    },
    arm: (preference, signal) =>
      armHermesWatch(agent, preference.roomId, signal, { preference }).catch((error: unknown) => {
        // The room is no longer the agent's main conversation (0.20.1: a move here, on another
        // Mac, or the reconcile restoring a main): listening moves to the main the server read
        // named. Re-pointing before this failure lands means it is not counted as one.
        if (error instanceof EarlierConversationError) {
          try {
            followConversationMain(agent, error.main)
          } catch {
            // The next schedule looks again.
          }
        }

        throw error
      }),
    // Every Mac meets this refusal the same (the rooms name no main, until the reconcile restores
    // one): retried, but handing the agent to another Mac would not help. A refusal that names a
    // main this Mac could not follow still counts (listening-room.ts).
    refused: matrixListeningRefusedEverywhere,
    // A Mac stuck re-arming (an incomplete catch-up, an unexplained arm failure) answers nothing
    // while it holds the lease: two retries in a row and it hands the agent over, too.
    recovering: reason => {
      if (leaseHandover.recovering(agent, reason)) {
        publish(state)
      }
    },
    armed: () => leaseHandover.armed(agent)
  })
}

function scheduleContinuousListening() {
  if (continuousScheduled || closing) {
    return
  }

  continuousScheduled = true
  setImmediate(() => {
    continuousScheduled = false

    if (closing) {
      return
    }

    const connection = deviceIdentity?.connection() ?? null

    if (connection !== keepAwakeConnection) {
      stopWatchingKeepAwakeConnection?.()
      keepAwakeConnection = connection
      stopWatchingKeepAwakeConnection = connection?.onState(() => scheduleContinuousListening())
    }

    for (const each of allAgents()) {
      try {
        // Existing watches and admitted turns belong to the account, not its replaced human SDK.
        if (ownerRepairPreservesWork()) {
          reconcileLease(each)

          continue
        }

        if (isCloudAgent(each)) {
          reconcileExecutionPolicyListening(each)
        } else {
          followConversationMain(each)
          adoptDefaultContinuousListening(each)
          each.continuous?.reconcile()
        }

        reconcileLease(each)
      } catch {
        console.warn('[Matrix] listening state unavailable')
      }
    }

    atumKeepAwake.setReason(
      'listening',
      allAgents().some(
        each =>
          each.continuous?.enabled &&
          each.listener.snapshot()?.state === 'listening' &&
          each.lease?.current.state === 'held'
      )
    )
    atumKeepAwake.setReason('cloud_device', cloudAgents.size > 0 && deviceIdentity?.presence().state === 'enrolled')
  })
}

/** The room each agent's default keep listening was last turned on for, this session: a
 * default that did not hold (its chat turned out not to be the agent's) is not retried. */
const continuousDefaults = new WeakMap<MatrixAgentRuntime, string>()

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
function adoptDefaultContinuousListening(agent: MatrixAgentRuntime) {
  const human = state.identity
  const enrolled = enrollmentOf(agent)
  // The agent's home as the rooms mark it now (its main conversation), not the room its Hermes
  // was started with (`agent.homeRoom`), which a move made since may have turned Earlier.
  const roomId = assistantHomeRoom(agent)

  if (
    !agent.continuous?.awaitsDefault ||
    agent.closed ||
    !human ||
    !roomId ||
    enrolled.state !== 'ready' ||
    !enrolled.identity ||
    continuousDefaults.get(agent) === roomId ||
    isCloudAgent(agent) ||
    isMovingAgent(agent) ||
    answersFromHome(agent)
  ) {
    return
  }

  const room = state.rooms.find(item => item.id === roomId && item.membership === 'join')
  const binding = continuousBinding(roomId, agent)

  if (!room || !binding || !isAssistantRoom(room, human.userId, enrolled.identity.userId)) {
    return
  }

  continuousDefaults.set(agent, roomId)
  agent.continuous.enable(binding, roomId)
}

/**
 * Keep listening follows the agent's main conversation (0.20.1). However the main moved (this
 * Mac's move, another Mac's, the reconcile restoring a main after two moves crossed, a cloud move
 * putting back the room it took), listening left in what is now an earlier conversation would
 * answer nothing: every turn there is refused. Checked on every listening schedule, so no path
 * that moves the main has to remember it; `named` is the main a refused arm's server read named.
 * True when it moved listening.
 */
function followConversationMain(agent: MatrixAgentRuntime, named?: string): boolean {
  const roomId = agent.continuous?.roomId
  const human = state.identity
  const agentId = enrollmentOf(agent).identity?.userId

  if (!AGENT_ONE_CONVERSATION || !roomId || !human || !agentId || agent.closed) {
    return false
  }

  const main = matrixListeningFollow({
    rooms: state.rooms,
    ownerId: human.userId,
    agentId,
    roomId,
    named,
    pending: pendingConversationHome(agent)
  })

  const binding = main ? continuousBinding(main, agent) : undefined

  if (!main || !binding || !agent.continuous) {
    return false
  }

  agent.continuous.enable(binding, main)
  console.warn(
    `[Matrix] listening follows main agent=${agent.principal?.slice(0, 8) ?? 'default'} from=${named ? 'refusal' : 'markers'}`
  )

  return true
}

/** A preference write failure cannot prevent authority revocation/turn cleanup. */
function forgetContinuousListening(agent: MatrixAgentRuntime) {
  try {
    agent.continuous?.disable()
  } catch {
    console.warn('[Matrix] continuous preference cleanup failed; local listening stopped')
  }
}

/** How long a temporary (not continuous) watch lasts, within its credential's lifetime. */
const TEMPORARY_WATCH_MS = 15 * 60_000

/** Prepare before SDK acknowledgement, admit only after rechecking the same
 * native account/room/host generation. Both temporary and persistent modes use it. */
async function armHermesWatch(
  agent: MatrixAgentRuntime,
  roomId: string,
  signal: AbortSignal,
  options: { preference?: ContinuousListeningPreference; policy?: true } = {}
): Promise<void> {
  const { policy, preference } = options
  const enrolled = enrollmentOf(agent)
  const human = state.identity
  const agentHost = hosts.get(agent.role)
  const humanHost = hosts.get('human')

  if (
    !matrixHumanSdkReady(state.state, humanHost) ||
    !human ||
    !agentHost?.ready ||
    enrolled.state !== 'ready' ||
    !enrolled.identity
  ) {
    throw new Error('matrix_agent_unavailable')
  }

  // Where an arm stopped, for its log line: until 0.20.1 an arm failure was never written down,
  // so a Mac that kept handing its agent over showed no reason anywhere (2026-10-11).
  let stage: 'room' | 'lease' | 'watch' | 'scan' | 'admit' = 'room'

  const abort = new AbortController()
  const cancel = () => abort.abort()
  signal.addEventListener('abort', cancel, { once: true })

  if (signal.aborted) {
    abort.abort()
  }

  agent.listeningConsent = abort

  try {
    await requireAssistantRoom(roomId, humanHost, agentHost, { forTurn: true })
    abort.signal.throwIfAborted()
    stage = 'lease'

    // Temporary listen has no persisted preference to drive acquisition. Its
    // just-confirmed native consent is demand, but never permission to proceed
    // before the platform returns a fenced term.
    reconcileLease(agent)

    if (
      !(await waitUntil(
        () => Boolean(agent.lease?.held(enrolled.identity!.executorId)?.leaseToken),
        5_000,
        abort.signal
      ))
    ) {
      throw new Error('matrix_automatic_lease_required')
    }

    // The credential as it is now: a renewal while this was arming only moved its expiry.
    const renewed = enrollmentOf(agent)

    if (!sameMatrixEnrollment(renewed, enrolled) || !renewed.identity) {
      throw new Error('matrix_not_ready')
    }

    const watch: MatrixInvocationWatch = {
      id: randomUUID(),
      roomId,
      sender: human,
      since: Date.now(),
      until: preference || policy
        ? renewed.identity.expiresAt
        : Math.min(Date.now() + TEMPORARY_WATCH_MS, renewed.identity.expiresAt)
    }

    const held = agent.lease?.held(enrolled.identity.executorId)

    if (!held?.leaseToken || held.boundary === undefined) {
      throw new Error('matrix_automatic_upgrade_required')
    }

    watch.automatic = {
      windowStart: Math.max(held.boundary, preference || policy ? Date.now() - 15 * 60_000 : watch.since)
    }

    stage = 'watch'
    agent.listener.prepare(watch)
    await agentHost.queue.command({ kind: 'watchInvocations', watch })
    abort.signal.throwIfAborted()

    if (watch.automatic) {
      stage = 'scan'

      const scan = (await agentHost.queue.command({ kind: 'scanInvocations', watch }, 60_000)) as {
        hints?: unknown[]
        complete?: boolean
        undecryptable?: boolean
      }

      abort.signal.throwIfAborted()

      if (scan.undecryptable) {
        // A late room key is a transient readiness gap. Keep the opt-in and
        // retry with the controller's backoff; never demand a new consent.
        throw new Error('matrix_catchup_decryption_pending')
      }

      if (scan.complete !== true || scan.undecryptable || !Array.isArray(scan.hints)) {
        // Do not process a partial suffix out of order or hide unreadable input.
        if (preference) {
          agent.continuous?.pause('overflow', true)
        }

        throw new Error('matrix_catchup_incomplete')
      }

      agent.listener.backfill(watch.id, scan.hints)
    }

    stage = 'admit'

    if (
      closing ||
      state.state !== 'ready' ||
      !agentHost.ready ||
      hosts.get(agent.role) !== agentHost ||
      hosts.get('human') !== humanHost ||
      JSON.stringify(state.identity) !== JSON.stringify(human) ||
      !sameMatrixEnrollment(enrollmentOf(agent), enrolled) ||
      watch.until <= Date.now() ||
      agent.lease?.held(enrolled.identity.executorId)?.leaseToken !== held.leaseToken ||
      documents.describe({ userId: human.userId, roomId }) ||
      (policy &&
        (!isCloudAgent(agent) || executionPolicyLocal(agent) !== 'enabled' ||
          !agent.lease?.held(enrolled.identity.executorId))) ||
      (preference &&
        (continuousBinding(roomId, agent) !== preference.binding ||
          !agent.continuous?.enabled ||
          !agent.lease?.held(enrolled.identity.executorId)))
    ) {
      throw new Error('matrix_not_ready')
    }

    if (!agent.listener.commit(watch.id)) {
      throw new Error('matrix_listener_unavailable')
    }
  } catch (error) {
    // A cancellation (a pause, a stop, the next arm) is not a failure. No room or event ID.
    // Windowed: a refusal the reconcile cannot repair yet retries for as long as this Mac holds
    // the lease, and each distinct line is written at once, then at most once per ten minutes.
    if (!abort.signal.aborted) {
      listeningArmLog.line(
        `[Matrix] listening arm failed agent=${agent.principal?.slice(0, 8) ?? 'default'} mode=${policy ? 'policy' : preference ? 'automatic' : 'temporary'} stage=${stage} code=${matrixListeningArmCode(error)}`
      )
    }

    if (agent.listeningConsent === abort) {
      // No turn was admitted before commit. The continuous controller evaluates
      // current readiness instead of turning a transient race into a turn failure.
      agent.listener.stop('cancelled')
      void agentHost.queue.command({ kind: 'watchInvocations', watch: null }).catch(() => {})
    }

    throw error
  } finally {
    signal.removeEventListener('abort', cancel)

    if (agent.listeningConsent === abort) {
      agent.listeningConsent = undefined
    }
  }
}

/** Device IDs this Mac enrolled for Atum's own participants: never a person's new sign-in. */
function excludedNewSignInDevices(): Set<string> {
  const excluded = new Set<string>()

  try {
    for (const deviceId of account.agentDeviceIds()) {
      excluded.add(deviceId)
    }
  } catch {
    // An unreadable vault changes nothing here; the SDK still lists the person's devices.
  }

  return excluded
}

/**
 * The own-device watcher read the person's device list (unverified-devices.ts): raise the newest
 * device this Mac has never accounted for, once per sign-in. The first read is the baseline, so
 * this Mac's existing devices (and the owner's, on the release that adds the banner) stay quiet.
 */
function observeNewSignIn(settled = false) {
  const humanHost = hosts.get('human')
  const identity = state.identity

  // A banner belongs to one ready account sign-in; publish clears it when that changes.
  if (
    !identity ||
    !humanHost ||
    state.state !== 'ready' ||
    humanHost.identity.userId !== identity.userId ||
    humanHost.identity.deviceId !== identity.deviceId
  ) {
    return
  }

  let next: MatrixNewSignIn | undefined

  try {
    next = matrixNewSignInView({
      identity,
      read: unverifiedDevices.ownDevices(humanHost),
      shown: newSignIn,
      ledger: newSignInLedger,
      excluded: excludedNewSignInDevices(),
      settled
    })
  } catch (error) {
    const code = error instanceof Error && /^matrix_[a-z0-9_]+$/.test(error.message) ? error.message : 'unexpected'
    console.warn(`[Matrix] new sign-in check failed code=${code}`)

    if (!settled) {
      return
    }
  }

  if (newSignIn?.deviceId === next?.deviceId && newSignIn?.name === next?.name) {
    return
  }

  newSignIn = next
  newSignInFor = next ? matrixNewSignInScope(identity) : undefined
  publish(state)
}

// The platform directory is the only authority on which rooms are company channels; a room's own
// create-event type is written by whoever made the room. Reads are scoped to the signed-in account.
// With channel admission active that is the 1.4 admitted directory, private channels included; an
// older or inactive server is read on 1.1 (admitted public channels only).
const companyDirectory = (companyId: string, signal?: AbortSignal) => {
  if (config.companyWorkspace !== true || !config.domain || !state.identity) {
    return Promise.reject(new Error('matrix_company_unavailable'))
  }

  const timeout = AbortSignal.timeout(15_000)

  return readCompanyChannelDirectory(account, companyId, signal ? AbortSignal.any([timeout, signal]) : timeout)
}

const companyChannelConfirmations = new CompanyChannelConfirmations({
  read: companyDirectory,
  changed: () => publish(state)
})

// The same for company conversations (company DMs and group DMs, wire 1.5): the platform's conversation
// directory is the only authority, and a room that merely claims the type is shown nowhere.
const companyConversationConfirmations = new CompanyConversationConfirmations({
  read: (companyId, signal) => {
    if (config.companyWorkspace !== true || !config.domain || !state.identity) {
      return Promise.reject(new Error('matrix_company_unavailable'))
    }

    return account.company({ action: 'conversations', companyId }, AbortSignal.any([AbortSignal.timeout(15_000), signal]))
  },
  changed: () => publish(state)
})

/** What any window, and any notification, is shown of the rooms main holds. */
const companyProjection = <T extends MatrixSnapshot>(snapshot: T): T =>
  companyConversationConfirmations.project(companyChannelConfirmations.project(snapshot))

/** Every Matrix command that names a room passes this before it reaches the SDK, whoever asks. */
const guardRoomCommand = createRoomCommandGuard({
  rooms: () => state.rooms,
  directory: companyDirectory,
  confirmsConversation: room => companyConversationConfirmations.confirms(room)
})

/** `attend` and `typing`: presentation signals that skip the idle check but not the room guard. */
const presentationCommand = createPresentationDispatch({
  parse: parseMatrixCommand,
  guard: guardRoomCommand,
  run: value => command(value)
})

function publish(next: MatrixSnapshot) {
  if (webPreviewScope(next) !== webPreviewScope(state)) {
    webPreviews.clear()
  }

  // Domain revocation/account generation changes fence pending local work even
  // when another feature is the first to discover that the grant has expired.
  syncLocalBrain(next.identity)
  wallet?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  checkout?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  companyStore?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  store?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  officialAccounts?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  // The account may just have changed: the shared Mac names are scoped to it.
  syncExecutionDeviceNamesScope()
  // Company-channel confirmations belong to one signed-in session: a new session (or quit) voids them.
  companyChannelConfirmations.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  companyConversationConfirmations.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  if (!closing && next.state === 'ready' && next.identity && pendingMatrixDrafts) {
    void pendingMatrixDrafts.drain(next.identity, draft => dispatchSdkCommand(draft)).catch(() => {})
  }
  executionPolicies?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  cloudModelChoices?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  providerConnections?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  chatGptRelay?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  modelDestinations?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)

  for (const each of allAgents()) {
    const principal = cloudPrincipal(each)

    // The offer is read only for agents that answer in the cloud: a Mac turn never uses it.
    if (!each.closed && principal && isCloudAgent(each)) {
      cloudModelChoices?.refresh(principal)
    }

    // Every agent's card shows a destination row; the route decides whether it exists.
    if (!each.closed && principal) {
      modelDestinations?.refresh(principal)
    }
  }

  if (!matrixNewSignInSameScope(newSignInFor, next.identity)) {
    newSignIn = undefined
    newSignInFor = undefined
  }

  if (!next.identity) {
    founderChat?.reset()
    // Session-scoped placements go with the account: a fresh sign-in starts with none.
    placedAgents.reset()
    executionPolicyLocalStates.clear()
    executionPolicyReenrollments.clear()
    executionPolicyRuntimeRestarts.clear()
    executionPolicyRuntimeRestarting.clear()

    for (const listening of executionPolicyListening.values()) {
      listening.opening?.abort()

      if (listening.retry) {
        clearTimeout(listening.retry)
      }
    }

    executionPolicyListening.clear()
  }

  if (!closing && next.identity && store && pets) {
    void resumeMatrixPetHatch()
  }

  const participants = readMatrixAgentPresentation(
    Boolean(next.identity && config.domain && account?.appScope()),
    () => ({ agents: agentViews(), primary: productAgent() })
  )

  const agentList = participants?.agents
  agentActionsLog.observe(agentList)
  const primary = participants?.primary
  const primaryMacRole = primary ? cloudAgentMacRole(primary) : undefined
  const primaryAnswersInCloud = primary
    ? matrixCloudAgentAnswersInCloud({ cloudRoute: isCloudAgent(primary), role: primaryMacRole })
    : false
  const primaryLocalReadiness = primary ? readinessOf(primary) : undefined
  const primaryReadiness = primary
    ? matrixCloudAgentReadinessForUser({
        cloudRoute: isCloudAgent(primary),
        role: primaryMacRole,
        local: primaryLocalReadiness,
        since: primaryLocalReadiness?.since ?? Date.now()
      })
    : undefined
  const primarySetup = primary
    ? matrixCloudAgentSetupForUser({
        cloudRoute: isCloudAgent(primary),
        role: primaryMacRole,
        setup: primary === defaultAgent ? assistantSetupState : primary.setupState
      })
    : undefined
  const defaultAuthority = primary ? matrixEnrollmentAuthority(enrollmentOf(primary)) : { ok: false }

  const projection = projectAssistantRooms(
    next.rooms,
    next.roomId,
    primary?.identity,
    agentList,
    next.identity?.userId
  )

  const projectedRooms = projection.rooms
  const projectedRoomId = projection.roomId
  const hiddenAssistantInviteSelected = Boolean(projection.hiddenInvite)

  const move = projection.hiddenInvite?.mainRoomId
    ? `${projection.hiddenInvite.hiddenRoomId}\n${projection.hiddenInvite.mainRoomId}`
    : undefined

  if (assistantInviteCoexistences(next.rooms, projectedRooms, agentList ?? [], next.identity?.userId) > 0) {
    assistantInviteCoexistenceLog.line(
      '[Matrix] assistant invite coexistence code=matrix_assistant_invite_duplicate'
    )
  }

  if (move) {
    if (hiddenAssistantSelectionMove !== move) {
      hiddenAssistantSelectionMove = move
      void command({ kind: 'select', roomId: projection.hiddenInvite!.mainRoomId! }).catch(() => {
        if (hiddenAssistantSelectionMove === move) {
          hiddenAssistantSelectionMove = undefined
        }

        console.warn('[Matrix] assistant invite selection code=matrix_assistant_invite_selection_pending')
      })
    }
  } else {
    hiddenAssistantSelectionMove = undefined
  }

  if (!next.identity) {
    profiles.stop()
    assistantNames.stop()
    documents?.reset()
  } else {
    documents?.retainRooms(
      next.identity.userId,
      projectedRooms.filter(room => usableAgentRoom(room)).map(room => room.id)
    )
    documents?.retainTextRoom(projectedRoomId ? { userId: next.identity.userId, roomId: projectedRoomId } : null)

    if (projectedRoomId !== state.roomId) {
      documents?.closePreviews()
      void documents?.hideWord()
    }
  }

  if (!next.identity) {
    for (const each of allAgents()) {
      each.promptNotice = undefined
    }

    defaultAgent.identity = undefined
    defaultAgent.agentPrincipal = undefined
    defaultAgent.matrixUser = undefined
  }

  const apps = next.identity ? appsSnapshot() : undefined
  const official = next.identity ? officialAccounts?.snapshot() : undefined

  if (!next.identity) {
    firstRun.reset()
    firstRunProgress = {}
    firstRunWelcome.reset()
    protectedFolderDeniedOwner = undefined
  }

  const firstRunIsOpen = Boolean(
    matrixFirstRunOpen({
      identity: Boolean(next.identity),
      primary: Boolean(primary),
      marker: next.firstRunMarker,
      welcome: next.firstRunWelcome
    }) && firstRun.view(next.firstRunMarker)
  )

  // The source store historically defaulted to on for existing accounts. A genuinely new
  // account gets a create-only snapshot with every prompt-free source on (Google, Team spaces,
  // Location); Mac folders, Messages and Browser wait for the macOS step in the first-run ask.
  // Confirmed legacy Google grants migrate once to the owner's automatic default. Subsequent
  // explicit off choices remain authoritative across publishes.
  if (next.identity) {
    try {
      const store = macSourcesConsentStore()

      const initialized = (firstRunIsOpen
        ? store.initializeFirstRunDefaults()
        : store.initializeExistingOpen()) ?? store.initializeConnectedGoogle(
          Object.values(googleConnections?.services() ?? {}).some(Boolean)
        )

      if (initialized) {
        writeMacSourcesPolicy(macSourcesPolicyFile(), initialized)
        sourceGateSync?.reconcile()
        announceSourceChoicesChanged()
      }
    } catch {
      console.warn(`[Matrix] source gates: could not initialize ${firstRunIsOpen ? 'first-run' : 'existing'} account`)
    }
  }

  state = {
    ...next,
    roomId: projectedRoomId,
    destination: hiddenAssistantInviteSelected ? null : next.destination,
    ...(hiddenAssistantInviteSelected ? { members: [], messages: [], typing: [], threads: [], canSend: false } : {}),
    // Whether the recovery key is kept here quietly, until the person writes it down.
    security: securityView(next.security, next.identity),
    deviceIsolation: isolationView(),
    disk: diskHealth,
    deviceDamaged:
      next.identity && (ownDeviceDamaged === `${next.identity.userId}\n${next.identity.deviceId}` ||
        ownerDeviceRepair?.replacing(next.identity)) ? true : undefined,
    ownerDeviceRepair: ownerDeviceRepair?.snapshot(next.identity),
    deviceControlRequired: next.identity && deviceControlOwner?.userId === next.identity.userId &&
      deviceControlOwner?.deviceId === next.identity.deviceId ? true : undefined,
    newSignIn,
    // macOS denial appears only after a real protected-folder read, wherever the agent runs.
    firstRun:
      next.identity?.userId === protectedFolderDeniedOwner
        ? 'blocked'
        : matrixFirstRunAvailable({
              identity: Boolean(next.identity),
              primary: Boolean(primary),
              assistantPath: config.assistantPath ?? 'local',
              cloudOnly: isCloudOnlyAgent(primary),
              marker: next.firstRunMarker,
              welcome: next.firstRunWelcome
            })
          ? firstRun.view(next.firstRunMarker)
          : undefined,
    ...(next.identity && Object.keys(firstRunProgress).length ? { firstRunProgress } : {}),
    // The welcome is the account's, wherever its primary answers (a
    // new account's primary is cloud-placed), until the marker is answered or this window records
    // the answer. `view` is already empty for both.
    ...(firstRunIsOpen ? { firstRunOpen: true as const } : {}),
    wallet: wallet?.snapshot(),
    store: store?.snapshot(),
    checkout: checkout?.snapshot(),
    starter: matrixStarterNotice(
      wallet?.snapshot(),
      next.starterMarker,
      Boolean(next.identity) && next.state === 'ready'
    ),
    ownProfile: next.identity && next.ownProfile?.userId === next.identity.userId ? next.ownProfile : undefined,
    petScope: next.identity ? petScopeToken() : undefined,
    apps,
    assistant: primary?.identity,
    appParticipants: next.identity
      ? apps?.apps.flatMap(app => {
          const host = hosts.get(`app:${app.app}`)

          return host ? [{ appId: app.app_id, userId: host.identity.userId, ready: Boolean(host.ready) }] : []
        })
      : undefined,
    appTurn:
      primary?.invocation?.app && primary.invocation.roomId && !primary.invocation.abort.signal.aborted
        ? { appId: primary.invocation.app.id, roomId: primary.invocation.roomId }
        : undefined,
    rooms: projectedRooms,
    hermesActivity:
      next.identity && !primary?.invocation?.abort.signal.aborted ? primary?.invocation?.activity : undefined,
    linkedDocument:
      next.identity && projectedRoomId
        ? (documents?.describe({ userId: next.identity.userId, roomId: projectedRoomId }) ?? null)
        : null,
    webPreview: webPreviews.view(webPreviewScope(next)),
    terminals: terminals.view(webPreviewScope(next)),
    terminalRead: terminals.readRequest(webPreviewScope(next)),
    domainEnabled: Boolean(config.domain),
    companyWorkspaceEnabled: Boolean(config.companyWorkspace && config.domain),
    companyDriveFilesEnabled: Boolean(config.companyDriveFiles && config.companyWorkspace && config.domain),
    companyProjectSourcesEnabled: Boolean(config.companyProjectSources && config.companyWorkspace && config.domain),
    companyProjectReaderEnabled: Boolean(config.companyProjectReader && config.companyProjectSources && config.companyWorkspace && config.domain),
    companyFundingEnabled: Boolean(config.companyFunding && config.companyWorkspace && config.domain),
    homeserver: config.server,
    readiness: next.identity ? primaryReadiness : undefined,
    localTurns:
      next.identity && projectedRoomId
        ? localTurnView(projectedRoomId, next.messages, projectedRooms, next.identity.userId)
        : undefined,
    assistantPath: config.assistantPath ?? 'local',
    ...matrixAgentModelView({
      managedModel: Boolean(managedModel),
      ownModel: primary?.ownModel,
      connectedModel: primary?.connectedModel,
      cloud: isCloudAgent(primary),
      local: !isCloudOnlyAgent(primary)
    }),
    assistantSetup: defaultAuthority.ok ? primarySetup : undefined,
    startup: defaultAuthority.ok && primary === defaultAgent && !primaryAnswersInCloud ? startupState : undefined,
    agentCleanupRequired,
    hermesListening: primary?.continuous?.snapshot() ?? primary?.listener.snapshot(),
    hermesPromptNotice: primary?.promptNotice,
    hermesPrompts:
      primary?.invocation?.prompts && primary.invocation.roomId && !primary.invocation.abort.signal.aborted
        ? { roomId: primary.invocation.roomId, prompts: primary.invocation.prompts.snapshot() }
        : undefined,
    hermes: primary ? hermesState(primary) : 'unavailable',
    agents: agentList,
    agentRoster: next.identity ? agentRosterReadiness : undefined,
    agentTurns: next.identity ? agentTurns() : undefined,
    agentCreation: next.identity ? agentCreation : undefined,
    googleAssistant: next.identity && next.state === 'ready' ? googleAssistant.view() : undefined,
    signInMethods: next.identity ? undefined : { email: emailSignIn.value() },
    // Who Atum marks, and the founder with this account's chat (founder-chat.ts): only with an
    // identity, and absent while the platform cannot be read.
    officialAccounts: official?.accounts,
    founder: matrixFounderView(official, next.founderChat, next.identity?.userId)
  }

  if (!state.identity && !closing && account) {
    emailSignIn.want()
  }

  founderChat?.reconcile()
  launchSummary.observe(state.identity && state.state === 'ready' ? state.agents : undefined)

  if (!closing) {
    // An account nobody has evaluated gets its welcome record once (first-run-welcome.ts).
    firstRunWelcome.observe(state)
  }

  drive?.activate(Boolean(state.identity))

  // First run: Drive sets itself up once the account is ready and Atum's window is on screen
  // (the browser consent then has its context), once per account per Mac, and only while Drive
  // is open to every account (drive.autoConnect asks the server first).
  if (state.identity && state.state === 'ready' && ui && !ui.isDestroyed() && ui.isVisible()) {
    drive?.autoConnect()
  }

  petOverlays?.observe()
  notifications.reconcile()
  appMenu.apply(state)

  if (ui && !ui.isDestroyed()) {
    applyMatrixDisplayZoom(ui.webContents, state)
    // Main keeps the rooms' own claims; the window only sees a company channel the directory confirms.
    ui.webContents.send(channel.snapshot, companyProjection(state))
  }

  if (state.identity && state.state === 'ready') {
    desktopServices?.synced()
  }

  desktopServices?.refreshBusy()

  for (const each of allAgents()) {
    refreshHermesHomeRoom(each)
    refreshCronTicker(each)
  }

  scheduleConversationPreviews()

  for (const each of allAgents()) {
    refreshGoogleTools(each)
  }

  scheduleContinuousListening()

  // A retired agent's chats leave the chat list once the chats are synced (retired-agent-rooms.ts).
  if (!closing) {
    void retiredAgentRooms.sweep({ owner: state.identity?.userId, ready: state.state === 'ready', rooms: state.rooms })
  }
}

/** The apps' view for the window; publish never throws, so neither does this. */
function appsSnapshot(): ReturnType<NonNullable<typeof matrixApps>['snapshot']> | undefined {
  try {
    return matrixApps?.snapshot()
  } catch {
    return undefined
  }
}

/** The names the apps in the current catalog go by: not an assistant's to take (shared/matrix-assistant-name.ts). */
function appNames(): string[] {
  return appCatalogNames(appsSnapshot()?.apps)
}

/** An agent's backend as the window shows it. */
function hermesState(agentRuntime: MatrixAgentRuntime): NonNullable<MatrixSnapshot['hermes']> {
  // The roster/cloud placement is the authority for a remotely answered assistant. This Mac's
  // optional standby runtime may be absent or starting without making the healthy cloud backend
  // unavailable in the chat.
  if (
    matrixCloudAgentAnswersInCloud({
      cloudRoute: isCloudAgent(agentRuntime),
      role: cloudAgentMacRole(agentRuntime)
    })
  ) {
    return 'ready'
  }

  if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
    return 'unavailable'
  }

  return runtimeInvalid
    ? 'invalid'
    : !runtime
      ? 'unconfigured'
      : agentRuntime.invocation && !agentRuntime.invocation.app
        ? 'running'
        : hosts.get(agentRuntime.role)?.ready
          ? 'ready'
          : 'unavailable'
}

/**
 * A cloud agent's model view, with the account-wide OpenCode Go source folded in: the server's
 * 1.4 choice and the closed provider-connections status (models and connection state). A revoked
 * choice stays visible as a subscription so the picker offers Reconnect, never a silent Atum pick.
 */
function cloudModelView(principal: string) {
  const base = cloudModelChoices?.view(principal)
  const choice = modelDestinations?.cloudChoice(principal)
  const connection = providerConnections?.view()?.connection
  const relay = chatGptRelay?.view()
  const subscription = choice?.source === 'opencode_go' || choice?.source === 'chatgpt_plan' ? choice : undefined
  const subscriptionState = subscription
    ? subscription.source === 'chatgpt_plan'
      ? relay?.state === 'enabled' ? ('connected' as const) : relay ? ('revoked' as const) : ('unavailable' as const)
      : connection?.state === 'connected' ? ('connected' as const) : connection ? ('revoked' as const) : ('unavailable' as const)
    : connection?.state === 'connected'
      ? ('connected' as const)
      : relay?.state === 'enabled'
        ? ('connected' as const)
        : connection || relay
        ? ('disconnected' as const)
        : ('unavailable' as const)
  const models = subscription?.source === 'chatgpt_plan'
    ? relay?.state === 'enabled' ? relay.models : []
    : connection?.state === 'connected' ? connection.models : []

  if (!base && !subscription) {
    return undefined
  }

  return {
    offered: base?.offered ?? [],
    ...(base?.current ? { current: base.current } : {}),
    ...(subscription
      ? {
          subscription: {
            source: subscription.source,
            model: subscription.model,
            effort: subscription.effort,
            displayName: models.find(model => model.id === subscription.model)?.displayName ?? subscription.model
          }
        }
      : {}),
    ...(models.length
      ? {
          subscriptionModels: models.map(model => ({
            id: model.id,
            displayName: model.displayName,
            efforts: [...model.efforts],
            defaultEffort: model.defaultEffort
          }))
        }
      : {}),
    subscriptionState
  }
}

/** The person's agents for the window, the default first (§2.4). */
function agentViews(): MatrixAgentView[] {
  return allAgents().flatMap(each => {
    // A retired physical root remains only as inert local custody for historical rooms.
    if (each.closed) {
      return []
    }

    const principal = each.agentPrincipal
    const userId = each.userId
    const localSetup = each === defaultAgent ? assistantSetupState : each.setupState
    const listening = each.continuous?.snapshot() ?? each.listener.snapshot()
    const content = agentContent.view(agentContentTarget(each))
    const authority = matrixEnrollmentAuthority(enrollmentOf(each))
    const localReadiness = readinessOf(each)
    const destinations = modelDestinations?.view(principal)
    const cloudModel = isCloudAgent(each) ? cloudModelView(principal) : undefined
    const macRole = cloudAgentMacRole(each)
    const readiness = matrixCloudAgentReadinessForUser({
      cloudRoute: isCloudAgent(each),
      role: macRole,
      local: localReadiness,
      since: localReadiness?.since ?? Date.now()
    })
    const setup = matrixCloudAgentSetupForUser({
      cloudRoute: isCloudAgent(each),
      role: macRole,
      setup: localSetup
    })

    return principal && userId
      ? [
          {
            principal,
            userId,
            ...(authority.ok && each.assistantId ? { assistantId: each.assistantId } : {}),
            avatarUrl: each.avatarUrl,
            ...(each.identity ? { deviceId: each.identity.deviceId } : {}),
            ...(each.name ? { name: each.name } : {}),
            ...(each.title ? { title: each.title } : {}),
            ...(each.mark ? { mark: each.mark } : {}),
            ...(each.hire ? { hire: each.hire } : {}),
            ...(hosts.get(each.role)?.profile?.userId === userId ? { profile: hosts.get(each.role)!.profile } : {}),
            isDefault: each === productAgent(),
            ready: matrixAgentAnswerReady({
              cloudRoute: isCloudAgent(each),
              role: macRole,
              localAuthority: authority.ok,
              localHostReady: Boolean(hosts.get(each.role)?.ready)
            }),
            hermes: hermesState(each),
            ...(readiness ? { readiness } : {}),
            ...(authority.ok && setup ? { setup } : {}),
            ...(({ atumModel, ownModel, connectedModel, localModel }) => ({
              atumModel,
              ownModel,
              ...(connectedModel ? { connectedModel } : {}),
              ...(localModel ? { localModel } : {})
            }))(
              matrixAgentModelView({
                managedModel: Boolean(managedModel),
                ownModel: each.ownModel,
                connectedModel: each.connectedModel,
                cloud: isCloudAgent(each),
                local: !isCloudOnlyAgent(each)
              })
            ),
            ...(listening ? { listening } : {}),
            ...(content ? { content } : {}),
            ...(AGENT_ONE_CONVERSATION && conversations.get(each)?.current() && conversations.get(each)?.view
              ? { conversation: conversations.get(each)!.view }
              : {}),
            ...(executionPolicies?.snapshot(principal)
              ? { executionPolicy: executionPolicies.snapshot(principal) }
              : {}),
            ...(home => (home ? { home } : {}))(agentHomeView(principal)),
            ...(isCloudAgent(each)
              ? {
                  answering: 'cloud' as const,
                  ...(hostRuntimeAgents.has(principal) ? { runtime: 'hermes' as const } : {}),
                  ...(cloudModel ? { cloudModel } : {})
                }
              : {}),
            ...(destinations ? { modelDestinations: destinations } : {}),
            ...(macRole ? { macRole } : {}),
            ...(macRole === 'answering' && cloudHomeAgentMemoryNote(each)
              ? { memoryNote: cloudHomeAgentMemoryNote(each) }
              : {}),
            ...(leaseHandover.persistent(each) ? { answeringTrouble: 'handover' as const } : {})
          }
        ]
      : []
  })
}

/** Every agent's work in progress, by room: activity, open prompts, prompt notice (§2.4). */
function agentTurns(): MatrixAgentTurnView[] {
  const rooms = new Map<string, MatrixAgentTurnView>()

  const row = (roomId: string) => {
    let value = rooms.get(roomId)

    if (!value) {
      value = { roomId }
      rooms.set(roomId, value)
    }

    return value
  }

  for (const each of allAgents()) {
    const turn = each.invocation

    if (turn?.roomId && !turn.app && !turn.abort.signal.aborted) {
      const value = row(turn.roomId)
      const prompts = turn.prompts?.snapshot()

      if (turn.activity) {
        value.activity = turn.activity
      }

      if (prompts?.length) {
        value.prompts = prompts
      }
    }

    if (each.promptNotice) {
      row(each.promptNotice.roomId).notice = each.promptNotice
    }
  }

  return Array.from(rooms.values())
}

/** The selected room's local turns, from the agent the room belongs to. */
function localTurnView(
  roomId: string,
  messages: MatrixSnapshot['messages'],
  rooms: MatrixSnapshot['rooms'],
  ownerId: string
) {
  try {
    return agentOfRoom(roomId, rooms, ownerId)?.localTurns?.view(roomId, messages) ?? []
  } catch {
    return []
  }
}

/**
 * Owner messages this Mac's own SDK sent this session (bounded). A message from a room without
 * encryption names no device, so this is how a turn knows one was typed here (invocation.ts
 * `sentHere`) rather than on the phone. Session only: after a restart such a message counts as
 * sent elsewhere.
 */
const sentHereEvents = new Set<string>()

function rememberSentHere(eventId: unknown): void {
  if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
    return
  }

  sentHereEvents.add(eventId)

  if (sentHereEvents.size > 500) {
    sentHereEvents.delete(sentHereEvents.values().next().value!)
  }
}

function dispatchSdkCommand(value: unknown, timeoutMs = matrixSdkCommandTimeout(value)) {
  const send = () =>
    hosts.get('human')?.queue.command(value, timeoutMs) ?? Promise.reject(new Error('matrix_sdk_unavailable'))

  return dispatchMatrixCommand((value as { kind?: string })?.kind, send, observeMessage, rememberSentHere)
}

function command(value: unknown, timeoutMs = matrixSdkCommandTimeout(value)) {
  return (value as { kind?: string })?.kind === 'draft' && pendingMatrixDrafts
    ? pendingMatrixDrafts.submit(
        value as Extract<MatrixCommand, { kind: 'draft' }>,
        draft => dispatchSdkCommand(draft, timeoutMs)
      )
    : dispatchSdkCommand(value, timeoutMs)
}

interface NativeConversation {
  activity: ConversationRequestActivity
  convergedMain?: string
  scope: string
  owner: Host
  service: ConversationMigrationService
  view?: MatrixConversationView
  current(): boolean
  fence?: Awaited<ReturnType<typeof conversationRuntimeFence>>
}

const conversations = new WeakMap<MatrixAgentRuntime, NativeConversation>()
const conversationHomes = new WeakMap<MatrixAgentRuntime, { scope: string; main: string; revision: string }>()
const conversationPreviewAt = new WeakMap<MatrixAgentRuntime, number>()

function conversationProjectionRevision(agent: MatrixAgentRuntime): string {
  return JSON.stringify(
    state.rooms
      .filter(room => isAssistantRoom(room, state.identity?.userId, agent.userId))
      .map(room => [room.id, room.conversationOwnerId, room.conversation])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  )
}

function conversationJournalKey(agent: MatrixAgentRuntime): string | undefined {
  const ownerId = state.identity?.userId

  if (!ownerId || !agent.userId) {
    return undefined
  }

  return `conversation-migration:${createHash('sha256')
    .update(JSON.stringify([ownerId, agent.userId]))
    .digest('hex')}`
}

function conversationPending(agent: MatrixAgentRuntime): boolean {
  if (!AGENT_ONE_CONVERSATION) {
    return false
  }

  const key = conversationJournalKey(agent)

  return Boolean(conversations.get(agent)?.activity.changing) || Boolean(key && agent.store.getItem(key))
}

function conversationIdle(agent: MatrixAgentRuntime): boolean {
  return (
    !isMovingAgent(agent) &&
    !agent.invocation &&
    !agent.lock.holder &&
    !agent.lock.waiting &&
    !agent.localTurns?.executionPending &&
    !agent.starting
  )
}

/** All facts are native/server facts. Failed enumeration never means an empty fleet or no cloud. */
function nativeConversation(agent: MatrixAgentRuntime): NativeConversation {
  const owner = hosts.get('human')
  const identity = account.identity()
  const scope = petScopeToken()

  if (
    !AGENT_ONE_CONVERSATION ||
    !owner ||
    !identity ||
    !scope ||
    !agent.userId ||
    agent.closed ||
    !matrixEnrollmentAuthority(enrollmentOf(agent)).ok
  ) {
    throw new Error('matrix_conversation_unavailable')
  }

  const existing = conversations.get(agent)

  if (existing?.scope === scope && existing.owner === owner && existing.current()) {
    return existing
  }

  const agentId = agent.userId
  const agentHost = hosts.get(agent.role)
  const principal = cloudPrincipal(agent)

  const current = () =>
    !closing &&
    state.state === 'ready' &&
    !agent.closed &&
    scope === petScopeToken() &&
    hosts.get('human') === owner &&
    hosts.get(agent.role) === agentHost &&
    account.identity()?.userId === identity.userId &&
    account.identity()?.deviceId === identity.deviceId &&
    agent.userId === agentId &&
    matrixEnrollmentAuthority(enrollmentOf(agent)).ok

  const key = conversationJournalKey(agent)!

  const requireCurrent = () => {
    if (!current()) {
      throw new Error('matrix_conversation_stale')
    }
  }

  const facts = async () => {
    requireCurrent()
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 20_000)

    try {
      const cloudRead =
        principal && cloudEnrollments ? await cloudEnrollments.current(principal, abort.signal) : undefined

      requireCurrent()
      const cloudMayAnswer = isCloudAgent(agent) || cloudRead === undefined || cloudRead !== null
      // Readiness is server-projected from this exact agent's authenticated live cloud lease.
      // Older/malformed enrollment responses parse as false, so migration stays fail-closed.
      const cloudReady = cloudRead?.conversationReady === true

      const devices = (await deviceRegistryTransport(s1Call).list(abort.signal))
        .filter(device => device.state === 'active' && device.platform === 'macos')
        .map(device => device.deviceServiceId)

      requireCurrent()
      const own = deviceIdentity?.enrollment()?.deviceServiceId

      const reports = (await owner.queue.command({
        kind: 'conversationAppVersions',
        ownerId: identity.userId,
        devices,
        ...(own && devices.includes(own)
          ? { own: { deviceServiceId: own, version: app.isPackaged ? app.getVersion() : '0.19.0', at: Date.now() } }
          : {})
      })) as unknown[]

      requireCurrent()
      const listed = Boolean(own && devices.includes(own))
      const versions = new Map(devices.map((id, index) => [id, reports[index]]))

      return {
        cloudMayAnswer,
        cloudReady,
        fleetReady: listed && conversationMacFleetReady(devices, versions),
        // Every active Mac, online or not, on 0.20: only then may an agent move to a plain room.
        // It gates replacing an existing agent's encrypted room, never making a new agent's
        // first room: a new agent has one creator (this Mac), so there is no other writer to
        // race, and its room is plain from the start (review follow-up, 2026-10-10).
        plainReady: listed && conversationMacFleetReady(devices, versions, CONVERSATION_PLAIN_FLOOR)
      }
    } catch {
      requireCurrent()

      return { cloudMayAnswer: true, cloudReady: false, fleetReady: false, plainReady: false }
    } finally {
      clearTimeout(timeout)
    }
  }

  const jobOrigins = async (action: 'count' | 'repoint', rooms: readonly string[], main?: string) => {
    requireCurrent()
    const enrolled = enrollmentOf(agent).identity
    const selectedRuntime = runtime

    if (!enrolled || !selectedRuntime) {
      throw new Error('matrix_conversation_jobs_unavailable')
    }

    const result = await conversationJobOrigins(
      selectedRuntime,
      agentHermesHome(agent, enrolled, selectedRuntime),
      { action, rooms, ...(main ? { main } : {}) },
      AbortSignal.timeout(30_000)
    )

    requireCurrent()

    return result
  }

  const entry: NativeConversation = {
    scope,
    owner,
    current,
    service: undefined!,
    activity: new ConversationRequestActivity({
      hold: active => holdOperation(agent, active),
      release: async () => {
        try {
          await entry.fence?.release()
        } finally {
          entry.fence = undefined
        }
      }
    })
  }

  const fence = async () => {
    requireCurrent()

    if (!conversationIdle(agent)) {
      throw new Error('matrix_conversation_turn_live')
    }

    if (!entry.fence) {
      const enrolled = enrollmentOf(agent).identity
      const selectedRuntime = runtime

      if (!enrolled || !selectedRuntime) {
        throw new Error('matrix_conversation_jobs_unavailable')
      }

      entry.fence = await conversationRuntimeFence(
        selectedRuntime,
        agentHermesHome(agent, enrolled, selectedRuntime),
        AbortSignal.timeout(5 * 60_000)
      )
    }

    requireCurrent()

    if (!entry.fence.held() || !conversationIdle(agent)) {
      throw new Error('matrix_conversation_turn_live')
    }
  }

  entry.service = new ConversationMigrationService({
    current,
    idle: () => current() && conversationIdle(agent),
    knownMain: () =>
      resolveProjectedConversation(state.rooms, identity.userId, agentId).main ??
      (conversationHomes.get(agent)?.scope === scope ? conversationHomes.get(agent)?.main : undefined),
    read: async () => {
      requireCurrent()

      const knownMain =
        resolveProjectedConversation(state.rooms, identity.userId, agentId).main ??
        (conversationHomes.get(agent)?.scope === scope ? conversationHomes.get(agent)?.main : undefined)

      const reads = (await owner.queue.command({
        kind: 'readConversationCandidates',
        ownerId: identity.userId,
        agentId,
        knownRooms: state.rooms.filter(room => isAssistantRoom(room, identity.userId, agentId)).map(room => room.id),
        ...(knownMain ? { knownMain } : {})
      })) as ConversationCandidateRead[]

      requireCurrent()

      return reads
    },
    facts,
    jobs: (rooms, main) => jobOrigins('count', rooms, main),
    write: async write => {
      requireCurrent()

      if (!conversationIdle(agent)) {
        throw new Error('matrix_conversation_turn_live')
      }

      if (Object.keys(write.content).length) {
        const gate = await facts()
        requireCurrent()

        if ((gate.cloudMayAnswer && !gate.cloudReady) || !gate.fleetReady) {
          throw new Error('matrix_conversation_gate_changed')
        }
      }

      await fence()
      await owner.queue.command({ kind: 'writeConversationMarker', ownerId: identity.userId, agentId, ...write })
      console.warn(
        `[Matrix] conversation marker agent=${agent.principal?.slice(0, 8) ?? 'root'} role=${'role' in write.content ? write.content.role : 'cleared'} room=${matrixRoomLogHash(write.roomId)}`
      )
      requireCurrent()

      if (!entry.fence?.held()) {
        throw new Error('matrix_conversation_turn_live')
      }
    },
    readJournal: () => {
      requireCurrent()
      const raw = agent.store.getItem(key)
      const parsed = parseConversationMigrationJournal(raw)

      if (raw && !parsed) {
        throw new Error('matrix_conversation_rollback_pending')
      }

      return parsed
    },
    saveJournal: journal => {
      requireCurrent()

      if (journal) {
        agent.store.setItem(key, JSON.stringify(journal))
      } else {
        agent.store.removeItem(key)
      }
    },
    finish: async (main, rooms) => {
      requireCurrent()

      if (!conversationIdle(agent)) {
        throw new Error('matrix_conversation_turn_live')
      }

      const gate = await facts()

      if ((gate.cloudMayAnswer && !gate.cloudReady) || !gate.fleetReady) {
        throw new Error('matrix_conversation_gate_changed')
      }

      await fence()
      const selected = await owner.queue.command({ kind: 'findAssistantRoom', ownerId: identity.userId, agentId })
      requireCurrent()

      if (selected !== main) {
        throw new Error('matrix_conversation_main_changed')
      }

      const jobs = await jobOrigins('count', rooms, main)
      await fence()
      const restart = agent.homeRoom !== main || jobs > 0
      const running = Boolean(agent.executor)

      if (restart) {
        stopListening('cancelled', agent)

        if (!conversationIdle(agent)) {
          throw new Error('matrix_conversation_turn_live')
        }

        await stopHermesExecutor(agent)
        requireCurrent()
        await jobOrigins('repoint', rooms, main)
        await fence()
      }

      conversationHomes.set(agent, { scope, main, revision: conversationProjectionRevision(agent) })

      if (agent.continuous?.enabled) {
        const binding = continuousBinding(main, agent)

        if (binding) {
          agent.continuous.enable(binding, main)
        }
      }

      if (restart && running) {
        // The durable journal and change scope continue to refuse turns during this start.
        agent.operation = false

        try {
          if (!(await startAssistantHermes(agent))) {
            throw new Error('matrix_conversation_restart_failed')
          }
        } finally {
          agent.operation = true
        }

        requireCurrent()
        await fence()
      }

      entry.convergedMain = main
    },
    create: async reuse => {
      requireCurrent()
      const tag = agent.principal?.slice(0, 8) ?? 'root'
      let stage = reuse ? 'reuse' : 'create'

      try {
        const room =
          reuse ??
          (await owner.queue.command({
            kind: 'createAssistant',
            name: agent.name ?? '',
            invite: [agentId],
            direct: true,
            replaceMain: true
          }))

        requireCurrent()

        if (typeof room !== 'string' || (!agentHost && !isCloudAgent(agent))) {
          throw new Error('matrix_conversation_unavailable')
        }

        if (agentHost) {
          stage = 'owner-room-check'
          await requireAssistantRoom(room, owner, agentHost, { allowInvite: true })
          // The agent's SDK may not have synced the invitation yet: joinAgentRoom waits for it
          // (bounded) and also accepts a room the agent already joined on an earlier attempt.
          stage = 'agent-join'
          await agentHost.queue.command({
            kind: 'joinAgentRoom',
            roomId: room,
            ownerId: identity.userId,
            scope: 'assistant'
          })
        } else {
          // A cloud agent has no engine on this Mac: it takes the invite from its own (the
          // controller's room set). Only the owner's read of the new room happens here.
          stage = 'cloud-room-check'
          await owner.queue.command({
            kind: 'readAssistantRoom',
            roomId: room,
            ownerId: identity.userId,
            agentId,
            allowInvite: true
          })
        }

        console.warn(
          `[Matrix] conversation create agent=${tag} room=${matrixRoomLogHash(room)} join=${agentHost ? 'local' : 'cloud'} reused=${reuse ? 'yes' : 'no'}`
        )
        requireCurrent()

        return room
      } catch (error) {
        // Closed stage and code only: an SDK error's text can carry request data.
        const code = error instanceof Error && /^matrix_[a-z0-9_]+$/.test(error.message) ? error.message : 'unexpected'
        console.warn(`[Matrix] conversation create failed agent=${tag} stage=${stage} code=${code}`)
        throw error
      }
    },
    changed: view => {
      if (current()) {
        entry.view = view
        publish(state)
      }
    },
    now: Date.now
  })
  conversations.set(agent, entry)

  return entry
}

async function changeAgentConversation(
  agent: MatrixAgentRuntime,
  action: ConversationMigrationAction,
  roomId?: string
) {
  const entry = nativeConversation(agent)

  if (entry.activity.busy) {
    throw new Error('matrix_conversation_busy')
  }

  if (action !== 'preview' && !conversationIdle(agent)) {
    const previous = entry.view

    const view: MatrixConversationView = {
      ...(previous ?? { candidates: [], earlier: [], skipped: [], jobs: null }),
      state: 'blocked',
      reason: 'turn_live'
    }

    entry.view = view
    publish(state)

    return view
  }

  try {
    return await entry.activity.run(action === 'preview' ? 'preview' : 'change', () =>
      entry.service.request(action, roomId)
    )
  } catch {
    if (!entry.current()) {
      throw new Error('matrix_conversation_unavailable')
    }

    const previous = entry.view ?? { candidates: [], earlier: [], skipped: [], jobs: null }
    const key = conversationJournalKey(agent)

    const view: MatrixConversationView = {
      ...previous,
      state: key && agent.store.getItem(key) ? 'retry' : 'blocked',
      reason: key && agent.store.getItem(key) ? 'rollback_pending' : 'read_unavailable'
    }

    entry.view = view

    return view
  } finally {
    publish(state)
  }
}

/** One bounded background owner preview per agent/minute; the service owns all write gates. */
function scheduleConversationPreviews(): void {
  if (!AGENT_ONE_CONVERSATION || closing || state.state !== 'ready' || !state.identity || anyOperation()) {
    return
  }

  for (const agent of allAgents()) {
    if (
      agent.closed ||
      !agent.userId ||
      !matrixEnrollmentAuthority(enrollmentOf(agent)).ok ||
      Date.now() - (conversationPreviewAt.get(agent) ?? 0) < 60_000
    ) {
      continue
    }

    conversationPreviewAt.set(agent, Date.now())
    setImmediate(() => {
      if (!closing && state.state === 'ready' && !anyOperation()) {
        void (async () => {
          const view = await changeAgentConversation(agent, 'preview')
          const entry = conversations.get(agent)
          // A move whose markers are written but whose effects did not settle is resumed here
          // too: until it settles this Mac refuses the agent's every turn and its Hermes start.
          const action = entry ? conversationBackgroundAction(view, agent.homeRoom, entry.convergedMain) : undefined

          if (entry?.current() && !anyOperation() && conversationIdle(agent) && action) {
            // Marked rooms with no main: two Macs' moves crossed, and the reconcile restores one.
            const repair = action === 'reconcile' && !view.main && view.earlier.length > 0
            const moved = await changeAgentConversation(agent, action)
            console.warn(
              `[Matrix] conversation ${action} agent=${agent.principal?.slice(0, 8) ?? 'root'}${repair ? ' kind=repair' : ''} state=${moved.state} reason=${moved.reason ?? 'none'}`
            )
          }
        })().catch(() => {})
      }
    })
  }
}

const signedOwnerReaders = new Set<string>()
/** The owner SDK hosts this session prepared the reader's controls room for (0.20). */
const readerControlsPrepared = new WeakSet<Host>()

/** Every signed-in desktop asks the shell about owner-reader enrollments, so the
 * cadence is fast only while one is pending; otherwise it backs off (owner-reader-poll). */
const ownerReaderTrustPoller = createOwnerReaderTrustPoller({
  active: () => !closing && state.state === 'ready' && Boolean(hosts.get('human')) && Boolean(account.identity()),
  check: checkOwnerReaderTrust
})

function refreshOwnerReaderTrust(): void {
  ownerReaderTrustPoller.run()
}

/** Resolves whether an owner_reader enrollment is provisioning or awaiting trust. */
async function checkOwnerReaderTrust(): Promise<boolean> {
  const human = hosts.get('human')

  if (!human || !account.identity()) {
    return false
  }

  let pending = false

  // The reader reads plain rooms without the hand-off below, but stops without a controls room,
  // which only the hand-off made. Prepared once per host whenever a reader exists (idempotent).
  if (cloudEnrollments && !readerControlsPrepared.has(human)) {
    const enrollments = cloudEnrollments

    const prepared = await prepareOwnerReaderControls({
      reader: () => enrollments.reader(AbortSignal.timeout(10_000)),
      prepare: () => human.queue.command({ kind: 'awarenessPrepareControls' }, 30000),
      current: () => hosts.get('human') === human && !closing && state.state === 'ready',
      log: line => console.warn(line)
    })

    if (prepared) {
      readerControlsPrepared.add(human)
    }
  }

  try {
    const read = await account.ownerReaderTrustState()
    pending = read.pending
    const enrollment = read.enrollment

    if (!enrollment || hosts.get('human') !== human || closing || state.state !== 'ready') {
      return pending
    }

    const key = JSON.stringify([human.identity, enrollment.executorId, enrollment.handoffUntil])

    const current = async () => {
      if (hosts.get('human') !== human || closing || state.state !== 'ready') {
        throw Error('matrix_owner_reader_stale')
      }

      const value = await account.ownerReaderTrustEnrollment(enrollment.executorId)

      if (!value || hosts.get('human') !== human || closing || state.state !== 'ready') {
        throw Error('matrix_owner_reader_stale')
      }

      return value
    }

    const owner = {
      identity: human.identity,
      command: (value: Parameters<typeof human.queue.command>[0]) => human.queue.command(value, 30000)
    }

    if (!signedOwnerReaders.has(key)) {
      await human.queue.command({ kind: 'awarenessPrepareControls' }, 30000)

      if (hosts.get('human') !== human || closing || state.state !== 'ready') {
        return pending
      }

      await crossSignCurrentOwnerReader({ owner, current })
      signedOwnerReaders.add(key)
    }

    await compareCurrentOwnerReader({
      owner,
      current,
      verification: async body => {
        await current()
        const value = await account.ownerReaderVerification(enrollment.enrollmentId, body)
        await current()

        return value
      }
    })
  } catch {
    // Native connectivity/trust failures leave the enrolled reader pending.
    // Never fall back to key injection or a custom identity carrier.
  }

  return pending
}

function observeMessage<T>(send: () => Promise<T>): Promise<T> {
  return desktopServices ? desktopServices.message(send) : send()
}

/** Same dispatch/outcome engine as Hermes, separate participant and provider. */
async function runApp(appId: string, target: { roomId: string; eventId: string }, publicationOnly = false) {
  const owner = requireProductAgent()

  if (anyOperation() || domainOperation || owner.invocation || closing || state.state !== 'ready') {
    throw new Error('matrix_not_ready')
  }

  const descriptor = matrixApps!.participant(appId)
  const role = `app:${descriptor.app}` as const
  const human = hosts.get('human')!
  const agent = hosts.get(role)!
  const abort = new AbortController()

  const context = () => {
    abort.signal.throwIfAborted()
    const current = matrixApps!.participant(appId)
    const enrolled = account.appEnrollment(descriptor.app)

    if (
      closing ||
      state.state !== 'ready' ||
      !human ||
      !agent?.ready ||
      hosts.get('human') !== human ||
      hosts.get(role) !== agent ||
      current.app_version_id !== descriptor.app_version_id ||
      enrolled.state !== 'ready' ||
      !enrolled.identity ||
      enrolled.identity.appId !== descriptor.app_id ||
      enrolled.identity.appVersionId !== descriptor.app_version_id ||
      enrolled.identity.deviceId !== agent.identity.deviceId ||
      enrolled.identity.userId !== agent.identity.userId
    ) {
      throw new Error('matrix_app_unavailable')
    }

    return { human: human.identity, agent: enrolled.identity }
  }

  context()

  const pending = (async () => {
    await connectAppRoom(
      target.roomId,
      human,
      agent,
      () => {
        context()
      },
      publicationOnly
    )

    return invokeMatrixApp(
      {
        publicationOnly,
        ...(sentHereEvents.has(target.eventId) ? { sentHere: target.eventId } : {}),
        log: line => console.warn(line),
        context,
        read: async (value, timeout) => {
          await human.queue.command({
            kind: 'readAppRoom',
            roomId: target.roomId,
            ownerId: human.identity.userId,
            agentId: agent.identity.userId
          })
          context()

          return agent.queue.command(value, timeout)
        },
        authorize: value => account.invocation(value, descriptor.app),
        // Explicit app-targeted composer action is the per-turn consent. Enrollment
        // has already disclosed local room readership and addressed-only delivery.
        confirm: async () => true,
        prepare: async () => {
          context()

          return true
        },
        execute: value => account.appTurn(descriptor.app, value),
        store: outcomeStore
      },
      target,
      abort.signal
    )
  })()

  owner.invocation = { abort, pending, roomId: target.roomId, app: { slug: descriptor.app, id: appId } }
  publish(state)

  try {
    return await pending
  } finally {
    if (owner.invocation?.abort === abort) {
      owner.invocation = undefined
    }

    publish(state)
  }
}

/** The turns an intentional host stop or authority expiry must end. A replaceable core SDK
 * renderer crash is handled in startHost and preserves the main-owned Hermes runtime/turn. */
function turnsUsing(role: MatrixHostRole): MatrixTurnSlot[] {
  return matrixTurnsUsing(role, allAgents())
}

/** Joins the agent to its private room with the owner, then starts the two devices verifying
 * each other in the background: connectHermes, and the last step of creating an agent. */
async function connectAgentRoom(agentRuntime: MatrixAgentRuntime, roomId: string, humanHost: Host, agentHost: Host) {
  const human = account.identity()
  const enrolled = enrollmentOf(agentRuntime).identity

  if (!human || !enrolled) {
    throw new Error('matrix_agent_unavailable')
  }

  let stage = 'owner-room-check'

  try {
    await requireAssistantRoom(roomId, humanHost, agentHost, { allowInvite: true })
    stage = 'agent-join'
    await agentHost.queue.command({ kind: 'joinAgentRoom', roomId, ownerId: human.userId, scope: 'assistant' })
    stage = 'joined-room-check'
    await requireAssistantRoom(roomId, humanHost, agentHost)
    // A new agent is ready without verification: trust runs in the background (0.20).
    backgroundAgentTrust(
      () => ensureAgentTrust(agentRuntime, humanHost, agentHost),
      'connect',
      line => console.warn(line)
    )
  } catch (error) {
    // Closed local stage labels only: SDK failures must not leak raw requests,
    // credentials or room contents into the operator log.
    console.warn(`[Matrix] agent ${agentRuntime.principal?.slice(0, 8) ?? 'root'} connection failed at ${stage}`)
    throw error
  }
}

function ensureAgentTrust(
  agentRuntime: MatrixAgentRuntime,
  humanHost = hosts.get('human'),
  agentHost = hosts.get(agentRuntime.role)
) {
  return serializeSecurity(async () => {
    const assertCurrent = () => {
      const owner = account.identity()
      const enrolled = enrollmentOf(agentRuntime)

      if (
        closing ||
        agentRuntime.closed ||
        !humanHost ||
        !agentHost ||
        !agentHost.ready ||
        hosts.get('human') !== humanHost ||
        hosts.get(agentRuntime.role) !== agentHost ||
        !owner ||
        owner.userId !== humanHost.identity.userId ||
        owner.deviceId !== humanHost.identity.deviceId ||
        enrolled.state !== 'ready' ||
        enrolled.identity?.userId !== agentHost.identity.userId ||
        enrolled.identity?.deviceId !== agentHost.identity.deviceId
      ) {
        throw new Error('matrix_agent_identity_stale')
      }
    }

    assertCurrent()

    if (trustedAgents.get(agentHost!) === humanHost) {
      return
    }

    // The person's own device first: unlocked by itself with the key this Mac keeps
    // (owner-unlock.ts), so an assistant never waits on a step the person already took here.
    const unlocked = await unlockOwnerNow(humanHost!, assertCurrent)
    let ownerKey: string | undefined

    if (unlocked.state === 'unlocked') {
      ownerKey = unlocked.key
    } else if (unlocked.state === 'unknown') {
      throw new Error('matrix_recovery_unknown')
    } else if (unlocked.state === 'needs_key') {
      throw new Error('matrix_owner_recovery_required')
    } else {
      // A first Mac's account has no recovery yet: it is made and kept here now, so the first
      // hello never waits on it (owner-recovery.ts); the person writes it down later.
      ownerKey = await ensureMatrixOwnerRecovery({
        remembered: () => keptOwnerKey(humanHost!.identity)?.key,
        storage: () => state.security?.storage,
        command: value => humanHost!.queue.command(value, 120_000),
        remember: key => {
          retainOwnerKey(humanHost!.identity, key, { source: 'created', custody: 'device' })
          ownerKeyChanged()
          console.warn('[Matrix] recovery key made and kept on this Mac')
          publish(state)
        },
        assertCurrent
      })

      if (!ownerKey) {
        throw new Error('matrix_owner_recovery_required')
      }
    }

    const started = Date.now()
    const label = agentRuntime.principal?.slice(0, 8) ?? 'root'

    // The fallback handshake is main's own business (quiet verification, C1): from the moment
    // main starts its request to this agent's device, that request never reaches the window.
    const ownerCommand = async (value: MatrixSdkCommand) => {
      if (value.kind !== 'agentVerificationStart') {
        return humanHost!.queue.command(value, 120_000)
      }

      backgroundVerifications.begin(agentHost!.identity, label, state.security?.verification)

      try {
        const result = await humanHost!.queue.command(value, 120_000)
        backgroundVerifications.confirm()

        return result
      } catch (error) {
        backgroundVerifications.abandon()
        throw error
      }
    }

    try {
      const result = await prepareMatrixAgentTrust({
        owner: { identity: humanHost!.identity, command: ownerCommand },
        agent: { identity: agentHost!.identity, command: value => agentHost!.queue.command(value, 120_000) },
        ownerKey,
        claim: () => account.agentIdentity(enrollmentOf(agentRuntime).identity!.executorId),
        assertCurrent,
        log: line => console.warn(line)
      })

      assertCurrent()
      trustedAgents.set(agentHost!, humanHost!)
      console.warn(`[Matrix] agent ${label} trust result=${result} ms=${Date.now() - started}`)
      launchSummary.trusted(result)
    } catch (error) {
      // The closed code with its stage (`matrix_agent_verification_cancelled:m.key_mismatch:owner`,
      // `matrix_agent_device_replaced`), never a raw error: what took server forensics on 10-05.
      const code =
        error instanceof Error && /^matrix_[a-z0-9_]+(?::[A-Za-z0-9._-]+){0,2}$/.test(error.message)
          ? error.message
          : 'unexpected'

      console.warn(`[Matrix] agent ${label} trust result=failed code=${code} ms=${Date.now() - started}`)
      launchSummary.trusted('failed')
      throw error
    } finally {
      backgroundVerifications.end()
    }
  })
}

/** This Mac's replacements of agents' executors, for the daily bound (agent-reenroll.ts). */
let reenrollments: MatrixAgentReenrollments | undefined

/**
 * Replaces one agent's executor here (agent-reenroll.ts): automatically for a device that lost
 * its keys (`device_replaced`), or on the person's Reconnect. One at a time per agent; `busy`
 * while one runs or while the root's agent can't be confirmed yet.
 */
function reenrollAgent(
  agentRuntime: MatrixAgentRuntime,
  reason: MatrixReenrollReason
): Promise<'started' | 'capped' | 'failed' | 'busy'> {
  if (agentRuntime.reenrolling) {
    return Promise.resolve('busy')
  }

  const owner = account.driveOwner()
  const label = agentRuntime.principal?.slice(0, 8) ?? 'root'

  if (closing || agentRuntime.closed || !owner || !reenrollments) {
    return Promise.resolve('failed')
  }

  // A new root enrollment takes the platform's default agent: only replace the root while it
  // serves exactly that agent, never bind it to another one.
  if (agentRuntime.principal === undefined) {
    let held: string | undefined

    try {
      held = account.retainedAgentPrincipal()
    } catch {
      held = undefined
    }

    if (productDefaultPrincipal === undefined) {
      return Promise.resolve('busy')
    }

    if (held !== productDefaultPrincipal) {
      console.warn(`[Matrix] agent ${label} executor not replaced: the root serves another agent`)

      return Promise.resolve('failed')
    }
  }

  const ledger = reenrollments
  const key = matrixReenrollKey(`${owner.issuer}\n${owner.subject}`, agentRuntime.principal)

  const running: Promise<'started' | 'capped' | 'failed'> = (async () => {
    const enrolled = enrollmentOf(agentRuntime).identity

    // The root's home is named by its executor: it moves to the new one at its next host start.
    if (agentRuntime.principal === undefined && runtime) {
      agentRuntime.carryHome = enrolled
        ? matrixHermesHome(runtime, enrolled.principal, enrolled.executorId)
        : account.retainedAgentHermes(cloudPrincipal(agentRuntime))?.home
    }

    const result = await reenrollMatrixAgent(
      {
        label,
        device: () => {
          const identity = enrollmentOf(agentRuntime).identity

          if (identity) {
            return { userId: identity.userId, deviceId: identity.deviceId }
          }

          try {
            return account.retainedAgentDevice(agentRuntime.principal)
          } catch {
            return undefined
          }
        },
        stop: () => stopHost(agentRuntime.role),
        revoke: async () => {
          if (agentRuntime.principal === undefined) {
            await account.revokeHermes()
          } else {
            await account.revokeAgent(agentRuntime.principal)
          }

          agentRuntime.identity = undefined
        },
        erase: device => clearDevice(device),
        restart: () => {
          agentRuntime.reconnectRequired = undefined
          agentRuntime.setupState = undefined
          // After this replacement has let go of the agent (the gate refuses while it runs).
          setImmediate(() => agentRuntime.readiness?.start())
        },
        log: line => console.warn(line)
      },
      ledger,
      key,
      reason
    )

    if (result === 'capped') {
      agentRuntime.carryHome = undefined
      agentRuntime.reconnectRequired = 'capped'
    }

    return result
  })()
    .catch(error => {
      const code = error instanceof Error && /^matrix_[a-z0-9_]+$/.test(error.message) ? error.message : 'unexpected'
      console.warn(`[Matrix] agent ${label} executor replacement failed code=${code}`)
      agentRuntime.reconnectRequired = 'failed'

      return 'failed' as const
    })
    .finally(() => {
      if (agentRuntime.reenrolling === running) {
        agentRuntime.reenrolling = undefined
      }

      scheduleExecutionPolicyReconcile()
      publish(state)
    })

  agentRuntime.reenrolling = running
  publish(state)

  return running
}

async function requireAssistantRoom(
  roomId: string,
  humanHost: Host,
  agentHost: Host,
  options: { allowInvite?: boolean; forTurn?: boolean } = {}
) {
  const agentRuntime = allAgents().find(each => hosts.get(each.role) === agentHost)
  const pending = () => Boolean(options.forTurn && agentRuntime && conversationPending(agentRuntime))
  await requireAssistantConversation(
    () =>
      humanHost.queue.command({
        kind: 'readAssistantRoom',
        roomId,
        ownerId: humanHost.identity.userId,
        agentId: agentHost.identity.userId,
        ...options
      }),
    () =>
      !closing &&
      state.state === 'ready' &&
      hosts.get('human') === humanHost &&
      Array.from(hosts.values()).includes(agentHost) &&
      Boolean(agentHost.ready) &&
      !pending(),
    pending
  )
}

/**
 * A group one of the owner's assistants answers in, re-read in full from the server through
 * the owner's SDK (readGroupRoom): who is in it now, from which the group's mode follows.
 */
async function requireGroupRoom(roomId: string, humanHost: Host, agentHost: Host): Promise<MatrixGroupRoomRead> {
  const read = (await humanHost.queue.command({
    kind: 'readGroupRoom',
    roomId,
    ownerId: humanHost.identity.userId,
    agentId: agentHost.identity.userId
  })) as MatrixGroupRoomRead | null

  if (
    closing ||
    state.state !== 'ready' ||
    hosts.get('human') !== humanHost ||
    !Array.from(hosts.values()).includes(agentHost) ||
    !agentHost.ready ||
    !Array.isArray(read?.members)
  ) {
    throw new Error('matrix_not_ready')
  }

  return read
}

/** Every one of the owner's own assistants (any Mac's), by Matrix user: a group of only them
 * and the owner is a private meeting (shared/matrix-group-room.ts). */
function ownAgentUserIds(): string[] {
  return allAgents().flatMap(each => (!each.closed && each.userId ? [each.userId] : []))
}

/**
 * The owner's assistants just invited to a group join it, each through its own host on this
 * Mac (an agent never joins a room by itself). Any that couldn't stay invited. The picker has
 * already shown the routing disclosure; after a successful join, record that fact in the
 * owner's room policy. Older groups without the marker disclose inside the room before routing.
 */
async function joinGroupAgents(roomId: string, userIds: readonly string[]) {
  let missed = false
  const joined: string[] = []
  // Each agent takes only its owner's invitation to a plain group (sdk.ts `joinAgentRoom`).
  const ownerId = account.identity()?.userId ?? ''

  for (const userId of userIds) {
    const agentRuntime = allAgents().find(each => !each.closed && each.userId === userId)
    const host = agentRuntime ? hosts.get(agentRuntime.role) : undefined

    try {
      if (!host?.ready) {
        throw new Error('matrix_agent_unavailable')
      }

      await host.queue.command({ kind: 'joinAgentRoom', roomId, ownerId, scope: 'group' }, 30_000)
      joined.push(userId)
    } catch {
      missed = true

      continue
    }
  }

  const humanHost = hosts.get('human')

  if (joined.length && humanHost?.identity.userId === ownerId && hosts.get('human') === humanHost) {
    await humanHost.queue
      .command({
        kind: 'ownerGroupPolicy',
        roomId,
        ownerId,
        agentIds: joined,
        change: { routingDisclosure: 1 }
      })
      .then(requireGroupPolicyRead)
      .catch(() => console.warn('[Matrix] group routing disclosure marker will be retried in the room'))
  }

  publish(state)

  if (missed) {
    throw new Error('matrix_group_agent_unavailable')
  }
}

/**
 * An agent host's watch over its groups (src/matrix/group-turns.ts): from now on, the owner's
 * new messages there that name the agent or reply to it become hints. Armed each time the host
 * comes up; a message sent while it was away is not answered.
 */
function armGroupTurns(agentRuntime: MatrixAgentRuntime, host: Host, since = Date.now()) {
  let owner: string | undefined

  try {
    owner = account?.identity()?.userId
  } catch {
    owner = undefined
  }

  owner ??= state.identity?.userId

  // A cloud-route agent this Mac keeps ready under the saved policy watches its groups too: the
  // lease (taken on demand, as for any group turn) decides whether this Mac answers.
  if (!owner || closing || agentRuntime.closed || isCloudOnlyAgent(agentRuntime)) {
    return
  }

  agentRuntime.groupWatchSince = since
  void host.queue
    .command({ kind: 'watchGroupTurns', watch: { owner, since, agentIds: ownAgentUserIds() } })
    .catch(() => {
      if (agentRuntime.groupWatchSince === since) {
        agentRuntime.groupWatchSince = undefined
      }
    })
}

/** Hidden task rooms are a transport only. Every hint is re-read and rebound to the live roster. */
async function offerAgentTask(agentRuntime: MatrixAgentRuntime, host: Host, value: unknown): Promise<void> {
  const hint = value as { watchId?: unknown; roomId?: unknown; eventId?: unknown }
  const identity = enrollmentOf(agentRuntime).identity
  const human = account.identity()

  if (
    hint.watchId !== MATRIX_AGENT_TASK_WATCH_ID ||
    typeof hint.roomId !== 'string' ||
    typeof hint.eventId !== 'string' ||
    !identity ||
    !human ||
    closing ||
    agentRuntime.closed ||
    hosts.get(agentRuntime.role) !== host ||
    !host.ready
  ) {return}

  const binding = (await host.queue.command({
    kind: 'readAgentTaskRoom',
    roomId: hint.roomId,
    ownerId: human.userId,
    agentPrincipal: identity.agentPrincipal,
    agentUserId: identity.userId
  })) as AgentTaskBinding

  const message = (await host.queue.command({
    kind: 'readInvocation',
    roomId: hint.roomId,
    eventId: hint.eventId
  })) as MatrixInvocationMessage

  const marker = agentTaskMessage(message?.content?.agentTask)
  const scope = account.appScope()
  const roster = scope ? await account.agents(AbortSignal.timeout(15_000)).catch(() => undefined) : undefined
  const origin = roster?.find(agent => agent.status === 'active' && agent.principal === binding?.originPrincipal)
  const target = roster?.find(agent => agent.status === 'active' && agent.principal === binding?.targetPrincipal)
  const currentMain = roster?.find(agent => agent.status === 'active' && agent.isDefault && agent.matrixUser)

  if (
    !roster ||
    !scope ||
    account.appScope()?.accountKey !== scope.accountKey ||
    account.appScope()?.generation !== scope.generation ||
    !binding ||
    binding.owner !== human.userId ||
    binding.targetPrincipal !== identity.agentPrincipal ||
    binding.targetUser !== identity.userId ||
    origin?.matrixUser !== binding.originUser ||
    target?.matrixUser !== binding.targetUser ||
    message?.roomId !== hint.roomId ||
    message.eventId !== hint.eventId ||
    message.wireType !== 'm.room.message' ||
    message.roomPlain !== true ||
    message.senderVerified !== true ||
    message.senderDevice !== MATRIX_PLAIN_SENDER_DEVICE ||
    message.related !== false ||
    message.content?.msgtype !== 'm.text' ||
    typeof message.content.body !== 'string' ||
    !message.content.body.trim() ||
    !marker ||
    marker.taskId !== binding.taskId
  ) {return}

  if (marker.kind === 'start') {
    if (
      message.sender !== binding.originUser ||
      marker.at !== binding.createdAt
    ) {return}

    const savedOutcome = hasStoredMatrixAgentTaskOutcome(agentRuntime.store, { human, agent: identity }, binding)

    if (!savedOutcome && (
      binding.expiresAt <= Date.now() ||
      !currentMain?.matrixUser ||
      currentMain.principal !== binding.mainPrincipal ||
      currentMain.matrixUser !== binding.mainUser
    )) {return}

    const controls = controlsForAgentTask(agentRuntime)

    if (!controls.admitStart(hint.eventId)) {return}
    void runAgentTask(agentRuntime, host, {
      roomId: hint.roomId,
      eventId: hint.eventId,
      taskId: binding.taskId
    }, controls)
      .catch(() => {})
      .finally(() => controls.finishStart(hint.eventId as string))

    return
  }

  if (!['stop', 'steer'].includes(marker.kind)) {return}

  if (
    binding.expiresAt <= Date.now() ||
    !currentMain?.matrixUser ||
    currentMain.principal !== binding.mainPrincipal ||
    currentMain.matrixUser !== binding.mainUser
  ) {return}

  if (message.sender !== binding.originUser && message.sender !== currentMain.matrixUser) {return}

  controlsForAgentTask(agentRuntime).offer({
    ...marker,
    eventId: hint.eventId,
    sender: message.sender,
    body: message.content.body,
    ...(Number.isSafeInteger(message.timestamp) ? { serverAt: message.timestamp } : {})
  } as AgentTaskEvent, binding.expiresAt)
}

/** Arm recovery before live delivery. A missed invitation is found by the SDK's task scan. */
function armAgentTasks(agentRuntime: MatrixAgentRuntime, host: Host, since = Date.now()): void {
  const identity = enrollmentOf(agentRuntime).identity
  const human = account.identity()
  const scope = account.appScope()

  if (!identity || !human || !scope || closing || agentRuntime.closed) {return}

  void account.agents(AbortSignal.timeout(15_000))
    .then(async roster => {
      if (!roster || closing || agentRuntime.closed || hosts.get(agentRuntime.role) !== host ||
        account.appScope()?.accountKey !== scope.accountKey || account.appScope()?.generation !== scope.generation) {return}

      const watch = {
        id: MATRIX_AGENT_TASK_WATCH_ID,
        ownerId: human.userId,
        agentPrincipal: identity.agentPrincipal,
        agentUserId: identity.userId,
        since,
        ownedAgents: roster.flatMap(agent => agent.status === 'active' && agent.matrixUser
          ? [{ principal: agent.principal, userId: agent.matrixUser }] : [])
      }

      await host.queue.command({ kind: 'watchAgentTasks', watch })

      return host.queue.command({ kind: 'scanAgentTasks', watch })
    })
    .then(async value => {
      const scan = value as { hints?: unknown }

      if (!Array.isArray(scan?.hints)) {return}

      for (const hint of scan.hints) {await offerAgentTask(agentRuntime, host, hint).catch(() => {})}
    })
    .catch(() => {})
}

async function runAgentTask(
  agentRuntime: MatrixAgentRuntime,
  host: Host,
  target: { roomId: string; eventId: string; taskId: string },
  controls: MatrixAgentTaskControls
): Promise<void> {
  const enrolled = enrollmentOf(agentRuntime)
  const identity = enrolled.state === 'ready' ? enrolled.identity : undefined
  const human = account.identity()
  const lease = agentRuntime.lease

  if (
    !identity ||
    !human ||
    !lease ||
    !runtime ||
    closing ||
    agentRuntime.closed ||
    isCloudOnlyAgent(agentRuntime) ||
    isMovingAgent(agentRuntime)
  ) {return}

  const conversationKey = matrixConversationKey(identity, human, target.roomId, target.taskId)
  const authority = new AbortController()

  const active = controls.begin(target.taskId, {
    abort: authority,
    steer: text => agentRuntime.executor?.steer(conversationKey, text) ?? Promise.resolve(false)
  })

  agentRuntime.backgroundDemand += 1

  const publishStopped = () => host.queue.command({
    kind: 'sendAgentTask' as const,
    roomId: target.roomId,
    taskId: target.taskId,
    action: 'stopped' as const,
    body: 'Task stopped before execution.',
    transactionId: `atum-task-stopped-${target.taskId}`
  }).catch(() => undefined)

  try {
    if (active.stopped()) {
      await publishStopped()

      return
    }

    reconcileLease(agentRuntime)

    if (!lease.held(identity.executorId)) {
      try {
        await waitUntil(
          () => Boolean(lease.held(identity.executorId)) || lease.current.state === 'elsewhere',
          8_000,
          authority.signal
        )
      } catch (cause) {
        if (!active.stopped()) {throw cause}
      }
    }

    const held = lease.held(identity.executorId)

    if (active.stopped()) {
      await publishStopped()

      return
    }

    if (!held?.leaseToken || authority.signal.aborted || controlsForAgentTask(agentRuntime) !== controls) {return}

    const release = await agentRuntime.lock.acquire(target.roomId, 'agent-task', authority.signal)

    try {
      if (
        closing ||
        agentRuntime.closed ||
        hosts.get(agentRuntime.role) !== host ||
        !host.ready ||
        enrollmentOf(agentRuntime).identity?.executorId !== identity.executorId
      ) {return}

      if (agentRuntime.executor && !agentRuntime.executor.usable) {await stopHermesExecutor(agentRuntime)}
      const selectedRuntime = runtime
      agentRuntime.executor ??= new MatrixHermesExecutor(
        executorSignal => openAssistantHermes(
          selectedRuntime,
          { owner: identity.principal, executorId: identity.executorId },
          executorSignal,
          agentRuntime
        ),
        agentRuntime.store,
        observation => desktopServices?.turn(observation),
        matrixAgentSoulLifecycle(agentRuntime)
      )
      const executor = agentRuntime.executor
      const taskSignal = AbortSignal.any([authority.signal, held.signal])

      await invokeMatrixAgentTask({
        context: () => ({ human, agent: identity }),
        roster: rosterSignal => account.agents(AbortSignal.any([rosterSignal, AbortSignal.timeout(15_000)])),
        read: (command, timeoutMs) => host.queue.command(command, timeoutMs),
        authorize: input => account.invocation(input),
        // A migrated agent's result goes through the platform's outbox, which records it on the ledger itself.
        ledgerPublishes: invocationId => outboxedResult(agentRuntime, invocationId),
        leaseToken: held.leaseToken,
        store: agentRuntime.store,
        stopped: active.stopped,
        prepare: async input => executor.prepare({
          conversationKey: input.conversationKey,
          signal: input.signal
        }),
        execute: async input => {
          const prompts = new MatrixHermesPrompts(() => publish(state))
          const storeOwner = account.appScope()

          const pending = executor.run({
            prepared: input.conversation,
            conversationKey: input.conversationKey,
            invocationId: input.invocationId,
            roomId: target.roomId,
            text: input.text,
            signal: input.signal,
            deadlineAt: input.deadlineAt,
            timeoutMs: Math.max(1, input.deadlineAt - Date.now()),
            ask: prompts.ask,
            sessionModel: sessionModelOf(agentRuntime),
            onStoreDiscovery: (payload, requestSignal) => agentStoreDiscovery({
              payload,
              read: () => account.storeRequest('catalog', requestSignal),
              current: () => !requestSignal.aborted && !closing &&
                Boolean(storeOwner && account.appScope()?.accountKey === storeOwner.accountKey &&
                  account.appScope()?.generation === storeOwner.generation)
            }),
            onAppsDiscovery: (_event, _payload, requestSignal) => agentAppsDiscovery({
              read: () => account.appRequest({}),
              current: () => !requestSignal.aborted && !closing &&
                Boolean(storeOwner && account.appScope()?.accountKey === storeOwner.accountKey &&
                  account.appScope()?.generation === storeOwner.generation)
            }),
            onAgentProfile: (payload, requestSignal) => {
              const current = () => !requestSignal.aborted && !closing &&
                Boolean(storeOwner && account.appScope()?.accountKey === storeOwner.accountKey &&
                  account.appScope()?.generation === storeOwner.generation)

              return manageMatrixAgentProfile({
                originPrincipal: identity.agentPrincipal,
                request: (profileRequest, profileSignal) => requestCanonicalAgentProfile(
                  identity.agentPrincipal,
                  profileRequest,
                  profileSignal,
                  current
                ),
                current,
                saved: applyCanonicalAgentProfile
              }, payload, requestSignal)
            },
            onAgentTask: (payload, requestSignal) => manageMatrixAgentTask({
              originPrincipal: identity.agentPrincipal,
              ownerUserId: human.userId,
              roster: rosterSignal => account.agents(rosterSignal),
              command: (command, timeoutMs) => host.queue.command(command, timeoutMs),
              current: () => !requestSignal.aborted && !closing &&
                Boolean(storeOwner && account.appScope()?.accountKey === storeOwner.accountKey &&
                  account.appScope()?.generation === storeOwner.generation)
            }, payload, requestSignal),
            onChats: (payload, requestSignal) =>
              requestAgentChats(agentRuntime, identity, storeOwner, payload, requestSignal),
            onMacSources: (payload, requestSignal) =>
              requestAgentMacSources(agentRuntime, identity, storeOwner, payload, requestSignal)
          })

          agentRuntime.invocation = {
            abort: authority,
            pending,
            prompts,
            roomId: target.roomId,
            invocationId: input.invocationId,
            leaseSignal: held.signal
          }
          controls.retry(target.taskId)
          publish(state)

          try {
            return await pending
          } finally {
            if (agentRuntime.invocation?.abort === authority) {agentRuntime.invocation = undefined}
            publish(state)
            void wallet?.refresh('turn')
          }
        }
      }, target, taskSignal)
    } finally {
      release()
    }
  } finally {
    active.finish()
    agentRuntime.backgroundDemand = Math.max(0, agentRuntime.backgroundDemand - 1)
    reconcileLease(agentRuntime)
    scheduleExecutionPolicyReconcile()

    // Another task start may have arrived while this runtime was occupied. The Matrix room is
    // the durable queue; re-scan once the executor is idle so that start is not stranded.
    if (
      !closing &&
      !agentRuntime.closed &&
      hosts.get(agentRuntime.role) === host &&
      host.ready &&
      !['elsewhere', 'yielding'].includes(agentRuntime.lease?.current.state ?? 'stopped')
    ) {
      const retry = setTimeout(() => armAgentTasks(agentRuntime, host, 0), 1_000)
      retry.unref?.()
    }
  }
}

const earlierNoticeFlights = new Set<string>()

/** Live owner messages in an old private room receive static copy before any turn lock/claim. */
async function offerEarlierConversation(agent: MatrixAgentRuntime, host: Host, value: unknown): Promise<void> {
  const hint = value as { roomId?: unknown; eventId?: unknown }

  if (
    !AGENT_ONE_CONVERSATION ||
    typeof hint.roomId !== 'string' ||
    !/^![^:\s]+:[^\s]+$/.test(hint.roomId) ||
    typeof hint.eventId !== 'string' ||
    !hint.eventId.startsWith('$') ||
    hint.eventId.length > 255
  ) {
    return
  }

  const owner = hosts.get('human')
  const scope = petScopeToken()
  const identity = enrollmentOf(agent).identity
  const roomId = hint.roomId
  const eventId = hint.eventId

  const current = () =>
    !closing &&
    state.state === 'ready' &&
    scope === petScopeToken() &&
    hosts.get('human') === owner &&
    hosts.get(agent.role) === host &&
    Boolean(host.ready) &&
    enrollmentOf(agent).identity?.executorId === identity?.executorId &&
    matrixEnrollmentAuthority(enrollmentOf(agent)).ok

  const holder = () => Boolean(identity && agent.lease?.held(identity.executorId)?.leaseToken)

  if (!owner || !scope || !current() || !holder() || conversationPending(agent)) {
    return
  }

  const hash = createHash('sha256')
    .update(JSON.stringify([owner.identity.userId, host.identity.userId, roomId]))
    .digest('hex')

  if (earlierNoticeFlights.has(hash)) {
    return
  }

  earlierNoticeFlights.add(hash)

  try {
    const message = (await owner.queue.command({ kind: 'readInvocation', roomId, eventId })) as MatrixInvocationMessage

    if (
      !current() ||
      !holder() ||
      message.sender !== owner.identity.userId ||
      !message.senderVerified ||
      !matrixOwnerWireType(message.wireType) ||
      message.content.msgtype !== 'm.text' ||
      message.thread ||
      (message.related && !message.content.replyTo) ||
      Date.now() - message.timestamp > 120_000 ||
      message.timestamp > Date.now()
    ) {
      return
    }

    try {
      await requireAssistantRoom(roomId, owner, host, { forTurn: true })

      return
    } catch (error) {
      const locale = matrixAppMenuLocale(state, app.getPreferredSystemLanguages())
      await postEarlierConversationNotice(
        error,
        {
          current,
          leaseHolder: holder,
          lastDay: () => agent.store.getItem(`conversation-notice:${hash}`) ?? undefined,
          rememberDay: (_room, day) => agent.store.setItem(`conversation-notice:${hash}`, day),
          publish: async (_room, body, transactionId) => {
            await requireAssistantRoom(roomId, owner, host)

            if (!current() || !holder()) {
              throw new Error('matrix_conversation_stale')
            }

            await host.queue.command({
              kind: 'publishNotice',
              roomId,
              eventId,
              body,
              transactionId: `${transactionId}-${hash}`
            })
          }
        },
        earlierConversationNotice(locale, agent.name ?? state.rooms.find(room => room.id === roomId)?.name ?? ''),
        Date.now()
      )
    }
  } finally {
    earlierNoticeFlights.delete(hash)
  }
}

/** Group messages being taken up on this Mac: one offered twice is run once (the ledger's
 * claim, in invocation.ts, is what makes it once everywhere). */
const groupFlights = new MatrixInvocationFlights()
const groupRoomQueue = new GroupRoomQueue()
const groupTurns = new GroupTurnCorrections()
const groupCorrectionFlights = new Map<string, Promise<void>>()
const groupRoutingDisclosureFlights = new Map<string, Promise<void>>()
const groupRoutingMissFlights = new Map<string, Promise<void>>()
let groupRelevanceRouter: GroupRelevanceRouter | undefined

/** A closed code for the log, never an error's text. */
const groupLogCode = (error: unknown) =>
  error instanceof Error && /^matrix_[a-z_]+$/.test(error.message) ? error.message : 'unknown'

function offerGroupTurn(agentRuntime: MatrixAgentRuntime, host: Host, target: { roomId: string; eventId: string }) {
  const since = agentRuntime.groupWatchSince

  if (since === undefined || hosts.get(agentRuntime.role) !== host || closing || isCloudOnlyAgent(agentRuntime)) {
    return
  }

  const release = groupFlights.take(`${agentRuntime.role}\n${target.roomId}`, target.eventId)

  if (!release) {
    return
  }

  const acceptedAt = Date.now()
  const abort = new AbortController()
  const untrack = groupTurns.track({ roomId: target.roomId, eventId: target.eventId, abort })

  void applyGroupCorrection(target, since, acceptedAt)
    .catch(() => {})
    .then(() => runGroupTurn(agentRuntime, host, target, since, acceptedAt, abort.signal))
    .then(async result => {
      if (result !== 'published') {
        console.warn(`[Matrix] group message not answered here: ${result}`)
      }

      if (result === 'lease_timeout') {
        await noticeGroupMiss(agentRuntime, host, target)
      }
    })
    .catch(async error => {
      if (abort.signal.aborted) {
        console.warn('[Matrix] group message superseded by owner correction')

        return
      }

      console.warn(`[Matrix] group message not answered here: ${groupLogCode(error)}`)

      if (groupLogCode(error) === 'matrix_group_changed') {
        await noticeGroupMiss(agentRuntime, host, target)
      } else if (groupLogCode(error) === 'matrix_group_stale') {
        await noticeGroupMiss(agentRuntime, host, target, 'groupStale')
      }
    })
    .catch(() => {})
    .finally(() => {
      untrack()
      release()
    })
}

/** One owner event is read once even though every local bot may offer it. */
async function applyGroupCorrection(
  target: { roomId: string; eventId: string },
  since: number,
  acceptedAt: number
): Promise<void> {
  const humanHost = hosts.get('human')

  if (!humanHost) {
    return
  }

  const key = `${humanHost.identity.userId}\n${target.roomId}\n${target.eventId}`
  const existing = groupCorrectionFlights.get(key)

  if (existing) {
    return existing
  }

  const pending = (async () => {
    const message = (await humanHost.queue.command({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage

    const corrected = groupCorrectionTarget(message, {
      ...target,
      ownerId: humanHost.identity.userId,
      since,
      acceptedAt
    })

    if (corrected && hosts.get('human') === humanHost) {
      const stopped = groupTurns.apply(target.roomId, corrected)

      if (stopped) {
        console.info(`[Matrix] owner correction stopped ${stopped} group turn(s)`)
      }
    }
  })().finally(() => {
    if (groupCorrectionFlights.get(key) === pending) {
      groupCorrectionFlights.delete(key)
    }
  })

  groupCorrectionFlights.set(key, pending)

  return pending
}

/** Messages this Mac has already said it couldn't answer, per agent (bounded). */
const groupMisses = new Set<string>()
const groupRoutingMisses = new Set<string>()

function currentGroupLeaseToken(agentRuntime: MatrixAgentRuntime, host: Host): string | undefined {
  const enrollment = enrollmentOf(agentRuntime)

  if (
    enrollment.state !== 'ready' ||
    !enrollment.identity ||
    !host.ready ||
    hosts.get(agentRuntime.role) !== host
  ) {
    return undefined
  }

  return agentRuntime.lease?.held(enrollment.identity.executorId)?.leaseToken
}

async function waitForGroupRoutingDisclosure(
  agentRuntime: MatrixAgentRuntime,
  host: Host,
  target: { roomId: string; eventId: string },
  candidateIds: readonly string[],
  readPolicy: () => Promise<ReturnType<typeof requireGroupPolicyRead>>,
  signal: AbortSignal
): Promise<void> {
  const humanHost = hosts.get('human')
  const designatedAgentId = [...candidateIds].sort()[0]

  if (!humanHost || !designatedAgentId) {
    throw new Error('matrix_group_routing_disclosure_required')
  }

  const key = `${humanHost.identity.userId}\n${target.roomId}`
  const disclosed = async () => (await readPolicy()).policy.routingDisclosure === 1

  if (await disclosed()) {
    return
  }

  if (host.identity.userId === designatedAgentId) {
    const existing = groupRoutingDisclosureFlights.get(key)

    if (existing) {
      return existing
    }

    const pending = (async () => {
      if (await disclosed()) {
        return
      }

      const leaseToken = currentGroupLeaseToken(agentRuntime, host)

      if (!leaseToken) {
        throw new Error('matrix_group_routing_disclosure_required')
      }

      signal.throwIfAborted()
      await requireGroupRoom(target.roomId, humanHost, host)

      if (
        closing ||
        hosts.get('human') !== humanHost ||
        currentGroupLeaseToken(agentRuntime, host) !== leaseToken
      ) {
        throw new Error('matrix_group_routing_disclosure_required')
      }

      const copy =
        matrixActionCopy[
          matrixHeldReplyLocale(undefined, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages())
        ]

      const transactionId = `atum-gr-${createHash('sha256')
        .update(JSON.stringify([humanHost.identity.userId, target.roomId, 1]))
        .digest('hex')}`

      signal.throwIfAborted()
      await host.queue.command(
        { kind: 'publishGroupNotice', roomId: target.roomId, body: copy.groupJoined, transactionId },
        30_000
      )

      const result = await humanHost.queue.command({
        kind: 'ownerGroupPolicy',
        roomId: target.roomId,
        ownerId: humanHost.identity.userId,
        agentIds: [...candidateIds],
        change: { routingDisclosure: 1 }
      })

      if (requireGroupPolicyRead(result).policy.routingDisclosure !== 1) {
        throw new Error('matrix_group_routing_disclosure_required')
      }
    })().finally(() => {
      if (groupRoutingDisclosureFlights.get(key) === pending) {
        groupRoutingDisclosureFlights.delete(key)
      }
    })

    groupRoutingDisclosureFlights.set(key, pending)

    return pending
  }

  const deadline = Date.now() + 12_000

  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const local = groupRoutingDisclosureFlights.get(key)

    if (local) {
      await local

      return
    }

    if (await disclosed()) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }

      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, 250)

      signal.addEventListener('abort', abort, { once: true })

      if (signal.aborted) {
        abort()
      }
    })
  }

  throw new Error('matrix_group_routing_disclosure_required')
}

/** An ambient routing failure is visible once from the canonical candidate and lease holder. */
async function noticeGroupRoutingFailure(
  agentRuntime: MatrixAgentRuntime,
  host: Host,
  target: { roomId: string; eventId: string },
  since: number,
  acceptedAt: number,
  designatedAgentId: string
) {
  const humanHost = hosts.get('human')
  const key = `${humanHost?.identity.userId ?? ''}\n${target.roomId}\n${target.eventId}`
  const leaseToken = currentGroupLeaseToken(agentRuntime, host)

  if (
    closing ||
    !humanHost ||
    host.identity.userId !== designatedAgentId ||
    !leaseToken ||
    groupRoutingMisses.has(key)
  ) {
    return
  }

  const existing = groupRoutingMissFlights.get(key)

  if (existing) {
    return existing
  }

  const pending = (async () => {
    const message = (await humanHost.queue.command({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage
    requireGroupOwnerEvent(message, { ...target, ownerId: humanHost.identity.userId, since, acceptedAt })
    await requireGroupRoom(target.roomId, humanHost, host)

    if (
      closing ||
      hosts.get('human') !== humanHost ||
      currentGroupLeaseToken(agentRuntime, host) !== leaseToken ||
      groupRoutingMisses.has(key)
    ) {
      return
    }

    if (groupRoutingMisses.size >= 500) {
      groupRoutingMisses.clear()
    }

    const copy =
      matrixActionCopy[
        matrixHeldReplyLocale(undefined, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages())
      ]

    const transactionId = `atum-grf-${createHash('sha256')
      .update(JSON.stringify([humanHost.identity.userId, target.roomId, target.eventId]))
      .digest('hex')}`

    await host.queue.command(
      { kind: 'publishNotice', ...target, body: copy.groupRoutingUnavailable, group: true, transactionId },
      30_000
    )
    groupRoutingMisses.add(key)
  })().finally(() => {
    if (groupRoutingMissFlights.get(key) === pending) {
      groupRoutingMissFlights.delete(key)
    }
  })

  groupRoutingMissFlights.set(key, pending)

  return pending
}

/**
 * The owner asked their assistant in a group and this Mac took the message up but can't answer
 * it (the answering lease never came, or the group changed under the turn): the assistant says
 * so once, in the owner's language, instead of leaving them waiting (`groupMissed`). Only for
 * the owner's own message from a verified device that @mentions this agent, re-read through the
 * owner's SDK, in a room re-read as a group. Fixed copy, never words from any message. The
 * reasons found while reading the message (it waited too long, it came from a phone this Mac
 * wasn't answering for) are said by invocation.ts.
 */
async function noticeGroupMiss(
  agentRuntime: MatrixAgentRuntime,
  host: Host,
  target: { roomId: string; eventId: string },
  reason: 'groupMissed' | 'groupStale' = 'groupMissed'
) {
  const humanHost = hosts.get('human')
  const key = `${agentRuntime.role}\n${target.roomId}\n${target.eventId}`

  if (closing || !humanHost || !host.ready || hosts.get(agentRuntime.role) !== host || groupMisses.has(key)) {
    return
  }

  const message = (await humanHost.queue.command({
    kind: 'readInvocation',
    ...target
  })) as MatrixInvocationMessage | null

  if (
    message?.roomId !== target.roomId ||
    message.eventId !== target.eventId ||
    !matrixOwnerWireType(message.wireType) ||
    message.sender !== humanHost.identity.userId ||
    message.senderVerified !== true ||
    message.content?.msgtype !== 'm.text' ||
    message.content.invalidMentions ||
    !message.content.mentionedUserIds?.includes(host.identity.userId)
  ) {
    return
  }

  await requireGroupRoom(target.roomId, humanHost, host)

  if (groupMisses.size >= 500) {
    groupMisses.clear()
  }

  groupMisses.add(key)

  const copy =
    matrixActionCopy[
      matrixHeldReplyLocale(undefined, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages())
    ]

  await host.queue.command({ kind: 'publishNotice', ...target, body: copy[reason], group: true }, 30_000)
}

/**
 * The owner's message to their assistant in a group (owner-only, plan O1–O4):
 *
 * 1. Only the Mac that holds the agent's answering lease answers. When nobody holds it, this
 *    Mac asks for it for the turn, as a typed message would; when another Mac does, nothing
 *    runs here.
 * 2. The group is re-read through the owner's SDK; who is in it now decides its mode.
 * 3. invokeMatrixHermes (with `group`) re-reads the message: the owner's own, from a verified
 *    device, recent, naming the agent or replying to its message. Anything else is ignored
 *    before anything is prepared, claimed or charged. It is claimed once on the ledger, then
 *    runs in the group's own Hermes session for this agent, never the private one.
 */
async function runGroupTurn(
  agentRuntime: MatrixAgentRuntime,
  host: Host,
  target: { roomId: string; eventId: string },
  since: number,
  acceptedAt: number,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const enrolled = enrollmentOf(agentRuntime)
  const identity = enrolled.state === 'ready' ? enrolled.identity : undefined
  const humanHost = hosts.get('human')
  const lease = agentRuntime.lease

  if (closing || agentRuntime.closed || !identity || !lease || !humanHost || state.state !== 'ready' || !runtime) {
    return 'not_ready'
  }

  // A cloud-route agent no policy keeps on this Mac has no host here. One a saved policy keeps
  // here answers its groups only while it holds the term (below): `matrixGroupLease` sends every
  // other state to 'answered_elsewhere'.
  if (isCloudOnlyAgent(agentRuntime)) {
    return 'not_ready'
  }

  if (matrixGroupLease(lease.current.state, Boolean(lease.held(identity.executorId))) === 'not_here') {
    return 'answered_elsewhere'
  }

  agentRuntime.groupDemand += 1

  try {
    reconcileLease(agentRuntime)

    if (!lease.held(identity.executorId)) {
      await waitUntil(
        () => Boolean(lease.held(identity.executorId)) || matrixGroupLease(lease.current.state, false) === 'not_here',
        8_000,
        AbortSignal.any([signal, AbortSignal.timeout(9_000)])
      )
    }

    if (!lease.held(identity.executorId)) {
      // Nobody else took it either: this Mac asked for the lease and it didn't come.
      return matrixGroupLease(lease.current.state, false) === 'not_here' ? 'answered_elsewhere' : 'lease_timeout'
    }

    if (hosts.get(agentRuntime.role) !== host || !host.ready || hosts.get('human') !== humanHost) {
      return 'not_ready'
    }

    const human = account.identity()

    if (!human) {
      return 'not_ready'
    }

    const scope = { ...target, ownerId: humanHost.identity.userId, agentId: host.identity.userId }

    const readPolicy = async () =>
      requireGroupPolicyRead(await humanHost.queue.command({ kind: 'readRoomPolicy', ...scope }))

    const snapshot = async () => {
      if (!lease.held(identity.executorId)) {
        throw new Error('matrix_group_lease_required')
      }

      return {
        ...(await readPolicy()),
        ...(await requireGroupRoom(target.roomId, humanHost, host)),
        ownAgentIds: ownAgentUserIds()
      }
    }

    const trigger = (await humanHost.queue.command({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage
    signal.throwIfAborted()

    const admission =
      trigger.sender !== scope.ownerId
        ? await prepareGroupChain(
            { ...scope, since, acceptedAt },
            {
              read: async eventId =>
                (await humanHost.queue.command({
                  kind: 'readInvocation',
                  roomId: target.roomId,
                  eventId
                })) as MatrixInvocationMessage,
              snapshot
            }
          )
        : await prepareGroupFloor(
            { ...scope, since, acceptedAt },
            {
              ownerEvent: async () =>
                (await humanHost.queue.command({ kind: 'readInvocation', ...target })) as MatrixInvocationMessage,
              ownerDeviceDenied: deviceId => unverifiedDevices.denied(humanHost, deviceId),
              snapshot,
              relevance: async ({ message, candidateIds, ownAgentIds, routingDisclosed, replySenderId }) => {
                const owner = account.appScope()

                const current = () => {
                  const now = account.appScope()

                  if (
                    !owner ||
                    now?.accountKey !== owner.accountKey ||
                    now.generation !== owner.generation ||
                    closing ||
                    state.state !== 'ready' ||
                    hosts.get('human') !== humanHost
                  ) {
                    throw new Error('matrix_group_routing_account_changed')
                  }
                }

                const work = productAgent()?.signals?.work(target.roomId)
                const designatedAgentId = [...candidateIds].sort()[0]
                const router = groupRelevanceRouter

                try {
                  if (message.content.googleProtected) {
                    throw new Error('matrix_group_routing_protected')
                  }

                  if (!router) {
                    throw new Error('matrix_group_routing_unavailable')
                  }

                  if (!routingDisclosed) {
                    await waitForGroupRoutingDisclosure(
                      agentRuntime,
                      host,
                      target,
                      candidateIds,
                      readPolicy,
                      signal
                    )
                  }

                  return await router.decide({
                    ...target,
                    candidateIds,
                    signal,
                    load: async routingSignal => {
                      current()
                      const ids = [...candidateIds].sort()

                      const contextTarget: GroupRecentTarget = {
                        roomId: target.roomId,
                        ownerId: scope.ownerId,
                        viewerAgentId: ids[0],
                        ownAgentIds,
                        excludeEventId: target.eventId,
                        window: 'meeting',
                        purpose: 'routing',
                        limits: DEFAULT_CONTEXT_LIMITS
                      }

                      const [recent, cards] = await Promise.all([
                        humanHost.queue
                          .command({ kind: 'readGroupRecent', ...contextTarget }, 9_000)
                          .then(value => requireGroupRecentRead(value, contextTarget)),
                        Promise.all(
                          ids.map(async userId => {
                            const agent = allAgents().find(
                              candidate => candidate.userId === userId && !candidate.closed
                            )

                            if (!agent?.assistantId) {
                              throw new Error('matrix_agent_roster_unavailable')
                            }

                            const definition = await account.agentDefinition(agent.assistantId, routingSignal)
                            current()

                            if (agent.closed || agent.userId !== userId) {
                              throw new Error('matrix_group_routing_changed')
                            }

                            return {
                              userId,
                              name: agent.name,
                              role: publicGroupRoutingRole(
                                definition.definition?.soul ??
                                  (productAgent() === agent ? matrixPrimarySoulFallback(agent.name).soul : '')
                              )
                            }
                          })
                        )
                      ])

                      current()

                      return {
                        message: { text: message.content.body, senderId: message.sender, replySenderId },
                        agents: cards,
                        recent: recent.context.lines.map(line => ({ senderId: line.senderRef, text: line.text }))
                      }
                    }
                  })
                } catch (error) {
                  const code = groupLogCode(error)

                  if (
                    !signal.aborted &&
                    designatedAgentId &&
                    (code.startsWith('matrix_group_routing_') || code === 'matrix_agent_roster_unavailable')
                  ) {
                    await noticeGroupRoutingFailure(
                      agentRuntime,
                      host,
                      target,
                      since,
                      acceptedAt,
                      designatedAgentId
                    ).catch(() => {})
                  }

                  throw error
                } finally {
                  work?.stop()
                }
              },
              replySender: async eventId => {
                const quote = (await humanHost.queue.command({
                  kind: 'readReplyQuote',
                  ...scope,
                  eventId,
                  anyMember: true
                })) as { state?: string; eventId?: string; sender?: string; verified?: boolean } | null

                return quote?.state === 'message' && quote.eventId === eventId && quote.verified === true
                  ? quote.sender
                  : undefined
              }
            }
          )

    if (admission.state === 'ignored') {
      return 'ignored'
    }

    const paused = async (position: number, force = false, claimedCap?: number) => {
      await publishPausedGroupNotice(
        {
          roomId: target.roomId,
          position,
          identity,
          ...(force && claimedCap !== undefined ? { canonicalCap: claimedCap } : {})
        },
        {
          readPolicy,
          requireRoom: async () => {
            const current = enrollmentOf(agentRuntime)
            const held = lease.held(identity.executorId)

            if (
              closing ||
              state.state !== 'ready' ||
              hosts.get('human') !== humanHost ||
              hosts.get(agentRuntime.role) !== host ||
              !host.ready ||
              current.state !== 'ready' ||
              current.identity?.executorId !== identity.executorId ||
              current.identity.deviceId !== identity.deviceId ||
              !held?.leaseToken
            ) {
              throw new Error('matrix_group_lease_required')
            }

            await requireGroupRoom(target.roomId, humanHost, host)

            if (lease.held(identity.executorId)?.leaseToken !== held.leaseToken) {
              throw new Error('matrix_group_lease_required')
            }

            return held.leaseToken
          },
          authorize: input => account.groupNotice(input),
          publish: async (transactionId, cap) => {
            const locale = matrixHeldReplyLocale(
              undefined,
              state.displayPreferences?.language?.value,
              app.getPreferredSystemLanguages()
            )

            return host.queue.command(
              {
                kind: 'publishGroupNotice',
                roomId: target.roomId,
                body: groupPausedCopy[locale].replace('{cap}', String(cap)),
                transactionId
              },
              30_000
            )
          },
          recordUsage: (day, dailyTurns) =>
            humanHost.queue.command({ kind: 'writeRoomUsage', ...scope, change: 'paused', dailyTurns, day })
        }
      )
    }

    if (admission.state === 'paused') {
      await paused(admission.position)

      return 'room_cap'
    }

    return await groupRoomQueue.run(`${target.roomId}\n${scope.agentId}`, async () => {
      signal.throwIfAborted()
      let claimedCap: number | undefined

      try {
        const participation = await admission.finish()
        const { mode } = participation
        claimedCap = participation.dailyTurns

        // The message must be new since this host's group watch began and fresh (invocation.ts
        // checks both against this), and the turn ends with the lease's own turn limit. The
        // watch lives as long as the credential the turn runs under, which is renewed while it
        // runs; the turn's own cap is quiet time now, not a watch-length wall clock (§6.1 A).
        const watch: MatrixInvocationWatch = {
          id: randomUUID(),
          roomId: target.roomId,
          sender: human,
          since,
          until: identity.expiresAt
        }

        const contextTarget: GroupRecentTarget = {
          roomId: target.roomId,
          ownerId: humanHost.identity.userId,
          viewerAgentId: host.identity.userId,
          ownAgentIds: ownAgentUserIds(),
          excludeEventId: target.eventId,
          window: 'meeting',
          limits: DEFAULT_CONTEXT_LIMITS
        }

        const recent =
          mode === 'meeting'
            ? requireGroupRecentRead(
                await humanHost.queue.command({ kind: 'readGroupRecent', ...contextTarget }, 9_000),
                contextTarget
              )
            : undefined

        return matrixInvocationResult(
          await runHermes(target, undefined, watch, signal, agentRuntime, {
            ...participation,
            ...(recent ? { recent } : {})
          })
        ).state
      } catch (error) {
        if (groupLogCode(error) !== 'matrix_group_room_cap') {
          throw error
        }

        await paused(admission.position, true, claimedCap)

        return 'room_cap'
      }
    })
  } finally {
    agentRuntime.groupDemand = Math.max(0, agentRuntime.groupDemand - 1)
    reconcileLease(agentRuntime)
    scheduleExecutionPolicyReconcile()
  }
}

/** Chats known to hold earlier dialogue (by account and room): the first-run note is asked of
 * a chat until its first message passes, and a chat that has begun never needs the read again. */
const firstRunBegunChats = new Set<string>()
const FIRST_RUN_NOTE_WAIT_MS = 3_000

/**
 * The first-run naming note for a message another device sent, or nothing (invocation.ts
 * `firstRunNote`). Free for every account that is not in its first run: the window's own rule decides
 * before any room is read, and a chat that has begun is remembered. Waits briefly, never longer.
 */
async function firstRunNamingNote(
  agentRuntime: MatrixAgentRuntime,
  humanHost: Host,
  agentHost: Host,
  input: { roomId: string; eventId: string; signal: AbortSignal }
): Promise<string | undefined> {
  const key = `${humanHost.identity.userId}\n${input.roomId}`

  if (agentRuntime !== productAgent() || firstRunBegunChats.has(key) || !matrixFirstRunPlace(state, input.roomId)) {
    return undefined
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const read = await Promise.race([
      conversationContinuity({ roomId: input.roomId, before: input.eventId }, humanHost, agentHost, input.signal).read(
        undefined,
        { bounded: true }
      ),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), FIRST_RUN_NOTE_WAIT_MS)
      })
    ])

    if (!read) {
      return undefined
    }

    const note = matrixFirstRunNamingForIncoming({
      snapshot: state,
      roomId: input.roomId,
      primary: true,
      name: agentRuntime.name,
      read
    })

    if (!note && read.entries.length > 0) {
      firstRunBegunChats.add(key)
    }

    return note
  } finally {
    clearTimeout(timer)
  }
}

function conversationContinuity(
  target: Pick<MatrixContinuityTarget, 'roomId' | 'before' | 'excludeTurn'>,
  humanHost: Host,
  agentHost: Host,
  signal: AbortSignal
) {
  const current = () => {
    signal.throwIfAborted()

    if (
      closing ||
      state.state !== 'ready' ||
      hosts.get('human') !== humanHost ||
      !Array.from(hosts.values()).includes(agentHost) ||
      !agentHost.ready
    ) {
      throw new Error('matrix_not_ready')
    }
  }

  return {
    async read(stopAt?: string, options?: { bounded?: boolean }) {
      current()

      const scope: MatrixContinuityTarget = {
        ...target,
        ownerId: humanHost.identity.userId,
        agentId: agentHost.identity.userId,
        stopAt,
        ...(options?.bounded ? { bounded: true } : {})
      }

      const value = await humanHost.queue.command(
        { kind: 'readContinuity', ...scope },
        MATRIX_CONTINUITY.deadlineMs + 1_000
      )

      current()

      const read = readContinuityResult(value, scope)

      const notice = continuityDiagnostic(read)

      if (notice) {
        console.warn(notice)
      }

      return read
    }
  }
}

async function runHermes(
  target: { roomId: string; eventId: string },
  locale?: string,
  watch?: MatrixInvocationWatch,
  listenerSignal?: AbortSignal,
  agentRuntime: MatrixAgentRuntime = defaultAgent,
  group?: MatrixGroupTurn,
  /** The message's place in the listener's line (MatrixTurnLine): its wait for this lock counts. */
  line?: MatrixTurnLine
) {
  if (
    assistantBlocked({
      operation: operation || agentRuntime.operation,
      domainOperation,
      // A Hermes turn in progress is waited for (the lock below); an app turn is not.
      invocation: Boolean(agentRuntime.invocation?.app),
      closing,
      ready: state.state === 'ready',
      agentReady: Boolean(hosts.get(agentRuntime.role)?.ready),
      listening: agentRuntime.listener.snapshot()?.state === 'listening',
      fromListener: Boolean(watch)
    })
  ) {
    throw new Error('matrix_not_ready')
  }

  if (!group && AGENT_ONE_CONVERSATION) {
    const human = hosts.get('human')
    const agent = hosts.get(agentRuntime.role)

    if (!human || !agent) {
      throw new Error('matrix_not_ready')
    }

    try {
      await requireAssistantRoom(target.roomId, human, agent, { forTurn: true })
    } catch (error) {
      if (error instanceof EarlierConversationError) {
        await offerEarlierConversation(agentRuntime, agent, target).catch(() => {})
      }

      // A room read that failed on the link, for a turn the listener offered: nothing is claimed
      // yet, so the listener offers it again instead of stopping (invocation.ts `deferred`).
      const transient = watch ? matrixTransientReadFailure(error) : undefined

      if (transient) {
        console.warn(`[Matrix] invocation deferred reason=${transient} before=room`)

        return { state: 'deferred' as const, reason: transient }
      }

      throw error
    }
  }

  const release = await agentRuntime.lock.acquire(target.roomId, watch ? 'watch' : 'explicit', listenerSignal)

  try {
    return await runHermesLocked(target, locale, watch, listenerSignal, agentRuntime, group, line)
  } finally {
    release()
  }
}

async function runHermesLocked(
  target: { roomId: string; eventId: string },
  locale?: string,
  watch?: MatrixInvocationWatch,
  listenerSignal?: AbortSignal,
  agentRuntime: MatrixAgentRuntime = defaultAgent,
  group?: MatrixGroupTurn,
  line?: MatrixTurnLine
) {
  if (agentRuntime.invocation || closing || state.state !== 'ready' || !hosts.get(agentRuntime.role)?.ready) {
    throw new Error('matrix_not_ready')
  }

  const agentHost = hosts.get(agentRuntime.role)!
  const humanHost = hosts.get('human')

  if (!humanHost) {
    throw new Error('matrix_not_ready')
  }

  if (!runtime) {
    throw new Error('matrix_runtime_unconfigured')
  }

  // Once per session instead of per message: while this Mac holds the answering lease,
  // new replies keep their exactly-once record locally; otherwise (another Mac holds it,
  // or the platform is unreachable) the platform grants each message, as before.
  const enrolled = enrollmentOf(agentRuntime).identity

  requireMatrixSessionChoice(
    state.rooms.find(room => room.id === target.roomId),
    enrolled?.agentPrincipal
  )

  const lease = enrolled ? (agentRuntime.lease?.held(enrolled.executorId) ?? null) : null

  if (group && watch && !lease?.leaseToken) {
    throw new Error('matrix_group_lease_required')
  }

  if (watch?.automatic && !lease?.leaseToken) {
    throw new Error('matrix_automatic_lease_required')
  }

  const abort = new AbortController()
  agentRuntime.promptNotice = undefined
  const cancel = () => abort.abort()
  listenerSignal?.addEventListener('abort', cancel, { once: true })

  if (listenerSignal?.aborted) {
    abort.abort()
  }

  let prepared: MatrixHermesExecutor | undefined
  let statusLine: MatrixStatusLine | undefined
  let voice: MatrixTurnVoice | undefined
  const prompts = new MatrixHermesPrompts(() => publish(state))

  // A group turn (owner-only): the group, not the agent's own room, is what is re-read. Who is
  // in it must still be what the turn started with when it runs and again before anything it
  // says is posted: the same mode and, when shared, the same people. Someone added meanwhile
  // never reads an answer made for a private meeting, or one that drew on the session kept for
  // the people before them; the answer stays saved, unposted (group-turns.ts).
  const requireRoom = async () => {
    if (!group) {
      await requireAssistantRoom(target.roomId, humanHost, agentHost, { forTurn: true })

      return
    }

    const read = await requireGroupRoom(target.roomId, humanHost, agentHost)
    const owner = humanHost.identity.userId

    if (
      matrixGroupMode(read.members, owner, ownAgentUserIds()) !== group.mode ||
      (group.mode === 'shared' &&
        matrixGroupAudience(read.members, owner, ownAgentUserIds()).join('\n') !== group.audience.join('\n'))
    ) {
      throw new Error('matrix_group_changed')
    }

    const policy = requireGroupPolicyRead(
      await humanHost.queue.command({
        kind: 'readRoomPolicy',
        roomId: target.roomId,
        ownerId: owner,
        agentId: agentHost.identity.userId
      })
    )

    if (
      group.participation !== undefined &&
      effectiveMode({ roomMode: group.mode, stored: policy.policy.agents[agentHost.identity.userId]?.mode }) !==
        group.participation
    ) {
      throw new Error('matrix_group_changed')
    }

    if (group.chain) {
      const chain = await prepareGroupChain(
        {
          ...target,
          ownerId: owner,
          agentId: agentHost.identity.userId,
          since: watch?.since ?? 0,
          acceptedAt: group.floor?.acceptedAt ?? Date.now()
        },
        {
          read: async eventId =>
            (await humanHost.queue.command({
              kind: 'readInvocation',
              roomId: target.roomId,
              eventId
            })) as MatrixInvocationMessage,
          snapshot: async () => ({ ...policy, ...read, ownAgentIds: ownAgentUserIds() })
        }
      )

      const current = await chain.finish()

      if (JSON.stringify(current.chain) !== JSON.stringify(group.chain)) {
        throw new Error('matrix_group_changed')
      }
    }

    return read
  }

  const pending = (async () => {
    // A group is re-read now, before anything else. The private room was read just before the
    // turn lock (runHermes) and is read again after the claim, before dispatch (`conversation`).
    if (group) {
      await requireRoom()
    }

    abort.signal.throwIfAborted()

    const petSurface =
      !group && (await privatePetIntentSurface(agentRuntime, target.roomId, humanHost, agentHost, abort.signal))

    return invokeMatrixHermes(
      {
        watch,
        ...(line ? { line } : {}),
        petSurface,
        ...(sentHereEvents.has(target.eventId) ? { sentHere: target.eventId } : {}),
        ...(group
          ? {
              group,
              groupRevalidate: async () => {
                await requireRoom()
              },
              ...(lease?.leaseToken ? { groupLease: { leaseToken: lease.leaseToken } } : {}),
              groupClaimed: async invocationId => {
                await humanHost.queue.command({
                  kind: 'writeRoomUsage',
                  roomId: target.roomId,
                  ownerId: humanHost.identity.userId,
                  agentId: agentHost.identity.userId,
                  change: 'claimed',
                  dailyTurns: group.dailyTurns ?? 30,
                  invocationId
                })
              }
            }
          : {}),
        ...(watch?.automatic ? { automatic: { leaseToken: lease!.leaseToken! } } : {}),
        // Standard receipt and typing while its admitted turn runs, in a group too: the SDK
        // names only the message addressed to or admitted by this agent (agent-signals.ts).
        signals: {
          seen: (eventId: string, proof?: MatrixSeenProof) =>
            agentRuntime.signals?.seen(target.roomId, eventId, proof),
          work: () => agentRuntime.signals?.work(target.roomId)
        },
        context: () => {
          const human = account.identity()
          const enrollment = enrollmentOf(agentRuntime)

          if (
            !human ||
            enrollment.state !== 'ready' ||
            !enrollment.identity ||
            hosts.get(agentRuntime.role) !== agentHost ||
            hosts.get('human') !== humanHost
          ) {
            throw new Error('matrix_agent_unavailable')
          }

          return { human, agent: enrollment.identity }
        },
        read: matrixHermesReader(
          (command, timeoutMs) => humanHost.queue.command(command, timeoutMs),
          async (command, timeoutMs) => {
            if (command.kind === 'publishResult') {
              await statusLine?.end()
              // The working line is removed and a held interim remark dropped first (agent-turns/1.4);
              // the answer is a new message.
              await voice?.end(command.body)
              await requireRoom()
              abort.signal.throwIfAborted()
            }

            let next: MatrixSdkCommand = command

            // A latched assistant's answer carries the Google mark (G2-19).
            if (next.kind === 'publishResult' && googleAssistant.marks(agentRuntime.role)) {
              next = { ...next, google: true as const }
            }

            // In a group, what the agent posts is for everyone there (publish-result.ts), and
            // only while the group is still the one the turn began in (requireRoom).
            if (group && (next.kind === 'publishResult' || next.kind === 'publishNotice')) {
              const publicationRoom = await requireRoom()
              const depth = (group.chain?.depth ?? 0) + 1

              const joined = new Set(
                publicationRoom?.members.filter(member => member.membership === 'join').map(member => member.userId)
              )

              const recipients = allAgents()
                .filter(
                  agent =>
                    !agent.closed &&
                    agent.userId &&
                    agent.userId !== agentHost.identity.userId &&
                    joined.has(agent.userId)
                )
                .map(agent => ({ userId: agent.userId!, name: agent.name ?? '' }))

              // A split answer (matrix-answer-parts.ts) hands the meeting on once, with its last part.
              const finalPart = next.kind !== 'publishResult' || !next.part || next.part.index === next.part.count - 1

              const posted = {
                ...next,
                group: true as const,
                ...(next.kind === 'publishResult' && group.mode === 'meeting' && depth <= 3 && finalPart
                  ? {
                      chain: {
                        origin: group.chain?.origin ?? target.eventId,
                        parent: target.eventId,
                        depth,
                        recipients
                      }
                    }
                  : {})
              }

              if (next.kind === 'publishResult' && group.mode === 'shared') {
                const currentEnrollment = () => {
                  abort.signal.throwIfAborted()
                  const fresh = enrollmentOf(agentRuntime)

                  if (
                    !enrolled ||
                    fresh.state !== 'ready' ||
                    fresh.identity?.executorId !== enrolled.executorId ||
                    hosts.get(agentRuntime.role) !== agentHost ||
                    hosts.get('human') !== humanHost ||
                    account.identity()?.userId !== humanHost.identity.userId
                  ) {
                    throw new Error('matrix_agent_unavailable')
                  }

                  return fresh.identity
                }

                const identity = currentEnrollment()

                const copy =
                  matrixActionCopy[
                    matrixHeldReplyLocale(
                      locale,
                      state.displayPreferences?.language?.value,
                      app.getPreferredSystemLanguages()
                    )
                  ]

                return publishDisclosedGroupAnswer({
                  mode: group.mode,
                  audience: group.audience,
                  conversationKey: matrixConversationKey(identity, humanHost.identity, target.roomId, undefined, group),
                  roomConversationKey: matrixConversationKey(
                    identity,
                    humanHost.identity,
                    target.roomId,
                    undefined,
                    'shared'
                  ),
                  invocationId: next.invocationId,
                  store: agentRuntime.store,
                  requireRoom: async () => {
                    const fresh = await requireRoom()
                    currentEnrollment()

                    return fresh ? groupDisclosureEpoch(fresh.members, group.audience) : undefined
                  },
                  publishDisclosure: transactionId => {
                    abort.signal.throwIfAborted()

                    return agentHost.queue.command(
                      {
                        kind: 'publishGroupNotice',
                        roomId: target.roomId,
                        body: copy.groupJoined,
                        transactionId
                      },
                      timeoutMs
                    )
                  },
                  publishAnswer: () => {
                    abort.signal.throwIfAborted()

                    return agentHost.queue.command(posted, timeoutMs)
                  }
                })
              }

              return publishCurrentGroupTurn(abort.signal, requireRoom, () =>
                agentHost.queue.command(posted, timeoutMs)
              )
            }

            await admitPrivateConversationPublication(next, Boolean(group), requireRoom)

            return agentHost.queue.command(next, timeoutMs)
          }
        ),
        // The language of the one line the assistant says when it holds a reply it can't quote.
        ownerLocale: () =>
          matrixHeldReplyLocale(locale, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages()),
        // The owner's own device that isn't verified: refused as before, with one sanitized line,
        // and the window's reminder to verify it reads the device list again.
        log: line => console.warn(line),
        ownerDeviceDenied: deviceId => unverifiedDevices.denied(humanHost, deviceId),
        authorize: input => account.invocation(input),
        // A migrated agent's result goes through the platform's outbox, which records it on the ledger itself.
        ledgerPublishes: invocationId => outboxedResult(agentRuntime, invocationId),
        // A cloud-route agent always records the turn in the shared ledger, including a linked
        // document sent on this Mac. Failback can then see it; local records remain local agents'.
        // A migrated agent's turns are on the ledger too: that is where its published event is recorded.
        ...(enrolled && !isCloudAgent(agentRuntime) && !isMigratedAgent(agentRuntime)
          ? {
              local: {
                records: localInvocationRecords(agentRuntime.store, {
                  principal: enrolled.principal,
                  agentPrincipal: enrolled.agentPrincipal,
                  deviceId: enrolled.deviceId
                }),
                // New only if clearly after the session began: the chat server's clock
                // may differ slightly from this Mac's.
                lease: lease ? { notBefore: lease.since + 5_000, turnLimitMs: LOCAL_TURN_LIMIT_MS } : null
              }
            }
          : {}),
        // A linked document belongs to the owner's own chat with the agent, never a group.
        ...(group
          ? {}
          : { document: () => documents.forInvocation({ userId: humanHost.identity.userId, roomId: target.roomId }) }),
        confirm: async (text, attachmentName) => {
          // Renderer may choose a supported language, never the consent text.
          const copy = Object.hasOwn(matrixActionCopy, locale ?? '') ? matrixActionCopy[locale!] : matrixActionCopy.en

          // Several agents' turns can ask at once: one native dialog at a time.
          const result = await oneDialogAtATime(() =>
            dialog.showMessageBox(ui!, {
              type: 'question',
              title: copy.consentTitle,
              message: copy.consentTitle,
              detail: `${copy.consentHelp}${attachmentName ? `\n\n${copy.fileHelp}\n${attachmentName}` : ''}\n\n${text}`,
              buttons: [copy.consentCancel, copy.consentAllow],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
              signal: abort.signal
            })
          )

          return result.response === 1
        },
        prepare: async input => {
          try {
            if (agentRuntime.executor && !agentRuntime.executor.usable) {
              await stopHermesExecutor(agentRuntime)
            }

            input.signal.throwIfAborted()
            const selectedRuntime = runtime!
            agentRuntime.executor ??= new MatrixHermesExecutor(
              signal => openAssistantHermes(selectedRuntime, input, signal, agentRuntime),
              agentRuntime.store,
              observation => desktopServices?.turn(observation),
              matrixAgentSoulLifecycle(agentRuntime)
            )
            prepared = agentRuntime.executor
            const connection = await prepared.connect(input.signal)

            return (await matrixHermesReadiness(connection, input.signal)).state === 'ready'
          } catch {
            input.signal.throwIfAborted()

            return false
          }
        },
        // Before dispatch (invocation.ts): the private room re-read and the conversation made
        // ready, so a slow link refuses the turn only for now (the listener offers it again),
        // never once it counts as run. A group's room is re-read just after, before dispatch
        // (groupRevalidate). What it prepares goes to the one run below.
        conversation: async input => {
          if (!prepared) {
            throw new Error('matrix_setup_required')
          }

          if (!group) {
            await requireRoom()
          }

          input.signal.throwIfAborted()
          requireMatrixSessionChoice(
            state.rooms.find(room => room.id === target.roomId),
            enrolled?.agentPrincipal
          )

          return prepared.prepare({
            conversationKey: input.conversationKey,
            signal: input.signal,
            ...(group
              ? { sharedRoom: group.mode === 'shared', replyOnly: group.mode === 'meeting' && Boolean(group.chain) }
              : {
                  petSurface: input.petSurface === true,
                  continuity: conversationContinuity(
                    { roomId: target.roomId, before: target.eventId },
                    humanHost,
                    agentHost,
                    input.signal
                  )
                })
          })
        },
        // The person's first words in a new account's primary chat answer a welcome the model never
        // saw. A message another device sent (the phone) reaches this Mac here, not through the
        // window's own turn, so this side adds the note too (first-run-naming.ts).
        firstRunNote: input => firstRunNamingNote(agentRuntime, humanHost, agentHost, input),
        execute: async input => {
          // Everything from here to the prompt is Hermes-free: a failure in it ran nothing, and the
          // run's tracker says so (turn-effects.ts). The executor takes it over from `run`.
          input.effects?.attach()

          if (!prepared) {
            throw new Error('matrix_setup_required')
          }

          // The room was re-read before dispatch (`conversation`); the answer's publication
          // re-reads it again. Nothing between dispatch and Hermes can refuse for the room.
          input.signal.throwIfAborted()

          if (agentRuntime.invocation?.abort === abort) {
            agentRuntime.invocation.invocationId = input.invocationId
          }

          // The typing handle stays here (it pauses through `ask`); the run never sees it.
          const { work, conversation, ...run } = input

          const progressLocale = matrixHeldReplyLocale(
            locale,
            state.displayPreferences?.language?.value,
            app.getPreferredSystemLanguages()
          )

          const statusCopy = matrixStatusLineCopy[progressLocale]

          if (work && lease && enrolled) {
            const current = () => {
              const fresh = enrollmentOf(agentRuntime)

              return (
                !input.signal.aborted &&
                !closing &&
                state.state === 'ready' &&
                account.identity()?.userId === humanHost.identity.userId &&
                hosts.get('human') === humanHost &&
                hosts.get(agentRuntime.role) === agentHost &&
                fresh.state === 'ready' &&
                fresh.identity?.executorId === enrolled.executorId &&
                !lease.signal.aborted &&
                agentRuntime.lease?.held(enrolled.executorId)?.leaseToken === lease.leaseToken
              )
            }

            statusLine = new MatrixStatusLine(target, {
              current,
              publish: async command => {
                if (!current()) {
                  throw new Error('matrix_agent_unavailable')
                }

                await requireRoom()

                if (!current()) {
                  throw new Error('matrix_agent_unavailable')
                }

                return agentHost.queue.command({ kind: 'publishNotice', ...command }) as Promise<string>
              }
            })

            // The turn's one transient working line (agent-turns/1.4): tool activity, the todo list and
            // waits, edited in place in the agent's private chat and removed when the turn ends. A group
            // gets receipt and typing only.
            const progressCopy = matrixProgressCopy[progressLocale]

            const publishVia = async (command: MatrixNoticeEdit) => {
              if (!current()) {
                throw new Error('matrix_agent_unavailable')
              }

              await requireRoom()

              if (!current()) {
                throw new Error('matrix_agent_unavailable')
              }

              return agentHost.queue.command({ kind: 'publishNotice', ...command }) as Promise<string>
            }

            const timers = {
              now: () => Date.now(),
              after: (milliseconds: number, run: () => void) => {
                const timer = setTimeout(run, milliseconds)
                timer.unref?.()

                return () => clearTimeout(timer)
              },
              log: (line: string) => console.warn(line)
            }

            voice = new MatrixTurnVoice(
              new MatrixProgressLine(target, { current, publish: publishVia, ...timers }, {
                privateChat: !group,
                heartbeatText: progressCopy.heartbeat,
                transactionFor: generation =>
                  matrixProgressNoticeTransaction(
                    agentHost.identity.userId, input.invocationId, target.roomId, target.eventId, generation
                  )
              }),
              // The agent's own remarks are real messages (agent-turns/1.4); Atum adds no opener of its own.
              new MatrixInterimMessages(target, { current, publish: publishVia, ...timers }, {
                privateChat: !group,
                transactionFor: sequence =>
                  matrixInterimTransaction(
                    agentHost.identity.userId, input.invocationId, target.roomId, target.eventId, sequence
                  )
              }),
              progressLocale
            )
          }

          const running = prepared.run({
            ...run,
            ...(conversation ? { prepared: conversation } : {}),
            effort: roomEffort(target.roomId, agentRuntime),
            sessionModel: sessionModelOf(agentRuntime),
            // A group's bounded meeting context is in the user prompt. It binds no scheduled
            // job to the group (no chat_id), and its session is restricted in a shared room.
            ...(group
              ? { sharedRoom: group.mode === 'shared', replyOnly: group.mode === 'meeting' && Boolean(group.chain) }
              : {
                  roomId: target.roomId,
                  continuity: conversationContinuity(
                    { roomId: target.roomId, before: target.eventId },
                    humanHost,
                    agentHost,
                    input.signal
                  )
                }),
            // Its typing pauses while the run waits on its owner (an approval, a question).
            // In the private chat the wait is part of the working line; a group keeps its status line.
            ask: matrixStatusAsk(
              matrixWorkingAsk(prompts.ask, work),
              group ? statusLine : undefined,
              statusCopy,
              line => console.warn(line),
              group ? undefined : voice?.line
            ),
            onProgress: event => voice?.event(event),
            // The private chat hears this turn narrated, so the agent is asked to (the cloud's own line);
            // a group's voice is inert (receipt and typing only) and its prompt stays as it was.
            ...(voice && !group ? { turnStyle: true } : {}),
            onActivity: activity => {
              if (
                agentRuntime.invocation?.abort !== abort ||
                abort.signal.aborted ||
                closing ||
                hosts.get('human') !== humanHost ||
                hosts.get(agentRuntime.role) !== agentHost
              ) {
                return
              }

              agentRuntime.invocation.activity = { ...activity, roomId: target.roomId, eventId: target.eventId }
              publish(state)
            },
            onPromptNotice: reason => {
              if (
                agentRuntime.invocation?.abort !== abort ||
                closing ||
                hosts.get('human') !== humanHost ||
                hosts.get(agentRuntime.role) !== agentHost
              ) {
                return
              }

              agentRuntime.promptNotice = { id: randomUUID(), roomId: target.roomId, reason }
              publish(state)
            }
          })

          return running.catch(error => {
            // The owner's Stop is final: this turn is never queued again and never reported as
            // unconfirmed (turn-effects.ts, matrixTurnSettlement).
            throw agentRuntime.invocation?.abort === abort && agentRuntime.invocation.stopRequested
              ? new Error(MATRIX_TURN_STOPPED, { cause: error })
              : error
          })
        },
        // The person's Stop, read again while a failed run is settled (invocation.ts).
        stopped: () => agentRuntime.invocation?.abort === abort && agentRuntime.invocation.stopRequested === true,
        store: agentRuntime.store
      },
      target,
      // A lease-bounded turn stops as soon as the lease is lost, before it could lapse.
      lease ? AbortSignal.any([abort.signal, lease.signal]) : abort.signal
    )
  })()

  agentRuntime.invocation = {
    abort,
    pending,
    prompts,
    roomId: target.roomId,
    leaseSignal: lease?.signal,
    model: roomModel(target.roomId, agentRuntime),
    effort: roomEffort(target.roomId, agentRuntime),
    ...(group ? { group: true as const, groupMode: group.mode } : {})
  }
  publish(state)

  try {
    return await pending
  } catch {
    throw new Error('matrix_invocation_unavailable')
  } finally {
    await statusLine?.end()
    await voice?.end()
    listenerSignal?.removeEventListener('abort', cancel)

    if (agentRuntime.invocation?.abort === abort) {
      agentRuntime.invocation = undefined
    }

    scheduleExecutionPolicyReconcile()
    scheduleContinuousListening()
    publish(state)
    void wallet?.refresh('turn')

    if (!agentRuntime.executor?.usable) {
      setTimeout(() => void startAssistantHermes(agentRuntime), 1_000)
    }
  }
}

async function stopHermesExecutor(agentRuntime: MatrixAgentRuntime = defaultAgent) {
  macJobs.get(agentRuntime)?.lifecycle.stop()
  const current = agentRuntime.executor
  await current?.close()

  if (agentRuntime.executor === current) {
    agentRuntime.executor = undefined
  }

  // The stopped launch's Google key dies with it; the next launch gets its own.
  if (isMatrixGoogleAgentRole(agentRuntime.role) && !agentRuntime.executor) {
    googleTools?.revoke(agentRuntime.role)
    googleLaunched.delete(agentRuntime.role)
  }
}

async function stopHost(role: MatrixHostRole) {
  sdkRendererRecovery.cancel(role)
  const agentRuntime = agentOfRole(role)

  if (role === 'human') {
    notifications.clear()
    hermesPages?.clearAll()
    await nativeApps?.clear()
  } else if (agentRuntime?.agentPrincipal) {
    hermesPages?.clearAgent(agentRuntime.agentPrincipal)
  }

  if (role === 'human') {
    for (const each of allAgents()) {
      stopListening('unavailable', each)
    }
  } else if (agentRuntime) {
    stopListening('unavailable', agentRuntime)
  }

  if (role === 'human') {
    humanPrepared = false
    resetDeviceControlReadyChecks()
    documents?.reset()
    // Revoke views synchronously; storage cleanup gates future PDF placement,
    // never authentication or quit if Chromium's cache cleanup stalls.
    void clearPdfSession()
  }

  let runtimeStopped: Promise<void> | undefined

  for (const turn of turnsUsing(role)) {
    turn.abort.abort()
  }

  if (agentRuntime) {
    runtimeStopped = stopHermesExecutor(agentRuntime)
  }

  // The agent's backend and the host's turns have ended before the host is gone.
  const settled = async () => {
    await runtimeStopped
    await Promise.all(turnsUsing(role).map(turn => turn.pending.catch(() => {})))
  }

  const target = hosts.get(role)

  if (!target) {
    await settled()

    return
  }

  clearTimeout(target.expiry)
  target.renewal?.stop()
  await target.queue.stop()
  await settled()

  if (hosts.get(role) === target) {
    hosts.delete(role)
  }
}

const sdkRendererRecovery = new MatrixSdkRendererRecovery<MatrixHostRole>({
  eligible: role => !closing && !hosts.has(role) && !(role === 'human' && ownerRepairPreservesWork()),
  start: async role => {
    await startHost(role, { preserveRuntime: true })

    return hosts.has(role)
  },
  recovered: () => {
    recheckAgents()
    scheduleContinuousListening()
    publish(state)
  },
  exhausted: role => {
    void (async () => {
      console.warn(`[Matrix] ${role === 'human' ? 'chat' : 'agent'} engine restart exhausted`)
      await stopHost(role)
      const affected = role === 'human' ? allAgents() : [agentOfRole(role)].filter((agent): agent is MatrixAgentRuntime => Boolean(agent))

      await Promise.all(
        affected.map(async agent => {
          await agent.lease?.stop()
          await stopHermesExecutor(agent)
        })
      )

      if (role === 'human') {
        publish({ ...state, state: 'error', error: 'matrix_sdk_stopped' })
      } else {
        publish(state)
      }
    })().catch(() => console.warn('[Matrix] SDK renderer terminal cleanup did not finish'))
  },
  retrying: (role, attempt) =>
    console.warn(`[Matrix] ${role === 'human' ? 'chat' : 'agent'} engine restart attempt=${attempt}`)
})

async function stopSdk() {
  petOverlays?.clear()
  ownerReaderTrustPoller.stop()
  signedOwnerReaders.clear()
  brainActive = false
  brainOwner = null
  const brainStop = localBrain?.stop()
  profiles.stop()
  assistantNames.stop()
  hermesPages?.clearAll()
  appLoadHost = undefined
  // Start every app stop before slower pane/SDK teardown can fail.
  const appStops = stopAppHosts()

  const sdkStop = stopSdkWithApps(
    async () => {
      await matrixApps?.reset()
    },
    () => stopHost('human'),
    async () => {
      await Promise.all([stopHost('agent'), ...Array.from(agents.values(), each => stopHost(each.role)), appStops])
    },
    () => console.warn('[matrix-apps] local_cleanup_failed')
  )

  // Start both withdrawals before awaiting either, so a local process failure
  // cannot skip SDK/participant cleanup.
  const stopped = await Promise.allSettled([brainStop, sdkStop])
  const failed = stopped.find(result => result.status === 'rejected')

  if (failed?.status === 'rejected') {
    throw failed.reason
  }
}

async function stopAppHosts(slug?: string) {
  await Promise.all(
    [...hosts.keys()]
      .filter(role => matrixHostApp(role) !== undefined && (slug === undefined || matrixHostApp(role) === slug))
      .map(role => stopHost(role))
  )
}

function partitionFor(identity: MatrixIdentity) {
  return `persist:matrix-sdk-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

async function clearDevice(identity: MatrixIdentity) {
  const store = session.fromPartition(partitionFor(identity))
  await store.clearStorageData()
  await store.clearCache()
}

function requireHost(event: Parameters<typeof requireMatrixCaller>[0]): [MatrixHostRole, Host] {
  for (const entry of hosts) {
    if (event.sender === entry[1].window.webContents) {
      requireMatrixCaller(event, entry[1].window.webContents, SDK_URL)

      return entry
    }
  }

  throw new Error('matrix_ipc_denied')
}

async function lockWindow(window: BrowserWindow, url: string, host: 'ui' | 'sdk') {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())

  if (host === 'sdk') {
    window.webContents.on('will-attach-webview', event => event.preventDefault())
  }

  // UI guests are validated by the existing consumer-browser controller. The
  // hidden SDK window never gains a guest capability.
  const mediaAllowed = (
    contents: Electron.WebContents | null,
    permission: string,
    details: { isMainFrame?: boolean; requestingUrl?: string; mediaTypes?: unknown; mediaType?: unknown }
  ) =>
    matrixVoiceFramePermission({
      trustedContents: host === 'ui' && contents === ui?.webContents && contents === window.webContents,
      currentConsent:
        Boolean(microphoneConsent?.()) &&
        (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted'),
      permission,
      uiUrl: UI_URL,
      details
    })

  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(mediaAllowed(contents, permission, details))
  )
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    mediaAllowed(contents, permission, details)
  )

  if (!(await window.webContents.session.protocol.isProtocolHandled('atum-matrix'))) {
    window.webContents.session.protocol.handle('atum-matrix', async request => {
      const parsed = new URL(request.url)

      if (parsed.host !== host || !['GET', 'HEAD'].includes(request.method)) {
        return new Response(null, { status: 403 })
      }

      const relative = decodeURIComponent(parsed.pathname).slice(1)
      const target = path.resolve(assets, relative)

      if (!target.startsWith(`${assets}${path.sep}`) || !/\.(html|js|css|woff2?|ttf|wasm|png|svg)$/.test(target)) {
        return new Response(null, { status: 404 })
      }

      const response = await net.fetch(pathToFileURL(target).href)
      const headers = new Headers(response.headers)
      headers.set(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: atum-look:; font-src 'self' data:; media-src ${host === 'ui' ? 'data: blob:' : "'none'"}; connect-src ${host === 'sdk' ? `'self' ${new URL(config.server).origin}` : "'none'"}; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-src 'none'`
      )

      if (target.endsWith('.wasm')) {
        headers.set('Content-Type', 'application/wasm')
      }

      return new Response(response.body, { status: response.status, headers })
    })
  }

  if (host === 'ui' && !(await window.webContents.session.protocol.isProtocolHandled('atum-look'))) {
    window.webContents.session.protocol.handle('atum-look', async request => {
      const parsed = new URL(request.url)

      if (
        !lookAssets ||
        !['GET', 'HEAD'].includes(request.method) ||
        !/^[a-f0-9]{64}$/u.test(parsed.host) ||
        (parsed.pathname !== '' && parsed.pathname !== '/') ||
        parsed.search ||
        parsed.hash
      ) {
        return new Response(null, { status: 404 })
      }

      const asset = await lookAssets.read(parsed.host)

      if (!asset) {
        return new Response(null, { status: 404 })
      }

      const headers = new Headers({
        'Content-Type': asset.mime,
        'Content-Length': String(asset.bytes.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      })

      if (asset.mime === 'image/svg+xml') {
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      }

      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.bytes), { status: 200, headers })
    })
  }

  window.webContents.on('did-navigate', (_event, target) => {
    if (target !== url) {
      window.destroy()
    }
  })
}

async function startHost(role: MatrixHostRole, options: { preserveRuntime?: boolean } = {}) {
  if (closing || hosts.has(role)) {
    return
  }

  const deviceIsolation = isolationPolicy?.forHost()

  if (!deviceIsolation) {
    throw new Error('matrix_device_isolation_unavailable')
  }

  const slug = matrixHostApp(role)
  const agentRuntime = agentOfRole(role)

  // Another agent's host starts only through its live runtime (agentRuntimeFor).
  if (matrixHostAgent(role) !== undefined && (!agentRuntime || agentRuntime.closed)) {
    return
  }

  const enrollment =
    role === 'human'
      ? null
      : agentRuntime
        ? enrollmentOf(agentRuntime)
        : slug === undefined
          ? null
          : account.appEnrollment(slug)

  if (agentRuntime && enrollment?.identity) {
    agentRuntime.identity = { userId: enrollment.identity.userId, deviceId: enrollment.identity.deviceId }
    agentRuntime.agentPrincipal = enrollment.identity.agentPrincipal
    publish(state)
  }

  const source = role === 'human' ? account.identity() : enrollment?.state === 'ready' ? enrollment.identity : null

  if (!source) {
    return
  }

  if (agentRuntime && runtime && enrollment?.state === 'ready' && enrollment.identity) {
    const home = reconcileAgentHome(
      agentRuntime,
      agentRuntime.principal ?? enrollment.identity.agentPrincipal,
      enrollment.identity,
      runtime
    )

    // A replaced root executor keeps its home: memory and tools follow it (agent-reenroll.ts).
    if (agentRuntime.principal === undefined && agentRuntime.carryHome) {
      carryMatrixHermesHome(agentRuntime.carryHome, home, line => console.warn(line))
      agentRuntime.carryHome = undefined
    }

    account.retainHermesProfile(home, agentRuntime.principal)
  }

  const identity = { userId: source.userId, deviceId: source.deviceId }

  const target = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(assets, 'matrix-sdk-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: partitionFor(identity),
      webSecurity: true
    }
  })

  const sdkQueue = new MatrixSdkHost(
    (id, value) => target.webContents.send(channel.sdkCommand, id, value),
    () => {
      if (!target.isDestroyed()) {
        target.destroy()
      }
    }
  )

  const host: Host = {
    deviceIsolation,
    window: target,
    identity,
    // An agent's host says nothing in a room while this Mac is not the home of an agent the placement
    // model manages (the stand-down fence; an agent it does not manage is untouched). The platform's
    // server-side outbox worker replaces this check when it exists .
    queue: agentRuntime && agentHome ? agentHome.guard(sdkQueue, () => cloudPrincipal(agentRuntime)) : sdkQueue
  }

  hosts.set(role, host)

  if (enrollment?.identity) {
    const enrolledOwner = state.identity
    const executorId = enrollment.identity.executorId

    host.expire = () => {
      // Expiry closes local custody immediately, independently of the server's
      // introspection cache. Never let a renderer extend its own lifetime: only main
      // renews (credential-renewal.ts), and a credential no renewal reached ends here.
      host.renewal?.stop()

      for (const turn of turnsUsing(role)) {
        turn.abort.abort()
      }

      const stopped = agentRuntime ? stopHermesExecutor(agentRuntime) : Promise.resolve()

      if (agentRuntime) {
        stopListening('expired', agentRuntime)
      }

      host.queue.close()

      if (hosts.get(role) === host) {
        hosts.delete(role)
      }

      publish(state)
      // Expiry is not a permanent dead end: only the readiness gate can
      // re-enroll. Its existing retry/backoff owns recovery, never a new timer.
      void restartMatrixReadinessAfterExpiry(
        stopped,
        () =>
          Boolean(
            agentRuntime &&
            !closing &&
            !agentRuntime.closed &&
            state.identity &&
            JSON.stringify(state.identity) === JSON.stringify(enrolledOwner) &&
            enrollmentOf(agentRuntime).identity?.executorId === executorId &&
            // Still expired, or renewed too late for this host: the gate starts it again.
            ['expired', 'ready'].includes(enrollmentOf(agentRuntime).state)
          ),
        () => agentRuntime?.readiness?.start()
      ).catch(() => console.warn('[Matrix] expired executor cleanup failed; re-enrollment paused'))
    }

    armHostExpiry(host, enrollment.identity.expiresAt)

    // Each agent's host takes main's renewed token with its own handle (never an app's), and
    // its credential is renewed ahead of expiry from now on: before its page loads, so a token
    // refused at its first request can already wait for a renewal (expedite). Expiry stays
    // the backstop.
    if (agentRuntime && matrixAgentRenews(role)) {
      host.refreshHandle = randomUUID()
      host.renewal = createCredentialRenewal(role, host, agentRuntime)
      host.renewal.start()
    }
  }

  await lockWindow(target, SDK_URL, 'sdk')

  if (closing || hosts.get(role) !== host || target.isDestroyed()) {
    host.renewal?.stop()
    host.queue.close()

    return
  }

  target.webContents.on('render-process-gone', (_event, details) => {
    if (hosts.get(role) === host) {
      const restartable = matrixSdkRendererRestartable(role, Boolean(agentRuntime))

      if (role === 'human') {
        console.warn(
          `[Matrix] chat engine exited reason=${/^[a-z-]{1,32}$/.test(details.reason) ? details.reason : 'unexpected'}`
        )

        for (const each of allAgents()) {
          each.listener.drainAndStop('unavailable')
        }
      } else if (agentRuntime) {
        agentRuntime.listener.drainAndStop('unavailable')
      }

      clearTimeout(host.expiry)
      host.renewal?.stop()
      hosts.delete(role)
      host.queue.close()

      // SDK renderers carry Matrix I/O, not the main-owned Hermes process or its answering term.
      // Preserve admitted work while a core host is recreated; app-host work still ends with its
      // renderer because that renderer owns the app execution itself.
      if (!restartable) {
        for (const turn of turnsUsing(role)) {
          turn.abort.abort()
        }
      }

      if (role === 'human') {
        publish({ ...state, state: 'connecting', error: null })
      } else {
        publish(state)
      }

      if (restartable && !closing) {
        sdkRendererRecovery.restart(role)
      }
    }
  })

  if (role === 'human') {
    // The previous human's cosmetics must not cross the host transition. This
    // SDK's own cached account data supplies its choices when it publishes.
    publish({ ...state, state: 'connecting', identity, displayPreferences: undefined, error: null })
  }

  try {
    await target.loadURL(SDK_URL)
  } catch (error) {
    if (hosts.get(role) === host) {
      if (options.preserveRuntime) {
        hosts.delete(role)
        clearTimeout(host.expiry)
        host.renewal?.stop()
        host.queue.close()
      } else {
        await stopHost(role)
      }
    }

    throw error
  }
}

/** Arms a host's end at its credential's expiry, from the wall clock: when it starts, when a
 * renewal moves the expiry, and after sleep, since Node's timers do not count time asleep on
 * macOS. */
function armHostExpiry(host: Host, expiresAt: number) {
  clearTimeout(host.expiry)
  host.expiry = undefined

  if (host.expire) {
    host.expiresAt = expiresAt
    host.expiry = setTimeout(host.expire, Math.max(0, expiresAt - Date.now()))
  }
}

/** The Mac woke: every host's expiry and renewal is set again from the wall clock. An expiry
 * that passed while asleep ends its host now; a renewal that fell due runs now. */
function resumeHosts() {
  for (const host of hosts.values()) {
    if (host.expiresAt !== undefined) {
      armHostExpiry(host, host.expiresAt)
    }

    host.renewal?.resume()
  }
}

const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex')

/** An agent host's renewal schedule (credential-renewal.ts). */
function createCredentialRenewal(role: MatrixHostRole, host: Host, agentRuntime: MatrixAgentRuntime) {
  return new MatrixCredentialRenewal({
    label: agentRuntime.principal === undefined ? 'assistant' : `agent ${agentRuntime.principal.slice(0, 8)}`,
    expiresAt: () => {
      try {
        const enrolled = enrollmentOf(agentRuntime)

        return hosts.get(role) === host && enrolled.state === 'ready' ? enrolled.identity?.expiresAt : undefined
      } catch {
        return undefined
      }
    },
    // Not while a turn or a setup step runs: the platform refuses the executor's calls for
    // the second it takes to rotate.
    busy: () =>
      Boolean(agentRuntime.invocation) || Boolean(agentRuntime === defaultAgent ? assistantSetup : agentRuntime.setup),
    renew: () => {
      const renewing = renewAgentHost(role, host, agentRuntime)
      host.renewing = renewing

      return renewing.finally(() => {
        if (host.renewing === renewing) {
          host.renewing = undefined
        }

        if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
          // Renewal denied this executor, not its retained device/profile. End
          // answering authority and publish now, without tearing down SDK custody.
          reconcileLease(agentRuntime)
          agentRuntime.localTurns?.kick()
          agentRuntime.readiness?.recheck()
          publish(state)
        }
      })
    },
    log: line => console.warn(line)
  })
}

/** One renewal of an agent host's executor credential (credential-renewal.ts). */
function renewAgentHost(role: MatrixHostRole, host: Host, agentRuntime: MatrixAgentRuntime): Promise<void> {
  return renewMatrixAgentHost({
    current: () => hosts.get(role) === host && !closing && !agentRuntime.closed,
    identity: host.identity,
    rotate: () => account.renewAgentExecutor(agentRuntime.principal),
    expireAt: expiresAt => armHostExpiry(host, expiresAt),
    notify: () => void host.queue.command({ kind: 'renewed' }).catch(() => {}),
    extend: expiresAt => {
      const watch = agentRuntime.listener.extend(current =>
        matrixRenewedWatchEnd(
          current,
          expiresAt,
          agentRuntime.continuous?.enabled ? agentRuntime.continuous.roomId : undefined,
          TEMPORARY_WATCH_MS
        )
      )

      // The SDK keeps the same watch, with its later end, and what it has seen.
      if (watch) {
        void host.queue.command({ kind: 'watchInvocations', watch }).catch(() => {})
      }
    },
    changed: () => publish(state)
  })
}

/** Another agent's runtime, made once: its own vault scope, room watch, scheduled posts,
 * lease, local turns and gate. Its host and backend start from its gate (setUpAgent). */
function agentRuntimeFor(principal: string): MatrixAgentRuntime {
  let agentRuntime = agents.get(principal)

  // A runtime stopped for good is never reused: a later roster or creation gets a fresh one.
  if (agentRuntime?.closed) {
    agents.delete(principal)
    agentRuntime = undefined
  }

  if (!agentRuntime) {
    agentRuntime = new MatrixAgentRuntime(`agent:${principal}`, principal)
    agentRuntime.store = outcomeStore.scope(matrixAgentScope(principal))
    agentRuntime.listener = createListener(agentRuntime)
    agentRuntime.continuous = createContinuousListening(agentRuntime)
    agentRuntime.cron = createCronDelivery(agentRuntime)
    agentRuntime.lease = createLease(agentRuntime)
    agentRuntime.signals = createAgentSignals(agentRuntime)
    agentRuntime.localTurns = createLocalTurns(agentRuntime)

    try {
      agentRuntime.localTurns.recover()
    } catch {
      console.warn(`[Matrix] agent ${principal.slice(0, 8)} local turns could not be recovered: vault unavailable`)
    }

    if (config.domain) {
      agentRuntime.readiness = createReadiness(agentRuntime)
    }

    agents.set(principal, agentRuntime)
  }

  return agentRuntime
}

/** Stops another agent's runtime on this Mac for good: its gate, lease, watch, turns,
 * backend and host, and a setup in flight (which then starts nothing again). Its
 * enrollment, vault scope and Hermes home are left for retire (or sign-out). */
async function stopAgentRuntime(agentRuntime: MatrixAgentRuntime) {
  if (agentRuntime.principal) {
    hermesPages?.clearAgent(agentRuntime.principal)
  }

  agentRuntime.closed = true
  agentRuntime.invocation?.abort.abort()
  storeRuns.end(agentRuntime.role)
  storeSchedules.forget(agentRuntime.role)
  forgetContinuousListening(agentRuntime)
  leaseHandover.forget(agentRuntime)
  agentRuntime.readiness?.stop()
  const released = agentRuntime.lease?.stop()
  stopListening('cancelled', agentRuntime)
  agentRuntime.listener.clear()
  agentRuntime.localTurns?.stop()
  agentRuntime.signals?.stop()
  // Stopping the host also aborts a model check in flight (its turn slot).
  await stopHost(agentRuntime.role)
  await Promise.race([agentRuntime.setup, new Promise(resolve => setTimeout(resolve, 30_000).unref())])
  await stopHost(agentRuntime.role)
  await released
}

function unusedRoot(): boolean {
  return Boolean(
    account.appScope() &&
    productDefaultPrincipal &&
    matrixRootEnrollmentPrincipal(
      account.retainedAgentPrincipal(),
      productDefaultPrincipal,
      new Set([...agents.keys(), ...account.agentEnrollments()])
    ) === undefined
  )
}

/** Try again, power resume or a network change: every agent's gate checks now. */
function recheckAgents(refreshRoster = false) {
  if (refreshRoster) {
    agentRoster.request()
  }

  for (const each of allAgents()) {
    if (each === defaultAgent && unusedRoot()) {
      each.readiness?.stop()

      continue
    }

    each.readiness?.recheck()
  }
}

/** Sign-out: every other agent's runtime is stopped and forgotten; the roster brings them
 * back after the next sign-in. */
/** The owners whose ChatGPT sign-in a sign-out forgets: every agent's on this Mac. */
function signingOutCodexOwners(): string[] {
  return [
    ...new Set(
      allAgents().flatMap(each => {
        const principal = enrollmentOf(each).identity?.principal

        return principal ? [principal] : []
      })
    )
  ]
}

function forgetCodexOwners(owners: readonly string[]) {
  if (!runtime) {
    return
  }

  for (const owner of owners) {
    try {
      forgetMatrixAccountCodex(runtime, owner)
    } catch {
      console.warn('[Matrix] matrix_codex_cleanup_pending')
    }
  }
}

/** Sign-out: the account's OpenCode Go key goes with it. Its key is the account key, so a
 * later sign-in to another account can never read it. */
function forgetSubscriptionKey(accountKey: string | undefined) {
  if (!accountKey || !credentialStore) {
    return
  }

  try {
    matrixSubscriptionKeyStore(credentialStore, accountKey).clear()
  } catch {
    console.warn('[Matrix] matrix_subscription_cleanup_pending')
  }
}

async function forgetAgents() {
  productDefaultPrincipal = undefined
  agentCreation = false
  agentRosterReadiness = undefined
  agentContent.clear()
  const others = Array.from(agents.values())
  await Promise.all(others.map(each => stopAgentRuntime(each)))

  for (const each of others) {
    if (agents.get(each.principal!) === each) {
      agents.delete(each.principal!)
    }
  }
}

/**
 * The person's other agents on this Mac (per-agent runtime plan §2.3): each active agent on
 * the roster that answers in Matrix gets its runtime and gate (matrixRosterChanges). Runs
 * once the default agent is set up (the domain grant exists). An agent this Mac knew that is
 * no longer on the roster was retired, so this Mac's part of retiring it runs here.
 */
let agentsSync: Promise<MatrixReadinessCheck> | undefined
/** The last roster came from a platform that can make more agents. */
let agentCreation = false
const agentRoster = new MatrixRosterRecovery<Awaited<ReturnType<MatrixAccount['agents']>>>()
/** The last authoritative roster and the account it was read for: what the Store checks a
 * reusable hire target against (store.ts matrixScopedHireTargetLive). */
let hireRoster: { scope: MatrixRosterScope; roster: Awaited<ReturnType<MatrixAccount['agents']>> } | undefined

/** Unknown (undefined) until a roster is read for the signed-in account and generation. */
function hireTargetLive(assistantId: string): boolean | undefined {
  return matrixScopedHireTargetLive(hireRoster, account.appScope(), assistantId)
}

function syncAgents(): Promise<MatrixReadinessCheck> {
  if (!config.domain || closing) {
    return Promise.resolve(readinessPass)
  }

  agentsSync ??= (async () => {
    if (account.appScope() && agentRosterReadiness?.state !== 'ready') {
      setAgentRosterReadiness('loading')
      publish(state)
    }

    try {
      const result = await agentRoster.sync({
        scope: () => account.appScope(),
        fetch: signal => account.agents(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
      })

      if (result.state === 'idle' || result.state === 'cancelled') {
        return readinessPass
      }

      if (result.state === 'failed') {
        throw new Error('matrix_agent_roster_unavailable')
      }

      // The roster is authoritative only for the account/domain-grant generation that
      // fetched it. Check before touching even display-only default-agent metadata.
      if (closing) {
        return readinessPass
      }

      if (!agentRoster.isCurrent(result, account.appScope())) {
        agentRoster.request()

        return readinessPass
      }

      const { roster } = result
      // The switches are owner-wide. Reconcile every active assistant from the same authoritative
      // roster without delaying roster setup or renderer readiness.
      sourceGateSync?.reconcile()
      await executionPolicies?.retain(roster.filter(agent => agent.status === 'active').map(agent => agent.principal))

      // Policy reads are bounded but asynchronous. Re-check the roster/account generation before
      // either source can mutate runtime custody for a person who has since signed out or switched.
      if (closing || !agentRoster.isCurrent(result, account.appScope())) {
        agentRoster.request()

        return readinessPass
      }

      // Its tombstones also retire the Store's reusable hire targets for those agents.
      hireRoster = { scope: result.scope, roster }
      store?.pruneHireTargets()
      // Its tombstones name the retired agents whose chats leave the chat list.
      retiredAgentRooms.roster(account.identity()?.userId, roster)
      // S1 compatibility still names cloud routing; H-F policy decides whether this Mac also
      // keeps a policy-backed local writer ready for takeover.
      applyAnswering(roster)
      const own = account.retainedAgentPrincipal()
      const primary = matrixDefaultAgent(roster)
      const mine = roster.find(agent => agent.principal === own)

      productDefaultPrincipal = primary.principal

      // Task rooms keep an owner-signed current-Main pointer. Reconcile it from the same
      // authoritative roster that selected productDefaultPrincipal; an agent cannot promote
      // itself by writing Matrix state, and a demoted Main loses non-participant membership.
      const ownerHost = hosts.get('human')
      const ownerIdentity = account.identity()

      if (ownerHost?.ready && ownerIdentity && primary.matrixUser && ownerHost.identity.userId === ownerIdentity.userId) {
        try {
          // Keep successive roster generations ordered. A detached command could let an older
          // Main reconciliation land after a newer one and restore the demoted coordinator.
          await ownerHost.queue.command({
            kind: 'reconcileAgentTaskCoordinators',
            ownerId: ownerIdentity.userId,
            currentMainPrincipal: primary.principal,
            currentMainUser: primary.matrixUser,
            ownedAgents: roster.flatMap(agent => agent.status === 'active' && agent.matrixUser
              ? [{ principal: agent.principal, userId: agent.matrixUser }] : [])
          }, 30_000)
        } catch (error) {
          // Task coordination is an edge capability. A Matrix outage must not make the roster,
          // ordinary chat, or profile management unavailable; the next roster refresh retries.
          console.warn('[Matrix] agent task coordinators not reconciled:', setupFailureDetail(error))
        }
      }

      if (mine) {
        defaultAgent.assistantId = mine.id
        defaultAgent.name = mine.displayName
        defaultAgent.title = mine.title
        defaultAgent.mark = mine.mark
        defaultAgent.hire = mine.hire
        agentAvatars.project(defaultAgent, mine.id, mine.avatarUrl)

        // The authenticated roster can name a withdrawn default agent for display,
        // without restoring its executor credential or fabricating an SDK device.
        if (
          account.enrollment().state === 'withdrawn' &&
          !defaultAgent.identity &&
          mine.status === 'active' &&
          mine.matrixUser
        ) {
          defaultAgent.agentPrincipal = mine.principal
          defaultAgent.matrixUser = mine.matrixUser
        }
      }

      // Only a platform with several agents per person (0146) names the agents' Matrix users.
      agentCreation = Boolean(primary.matrixUser)

      const retiring = lifecycle.retiring()

      const retiredRoot = matrixRetiredRootCustody({
        roster,
        rootPrincipal: own,
        productDefaultPrincipal: primary.principal
      })

      const { active: others, retired } = matrixRosterChanges({
        roster,
        defaultPrincipal: own,
        known: [...agents.keys(), ...account.agentEnrollments()],
        keep: new Set([...lifecycle.creating(), ...retiring])
      })

      // Content status belongs only to the current authoritative roster, even if a
      // retired agent's other local cleanup has to wait for a later watch tick.
      agentContent.retain([
        ...(own && !retiredRoot ? [own] : []),
        ...others.map(record => record.principal),
        ...lifecycle.creating()
      ])

      for (const record of others) {
        if (closing) {
          return readinessPass
        }

        if (!agentRoster.isCurrent(result, account.appScope())) {
          agentRoster.request()

          return readinessPass
        }

        // An agent being retired here stays stopped until the retirement finishes.
        if (retiring.has(record.principal)) {
          continue
        }

        const known = agents.has(record.principal) && !agents.get(record.principal)!.closed
        const agentRuntime = agentRuntimeFor(record.principal)
        agentRuntime.assistantId = record.id
        agentRuntime.name = record.displayName
        agentRuntime.title = record.title
        agentRuntime.mark = record.mark
        agentRuntime.hire = record.hire
        agentAvatars.project(agentRuntime, record.id, record.avatarUrl)
        agentRuntime.matrixUser = record.matrixUser

        if (!known && !lifecycle.creating().has(record.principal)) {
          agentRuntime.readiness?.start()
        }
      }

      // The assistant card (2026-10-05): what others see follows the record's name, and a
      // persona changed on another Mac reaches this Mac's copy.
      observeAssistantNames()
      refreshAgentSouls([...(mine ? [mine] : []), ...others])
      keepRosterFresh()

      if (unusedRoot()) {
        defaultAgent.readiness?.stop()
        assistantSetupState = undefined
        startupState = undefined
      }

      // Retired on another Mac, or before a quit here: this Mac's part of the retirement.
      let reconciliationFailed = false

      // A withdrawn executor still retains its physical custody until local
      // cleanup runs. Successful revocation removes that retained principal,
      // so the tombstone no longer selects a root on the next roster sync.
      if (retiredRoot && !retiring.has(retiredRoot.principal)) {
        try {
          await lifecycle.retire(retiredRoot.principal, retiredRoot.id, true)
        } catch (error) {
          reconciliationFailed = true
          console.warn(
            `[Matrix] retired root ${retiredRoot.principal.slice(0, 8)} cleanup still pending:`,
            setupFailureDetail(error)
          )
        }
      }

      for (const principal of retired) {
        if (closing) {
          return readinessPass
        }

        if (!agentRoster.isCurrent(result, account.appScope())) {
          agentRoster.request()

          return readinessPass
        }

        console.warn(`[Matrix] agent ${principal.slice(0, 8)} is no longer on the roster: removing it from this Mac`)

        try {
          await forgetRetiredAgent(principal)
        } catch (error) {
          reconciliationFailed = true
          console.warn(`[Matrix] agent ${principal.slice(0, 8)} cleanup still pending:`, setupFailureDetail(error))
        }
      }

      if (!agentRoster.isCurrent(result, account.appScope())) {
        agentRoster.request()

        return readinessPass
      }

      if (reconciliationFailed) {
        agentRoster.request()
        setAgentRosterReadiness('unavailable')

        return readinessFail('agent_roster_unavailable')
      }

      console.warn(`[Matrix] agents synced: ${others.length} other agent${others.length === 1 ? '' : 's'}`)
      // Creations and retirements a quit interrupted.
      lifecycle.resume()
      setAgentRosterReadiness('ready')

      for (const each of allAgents()) {
        const host = hosts.get(each.role)

        if (!each.closed && host?.ready) {armAgentTasks(each, host)}
      }

      return readinessPass
    } catch (error) {
      // A fetched roster only becomes complete after reconciliation. Keep it pending if
      // local setup or retirement failed, so the existing readiness watch can retry it.
      agentRoster.request()
      setAgentRosterReadiness('unavailable')
      console.warn('[Matrix] agents not synced:', setupFailureDetail(error))

      return readinessFail('agent_roster_unavailable')
    } finally {
      agentsSync = undefined
      publish(state)
    }
  })()

  return agentsSync
}

/** Creating and retiring other agents: the order and the vault records are
 * agent-lifecycle.ts's; the effects of each step are main's. */
let lifecycle: MatrixAgentLifecycle

function createLifecycle(): MatrixAgentLifecycle {
  return new MatrixAgentLifecycle({
    store: outcomeStore,
    // The platform's answers that are final: a name it does not allow (400), the limit of
    // agents (409), an account that may not make them or a platform without them (403, 404),
    // a hire the third+ agent requires (with its price) and a short Proton balance.
    refusal: error =>
      error instanceof MatrixAgentDefinitionError
        ? error.code === 'hire_required'
          ? { hire: error.refusal?.hire?.price_protons ?? 60_000 }
          : error.code === 'conflict' && error.refusal?.reason === 'hire_insufficient_protons'
            ? 'short'
            : error.code === 'invalid'
              ? 'name'
              : error.code === 'conflict'
                ? 'limit'
                : error.code === 'denied' || error.code === 'missing'
                  ? 'account'
                  : undefined
        : undefined,
    createOnPlatform: input => account.createAgent(input, AbortSignal.timeout(20_000)),
    define: creation => defineAgent(creation),
    runtime: creation => {
      const agentRuntime = agentRuntimeFor(creation.principal)
      agentRuntime.assistantId = creation.assistantId
      agentRuntime.name = creation.name
      agentRuntime.matrixUser = creation.matrixUser
      publish(state)
    },
    room: creation => agentRoom(creation),
    importProfile: async creation => {
      const agentRuntime = agents.get(creation.principal)

      if (!runtime || !agentRuntime || agentRuntime.closed || closing || !creation.profileImport || !creation.roomId) {
        throw new Error('matrix_profile_import_invalid')
      }

      // Enrollment creates identity/vault records, not a running Hermes home. The
      // lifecycle blocks all background runtime starts until installation finishes.
      if (enrollmentOf(agentRuntime).state !== 'ready') {
        await account.enrollAgent(creation.principal)
      }

      const identity = enrollmentOf(agentRuntime).identity

      if (!identity || agentRuntime.closed || closing) {
        throw new Error('matrix_agent_unavailable')
      }

      await installMatrixProfileImport(
        runtime,
        creation.profileImport,
        agentHermesHome(agentRuntime, identity, runtime),
        creation.roomId
      )
      markAgentHostedHere(agentRuntime)
      rememberOwnModel(identity.executorId, true, agentRuntime)
    },
    setUp: async principal => {
      const agentRuntime = agents.get(principal)

      if (!agentRuntime) {
        return false
      }

      // Enrollment, host, persona (before its Hermes first runs) and Atum's model.
      await setUpAgent(agentRuntime)

      return (
        enrollmentOf(agentRuntime).state === 'ready' &&
        agentRuntime.setupState !== 'failed' &&
        (await waitUntil(() => Boolean(hosts.get(agentRuntime.role)?.ready), 30_000, AbortSignal.timeout(31_000)))
      )
    },
    connect: async (principal, roomId) => {
      const agentRuntime = agents.get(principal)
      const humanHost = hosts.get('human')
      const agentHost = agentRuntime ? hosts.get(agentRuntime.role) : undefined

      if (!agentRuntime || !humanHost || !agentHost) {
        throw new Error('matrix_not_ready')
      }

      await connectAgentRoom(agentRuntime, roomId, humanHost, agentHost)
    },
    started: principal => {
      const agentRuntime = agents.get(principal)

      // Made on this Mac: this Mac is its home device.
      if (agentRuntime) {
        markAgentHostedHere(agentRuntime)
      }

      agentRuntime?.readiness?.start()
      publish(state)
    },
    placed: creation => rememberPlacedCloudAgent(creation.principal),
    retireOnPlatform: async assistantId => {
      const { sessionCleanup } = await account.retireAgent(assistantId, AbortSignal.timeout(20_000))
      // Retired for good: never the target of a later hire (store.ts reusable hire targets).
      store?.forgetHireTarget(assistantId)

      return sessionCleanup
    },
    forgetLocally: (principal, rootCustody) => forgetRetiredAgent(principal, rootCustody),
    log: line => console.warn(line),
    randomId: () => randomUUID()
  })
}

/** The persona goes into the agent's definition on the platform, so each of the person's
 * Macs seeds its Hermes from it. Repeating it after a write that landed changes nothing. */
async function defineAgent(creation: MatrixCreatedAgent) {
  if (creation.profileImport) {
    if (!runtime) {
      throw new Error('matrix_runtime_unavailable')
    }

    const imported = await readMatrixProfileImport(
      runtime,
      creation.profileImport.prepared,
      creation.profileImport.sha256
    )

    await publishMatrixProfileImport(imported, {
      read: () => account.agentDefinition(creation.assistantId, AbortSignal.timeout(20_000)),
      skill: bundle => account.putAgentSkill(creation.assistantId, bundle, AbortSignal.timeout(30_000)),
      write: (snapshot, definition) =>
        account.writeAgentDefinition(
          creation.assistantId,
          {
            expectedDefinitionRevision: snapshot.definitionRevision,
            expectedIdentityRevision: snapshot.identityRevision,
            displayName: snapshot.assistant.displayName,
            avatar: snapshot.assistant.avatar,
            definition
          },
          AbortSignal.timeout(20_000)
        )
    })

    return
  }

  if (!creation.persona.trim()) {
    return
  }

  const snapshot = await account.agentDefinition(creation.assistantId, AbortSignal.timeout(20_000))

  if (snapshot.definition?.soul === creation.persona) {
    return
  }

  await account.writeAgentDefinition(
    creation.assistantId,
    {
      expectedDefinitionRevision: snapshot.definitionRevision,
      expectedIdentityRevision: snapshot.identityRevision,
      displayName: snapshot.assistant.displayName,
      avatar: snapshot.assistant.avatar,
      definition: {
        schemaVersion: ATUM_AGENT_PORTABILITY_SCHEMA_VERSION,
        soul: creation.persona,
        modelAlias: snapshot.definition?.modelAlias ?? MATRIX_DEFAULT_MODEL,
        reasoning: snapshot.definition?.reasoning ?? null,
        skills: snapshot.definition?.skills ?? []
      }
    },
    AbortSignal.timeout(20_000)
  )
}

/** The owner's private room with the agent: the one that exists (a repeat after the room
 * was made), else a new one, which the window opens. */
async function agentRoom(creation: MatrixCreatedAgent): Promise<string> {
  const owner = account.identity()?.userId

  if (!owner || !humanPrepared || state.state !== 'ready') {
    throw new Error('matrix_not_ready')
  }

  // The server's list of the owner's rooms, not the last sync: a room made just before a quit
  // is reused, never made twice.
  const existing = await command({ kind: 'findAssistantRoom', ownerId: owner, agentId: creation.matrixUser }, 60_000)

  if (typeof existing === 'string' && existing.startsWith('!')) {
    return existing
  }

  const roomId = await command(
    { kind: 'createAssistant', name: '', direct: true, invite: [creation.matrixUser] },
    60_000
  )

  if (typeof roomId !== 'string' || !roomId.startsWith('!')) {
    throw new Error('matrix_send_failed')
  }

  return roomId
}

/** This Mac's part of a retirement, safe to repeat. A named agent loses its runtime,
 * device, executor credentials and vault scope. A retired root instead loses only its
 * runtime, device and root executor credentials, keeping history and named-agent custody. */
async function forgetRetiredAgent(principal: string, rootCustody?: true) {
  const agentRuntime = rootCustody ? defaultAgent : agents.get(principal)
  let device = agentRuntime?.identity
  const matrixUser = agentRuntime?.userId

  placedAgents.delete(principal)

  // Its chats with the person leave the chat list now, never a live agent's (one that shares
  // the Matrix user); a later roster's tombstone repeats this on the person's other Macs.
  if (matrixUser && !allAgents().some(each => each !== agentRuntime && !each.closed && each.userId === matrixUser)) {
    retiredAgentRooms.retired(account.identity()?.userId, matrixUser)
    void retiredAgentRooms.sweep({ owner: state.identity?.userId, ready: state.state === 'ready', rooms: state.rooms })
  }

  // A host that never started here still has a device in the enrollment.
  if (!device) {
    try {
      device = account.retainedAgentDevice(rootCustody ? undefined : principal)
    } catch {
      device = undefined
    }
  }

  agentContent.forget(principal)

  if (agentRuntime) {
    await stopAgentRuntime(agentRuntime)
  }

  if (device) {
    await clearDevice(device)
  }

  // The platform already revoked its executors; this clears the credentials in its Hermes
  // home and the enrollment slot.
  if (rootCustody) {
    await account.revokeHermes()
    defaultAgent.identity = undefined
  } else if (account.agentEnrollments().includes(principal)) {
    await account.revokeAgent(principal)
  }

  if (!rootCustody) {
    outcomeStore.scope(matrixAgentScope(principal)).clear()
  }

  if (agents.get(principal) === agentRuntime) {
    agents.delete(principal)
  }
}

/**
 * The "cleanup by Atum support" notice comes from executors an earlier sign-out could not
 * revoke. With the same person's platform authority back, the account finishes them itself
 * (account.reconcileOrphanedEnrollments); the notice stays only for what the platform can't
 * confirm. Tried at launch and when any agent's authority checks out (the default root may be
 * unused), once per launch or sign-in that had authority; background, never interactive.
 */
async function reconcileOrphanedEnrollments(): Promise<void> {
  if (orphanedEnrollmentsTried || !agentCleanupRequired || !config.domain || !account.identity()) {
    return
  }

  orphanedEnrollmentsTried = true

  try {
    const { attempted, cleared, remaining } = await account.reconcileOrphanedEnrollments()

    if (!attempted) {
      // No platform authority yet (it may need the browser): a later trigger tries again.
      orphanedEnrollmentsTried = false

      return
    }

    console.warn(`[Matrix] orphaned enrollments cleared=${cleared} remaining=${remaining}`)
    const required = account.hasOrphanedEnrollments()

    if (required !== agentCleanupRequired) {
      agentCleanupRequired = required
      publish(state)
    }
  } catch {
    console.warn('[Matrix] orphaned enrollments unchanged: reconcile_failed')
  }
}

// Parity with the old app: a signed-in person gets their assistant without a manual
// setup step. Runs after sign-in (may open the browser once for the domain grant) and
// at launch (only with an existing grant). The manual controls stay for retry.
let assistantSetup: Promise<void> | undefined
/** Set when the platform asked the assistant's enrollment to wait (0150's Retry-After). */
let assistantSetupRetryAt: number | undefined

function setUpAssistant(interactive: boolean): Promise<void> {
  if (defaultAgent.closed) {
    return Promise.resolve()
  }

  // As setUpAgent: a legacy cloud-only assistant is never started or checked on this Mac. A saved
  // H-F policy can prepare it for a fenced takeover; a move still cannot restart it mid-flight.
  if (isCloudOnlyAgent(defaultAgent) || isMovingAgent(defaultAgent)) {
    assistantSetupState = undefined
    assistantSetupRetryAt = undefined
    startupState = undefined
    publish(state)

    return Promise.resolve()
  }

  if (!matrixEnrollmentAuthority(account.enrollment()).ok) {
    assistantSetupState = undefined
    assistantSetupRetryAt = undefined
    startupState = undefined
    publish(state)

    return Promise.resolve()
  }

  if (!config.domain || closing) {
    startupState = undefined
    publish(state)

    return Promise.resolve()
  }

  // This Mac already holds its default in a named slot. The empty physical
  // root stays idle; setup never copies custody or issues a redundant device.
  if (unusedRoot()) {
    defaultAgent.readiness?.stop()

    return Promise.resolve()
  }

  // Manual setup previously read the platform roster every time. Keep that explicit
  // refresh behavior, while normal readiness starts only retry a pending roster.
  if (interactive) {
    agentRoster.request()
  }

  const live = () => {
    if (!matrixEnrollmentAuthority(account.enrollment()).ok) {
      throw new Error('matrix_authority_withdrawn')
    }
  }

  assistantSetup ??= (async () => {
    let step: 'assistant' | 'model' = 'assistant'
    assistantSetupRetryAt = undefined

    try {
      // Roster only reads role/slot metadata. It never awaits setup, so this
      // direction cannot deadlock the roster and enrollment single flights.
      if (productDefaultPrincipal === undefined && account.appScope()) {
        let roster: MatrixReadinessCheck | undefined
        let failure: unknown

        try {
          roster = await syncAgents()
        } catch (error) {
          failure = error
        }

        // A first roster read that fails before naming the product default is not a setup
        // failure: the assistant may already be in the cloud, and the next read decides. Keep
        // the setup pending and let the readiness gate retry it at its first backoff.
        const retry = matrixAssistantSetupRosterRetry({ roster, defaultPrincipal: productDefaultPrincipal })

        if (retry !== undefined) {
          assistantSetupState = undefined
          assistantSetupRetryAt = Date.now() + retry
          startupState = undefined
          publish(state)

          return
        }

        if (failure) {
          throw failure
        }

        live()
      }

      // The entry guard ran before a cold sign-in had a roster. The sync above is the first
      // answer, and a cloud-only default is already answering in the cloud: no local executor
      // enrollment may start (the platform fences it with `cloud_answering`, which would show a
      // setup failure for a healthy assistant).
      if (!matrixAssistantSetupRunsLocally({ cloudOnly: isCloudOnlyAgent(defaultAgent) })) {
        assistantSetupState = undefined
        assistantSetupRetryAt = undefined
        startupState = undefined
        publish(state)

        return
      }

      if (unusedRoot()) {
        defaultAgent.readiness?.stop()
        assistantSetupState = undefined
        startupState = undefined

        return
      }

      const enrollment = account.enrollment()

      if (enrollment.state === 'ready') {
        // The assistant exists. A first setup that failed or was interrupted
        // still owes it Atum's model: checked at every launch and on retry.
        if (!hosts.has('agent')) {
          startupState = { step, state: 'working' }
          publish(state)
          await startHost('agent')
          live()

          if (!hosts.has('agent')) {
            throw new Error('matrix_agent_unavailable')
          }
        }

        step = 'model'
        await syncAgents()
        await seedAgentSoul(defaultAgent)
        live()
        syncAgentContent(defaultAgent)
        startupState = { step, state: 'working' }
        publish(state)
        const model = await configureManagedModelWithRetry()
        live()
        assistantSetupState = undefined
        console.warn(`[Matrix] assistant ready: ${modelCheckNote(model)}`)
        void syncAgents()

        return
      }

      // Same exclusion as the manual enrollHermes command.
      if (
        !['absent', 'expired', 'pending'].includes(enrollment.state) ||
        operation ||
        defaultAgent.operation ||
        domainOperation ||
        !account.identity()
      ) {
        return
      }

      assistantSetupState = 'working'
      startupState = { step, state: 'working' }
      publish(state)
      domainOperation = true

      try {
        await stopHost('agent')
        live()
        await account.enrollHermes(interactive)
        live()
        await startHost('agent')
        live()
      } finally {
        domainOperation = false
      }

      step = 'model'
      await syncAgents()
      await seedAgentSoul(defaultAgent)
      live()
      syncAgentContent(defaultAgent)
      startupState = { step, state: 'working' }
      publish(state)
      const model = await configureManagedModelWithRetry()
      live()
      assistantSetupState = undefined
      console.warn(
        `[Matrix] assistant ready: enrolled and ${model === 'checked' ? 'model set' : modelCheckNote(model)}`
      )
      void syncAgents()
    } catch (error) {
      if (!matrixEnrollmentAuthority(account.enrollment()).ok) {
        assistantSetupState = undefined
        assistantSetupRetryAt = undefined
        startupState = undefined

        return
      }

      // Asked to wait by the platform's per-owner bounds (0150): still setting up, not failed.
      // The gate waits for Retry-After and sends nothing before it.
      if (error instanceof MatrixEnrollmentRateLimited) {
        assistantSetupState = undefined
        assistantSetupRetryAt = Date.now() + error.retryAfterMs
        console.warn(
          `[Matrix] assistant setup waits ${Math.round(error.retryAfterMs / 1000)} s: the platform asked to wait`
        )

        return
      }

      const code = error instanceof Error && /^matrix_[a-z_]+$/.test(error.message) ? error.message : 'unexpected'
      rereadCustodyAfterRefusal(code)

      // Without a domain grant the person has to click once (never a surprise browser). A
      // browser confirmation that was cancelled or ran out of time is still that one step,
      // not a failed setup.
      const actionRequired = [
        'matrix_domain_connection_required',
        'matrix_login_cancelled',
        'matrix_login_timed_out'
      ].includes(code)

      assistantSetupState = actionRequired ? 'action_required' : 'failed'
      startupState = { step, state: actionRequired ? 'action_required' : 'failed' }
      console.warn('[Matrix] assistant setup did not finish:', step, code, setupFailureDetail(error))
    } finally {
      // Anything still marked working has finished or had nothing to do.
      if (startupState?.state === 'working') {
        startupState = undefined
      }

      assistantSetup = undefined
      publish(state)
    }
  })()

  return assistantSetup
}

/** A refused enrollment may have just withdrawn a stale duplicate intent (account.ts
 * releaseStaleDuplicate): the roster decides again, now, which slot serves the agent here,
 * instead of after a relaunch. Roster sync never awaits setup, so this cannot deadlock. */
function rereadCustodyAfterRefusal(code: string) {
  if (code !== 'matrix_enrollment_invalid' || closing) {
    return
  }

  agentRoster.request()
  void syncAgents()
}

/** Another agent's setup, as setUpAssistant is the default's: this Mac's executor for it is
 * enrolled (never through the browser: the default's setup holds the domain grant), its
 * host started and Atum's model checked, at every launch and on retry. Its own guard, so
 * one agent's setup never holds up another's turns. */
function setUpAgent(agentRuntime: MatrixAgentRuntime): Promise<void> {
  const principal = agentRuntime.principal

  // S1 legacy cloud-only agents are not enrolled, started or checked here. A saved H-F policy can
  // prepare one for a fenced takeover; a move still cannot restart it mid-flight.
  if (isCloudOnlyAgent(agentRuntime) || isMovingAgent(agentRuntime)) {
    agentRuntime.setupState = undefined
    agentRuntime.setupRetryAt = undefined

    return Promise.resolve()
  }

  if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
    agentRuntime.setupState = undefined
    agentRuntime.setupRetryAt = undefined
    publish(state)

    return Promise.resolve()
  }

  if (
    principal === undefined ||
    !config.domain ||
    closing ||
    agentRuntime.closed ||
    lifecycle.blocksRuntime(principal)
  ) {
    return Promise.resolve()
  }

  // Stopped for good (retire, sign-out) while a step awaited: nothing more starts.
  const live = () => {
    if (agentRuntime.closed || closing) {
      throw new Error('matrix_agent_unavailable')
    }

    if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
      throw new Error('matrix_authority_withdrawn')
    }
  }

  agentRuntime.setup ??= (async () => {
    let step: 'assistant' | 'model' = 'assistant'
    agentRuntime.setupRetryAt = undefined

    try {
      const enrollment = enrollmentOf(agentRuntime)

      if (enrollment.state !== 'ready') {
        // As for the default agent: nothing to do now; the gate reports the setup as failed.
        if (
          !['absent', 'expired', 'pending'].includes(enrollment.state) ||
          operation ||
          agentRuntime.operation ||
          !account.identity()
        ) {
          return
        }

        agentRuntime.setupState = 'working'
        agentRuntime.operation = true
        publish(state)

        try {
          await stopHost(agentRuntime.role)
          live()
          await account.enrollAgent(principal)
        } finally {
          agentRuntime.operation = false
        }
      }

      live()

      if (!hosts.has(agentRuntime.role)) {
        await startHost(agentRuntime.role)

        if (!hosts.has(agentRuntime.role)) {
          throw new Error('matrix_agent_unavailable')
        }
      }

      live()
      await seedAgentSoul(agentRuntime)
      // Its skills from the definition, in the background: never delays its readiness.
      syncAgentContent(agentRuntime)
      live()
      step = 'model'
      const model = await configureManagedModelWithRetry(agentRuntime)
      live()
      agentRuntime.setupState = undefined
      console.warn(`[Matrix] agent ${principal.slice(0, 8)} ready: ${modelCheckNote(model)}`)
    } catch (error) {
      if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
        agentRuntime.setupState = undefined
        agentRuntime.setupRetryAt = undefined

        return
      }

      // Asked to wait by the platform's per-owner bounds (0150): still setting up, not failed.
      // Its gate waits for Retry-After and sends nothing before it.
      if (error instanceof MatrixEnrollmentRateLimited) {
        agentRuntime.setupState = undefined
        agentRuntime.setupRetryAt = Date.now() + error.retryAfterMs
        console.warn(
          `[Matrix] agent ${principal.slice(0, 8)} setup waits ${Math.round(error.retryAfterMs / 1000)} s: the platform asked to wait`
        )

        return
      }

      const code = error instanceof Error && /^matrix_[a-z_]+$/.test(error.message) ? error.message : 'unexpected'
      rereadCustodyAfterRefusal(code)
      agentRuntime.setupState = code === 'matrix_domain_connection_required' ? 'action_required' : 'failed'
      console.warn(
        `[Matrix] agent ${principal.slice(0, 8)} setup did not finish:`,
        step,
        code,
        setupFailureDetail(error)
      )
    } finally {
      agentRuntime.setup = undefined
      publish(state)
    }
  })()

  return agentRuntime.setup
}

/** The person chose to answer this agent's typed messages on this Mac (Always answer here). */
const MATRIX_ANSWER_HERE = 'matrix-agent-answer-here-v1'

/**
 * Typed messages to this agent go to the Mac that answers it (option A, the agent's home
 * device): only for a named agent this Mac holds as a guest copy (installed from its
 * definition, not created or imported here), unless the person chose to answer here or
 * the build's configuration hasn't turned it on (`agentHandoff: true`; off by default since
 * 2026-10-04: agents sync to every Mac instead of living on one). The default agent (the
 * product default, wherever it is held) keeps today's path. Whether another Mac answers now
 * is the lease's (the caller's) to say.
 */
function answersFromHome(agentRuntime: MatrixAgentRuntime): boolean {
  // The default agent keeps today's path, in the root slot or in a named one.
  if (
    config.agentHandoff !== true ||
    agentRuntime.principal === undefined ||
    agentRuntime.closed ||
    agentRuntime === productAgent()
  ) {
    return false
  }

  try {
    if (agentRuntime.store.getItem(MATRIX_ANSWER_HERE) === '1') {
      return false
    }
  } catch {
    return false
  }

  return agentHostedHere(agentRuntime) === false
}

/** Whether this Mac is the agent's home (created or imported here, agent-home.ts): settled
 * once per executor with the agent's home, so a publish never reads the disk for it. */
function agentHostedHere(agentRuntime: MatrixAgentRuntime): boolean | undefined {
  const identity = enrollmentOf(agentRuntime).identity

  if (!runtime || !identity || agentRuntime.principal === undefined) {
    return undefined
  }

  const known = agentRuntime.hosted

  if (known?.executorId === identity.executorId) {
    return known.hosted
  }

  const home = agentHermesHome(agentRuntime, identity, runtime)

  const hosted = matrixAgentHosted({
    profiles: runtime.profiles,
    owner: identity.principal,
    agent: agentRuntime.principal,
    home
  })

  agentRuntime.hosted = { executorId: identity.executorId, hosted }

  return hosted
}

/** This Mac made or imported the agent: it is the agent's home (agent-home.ts). */
function markAgentHostedHere(agentRuntime: MatrixAgentRuntime) {
  const identity = enrollmentOf(agentRuntime).identity

  if (!runtime || !identity || agentRuntime.principal === undefined) {
    return
  }

  try {
    markMatrixAgentHosted({
      profiles: runtime.profiles,
      owner: identity.principal,
      agent: agentRuntime.principal,
      home: agentHermesHome(agentRuntime, identity, runtime)
    })
    agentRuntime.hosted = { executorId: identity.executorId, hosted: true }
  } catch {
    console.warn(`[Matrix] agent ${agentRuntime.principal.slice(0, 8)} home device not recorded`)
  }
}

/** The Hermes home an agent runs in on this Mac. Once an enrollment names the agent principal,
 * both root and named custody use the stable per-agent binding (agent-home.ts). */
function agentHermesHome(
  agentRuntime: MatrixAgentRuntime,
  identity: { principal: string; executorId: string },
  selectedRuntime: MatrixHermesRuntimeConfig
): string {
  const known = agentRuntime.hermesHome

  if (known?.executorId === identity.executorId && known.profiles === selectedRuntime.profiles) {
    return known.home
  }

  const agent =
    agentRuntime.principal ?? agentRuntime.agentPrincipal ?? enrollmentOf(agentRuntime).identity?.agentPrincipal

  let retained: { home: string; executorId: string } | undefined

  try {
    retained =
      agentRuntime.principal === undefined
        ? account.retainedHermesProfile()
        : account.retainedAgentHermes(agentRuntime.principal)
  } catch {
    retained = undefined
  }

  return matrixRuntimeHome({
    profiles: selectedRuntime.profiles,
    owner: identity.principal,
    agent,
    executorId: identity.executorId,
    retained
  })
}

/** Before an agent's home is retained at host start: its binding, and once, an earlier home over
 * a replaced empty one (agent-home.ts). The displaced home is kept for rollback, without the
 * executor's Atum key, which now lives where its Hermes runs. */
function reconcileAgentHome(
  agentRuntime: MatrixAgentRuntime,
  principal: string | undefined,
  identity: { principal: string; executorId: string },
  selectedRuntime: MatrixHermesRuntimeConfig
): string {
  const root = agentRuntime.principal === undefined

  const retained = root
    ? account.retainedHermesProfile()
    : principal
      ? account.retainedAgentHermes(principal)
      : undefined

  let decision: { home: string }

  try {
    decision = reconcileMatrixAgentHome({
      profiles: selectedRuntime.profiles,
      owner: identity.principal,
      agent: principal,
      executorId: identity.executorId,
      retained,
      reserved: account.retainedHermesHomes().filter(home => home !== retained?.home),
      quiescent: !agentRuntime.executor && !agentRuntime.invocation && !agentRuntime.starting,
      log: line => console.warn(line)
    })
  } catch {
    // Never a reason to fail the host: the home as the account and the binding have it now.
    agentRuntime.hermesHome = undefined

    return agentHermesHome(agentRuntime, identity, selectedRuntime)
  }

  const settled = (home: string) => {
    agentRuntime.hermesHome = { executorId: identity.executorId, profiles: selectedRuntime.profiles, home }

    return home
  }

  if (!retained || retained.executorId !== identity.executorId || retained.home === decision.home) {
    return settled(decision.home)
  }

  if (!principal) {
    return settled(retained.home)
  }

  try {
    if (root) {
      account.rebindHermesProfile(identity.executorId, retained.home, decision.home)
    } else {
      account.rebindAgentHermesProfile(principal, identity.executorId, retained.home, decision.home)
    }
  } catch {
    // The retained home stays this executor's until a later start completes the move.
    console.warn(`[Matrix] agent ${principal.slice(0, 8)} home move not recorded yet`)

    return settled(retained.home)
  }

  void clearMatrixHermesCredentials(selectedRuntime, retained.home).catch(() =>
    console.warn(`[Matrix] agent ${principal.slice(0, 8)} earlier home key not cleared`)
  )

  return settled(decision.home)
}

/** The agent's persona as its Hermes SOUL.md, the first time it is set up on this Mac, from
 * its definition on the platform (seedMatrixAgentSoul). The primary assistant without one is
 * Atum's built-in persona under the name it goes by (atum-soul.ts), never the engine's
 * default persona. */
async function seedAgentSoul(agentRuntime: MatrixAgentRuntime): Promise<void> {
  const identity = enrollmentOf(agentRuntime).identity
  const assistantId = agentRuntime.assistantId

  if (!runtime || !identity) {
    return
  }

  const primary = productAgent() === agentRuntime ? matrixPrimarySoulFallback(agentRuntime.name) : undefined

  await seedMatrixAgentSoul(
    agentHermesHome(agentRuntime, identity, runtime),
    async () => {
      // Existing imported homes never read or replace their SOUL. A fresh home must
      // resolve its own definition before Hermes can seed an unrelated default persona.
      if (!assistantId) {
        throw new Error('matrix_agent_roster_unavailable')
      }

      const soul = (await account.agentDefinition(assistantId, AbortSignal.timeout(15_000))).definition?.soul

      // Retired while the definition was read: nothing is written for it.
      if (agentRuntime.closed) {
        throw new Error('matrix_agent_unavailable')
      }

      if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
        throw new Error('matrix_authority_withdrawn')
      }

      return soul
    },
    primary
  )
}

/** Each agent's skills on this Mac (agent-content, AW): owned by that module, run from here. */
const agentContent = new MatrixAgentContent({
  log: line => console.warn(line),
  changed: () => publish(state)
})

const profiles = new MatrixProfiles({
  resolve: target =>
    matrixMainProfileHost(
      {
        account: () => account,
        state: () => state,
        closing: () => closing,
        hosts,
        agents: allAgents,
        enrollment: enrollmentOf,
        blocked: agent => lifecycle.blocksRuntime(agent.principal)
      },
      target
    ),
  changed: (target, metadata) => {
    const role =
      target.kind === 'human' ? 'human' : allAgents().find(agent => agent.agentPrincipal === target.principal)?.role

    const host = role ? hosts.get(role) : undefined

    if (host?.identity.userId === metadata.userId) {
      host.profile = metadata
      observeAssistantNames()
      publish(target.kind === 'human' ? { ...state, ownProfile: metadata } : state)
    }
  }
})

/**
 * What other people see an assistant called (assistant-name-sync.ts): each assistant whose
 * Matrix session this Mac holds, its record's name against its session's. A primary whose
 * name is locked (owner decision D1) is left alone.
 */
const assistantNames = new MatrixAssistantNameSync({
  apply: (principal, name) => profiles.syncName(principal, name),
  log: line => console.warn(line)
})

function observeAssistantNames() {
  if (closing) {
    return
  }

  assistantNames.observe(
    matrixAssistantNameEntries(
      allAgents().map(each => {
        const host = hosts.get(each.role)

        return {
          closed: each.closed,
          primary: each === productAgent(),
          principal: each.agentPrincipal,
          name: each.name,
          userId: each.userId,
          host: host && { ready: host.ready, profile: host.profile }
        }
      }),
      isAssistantNameLocked
    )
  )
}

/** The definition revision whose persona this Mac's copy of each assistant last reconciled. */
const reconciledSouls = new Map<string, number>()
const reconcilingSouls = new Set<string>()

/** This Mac's SOUL.md for one assistant, brought to its definition's persona when it still
 * says what Atum last wrote there (reconcileMatrixAgentSoul). Never blocks anything. */
function refreshAgentSoul(agentRuntime: MatrixAgentRuntime, soul: string | undefined, revision: number) {
  const identity = enrollmentOf(agentRuntime).identity
  const principal = agentRuntime.agentPrincipal

  if (
    !runtime ||
    !identity ||
    !principal ||
    agentRuntime.closed ||
    !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok
  ) {
    return
  }

  // The primary's built-in persona says the name it goes by now, so a rename reaches it too.
  const primary = productAgent() === agentRuntime ? matrixPrimarySoulFallback(agentRuntime.name) : undefined

  try {
    const result = reconcileMatrixAgentSoul(agentHermesHome(agentRuntime, identity, runtime), soul, primary)

    if (result !== 'absent') {
      reconciledSouls.set(principal, revision)
    }

    if (result === 'applied') {
      console.warn(`[Matrix] assistant ${principal.slice(0, 8)} persona updated on this Mac (r${revision})`)
    }
  } catch (error) {
    console.warn(`[Matrix] assistant ${principal.slice(0, 8)} persona not updated:`, setupFailureDetail(error))
  }
}

/** After a roster read: any assistant enrolled here whose definition moved on. */
function refreshAgentSouls(records: readonly { principal: string; id: string; definitionRevision: number }[]) {
  for (const record of records) {
    const agentRuntime = allAgents().find(each => each.agentPrincipal === record.principal && !each.closed)

    if (
      !agentRuntime ||
      !enrollmentOf(agentRuntime).identity ||
      reconcilingSouls.has(record.principal) ||
      (reconciledSouls.get(record.principal) ?? -1) >= record.definitionRevision
    ) {
      continue
    }

    reconcilingSouls.add(record.principal)
    void account
      .agentDefinition(record.id, AbortSignal.timeout(15_000))
      .then(snapshot => {
        if (!closing && !agentRuntime.closed) {
          refreshAgentSoul(agentRuntime, snapshot.definition?.soul, snapshot.definitionRevision)
        }
      })
      .catch(() => {})
      .finally(() => reconcilingSouls.delete(record.principal))
  }
}

const SOUL_WRITEBACK_KEY = 'matrix-agent-soul-writeback-v1'

interface MatrixSoulTurnStart {
  home: string
  raw: string
  text: string
  platformText: string
  snapshot: MatrixAgentDefinitionSnapshot
  assistantId: string
  principal: string
  executorId: string
}

function readSoulRaw(home: string): string | undefined {
  try {
    const value = readFileSync(path.join(home, 'SOUL.md'), 'utf8')
    return Buffer.byteLength(value, 'utf8') <= 65_536 ? value : undefined
  } catch {
    return undefined
  }
}

function soulPendingKey(executorId: string): string {
  return `${SOUL_WRITEBACK_KEY}:${executorId}`
}

/** Revision-fenced Mac SOUL write-back; a concurrent card change always wins. */
function matrixAgentSoulLifecycle(agentRuntime: MatrixAgentRuntime): MatrixHermesTurnLifecycle {
  return {
    beforeTurn: async (): Promise<MatrixSoulTurnStart | undefined> => {
      const identity = enrollmentOf(agentRuntime).identity
      const assistantId = agentRuntime.assistantId
      const principal = cloudPrincipal(agentRuntime)
      const selectedRuntime = runtime

      if (
        !identity ||
        !assistantId ||
        !principal ||
        !selectedRuntime ||
        !atumInstructionsForMacHome(agentRuntime) ||
        agentRuntime.closed ||
        !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok
      ) {return undefined}

      const snapshot = await account.agentDefinition(assistantId, AbortSignal.timeout(15_000))
      if (agentRuntime.closed || enrollmentOf(agentRuntime).identity?.executorId !== identity.executorId) {return undefined}

      refreshAgentSoul(agentRuntime, snapshot.definition?.soul, snapshot.definitionRevision)
      const home = agentHermesHome(agentRuntime, identity, selectedRuntime)
      const raw = readSoulRaw(home)
      const localText = matrixAgentSoulText(home)
      if (raw === undefined || localText === undefined) {return undefined}

      const primary = productAgent() === agentRuntime ? matrixPrimarySoulFallback(agentRuntime.name).soul.trim() : ''
      const platformText = (snapshot.definition?.soul ?? primary).replace(/\r\n?/gu, '\n').trim()
      let text = localText

      try {
        const pending = JSON.parse(agentRuntime.store.getItem(soulPendingKey(identity.executorId)) ?? 'null') as {
          revision?: unknown
          platformText?: unknown
        } | null
        if (
          pending?.revision === snapshot.definitionRevision &&
          pending.platformText === platformText &&
          localText !== platformText
        ) {
          // A previous write failed: retry even when the agent made no second edit this turn.
          text = platformText
        } else {
          agentRuntime.store.removeItem(soulPendingKey(identity.executorId))
        }
      } catch {
        // An unreadable retry note is no authority; compare against the file as it is.
      }

      return {
        home,
        raw,
        text,
        platformText,
        snapshot,
        assistantId,
        principal,
        executorId: identity.executorId
      }
    },
    afterTurn: async value => {
      const start = value as MatrixSoulTurnStart | undefined
      if (!start || agentRuntime.closed || enrollmentOf(agentRuntime).identity?.executorId !== start.executorId) {return}

      const raw = readSoulRaw(start.home)
      const text = matrixAgentSoulText(start.home)
      if (raw === undefined || text === undefined || text === start.text) {return}

      const clearPending = () => {
        try {
          agentRuntime.store.removeItem(soulPendingKey(start.executorId))
        } catch {
          // The platform write is still authoritative; a stale retry note is ignored by revision.
        }
      }

      if (!text || text.includes('\u0000') || Buffer.byteLength(text, 'utf8') > 65_536) {
        if (start.platformText) {replaceMatrixAgentSoul(start.home, raw, start.platformText)}
        clearPending()
        return
      }

      try {
        const written = await account.writeAgentDefinition(
          start.assistantId,
          {
            expectedDefinitionRevision: start.snapshot.definitionRevision,
            expectedIdentityRevision: start.snapshot.identityRevision,
            displayName: start.snapshot.assistant.displayName,
            avatar: start.snapshot.assistant.avatar,
            definition: {
              schemaVersion: ATUM_AGENT_PORTABILITY_SCHEMA_VERSION,
              soul: text,
              modelAlias: start.snapshot.definition?.modelAlias ?? MATRIX_DEFAULT_MODEL,
              reasoning: start.snapshot.definition?.reasoning ?? null,
              skills: start.snapshot.definition?.skills ?? []
            }
          },
          AbortSignal.timeout(20_000)
        )

        // Mark only the exact file the turn produced; a simultaneous local edit remains local.
        if (readSoulRaw(start.home) === raw) {markMatrixAgentSoulApplied(start.home, text)}
        clearPending()
        reconciledSouls.set(start.principal, written.definitionRevision)
        agentRoster.request()
        publish(state)
      } catch (error) {
        if (error instanceof MatrixAgentDefinitionError && error.code === 'conflict') {
          const current = await account.agentDefinition(start.assistantId, AbortSignal.timeout(15_000)).catch(() => undefined)
          const primary = productAgent() === agentRuntime ? matrixPrimarySoulFallback(agentRuntime.name).soul.trim() : ''
          const winner = (current?.definition?.soul ?? primary).trim()
          if (winner) {replaceMatrixAgentSoul(start.home, raw, winner)}
          if (current) {reconciledSouls.set(start.principal, current.definitionRevision)}
          clearPending()
          return
        }

        try {
          agentRuntime.store.setItem(
            soulPendingKey(start.executorId),
            JSON.stringify({ revision: start.snapshot.definitionRevision, platformText: start.platformText })
          )
        } catch {
          // The local SOUL remains untouched and the next card/roster reconciliation stays safe.
        }
      }
    }
  }
}

/** A rename or a persona made on another Mac shows here without a relaunch: the roster is
 * read again every quarter hour while signed in (a no-op read when nothing changed). */
let rosterRefresh: ReturnType<typeof setInterval> | undefined

function keepRosterFresh() {
  rosterRefresh ??= setInterval(() => {
    if (closing || !account.appScope()) {
      return
    }

    agentRoster.request()
    void syncAgents()
  }, 15 * 60_000)
  rosterRefresh.unref?.()
}

/** The assistant card (2026-10-05): its name and persona, written to the platform record. */
const assistantCards = new MatrixAssistantCards({
  appNames,
  agents: () =>
    allAgents().flatMap(each =>
      !each.closed && each.agentPrincipal && each.assistantId
        ? [
            {
              principal: each.agentPrincipal,
              assistantId: each.assistantId,
              isDefault: each === productAgent(),
              ...(each.name ? { name: each.name } : {})
            }
          ]
        : []
    ),
  read: (assistantId, signal) => account.agentDefinition(assistantId, signal),
  write: (assistantId, input, signal) => account.writeAgentDefinition(assistantId, input, signal),
  avatar: async (agent, avatar, signal) => {
    const written = await writeCanonicalAgentAvatar(
      null,
      { id: agent.assistantId, principal: agent.principal },
      avatar,
      signal,
      () => !signal.aborted && !closing
    )

    const runtime = allAgents().find(each => !each.closed && each.agentPrincipal === agent.principal)

    return runtime
      ? { ...written, assistant: { ...written.assistant, avatarUrl: runtime.avatarUrl } }
      : { ...written, assistant: { ...written.assistant, avatarUrl: null } }
  },
  saved: (agent, written, previous) => {
    for (const each of allAgents()) {
      if (each.agentPrincipal !== agent.principal || each.closed) {
        continue
      }

      each.name = written.assistant.displayName

      if (written.definitionRevision !== previous.definitionRevision) {
        refreshAgentSoul(each, written.definition?.soul, written.definitionRevision)
      }
    }

    observeAssistantNames()
    publish(state)
  }
})

/**
 * The assistant card's scheduled tasks (agent-routines.ts): one owner-route list per agent.
 * Main maps the window's principal to the platform's assistant id and holds the bearer; the
 * window only sees closed routines. The request ledger makes a retried draft one mutation.
 */
const agentRoutines = new MatrixAgentRoutines({
  agents: () =>
    allAgents().flatMap(each =>
      !each.closed && each.agentPrincipal && each.assistantId
        ? [{ principal: each.agentPrincipal, assistantId: each.assistantId }]
        : []
    ),
  read: (assistantId, signal) => account.agentRoutines(assistantId, signal),
  mutate: (assistantId, input, signal) => account.mutateAgentRoutine(assistantId, input, signal),
  runs: (assistantId, routineId, signal) => account.agentRoutineRuns(assistantId, routineId, signal),
  ownerZone: () => account.ownerTimeZone()
})

/** Keep the live shell on the same canonical photo returned by the platform, then reconcile the
 * full roster in the background. Matrix profile media is not an assistant-photo authority. */
async function writeCanonicalAgentAvatar(
  originPrincipal: string | null,
  target: Pick<MatrixAgentDefinitionRecord, 'id' | 'principal'>,
  avatar: { type: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array } | null,
  signal: AbortSignal,
  current: () => boolean
): Promise<MatrixAgentDefinitionSnapshot> {
  const saved = await account.writeAgentAvatar(
    target.id,
    originPrincipal,
    target.principal,
    avatar,
    signal
  )

  signal.throwIfAborted()

  if (!current()) {throw new Error('matrix_agent_profile_stale')}

  const runtime = allAgents().find(each => !each.closed && each.agentPrincipal === target.principal)

  if (runtime) {agentAvatars.project(runtime, target.id, saved.assistant.avatarUrl, avatar ?? undefined)}
  agentRoster.request()
  publish(state)
  void syncAgents()

  return saved
}

/** Profile authorization lives on the platform. A fresh roster is used only to translate a
 * target principal into the existing assistant-id avatar route; it never grants the write. */
async function requestCanonicalAgentProfile(
  originPrincipal: string,
  request: AgentProfileRequest,
  signal: AbortSignal,
  current: () => boolean
): Promise<AgentProfileResult> {
  signal.throwIfAborted()

  if (!current()) {throw new Error('matrix_agent_profile_stale')}

  if (request.operation !== 'avatar') {
    return account.agentProfiles(originPrincipal, request, signal)
  }

  const targetPrincipal = request.target ?? originPrincipal
  const roster = await account.agents(AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
  signal.throwIfAborted()

  if (!current()) {throw new Error('matrix_agent_profile_stale')}
  const target = roster.find(record => record.status === 'active' && record.principal === targetPrincipal)

  if (!target) {return { error: 'missing' }}

  await writeCanonicalAgentAvatar(originPrincipal, target, request.avatar, signal, current)

  return account.agentProfiles(
    originPrincipal,
    { operation: 'read', ...(request.target === undefined ? {} : { target: request.target }) },
    signal
  )
}

/** Apply only the canonical profile returned by the server, then reconcile the full roster. */
function applyCanonicalAgentProfile(profile: AgentProfileDetail) {
  for (const runtime of allAgents()) {
    if (runtime.closed || runtime.agentPrincipal !== profile.principal) {continue}
    runtime.name = profile.displayName

    if (runtime.assistantId) {agentAvatars.project(runtime, runtime.assistantId, profile.avatarUrl)}
    refreshAgentSoul(runtime, profile.soul, profile.definitionRevision)
  }

  observeAssistantNames()
  agentRoster.request()
  publish(state)
  void syncAgents()
}

/** The chat-view authority is the turn's enrolled host plus the signed-in account
 * generation. The tool payload names neither. Both are re-read after the native
 * owner-token route answers before its bytes may return to Hermes. */
function requestAgentChats(
  agentRuntime: MatrixAgentRuntime,
  identity: NonNullable<MatrixEnrollment['identity']>,
  owner: ReturnType<MatrixAccount['appScope']>,
  payload: unknown,
  signal: AbortSignal
): Promise<string> {
  if (!macSourcesConsentStore().read().teamSpaces) {
    return Promise.resolve('{"error":"disabled"}')
  }

  if (!owner) {
    return Promise.reject(new Error('matrix_agent_chats_unavailable'))
  }

  const binding: MatrixAgentChatsBinding = {
    ...owner,
    agentPrincipal: identity.agentPrincipal,
    executorId: identity.executorId
  }

  return requestBoundMatrixAgentChats({
    account,
    binding,
    payload,
    signal,
    current: () => {
      const scope = account.appScope()
      const enrolled = enrollmentOf(agentRuntime).identity

      return !closing &&
        !agentRuntime.closed &&
        scope &&
        enrolled?.agentPrincipal === binding.agentPrincipal &&
        enrolled.executorId === binding.executorId
        ? { ...scope, agentPrincipal: enrolled.agentPrincipal, executorId: enrolled.executorId }
        : null
    }
  })
}

function localMacSourcesConsentScope() {
  const installation = new MacSourcesConsentStore(outcomeStore, () => null).installationId()
  return macSourceConsentScope(null, false, installation)!
}

function macSourcesConsentScope() {
  return account?.appScope() ?? (config.domain ? null : localMacSourcesConsentScope())
}

function macSourcesConsentStore(): MacSourcesConsentStore {
  return new MacSourcesConsentStore(outcomeStore, macSourcesConsentScope)
}

let folderAccessInstance: MatrixFolderAccess | undefined

/** The owner's shared Mac folders (folder-access.ts); main alone lists them, only on request. */
function matrixFolderAccess(): MatrixFolderAccess {
  folderAccessInstance ??= new MatrixFolderAccess({
    storage: outcomeStore,
    scope: () => account?.appScope() ?? null,
    platform: process.platform,
    home: app.getPath('home'),
    list: directory => readdir(directory),
    exists: file => existsSync(file),
    pick: async () => {
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
      const picked = ui && !ui.isDestroyed() ? await dialog.showOpenDialog(ui, options) : await dialog.showOpenDialog(options)

      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    // Bound to the account an operation started for, never to whichever account is current now.
    policyFile: accountKey => folderAccessPolicyFile(macSourcesPolicyFileFor(accountKey))
  })

  return folderAccessInstance
}

function macSourcesPolicyFile(): string {
  const scope = macSourcesConsentScope()

  if (!scope) {
    throw new Error('matrix_mac_sources_consent_unavailable')
  }

  return macSourcesPolicyFileFor(scope.accountKey)
}

function macSourcesPolicyFileFor(accountKey: string): string {
  return path.join(app.getPath('userData'), 'source-policy', `${accountKey}.json`)
}

/** A launch always carries a fixed path; handlers fail closed if this refresh cannot land. */
function prepareMacSourcesPolicy(): string {
  const file = macSourcesPolicyFile()

  try {
    writeMacSourcesPolicy(file, macSourcesConsentStore().read())
  } catch {
    console.warn('[Matrix] source policy: could not refresh live policy')
  }

  try {
    matrixFolderAccess().writePolicy()
  } catch {
    console.warn('[Matrix] source policy: could not refresh folder choices')

    // Fail closed: without a current folder file the tools can't see a folder the owner closed,
    // so this process gets no Mac folders at all until the next launch writes one.
    try {
      if (matrixFolderAccess().closedFolders().length > 0) {
        writeMacSourcesPolicy(file, { ...macSourcesConsentStore().read(), folders: false })
      }
    } catch {
      console.warn('[Matrix] source policy: could not close Mac folders')
    }
  }

  return file
}

function commitMacSourceConsent(source: Parameters<MacSourcesConsentStore['set']>[0], enabled: boolean) {
  const store = macSourcesConsentStore()
  const next = { ...store.read(), [source]: enabled }

  // Close a live handler gate before persisting an off transition. If the encrypted write
  // then fails, this process remains conservatively off and the renderer receives the failure.
  if (!enabled) {
    writeMacSourcesPolicy(macSourcesPolicyFile(), next)
  }

  const saved = store.set(source, enabled)

  if (enabled) {
    writeMacSourcesPolicy(macSourcesPolicyFile(), saved)
  }

  announceSourceChoicesChanged()

  return saved
}

function commitPendingMacSourceOff(gate: Parameters<MatrixAccountSourceGates['set']>[0]): void {
  const source = gate === 'team_spaces' ? 'teamSpaces' : gate
  commitMacSourceConsent(source, false)
  macSourcesConsentStore().queueNarrow(source)
}

async function setMacSourceConsent(source: Parameters<MacSourcesConsentStore['set']>[0], enabled: boolean) {
  const gate = source === 'teamSpaces' ? 'team_spaces' : source
  if (sourceGateSync) {await sourceGateSync.set(gate, enabled)}
  else if (!enabled) {commitPendingMacSourceOff(gate)}
  else {
    commitMacSourceConsent(source, true)
    macSourcesConsentStore().clearPendingNarrow([source])
  }
  return macSourcesConsentStore().read()
}

function shownOnThisMac(): boolean {
  const store = macSourcesConsentStore()
  return Boolean(store.presentedAt(store.installationId()))
}

function remoteMacSourceReadsEnabled(): boolean {
  return REMOTE_MAC_SOURCE_READS_ENABLED && shownOnThisMac()
}

function currentMacSourceReadiness() {
  return sourceReadiness.snapshot(macSourcesConsentStore().read(), accountSourceFacts().fullDisk,
    remoteMacSourceReadsEnabled(), Date.now(), macLocationAccessStatus())
}

/** The signed CoreLocation helper is not installed; unknown authorization stays closed. */
function macLocationAccessStatus() { return 'not-determined' as const }

/** Account-level source facts for Settings. No assistant or open chat is consulted. */
function accountSourceFacts() {
  const home = app.getPath('home')
  const fullDisk = process.platform === 'darwin'
    ? probeFullDiskAccess({
        messages: path.join(home, 'Library', 'Messages', 'chat.db'),
        safari: path.join(home, 'Library', 'Safari', 'History.db')
      })
    : 'unknown'

  return {
    mac: process.platform === 'darwin',
    fullDisk: fullDisk === 'granted' || fullDisk === 'not-granted' ? fullDisk : 'unknown' as const,
    googleConnected: Object.values(googleConnections?.services() ?? {}).some(Boolean),
    location: macLocationAccessStatus()
  }
}

/** Every open Settings or first-run card re-reads the saved account switches. */
function announceSourceChoicesChanged() {
  if (ui && !ui.isDestroyed()) {
    ui.webContents.send(MATRIX_AGENT_SOURCES_IPC.changed)
  }
}

function macSourcesService(): MacSourcesService {
  const home = app.getPath('home')

  return new MacSourcesService({
    // Read afresh on every call: a source switched off in Settings stops immediately.
    consent: () => macSourcesConsentStore().read(),
    fullDisk: () =>
      probeFullDiskAccess({
        messages: path.join(home, 'Library', 'Messages', 'chat.db'),
        safari: path.join(home, 'Library', 'Safari', 'History.db')
      }),
    messages: {
      databasePath: path.join(home, 'Library', 'Messages', 'chat.db')
    },
    browser: {
      safariPath: path.join(home, 'Library', 'Safari', 'History.db'),
      chromeRoot: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    },
    location: new MacLocationProvider({
      timeZone: currentIanaTimeZone,
      ownerLocation: signal => account.ownerLocation(signal)
      // Precise CoreLocation is intentionally absent until its signed helper ships.
    })
  })
}

/** Mac-local only for this slice: bind the host read to the same account, agent and executor
 * before and after it awaits. Background sweeps will use the service's background posture
 * directly; a live chat/first-learning turn is foreground. */
async function requestAgentMacSources(
  agentRuntime: MatrixAgentRuntime,
  identity: NonNullable<MatrixEnrollment['identity']>,
  owner: ReturnType<MatrixAccount['appScope']>,
  payload: unknown,
  signal: AbortSignal
): Promise<string> {
  if (!owner) {
    throw new Error('matrix_agent_mac_sources_unavailable')
  }

  const binding = {
    ...owner,
    agentPrincipal: identity.agentPrincipal,
    executorId: identity.executorId
  }
  const current = () => {
    signal.throwIfAborted()
    const scope = account.appScope()
    const enrolled = enrollmentOf(agentRuntime).identity

    if (
      closing ||
      agentRuntime.closed ||
      !scope ||
      scope.accountKey !== binding.accountKey ||
      scope.generation !== binding.generation ||
      enrolled?.agentPrincipal !== binding.agentPrincipal ||
      enrolled.executorId !== binding.executorId
    ) {
      throw new Error('matrix_agent_mac_sources_stale')
    }
  }

  current()
  const answer = await macSourcesService().request(payload, { background: false, mayPrompt: true }, signal)
  current()

  return answer
}

/** The same exact account, runtime and enrolled home for starting and displaying a check. */
function agentContentTarget(agentRuntime: MatrixAgentRuntime) {
  return matrixMainAgentContentTarget(
    {
      defaultAgent,
      agents,
      account: () => account,
      runtime: () => runtime,
      closing: () => closing,
      memoryAllowed: agent => agent.role !== MATRIX_GOOGLE_ASSISTANT_ROLE || !googleAssistant.latched(),
      enrollment: enrollmentOf,
      home: agentHermesHome
    },
    agentRuntime
  )
}

/** The agent's declared skills into its Hermes home on this Mac, in the background: what is
 * missing comes from the account; nothing here is replaced (which agents: matrixAgentContentTarget). */
function syncAgentContent(agentRuntime: MatrixAgentRuntime): void {
  agentContent.start(agentContentTarget(agentRuntime))
}

/** Error class and message for the diagnostic log only: long token-like runs are
 * masked and the text is capped, so an unexpected failure is explained without
 * leaking a credential. */
function setupFailureDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error

  return text.replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, '<masked>').slice(0, 240)
}

/** One quiet retry before the person is asked to click. The failure every launch used to hit
 * (the check's Hermes killed with SIGTERM before its port announcement) was the app's own:
 * the agent's host, still connecting, ended the check (matrixTurnsNeedingHost, G1-13). */
async function configureManagedModelWithRetry(
  agentRuntime: MatrixAgentRuntime = defaultAgent
): Promise<MatrixModelCheckOutcome> {
  try {
    return await configureManagedModel(agentRuntime)
  } catch (error) {
    // Waiting for the person, not a flaky start: trying again at once cannot help.
    if (
      !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok ||
      (error instanceof Error && MATRIX_PLAN_SIGN_IN_CODES.has(error.message))
    ) {
      throw error
    }

    console.warn('[Matrix] model check failed once, retrying:', setupFailureDetail(error))
    await new Promise(resolve => setTimeout(resolve, 3_000))

    return configureManagedModel(agentRuntime)
  }
}

// Like the old app, which starts its Hermes backend with the window: once the
// assistant is ready its Hermes starts and stays running, so a first message
// waits only for the model. A turn that fails retires the process for safety; it
// is started again in the background instead of on the next message.
let startingHermes: Promise<boolean> | undefined

/** The agent's own room with its owner: where its scheduled jobs post (D7, one room per
 * agent). The marked main wins; legacy rooms retain their stable lowest-ID order. */
function assistantHomeRoom(agentRuntime: MatrixAgentRuntime = defaultAgent): string | undefined {
  let owner: string | undefined
  let agent: string | undefined

  // Signed out, signing out or without the domain grant, the account read throws. There is
  // no room then, and publish, which reaches this, must never throw.
  try {
    owner = account?.identity()?.userId
    agent = enrollmentOf(agentRuntime).identity?.userId
  } catch {
    return undefined
  }

  const pending = pendingConversationHome(agentRuntime)

  return AGENT_ONE_CONVERSATION && pending ? pending : matrixAgentHomeRoom(state.rooms, owner, agent)
}

/**
 * The main this Mac's own conversation move just finished, while this Mac's synced view of the
 * markers is still the one it finished against (the projection has not caught up). Once that view
 * changes, the markers decide again and the override is dropped.
 */
function pendingConversationHome(agentRuntime: MatrixAgentRuntime): string | undefined {
  const override = conversationHomes.get(agentRuntime)

  const pendingProjection =
    override?.scope === petScopeToken() && override.revision === conversationProjectionRevision(agentRuntime)

  if (override && !pendingProjection) {
    conversationHomes.delete(agentRuntime)
  }

  return pendingProjection ? override.main : undefined
}

/** Whether this Mac runs the agent's scheduled jobs. The Mac that is always on does; a
 * second Mac is switched off (`matrix-run-jobs` = '0') so no job runs twice. */
const MATRIX_RUN_JOBS_KEY = 'matrix-run-jobs'

function runsJobsHere(): boolean {
  try {
    return outcomeStore.getItem(MATRIX_RUN_JOBS_KEY) !== '0'
  } catch {
    return true
  }
}

/** What this Mac does for one agent's scheduled work: the placement decides (cloud-agent-placement.ts). */
function agentJobsPlan(agentRuntime: MatrixAgentRuntime): MatrixAgentJobsPlan {
  const cloudRoute = isCloudAgent(agentRuntime)

  return matrixAgentJobsPlan({
    cloudRoute,
    role: cloudRoute ? cloudAgentMacRole(agentRuntime) : undefined,
    runsJobsHere: runsJobsHere()
  })
}

let cronHolds: MatrixCronHolds | undefined

/** The hold markers sit beside the app's device state, outside every agent's Hermes home. */
function cronHoldStore(): MatrixCronHolds {
  return (cronHolds ??= new MatrixCronHolds(path.join(app.getPath('userData'), 'device', 'cron-holds')))
}

/** Whether D1 manages the agent on this Mac; an unreadable journal holds (it might be). */
function macJobsPlaced(agent: MatrixAgentRuntime): boolean {
  const principal = cloudPrincipal(agent)

  try {
    return Boolean(principal && agentHome?.controller.ctx.journal.read(principal).managed)
  } catch {
    return true
  }
}

/** One scheduler lifetime per backend; replacing authority cancels before async work. */
const macJobPreparations = new WeakMap<MatrixAgentRuntime, symbol>()
const macJobs = new Map<MatrixAgentRuntime, { lifecycle: MacJobLifecycle; authority: string }>()

function reconcileMacJobs(agent: MatrixAgentRuntime, force = false): void {
  const entry = macJobs.get(agent)

  if (!entry) {return}
  const principal = cloudPrincipal(agent)
  const facts = principal ? agentHome?.controller.ctx.runtime.leaseFacts(principal) : null

  const authority = !closing && !agent.closed && !isMovingAgent(agent) && facts
    ? `${facts.leaseId}:${facts.executorTerm}` : ''

  if (!force && entry.authority === authority) {return}
  entry.authority = authority
  entry.lifecycle.stop()

  // Close the ticker gate synchronously before any snapshot or cancelled-run cleanup.
  applyJobsHold(agent)
  refreshCronTicker(agent)

  if (authority) {
    void entry.lifecycle.refresh().catch(() => {
      // Permit the next normal reconcile to retry a failed snapshot on the same lease.
      if (entry.authority === authority && !entry.lifecycle.tickerPrepared) {entry.authority = ''}
      console.warn('[Matrix] managed jobs reconciliation deferred')
    }).finally(() => {
      if (macJobs.get(agent) !== entry) {return}
      applyJobsHold(agent)
      refreshCronTicker(agent)
    })
  }
}

async function prepareMacJobs(agent: MatrixAgentRuntime, signal: AbortSignal, selectedRuntime: MatrixHermesRuntimeConfig, input: { owner: string; executorId: string }): Promise<void> {
  const preparation = Symbol()
  macJobPreparations.set(agent, preparation)
  const previous = macJobs.get(agent)?.lifecycle
  previous?.stop()
  await previous?.drained()
  signal.throwIfAborted()
  if (macJobPreparations.get(agent) !== preparation) {throw new Error('mac_job_start_superseded')}
  macJobs.delete(agent)
  const context = agentHome?.controller.ctx
  const principal = cloudPrincipal(agent)

  if (!context || !principal || !agent.assistantId) {return}

  const lifecycle = new MacJobLifecycle({
    context, principal, assistantId: agent.assistantId, agentKey: agent.role,
    holds: cronHoldStore(), request: (send, signal) => account.s1Request(send, signal),
    run: async (_selection, client, runSignal) => {
      if (!agent.cron || !managedModel) {throw new Error('mac_job_runtime_unavailable')}
      await runMacJobs({ runtime: selectedRuntime, ...input, assistantId: agent.assistantId!, principal,
        home: agentHermesHome(agent, { principal: input.owner, executorId: input.executorId }, selectedRuntime),
        room: () => assistantHomeRoom(agent), baseUrl: managedModel.baseUrl, client, delivery: agent.cron, signal: runSignal,
        log: line => console.warn(line),
        transport: { auth: context.auth, request: (send, signal) => account.s1Request(send, signal),
          authority: (_assistant, signal) => macJobAuthority(context, principal, signal) } })
    }
  })

  const entry = { lifecycle, authority: '' }
  macJobs.set(agent, entry)
  signal.addEventListener('abort', () => {
    lifecycle.stop()

    if (macJobs.get(agent) === entry) {macJobs.delete(agent)}
  }, { once: true })
  signal.throwIfAborted()
  await lifecycle.refresh().catch(error => {
    if (!(error instanceof MacJobTransportError)) {throw error}
    console.warn('[Matrix] managed jobs snapshot deferred')
  })
}

/** Holds or lifts one agent's running cron ticker as its placement changes (a lease taken, lost or
 * handed back; a policy edited; the roster moving it). No restart: the backend's ticker reads the
 * marker on every tick, so a Mac that takes the term fires from its next tick on. A hold that cannot
 * be written leaves the running ticker un-held, which must never run: the backend is restarted
 * with its ticker off instead (refreshCronTicker), so every failure holds. */
function reconcileJobsHold(agentRuntime: MatrixAgentRuntime): void {
  reconcileMacJobs(agentRuntime)
  applyJobsHold(agentRuntime)
  refreshCronTicker(agentRuntime)
}

/** The marker follows the plan now; whether the running ticker is left un-held, or a backend that
 * should be firing has no ticker at all, is remembered. */
function applyJobsHold(agentRuntime: MatrixAgentRuntime): void {
  const plan = macJobsTickerPlan(agentJobsPlan(agentRuntime), macJobs.get(agentRuntime)?.lifecycle, macJobsPlaced(agentRuntime))
  const running = agentRuntime.cronTickerRunning

  agentRuntime.cronTickerUnheld = reconcileMatrixJobsHold(cronHoldStore(), agentRuntime.role, plan, running).unheld
  agentRuntime.cronTickerMissing = matrixJobsTickerMissing(plan, running)
}

/** Puts a backend's cron ticker right, by restarting that backend (Hermes starts its ticker once, at
 * launch). Retried at every publish while a reply or a start in progress holds it back.
 * - An un-held ticker (reconcileJobsHold): the restart's launch applies the hold again and starts
 *   without the ticker if it still cannot be written. Urgent, so it waits only for what must not be
 *   cut (matrixUnheldTickerRestartable).
 * - A backend that launched without a ticker (its hold could not be written then) on a Mac that now
 *   answers: the agent's jobs would fire nowhere, so it restarts with the ticker on. Not urgent, so
 *   it waits for an idle backend like any optional restart (matrixMissingTickerRestartable). */
function refreshCronTicker(agentRuntime: MatrixAgentRuntime): void {
  if (matrixUnheldTickerRestartable(agentRuntime, { closing })) {
    agentRuntime.cronTickerUnheld = false
    console.warn('[Matrix] cron hold not written: restarting Hermes with its ticker off')
    void stopHermesExecutor(agentRuntime).then(() => startAssistantHermes(agentRuntime))

    return
  }

  if (
    conversationPending(agentRuntime) ||
    !matrixMissingTickerRestartable(agentRuntime, { busy: Boolean(operation || domainOperation), closing }) ||
    !readMatrixAgentPresentation(
      Boolean(account?.appScope()),
      () => matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok
    )
  ) {
    return
  }

  agentRuntime.cronTickerMissing = false
  console.warn('[Matrix] this Mac answers and its backend has no cron ticker: restarting Hermes with it on')
  void stopHermesExecutor(agentRuntime).then(() => startAssistantHermes(agentRuntime))
}

/**
 * Whether this launch keeps the ChatGPT plan sign-in where 0.18.2 did (codex-accounts.ts): a
 * Mac that has held one Atum account. Recording the signed-in account comes first, so a second
 * account splits both from its first launch. Unsure (no account read, a folder it cannot
 * read): kept apart.
 */
function sharedCodexHere(): boolean {
  return matrixSharedCodexHere(app.getPath('userData'), () => account?.appScope()?.accountKey)
}

/** The assistant's Hermes backend: its home room for scheduled posts, and the app
 * answering those posts on its connection. */
async function openAssistantHermes(
  selectedRuntime: MatrixHermesRuntimeConfig,
  input: { owner: string; executorId: string },
  signal: AbortSignal,
  agentRuntime: MatrixAgentRuntime = defaultAgent
): Promise<MatrixHermesConnection> {
  // Legacy cloud-only agents have no Hermes here. H-F can run Hermes under a local lease, while
  // scheduled jobs remain cloud-owned.
  if (
    lifecycle.blocksRuntime(agentRuntime.principal) ||
    isCloudOnlyAgent(agentRuntime) ||
    isMovingAgent(agentRuntime)
  ) {
    throw new Error('matrix_agent_unavailable')
  }

  const homeRoom = assistantHomeRoom(agentRuntime)
  // Google tools and the Google fence are decided once per launch (main-google.ts).
  const google = await googleAssistant.launch(agentRuntime.role, signal)
  const sourcePolicy = prepareMacSourcesPolicy()

  if (isMatrixGoogleAgentRole(agentRuntime.role)) {
    googleLaunched.set(agentRuntime.role, { tools: google.tools, fence: google.fence })
  }

  // What this Mac does for the agent's scheduled work follows its placement (the saved policy and
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // whose cloud is off and whom this Mac answers. The ticker is held, not left off, while another
  // destination holds the term, so it fires from the first tick after this Mac takes it over.
  const jobs = agentJobsPlan(agentRuntime)
  const holds = cronHoldStore()
  // A hold that could not be written never runs the ticker: it would fire on a Mac that must not.
  // Never lift a previous hold before signed selection/inventory preparation.
  holds.hold(agentRuntime.role)

  await prepareMacJobs(agentRuntime, signal, selectedRuntime, input)
  signal.throwIfAborted()
  const tickerMayRun = applyMatrixJobsHold(holds, agentRuntime.role,
    macJobsTickerPlan(agentJobsPlan(agentRuntime), macJobs.get(agentRuntime)?.lifecycle, macJobsPlaced(agentRuntime)))

  const connection = await openMatrixHermes(selectedRuntime, {
    owner: input.owner,
    executorId: input.executorId,
    signal,
    homeRoom,
    runJobs: jobs.tick && tickerMayRun,
    cronHold: holds.path(agentRuntime.role),
    home: agentHermesHome(agentRuntime, { principal: input.owner, executorId: input.executorId }, selectedRuntime),
    google: google.env,
    sourcePolicy,
    sharedCodex: sharedCodexHere(),
    atumInstructions: atumInstructionsForMacHome(agentRuntime)
  })

  const managedLifecycle = macJobs.get(agentRuntime)?.lifecycle
  connection.signal.addEventListener('abort', () => managedLifecycle?.stop(), { once: true })
  agentRuntime.homeRoom = homeRoom
  agentRuntime.cronTicker = jobs.tick && tickerMayRun ? connection.signal : undefined
  agentRuntime.cronTickerUnheld = false
  agentRuntime.cronTickerMissing = false
  // The plan may have changed while this backend was opening; a hold that fails now finds its ticker.
  // The restart itself waits for this start to end (the next publish or policy reconcile).
  applyJobsHold(agentRuntime)
  agentRuntime.cronListening?.()
  agentRuntime.cronListening = jobs.attach ? agentRuntime.cron?.listen(connection.gateway) : undefined
  agentRuntime.storeGateway = connection.gateway
  connection.signal.addEventListener(
    'abort',
    () => {
      if (agentRuntime.storeGateway === connection.gateway) {
        agentRuntime.storeGateway = undefined
      }
    },
    { once: true }
  )
  // A paid hire's optional skills go in before this backend serves its first turn, so no
  // conversation's cached prompt changes under it; its jobs follow without holding it up.
  await prepareStoreHire(agentRuntime)

  if (jobs.attach) {
    reconcileStoreJobs(agentRuntime, true)
  }

  // Only the default assistant checks in; any other agent's backend is always declined.
  agentRuntime.checkInListening?.()
  agentRuntime.checkInListening =
    agentRuntime === defaultAgent && checkIns && jobs.attach
      ? checkIns.listen(connection.gateway)
      : refuseMatrixCheckIns(connection.gateway)

  if (agentRuntime === defaultAgent && jobs.attach) {
    checkInGateway = connection.gateway
    connection.signal.addEventListener(
      'abort',
      () => {
        if (checkInGateway === connection.gateway) {
          checkInGateway = undefined
        }
      },
      { once: true }
    )
    ensureCheckInJob()
  }

  return connection
}

/**
 * The default assistant's one check-in job (cron/check_ins.py), on this Mac's backend. The
 * Settings switch is the one control: while check-ins are on (an account that never chose
 * has them), every Mac keeps the job, and one that went missing comes back. `on`: the
 * owner has just turned them on, ahead of sync.
 */
function ensureCheckInJob(on = false) {
  if (!on && state.checkIns?.settings.enabled === false) {
    return
  }

  void checkInGateway
    ?.request<{ state?: unknown }>('heartbeat.ensure', { force: true }, 15_000)
    .then(result => {
      if (result?.state === 'created') {
        console.warn('[Matrix] check-ins job added')
      }
    })
    .catch(() => console.warn('[Matrix] check-ins job not added'))
}

/**
 * An agent's answering lease for background work: a check-in's claim (check-ins.ts, the
 * default assistant), or a paid assistant's scheduled run (store-schedules.ts). Already held
 * here, taken on demand when no Mac holds it (as a typed message does), or none while
 * another Mac answers for the agent. Released when the work is done with it.
 */
async function holdAgentLease(
  agent: MatrixAgentRuntime,
  waitMs = 8_000
): Promise<(MatrixCheckInLeaseHold & { leaseToken?: string }) | null> {
  const executorId = enrollmentOf(agent).identity?.executorId

  if (
    !executorId ||
    !agent.lease ||
    closing ||
    agent.closed ||
    ['elsewhere', 'yielding'].includes(agent.lease.current.state)
  ) {
    return null
  }

  agent.backgroundDemand += 1
  let released = false

  const release = () => {
    if (!released) {
      released = true
      agent.backgroundDemand = Math.max(0, agent.backgroundDemand - 1)
      reconcileLease(agent)
      scheduleExecutionPolicyReconcile()
    }
  }

  reconcileLease(agent)

  if (!agent.lease.held(executorId)) {
    await waitUntil(
      () =>
        Boolean(agent.lease?.held(executorId)) ||
        ['elsewhere', 'yielding', 'unavailable', 'stopped'].includes(agent.lease?.current.state ?? 'stopped'),
      waitMs,
      new AbortController().signal
    )
  }

  const session = agent.lease?.held(executorId)

  if (!session) {
    release()

    return null
  }

  return {
    leaseToken: session.leaseToken,
    held: () => !session.signal.aborted && Boolean(agent.lease?.held(executorId)),
    release
  }
}

/** The default assistant's lease for a check-in's claim, released once the claim is written. */
function holdCheckInLease(): Promise<MatrixCheckInLeaseHold | null> {
  return holdAgentLease(defaultAgent)
}

const AGENT_SWEEP_SIGNED_ACTION = MATRIX_BACKGROUND_SWEEP_SIGNATURE_ACTION as HomeSignedAction

function backgroundSweepRuntime(candidate: BackgroundSweepCandidate): MatrixAgentRuntime | undefined {
  return allAgents().find(
    each =>
      !each.closed &&
      each.assistantId === candidate.assistantId &&
      cloudPrincipal(each) === candidate.agentPrincipal &&
      assistantHomeRoom(each) === candidate.roomId
  )
}

function backgroundSweepCurrent(candidate: BackgroundSweepCandidate): boolean {
  return account.identity()?.userId === candidate.ownerPrincipal && Boolean(backgroundSweepRuntime(candidate))
}

async function backgroundSweepContinuity(
  candidate: BackgroundSweepCandidate
): Promise<{ read: MatrixContinuityRead; at: number }> {
  const runtime = backgroundSweepRuntime(candidate)
  const human = hosts.get('human')
  const agent = runtime && hosts.get(runtime.role)
  const owner = account.identity()

  if (!runtime || !human || !agent || !owner || !runtime.userId || !human.ready || !agent.ready) {
    throw new Error('matrix_background_sweep_unavailable')
  }

  const scope: MatrixContinuityTarget = {
    roomId: candidate.roomId,
    ownerId: owner.userId,
    agentId: runtime.userId,
    bounded: true
  }
  const value = await human.queue.command({ kind: 'readContinuity', ...scope }, MATRIX_CONTINUITY.deadlineMs + 1_000)
  const read = readContinuityResult(value, scope)
  const room = state.rooms.find(each => each.id === candidate.roomId)
  const at = room?.preview?.at ?? room?.lastActiveAt

  if (!read || read.uncertainAgent || !Number.isSafeInteger(at)) {
    throw new Error('matrix_background_sweep_unavailable')
  }

  return { read, at: Number(at) }
}

async function backgroundSweepActivity(candidate: BackgroundSweepCandidate) {
  const runtime = backgroundSweepRuntime(candidate)

  if (!runtime || isCloudOnlyAgent(runtime) || isMovingAgent(runtime)) {
    return null
  }

  const { read, at } = await backgroundSweepContinuity(candidate)

  return {
    lastOwnerEvent: backgroundSweepOwnerEvent(read.entries, at),
    lastDialogueAt: at,
    busy: Boolean(runtime.invocation || runtime.localTurns?.executionPending || runtime.lock.holder),
    pendingWork: Boolean(runtime.operation || runtime.lock.waiting || conversationPending(runtime)),
    pendingApproval: Boolean(runtime.invocation?.prompts?.snapshot().length),
    typing: false
  }
}

async function backgroundSweepMemorySource(
  candidate: BackgroundSweepCandidate,
  sourceIntervalMs: number,
  warmup: boolean,
  includeMacFiles: boolean
): Promise<BackgroundSweepSourceRead> {
  const agent = backgroundSweepRuntime(candidate)
  const enrolled = agent && enrollmentOf(agent).identity
  const selectedRuntime = runtime

  if (!agent || !enrolled || !selectedRuntime) {
    return { status: 'unavailable' }
  }

  const home = agentHermesHome(agent, enrolled, selectedRuntime)
  const parts: string[] = []
  let observedAt = 0

  for (const name of ['SOUL.md', 'USER.md', 'MEMORY.md']) {
    try {
      const file = path.join(home, name)
      if (!existsSync(file) || !statSync(file).isFile()) {
        continue
      }
      observedAt = Math.max(observedAt, Math.trunc(statSync(file).mtimeMs))
      const text = readFileSync(file, 'utf8').trim()
      if (text) {
        parts.push(`${name}\n${text}`)
      }
    } catch {
      return { status: 'failed' }
    }
  }

  const capturedAt = Date.now()
  // Background work never probes protected Desktop/Documents/Downloads: even testing access can
  // raise a macOS prompt. Atum Drive is app-created and already background-safe.
  const macFiles = includeMacFiles && process.platform === 'darwin'
    ? await recentMacFileNames({
        roots: [path.join(app.getPath('home'), 'Atum', 'Drive')],
        since: capturedAt - 30 * 24 * 60 * 60_000,
        limit: 2
      })
    : []
  const fileEntries = macFiles.map(file => backgroundSweepMacFileEvidence(
    file,
    !warmup && file.modifiedAt >= capturedAt - sourceIntervalMs
  ))

  if (!parts.length) {
    return { status: 'not_configured', entries: fileEntries }
  }

  const revision = createHash('sha256').update(parts.join('\n\0')).digest('hex')
  const cursor = sweepWatermark(capturedAt, [revision])
  const entries = [backgroundSweepMemoryEvidence(candidate.agentPrincipal, parts.join('\n\n'), observedAt), ...fileEntries]

  return {
    status: 'ok',
    cursor,
    entryCursors: entries.map(() => cursor),
    entries
  }
}

async function backgroundSweepConversationSource(
  candidate: BackgroundSweepCandidate,
  sourceIntervalMs: number,
  prior: string | undefined
): Promise<BackgroundSweepSourceRead> {
  const { read, at } = await backgroundSweepContinuity(candidate)
  const visible = read.entries.slice(0, 20)
  const ownerEvent = backgroundSweepOwnerEvent(visible, at)
  const entries = ownerEvent
    ? [
        backgroundSweepConversationEvidence(
          candidate.roomId,
          ownerEvent,
          sourceIntervalMs,
          visible
            .slice()
            .reverse()
            .map(entry => `${entry.role}: ${entry.text}`)
            .join('\n')
        )
      ]
    : []

  return {
    status: 'ok',
    ...(ownerEvent ? { cursor: sweepWatermark(ownerEvent.at, [ownerEvent.eventId]) } : prior ? { cursor: prior } : {}),
    entries
  }
}

async function backgroundSweepChatsSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  signal: AbortSignal,
  warmup = false
): Promise<BackgroundSweepSourceRead> {
  const agent = backgroundSweepRuntime(candidate)
  const identity = agent && enrollmentOf(agent).identity
  const owner = account.appScope()

  if (!agent || !identity || !owner) {
    return { status: 'unavailable' }
  }
  const now = Date.now()
  const priorCarry = sweepWatermarkCarry(prior)
  const priorAt = sweepWatermarkAt(prior, now - 24 * 60 * 60_000)
  // A warm-up nudge reads recent rooms, not only unread ones; an already-read message can still be
  // the most useful detail when the agent is building its first picture of the owner's work.
  const sinceMs = warmup ? now - 7 * 24 * 60 * 60_000
    : priorCarry.size > 0
      ? now - 48 * 60 * 60_000
      : Math.max(now - 48 * 60 * 60_000, priorAt - 2 * 60 * 60_000)
  const listed = JSON.parse(
    await requestAgentChats(
      agent,
      identity,
      owner,
      {
        op: 'list',
        unreadOnly: !warmup,
        sinceMs,
        limit: 20
      },
      signal
    )
  ) as { rooms?: unknown }

  if (!Array.isArray(listed.rooms)) {
    return { status: 'failed' }
  }
  const entries: FollowupSweepEvidenceInput[] = []
  const included = new Set<string>()
  const selection = selectBackgroundSweepChats(listed.rooms, prior ?? null, now, warmup)

  for (const pending of selection.candidates) {
    const detail = JSON.parse(
      await requestAgentChats(
        agent,
        identity,
        owner,
        {
          op: 'read',
          id: pending.id,
          limit: 20
        },
        signal
      )
    ) as { messages?: unknown }
    const messages = Array.isArray(detail.messages) ? (detail.messages as Array<Record<string, unknown>>) : []
    const message = messages.find(each => each.mine === false && typeof each.text === 'string')
    const observedAt = message && (Number(message.at) || now)

    if (!message || !Number.isSafeInteger(observedAt)) {
      continue
    }

    included.add(pending.key)
    entries.push(
      backgroundSweepChatEvidence(
        pending.id,
        {
          eventId: typeof message.eventId === 'string' ? message.eventId : pending.anchorId,
          at: observedAt!,
          text: String(message.text)
        },
        typeof pending.room.label === 'string' ? pending.room.label : undefined
      )
    )
  }

  const cursor = selection.watermark(included)

  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

function googleSourceStatus(error: string): BackgroundSweepSourceRead['status'] {
  return ['not_connected', 'unavailable'].includes(error)
    ? 'not_configured'
    : error === 'not_allowed'
      ? 'not_authorized'
      : 'failed'
}

async function backgroundSweepGoogleSource(
  candidate: BackgroundSweepCandidate,
  source: 'google_mail' | 'google_calendar',
  prior: string | undefined,
  ownerTimeZone: string,
  signal: AbortSignal,
  warmup = false,
  includeDrive = false
): Promise<BackgroundSweepSourceRead> {
  const agent = backgroundSweepRuntime(candidate)

  if (agent !== defaultAgent || !googleConnections?.configured) {
    return { status: 'not_configured' }
  }
  const gate = googleAssistant.gate(agent.role)
  if (gate !== 'ok') {
    return { status: gate === 'not_available' ? 'not_configured' : 'not_authorized' }
  }
  signal.throwIfAborted()
  const now = Date.now()
  const priorCarry = sweepWatermarkCarry(prior ?? null)
  const priorAt = sweepWatermarkAt(prior ?? null, now - 24 * 60 * 60_000)
  const sinceMs = priorCarry.size > 0
    ? now - 48 * 60 * 60_000
    : Math.max(now - 48 * 60 * 60_000, priorAt - 2 * 60 * 60_000)
  const request =
    source === 'google_mail'
      ? { action: 'search_mail' as const, query: `is:unread -from:me after:${Math.floor(sinceMs / 1_000)}` }
      : { action: 'agenda' as const, when: 'today_and_tomorrow' as const }
  const utility = matrixGoogleUtilityInput(request, new Date(now))
  const outcome = 'read' in utility ? await googleConnections.toolRead(utility.read) : null
  signal.throwIfAborted()

  if (!outcome) {
    return { status: 'unavailable' }
  }
  if (outcome.ok === false) {
    return { status: googleSourceStatus(outcome.error) }
  }
  const result = matrixGoogleToolResult(request, outcome.value) as Record<string, unknown>
  if (typeof result.error === 'string') {
    return { status: googleSourceStatus(result.error) }
  }
  const entries: FollowupSweepEvidenceInput[] = []
  let watermark: string

  if (source === 'google_mail') {
    const selection = selectBackgroundSweepMail(
      Array.isArray(result.messages) ? result.messages : [],
      prior ?? null,
      now
    )

    for (const { message, observedAt } of selection.entries) {
      entries.push(backgroundSweepMailEvidence(message, observedAt))
    }
    watermark = selection.watermark
    // Warm-up only: a category pass adds durable context (what the owner buys, subscribes to, or
    // ignores) as non-fresh evidence. It never advances the unread frontier, so the next normal
    // sweep still sees the same unread mail it would have seen without this pass.
    if (warmup) {
      const categoryRequest = { action: 'search_mail' as const,
        query: '-from:me newer_than:90d (category:updates OR category:promotions OR category:social)' }
      const categoryUtility = matrixGoogleUtilityInput(categoryRequest, new Date(now))
      const categoryOutcome = 'read' in categoryUtility
        ? await googleConnections.toolRead(categoryUtility.read).catch(() => null)
        : null
      signal.throwIfAborted()

      if (categoryOutcome && categoryOutcome.ok !== false) {
        const category = matrixGoogleToolResult(categoryRequest, categoryOutcome.value) as Record<string, unknown>
        const seen = new Set(entries.map(entry => entry.anchorId))
        const messages = (Array.isArray(category.messages) ? category.messages : [])
          .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object' &&
            !Array.isArray(message) && typeof message.messageId === 'string')
          .slice(0, 3)

        for (const message of messages) {
          if (seen.has(String(message.messageId))) {
            continue
          }
          entries.push({ ...backgroundSweepMailEvidence({
            messageId: String(message.messageId),
            ...(typeof message.threadId === 'string' ? { threadId: message.threadId } : {}),
            ...(typeof message.sourceId === 'string' ? { sourceId: message.sourceId } : {}),
            ...(typeof message.date === 'string' ? { date: message.date } : {}),
            ...(typeof message.subject === 'string' ? { subject: message.subject } : {}),
            ...(typeof message.snippet === 'string' ? { snippet: message.snippet } : {})
          }, Date.parse(String(message.date ?? '')) || now), fresh: false })
        }
      }
    }
  } else {
    const events = (Array.isArray(result.events) ? (result.events as Array<Record<string, unknown>>) : [])
      .map(event => ({ event, start: Date.parse(String(event.start ?? '')) }))
      .filter(({ event, start }) => Number.isFinite(start) && typeof event.eventId === 'string')
      .slice(0, 20)
      .map(({ event, start }) => {
        const revision = `calendar:${String(event.eventId)}:${String(event.start ?? '')}`
        return { event, start, revision, key: sweepCarryKey(revision) }
      })
    const driveFiles = new Map<string, Record<string, unknown>>()

    for (const sort of includeDrive ? ['modified', 'viewed'] as const : []) {
      const driveRequest = { action: 'search_drive' as const, sort }
      const driveUtility = matrixGoogleUtilityInput(driveRequest, new Date(now))
      const driveOutcome = 'read' in driveUtility
        ? await googleConnections.toolRead(driveUtility.read).catch(() => null)
        : null
      signal.throwIfAborted()

      if (driveOutcome && driveOutcome.ok !== false) {
        const drive = matrixGoogleToolResult(driveRequest, driveOutcome.value) as Record<string, unknown>
        for (const file of (Array.isArray(drive.files) ? drive.files : []).filter(
          (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).fileId === 'string'
        )) {
          driveFiles.set(String(file.fileId), { ...(driveFiles.get(String(file.fileId)) ?? {}), ...file })
        }
      }
    }

    const files = [...driveFiles.values()].flatMap(file => {
      const modifiedAt = typeof file.modified === 'string' ? file.modified : undefined
      const viewedAt = typeof file.viewed === 'string' ? file.viewed : undefined
      const revision = `drive:${String(file.fileId)}:${modifiedAt ?? ''}:${viewedAt ?? ''}`
      const evidence = backgroundSweepDriveEvidence({
        fileId: String(file.fileId),
        ...(typeof file.sourceId === 'string' ? { sourceId: file.sourceId } : {}),
        ...(typeof file.name === 'string' ? { name: file.name } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
        ...(viewedAt ? { viewedAt } : {})
      }, true)
      return evidence ? [{ evidence, revision, key: sweepCarryKey(revision) }] : []
    })
    const revisions = [...events.map(candidate => candidate.revision), ...files.map(candidate => candidate.revision)]
    const changed = prior === undefined || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
    const calendarPending = events
      .filter(candidate => changed || priorCarry.has(candidate.key))
      .sort((left, right) => Number(priorCarry.has(right.key)) - Number(priorCarry.has(left.key)) || left.start - right.start)
    const drivePending = files
      .filter(candidate => changed || priorCarry.has(candidate.key))
      .sort((left, right) => Number(priorCarry.has(right.key)) - Number(priorCarry.has(left.key)) ||
        right.evidence.observedAt - left.evidence.observedAt)
    const included = new Set<string>()
    const inside = followupSweepInsideNormalWindow(now, ownerTimeZone)

    for (const candidate of calendarPending.slice(0, 3)) {
      included.add(candidate.key)
      entries.push(backgroundSweepCalendarEvidence({
        eventId: String(candidate.event.eventId),
        ...(typeof candidate.event.sourceId === 'string' ? { sourceId: candidate.event.sourceId } : {}),
        start: candidate.start,
        startText: String(candidate.event.start ?? ''),
        ...(typeof candidate.event.title === 'string' ? { title: candidate.event.title } : {}),
        ...(typeof candidate.event.location === 'string' ? { location: candidate.event.location } : {}),
        ...(typeof candidate.event.notes === 'string' ? { notes: candidate.event.notes } : {})
      }, now, inside))
    }
    for (const candidate of drivePending.slice(0, 2)) {
      included.add(candidate.key)
      entries.push(candidate.evidence)
    }

    if (warmup) {
      const historyRequest = { action: 'agenda' as const, when: 'past_30d' as const }
      const historyUtility = matrixGoogleUtilityInput(historyRequest, new Date(now))
      const historyOutcome = 'read' in historyUtility
        ? await googleConnections.toolRead(historyUtility.read).catch(() => null)
        : null
      signal.throwIfAborted()
      if (historyOutcome && historyOutcome.ok !== false) {
        const history = matrixGoogleToolResult(historyRequest, historyOutcome.value) as Record<string, unknown>
        const currentIds = new Set(events.map(candidate => String(candidate.event.eventId)))
        for (const event of (Array.isArray(history.events) ? history.events : []).filter(
          (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
            typeof (value as Record<string, unknown>).eventId === 'string'
        )) {
          if (currentIds.has(String(event.eventId)) || entries.filter(entry => entry.source === 'google_calendar').length >= 5) {
            continue
          }
          const start = Date.parse(String(event.start ?? ''))
          if (!Number.isFinite(start)) {
            continue
          }
          entries.push({ ...backgroundSweepCalendarEvidence({
            eventId: String(event.eventId),
            ...(typeof event.sourceId === 'string' ? { sourceId: event.sourceId } : {}),
            start,
            startText: String(event.start ?? ''),
            ...(typeof event.title === 'string' ? { title: event.title } : {}),
            ...(typeof event.location === 'string' ? { location: event.location } : {}),
            ...(typeof event.notes === 'string' ? { notes: event.notes } : {})
          }, now, inside), fresh: false })
        }
      }
    }

    const carry = [...new Set([...priorCarry, ...events.map(candidate => candidate.key), ...files.map(candidate => candidate.key)])]
      .filter(key => !included.has(key))
      .slice(0, 20)
    // The frozen wire has one Google-calendar frontier. It tracks the bounded calendar+Drive
    // planning bundle so Mac and cloud homes make the same fresh/unchanged decision.
    watermark = sweepWatermark(now, revisions, carry)
  }

  return { status: 'ok', cursor: watermark, entryCursors: entries.map(() => watermark), entries }
}

async function backgroundSweepGoogleDriveSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  signal: AbortSignal
): Promise<BackgroundSweepSourceRead> {
  const agent = backgroundSweepRuntime(candidate)
  if (agent !== defaultAgent || !googleConnections?.configured) {
    return { status: 'not_configured' }
  }
  const gate = googleAssistant.gate(agent.role)
  if (gate !== 'ok') {
    return { status: gate === 'not_available' ? 'not_configured' : 'not_authorized' }
  }

  const now = Date.now()
  const files = new Map<string, Record<string, unknown>>()
  for (const sort of ['modified', 'viewed'] as const) {
    const request = { action: 'search_drive' as const, sort }
    const utility = matrixGoogleUtilityInput(request, new Date(now))
    const outcome = 'read' in utility ? await googleConnections.toolRead(utility.read).catch(() => null) : null
    signal.throwIfAborted()
    if (!outcome) {
      return { status: 'unavailable' }
    }
    if (outcome.ok === false) {
      return { status: googleSourceStatus(outcome.error) }
    }
    const result = matrixGoogleToolResult(request, outcome.value) as Record<string, unknown>
    if (typeof result.error === 'string') {
      return { status: googleSourceStatus(result.error) }
    }
    for (const file of (Array.isArray(result.files) ? result.files : []).filter(
      (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' &&
        !Array.isArray(value) && typeof (value as Record<string, unknown>).fileId === 'string'
    )) {
      files.set(String(file.fileId), { ...(files.get(String(file.fileId)) ?? {}), ...file })
    }
  }

  const candidates = [...files.values()].flatMap(file => {
    const evidence = backgroundSweepDriveEvidence({ fileId: String(file.fileId),
      ...(typeof file.sourceId === 'string' ? { sourceId: file.sourceId } : {}),
      ...(typeof file.name === 'string' ? { name: file.name } : {}),
      ...(typeof file.modified === 'string' ? { modifiedAt: file.modified } : {}),
      ...(typeof file.viewed === 'string' ? { viewedAt: file.viewed } : {}) }, true)
    return evidence ? [{ evidence, revision: evidence.anchorId }] : []
  }).sort((left, right) => right.evidence.observedAt - left.evidence.observedAt)
  const revisions = candidates.map(candidate_ => candidate_.revision)
  const changed = prior === undefined || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const entries = candidates.slice(0, 2).map(candidate_ => ({ ...candidate_.evidence, fresh: changed }))
  const cursor = sweepWatermark(now, revisions)

  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

async function backgroundSweepScopedRoomSource(
  candidate: BackgroundSweepCandidate,
  roomId: string,
  prior: string | undefined,
  signal: AbortSignal
): Promise<BackgroundSweepSourceRead> {
  const agent = backgroundSweepRuntime(candidate)
  const identity = agent && enrollmentOf(agent).identity
  const owner = account.appScope()
  if (!agent || !identity || !owner || !roomId.startsWith('!')) {
    return { status: 'unavailable' }
  }
  const value = JSON.parse(
    await requestAgentChats(agent, identity, owner, { op: 'read', id: roomId, limit: 20 }, signal)
  ) as { error?: unknown; messages?: unknown }
  if (value.error === 'disabled') {
    return { status: 'not_authorized' }
  }
  if (typeof value.error === 'string' || !Array.isArray(value.messages)) {
    return { status: 'unavailable' }
  }
  const message = (value.messages as Array<Record<string, unknown>>)
    .find(each => each.mine === false && typeof each.eventId === 'string' && typeof each.text === 'string')
  if (!message) {
    return { status: 'ok', ...(prior ? { cursor: prior } : {}), entries: [] }
  }
  const observedAt = Number(message.at)
  if (!Number.isSafeInteger(observedAt)) {
    return { status: 'failed' }
  }
  const eventId = String(message.eventId)
  const cursor = sweepWatermark(observedAt, [eventId])
  const entries = cursor === prior ? [] : [backgroundSweepChatEvidence(roomId, {
    eventId,
    at: observedAt,
    text: String(message.text)
  })]

  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

async function requestBackgroundMacSources(
  candidate: BackgroundSweepCandidate,
  payload: unknown,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin') {
    return { error: 'unavailable' }
  }
  const agent = backgroundSweepRuntime(candidate)
  const identity = agent && enrollmentOf(agent).identity
  const owner = account.appScope()
  if (!agent || !identity || !owner) {
    return { error: 'unavailable' }
  }
  const accountKey = owner.accountKey
  const generation = owner.generation
  const current = () => {
    const scope = account.appScope()
    const enrolled = enrollmentOf(agent).identity
    return !closing && !agent.closed && scope?.accountKey === accountKey && scope.generation === generation &&
      enrolled?.agentPrincipal === identity.agentPrincipal && enrolled.executorId === identity.executorId
  }
  if (!current()) {
    return { error: 'unavailable' }
  }
  const value = JSON.parse(await macSourcesService().request(payload, { background: true }, signal)) as Record<string, unknown>
  return current() ? value : { error: 'disabled' }
}

function macBackgroundStatus(value: Record<string, unknown>): BackgroundSweepSourceRead['status'] | null {
  return value.error === 'disabled' || value.error === 'permission_needed'
    ? 'not_authorized'
    : value.error === 'unavailable'
      ? 'unavailable'
      : value.error === 'invalid'
        ? 'failed'
        : null
}

async function backgroundSweepMacFilesSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  sourceIntervalMs: number
): Promise<BackgroundSweepSourceRead> {
  if (process.platform !== 'darwin' || !backgroundSweepRuntime(candidate)) {
    return { status: 'unavailable' }
  }
  const now = Date.now()
  const files = await recentMacFileNames({ roots: [path.join(app.getPath('home'), 'Atum', 'Drive')],
    since: now - 30 * 24 * 60 * 60_000, limit: 5 })
  const revisions = files.map(file => `${file.identity}:${file.modifiedAt}`)
  const changed = prior === undefined || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const entries = files.map(file => backgroundSweepMacFileEvidence(file,
    changed && file.modifiedAt >= now - sourceIntervalMs))
  const cursor = sweepWatermark(now, revisions)
  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

async function backgroundSweepMacMessagesSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  signal: AbortSignal
): Promise<BackgroundSweepSourceRead> {
  const value = await requestBackgroundMacSources(candidate, { op: 'messages.conversations', days: 30, limit: 10 }, signal)
  const status = macBackgroundStatus(value)
  if (status) {
    return { status }
  }
  if (!Array.isArray(value.conversations)) {
    return { status: 'failed' }
  }
  const rows = (value.conversations as Array<Record<string, unknown>>).filter(row =>
    typeof row.id === 'string' && typeof row.lastActivity === 'string')
  const revisions = rows.map(row => `${row.id}:${row.lastActivity}:${String(row.messageCount ?? '')}`)
  const changed = prior === undefined || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const entries: FollowupSweepEvidenceInput[] = rows.slice(0, 5).flatMap(row => {
    const observedAt = Date.parse(String(row.lastActivity))
    if (!Number.isFinite(observedAt)) {
      return []
    }
    const participants = Array.isArray(row.participants)
      ? row.participants.map(item => typeof item === 'object' && item && 'name' in item ? String(item.name) : '')
        .filter(Boolean).slice(0, 3).join(', ')
      : ''
    return [{ source: 'mac_messages', scope: 'mac:messages', objectId: String(row.id),
      anchorId: `${String(row.id)}:${String(row.lastActivity)}:${String(row.messageCount ?? 0)}`, dueAt: null,
      observedAt, title: String(row.title ?? '').slice(0, 240),
      text: `${participants || (row.isGroup ? 'Group conversation' : 'Conversation')}; ${String(row.messageCount ?? 0)} messages`,
      fresh: changed }]
  })
  const cursor = sweepWatermark(Date.now(), revisions)
  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

async function backgroundSweepMacBrowserSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  signal: AbortSignal
): Promise<BackgroundSweepSourceRead> {
  const value = await requestBackgroundMacSources(candidate,
    { op: 'browser.history', browser: 'all', days: 14, limit: 20, mode: 'recent' }, signal)
  const status = macBackgroundStatus(value)
  if (status) {
    return { status }
  }
  if (!Array.isArray(value.history)) {
    return { status: 'failed' }
  }
  const rows = value.history as Array<Record<string, unknown>>
  const revisions = rows.map(row => JSON.stringify([row.browser, row.domain, row.path, row.lastVisit, row.visits]))
  const changed = prior === undefined || sweepWatermarkDigest(prior) !== sweepHash([...revisions].sort())
  const entries: FollowupSweepEvidenceInput[] = rows.slice(0, 5).flatMap(row => {
    const observedAt = Date.parse(String(row.lastVisit ?? ''))
    if (!Number.isFinite(observedAt) || typeof row.domain !== 'string') {
      return []
    }
    const identity = createHash('sha256').update(JSON.stringify([row.browser, row.domain, row.path])).digest('hex')
    return [{ source: 'mac_browser_history', scope: 'mac:browser', objectId: identity,
      anchorId: `${identity}:${String(row.lastVisit)}`, dueAt: null, observedAt,
      title: String(row.title ?? row.domain).slice(0, 240),
      text: `${row.domain}; ${String(row.visits ?? 1)} visits`, fresh: changed }]
  })
  const cursor = sweepWatermark(Date.now(), revisions)
  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

async function backgroundSweepMacLocationSource(
  candidate: BackgroundSweepCandidate,
  prior: string | undefined,
  signal: AbortSignal
): Promise<BackgroundSweepSourceRead> {
  const value = await requestBackgroundMacSources(candidate, { op: 'location.current', precision: 'city' }, signal)
  const status = macBackgroundStatus(value)
  if (status) {
    return { status }
  }
  if (typeof value.timeZone !== 'string') {
    return { status: 'failed' }
  }
  const revision = JSON.stringify([value.city ?? '', value.region ?? '', value.country ?? '', value.timeZone])
  const cursor = sweepWatermark(Date.now(), [revision])
  const changed = cursor !== prior && sweepWatermarkDigest(prior ?? null) !== sweepHash([revision])
  const label = [value.city, value.region, value.country].filter(item => typeof item === 'string').join(', ')
  const entries: FollowupSweepEvidenceInput[] = changed ? [{ source: 'mac_location', scope: 'mac:location',
    objectId: 'current-city', anchorId: createHash('sha256').update(revision).digest('hex'), dueAt: null,
    observedAt: Date.now(), title: label.slice(0, 240), text: `${label || 'Current city unavailable'}; ${value.timeZone}`,
    fresh: true }] : []
  return { status: 'ok', cursor, entryCursors: entries.map(() => cursor), entries }
}

function backgroundSweepSourceRegistry(
  candidate: BackgroundSweepCandidate,
  policy: { sourceIntervalMs: number; effectiveSourceIntervalMs?: number },
  ownerTimeZone: string,
  warmup: boolean
): BackgroundSweepSourceRegistry {
  const registry = new BackgroundSweepSourceRegistry()
  const interval = policy.effectiveSourceIntervalMs ?? policy.sourceIntervalMs
  const register = (operations: readonly string[], handler: Parameters<BackgroundSweepSourceRegistry['register']>[1]) => {
    for (const operation of operations) {
      registry.register(operation, handler)
    }
  }
  register([NATIVE_AGENT_SOURCE_OPERATIONS.chats, NATIVE_AGENT_SOURCE_OPERATIONS.cloudChats], context =>
    backgroundSweepChatsSource(candidate, context.priorCursor, context.signal, warmup))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.scopedRoom, context =>
    backgroundSweepScopedRoomSource(candidate, context.admission.descriptor.scopeRef, context.priorCursor, context.signal))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.conversation, context =>
    backgroundSweepConversationSource(candidate, interval, context.priorCursor))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.googleMail, context =>
    backgroundSweepGoogleSource(candidate, 'google_mail', context.priorCursor, ownerTimeZone, context.signal, warmup))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.googleCalendar, context =>
    backgroundSweepGoogleSource(candidate, 'google_calendar', context.priorCursor, ownerTimeZone, context.signal, warmup))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.legacyCalendarDrive, context =>
    backgroundSweepGoogleSource(candidate, 'google_calendar', context.priorCursor, ownerTimeZone, context.signal,
      warmup, true))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.googleDrive, context =>
    backgroundSweepGoogleDriveSource(candidate, context.priorCursor, context.signal))
  register([NATIVE_AGENT_SOURCE_OPERATIONS.memory, NATIVE_AGENT_SOURCE_OPERATIONS.cloudMemory], () =>
    backgroundSweepMemorySource(candidate, interval, warmup, false))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.legacyMemoryFiles, () =>
    backgroundSweepMemorySource(candidate, interval, warmup, true))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.macFiles, context =>
    backgroundSweepMacFilesSource(candidate, context.priorCursor, interval))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.macMessages, context =>
    backgroundSweepMacMessagesSource(candidate, context.priorCursor, context.signal))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.macBrowser, context =>
    backgroundSweepMacBrowserSource(candidate, context.priorCursor, context.signal))
  registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.macLocation, context =>
    backgroundSweepMacLocationSource(candidate, context.priorCursor, context.signal))
  return registry
}

async function backgroundSweepAuthority(candidate: BackgroundSweepCandidate, signal: AbortSignal) {
  const ctx = agentHome?.controller.ctx
  if (!ctx) {
    throw new Error('matrix_background_sweep_unavailable')
  }
  const placement = await ctx.platform.readPlacement(candidate.agentPrincipal, signal)
  if (placement.ok === false) {
    throw new Error('matrix_background_sweep_unavailable')
  }
  const home = fenceFromLease(placement.value, ctx.runtime.leaseFacts(candidate.agentPrincipal))
  if (!home || home.leaseId === undefined) {
    throw new Error('matrix_background_sweep_unavailable')
  }
  return { ctx, placement: placement.value, home }
}

function backgroundSweepPlatform(candidate: BackgroundSweepCandidate, signal: AbortSignal) {
  const sign = async (request: unknown, occurrenceId?: string) => {
    const { ctx, home } = await backgroundSweepAuthority(candidate, signal)
    return ctx.auth.sign(AGENT_SWEEP_SIGNED_ACTION, meta =>
      occurrenceId
        ? { meta, fence: withOperation(home, { kind: 'job', id: occurrenceId }), request }
        : { meta, home, request }
    )
  }

  return new ShellBackgroundSweepPlatform({
    request: (send, bounded) => account.s1Request(send, bounded),
    signClaim: request => sign(request),
    signActive: (request, occurrenceId) => sign(request, occurrenceId),
    signRelease: request => sign(request)
  })
}

function createBackgroundSweepPublications(): MatrixBackgroundSweepPublication {
  return new MatrixBackgroundSweepPublication({
    store: principal => allAgents().find(each => cloudPrincipal(each) === principal)?.store ?? null,
    prepare: async input => {
      const agent = allAgents().find(
        each => cloudPrincipal(each) === input.agent && assistantHomeRoom(each) === input.roomId
      )
      const host = agent && hosts.get(agent.role)
      if (!agent || !host?.ready || !agent.assistantId) {
        throw new Error('matrix_background_sweep_publication_unavailable')
      }
      const value = (await host.queue.command(
        {
          kind: 'prepareResult',
          roomId: input.roomId,
          body: input.body,
          invocationId: input.occurrenceId,
          transactionId: input.occurrenceId,
          matrixTransactionId: input.transactionId,
          ledger: true,
          sweep: true,
          ...(input.google ? { google: true as const } : {})
        },
        30_000
      )) as { eventType?: unknown; content?: unknown }
      if (
        (value.eventType !== 'm.room.message' && value.eventType !== 'm.room.encrypted') ||
        !value.content ||
        typeof value.content !== 'object'
      ) {
        throw new Error('matrix_background_sweep_publication_invalid')
      }
      return { eventType: value.eventType, content: value.content }
    },
    enqueue: async (record, signal) => {
      const candidateRuntime = allAgents().find(each => cloudPrincipal(each) === record.agent)
      if (!candidateRuntime?.assistantId) {
        throw new Error('matrix_background_sweep_publication_unavailable')
      }
      const candidate = {
        agentPrincipal: record.agent,
        assistantId: candidateRuntime.assistantId,
        roomId: record.roomId,
        ownerPrincipal: account.identity()?.userId ?? ''
      }
      const { ctx, placement, home } = await backgroundSweepAuthority(candidate, signal)
      const publication = await ctx.auth.sign('MatrixPublicationEnqueue', meta => ({
        meta,
        fence: withOperation(home, { kind: 'job', id: record.occurrenceId }),
        expectedPlacementRevision: placement.placementRevision,
        moveSerializationRevision: placement.placementRevision,
        outboxId: record.outboxId,
        roomId: record.roomId,
        transactionId: record.transactionId,
        payloadSha256: record.payloadSha256
      }))
      const envelope: PublicationEnvelope = {
        publication: publication as PublicationEnvelope['publication'],
        eventType: record.eventType,
        payloadBase64: record.payloadBase64
      }
      const result = await ctx.platform.enqueuePublication(record.agent, envelope, signal)
      // A native sweep is only staged here. The platform keeps this queued row
      // unclaimable until settlement admits the offer and invokes publication.
      if (result.ok === false || result.value.state !== 'queued') {
        throw new Error('matrix_background_sweep_publication_unavailable')
      }
    }
  })
}

function backgroundSweepSuggestions(): MatrixBackgroundSweepSuggestions {
  return (backgroundSweepSuggestionStore ??= new MatrixBackgroundSweepSuggestions(
    path.join(app.getPath('userData'), 'device', 'background-sweep-suggestions')
  ))
}

function createBackgroundSweeps(): MatrixBackgroundSweeps {
  backgroundSweepPublications ??= createBackgroundSweepPublications()
  return new MatrixBackgroundSweeps({
    candidates: () => {
      const ownerPrincipal = account.identity()?.userId ?? ''
      return allAgents().flatMap(agent => {
        const principal = cloudPrincipal(agent)
        const roomId = assistantHomeRoom(agent)
        return !closing && ownerPrincipal && principal && agent.assistantId && roomId && !agent.closed &&
          !isCloudOnlyAgent(agent)
          ? [{ agentPrincipal: principal, assistantId: agent.assistantId, roomId, ownerPrincipal }]
          : []
      })
    },
    probe: async candidate => {
      const signal = AbortSignal.timeout(15_000)
      const setting = await account.agentBackgroundSweep(candidate.assistantId, signal)

      if (!setting.activeForOwner) {
        return { active: false, revision: setting.revision }
      }

      try {
        await backgroundSweepAuthority(candidate, signal)
        return { active: true, revision: setting.revision }
      } catch {
        return { active: false, revision: setting.revision }
      }
    },
    activity: backgroundSweepActivity,
    hold: async candidate => {
      const agent = backgroundSweepRuntime(candidate)
      const held = agent ? await holdAgentLease(agent) : null
      return held?.leaseToken ? (held as BackgroundSweepLease) : null
    },
    acquire: async candidate => {
      const agent = backgroundSweepRuntime(candidate)
      const release = agent?.lock.tryAcquire(candidate.roomId, 'background-sweep')
      return release ? { release } : null
    },
    negotiate: async (candidate, signal) => {
      const sources = await backgroundSweepPlatform(candidate, signal).sources(candidate.assistantId, signal)
      return sources ? AGENT_SWEEP_PROFILE_V2 : AGENT_SWEEP_PROFILE_V11
    },
    claim: (candidate, _lease, request, signal) =>
      backgroundSweepPlatform(candidate, signal).claim(candidate.assistantId, request, signal),
    dispatch: (candidate, _lease, request, signal) =>
      backgroundSweepPlatform(candidate, signal).dispatch(candidate.assistantId, request.occurrenceId, request, signal),
    collect: async (candidate, claim, signal) => {
      const warmup = claim.profile !== AGENT_SWEEP_PROFILE && claim.occurrenceKind === 'warmup_nudge'
      const registry = backgroundSweepSourceRegistry(candidate, claim.policy, claim.ownerTimeZone, warmup)
      const gateEnabled = (gate: string) => macSourceGateEnabled(macSourcesConsentStore().read(), gate)
      const snapshot = claim.profile === AGENT_SWEEP_PROFILE_V2
        ? await collectBackgroundSweepSources({ ownerTimeZone: claim.ownerTimeZone,
            admittedSources: claim.admittedSources, sourceCursors: claim.sourceCursors, registry, gateEnabled,
            current: () => backgroundSweepCurrent(candidate), signal, warmup })
        : await collectLegacyBackgroundSweepSources({ ownerTimeZone: claim.ownerTimeZone,
            prior: claim.sourceWatermarks, registry, gateEnabled, current: () => backgroundSweepCurrent(candidate),
            signal, warmup })
      if (warmup) {
        return claim.profile === AGENT_SWEEP_PROFILE_V2
          ? fitAgentSourceSweepSnapshot(snapshot as AgentSourceSweepSnapshot, { warmup: claim.warmupNudgeIndex })
          : fitWarmupNudgeSnapshot(snapshot as FollowupSweepEvidenceSnapshot, claim.warmupNudgeIndex)
      }
      const evidence = snapshot as FollowupSweepPromptSnapshot
      const suggestion = !followupSweepNeedsModel(evidence) && followupSweepNeedsSuggestion(evidence)
      const history = suggestion
        ? followupSweepSuggestionHistory(evidence, candidate.ownerPrincipal,
          backgroundSweepSuggestions().read(candidate.ownerPrincipal))
        : null

      return claim.profile === AGENT_SWEEP_PROFILE_V2
        ? fitAgentSourceSweepSnapshot(snapshot as AgentSourceSweepSnapshot, suggestion ? 'suggestion' : 'finding',
            { previousSuggestion: history?.previousText ?? undefined })
        : fitFollowupSweepSnapshot(snapshot as FollowupSweepEvidenceSnapshot,
            suggestion ? 'suggestion' : 'finding', { previousSuggestion: history?.previousText ?? undefined })
    },
    needsModel: snapshot => followupSweepNeedsModel(snapshot as FollowupSweepPromptSnapshot),
    suggestion: snapshot => followupSweepNeedsSuggestion(snapshot as FollowupSweepPromptSnapshot),
    suggestions: {
      read: owner => backgroundSweepSuggestions().read(owner),
      write: note => backgroundSweepSuggestions().write(note),
      admit: (owner, date) => backgroundSweepSuggestions().admit(owner, date)
    },
    prompt: (snapshot, nudgeIndex, mode, previousSuggestion) => nudgeIndex === undefined
      ? followupSweepPrompt(snapshot as FollowupSweepPromptSnapshot, mode, { previousSuggestion })
      : warmupNudgePrompt(snapshot as FollowupSweepPromptSnapshot, nudgeIndex),
    classify: async (candidate, authorization, prompt, signal) => {
      const agent = backgroundSweepRuntime(candidate)
      const gateway = agent?.storeGateway as MatrixHermesConnection['gateway'] | undefined
      if (!agent || !gateway || authorization.expiresAt <= Date.now()) {
        throw new Error('matrix_background_sweep_unavailable')
      }
      let release = () => {}
      const atum = authorization.attribution.lane === 'atum_managed'
      if (atum) {
        if (
          authorization.limits.maxModelMicroProtons === null ||
          !['nguyet-thuc', 'nhat-thuc', 'binh-minh'].includes(authorization.destination.model)
        ) {
          throw new Error('matrix_background_sweep_authorization_invalid')
        }
        release = backgroundSweepModelCalls.begin(agent.role, {
          authorizationId: authorization.authorizationId,
          attributionId: authorization.attribution.id,
          model: authorization.destination.model as MatrixModelId,
          effort: authorization.destination.effort,
          protection: authorization.protection.kind,
          maxModelMicroProtons: authorization.limits.maxModelMicroProtons
        })
      }
      try {
        const result = await gateway.request<{ text?: unknown; usage?: unknown }>(
          'background_sweep.classify',
          {
            authorizationId: authorization.authorizationId,
            prompt,
            model: atum ? MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS : authorization.destination.model,
            effort: authorization.destination.effort
          },
          // The platform grants 1,800 seconds to a warm-up nudge; keep the RPC alive for the
          // authorized compute slice plus setup slack instead of the old 120-second ceiling.
          authorization.limits.activeComputeSeconds * 1_000 + 60_000,
          signal
        )
        const usage = backgroundSweepReportedUsage(result?.usage, authorization.limits.activeComputeSeconds)
        if (!result || typeof result.text !== 'string' || !usage) {
          throw new Error('matrix_background_sweep_model_invalid')
        }
        return {
          value: result.text,
          usage
        }
      } finally {
        release()
      }
    },
    validate: (value, snapshot, nudgeIndex, mode, ownerPrincipal) => nudgeIndex !== undefined
      ? validateWarmupNudgeResult(value, snapshot as FollowupSweepPromptSnapshot)
      : mode === 'suggestion'
        ? validateFollowupSweepSuggestion(value, snapshot as FollowupSweepPromptSnapshot, ownerPrincipal ?? '')
        : validateFollowupSweepResult(value, snapshot as FollowupSweepPromptSnapshot),
    fingerprint: followupSweepResultFingerprint,
    stagePublication: (candidate, occurrenceId, text, google, signal) =>
      backgroundSweepPublications!.stage(
        { agent: candidate.agentPrincipal, occurrenceId, roomId: candidate.roomId, body: text, google },
        signal
      ),
    release: async (input, signal) => {
      const request = {
        profile: input.profile,
        operation: 'release' as const,
        occurrenceId: input.occurrenceId,
        leaseToken: input.lease.leaseToken,
        reason: input.reason,
        ...(input.usage ? { usage: input.usage } : {})
      }
      return backgroundSweepPlatform(input.candidate, signal).release(
        input.candidate.assistantId,
        input.occurrenceId,
        request,
        signal
      )
    },
    settle: async (input, signal) => {
      const { home } = await backgroundSweepAuthority(input.candidate, signal)
      const request = {
        profile: input.profile,
        operation: 'settle' as const,
        occurrenceId: input.occurrenceId,
        leaseToken: input.lease.leaseToken,
        resultFingerprint: input.resultFingerprint,
        usage: input.usage,
        scan: input.profile === AGENT_SWEEP_PROFILE_V2
          ? { digest: input.snapshot.digest,
              sourceSnapshotDigest: (input.snapshot as AgentSourceSweepSnapshot).sourceSnapshotDigest,
              cursorDeltas: (input.snapshot as AgentSourceSweepSnapshot).cursorDeltas,
              sources: input.snapshot.sources }
          : { digest: input.snapshot.digest,
              watermarks: (input.snapshot as FollowupSweepEvidenceSnapshot).watermarks,
              sources: input.snapshot.sources },
        ownerEventWatermark: input.ownerEventWatermark,
        commit: {
          kind: 'native' as const,
          homeId: home.homeId,
          homeEpoch: home.homeEpoch,
          executorTerm: home.executorTerm,
          leaseId: home.leaseId
        },
        outcome: input.outcome,
        disposition: input.disposition,
        ...(input.urgency ? { urgency: input.urgency } : {}),
        findingHashes: input.findingHashes,
        outbox: input.outbox
      }
      const result = await backgroundSweepPlatform(input.candidate, signal).settle(
        input.candidate.assistantId,
        input.occurrenceId,
        request,
        signal
      )
      backgroundSweepPublications?.settled(input.candidate.agentPrincipal, input.occurrenceId)
      return { publication: { state: result.publication.state } }
    },
    log: line => console.warn(line)
  })
}

/** Paid hires' jobs on each assistant's backend (store-schedules.ts). */
const storeSchedules = new MatrixStoreSchedules({ log: line => console.warn(line) })

/** The Store binding of paid assistants' scheduled runs: only the Mac holding the
 * assistant's lease runs one, for its home room (store-schedules.ts). */
const storeRuns = new MatrixStoreRuns({
  entitled: async role => {
    const agent = agentOfRole(role as MatrixHostRole)
    const assistantId = agent?.assistantId

    if (!agent || !assistantId || closing || agent.closed || agent.ownModel) {
      return null
    }

    // The Store is read again when it may be stale (never read, a failed read, or a renewal
    // date passed); a run binds only to a paid period still running.
    const items = await matrixStoreRunItems({ store, assistantId })
    const scope = account.appScope()

    if (!items || !scope || closing || agent.closed || agent.ownModel || agent.assistantId !== assistantId) {
      return null
    }

    const enrolled = enrollmentOf(agent)

    return enrolled.state === 'ready' && enrolled.identity
      ? {
          assistantId,
          executorId: enrolled.identity.executorId,
          scope: `${scope.accountKey}:${scope.generation}`,
          items
        }
      : null
  },
  hold: role => {
    const agent = agentOfRole(role as MatrixHostRole)

    // Longer than a check-in waits: a run caught up at start comes while the hosts settle.
    return agent ? holdAgentLease(agent, 30_000) : Promise.resolve(null)
  },
  // The room the backend was started with (its MATRIX_HOME_ROOM, where the run posts), and
  // only while it is still the assistant's room: a run that could not be delivered is never
  // bound, so never charged.
  homeRoom: role => {
    const agent = agentOfRole(role as MatrixHostRole)
    const room = agent?.homeRoom

    return agent && room && room === assistantHomeRoom(agent) ? room : undefined
  },
  createTask: async binding => {
    const owner = account.appScope()
    const signal = AbortSignal.timeout(20_000)

    const task = await prepareMatrixStoreContext({
      entitlements: store?.snapshot()?.entitlements ?? [],
      ...binding,
      signal,
      current: () =>
        Boolean(
          owner &&
          account.appScope()?.accountKey === owner.accountKey &&
          account.appScope()?.generation === owner.generation
        ),
      request: value => account.storeRequest('tasks', signal, value)
    })

    return task ?? null
  },
  // The assistant's synced Store-run ledger (shared/matrix-store-runs.ts), through the
  // owner's SDK, like check-ins' ledger: fresh reads, and writes only under the lease.
  readLedger: async assistantId =>
    (await humanHost().queue.command({ kind: 'storeRunsRead', assistantId }, 20_000)) as MatrixStoreRunLedger,
  writeLedger: async (assistantId, ledger) => {
    await humanHost().queue.command({ kind: 'storeRunsWrite', assistantId, ledger }, 20_000)
  },
  log: line => console.warn(line)
})

/** The owner's SDK host, for account data main writes (Store-run claims). */
function humanHost() {
  const host = hosts.get('human')

  if (!host || closing) {
    throw new Error('matrix_not_ready')
  }

  return host
}

/** Backends whose hire skills are in place, with the hires they were checked for, and a
 * check in flight (so the backend's start and a Store change never install twice at once). */
const storeHiresPrepared = new WeakMap<object, string>()
const storeHiresPreparing = new WeakMap<object, Promise<void>>()

/**
 * A paid assistant's optional hire skills on its backend (store-schedules.ts), at most once
 * per backend connection and hire. Skipped while its hire is unknown (the Store not read yet,
 * or no assistant ID): the Store's next change tries again.
 */
async function prepareStoreHire(agentRuntime: MatrixAgentRuntime): Promise<void> {
  const gateway = agentRuntime.storeGateway
  const snapshot = store?.snapshot()

  if (!gateway || !agentRuntime.assistantId || agentRuntime.ownModel || snapshot?.state !== 'ready') {
    return
  }

  const items = matrixStoreHiredItems(snapshot.entitlements, agentRuntime.assistantId)
  const key = items.join('\n')

  if (!items.length || storeHiresPrepared.get(gateway) === key) {
    return
  }

  const inFlight = storeHiresPreparing.get(gateway)

  if (inFlight) {
    return inFlight
  }

  const preparing = prepareMatrixStoreHire({ gateway, items, log: line => console.warn(line) })
    .then(missing => {
      if (!missing.length) {
        storeHiresPrepared.set(gateway, key)
      }
    })
    .catch(() => console.warn('[Matrix] store hire skills not checked'))
    .finally(() => storeHiresPreparing.delete(gateway))

  storeHiresPreparing.set(gateway, preparing)

  return preparing
}

/**
 * A paid assistant's Store jobs on its backend: those of its hires in force, none once they
 * end, and none while it answers with its own model (its paid skills reach the model only
 * through Atum's AI). Nothing is decided while the Store or its assistant ID is unknown, so a
 * start before the Store is read never removes a job.
 */
function reconcileStoreJobs(agentRuntime: MatrixAgentRuntime, force = false) {
  const gateway = agentRuntime.storeGateway
  const snapshot = store?.snapshot()

  // A backend started without its home room has nowhere to post a run: add nothing there.
  if (
    !gateway ||
    closing ||
    agentRuntime.closed ||
    isCloudOnlyAgent(agentRuntime) ||
    !agentRuntime.assistantId ||
    !agentRuntime.homeRoom ||
    snapshot?.state !== 'ready'
  ) {
    return
  }

  const items = agentRuntime.ownModel ? [] : matrixStoreScheduledItems(snapshot.entitlements, agentRuntime.assistantId)

  void storeSchedules.reconcile(agentRuntime.role, gateway, items, force)
}

let storeChangeTimer: ReturnType<typeof setTimeout> | undefined

/** After a Store read or a hire: every assistant's jobs and hire skills, once per burst. */
function storeChanged() {
  if (storeChangeTimer) {
    return
  }

  storeChangeTimer = setTimeout(() => {
    storeChangeTimer = undefined

    for (const agentRuntime of [defaultAgent, ...agents.values()]) {
      // Never under a running turn: a skill installed now reaches the next conversation.
      // The jobs follow the skills: a hire held for missing skills gets its jobs once they
      // are in.
      if (agentRuntime.invocation) {
        reconcileStoreJobs(agentRuntime)
      } else {
        void prepareStoreHire(agentRuntime).finally(() => reconcileStoreJobs(agentRuntime))
      }
    }
  }, 1_000)
  storeChangeTimer.unref?.()
}

/** The default assistant's check-ins: the gate its job asks, the claims and the posts. */
function createCheckIns(): MatrixCheckIns {
  const human = () => {
    const host = hosts.get('human')

    if (!host || closing) {
      throw new Error('matrix_not_ready')
    }

    return host
  }

  return new MatrixCheckIns({
    available: () => {
      const enrolled = enrollmentOf(defaultAgent)

      const model = defaultAgent.ownModel
        ? defaultAgent.connectedModel?.model
        : managedModel
          ? MATRIX_CHECK_IN_MODEL_ALIAS
          : undefined

      if (
        closing ||
        defaultAgent.closed ||
        !model ||
        enrolled.state !== 'ready' ||
        !enrolled.identity ||
        !matrixEnrollmentAuthority(enrolled).ok ||
        !hosts.get('human') ||
        !hosts.get(defaultAgent.role)?.ready ||
        !assistantHomeRoom(defaultAgent)
      ) {
        return { ok: false }
      }

      const language = state.displayPreferences?.language?.value
      let watched: string

      try {
        if (!workspaceStartup) {
          return { ok: false }
        }

        watched = workspaceStartup.watched()
      } catch {
        return { ok: false }
      }

      return {
        ok: true,
        model,
        locale: isDesktopLocale(language) ? language : DEFAULT_DESKTOP_LOCALE,
        // Read the same current root facts used before runtime spawn, or stay unavailable.
        watched: [watched]
      }
    },
    cached: () => {
      const records = state.checkIns

      return records ? { settings: records.settings, feedback: records.feedback, ledger: records.ledger } : undefined
    },
    context: () => {
      const homeRoom = assistantHomeRoom(defaultAgent)
      const balance = wallet?.snapshot()

      return {
        busy: Boolean(defaultAgent.invocation?.roomId || defaultAgent.localTurns?.executionPending),
        lastActivity: state.rooms.find(room => room.id === homeRoom)?.lastActiveAt,
        canAfford:
          defaultAgent.ownModel ||
          balance?.state !== 'ready' ||
          balance.wallet.balances.available >= matrixCheckInCost().perRunMax * 1_000_000,
        betweenBriefChecks: !backgroundSweeps?.activeForOwner(cloudPrincipal(defaultAgent) ?? '')
      }
    },
    hold: holdCheckInLease,
    read: async () => (await human().queue.command({ kind: 'checkInsRead' }, 20_000)) as MatrixCheckInsState,
    writeLedger: async ledger => {
      await human().queue.command({ kind: 'checkInsLedger', ledger }, 20_000)
    },
    resurface: async (snooze, claimedAt) => {
      const roomId = assistantHomeRoom(defaultAgent)

      if (!roomId || !defaultAgent.cron) {
        return
      }

      const receipt = await defaultAgent.cron.deliver({
        requestId: '0',
        roomId,
        text: matrixCheckInEnvelope({ nudge: snooze.nudge, slot: 'check', claimedAt, resurfaced: true }),
        jobId: MATRIX_CHECK_IN_JOB_ID,
        runId: randomUUID()
      })

      if (receipt.status !== 'delivered') {
        console.warn(`[Matrix] check-in snooze not posted reason=${receipt.error}`)
      }
    },
    turnOff: async () => {
      const records = state.checkIns
      const owner = hosts.get('human')
      const identity = state.identity

      if (records?.settings.enabled === false) {
        return true
      }

      if (!records?.writable || !owner || !identity || closing) {
        return false
      }

      // As the owner asked: the chat then says check-ins are off, with the way back.
      await owner.queue.command({
        kind: 'checkInsChange',
        identity,
        change: { field: 'enabled', value: false, by: 'asked' }
      })

      return true
    },
    log: line => console.warn(line)
  })
}

/** The owner wrote to the default assistant: that answers its check-ins, and a short "stop
 * checking in" (any of Atum's languages) turns them off. Best effort; the message itself
 * goes on to the assistant as usual. */
function noteCheckInOwnerMessage(agentRuntime: MatrixAgentRuntime | undefined, body: string) {
  const principal = cloudPrincipal(agentRuntime)
  if (principal) {
    backgroundSweeps?.cancel(principal)
  }
  const records = state.checkIns
  const owner = hosts.get('human')
  const identity = state.identity

  if (agentRuntime !== defaultAgent || !records?.writable || !owner || !identity || closing) {
    return
  }

  if (records.settings.enabled && matrixCheckInStopRequested(body)) {
    void owner.queue
      .command({ kind: 'checkInsChange', identity, change: { field: 'enabled', value: false, by: 'asked' } })
      .then(() => console.warn('[Matrix] check-ins turned off on request'))
      .catch(() => console.warn('[Matrix] check-ins not turned off'))
  } else if (records.ledger.lastNudgeAt > records.feedback.ackAt) {
    void owner.queue.command({ kind: 'checkInsFeedback', identity, feedback: { kind: 'ack' } }).catch(() => {})
  }
}

/** A backend started before its agent's room existed cannot post its jobs there: once
 * the room is known and nothing is running, start it again with that home room. */
function refreshHermesHomeRoom(agentRuntime: MatrixAgentRuntime = defaultAgent) {
  // Only a running, idle backend holding no sign-in, with no conversation change pending, is
  // restarted; nothing else reads the account.
  if (
    conversationPending(agentRuntime) ||
    !matrixBackendRestartable(agentRuntime, { busy: Boolean(operation || domainOperation), closing })
  ) {
    return
  }

  // Listener shutdown also publishes. A revoked Atum grant must not make this
  // optional room refresh throw before sign-out reaches credential cleanup.
  if (
    !readMatrixAgentPresentation(
      Boolean(account?.appScope()),
      () => matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok
    )
  ) {
    return
  }

  const homeRoom = assistantHomeRoom(agentRuntime)

  if (!homeRoom || homeRoom === agentRuntime.homeRoom) {
    return
  }

  // A marked move converges jobs and home under the conversation service's runtime fence.
  if (
    AGENT_ONE_CONVERSATION &&
    resolveProjectedConversation(state.rooms, state.identity?.userId, agentRuntime.userId).main
  ) {
    return
  }

  // hermesHomeRoom changes only when the new backend opens (openAssistantHermes).
  console.warn('[Matrix] assistant room known: restarting Hermes with it as the jobs room')
  void stopHermesExecutor(agentRuntime).then(() => startAssistantHermes(agentRuntime))
}

let googleRestartAt = 0

/** Google tools reach the assistant only at launch (its tool list never changes inside a
 * conversation). Full power gives the available broker directly; the protected path gives it
 * with the route. Neither depends on whether services are connected, so connecting Google needs
 * no restart. When what the policy wants differs from the running launch, restart the idle
 * default assistant at most once a minute. */
function refreshGoogleTools(agentRuntime: MatrixAgentRuntime) {
  const launched = googleLaunched.get(agentRuntime.role)

  if (
    !launched ||
    !matrixBackendRestartable(agentRuntime, { busy: Boolean(operation || domainOperation), closing }) ||
    Date.now() - googleRestartAt < 60_000
  ) {
    return
  }

  const tools = googleAssistant.wantsTools(agentRuntime.role)

  // The fence is the default assistant's alone; another agent only compares the tool grant.
  if (tools === launched.tools && (launched.fence || agentRuntime.role !== MATRIX_GOOGLE_ASSISTANT_ROLE || !googleAssistant.latched())) {
    return
  }

  googleRestartAt = Date.now()
  console.warn('[Matrix] google access changed: restarting the assistant when idle')
  void stopHermesExecutor(agentRuntime).then(() => startAssistantHermes(agentRuntime))
}

/** Starts (or confirms) the assistant's Hermes; resolves true once it is connected. */
function startAssistantHermes(agentRuntime: MatrixAgentRuntime = defaultAgent): Promise<boolean> {
  if (
    isCloudOnlyAgent(agentRuntime) ||
    isMovingAgent(agentRuntime) ||
    (!conversations.get(agentRuntime)?.activity.changing && conversationPending(agentRuntime))
  ) {
    return Promise.resolve(false)
  }

  if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
    return Promise.resolve(false)
  }

  // Even acquiring the answering lease waits for a new profile's installation.
  if (lifecycle.blocksRuntime(agentRuntime.principal)) {
    return Promise.resolve(false)
  }

  if (agentRuntime.starting) {
    return agentRuntime.starting
  }

  // A live turn owns a connected executor: nothing to start.
  if (agentRuntime.invocation && !agentRuntime.invocation.app && agentRuntime.executor?.usable) {
    return Promise.resolve(true)
  }

  if (
    closing ||
    agentRuntime.closed ||
    !runtime ||
    agentRuntime.invocation ||
    operation ||
    domainOperation ||
    agentRuntime.operation
  ) {
    return Promise.resolve(false)
  }

  const enrollment = enrollmentOf(agentRuntime)

  if (enrollment.state !== 'ready' || !enrollment.identity || !hosts.get(agentRuntime.role)?.ready) {
    return Promise.resolve(false)
  }

  const identity = enrollment.identity
  const selectedRuntime = runtime
  reconcileLease(agentRuntime)

  agentRuntime.starting = (async () => {
    try {
      if (agentRuntime.executor && !agentRuntime.executor.usable) {
        await stopHermesExecutor(agentRuntime)
      }

      if (
        !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok ||
        isCloudOnlyAgent(agentRuntime) ||
        isMovingAgent(agentRuntime)
      ) {
        return false
      }

      agentRuntime.executor ??= new MatrixHermesExecutor(
        signal =>
          openAssistantHermes(
            selectedRuntime,
            { owner: identity.principal, executorId: identity.executorId },
            signal,
            agentRuntime
          ),
        agentRuntime.store,
        observation => desktopServices?.turn(observation),
        matrixAgentSoulLifecycle(agentRuntime)
      )
      await agentRuntime.executor.connect(new AbortController().signal)

      if (
        !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok ||
        isCloudOnlyAgent(agentRuntime) ||
        isMovingAgent(agentRuntime)
      ) {
        return false
      }

      console.warn('[Matrix] assistant Hermes running')

      // Settle any scheduled post a quit left in flight, now that the agent can post.
      if (!isCloudOnlyAgent(agentRuntime)) {
        void agentRuntime.cron?.resume().catch(() => {})
      }

      return true
    } catch (error) {
      console.warn('[Matrix] assistant Hermes did not start:', setupFailureDetail(error))

      return false
    } finally {
      agentRuntime.starting = undefined
      scheduleExecutionPolicyReconcile()
    }
  })()

  return agentRuntime.starting
}

function waitUntil(test: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + ms

    const poll = () => {
      if (signal.aborted) {
        resolve(false)
      } else if (test()) {
        resolve(true)
      } else if (Date.now() >= deadline) {
        resolve(false)
      } else {
        setTimeout(poll, 100)
      }
    }

    poll()
  })
}

const readinessPass: MatrixReadinessCheck = { ok: true }
const readinessFail = (code: string): MatrixReadinessCheck => ({ ok: false, code })

/** Atum's AI answers for this agent: offline first, then the free probe through the local
 * proxy with the agent's own key. */
async function checkAtumAi(
  signal: AbortSignal,
  agentRuntime: MatrixAgentRuntime = defaultAgent
): Promise<MatrixReadinessCheck> {
  const authority = matrixEnrollmentAuthority(enrollmentOf(agentRuntime))

  if (!authority.ok) {
    return authority
  }

  if (!net.isOnline()) {
    return readinessFail('offline')
  }

  const google = agentRuntime.role === MATRIX_GOOGLE_ASSISTANT_ROLE

  // A latched assistant may hold Google data: it answers only through the protected route,
  // never with a model the person brought (Settings › Google explains it).
  if (google && agentRuntime.ownModel && googleAssistant.latched()) {
    return readinessFail('ai_unavailable')
  }

  // The person's own model has no proxy to probe; its turn watchdog still applies.
  if (!config.managedModel || agentRuntime.ownModel) {
    return readinessPass
  }

  if (!managedModel) {
    return readinessFail('ai_unavailable')
  }

  const result = await managedModel.probe(agentRuntime.role, signal)

  // The same check keeps the protected route's answer fresh for the fence and Settings.
  if (google && result.ok && (await googleAssistant.refreshRoute(signal)) === false && googleAssistant.latched()) {
    return readinessFail('ai_unavailable')
  }

  if (!result.ok && result.code === 'out_of_protons') {
    void wallet?.refresh('out_of_protons')
  }

  const currentAuthority = matrixEnrollmentAuthority(enrollmentOf(agentRuntime))

  if (!currentAuthority.ok) {
    return currentAuthority
  }

  return result.ok ? readinessPass : readinessFail(result.code)
}

function leaseReady(agentRuntime: MatrixAgentRuntime = defaultAgent): MatrixReadinessCheck {
  const authority = matrixEnrollmentAuthority(enrollmentOf(agentRuntime))

  if (!authority.ok) {
    return authority
  }

  return agentRuntime.lease?.ready ? readinessPass : readinessFail('platform_unavailable')
}

/** Lease ownership follows admitted work, not the existence of a ready model.
 * Model setup/probes also use invocation; only a room-bound turn is demand. */
function reconcileLease(agent: MatrixAgentRuntime): void {
  const enrolled = enrollmentOf(agent)

  if (closing || agent.closed || !agent.lease) {
    return
  }

  // A drain or a checkpoint for a move of the agent's home signs with this lease: it keeps renewing, and
  // nothing new is claimed (the hold keeps the listener, the executor and local turns off).
  const homePrincipal = agent.agentPrincipal ?? agent.principal

  if (homePrincipal && agentHome?.keepsLease(homePrincipal)) {
    return
  }

  // Legacy cloud-only agents hold no local lease. A saved H-F policy may keep this Mac ready;
  // an exact yielding term drains without admitting another claim.
  if (isCloudOnlyAgent(agent) || isMovingAgent(agent)) {
    void agent.lease.release()

    return
  }

  if (agent.lease.current.state === 'yielding') {
    if (!agent.invocation && agent.groupDemand === 0 && agent.backgroundDemand === 0) {
      void agent.lease.release()
    }

    return
  }

  const agentHost = hosts.get(agent.role)
  const humanHost = hosts.get('human')
  const held = enrolled.identity ? agent.lease.held(enrolled.identity.executorId) : null

  // Host readiness gates only new claims (host-health.ts). A host that is down releases, as before.
  // One whose sync is only reconnecting does neither: what is held keeps renewing in the background
  // (a turn in flight keeps its authority until a real loss: a renewal refused, the wall clock past
  // its term, authority withdrawn), and nothing new is claimed until the sync is back.
  const hostAction = matrixLeaseHostAction({
    enrolled: enrolled.state === 'ready' && Boolean(enrolled.identity),
    agent: agentHost,
    human: { ready: matrixHumanSdkReady(state.state, humanHost), degraded: humanHost?.degraded },
    admitted: matrixTurnOwnsHeldLease(agent.invocation, held),
    humanReplacement: ownerRepairPreservesWork()
  })

  if (hostAction === 'release' || enrolled.state !== 'ready' || !enrolled.identity) {
    void agent.lease.release()

    return
  }

  if (hostAction === 'hold') {
    return
  }

  // This Mac stepped aside for the agent (lease-handover.ts): another device takes it over
  // meanwhile. A message typed here, or the owner's group message to it, still competes, so it
  // is answered here or granted against the Mac that took over (a group turn defers to a Mac
  // that holds the lease); a lease this Mac holds always listens.
  if (!leaseHandover.competes(agent) && !agent.localTurns?.executionPending && agent.groupDemand === 0) {
    void agent.lease.release()

    return
  }

  // A fresh saved policy is an in-memory own-chat watch, independent of the person's persistent
  // keep-listening choice. Start-then-lease remains intact: readiness and Hermes come first.
  // This is the only place the policy path ever attempts a lease, so FC D3 (a Mac whose keep-awake
  // row is off attempts none, and so never counts as eligible to the platform) is decided in one function.
  if (isCloudAgent(agent)) {
    const principal = cloudPrincipal(agent)
    const presence = deviceIdentity?.presence()

    const intent = matrixExecutionPolicyLeaseIntent({
      view: principal ? executionPolicies?.snapshot(principal) : undefined,
      deviceServiceId: presence?.state === 'enrolled' ? presence.deviceServiceId : undefined,
      powerEligible: macPowerEligible(),
      competes: leaseHandover.competes(agent),
      runtimeReady: agent.readiness?.current.phase === 'ready' && Boolean(agent.executor?.connected)
    })

    if (intent === 'start') {
      agent.lease.start(enrolled.identity.executorId, 2)

      return
    }

    if (intent === 'release') {
      void agent.lease.release()

      return
    }
  }

  if (agent.continuous?.wantsLease) {
    // A functioning SDK alone is not an available Hermes executor. Readiness
    // owns recovery; do not hold answering authority while it is degraded.
    if (agent.readiness?.current.phase === 'ready' && agent.executor?.connected) {
      agent.lease.start(enrolled.identity.executorId, 2)
    } else {
      void agent.lease.release()
    }
  } else {
    reconcileMatrixAgentLease(agent, enrolled.identity.executorId, 2)
  }
}

async function findTurn(
  host: Host | undefined,
  turn: Readonly<MatrixLocalTurn>,
  sender: string | undefined,
  which: 'question' | 'answer',
  /** One part of an answer posted as several messages (matrix-answer-parts.ts). */
  part?: number
): Promise<MatrixTurnLookup> {
  const started = Date.now()
  let lookup: MatrixTurnLookup = { state: 'unknown' }

  if (host && sender) {
    const value = (await host.queue
      .command(
        {
          kind: 'findTurn',
          roomId: turn.roomId,
          turnId: turn.turnId,
          sender,
          since: turn.createdAt,
          // A handed-off question carries the handoff marker (its answer comes from the other Mac).
          ...(which === 'question' && (turn.route === 'home' || turn.route === 'cloud')
            ? { marker: 'handoff' as const }
            : {}),
          ...(which === 'answer' && part !== undefined ? { part } : {})
        },
        MATRIX_FIND_TURN.deadlineMs + 5_000
      )
      .catch(() => null)) as MatrixTurnLookup | null

    if (value?.state === 'found' && typeof value.eventId === 'string' && value.eventId.startsWith('$')) {
      lookup = { state: 'found', eventId: value.eventId }
    } else if (value?.state === 'absent') {
      lookup = { state: 'absent' }
    }
  }

  console.warn(
    `[Matrix] findTurn ${which}${part !== undefined ? ` part=${part}` : ''} turn=${turn.turnId.slice(0, 8)} pages=${MATRIX_FIND_TURN.pages} size=${MATRIX_FIND_TURN.pageSize} ` +
      `deadline=${MATRIX_FIND_TURN.deadlineMs} result=${lookup.state} ms=${Date.now() - started}`
  )

  return lookup
}

/** One answering executor per agent, leased once per session (plan 2026-09-26-chat-speed-parity). */
function createLease(agentRuntime: MatrixAgentRuntime): MatrixExecutorLease {
  return new MatrixExecutorLease({
    request: (operation, executorId, options) => account.lease(operation, executorId, options),
    onLost: reason => console.warn(`[lease] lost reason=${reason}`),
    onChange: status => {
      // Lease transitions are part of the local path's trail (plan §4.8); renewals are not. A hold for
      // the owner's plan (0238) is its own line: it is neither another Mac nor an outage.
      const leaseKey = status.state === 'elsewhere' && status.reason ? `${status.state} ${status.reason}` : status.state

      if (leaseKey !== agentRuntime.leaseLogged) {
        agentRuntime.leaseLogged = leaseKey
        console.warn(
          `[Matrix] lease ${agentRuntime.principal === undefined ? '' : `${agentRuntime.principal.slice(0, 8)} `}${leaseKey}`
        )
      }

      // A new term on this Mac counts only its own failures (lease-handover.ts).
      if (status.state === 'held') {
        leaseHandover.leaseTerm(agentRuntime, status.leaseToken ?? String(status.acquiredAt))
      }

      // The Mac that holds a cloud-route agent's term runs its jobs; every other one holds them.
      reconcileJobsHold(agentRuntime)

      agentRuntime.localTurns?.kick()
      scheduleContinuousListening()
      scheduleExecutionPolicyReconcile()

      if (status.state === 'unavailable' && status.reason === 'authority_withdrawn') {
        agentRuntime.readiness?.recheck()
        publish(state)
      }
    }
  })
}

/** Posts an agent's scheduled results into its own room (readiness plan §4.5). */
function createCronDelivery(agentRuntime: MatrixAgentRuntime): MatrixCronDelivery {
  // Recovery is independent of the scheduler lifetime, which stops admission on a move.
  // D1's fresh mayPublish standing permits only the unacknowledged source drain.
  const recovery = (bound?: AbortSignal) => {
    const ctx = agentHome?.controller.ctx
    const principal = cloudPrincipal(agentRuntime)

    if (closing || agentRuntime.closed || !ctx || !principal) {throw new Error('mac_job_not_home')}
    const signal = bound ? AbortSignal.any([bound, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
    const authority = (_assistant: string, attempt: AbortSignal) => macJobAuthority(ctx, principal, attempt, true)
    const client = new MacJobsClient({ auth: ctx.auth, request: (send, signal) => account.s1Request(send, signal), authority })
    // Only the home/term that ran the occurrence may publish or settle it; a later one never does.
    const current = async (post: MatrixCronPost) => assertMacJobDeliveryHome(post, await authority('', signal))

    return { signal, authority, client, principal, current }
  }

  return new MatrixCronDelivery({
    store: agentRuntime.store,
    settleManaged: async (post, eventId, bound) => {
      if (post.occurrence?.assistantId !== agentRuntime.assistantId) {throw new Error('mac_job_not_home')}
      const { client, signal, current } = recovery(bound)
      await current(post)
      await settleMacJobDelivery(client, post, eventId, signal)
    },
    authorizeManaged: async (post, bound) => {
      if (post.occurrence?.assistantId !== agentRuntime.assistantId) {throw new Error('mac_job_not_home')}
      const { client, signal, current } = recovery(bound)
      await current(post)
      await completeMacJobDelivery(client, post, signal)
    },
    // Only the agent's own room with its owner, checked the way a turn's room is.
    requireRoom: async roomId => {
      if (isCloudOnlyAgent(agentRuntime) || !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
        throw new Error('matrix_authority_withdrawn')
      }

      const human = hosts.get('human')
      const agent = hosts.get(agentRuntime.role)

      if (!human || !agent) {
        throw new Error('matrix_not_ready')
      }

      await requireAssistantRoom(roomId, human, agent, { forTurn: true })
    },
    publish: async (post, bound) => {
      if (isCloudOnlyAgent(agentRuntime) || !matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
        throw new Error('matrix_authority_withdrawn')
      }

      const agent = hosts.get(agentRuntime.role)

      if (!agent?.ready) {
        throw new Error('matrix_offline')
      }

      if (post.occurrence) {
        const { principal, signal, current } = recovery(bound)

        await current(post)

        if (!agentHome) {throw new Error('mac_job_not_home')}

        return agentHome.publishJob({
          agent: principal, operation: { kind: 'job', id: post.occurrence.occurrenceId },
          roomId: post.roomId, transactionId: matrixCronTransaction(post.runId),
          prepare: async () => {
            const prepared = await agent.queue.command({ kind: 'prepareCron', roomId: post.roomId,
              body: post.text, runId: post.runId, jobId: post.jobId,
              ...(googleAssistant.marks(agentRuntime.role) ? { google: true as const } : {}) }, 40_000) as
              { eventType: 'm.room.message' | 'm.room.encrypted'; content: object }

            return prepared
          }
        }, signal)
      }

      // A check-in (check-ins.ts) is admitted again before it is posted, and posts its card.
      let nudge: MatrixCheckInNudge | undefined

      if (post.jobId === MATRIX_CHECK_IN_JOB_ID) {
        const admitted =
          agentRuntime === defaultAgent && checkIns
            ? await checkIns.admit(post.text, post.runId)
            : { drop: 'not_the_default_assistant' }

        if ('drop' in admitted) {
          console.warn(`[Matrix] check-in not posted reason=${admitted.drop}`)
          throw new Error('matrix_check_in_suppressed')
        }

        nudge = admitted.nudge
      }

      const eventId = await agent.queue.command(
        {
          kind: 'publishCron',
          roomId: post.roomId,
          body: nudge ? nudge.text : post.text,
          runId: post.runId,
          jobId: post.jobId,
          ...(nudge ? { nudge } : {}),
          ...(googleAssistant.marks(agentRuntime.role) ? { google: true as const } : {})
        },
        40_000
      )

      if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
        throw new Error('matrix_send_failed')
      }

      return eventId
    },
    find: async post => {
      const agent = hosts.get(agentRuntime.role)

      if (!agent?.ready) {
        return { state: 'unknown' }
      }

      const value = (await agent.queue
        .command(
          {
            kind: 'findTurn',
            marker: 'cron',
            roomId: post.roomId,
            turnId: post.runId,
            sender: agent.identity.userId,
            since: post.since
          },
          MATRIX_FIND_TURN.deadlineMs + 5_000
        )
        .catch(() => null)) as MatrixTurnLookup | null

      return value?.state === 'found' && typeof value.eventId === 'string' && value.eventId.startsWith('$')
        ? { state: 'found', eventId: value.eventId }
        : value?.state === 'absent'
          ? { state: 'absent' }
          : { state: 'unknown' }
    },
    log: line => console.warn(line)
  })
}

/** The agent's read receipt and typing in its own chat (agent-turns v1.1, agent-signals.ts),
 * through its own SDK host. Best effort: presentation only. */
function createAgentSignals(agentRuntime: MatrixAgentRuntime = defaultAgent): MatrixAgentSignals {
  return new MatrixAgentSignals({
    send: command => {
      const agentHost = hosts.get(agentRuntime.role)

      return agentHost?.ready
        ? agentHost.queue.command(command, 15_000)
        : Promise.reject(new Error('matrix_agent_unavailable'))
    },
    owner: () => account.identity()?.userId,
    leaseHeld: () => {
      const enrolled = enrollmentOf(agentRuntime).identity

      return !!enrolled && !!agentRuntime.lease?.held(enrolled.executorId)
    },
    log: line => console.warn(line)
  })
}

/** The local path (plan §4.1–4.4): this Mac's Hermes directly, the room for everyone else. */
function createLocalTurns(agentRuntime: MatrixAgentRuntime = defaultAgent): MatrixLocalTurns {
  /**
   * The turn's runtime, checked right before it acts: anything missing before the prompt reaches
   * Hermes leaves the turn waiting. Owner-only by design: the room is re-read from current state
   * (`room`), as the server path does, rather than trusting the check made when it was sent.
   */
  const ready = async (turn: Readonly<MatrixLocalTurn>, signal: AbortSignal, room: boolean) => {
    const enrolled = enrollmentOf(agentRuntime)
    const human = account.identity()

    if (
      closing ||
      agentRuntime.invocation ||
      !runtime ||
      enrolled.state !== 'ready' ||
      !enrolled.identity ||
      !human ||
      !hosts.get('human') ||
      !hosts.get(agentRuntime.role)
    ) {
      throw new Error('matrix_not_ready')
    }

    const humanHost = hosts.get('human')!
    const agentHost = hosts.get(agentRuntime.role)!

    if (room) {
      await requireAssistantRoom(turn.roomId, humanHost, agentHost, { forTurn: true })
      signal.throwIfAborted()
    }

    requireMatrixSessionChoice(
      state.rooms.find(item => item.id === turn.roomId),
      enrolled.identity.agentPrincipal
    )

    if (closing || agentRuntime.invocation) {
      throw new Error('matrix_not_ready')
    }

    const identity = enrolled.identity

    if (agentRuntime.executor && !agentRuntime.executor.usable) {
      await stopHermesExecutor(agentRuntime)
    }

    const selectedRuntime = runtime
    agentRuntime.executor ??= new MatrixHermesExecutor(
      executorSignal =>
        openAssistantHermes(
          selectedRuntime,
          { owner: identity.principal, executorId: identity.executorId },
          executorSignal,
          agentRuntime
        ),
      agentRuntime.store,
      observation => desktopServices?.turn(observation),
      matrixAgentSoulLifecycle(agentRuntime)
    )

    return { human, identity, humanHost, agentHost, executor: agentRuntime.executor }
  }

  const history = (turn: Readonly<MatrixLocalTurn>, humanHost: Host, agentHost: Host, signal: AbortSignal) =>
    conversationContinuity(
      { roomId: turn.roomId, before: turn.questionEventId, excludeTurn: turn.turnId },
      humanHost,
      agentHost,
      signal
    )

  return new MatrixLocalTurns({
    store: agentRuntime.store,
    scope: () => {
      const human = account?.identity()

      // S1: a cloud agent has no enrollment on this Mac; the roster names it.
      if (human && isCloudAgent(agentRuntime) && agentRuntime.userId && agentRuntime.agentPrincipal) {
        return { human, agentUserId: agentRuntime.userId, agentPrincipal: agentRuntime.agentPrincipal }
      }

      const enrolled = enrollmentOf(agentRuntime)

      return human && enrolled?.state === 'ready' && enrolled.identity
        ? { human, agentUserId: enrolled.identity.userId, agentPrincipal: enrolled.identity.agentPrincipal }
        : null
    },
    runnable: () =>
      agentRuntime.readiness?.current.phase === 'ready' &&
      !closing &&
      !operation &&
      !domainOperation &&
      !agentRuntime.operation,
    // Its Hermes is at work (a local turn, a phone message's turn, a model change): a message
    // sent meanwhile waits its turn, with no time limit (local-turn.ts waitLimitMs).
    busy: () => Boolean(agentRuntime.lock.holder),
    authority: () => {
      // Typed questions for a cloud-route agent always enter the room and shared invocation
      // ledger. A selected Mac's listener may claim them under its exact term; the direct local
      // turn path has no ledger row and could be cut as idle during policy yield.
      if (isCloudAgent(agentRuntime)) {
        return { kind: 'cloud' }
      }

      if (isMovingAgent(agentRuntime)) {
        return { kind: 'unavailable' }
      }

      const enrolled = enrollmentOf(agentRuntime).identity
      const held = enrolled ? agentRuntime.lease?.held(enrolled.executorId) : null

      // A migrated agent's answer goes through the platform's outbox, and only a turn on the platform's ledger can
      // be recorded there: it runs here under the platform's grant (claim, dispatch, complete), not under local
      // records. Its home is this Mac, so the platform grants it to the Mac that holds the lease.
      if (held && isMigratedAgent(agentRuntime)) {
        return { kind: 'platform' }
      }

      if (held) {
        return { kind: 'lease', signal: held.signal }
      }

      if (agentRuntime.lease?.current.state !== 'elsewhere') {
        return { kind: 'unavailable' }
      }

      // Another Mac answers this agent now. A guest copy hands the question to it, so the
      // agent answers with its home's memory, files and tools; the agent's home runs it here.
      return answersFromHome(agentRuntime) ? { kind: 'home' } : { kind: 'platform' }
    },
    lock: async (roomId, signal) => {
      const humanHost = hosts.get('human')
      const agentHost = hosts.get(agentRuntime.role)

      if (!humanHost || !agentHost) {
        throw new Error('matrix_not_ready')
      }

      await requireAssistantRoom(roomId, humanHost, agentHost, { forTurn: true })
      signal.throwIfAborted()

      return agentRuntime.lock.acquire(roomId, 'local', signal)
    },
    model: roomId => roomModel(roomId, agentRuntime),
    effort: roomId => roomEffort(roomId, agentRuntime),
    // Before a platform dispatch (local-turn.ts): the room re-read and the conversation made
    // ready, so a slow link sends the turn back to waiting instead of interrupting it unrun. The
    // conversation is made for a turn without a Store task; one with a task (known only after
    // dispatch) makes its own in its run, as before.
    prepare: async (turn, input) => {
      const { human, identity, humanHost, agentHost, executor } = await ready(turn, input.signal, true)

      const petSurface = await privatePetIntentSurface(
        agentRuntime,
        turn.roomId,
        humanHost,
        agentHost,
        input.signal,
        Boolean(turn.context)
      )

      const conversationKey = matrixConversationKey(
        identity,
        human,
        turn.roomId,
        undefined,
        undefined,
        petSurface,
        turn.profile
      )

      const conversation = await executor.prepare({
        conversationKey,
        petSurface,
        firstLearning: turn.profile === 'first_learning',
        signal: input.signal,
        continuity: history(turn, humanHost, agentHost, input.signal)
      })

      return { conversation, conversationKey, petSurface }
    },
    execute: async (turn, input) => {
      // Everything from here to the prompt is Hermes-free: a failure in it ran nothing, and the
      // run's tracker says so (turn-effects.ts). The executor takes it over from `run`.
      input.effects.attach()

      // A turn made ready before its dispatch had its room re-read then; nothing between the
      // dispatch and Hermes refuses for the room again.
      const { human, identity, humanHost, agentHost, executor } = await ready(turn, input.signal, !input.prepared)

      const abort = new AbortController()
      const signal = AbortSignal.any([input.signal, abort.signal])
      const prompts = new MatrixHermesPrompts(() => publish(state))
      agentRuntime.promptNotice = undefined

      const terminal = terminalReceiver(agentRuntime, turn.roomId)

      // Renewal and other-device inventory are server-owned. Refresh a missing
      // snapshot or crossed monthly boundary before making the paid/free choice.
      const currentStore = store?.snapshot()

      if (
        store &&
        (currentStore?.state !== 'ready' ||
          currentStore.entitlements.some(
            e =>
              (e.assistantId === null || e.assistantId === agentRuntime.assistantId) &&
              e.subscription &&
              Date.parse(e.subscription.renewAt) <= Date.now()
          ))
      ) {
        await store.refresh()
        signal.throwIfAborted()
      }

      const storeOwner = account.appScope()
      const storeLease = agentRuntime.lease?.held(identity.executorId)

      const storeTask = await prepareMatrixStoreContext({
        entitlements: store?.snapshot()?.entitlements ?? [],
        assistantId: agentRuntime.assistantId,
        executorId: identity.executorId,
        conversationId: turn.roomId,
        leaseToken: storeLease?.leaseToken,
        invocationId: input.invocationId,
        signal,
        current: () =>
          Boolean(
            storeOwner &&
            account.appScope()?.accountKey === storeOwner.accountKey &&
            account.appScope()?.generation === storeOwner.generation
          ),
        request: binding => account.storeRequest('tasks', signal, binding)
      })

      // What was made ready before dispatch holds for a turn without a Store task, on the runtime
      // that made it; otherwise (a task's own conversation, a restarted runtime) the run makes it.
      const prepared =
        input.prepared && !storeTask && executor.owns(input.prepared.conversation) ? input.prepared : undefined

      const petSurface = prepared
        ? prepared.petSurface
        : await privatePetIntentSurface(
            agentRuntime,
            turn.roomId,
            humanHost,
            agentHost,
            signal,
            Boolean(storeTask || turn.context)
          )

      const pending = executor.run({
        petSurface,
        ...(prepared ? { prepared: prepared.conversation } : {}),
        // What the person chose, applied to this conversation's Hermes session at the turn's start.
        effort: matrixTurnEffort(state.rooms, turn.roomId, turn.effort),
        sessionModel: sessionModelOf(agentRuntime),
        ...(input.onProgress || turn.profile === 'first_learning'
          ? {
              onProgress: event => {
                input.onProgress?.(event)

                if (turn.profile === 'first_learning' && event.kind === 'learning') {
                  firstRunProgress = { ...firstRunProgress, [event.source]: event.state }
                  publish(state)
                }
              }
            }
          : {}),
        ...(input.turnStyle ? { turnStyle: true } : {}),
        onTerminal: terminal.receive,
        onTerminalRead: terminal.read,
        onStoreDiscovery: (payload, requestSignal) =>
          agentStoreDiscovery({
            payload,
            read: () => account.storeRequest('catalog', requestSignal),
            current: () =>
              !requestSignal.aborted &&
              !closing &&
              Boolean(
                storeOwner &&
                account.appScope()?.accountKey === storeOwner.accountKey &&
                account.appScope()?.generation === storeOwner.generation
              )
          }),
        onAppsDiscovery: (event, payload, requestSignal) => {
          const current = () =>
            !requestSignal.aborted &&
            !closing &&
            Boolean(
              storeOwner &&
              account.appScope()?.accountKey === storeOwner.accountKey &&
              account.appScope()?.generation === storeOwner.generation
            )

          return agentAppsDiscovery({
            read: () => account.appRequest({}),
            current,
            ...(event === 'atum.apps.open.request'
              ? {
                  appId: (payload as { app_id?: unknown })?.app_id ?? '',
                  open: async appId => {
                    if (!matrixApps) {
                      throw Error('matrix_app_unavailable')
                    }

                    await matrixApps.refresh()

                    if (!current()) {
                      throw Error('matrix_app_unavailable')
                    }

                    await command({ kind: 'selectApp', appId })
                  }
                }
              : {})
            })
        },
        onAgentProfile: (payload, requestSignal) => {
          const originPrincipal = agentRuntime.agentPrincipal

          const current = () =>
            !requestSignal.aborted &&
            !closing &&
            Boolean(
              storeOwner &&
              account.appScope()?.accountKey === storeOwner.accountKey &&
              account.appScope()?.generation === storeOwner.generation
            )

          if (!originPrincipal) {
            return Promise.resolve({ error: 'unavailable' })
          }

          return manageMatrixAgentProfile(
            {
              originPrincipal,
              request: (profileRequest, profileSignal) => requestCanonicalAgentProfile(
                originPrincipal,
                profileRequest,
                profileSignal,
                current
              ),
              current,
              saved: applyCanonicalAgentProfile
            },
            payload,
            requestSignal
          )
        },
        onAgentTask: (payload, requestSignal) => {
          const originPrincipal = agentRuntime.agentPrincipal

          const current = () =>
            !requestSignal.aborted &&
            !closing &&
            Boolean(
              storeOwner &&
              account.appScope()?.accountKey === storeOwner.accountKey &&
              account.appScope()?.generation === storeOwner.generation
            )

          if (!originPrincipal) {
            return Promise.resolve({ error: 'unavailable' })
          }

          return manageMatrixAgentTask(
            {
              originPrincipal,
              ownerUserId: human.userId,
              roster: rosterSignal => account.agents(rosterSignal),
              command: (value, timeoutMs) => agentHost.queue.command(value, timeoutMs),
              current
            },
            payload,
            requestSignal
          )
        },
        onChats: (payload, requestSignal) =>
          requestAgentChats(agentRuntime, identity, storeOwner, payload, requestSignal),
        onMacSources: (payload, requestSignal) =>
          requestAgentMacSources(agentRuntime, identity, storeOwner, payload, requestSignal),
        conversationKey:
          prepared?.conversationKey ??
          matrixConversationKey(
            identity,
            human,
            turn.roomId,
            storeTask?.taskId,
            undefined,
            petSurface,
            turn.profile
          ),
        invocationId: input.invocationId,
        roomId: turn.roomId,
        // A reply's quote goes with the question as context; the turn's own text is unchanged.
        text: matrixTurnPrompt(turn),
        signal,
        continuity: history(turn, humanHost, agentHost, signal),
        // First learning is a normal funded turn: no shorter clock, iteration cap or inactivity
        // rule. Only its explicit read-only safety fence is narrower than an ordinary turn.
        deadlineAt: input.deadlineAt,
        timeoutMs: input.timeoutMs,
        ...(input.inactivityMs === undefined ? {} : { inactivityMs: input.inactivityMs }),
        firstLearning: turn.profile === 'first_learning',
        onProtectedFolderDenied: noteProtectedFolderDenied,
        ...(turn.profile === 'first_learning'
          ? {
              onToolStart: (name: string) => {
                if (!matrixFirstRunToolAllowed(name) && !abort.signal.aborted) {
                  console.warn('[Matrix] first learning reached a write-capable tool: stopped')
                  abort.abort()
                }
              }
            }
          : {}),
        // Its typing pauses while the run waits on its owner (an approval, a question).
        ask: matrixWorkingAsk(prompts.ask, input.work),
        onSubmit: input.onSubmit,
        effects: input.effects,
        onWebPreview: webPreviewReceiver(agentRuntime, turn.roomId, abort),
        onActivity: activity => {
          input.onActivity(activity)

          if (agentRuntime.invocation?.abort === abort && !abort.signal.aborted && !closing) {
            agentRuntime.invocation.activity = { ...activity, roomId: turn.roomId, turnId: turn.turnId }
            publish(state)
          }
        },
        onPromptNotice: reason => {
          if (agentRuntime.invocation?.abort === abort && !closing) {
            agentRuntime.promptNotice = { id: randomUUID(), roomId: turn.roomId, reason }
            publish(state)
          }
        }
      })

      agentRuntime.invocation = {
        abort,
        pending,
        prompts,
        roomId: turn.roomId,
        invocationId: input.invocationId,
        leaseSignal: storeLease?.signal,
        storeTask,
        model: matrixTurnModel(state.rooms, turn.roomId, turn.model),
        effort: matrixTurnEffort(state.rooms, turn.roomId, turn.effort)
      }
      publish(state)

      try {
        return await pending
      } catch (error) {
        abort.abort()

        // The person's Stop is final: this turn is never queued again and never reported as
        // unconfirmed (turn-effects.ts, matrixTurnSettlement).
        throw agentRuntime.invocation?.abort === abort && agentRuntime.invocation.stopRequested
          ? new Error(MATRIX_TURN_STOPPED, { cause: error })
          : error
      } finally {
        if (agentRuntime.invocation?.abort === abort) {
          agentRuntime.invocation = undefined
        }

        publish(state)
        void wallet?.refresh('turn')

        if (!agentRuntime.executor?.usable) {
          setTimeout(() => void startAssistantHermes(agentRuntime), 1_000)
        }
      }
    },
    platform: async (operation, turn, extra) => {
      const enrolled = enrollmentOf(agentRuntime).identity
      const human = account.identity()

      if (!enrolled || !human || !turn.questionEventId) {
        throw new Error('matrix_agent_unavailable')
      }

      if (operation === 'claim' || operation === 'dispatch') {
        const humanHost = hosts.get('human')
        const agentHost = hosts.get(agentRuntime.role)

        if (!humanHost || !agentHost) {
          throw new Error('matrix_not_ready')
        }

        await requireAssistantRoom(turn.roomId, humanHost, agentHost, { forTurn: true })
      }

      // This device's own question only: the binding names its event and this device.
      const binding = {
        roomId: turn.roomId,
        eventId: turn.questionEventId,
        executorId: enrolled.executorId,
        senderDevice: human.deviceId,
        requestHash: createHash('sha256').update(turn.text).digest('hex')
      }

      const value = await account.invocation({
        ...binding,
        operation,
        ...(extra.invocationId ? { invocationId: extra.invocationId } : {}),
        ...(extra.publishedEvent ? { publishedEvent: extra.publishedEvent } : {}),
        // A turn queued again: what the earlier run is known to have done (turn-effects.ts).
        ...(operation === 'requeue' ? { effect: extra.effect, tools: extra.tools ?? [] } : {})
      })

      return matrixGrant(value, {
        agent: enrolled,
        binding,
        capability: 'local-hermes-turn',
        // The platform answers a requeue with the fence of the new claim, not the spent one.
        invocationId: operation === 'requeue' ? undefined : extra.invocationId
      })
    },
    sendQuestion: async turn => {
      const humanHost = hosts.get('human')

      if (!humanHost) {
        throw new Error('matrix_sdk_unavailable')
      }

      const agentId = agentRuntime.userId

      if (!agentId) {
        throw new Error('matrix_agent_unavailable')
      }

      await requireAssistantConversation(
        () =>
          humanHost.queue.command({
            kind: 'readAssistantRoom',
            roomId: turn.roomId,
            ownerId: humanHost.identity.userId,
            agentId,
            forTurn: true
          }),
        () => !closing && hosts.get('human') === humanHost && agentRuntime.userId === agentId,
        () => conversationPending(agentRuntime)
      )

      if (closing || hosts.get('human') !== humanHost || agentRuntime.userId !== agentId) {
        throw new Error('matrix_not_ready')
      }

      // The turn marker (or the handoff marker), and a reply's relation (local-turn.ts).
      const question = matrixTurnQuestion(turn)
      // S1: a cloud agent's question carries this Mac's signed origin assertion.
      const origin = turn.route === 'cloud' ? await cloudOrigin(question, agentRuntime) : undefined

      const eventId = await observeMessage(() =>
        humanHost.queue.command(origin ? { ...question, origin } : question, 30_000)
      )

      if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
        throw new Error('matrix_send_failed')
      }

      if (turn.route === 'cloud') {
        deviceIdentity?.questionSent(question.transactionId, question.roomId, eventId)
      }

      return eventId
    },
    findQuestion: async turn => {
      const lookup = await findTurn(hosts.get('human'), turn, account.identity()?.userId, 'question')

      // Found after a restart: the origin minted for it is logged against that event.
      if (turn.route === 'cloud' && lookup.state === 'found') {
        deviceIdentity?.questionSent(turn.questionTxnId, turn.roomId, lookup.eventId)
      }

      return lookup
    },
    // A migrated agent's answer was sent by the platform's worker, which recorded it on the ledger: not acknowledged here.
    ledgerPublishes: invocationId => outboxedResult(agentRuntime, invocationId),
    publishAnswer: async (turn, input) => {
      const humanHost = hosts.get('human')
      const agentHost = hosts.get(agentRuntime.role)

      if (!humanHost || !agentHost?.ready || (!turn.answerText && !input.status)) {
        throw new Error('matrix_agent_unavailable')
      }

      await requireAssistantRoom(turn.roomId, humanHost, agentHost, { forTurn: true })

      // An answer too long for one message goes as its parts, one call each (local-turn.ts); the
      // pet's reply data rides on the last, where the answer ends. A turn that could not finish
      // says so in the owner's language instead, in the answer's place and under its transaction.
      const part = input.part
      const pet = !input.status && (!part || part.index === part.count - 1) ? matrixPetIntentEnvelope(turn.answerPet) : undefined
      const body = input.status
        ? matrixAgentStatusText(
            input.status,
            matrixHeldReplyLocale(undefined, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages())
          )
        : part
          ? part.body
          : turn.answerText!

      const eventId = await agentHost.queue.command(
        turn.profile === 'first_learning'
          ? {
              kind: 'publishCron',
              roomId: turn.roomId,
              body,
              runId: turn.turnId,
              jobId: MATRIX_FIRST_LEARNING_JOB_ID,
              ...(googleAssistant.marks(agentRuntime.role) ? { google: true as const } : {})
            }
          : {
              kind: 'publishResult',
              roomId: turn.roomId,
              eventId: input.questionEventId!,
              body,
              ...(pet ? { pet } : {}),
              invocationId: input.invocationId,
              transactionId: input.transactionId,
              turnId: turn.turnId,
              matrixTransactionId: part ? part.matrixTransactionId : turn.answerTxnId,
              ...(part ? { part: { index: part.index, count: part.count } } : {}),
              ...(input.status ? { status: input.status } : {}),
              ...(googleAssistant.marks(agentRuntime.role) ? { google: true as const } : {}),
              // A turn the platform's ledger holds (authority `platform`, its completed invocation): where a migrated
              // agent's worker records the published event. A turn on local records has no ledger row.
              ...(turn.authority === 'platform' && turn.platformInvocationId !== undefined && input.invocationId === turn.platformInvocationId
                ? { ledger: true as const }
                : {})
            },
        30_000
      )

      if (typeof eventId !== 'string' || !eventId.startsWith('$')) {
        throw new Error('matrix_send_failed')
      }

      return eventId
    },
    checking: async turn => {
      const agentHost = hosts.get(agentRuntime.role)

      if (!agentHost?.ready || !turn.questionEventId) {
        return
      }

      await agentHost.queue.command(
        {
          kind: 'publishNotice',
          roomId: turn.roomId,
          eventId: turn.questionEventId,
          body: matrixCheckingLine(
            matrixHeldReplyLocale(undefined, state.displayPreferences?.language?.value, app.getPreferredSystemLanguages())
          ),
          transactionId: `atum-ck-${createHash('sha256').update(JSON.stringify([turn.turnId, turn.roomId])).digest('hex')}`
        },
        30_000
      )
    },
    findAnswer: (turn, part) =>
      findTurn(hosts.get(agentRuntime.role), turn, enrollmentOf(agentRuntime).identity?.userId, 'answer', part),
    seen: (turn, proof) => {
      if (turn.questionEventId) {
        agentRuntime.signals?.seen(turn.roomId, turn.questionEventId, proof)
      }
    },
    work: turn => agentRuntime.signals?.work(turn.roomId),
    // What the owner sees while a Mac-typed run works (agent-turns/1.4), in the agent's private chat.
    // First learning has no owner question: only unthreaded assistant interims are published.
    progress: (turn, input) => {
      const agentHost = hosts.get(agentRuntime.role)
      const humanHost = hosts.get('human')

      if (!agentHost || !humanHost) {
        return undefined
      }

      const locale = matrixHeldReplyLocale(
        undefined,
        state.displayPreferences?.language?.value,
        app.getPreferredSystemLanguages()
      )

      const copy = matrixProgressCopy[locale]

      const current = () =>
        !input.signal.aborted &&
        !closing &&
        hosts.get('human') === humanHost &&
        hosts.get(agentRuntime.role) === agentHost &&
        agentHost.ready

      const port = {
        current,
        publish: async (command: MatrixNoticeEdit) => {
          await requireAssistantRoom(turn.roomId, humanHost, agentHost, { forTurn: true })

          if (!current()) {
            throw new Error('matrix_agent_unavailable')
          }

          return agentHost.queue.command({ kind: 'publishNotice', ...command }, 30_000) as Promise<string>
        },
        now: () => Date.now(),
        after: (milliseconds: number, run: () => void) => {
          const timer = setTimeout(run, milliseconds)
          timer.unref?.()

          return () => clearTimeout(timer)
        },
        log: (line: string) => console.warn(line)
      }

      const agentId = agentRuntime.userId ?? ''

      if (turn.profile === 'first_learning') {
        const target = { roomId: turn.roomId, eventId: `$first-learning-${turn.turnId}` }
        const interim = new MatrixInterimMessages(target, port, {
          privateChat: true,
          transactionFor: sequence =>
            matrixInterimTransaction(agentId, input.invocationId, turn.roomId, turn.turnId, sequence)
        })

        return {
          event: event => {
            if (event.kind === 'narration') {
              interim.offer(event.text)
            } else {
              interim.acknowledge([matrixFirstLearningStarting(locale)])
            }
          },
          end: answer => interim.end(answer)
        }
      }

      const target = { roomId: turn.roomId, eventId: input.questionEventId }

      return new MatrixTurnVoice(
        new MatrixProgressLine(target, port, {
          privateChat: true,
          heartbeatText: copy.heartbeat,
          transactionFor: generation =>
            matrixProgressNoticeTransaction(agentId, input.invocationId, turn.roomId, turn.turnId, generation)
        }),
        new MatrixInterimMessages(target, port, {
          privateChat: true,
          transactionFor: sequence =>
            matrixInterimTransaction(agentId, input.invocationId, turn.roomId, turn.turnId, sequence)
        }),
        locale
      )
    },
    diagnose: async (): Promise<MatrixLocalTurnNotice | undefined> => {
      const result = await checkAtumAi(AbortSignal.timeout(10_000), agentRuntime)

      if (result.ok) {
        return undefined
      }

      return result.code === 'offline'
        ? 'offline'
        : result.code === 'out_of_protons'
          ? 'out_of_protons'
          : 'ai_unavailable'
    },
    changed: () => {
      reconcileLease(agentRuntime)
      scheduleExecutionPolicyReconcile()
      publish(state)
    },
    log: line => console.warn(line)
  })
}

/** Blocks only an event can change (readiness.ts): the person's recovery key or approval, their
 * Reconnect, a new sign-in. Each of those starts the gate again; a timer would only repeat it. */
const MATRIX_EVENT_BLOCKS: ReadonlySet<string> = new Set([
  'recovery_required',
  'agent_reconnect_required',
  'device_replaced',
  // Only the person's sign-in mends it (pages wiring rechecks then); a timer would only start
  // and stop the agent's Hermes every minute, and could end a sign-in under way.
  'plan_sign_in'
])

/** A model check that waits on the person's plan sign-in (configureManagedModelLocked). */
const MATRIX_PLAN_SIGN_IN_CODES: ReadonlySet<string> = new Set([
  'matrix_plan_sign_in_required',
  'matrix_plan_sign_in_pending'
])

/** The five gate steps in order, then the watch (plan §4.5). */
function createReadiness(agentRuntime: MatrixAgentRuntime = defaultAgent): MatrixReadinessMonitor {
  return new (cloudAwareMonitor(agentRuntime))({
    waitsForEvent: MATRIX_EVENT_BLOCKS,
    gate: [
      {
        step: 'signed_in',
        check: async signal => {
          if (!account.identity()) {
            return readinessFail('signed_out')
          }

          // Ready once from the SDK cache or its first sync; a later chat outage is not a block.
          return (await waitUntil(() => humanPrepared && hosts.has('human'), 60_000, signal))
            ? readinessPass
            : readinessFail(state.state === 'error' ? 'chat_unavailable' : 'chat_unreachable')
        }
      },
      {
        step: 'assistant',
        check: async signal => {
          // Its executor is being replaced (agent-reenroll.ts): the replacement starts this gate
          // again when it is done.
          if (agentRuntime.reenrolling) {
            return readinessFail('agent_reconnecting')
          }

          // A replacement the person has to finish (or one an earlier launch left half done): the
          // one action is Reconnect, never a timer.
          if (agentRuntime.reconnectRequired || enrollmentOf(agentRuntime).state === 'revoking') {
            return readinessFail('agent_reconnect_required')
          }

          const authority = await admitMatrixEnrollmentSetup(
            () => enrollmentOf(agentRuntime),
            async () => {
              if (agentRuntime === defaultAgent) {
                const interactive = gateInteractive
                gateInteractive = false
                await setUpAssistant(interactive)
              } else {
                await setUpAgent(agentRuntime)
              }
            }
          )

          if (!authority.ok) {
            return authority
          }

          // The roster sync inside setup may have just placed the default in the cloud (a cold
          // first sign-in). Its local executor is not part of setup then: it is already answering
          // in the cloud, and waiting for a local host would report a setup failure for it.
          if (isCloudOnlyAgent(agentRuntime)) {
            return readinessPass
          }

          void reconcileOrphanedEnrollments()

          // Asked to wait (a 429 on enrollment): the gate stays on this step until then.
          const retryAt = agentRuntime === defaultAgent ? assistantSetupRetryAt : agentRuntime.setupRetryAt

          if (retryAt !== undefined && retryAt > Date.now()) {
            return { ok: false, code: 'rate_limited', retryAt }
          }

          const setup = agentRuntime === defaultAgent ? assistantSetupState : agentRuntime.setupState

          if (setup === 'action_required') {
            return readinessFail('action_required')
          }

          // The person's own ChatGPT (or other) plan needs signing in again: its own code, so the
          // chat and the indicator offer that sign-in instead of a bare "not ready".
          const block = matrixSetupBlock({
            setup,
            planSignIn: agentRuntime.planSignIn,
            enrolled: enrollmentOf(agentRuntime).state === 'ready'
          })

          if (block) {
            return readinessFail(block)
          }

          if (!(await waitUntil(() => Boolean(hosts.get(agentRuntime.role)?.ready), 30_000, signal))) {
            return readinessFail('assistant_unreachable')
          }

          // Trust only serves encrypted rooms now (0.20): it runs in the background and never
          // holds the agent's readiness. Plain agent rooms need no keys.
          backgroundAgentTrust(
            () => ensureAgentTrust(agentRuntime),
            'readiness',
            line => console.warn(line)
          )

          return readinessPass
        }
      },
      {
        step: 'hermes',
        check: async signal => {
          // Its Hermes is the cloud's (S1): the roster serves it, and this Mac starts nothing.
          if (isCloudOnlyAgent(agentRuntime)) {
            return readinessPass
          }

          if (!runtime) {
            return readinessFail(runtimeInvalid ? 'runtime_invalid' : 'runtime_unavailable')
          }

          if (await startAssistantHermes(agentRuntime)) {
            return readinessPass
          }

          // The first start after launch is sometimes cut short (SIGTERM before its port
          // announcement): one quiet retry before this step blocks.
          await waitUntil(() => false, 3_000, signal)

          return (await startAssistantHermes(agentRuntime)) ? readinessPass : readinessFail('hermes_unavailable')
        }
      },
      {
        step: 'ai',
        check: signal =>
          isCloudOnlyAgent(agentRuntime) ? Promise.resolve(readinessPass) : checkAtumAi(signal, agentRuntime)
      },
      {
        step: 'authority',
        check: async signal => {
          // The cloud holds the answering lease (S1): this Mac has nothing to enroll or claim.
          if (isCloudOnlyAgent(agentRuntime)) {
            return readinessPass
          }

          const authority = matrixEnrollmentAuthority(enrollmentOf(agentRuntime))

          if (!authority.ok) {
            return authority
          }

          const enrolled = enrollmentOf(agentRuntime).identity

          if (!enrolled || !agentRuntime.lease) {
            return readinessFail('platform_unavailable')
          }

          reconcileLease(agentRuntime)
          await waitUntil(() => !['stopped', 'acquiring'].includes(agentRuntime.lease!.current.state), 20_000, signal)

          return leaseReady(agentRuntime)
        }
      }
    ],
    watch: [
      { step: 'ai', check: signal => checkAtumAi(signal, agentRuntime) },
      { step: 'authority', check: async () => leaseReady(agentRuntime) },
      {
        step: 'hermes',
        check: async () => {
          if (agentRuntime.executor?.usable || (agentRuntime.invocation && !agentRuntime.invocation.app)) {
            return readinessPass
          }

          // Retired after a failed turn: started again in the background.
          void startAssistantHermes(agentRuntime)

          return readinessFail('hermes_unavailable')
        }
      },
      ...(agentRuntime === defaultAgent
        ? [
            {
              // Optional roster recovery runs last so a slow platform read cannot delay
              // the authority/runtime probes. Failure preserves every cached identity.
              step: 'assistant' as const,
              nonBlocking: true,
              check: () => syncAgents()
            }
          ]
        : [])
    ],
    onChange: readiness => {
      logLaunchExclusion(agentRuntime, readiness)
      agentRuntime.localTurns?.kick()
      publish(state)
    },
    log: line => console.warn(line)
  })
}

/** One line when an agent other than the primary stops its gate and so no longer holds the cold
 * start (readiness.ts `matrixLaunchExclusionLine`); its retries of the same stop add none. */
function logLaunchExclusion(agentRuntime: MatrixAgentRuntime, readiness: MatrixReadiness): void {
  const primary = productAgent()

  const line =
    primary && agentRuntime !== primary
      ? matrixLaunchExclusionLine(agentRuntime.principal ?? 'root', readiness)
      : undefined

  if (line && line !== agentRuntime.launchExclusionLogged) {
    console.warn(line)
  }

  agentRuntime.launchExclusionLogged = line
}

/** The readiness monitor for an agent that may answer in the cloud (below). */
function cloudAwareMonitor(agentRuntime: MatrixAgentRuntime): typeof MatrixReadinessMonitor {
  return class extends MatrixReadinessMonitor {
    constructor(options: ConstructorParameters<typeof MatrixReadinessMonitor>[0]) {
      super(cloudAwareReadiness(agentRuntime, options))
    }
  }
}

/**
 * S1: while the cloud is the answering destination, an agent needs only its owner signed in on
 * this Mac (the questions go through the owner's own SDK). A policy may keep a standby Hermes
 * here for failover, but that optional local provider does not become chat readiness until this
 * Mac holds the answering term.
 */
function cloudAwareReadiness(
  agentRuntime: MatrixAgentRuntime,
  options: ConstructorParameters<typeof MatrixReadinessMonitor>[0]
): ConstructorParameters<typeof MatrixReadinessMonitor>[0] {
  const cloudOnly = () =>
    isCloudOnlyAgent(agentRuntime) ||
    !matrixCloudAgentNeedsLocalReadiness({
      cloudRoute: isCloudAgent(agentRuntime),
      role: cloudAgentMacRole(agentRuntime)
    })

  return {
    ...options,
    gate: matrixCloudOnlyReadiness(options.gate, cloudOnly),
    watch: matrixCloudOnlyReadiness(options.watch, cloudOnly)
  }
}

/** What the launch-time model check did: ran (`checked`), found the profile exactly as its
 * last check left Atum's model (`unchanged`, model-check.ts), or had nothing to do now (no
 * managed model, or a live turn owns the executor). */
type MatrixModelCheckOutcome = MatrixModelCheckRun | 'not_needed'

const modelCheckNote = (outcome: MatrixModelCheckOutcome) =>
  ({
    checked: 'model checked',
    unchanged: 'model unchanged since its last check',
    not_needed: 'model check not needed now'
  })[outcome]

/** Atum's model by default, like the old app; a model the person chose is kept. */
async function configureManagedModel(
  agentRuntime: MatrixAgentRuntime = defaultAgent
): Promise<MatrixModelCheckOutcome> {
  const release = await agentRuntime.lock.acquire('*', 'configure')

  try {
    return await configureManagedModelLocked(agentRuntime)
  } finally {
    release()
  }
}

async function configureManagedModelLocked(
  agentRuntime: MatrixAgentRuntime = defaultAgent
): Promise<MatrixModelCheckOutcome> {
  if (agentRuntime.closed || lifecycle.blocksRuntime(agentRuntime.principal)) {
    throw new Error('matrix_agent_unavailable')
  }

  const enrollment = enrollmentOf(agentRuntime)

  if (!matrixEnrollmentAuthority(enrollment).ok) {
    throw new Error('matrix_authority_withdrawn')
  }

  const apiKey = account.managedModelKey(agentRuntime.principal)

  // No managed model (bring-your-own), or a live turn already owns the executor.
  if (!managedModel || agentRuntime.invocation) {
    return 'not_needed'
  }

  // The person is approving an account plan sign-in: a model check shares that auth store and
  // must wait whether the sign-in runs on the agent backend or the placement-independent account
  // management runtime.
  if (matrixSubscriptionPlanSignInGate(agentRuntime) === 'pending') {
    throw new Error('matrix_plan_sign_in_pending')
  }

  // Said again by this check: a check that fails for another reason is not a sign-in to ask for.
  agentRuntime.planSignIn = false

  if (!runtime || enrollment.state !== 'ready' || !enrollment.identity || !apiKey) {
    throw new Error(runtime ? 'matrix_setup_failed' : 'matrix_runtime_unavailable')
  }

  const identity = enrollment.identity
  const selectedRuntime = runtime
  const proxy = { baseUrl: managedModel.baseUrl, apiKey, model: MATRIX_DEFAULT_MODEL }
  const abort = new AbortController()
  const executorId = identity.executorId
  agentRuntime.ownModel = readOwnModel(executorId, agentRuntime)

  const check: MatrixModelCheckContext = {
    store: agentRuntime.store,
    executorId,
    build: `${app.getVersion()}+${buildRevision}`,
    writes: MATRIX_MODEL_CHECK_WRITES,
    proxy,
    readConfig: () => readFileSync(path.join(agentHermesHome(agentRuntime, identity, selectedRuntime), 'config.yaml'))
  }

  // Atum's model, in a profile exactly as the last check left it: no second Hermes to start
  // before the agent's own (G1-13). Otherwise the check runs on its own Hermes.
  return runMatrixModelCheck({
    context: check,
    ownModel: agentRuntime.ownModel,
    begin: () => {
      const pending = stopHermesExecutor(agentRuntime).then(() => {
        if (!matrixEnrollmentAuthority(enrollmentOf(agentRuntime)).ok) {
          throw new Error('matrix_authority_withdrawn')
        }

        return withMatrixHermes(
          selectedRuntime,
          {
            owner: identity.principal,
            executorId,
            signal: abort.signal,
            home: agentHermesHome(agentRuntime, identity, selectedRuntime),
            sharedCodex: sharedCodexHere()
          },
          async connection => {
            const prepared = await prepareMatrixHermesModel(connection, proxy, abort.signal)
            rememberOwnModel(executorId, prepared.ownModel, agentRuntime, prepared.connected)
            // The person's own plan needs signing in again: said as that, never a bare "not ready".
            agentRuntime.planSignIn = prepared.readiness.state !== 'ready' && Boolean(prepared.planSignIn)

            if (matrixSubscriptionPlanSignInGate(agentRuntime) === 'required') {
              throw new Error('matrix_plan_sign_in_required')
            }

            const full = await ensureFullHermes(connection, executorId, abort.signal, agentRuntime)

            return { ready: prepared.readiness.state === 'ready', atum: !prepared.ownModel && full !== 'failed' }
          }
        )
      })

      // The check never uses a Matrix host, so a host that is still starting does not end it.
      agentRuntime.invocation = { abort, pending, setup: true }
      publish(state)

      return pending
    },
    end: () => {
      if (agentRuntime.invocation?.abort === abort) {
        agentRuntime.invocation = undefined
      }
    },
    alive: () => !agentRuntime.closed,
    log: line => console.warn(line)
  })
}

async function startSdk() {
  await startHost('human')

  if (account.identity()) {
    // Reconcile account gates; only pending OFF choices keep retrying with bounded backoff.
    sourceGateSync?.reconcile()
    // A prior DELETE may have durably entered `revoking` before its MAS session existed. The
    // authoritative list survives a desktop restart, so this sweep finishes that old intent.
    void cloudEnrollments?.sweepRevocations(AbortSignal.timeout(30_000))
  }

  if (account.identity() && !account.sessionEnded() && !account.signOutPending()) {
    await deviceBootstrap?.accountReady(deviceLaunch).catch(() => console.warn('[Device] service not running'))
  }

  brainActive = true
  syncLocalBrain(state.identity, true)

  if (config.domain && hosts.has('human')) {
    // On an existing account the root slot may no longer be the product default.
    // Read the authoritative role even if that slot cannot start its SDK.
    if (account.appScope()) {
      setAgentRosterReadiness('loading')
      publish(state)
      agentRoster.request()
      await syncAgents()
    }

    try {
      if (!unusedRoot()) {
        await startHost('agent')
      }
    } catch {
      // Agent/domain failure must not relabel or stop a healthy Matrix account.
      // Enrollment metadata is not reader readiness; execution remains disabled.
      await stopHost('agent')
    }
  }
}

/**
 * The sign-in server ended the person's chat session (it refused this Mac's grant;
 * account.sessionEnded). Everything that answers or listens pauses and the window asks the
 * same person to sign in again, on the compact sign-in with "You were signed out on this
 * Mac". Nothing is revoked or forgotten: the account, its agents with their homes and
 * preferences stay for that sign-in, which resumes them (signIn below).
 */
function endChatSession(): Promise<void> {
  sessionEnding ??= (async () => {
    ownerDeviceRepair = undefined
    deviceControlOwner = undefined
    matrixDeviceStopFence?.('sign_out')
    deviceIdentity?.signOut('sign_out')
    executionDeviceNames.invalidate()
    scheduleContinuousListening()
    cloudEnrollments?.stop()
    const deviceStop = deviceBootstrap?.signedOut()
    console.warn('[Matrix] chat session ended; asking the person to sign in again')
    startupState = undefined

    for (const each of allAgents()) {
      each.readiness?.stop()
      void each.lease?.stop()
      stopListening('cancelled', each)
      each.localTurns?.stop()
      each.signals?.stop()
    }

    publish(matrixSessionEndedSnapshot(state))
    await stopSdk().catch(() => console.warn('[Matrix] chat engine cleanup failed after the session ended'))
    await deviceStop?.catch(() => console.warn('[Device] service cleanup failed'))
  })().finally(() => {
    sessionEnding = undefined
  })

  return sessionEnding
}

/**
 * The homeserver refused the person's engine's token, which alone proves nothing: main asks
 * the sign-in server (account.confirmSession). Its refusal ends the session; a new token, or
 * no answer, restarts the engine, which stopped on that refusal and asks again by itself.
 * Refused again within a minute of that restart, it stops there (session-route.ts).
 */
function confirmChatSession(host: Host): Promise<void> {
  sessionCheck ??= (async () => {
    console.warn('[Matrix] chat token refused; asking the sign-in server')
    const result = await account.confirmSession()

    if (closing || hosts.get('human') !== host) {
      return
    }

    const action = matrixSessionAction(result, 'main', sessionRestartedAt)

    if (action === 'session_ended') {
      await endChatSession()
    } else if (action === 'restart') {
      sessionRestartedAt = Date.now()
      console.warn(
        `[Matrix] chat engine restarting after a refused token${result.ok === false ? ` cause=${result.cause ?? 'unknown'}` : ''}`
      )
      await stopHost('human')
      await startHost('human')
    } else if (action === 'stopped') {
      console.warn('[Matrix] chat engine stopped: the homeserver refused a fresh token again')
      publish({ ...state, state: 'error', error: 'matrix_sdk_stopped' })
    } else if (action === 'disk_full') {
      // Restarting can't help: the new token waits for room on the disk (account.ts
      // HeldRotation). The window says so; the save landing restarts the engine (renewed).
      console.warn('[Matrix] chat engine waiting: the disk is too full to save its sign-in')
      await stopHost('human')

      if (!closing && state.identity) {
        publish({ ...state, state: 'error', error: 'matrix_disk_full' })
      }
    }
  })()
    .catch(() => {
      console.warn('[Matrix] chat session check failed')

      // The engine is down and did not come back: say so, with Try again.
      if (!closing && state.identity && !hosts.has('human')) {
        publish({ ...state, state: 'error', error: 'matrix_sdk_stopped' })
      }
    })
    .finally(() => {
      sessionCheck = undefined
    })

  return sessionCheck
}

/**
 * The person's chat sign-in rotated while the vault could not save it, and is saved now
 * (account.ts HeldRotation). An engine that stopped on the wait (Couldn't open your chats)
 * starts again without Try again; one still running or reconnecting takes a token at its own
 * next refresh, and an operation or a session check in progress owns the window.
 */
async function resumeChatAfterSave() {
  // A session check or ending in flight decides first; what it leaves is looked at after.
  await sessionCheck
  await sessionEnding

  if (
    closing ||
    operation ||
    !state.identity ||
    state.state !== 'error' ||
    !['matrix_sdk_stopped', 'matrix_sdk_start_failed', 'matrix_signed_out', 'matrix_disk_full'].includes(
      state.error ?? ''
    ) ||
    account.signOutPending()
  ) {
    return
  }

  console.warn('[Matrix] chat engine restarting: its sign-in is saved again')
  sessionRestartedAt = undefined
  await stopHost('human')
  await startHost('human')
}

/** Back to the app after a browser trip, like the old atum:// return. */
function bringToFront() {
  if (closing || !ui || ui.isDestroyed()) {
    return
  }

  ui.show()
  ui.focus()

  if (process.platform === 'darwin') {
    app.focus({ steal: true })
  }
}

/** The error a signed-out window keeps: the ended session's notice, while that account waits. */
function signedOutNotice(): string | null {
  return matrixEndedSession(account) ? 'matrix_session_ended' : null
}

/** "Check for Updates…": checks now, then says what it found once the check settles. A
 * downloaded update can restart from here; the sidebar's Update control stays the other way. */
async function checkForUpdatesFromMenu(locale: DesktopLocale) {
  const services = desktopServices

  if (!services) {
    return
  }

  const started = services.checkUpdates()
  const deadline = Date.now() + 60_000
  let seenChecking = false
  let status = services.status()

  while (Date.now() < deadline) {
    status = services.status()

    if (status.update.state === 'checking') {
      seenChecking = true
    } else if (
      seenChecking ||
      ['downloading', 'downloaded', 'error'].includes(status.update.state) ||
      (!started && status.update.state === 'unavailable')
    ) {
      break
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const answer = matrixUpdateCheckMessage({
    locale,
    state: status.update.state,
    current: app.getVersion(),
    next: status.update.version,
    busy: status.busy
  })

  if (!answer || closing) {
    return
  }

  const options = {
    type: 'info' as const,
    message: answer.message,
    buttons: answer.buttons,
    defaultId: 0,
    cancelId: answer.buttons.length - 1
  }

  const choice =
    ui && !ui.isDestroyed() ? await dialog.showMessageBox(ui, options) : await dialog.showMessageBox(options)

  if (answer.restart && choice.response === 0) {
    void services.restart()
  }
}

async function start() {
  // Tagged main-process warnings to main.log for diagnosis (app-identity.ts pins the folder).
  mirrorTaggedConsole(app.getPath('logs'))
  registerAtumKeepAwake()
  deviceLaunch = process.platform === 'darwin' ? deviceLaunchFrom(app.getLoginItemSettings()) : 'interactive'
  appMenu.apply(state)

  let revision = 'development'

  try {
    const stamp = JSON.parse(readFileSync(path.join(assets, 'matrix-build-stamp.json'), 'utf8'))

    if (/^[a-f0-9]{40}$/.test(stamp.commit)) {
      revision = stamp.commit
    }
  } catch {
    /* Unbundled development has no stamped release. */
  }

  buildRevision = revision

  updateHandoff = app.isPackaged && process.platform === 'darwin'
    ? createUpdateHandoff({
        directory: path.join(app.getPath('userData'), 'update-handoff'),
        currentVersion: app.getVersion(),
        bundlePath: path.resolve(process.resourcesPath, '..', '..'),
        stageProgress: path.join(app.getPath('home'), 'Library', 'Caches', 'com.atum.matrix-candidate', 'staged-swap', 'progress.log'),
        shipItLog: path.join(app.getPath('home'), 'Library', 'Caches', 'com.atum.matrix-candidate.ShipIt', 'ShipIt_stderr.log'),
        pid: process.pid,
        locale: windowLocale,
        bounds: () => (ui && !ui.isDestroyed() && !ui.isFullScreen() ? ui.getNormalBounds() : null),
        log: message => console.warn(message)
      })
    : null
  previousRestart = updateHandoff?.consume() ?? null

  // A staged update that rolled back is reported once; after that automatic checks carry on.
  if (app.isPackaged && process.platform === 'darwin' &&
    consumeFailureNotice(stageRoot(app.getPath('home'), STAGED_APP_ID), app.getVersion())) {
    previousRestart = { outcome: 'not_updated', fromVersion: app.getVersion(), toVersion: app.getVersion(), startedAt: Date.now(), bounds: null }
  }

  desktopServices = new MatrixDesktopServices({
    configPath: path.join(process.resourcesPath, 'atum-desktop-services.json'),
    applicationIdentifier: 'com.atum.matrix-candidate',
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    version: app.getVersion(),
    revision,
    packaged: app.isPackaged,
    supported: process.platform === 'darwin' && process.arch === 'arm64',
    busy: () => closing || anyOperation() || domainOperation || allAgents().some(each => Boolean(each.invocation)),
    quit: () => app.quit(),
    bundlePath: path.resolve(process.resourcesPath, '..', '..'),
    temporaryPath: app.getPath('temp'),
    forceExit: () => {localBrain?.killNow(); ownedBackgroundChildren.killNow(); app.exit(0)},
    beforeInstall: () => {
      closing = true

      // Document persistence already completed; hidden SDK windows and renderer
      // beforeunload handlers must not veto the native installation handoff.
      for (const window of BrowserWindow.getAllWindows()) {window.destroy()}
    },
    previousRestart,
    restartFeedback: updateHandoff ?? undefined,
    resetClosing: () => {closing = false},
    changed: status => {
      if (ui && !ui.isDestroyed()) {
        ui.webContents.send(MATRIX_DESKTOP_SERVICES.changed, status)
      }
    },
    loadUpdater: async () => {
      if (stagedRecoveryFailed) {throw new Error('The update did not finish; signed backup retained and updates paused')}

      const staged = app.isPackaged && process.platform === 'darwin' && process.arch === 'arm64'
      const stagedEnabled = () => stagedSwapEnabled(path.join(app.getPath('userData'), 'updates.json'))

      // Prepared swap is the normal path. A literal `updates.stagedSwap: false` is the rollback
      // switch for this Mac; legacy settings without the field stay on the default.
      if (!staged || !stagedEnabled()) {
        // Switched off (or never on): drop any staged copy left behind. Best effort, off the launch path.
        if (staged) {void cleanStaleStages({ home: app.getPath('home'), id: STAGED_APP_ID }).catch(() => undefined)}

        return appUpdater
      }

      return new StagedMacUpdater({
        fallback: appUpdater,
        home: app.getPath('home'),
        id: STAGED_APP_ID,
        target: path.resolve(process.resourcesPath, '..', '..'),
        version: app.getVersion(),
        handoffDirectory: path.join(app.getPath('userData'), 'update-handoff'),
        enabled: stagedEnabled,
        exit: relaunch => {
          if (relaunch) {app.relaunch()}
          app.exit(0)
        },
        reportInstallFailure: () => desktopServices?.capture({ name: 'update_failed', properties: { stage: 'install', code: 'failed' } }),
        log: line => console.warn(line)
      })
    },
    nativeUpdater: nativeAutoUpdater,
    locale: windowLocale,
    updaterLogger: console,
    setInterval: (callback, delay) => setInterval(callback, delay).unref(),
    log: message => console.warn(message),
    createSink: options => createReportingSink({ ...options, fetch: fetchMatrixReporting })
  })
  app.on('browser-window-blur', () => desktopServices?.inactive())
  app.on('browser-window-focus', () => desktopServices?.resumed())
  installMatrixDesktopServicesIpc({
    services: desktopServices,
    ipc: ipcMain,
    requireUi: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    requireDiagnostic: event => {
      if (event.sender === ui?.webContents) {
        return requireMatrixCaller(event, ui.webContents, UI_URL)
      }

      if (hermesPages?.acceptsDiagnostics(event)) {
        return
      }

      requireHost(event)
    }
  })
  await desktopServices.start()

  const loginStartup = new MatrixLoginStartup({
    app,
    openExternal: (url, options) => shell.openExternal(url, options),
    platform: process.platform,
    packaged: app.isPackaged,
    memory: fileLoginStartupMemory(path.join(app.getPath('userData'), 'login-startup.json'))
  })

  // Open at login is on by default, once per Mac (login-startup.ts applyDefault).
  loginStartup.applyDefault()
  registerMatrixLoginStartupIpc(ipcMain, loginStartup, event => requireMatrixCaller(event, ui?.webContents, UI_URL))
  // Import browser logins (Settings › Connections): Chrome on this Mac to the primary agent's computer, one Touch ID.
  registerBrowserImportIpc(
    ipcMain,
    createBrowserImport({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      identity: () => deviceIdentity,
      call: (send, signal) => account.s1Request(send, signal),
      owner: () => account?.identity()?.userId ?? null,
      primaryAgent: () => {
        const agent = productAgent()
        const principal = cloudPrincipal(agent)

        return agent && principal ? { principal, ...(agent.name ? { name: agent.name } : {}) } : null
      },
      locale: deviceLocale,
      setPaused: paused => deviceBootstrap?.setPaused(paused),
      log: line => console.warn(line)
    }),
    event => requireMatrixCaller(event, ui?.webContents, UI_URL)
  )
  registerMatrixProfilesIpc(ipcMain, profiles, event => requireMatrixCaller(event, ui?.webContents, UI_URL))
  registerMatrixMemberAvatarIpc(
    ipcMain,
    async userId => {
      const host = hosts.get('human')
      const id = typeof userId === 'string' ? userId : ''
      const roomId = matrixMemberAvatarRoom(state, id)

      if (!host || !roomId || closing || !matrixHumanSdkReady(state.state, host)) {
        return null
      }

      try {
        const value = (await host.queue.command({ kind: 'memberAvatar', roomId, userId: id }, 60_000)) as {
          userId?: unknown
          avatarUrl?: unknown
        } | null

        if (value?.userId !== id) {
          return null
        }

        if (value.avatarUrl === null) {
          return { userId: id, avatarUrl: null }
        }

        return typeof value.avatarUrl === 'string' &&
          value.avatarUrl.startsWith('data:image/') &&
          value.avatarUrl.length <= 4_000_000
          ? { userId: id, avatarUrl: value.avatarUrl }
          : null
      } catch {
        return null
      }
    },
    event => requireMatrixCaller(event, ui?.webContents, UI_URL)
  )
  // Link previews under messages in plain chats: the person's own SDK asks its homeserver.
  registerMatrixLinkPreviewIpc(
    ipcMain,
    () => state,
    async target => {
      const host = hosts.get('human')

      return host && !closing && matrixHumanSdkReady(state.state, host)
        ? host.queue.command({ kind: 'linkPreview', ...target }, 30_000)
        : null
    },
    event => requireMatrixCaller(event, ui?.webContents, UI_URL)
  )
  registerMatrixAssistantCardsIpc(ipcMain, assistantCards, event => requireMatrixCaller(event, ui?.webContents, UI_URL))
  registerMatrixAgentRoutinesIpc(ipcMain, agentRoutines, event => requireMatrixCaller(event, ui?.webContents, UI_URL))
  process.on('uncaughtExceptionMonitor', error => {
    desktopServices?.error({ operation: 'main', kind: error.name, stack: error.stack })
    desktopServices?.crashed()
  })
  app.on('render-process-gone', (_event, contents, details) => {
    if (
      contents === ui?.webContents ||
      [...hosts.values()].some(host => host.window.webContents === contents) ||
      hermesPages?.acceptsDiagnostics({ sender: contents, senderFrame: contents.mainFrame })
    ) {
      const services = desktopServices

      if (services) {
        reportRendererGone(
          services,
          details,
          contents === ui?.webContents ? { crashSession: () => services.crashed({ delivered: true }) } : {}
        )
      }
    }
  })
  app.on('child-process-gone', (_event, details) => {
    if (desktopServices) {
      reportChildProcessGone(desktopServices, details)
    }
  })

  try {
    runtime = selectMatrixHermesRuntime({
      packaged: app.isPackaged,
      resources: process.resourcesPath,
      assets,
      userData: app.getPath('userData'),
      developmentFile: option('matrix-hermes')
    })
  } catch (error) {
    // An invalid runtime must disable execution, not blank the chat/auth window
    // or fall back to mutable PATH/developer installations.
    runtimeInvalid = true
    console.warn('[Matrix] Hermes runtime unavailable:', matrixRuntimeFailureCode(error))
  }

  if (runtime) {
    // A backend that ends without a clean, intentional stop is a reported failure.
    // The report is a closed class only; logs stay local.
    runtime.onExit = exit => {
      if (desktopServices) {
        reportBackendExit(desktopServices, exit)
      }
    }

    // Read once, natively, when the first Hermes starts: each agent's "Where you run" section
    // names this Mac (hermes-runtime.ts ATUM_MAC_NAME).
    let macName: string | undefined
    runtime.macName = () => (macName ??= macComputerName())
    workspaceStartup = new MatrixWorkspaceStartup({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      runtime,
      roots: matrixWorkspaceDriveRoots,
      quiescent: () =>
        !closing &&
        allAgents().every(
          agent =>
            !agent.executor &&
            !agent.starting &&
            !agent.invocation &&
            !agent.lock.holder &&
            !agent.localTurns?.executionPending
        ),
      log: reason => console.warn(`[Matrix] ${reason}`)
    })
  }

  isolationPolicy = new MatrixDeviceIsolationPolicy(
    new EncryptedStore(path.join(app.getPath('userData'), 'device', 'device-isolation.json'), safeStorage)
  )
  outcomeStore = new EncryptedStore(path.join(app.getPath('userData'), 'outcomes.json'), safeStorage)
  pendingMatrixDrafts = new PendingMatrixDrafts(
    new EncryptedStore(path.join(app.getPath('userData'), 'drafts.pending.json'), safeStorage)
  )
  appBotTrustStore = new EncryptedStore(path.join(app.getPath('userData'), 'app-bot-trust.json'), safeStorage)
  // S1 WS-3b: this Mac's device service and the owner side of cloud enrollments.
  deviceIdentity = createDeviceIdentity()
  cloudEnrollments = createCloudEnrollments()
  // Which Mac an agent lives on (atum.agent-home/2.1). Inert for a signed-out account, for an agent the
  // platform has not placed under the model, and against a platform that has no such routes.
  agentHome = createAgentHome(deviceIdentity)
  agentHome.service.start()
  deviceBootstrap = new DeviceServiceBootstrap({
    createRuntime: buildDeviceRuntime,
    connection: () => deviceIdentity?.connection() ?? null,
    ipc: ipcMain,
    requireCaller: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    registerFence: fence =>
      registerMatrixDeviceStopFence(
        fence
          ? reason => {
              deviceNativeUi?.cancelAll()
              fence(reason)
            }
          : null
      ),
    log: line => console.warn(line)
  })
  deviceBootstrap.install()
  powerMonitor.on('suspend', () => {
    void ownPresence.away()
    desktopServices?.inactive()
    // Stop admitting work before the device connection's epoch is fenced. An active v2 term
    // becomes yielding and keeps its exact signal until that turn settles or its original deadline.
    void drainMatrixRuntimes(allAgents(), { holdOperations: false, reason: 'unavailable' })
    matrixDeviceStopFence?.('sleep')
    deviceIdentity?.suspend()
  })
  powerMonitor.on('resume', () => {
    desktopServices?.resumed()
    deviceIdentity?.resume()
    void reconcileDeviceControl(true)
    drive?.recoverConnectivity(true)
    void ownPresence.refresh()
  })
  // A locked screen locks the keybag class a Mac's older identity key lives in, so the device channel
  // cannot sign until the owner unlocks (the `device_key_failed` nights, 2026-10-12→19): dial the moment
  // it does instead of waiting out the backoff.
  powerMonitor.on('lock-screen', () => {
    void ownPresence.away()
    desktopServices?.inactive()
  })
  powerMonitor.on('unlock-screen', () => {
    desktopServices?.resumed()
    deviceIdentity?.resume()
    void reconcileDeviceControl(true)
    drive?.recoverConnectivity(true)
    void ownPresence.refresh()
  })
  // Every signed-in owner keeps this Mac enrolled and connected. The cadence checks server truth
  // and retries a transient failure without prompting.
  setInterval(() => {
    if (!closing && account?.identity()) {
      void reconcileDeviceControl()
    }

    if ((cloudAgents.size || config.cloudMigrationTestAgents?.length) && !closing && account?.identity()) {
      try {
        homeMigrationForOwner()
      } catch {
        return
      }
    }
  }, 15_000).unref()
  setInterval(() => {
    if (migrationTickRunning || closing || !account?.identity()) {
      return
    }

    migrationTickRunning = true

    void (async () => {
      try {
        await homeMigrationForOwner()?.client.tick()
      } catch {
        console.warn('[Device] migration hold remains active')
      } finally {
        migrationTickRunning = false
      }
    })()
  }, 1_000).unref()

  // The operator's single-shot trigger for the owner's home move (operator-move.ts). It lives in
  // the app's private data folder, is gated by the same allow-list as the migration itself and by
  // the agent being ready, and has no IPC or UI surface.
  const operatorMoveTick = operatorMoveTicker(() => {
    const allowed = config.cloudMigrationTestAgents

    if (!allowed?.length || closing || !account?.identity()) {
      return null
    }

    const moveTarget = (principal: string) => allAgents().find(each => cloudPrincipal(each) === principal)

    return {
      // Beside the operator's public-config.json, not under userData (operatorMoveDirectory).
      directory: operatorMoveDirectory(app.getPath('appData')),
      allowed,
      files: nodeOperatorFiles(),
      // While the roster still calls the agent a cloud agent the move refuses to start (its saved
      // policy has cloud on), so the trigger waits for the roster to say local, with a home bound.
      ready: principal => {
        try {
          const agent = moveTarget(principal)

          return Boolean(
            agent &&
              agent.userId &&
              !agent.closed &&
              !isCloudAgent(agent) &&
              !isMovingAgent(agent) &&
              cloudEnrollments &&
              deviceIdentity &&
              migrationLocalAgent(principal, agent.userId)?.hasHome()
          )
        } catch {
          return false // An unreadable home is not ready; the next tick looks again.
        }
      },
      move: principal => {
        const agent = moveTarget(principal)

        return agent ? moveAgentToCloud(agent) : Promise.reject(new Error('matrix_agent_unavailable'))
      },
      now: Date.now,
      log: line => console.warn(line)
    }
  })

  setInterval(() => void operatorMoveTick(), OPERATOR_MOVE_TICK_MS).unref()
  personalPetCache = new MatrixPersonalPetCache(path.join(app.getPath('userData'), 'matrix-personal-pets'))
  pets = new MatrixPets({
    scope: target => {
      const scope = account.appScope()

      if (
        !target ||
        typeof target.scope !== 'string' ||
        typeof target.agent !== 'string' ||
        closing ||
        !state.identity ||
        !scope ||
        target.scope !== petScopeToken()
      ) {
        return null
      }

      const agent = allAgents().find(each => !each.closed && each.agentPrincipal === target.agent)
      const identity = agent && enrollmentOf(agent).identity

      return agent?.assistantId && identity?.agentPrincipal === target.agent
        ? {
            key: scope.accountKey,
            generation: scope.generation,
            owner: identity.principal,
            agent: target.agent,
            assistantId: agent.assistantId,
            isDefault: agent === productAgent()
          }
        : null
    },
    cache: outcomeStore,
    roaming: (scope, signal) => account.petRoaming(scope.owner, AbortSignal.any([signal, AbortSignal.timeout(10_000)])),
    request: (scope, write) => account.agentPet(scope.assistantId, scope, AbortSignal.timeout(15_000), write),
    catalog: scope => account.agentPets(scope.assistantId, scope, AbortSignal.timeout(15_000)),
    visit: scope => account.beginAgentPetVisit(scope.assistantId, AbortSignal.timeout(15_000)),
    sprite: async (scope, binding, catalog) => {
      if (!runtime || !binding.ref) {
        throw new Error('matrix_pet_asset_unavailable')
      }

      const ref = binding.ref

      if (ref.kind === 'bundled') {
        return readBundledPet(runtime, ref.slug, binding.scale)
      }

      if (ref.kind !== 'personal' || !personalPetCache) {
        throw new Error('matrix_pet_asset_unavailable')
      }

      if (!catalog) {
        return readCachedMatrixPersonalPetById(runtime, personalPetCache, scope.key, ref.pet_id, binding.scale)
      }

      const record = catalog.personal.find(pet => pet.pet_id === ref.pet_id)

      if (!record) {
        personalPetCache.invalidatePet(scope.key, ref.pet_id)
        throw new Error('matrix_pet_asset_unavailable')
      }

      const library = await account.personalPets(AbortSignal.timeout(15_000))

      const confirmed = library.find(
        pet => pet.pet_id === record.pet_id && pet.content_sha256 === record.content_sha256 && !pet.deleted_at
      )

      if (!confirmed) {
        personalPetCache.invalidatePet(scope.key, ref.pet_id)
        throw new Error('matrix_pet_asset_unavailable')
      }

      try {
        return await readCachedMatrixPersonalPet(
          runtime,
          personalPetCache,
          scope.key,
          confirmed.content_sha256,
          binding.scale
        )
      } catch {
        // An absent or invalid receipt falls through to the authoritative,
        // owner-authorized content download below.
      }

      const bundle = await account.personalPetContent(confirmed.content_sha256, AbortSignal.timeout(60_000))

      if (bundle.sha256 !== confirmed.content_sha256) {
        throw new Error('matrix_pet_asset_unavailable')
      }

      return readMatrixPersonalPet(runtime, personalPetCache, scope.key, bundle, confirmed.pet_id, binding.scale)
    }
  })

  const petDisplay = new MatrixPetDisplay(
    new EncryptedStore(path.join(app.getPath('userData'), 'matrix-pet-display.json'), safeStorage)
  )

  const petOverlayRoom = (principal: string) => {
    const agent = allAgents().find(each => !each.closed && each.agentPrincipal === principal)

    return agent?.assistantId && enrollmentOf(agent).identity?.agentPrincipal === principal
      ? matrixAgentHomeRoom(state.rooms, state.identity?.userId, agent.userId)
      : undefined
  }

  petOverlays = new MatrixPetOverlayService(
    {
      context: () => {
        const scope = account.appScope()

        return !closing &&
          state.state === 'ready' &&
          state.identity &&
          scope &&
          !account.sessionEnded() &&
          !account.signOutPending()
          ? {
              accountKey: scope.accountKey,
              scope: petScopeToken()!,
              snapshot: state,
              locale: matrixAppMenuLocale(state, app.getPreferredSystemLanguages()),
              dark: nativeTheme.shouldUseDarkColors,
              reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion
            }
          : undefined
      },
      read: target => pets!.read(target),
      room: petOverlayRoom,
      chat: async input => {
        try {
          return { ok: true as const, reply: await account.petChat(input, AbortSignal.timeout(60_000)) }
        } catch (error) {
          return {
            ok: false as const,
            code: error instanceof MatrixPetChatError ? error.code : ('temporarily_unavailable' as const)
          }
        }
      },
      history: async ref => {
        try {
          return { ok: true as const, history: await account.petChatHistory(ref, AbortSignal.timeout(15_000)) }
        } catch (error) {
          return {
            ok: false as const,
            code: error instanceof MatrixPetChatError ? error.code : ('temporarily_unavailable' as const)
          }
        }
      },
      action: async (target, action) => {
        if (closing || target.scope !== petScopeToken()) {
          throw new Error('matrix_pet_overlay_unavailable')
        }

        if (action === 'hide') {
          const view = await pets!.read(target)

          const binding =
            view.selection.pet ??
            (view.standIn && view.sprite?.slug === 'gigi'
              ? { ref: { kind: 'bundled' as const, slug: 'gigi' }, enabled: true, scale: view.sprite.scale ?? 1 }
              : undefined)

          if (!binding || target.scope !== petScopeToken()) {
            throw new Error('matrix_pet_overlay_unavailable')
          }

          await pets!.write(target, view.selection.revision, { ...binding, enabled: false })

          return
        }

        const roomId = petOverlayRoom(target.agent)

        if (!roomId) {
          throw new Error('matrix_pet_overlay_unavailable')
        }

        await command(parseMatrixCommand({ kind: 'select', roomId }))

        if (closing || target.scope !== petScopeToken() || !ui || ui.isDestroyed()) {
          throw new Error('matrix_pet_overlay_unavailable')
        }

        ui.show()
        ui.focus()

        if (action === 'change' || action === 'size' || action === 'store' || action === 'settings') {
          ui.webContents.send(MATRIX_PET_DISPLAY_ACTION, { target, action })
        }
      }
    },
    petDisplay,
    {
      createWindow: options => new BrowserWindow(options),
      ipc: ipcMain,
      screen,
      preload: path.join(assets, 'matrix-pet-preload.js'),
      url: pathToFileURL(path.join(assets, 'matrix-pet.html')).href,
      signed: app.isPackaged
    }
  )
  defaultAgent.store = outcomeStore
  lifecycle = createLifecycle()
  defaultAgent.cron = createCronDelivery(defaultAgent)
  checkIns = createCheckIns()

  const documentFiles = new AtumConsumerFilesService({
    roots: () => ({
      home: app.getPath('home'),
      documents: app.getPath('documents'),
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads')
    }),
    shell
  })

  documents = new MatrixRoomDocuments(
    documentFiles,
    new EncryptedStore(path.join(app.getPath('userData'), 'documents.json'), safeStorage),
    token => pdf?.close(token),
    process.platform === 'darwin'
      ? (scope, token) => {
          const originalHost = hosts.get('human')
          const originalOwner = account.appScope()
          const helper = path.join(assets, 'atum-app-window').replace('app.asar/', 'app.asar.unpacked/')

          return new MatrixWordDocument(JSON.stringify(scope), {
            authority: () => {
              const current = account.appScope()

              if (
                closing ||
                !originalHost ||
                !originalOwner ||
                hosts.get('human') !== originalHost ||
                account.identity()?.userId !== scope.userId ||
                !current ||
                current.accountKey !== originalOwner.accountKey ||
                current.generation !== originalOwner.generation ||
                !state.rooms.some(room => room.id === scope.roomId && usableAgentRoom(room)) ||
                !documentFiles.resolveCapture(token)
              ) {
                throw new Error('WORD_DOCUMENT_UNAVAILABLE')
              }

              return JSON.stringify([originalOwner.accountKey, originalOwner.generation, scope.userId, scope.roomId])
            },
            beforeOpen: async () => {
              await nativeApps?.clear()
              await documents.hideWord()
            },
            window: () => (state.state === 'ready' && !closing ? (ui ?? null) : null),
            authorizePath: requested => {
              try {
                const granted = documentFiles.resolveCapture(token)

                if (!granted || documentFiles.confine(requested) !== granted || !statSync(granted).isFile()) {
                  throw new Error('WORD_DOCUMENT_UNAVAILABLE')
                }

                return granted
              } catch {
                throw new Error('WORD_DOCUMENT_UNAVAILABLE')
              }
            },
            live: createWordLiveMacAdapter(),
            word: createWordMacAdapter({ preflightAutomation: () => nativeWordAutomationAllowed(helper) }),
            workArea: bounds => screen.getDisplayMatching(bounds).workArea,
            ended: () => {},
            bindingEnded: () => {}
          })
        }
      : undefined,
    scope => {
      const originalHost = hosts.get('human')
      const originalOwner = account.appScope()
      const originalIdentity = account.identity()

      if (!originalHost || !originalOwner || !originalIdentity || originalIdentity.userId !== scope.userId) {
        throw new Error('matrix_document_unavailable')
      }

      const accountId = createHash('sha256')
        .update(JSON.stringify([config.domain?.resource, originalOwner.accountKey, scope.userId]))
        .digest('hex')

      const selectedScope = {
        // Matrix starts its epoch at zero; the shared lease envelope starts at one.
        account: { accountId, accountGeneration: originalOwner.generation + 1 },
        userId: scope.userId,
        deviceId: originalIdentity.deviceId,
        roomId: scope.roomId
      }

      const currentScope = () => {
        const owner = account.appScope()
        const identity = account.identity()

        return !closing &&
          state.roomId === scope.roomId &&
          hosts.get('human') === originalHost &&
          owner?.accountKey === originalOwner.accountKey &&
          owner.generation === originalOwner.generation &&
          identity?.userId === scope.userId &&
          identity.deviceId === originalIdentity.deviceId &&
          state.rooms.some(room => room.id === scope.roomId && usableAgentRoom(room))
          ? selectedScope
          : null
      }

      return new MatrixTextDocument(selectedScope, {
        authority: {
          currentAuthority: () => {
            const current = currentScope()

            return current ? { account: current.account } : null
          }
        },
        currentScope,
        available: () => state.state === 'ready',
        confine: requested => documentFiles.confine(requested),
        journalRootFor: current => {
          if (
            current.accountId !== accountId ||
            current.accountGeneration !== selectedScope.account.accountGeneration
          ) {
            throw new Error('matrix_document_unavailable')
          }

          return matrixDocumentRecoveryRoot(app.getPath('userData'), accountId, originalIdentity.deviceId, scope.roomId)
        }
      })
    }
  )
  // Its own file: a damaged credentials.json can't take the person's recovery key down with it.
  ownerKeys = new MatrixOwnerKeys(
    new EncryptedStore(path.join(app.getPath('userData'), 'owner-keys.json'), safeStorage)
  )
  // This Mac's device-trust bookkeeping: when it replaced each agent's executor by itself.
  const deviceTrust = new EncryptedStore(path.join(app.getPath('userData'), 'device-trust.json'), safeStorage)
  deviceTrustStore = deviceTrust
  // The optional native recovery helper is available only when supplied by the build.
  icloudKeychain = new MatrixICloudKeychain({
    helper: app.isPackaged ? matrixKeychainHelper(process.resourcesPath) : undefined,
    log: line => console.warn(line)
  })
  void icloudKeychain.available().then(available => {
    icloudAvailable = available

    if (available) {
      publish(state)
    }
  })
  reenrollments = new MatrixAgentReenrollments({
    // An unreadable entry throws (not "none yet"): the ledger then caps automatic replacements.
    read: () => {
      const value = deviceTrust.getItem('agent-reenrollments')
      const failure = value === null ? deviceTrust.failureCode() : null

      if (failure) {
        throw new Error(failure)
      }

      return value
    },
    write: value => deviceTrust.setItem('agent-reenrollments', value)
  })
  deviceLedger = new MatrixDeviceLedger({
    read: () => deviceTrust.getItem('device-ledger'),
    write: value => deviceTrust.setItem('device-ledger', value)
  })
  credentialStore = new EncryptedStore(path.join(app.getPath('userData'), 'credentials.json'), safeStorage)

  if (runtime) {
    // Every Mac-hosted assistant of the account reads the same OpenCode Go key from here.
    runtime.subscriptionEnv = () => matrixSubscriptionEnvironment(subscriptionKeys(), subscriptionAuthHome())
  }

  account = new MatrixAccount(
    config,
    credentialStore,
    url => {
      // The sign-in's checks are done and the browser opens now: from here the window asks the
      // person to finish there (before, it says the browser is opening).
      if (state.state === 'signing_in' && state.signInBrowser === false) {
        publish({ ...state, signInBrowser: true })
      }

      return shell.openExternal(url)
    },
    async (home, agent) => {
      await stopHost(agent === undefined ? 'agent' : `agent:${agent}`)

      if (!runtime) {
        throw new Error('matrix_local_cleanup_pending')
      }

      await clearMatrixHermesCredentials(runtime, home)
    },
    async (slug, identity) => {
      await stopAppHosts(slug)
      await clearDevice(identity)
    },
    // Every sign-in this Mac ends, revokes or can't keep, with its cause: no line in main.log
    // named the 2026-10-04 sign-out .
    event => console.warn(matrixAccountLogLine(event)),
    {
      // Room kept beside the vault for a token rotation that finds the disk full.
      reserve: matrixDiskReserve(path.join(app.getPath('userData'), 'credentials.reserve')),
      // A rotation the vault could not keep is saved now: an engine that stopped meanwhile
      // starts again by itself (a running one takes a token at its next refresh).
      renewed: client => {
        if (client === 'matrix') {
          sessionChecks.renewed()
        }
      },
      // "Atum OAuth, then right back to Atum": the window comes to the front the moment the
      // browser is back, before the code is redeemed, and says it is signing in (no longer
      // "finish in your browser"); the rest of the trip plays behind it.
      returned: () => {
        bringToFront()

        if (state.state === 'signing_in' && !state.signInReturned) {
          publish({ ...state, signInReturned: true })
        }
      },
      // The Shell sells an assistant only to a desktop that can deliver its hire (0.18.3+).
      desktopVersion: app.getVersion(),
      // The same cloud-only decision the launch makes: a cloud assistant never creates a local
      // executor on a Mac that does not serve it, whichever setup path reaches enrollment.
      localExecutorRequired: agent =>
        matrixLocalExecutorRequired({
          principal: agent,
          defaultCloudOnly: isCloudOnlyAgent(defaultAgent),
          namedCloudOnly: principal => {
            const named = agents.get(principal)

            return named ? isCloudOnlyAgent(named) : undefined
          }
        }),
      domainContinuation: matrixDriveChain(() => drive)
    }
  )

  sourceGateSync = config.domain
    ? new MatrixAccountSourceGates({
        scope: () => account.appScope(),
        gates: () => macSourceGates(macSourcesConsentStore().read()),
        assistants: async signal => (await account.agents(AbortSignal.any([signal, AbortSignal.timeout(15_000)])))
          .filter(agent => agent.status === 'active')
          .map(agent => agent.id),
        read: (assistantId, signal) => account.s1Request(
          (accessToken, resource) => readMatrixSourceGatesV2(resource, accessToken, assistantId, signal),
          signal
        ),
        write: (assistantId, input, signal) => account.s1Request(
          (accessToken, resource) => writeMatrixSourceGates(resource, accessToken, assistantId, input, signal),
          signal
        ),
        seed: () => {
          const seed = macSourcesConsentStore().accountGatesImport()
          const gates = macSourceGates(seed.consent)
          // Domain-less explicit OFF choices join the first import; defaults never do.
          const localOnly = new MacSourcesConsentStore(outcomeStore, localMacSourcesConsentScope)
          for (const source of localOnly.pendingNarrow()) {gates[source === 'teamSpaces' ? 'team_spaces' : source] = false}
          return { mergeId: seed.mergeId, gates }
        },
        recordOverridden: gates => {
          const store = macSourcesConsentStore()
          store.recordOverriddenOptOuts(gates.map(gate => gate === 'team_spaces' ? 'teamSpaces' : gate), store.installationId())
        },
        off: commitPendingMacSourceOff,
        pending: () => macSourcesConsentStore().pendingNarrow().map(source => source === 'teamSpaces' ? 'team_spaces' : source),
        clearPending: gates => macSourcesConsentStore().clearPendingNarrow(gates.map(gate => gate === 'team_spaces' ? 'teamSpaces' : gate)),
        merged: () => macSourcesConsentStore().accountGatesMerged(),
        markMerged: () => macSourcesConsentStore().markAccountGatesMerged(),
        apply: gates => {
          const current = macSourceGates(macSourcesConsentStore().read())
          for (const [gate, enabled] of Object.entries(gates)) {
            const source = gate as keyof typeof gates
            if (current[source] !== enabled) {commitMacSourceConsent(source === 'team_spaces' ? 'teamSpaces' : source, enabled)}
          }
        },
        changed: announceSourceChoicesChanged
      })
    : undefined

  executionPolicies = config.domain
    ? new MatrixExecutionPolicyController({
        scope: () => account.appScope(),
        request: (agentPrincipal, action, signal, update) =>
          account.s1Request(
            (accessToken, resource) =>
              requestMatrixExecutionPolicy(resource, accessToken, agentPrincipal, action, signal, update),
            signal
          ),
        deviceNames: () => executionDeviceNames.read(),
        changed: scheduleExecutionPolicyReconcile,
        log: line => console.warn(line)
      })
    : undefined

  // The account-wide OpenCode Go connection (`atum.provider-connections/1`, migration 0335).
  // The key is write-only and lives in the platform; this cache holds only the closed status.
  providerConnections = config.domain
    ? new MatrixProviderConnections({
        scope: () => account.appScope(),
        call: (action, signal, body) =>
          account.s1Request(
            (accessToken, resource) =>
              requestMatrixProviderConnections(resource, accessToken, action, signal, body),
            signal
          ),
        changed: () => publish(state)
      })
    : undefined

  chatGptRelay = config.domain
    ? new MatrixChatGptRelay({
        scope: () => account.appScope(),
        call: (action, signal, body) => account.s1Request(
          (accessToken, resource) => requestMatrixChatGptRelay(resource, accessToken, action, signal, body), signal),
        changed: () => publish(state)
      })
    : undefined

  cloudModelChoices = config.domain
    ? new MatrixCloudModelChoices({
        scope: () => account.appScope(),
        call: (agentPrincipal, action, signal, body) =>
          account.s1Request(
            (accessToken, resource) =>
              requestMatrixCloudModelChoice(resource, accessToken, agentPrincipal, action, signal, body),
            signal
          ),
        changed: () => publish(state)
      })
    : undefined

  // The owner's default model per destination (cloud and each Mac). The same owner routes
  // the phone writes; the card's cloud row follows the composer's offer for eligibility.
  modelDestinations = config.domain
    ? new MatrixModelDestinations({
        scope: () => account.appScope(),
        call: (agentPrincipal, action, signal, body) =>
          account.s1Request(
            (accessToken, resource) =>
              requestMatrixModelDestinations(resource, accessToken, agentPrincipal, action, signal, body),
            signal
          ),
        deviceNames: () => executionDeviceNames.read(),
        supersededDeviceIds: () => executionDeviceNames.superseded(),
        offer: principal => cloudModelChoices?.view(principal),
        here: principal => {
          const agent = allAgents().find(each => cloudPrincipal(each) === principal)

          return agent && isCloudAgent(agent) ? 'cloud' : 'mac'
        },
        thisDevice: () => deviceIdentity?.enrollment()?.deviceServiceId,
        changed: () => publish(state)
      })
    : undefined

  cloudHomeReader = config.domain
    ? new MatrixCloudHomeReader({
        // Beside the device state, outside every agent's home: a local file the cloud's copy is about to
        // replace is saved here first, so a takeover never silently drops what this Mac learned.
        backups: path.join(app.getPath('userData'), 'device', 'cloud-home-backups'),
        request: (agentPrincipal, action, signal) =>
          account.s1Request(
            (accessToken, resource) => requestCloudHome(resource, accessToken, agentPrincipal, action, signal),
            signal
          )
      })
    : undefined

  // Once, before any Hermes opens: no assistant keeps a ChatGPT sign-in it may have copied
  // from another account through the shared store used before 0.18.3. The account signed in
  // now counts first (read from the vault, nothing opened yet), so a second account's first
  // start migrates before its assistants open (codex-accounts.ts). Never fails startup.
  if (runtime) {
    let accountKey: string | undefined

    try {
      accountKey = account.appScope()?.accountKey
    } catch {
      accountKey = undefined
    }

    migrateMatrixCodexAccounts(runtime, { userData: app.getPath('userData'), accountKey })
  }

  let driveEngine: ReturnType<typeof selectMatrixDriveEngine> | undefined

  try {
    const manifest = app.isPackaged
      ? path.join(process.resourcesPath, 'drive-engine', 'manifest.json')
      : option('matrix-drive-engine')

    if (manifest) {
      driveEngine = selectMatrixDriveEngine(manifest, config.issuer)
    }
  } catch {
    console.warn('[Matrix] matrix_drive_engine_unavailable')
  }

  drive = new MatrixDrive({
    // During the optional same-tab Drive hop the account grant is committed just before the UI
    // publishes identity. The default-off path keeps the established UI-state gate unchanged.
    owner: () => (closing || (!DRIVE_CHAINED_SIGN_IN && !state.identity) ? null : account.driveOwner()),
    engine: driveEngine,
    store: new EncryptedStore(path.join(app.getPath('userData'), 'drive.json'), safeStorage),
    userData: app.getPath('userData'),
    chooseFolder: async () => {
      if (!ui || ui.isDestroyed()) {
        return undefined
      }

      const selected = await dialog.showOpenDialog(ui, {
        properties: ['openDirectory', 'createDirectory'],
        message: matrixDriveFolderPrompt(state.displayPreferences?.language?.value)
      })

      return selected.canceled ? undefined : selected.filePaths[0]
    },
    // Drive's own folder inside Atum's: a first connect makes and uses it when it can be Drive.
    defaultFolder: path.join(app.getPath('home'), MATRIX_ATUM_FOLDER, 'Drive'),
    reachable: () => (driveEngine ? matrixDriveReachable(driveEngine.origin) : Promise.resolve(false)),
    open: () => (driveEngine ? matrixDriveOpen(driveEngine.origin) : Promise.resolve(false)),
    openExternal: url => shell.openExternal(url),
    // The engine runs with the person's own Atum account token, which the app refreshes; no
    // browser sign-in (atum.drive-app-credential/1). A rotation happens only for the token the
    // engine had refused and must still resolve to the identity it pinned. Null fails closed.
    credential: (refused, owner) => account.driveCredential(refused, owner),
    // Drive's browser sign-in came back (MAS's page says "returning to Atum"): Atum is in front.
    returned: () => bringToFront(),
    openPath: file => shell.openPath(file),
    closeNativePreview: token => {
      try {
        pdf.close(token)
      } catch {
        // Drive can withdraw before the PDF controller is composed during startup.
      }
    },
    log: line => console.warn(line),
    changed: view => {
      void deviceWorkspace?.refresh().catch(() => console.warn('[Device] Drive protection refresh failed'))

      if (ui && !ui.isDestroyed()) {
        ui.webContents.send(MATRIX_DRIVE_IPC.changed, view)
      }
    }
  })

  await deviceWorkspace?.refresh()

  if (runtime) {
    const importRuntime = runtime
    // The native runtime callback also gates every temporary setup/content executor.
    await workspaceStartup?.start()

    driveImport = new MatrixDriveImport({
      home: app.getPath('home'),
      python: importRuntime.python,
      target: () => (closing || !state.identity ? undefined : drive?.importTarget()),
      quota: () => (closing || !state.identity ? undefined : drive?.importQuota()),
      exclusions: () => (closing || !state.identity ? undefined : drive?.importExclusions()),
      protectedRoots: () => [
        app.getPath('userData'),
        process.resourcesPath,
        importRuntime.source,
        importRuntime.profiles,
        ...matrixWorkspaceDriveRoots(),
        ...(deviceWorkspace?.agentWorkingRoots() ?? [path.join(app.getPath('home'), 'Atum Tasks')])
      ],
      choose: async () => {
        const window = ui

        if (!window || window.isDestroyed()) {
          return undefined
        }

        const language = state.displayPreferences?.language?.value
        const locale = isDesktopLocale(language) ? language : DEFAULT_DESKTOP_LOCALE

        const selected = await oneDialogAtATime(() =>
          dialog.showOpenDialog(window, {
            properties: ['openFile', 'openDirectory', 'multiSelections'],
            title: MATRIX_DRIVE_IMPORT_LABELS[locale]
          })
        )

        return selected.canceled ? undefined : selected.filePaths
      }
    })
    void driveImport.cleanup().catch(() => {})
  }

  const driveTarget = (roomId: string, revision?: number) => {
    const agent = requireRoomAgent(roomId)
    const human = hosts.get('human')
    const owner = account.driveOwner()
    const principal = agent.agentPrincipal
    const userId = agent.userId

    if (!owner || !human || !principal || !userId) {
      throw new Error('matrix_drive_task_unavailable')
    }

    const current = () => {
      const active = account.driveOwner()

      if (
        closing ||
        operation ||
        domainOperation ||
        profileSelection ||
        agent.closed ||
        // The human host's readiness is the snapshot's: `host.ready` is set only for agent and
        // app hosts, so requiring it refused every Drive file to a cloud agent.
        !matrixHumanSdkReady(state.state, human) ||
        hosts.get('human') !== human ||
        agentOfRoom(roomId) !== agent ||
        agent.agentPrincipal !== principal ||
        agent.userId !== userId ||
        !active ||
        active.issuer !== owner.issuer ||
        active.subject !== owner.subject ||
        active.generation !== owner.generation ||
        !drive!.taskFilesReady(revision)
      ) {
        throw new Error('matrix_drive_task_unavailable')
      }
    }

    const ready = async () => {
      current()

      // A task for an agent this Mac has stood down, or is draining for a move, is not sent from here: the same fence
      // as anything the agent says. Nothing is sent by this check; it answers "not available" (what the status shows, and
      // what makes a send `not_sent`) instead of failing.
      if (agentHome && !(await agentHome.allows(principal, 'sendTaskFiles'))) {
        return false
      }

      await human.queue.command({
        kind: 'readAssistantRoom',
        roomId,
        ownerId: human.identity.userId,
        agentId: userId,
        forTurn: true
      })
      current()
      const available = await account.cloudFileAvailable(principal)
      current()

      return available
    }

    current()

    return { agent, human, principal, userId, current, ready }
  }

  registerMatrixDriveIpc(
    ipcMain,
    drive,
    event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    {
      taskStatus: async roomId => {
        if (!drive!.taskFilesReady()) {
          return { state: 'unavailable' }
        }

        const target = driveTarget(roomId)

        return taskFilesConversationStatus(() => target.ready())
      },
      sendTask: async input => {
        let target: ReturnType<typeof driveTarget>

        try {
          target = driveTarget(input.roomId, input.revision)

          if (target.agent.operation || target.agent.invocation || target.agent.localTurns?.executionPending) {
            return { state: 'not_sent' }
          }
        } catch {
          return { state: 'not_sent' }
        }

        holdOperation(target.agent, true)

        try {
          return await sendDriveTask({
            input,
            agentPrincipal: target.principal,
            current: target.current,
            ready: target.ready,
            metadata: (id, mode, revision) => drive!.metadata(id, mode, revision),
            send: taskFiles =>
              observeMessage(async () => {
                target.current()

                const send = async () =>
                  (await target.human.queue.command({
                    kind: 'sendTaskFiles',
                    roomId: input.roomId,
                    body: input.body,
                    userId: target.userId,
                    taskFiles
                  })) as string

                // The owner's message to an agent goes out through the same fence as the agent's own: counted while it
                // is in flight, and refused from a Mac that has stood the agent down or is draining it for a move.
                return agentHome ? agentHome.fence(target.principal, 'sendTaskFiles', send) : send()
              }),
            issue: async grant => {
              target.current()
              await account.issueCloudFileGrant(grant)
            }
          })
        } finally {
          holdOperation(target.agent, false)
        }
      }
    },
    driveImport
  )
  const brainProcess = selectMatrixLocalBrainProcess(app.isPackaged, runtime)

  try {
    localBrain = brainProcess
      ? new MatrixLocalBrain({
          userData: app.getPath('userData'),
          resources: app.isPackaged
            ? path.join(process.resourcesPath, 'local-brain')
            : path.join(assets, '..', 'build', 'local-brain', `${process.platform}-${process.arch}`),
          ...brainProcess,
          log: code => console.warn(`[Matrix] ${code}`)
        })
      : undefined
  } catch {
    localBrain = undefined
    console.warn('[Matrix] local_brain_runtime_unavailable')
  }

  googleFenceNotices = localBrain ? new MatrixGoogleFenceNotices(localBrain, googleFenceOwner) : undefined

  googleConnections = new MatrixGoogleConnections({
    root: path.join(app.getPath('userData'), 'matrix-google-private'),
    owner: googleConnectionOwner,
    safeStorage,
    google: readGoogleClient(path.join(assets, 'assets/google-desktop-client.json')),
    fetchImpl: fetch,
    openExternal: url => shell.openExternal(url),
    locale: () => (state.displayPreferences?.language?.value === 'vi' ? 'vi' : 'en'),
    publishFence: owner => publishMatrixGoogleFence(owner, googleConnectionOwner),
    // The owner confirms the exact email or event; nothing else can (G2-08).
    confirmWrite: async preview => {
      if (!ui || ui.isDestroyed()) {
        return false
      }

      const copy = matrixGoogleWriteCopy(state.displayPreferences?.language?.value)

      if (!ui.isVisible()) {
        ui.show()
      }

      const result = await oneDialogAtATime(() =>
        dialog.showMessageBox(ui!, {
          type: 'question',
          title: 'Atum',
          message: copy.message[preview.action],
          detail: preview.detail,
          buttons: [copy.cancel, copy.confirm[preview.action]],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: preview.signal
            ? AbortSignal.any([preview.signal, AbortSignal.timeout(90_000)])
            : AbortSignal.timeout(90_000)
        })
      )

      return result.response === 1
    },
    writeLabels: () => matrixGoogleWriteCopy(state.displayPreferences?.language?.value).labels,
    changed: () => publish(state)
  })
  ipcMain.handle(
    MATRIX_GOOGLE_CONNECTION_IPC,
    createMatrixGoogleConnectionIpcHandler({
      assertSender: (event: Electron.IpcMainInvokeEvent) => requireMatrixCaller(event, ui?.webContents, UI_URL),
      connections: () => googleConnections && {
        status: async () => {
          const owner = account.appScope()
          try {
            const signal = AbortSignal.timeout(20_000)
            const result = await account.s1Request(
              (token, resource) => requestMatrixGoogleAccountStatus(resource, token, signal), signal)
            const current = account.appScope()
            return owner && current?.accountKey === owner.accountKey && current.generation === owner.generation
              ? result : { status: null, error: 'cancelled' }
          } catch {
            return { status: null, error: 'network' }
          }
        },
        connect: async () => {
          const owner = account.appScope()
          const signal = AbortSignal.timeout(20_000)
          try {
            const current = await account.s1Request(
              (token, resource) => requestMatrixGoogleAccountStatus(resource, token, signal), signal)
            if (current.status?.accountState !== 'disconnected') { return current }
            const url = await account.s1Request(
              (token, resource) => requestMatrixGoogleAccountConnect(resource, token, signal), signal)
            const next = account.appScope()
            if (!owner || next?.accountKey !== owner.accountKey || next.generation !== owner.generation) {
              return { status: null, error: 'cancelled' }
            }
            await shell.openExternal(url)
            return current
          } catch {
            return { status: null, error: 'network' }
          }
        },
        disconnect: group => googleConnections.disconnect(group),
        setSourcePreferences: preferences => googleConnections.setSourcePreferences(preferences)
      },
      firstRunConnected: async context => {
        await firstRun.start({ locale: context.locale, ending: 'done' })
      }
    })
  )

  if (config.domain) {
    checkout = new MatrixCheckoutController({
      journal: new FileCheckoutJournal(path.join(app.getPath('userData'), 'checkout')),
      request: (endpoint, signal, input) => account.storeRequest(endpoint, signal, input),
      changed: () => publish(state),
      walletChanged: () => {
        void wallet?.refresh('manual')
      },
      openExternal: url => shell.openExternal(url)
    })
    companyStore = new MatrixCompanyStoreBridgeController({
      journal: new FileCompanyStoreJournal(path.join(app.getPath('userData'), 'company-store')),
      request: (companyId, endpoint, signal, input) => account.s1Request(
        (token, resource) => requestMatrixCompanyStore(resource, token, companyId, endpoint, signal, input, app.getVersion()), signal)
    })
    companyStore.activate(!closing && state.identity ? (account.appScope() ?? null) : null)
    store = new MatrixStoreController({
      journal: new FileStoreJournal(path.join(app.getPath('userData'), 'store')),
      request: (endpoint, signal, input) => account.storeRequest(endpoint, signal, input),
      // A hire whose assistant needs optional skills is sold only when this Mac's runtime can
      // install them (asked of any running backend: they share the runtime).
      hireReady: itemId =>
        matrixStoreHireInstallable({
          gateway: [defaultAgent, ...agents.values()].find(agent => agent.storeGateway && !agent.closed)?.storeGateway,
          itemId,
          log: line => console.warn(line)
        }),
      changed: () => {
        publish(state)
        storeChanged()
      },
      walletChanged: () => {
        void wallet?.refresh('manual')
      },
      log: line => console.warn(line),
      hireTargetLive,
      // A refused reused target may have been retired on another Mac: read the list now.
      rosterStale: () => {
        agentRoster.request()
        void syncAgents()
      },
      createAgent: async (input, signal) => {
        const created = await account.createAgent(input, signal)

        // A hire created with the disclosure may be placed in the cloud too: this Mac must not
        // enroll a local executor for it while its roster row still says local.
        if (created.cloudPlacement === 'placed' || created.cloudPlacement === 'pending_trust') {
          placedAgents.add(created.principal)
        }

        // A fresh read (an idle sync reads nothing) sets the hired agent up here. Not awaited:
        // the purchase shares this request's 25 s budget, and keeping a provisioned target
        // never waits for the roster to list it (store.ts rememberReusableHire).
        agentRoster.request()
        void syncAgents()

        return { id: created.id }
      }
    })
    wallet = new MatrixWalletController({
      read: signal => account.wallet(signal),
      changed: () => publish(state)
    })
    officialAccounts = new MatrixOfficialAccountsController({
      read: signal => account.officialAccounts(signal),
      changed: () => publish(state),
      settled: () => founderChat?.refreshed()
    })
    founderChat = createMatrixFounderChat({
      // Unknown while the platform has not been read (or cannot be): never "no founder".
      founder: () => {
        const official = state.identity ? officialAccounts?.snapshot() : undefined

        return official ? (official.founder?.userId ?? null) : undefined
      },
      host: () => {
        const host = hosts.get('human')

        return host ? { token: host, ready: matrixHumanSdkReady(state.state, host) } : undefined
      },
      command: (token, value) =>
        hosts.get('human') === token
          ? command(value, FOUNDER_CHAT_COMMAND_MS)
          : Promise.reject(new Error('matrix_sdk_unavailable')),
      select: (token, roomId) =>
        hosts.get('human') === token
          ? command({ kind: 'select', roomId })
          : Promise.reject(new Error('matrix_sdk_unavailable'))
    })
    powerMonitor.on('resume', () => officialAccounts?.resume())
  }

  defaultAgent.lease = createLease(defaultAgent)
  defaultAgent.continuous = createContinuousListening(defaultAgent)
  defaultAgent.signals = createAgentSignals()
  defaultAgent.localTurns = createLocalTurns()

  try {
    defaultAgent.localTurns.recover()
  } catch {
    console.warn('[Matrix] local turns could not be recovered: vault unavailable')
  }

  if (config.domain) {
    defaultAgent.readiness = createReadiness()
    backgroundSweeps ??= createBackgroundSweeps()
    // WS-4: wake uses a new device connection epoch and exchanges Status before any command.
    powerMonitor.on('resume', () => {
      for (const agent of allAgents()) {
        agent.lease?.resume()
      }

      executionPolicies?.refreshAll()
      resumeHosts()
      recheckAgents()
    })
    // A38: a wake is when this Mac may have moved. The existing watch path carries the read.
    refreshMatrixRosterOnWake(powerMonitor, agentRoster, () => void syncAgents())
    let online = net.isOnline()
    let backgroundSweptAt = 0
    setInterval(() => {
      // Recovery belongs to the account, not to the root assistant's readiness gate.
      // sync is a no-op after success and coalesces any pending read.
      if (!closing && account.identity()) {
        void syncAgents()
        executionPolicies?.refreshAll()

        // Store is the single refresh owner; this beat only checks its safety deadline.
        void store?.refresh(true)

        if (Date.now() - backgroundSweptAt >= 30_000) {
          backgroundSweptAt = Date.now()
          backgroundSweeps?.tick()
        }

        drive?.recoverConnectivity()
        void resumeMatrixPetHatch()
      }

      if (net.isOnline() !== online) {
        online = !online
        if (online) {
          void reconcileDeviceControl(true)
          drive?.recoverConnectivity(true)
        }
        recheckAgents()
      }
    }, 5_000).unref()
  }

  if (config.managedModel) {
    groupRelevanceRouter = new GroupRelevanceRouter({
      gateway: config.managedModel.gateway,
      scope: () => (!closing && state.state === 'ready' ? account.appScope() : null),
      bearer: refresh => account.managedModelBearer(refresh)
    })

    const candidate = new MatrixManagedModel({
      gateway: config.managedModel.gateway,
      port: config.managedModel.port,
      // Each agent's Hermes presents its own key, named by its host role.
      keys: () => [
        ...account
          .managedModelKeys()
          // A stopped or retired agent's leftover key completes nothing.
          .filter(({ agent }) => agent === undefined || (agents.has(agent) && !agents.get(agent)!.closed))
          .map(({ key, agent }) => [key, agent === undefined ? 'agent' : `agent:${agent}`] as const),
        ...Array.from(matrixPetHatchKeys.entries())
          .filter(([, run]) => !run.abort.signal.aborted && run.accountKey === account.appScope()?.accountKey)
          .map(([key, run]) => [key, run.role] as const)
      ],
      bearer: refresh => account.managedModelBearer(refresh),
      // The Google fence: a latched default assistant uses only the protected route.
      route: role => googleAssistant.route(role),
      hatchKey: (role, key) =>
        Array.from(matrixPetHatches.values()).some(
          run =>
            run.proxyKey === key &&
            !run.abort.signal.aborted &&
            run.role === role &&
            run.accountKey === account.appScope()?.accountKey
        ),
      // The gateway's daily cap attributes a call to this agent. It is the enrollment's
      // verified agent principal (not cloudPrincipal: its owner fallback is no agent).
      agentPrincipal: role =>
        matrixManagedAgentPrincipal(role, {
          runtime: each => agentOfRole(each as MatrixHostRole),
          enrolled: each => enrollmentOf(each).identity?.agentPrincipal
        }),
      model: role => agentOfRole(role as MatrixHostRole)?.invocation?.model ?? MATRIX_DEFAULT_MODEL,
      effort: role => agentOfRole(role as MatrixHostRole)?.invocation?.effort,
      // A check-in's one model call, for the default assistant only (check-ins.ts).
      checkInCall: role => agentOfRole(role as MatrixHostRole) === defaultAgent && Boolean(checkIns?.takeCall()),
      sweepCall: role => backgroundSweepModelCalls.take(role),
      // A paid assistant's scheduled run: bound to the Store on the lease holder, else silent.
      scheduledRun: (role, job) => storeRuns.binding(role, job),
      training: async (role, signal) => {
        const agent = agentOfRole(role as MatrixHostRole)
        const turn = agent?.invocation

        if (!turn?.storeTask || turn.app) {
          return null
        }

        signal.throwIfAborted()

        if (turn.abort.signal.aborted || enrollmentOf(agent!).state !== 'ready' || !account.appScope()) {
          throw new Error('matrix_store_execution_denied')
        }

        return turn.storeTask
      },
      hatch: (role, operationId, key, signal) => {
        const run = matrixPetHatches.get(operationId)

        return Boolean(
          run &&
          run.proxyKey === key &&
          !signal.aborted &&
          !run.abort.signal.aborted &&
          run.role === role &&
          run.accountKey === account.appScope()?.accountKey
        )
      }
    })

    // A taken port only disables Atum's model for this launch; chat keeps working.
    managedModel = await candidate.start().then(
      () => candidate,
      () => {
        console.warn('[Matrix] managed model proxy unavailable on port', config.managedModel!.port)

        return undefined
      }
    )
  }

  // Full power needs only the installed Google client; the protected path still needs its managed
  // model proxy. In either mode, the minted key reaches only the default assistant's launch.
  if (googleAssistant.wantsBroker()) {
    const tools = new MatrixGoogleTools({
      gate: role => googleAssistant.gate(role),
      connections: () => googleConnections,
      log: line => console.warn(line)
    })

    googleTools = await tools.start().then(
      () => tools,
      () => {
        console.warn('[Matrix] google tools unavailable')

        return undefined
      }
    )
  }

  ui = new BrowserWindow(
    matrixWindowOptions({
      // What the Window menu, Mission Control and the Dock call it. The identity name and data
      // folder (app-identity.ts) stay as they are.
      title: 'Atum',
      webPreferences: {
        preload: path.join(assets, 'matrix-ui-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:matrix-ui',
        webviewTag: true,
        webSecurity: true
      },
      titleBarOverlay:
        process.platform === 'darwin' ? undefined : { color: '#F4F5F7', symbolColor: '#202124', height: 40 }
    })
  )

  // Reuse the old app's inventory and placement engine, not its gateway/auth
  // root. Machine launch is independent of optional agent/backend readiness.
  const nativeHostIds = new WeakMap<Host, string>()

  const nativeAuthority = () => {
    const host = hosts.get('human')

    if (!host || closing || state.state !== 'ready' || !state.identity) {
      return ''
    }

    let id = nativeHostIds.get(host)

    if (!id) {
      id = randomUUID()
      nativeHostIds.set(host, id)
    }

    return `${id}:${state.identity.userId}:${state.identity.deviceId}:${state.roomId ?? ''}`
  }

  const voiceSource: MatrixVoiceSource = {
    authority: () => {
      const owner = account.appScope()
      const host = nativeAuthority()

      return owner && host ? `${host}:${owner.accountKey}:${owner.generation}` : ''
    },
    roomId: () => state.roomId ?? undefined,
    runtime: () => runtime,
    agent: agentOfRoom,
    enrollment: enrollmentOf,
    blocked: agent => agent.closed || lifecycle.blocksRuntime(agent.principal),
    verifyRoom: async (roomId, agent) => {
      const humanHost = hosts.get('human')
      const agentHost = hosts.get(agent.role)

      if (!humanHost || !agentHost) {
        throw new Error('matrix_voice_unavailable')
      }

      await requireAssistantRoom(roomId, humanHost, agentHost, { forTurn: true })
    },
    connection: agent => agent.executor?.connected,
    connect: async agent => {
      if (!agent.executor?.connected) {
        await startAssistantHermes(agent)
      }

      return agent.executor?.connected
    }
  }

  ipcMain.handle(MATRIX_VOICE_IPC.request, async (event, input: unknown) => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)
    const { roomId, ...operation } = parseMatrixVoiceRequest(input)
    const binding = await bindMatrixVoice(voiceSource, roomId)

    return binding.scope.request(operation)
  })
  ipcMain.handle(MATRIX_VOICE_IPC.microphone, async (event, roomId: unknown) => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)
    microphoneConsent = undefined
    const binding = await bindMatrixVoice(voiceSource, roomId)
    const granted = process.platform !== 'darwin' || (await systemPreferences.askForMediaAccess('microphone'))

    if (!granted || !binding.isCurrent()) {
      return false
    }

    microphoneConsent = binding.isCurrent

    return true
  })

  const nativeHelper = path.join(assets, 'atum-app-window').replace('app.asar/', 'app.asar.unpacked/')

  const nativeInventory = createNativeAppInventory({
    getAppPresentation: paths => nativeAppPresentation(nativeHelper, paths)
  })

  nativeApps = new NativeAppsController({
    inventory: nativeInventory,
    windows: createNativeAppWindows(nativeHelper),
    window: () => (nativeAuthority() ? (ui ?? null) : null),
    authority: nativeAuthority,
    authorizePath: () => {
      throw new Error('NATIVE_APP_INVALID_REQUEST')
    },
    workArea: bounds => screen.getDisplayMatching(bounds).workArea,
    beforeLaunch: async () => {
      await documents.hideWord()
    },
    ended: id => {
      if (ui && !ui.isDestroyed()) {
        ui.webContents.send(MATRIX_NATIVE_APPS.ended, id)
      }
    }
  })
  registerMatrixClipboard(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    writeText: text => clipboard.writeText(text)
  })
  ipcMain.handle(MATRIX_MESSAGE_LINK_IPC.pending, event => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)

    return messageLinks.take()
  })
  ipcMain.handle(MATRIX_INVITE_LINK_IPC.pending, event => {
    requireMatrixCaller(event, ui?.webContents, UI_URL)

    return inviteLinks.take()
  })
  registerMatrixMacSourcesIpc(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    read: () => macSourcesConsentStore().read(),
    set: setMacSourceConsent
  })
  registerMatrixFolderAccessIpc(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    access: {
      read: () => matrixFolderAccess().read(),
      apply: choices => matrixFolderAccess().apply(choices),
      add: () => matrixFolderAccess().add(),
      remove: id => matrixFolderAccess().remove(id)
    }
  })
  registerMatrixAgentSourcesIpc(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    settings: new MatrixAgentSourceSettings({
      scope: macSourcesConsentScope,
      gates: () => macSourceGates(macSourcesConsentStore().read()),
      facts: accountSourceFacts,
      macs: async () => {
        const rows = await deviceRegistryTransport(s1Call).list(AbortSignal.timeout(3_000)).catch(() => null)
        const enrollment = deviceIdentity?.enrollment()
        if (process.platform !== 'darwin') {return rows ? projectMacFleet(rows, undefined) : []}
        const presence = deviceIdentity?.presence()
        const connected = presence?.state === 'enrolled' && presence.connection === 'status_exchanged'
        const sources = nativeMacSourceStatus(macSourcesConsentStore().read(), accountSourceFacts().fullDisk, macLocationAccessStatus())
        const here = { id: enrollment?.deviceServiceId ?? macSourcesConsentStore().installationId(), name: macComputerName(), thisMac: true,
          state: !connected ? 'not_connected' as const : Object.values(sources).includes('needs_permission') ? 'needs_permission' as const : 'ready' as const, sources }
        return rows ? projectMacFleet(rows, here) : [here]
      },
      // R1 supplies verified legacy-writer evidence. Never infer it from a gate change.
      heldOff: gate => sourceGateSync?.heldOff(gate) ?? [],
      refresh: () => sourceGateSync?.refreshRead() ?? Promise.resolve(),
      notice: () => {
        if (shownOnThisMac()) {return undefined}
        const store = macSourcesConsentStore()
        const consent = store.read()
        const overridden = store.overriddenOptOuts()
        const sources = (['messages', 'browser', 'location', 'folders'] as const)
          .filter(source => consent[source] || overridden.includes(source))
        const noticed = [...new Set([...sources, ...overridden])].map(source => source === 'teamSpaces' ? 'team_spaces' as const : source)
        return noticed.length ? { sources: noticed } : undefined
      },
      presented: () => {
        if (!ui?.isFocused()) {return}
        const store = macSourcesConsentStore()
        store.presented(store.installationId())
        announceSourceChoicesChanged()
        void reconcileDeviceControl(true)
      },
      commit: (gate, enabled) => macSourceGates(commitMacSourceConsent(
        gate === 'team_spaces' ? 'teamSpaces' : gate,
        enabled
      )),
      save: async (gate, enabled) => {
        await setMacSourceConsent(gate === 'team_spaces' ? 'teamSpaces' : gate, enabled)
      },
      sync: () => sourceGateSync?.reconcile()
    })
  })
  registerMatrixPermissions(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    platform: process.platform,
    isTrustedAccessibilityClient: prompt => systemPreferences.isTrustedAccessibilityClient(prompt),
    getMediaAccessStatus: type => systemPreferences.getMediaAccessStatus(type),
    getFullDiskAccessStatus: () => {
      const home = app.getPath('home')

      return probeFullDiskAccess({
        messages: path.join(home, 'Library', 'Messages', 'chat.db'),
        safari: path.join(home, 'Library', 'Safari', 'History.db')
      })
    },
    // CoreLocation is not wired into this release yet. Never claim a grant or trigger a prompt.
    getLocationAccessStatus: macLocationAccessStatus,
    openExternal: url => shell.openExternal(url),
    relaunch: () => {
      app.relaunch()
      app.quit()
    }
  })
  registerMatrixNativeApps(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    authority: nativeAuthority,
    inventory: nativeInventory,
    controller: nativeApps,
    openSettings: async () => {
      systemPreferences.isTrustedAccessibilityClient(true)
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    },
    readiness: (roomId, refresh) =>
      readMatrixNativeAppReadiness(
        {
          authority: nativeAuthority,
          roomId: () => state.roomId ?? undefined,
          runtime: () => runtime,
          agent: id => agentOfRoom(id),
          enrollment: enrollmentOf,
          blocked: agent => agent.closed || lifecycle.blocksRuntime(agent.principal),
          connection: agent => agent.executor?.connected,
          connect: async agent => {
            if (!agent.executor?.connected) {
              await startAssistantHermes(agent)
            }

            return agent.executor?.connected
          }
        },
        roomId,
        refresh
      )
  })
  ui.on('focus', () => {
    void ownPresence.refresh()
    void nativeApps?.refresh().catch(() => {})

    // The app catalog is read at sign-in; a window left open for days looks again when it comes
    // forward (app-workspace.ts `revalidate`), so an app published since appears without a restart.
    if (!closing && state.state === 'ready') {
      void matrixApps?.revalidate().catch(() => {})
    }

    void documents.refreshWord()
    void wallet?.refresh('focus')
    if (!closing && account.identity()) {void store?.refresh()}
  })
  ui.on('blur', () => void ownPresence.away())
  ui.on('close', () => {
    void nativeApps?.clear()
    void documents.hideWord()
  })

  // Management pages are bundled, native-owned contents, never chat authority.
  // The weak binding keeps account/executor routing out of both renderer bridges.
  const pagesScopes = new WeakMap<
    MatrixPagesScope,
    {
      accountKey: string
      generation: number
      agentRuntime: MatrixAgentRuntime
      ownerPrincipal: string
      agentPrincipal: string
      executorId: string
      home: string
    }
  >()

  const pagesHubs = new WeakMap<MatrixPagesScope, MatrixPagesHubScope>()
  const pagesAuxiliary = new WeakMap<MatrixPagesScope, MatrixPagesAuxiliaryScope>()
  const pagesRuntimes = new WeakMap<MatrixPagesScope, ReturnType<typeof createMatrixPagesRuntimeScope>>()
  const pagesComputerUses = new WeakMap<MatrixPagesScope, ReturnType<typeof createMatrixPagesComputerUseScope>>()

  const pagesComputerUseGrants = new WeakMap<
    MatrixPagesScope,
    ReturnType<typeof createMatrixPagesComputerUseGrantScope>
  >()

  const pagesProviders = new WeakMap<MatrixPagesScope, MatrixPagesProvidersScope>()
  /** A page that signed its agent in to a plan, or chose its model: when it closes, that agent
   * checks again (its backend is the page's until then; providers wiring below). */
  const pagesRecheck = new WeakMap<MatrixPagesScope, MatrixAgentRuntime>()
  const pagesMcps = new WeakMap<MatrixPagesScope, MatrixPagesMcpScope>()
  const pagesManagement = new WeakMap<MatrixPagesScope, MatrixPagesManagementTransport>()
  const pagesCommandCenters = new WeakMap<MatrixPagesScope, MatrixPagesCommandCenterScope>()
  const pagesCurators = new WeakMap<MatrixPagesScope, MatrixPagesCuratorScope>()
  const pagesDebugShares = new WeakMap<MatrixPagesScope, MatrixPagesDebugShareScope>()
  const pagesMaintenance = new WeakMap<MatrixPagesScope, MatrixPagesCommandCenterOpsScope>()
  const pagesStarmaps = new WeakMap<MatrixPagesScope, MatrixPagesStarmapScope>()
  const pagesVoiceSettings = new WeakMap<MatrixPagesScope, MatrixPagesVoiceSettingsScope>()
  const pagesToolSettings = new WeakMap<MatrixPagesScope, MatrixPagesToolSettingsScope>()

  const pagesCurrent = (scope: MatrixPagesScope) => {
    const bound = pagesScopes.get(scope)
    const owner = account.appScope()

    if (
      !bound ||
      !owner ||
      closing ||
      bound.agentRuntime.closed ||
      isCloudOnlyAgent(bound.agentRuntime) ||
      lifecycle.blocksRuntime(bound.agentRuntime.principal) ||
      !allAgents().includes(bound.agentRuntime) ||
      owner.accountKey !== bound.accountKey ||
      owner.generation !== bound.generation
    ) {
      return false
    }

    const enrollment = enrollmentOf(bound.agentRuntime)

    return (
      enrollment.state === 'ready' &&
      enrollment.identity?.principal === bound.ownerPrincipal &&
      enrollment.identity.agentPrincipal === bound.agentPrincipal &&
      enrollment.identity.executorId === bound.executorId
    )
  }

  const managementFor = (scope: MatrixPagesScope) => {
    let transport = pagesManagement.get(scope)

    if (!transport) {
      const selected = pagesScopes.get(scope)?.agentRuntime

      if (!selected) {
        throw new Error('pages_agent_unavailable')
      }

      transport = new MatrixPagesManagementTransport({
        isCurrent: () => pagesCurrent(scope) && Boolean(hermesPages?.ownsScope(scope)),
        connection: () => selected.executor?.connected,
        connect: () => startAssistantHermes(selected),
        lock: selected.lock,
        busy: () =>
          Boolean(
            operation ||
            domainOperation ||
            selected.operation ||
            selected.invocation ||
            selected.setup ||
            selected.localTurns?.executionPending
          )
      })
      pagesManagement.set(scope, transport)
    }

    return transport
  }

  const confirmManagement = (scope: MatrixPagesScope, request: MatrixProviderConfirmation | MatrixMcpConfirmation) =>
    oneDialogAtATime(async () => {
      if (!managementFor(scope).current() || !ui) {
        throw new Error('pages_agent_unavailable')
      }

      const copy = matrixManagementConfirmationCopy(scope.context.locale, scope.context.agentName, request)

      const result = await dialog.showMessageBox(ui, {
        type: 'question',
        title: copy.title,
        message: copy.title,
        detail: copy.detail,
        buttons: [copy.cancel, copy.apply],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })

      return result.response === 1 && managementFor(scope).current()
    })

  hermesPages = new MatrixPagesController({
    window: () => ui ?? undefined,
    uiContents: () => ui?.webContents,
    uiUrl: UI_URL,
    pagesFile: path.join(assets, 'pages', 'matrix-pages.html'),
    opened: (input, result, ms) =>
      console.warn(matrixPagesOpenLogLine({ page: input?.page, agentPrincipal: input?.agentPrincipal, result, ms })),
    preload: path.join(assets, 'matrix-pages-preload.js'),
    resolve: input => {
      if (
        !input ||
        !MATRIX_PAGE_IDS.includes(input.page) ||
        !['vi', 'en', 'zh', 'zh-hant', 'ja'].includes(input.locale) ||
        !['light', 'dark'].includes(input.appearance) ||
        !matrixPagesHubAllowed(input)
      ) {
        throw new Error('pages_invalid_request')
      }

      const owner = account.appScope()

      const candidates = allAgents()
      const requested =
        input.agentPrincipal === undefined
          ? candidates[0]
          : candidates.find(agent => agent.agentPrincipal === input.agentPrincipal)

      // A cloud/standby assistant can answer normally while this Mac has no local host to manage.
      // Classify that expected state before local enrollment selection so the page shell explains
      // it instead of offering a retry that can never start the cloud host from this Mac.
      if (
        requested &&
        !hosts.get(requested.role)?.ready &&
        matrixCloudAgentAnswersInCloud({
          cloudRoute: isCloudAgent(requested),
          role: cloudAgentMacRole(requested)
        })
      ) {
        throw new Error('pages_agent_not_running')
      }

      // A legacy cloud-only agent has no Hermes on this Mac for these pages to manage. A saved
      // H-F destination may use the same local management surface while its policy stays enabled.
      if (
        input.agentPrincipal !== undefined &&
        isCloudOnlyAgent(allAgents().find(agent => agent.agentPrincipal === input.agentPrincipal))
      ) {
        throw new Error('pages_agent_cloud')
      }

      const { agent: selected, identity } = selectMatrixPagesAgent(candidates, enrollmentOf, input.agentPrincipal)

      if (
        !owner ||
        !selected ||
        !runtime ||
        closing ||
        selected.closed ||
        lifecycle.blocksRuntime(selected.principal)
      ) {
        throw new Error('pages_agent_unavailable')
      }

      const scope: MatrixPagesScope = {
        key: `${owner.accountKey}:${owner.generation}:${identity.agentPrincipal}:${identity.executorId}`,
        context: {
          page: input.page,
          locale: input.locale,
          appearance: input.appearance,
          agentPrincipal: identity.agentPrincipal,
          agentName: selected.name ?? 'Atum',
          local: true,
          // Where the jobs actually run: not on a standby Mac whose ticker is held for another
          // destination that answers (cloud-agent-placement.ts).
          jobsRunHere: ((plan: MatrixAgentJobsPlan) => plan.tick && !plan.holdUntilAnswering)(agentJobsPlan(selected)),
          // Where the Store sent the person; the page itself still asks before installing.
          ...(input.hub ? { hub: input.hub } : {})
        }
      }

      pagesScopes.set(scope, {
        ...owner,
        agentRuntime: selected,
        ownerPrincipal: identity.principal,
        agentPrincipal: identity.agentPrincipal,
        executorId: identity.executorId,
        home: agentHermesHome(selected, identity, runtime)
      })

      return scope
    },
    isCurrent: pagesCurrent,
    retired: scope => {
      pagesManagement.get(scope)?.retire()
      void pagesProviders
        .get(scope)
        ?.stop()
        .catch(() => {})
      pagesMcps.get(scope)?.stop()

      const agent = pagesRecheck.get(scope)

      if (agent?.readiness?.current.phase === 'blocked') {
        agent.readiness.recheck()
      }
    },
    request: (scope, request) => {
      if (isMatrixComputerUseRequest(request?.path) || isMatrixComputerUseGrantRequest(request?.path)) {
        let computerUse = pagesComputerUses.get(scope)

        if (!computerUse) {
          const transport = managementFor(scope)
          computerUse = createMatrixPagesComputerUseScope({
            isCurrent: () => transport.current(),
            forward: value => transport.forward(value)
          })
          pagesComputerUses.set(scope, computerUse)
        }

        if (isMatrixComputerUseRequest(request?.path)) {
          return computerUse.request(request)
        }

        let grant = pagesComputerUseGrants.get(scope)

        if (!grant) {
          const transport = managementFor(scope)
          const passive = computerUse
          grant = createMatrixPagesComputerUseGrantScope({
            platform: process.platform,
            isCurrent: () => transport.current(),
            status: () => passive.request({ path: '/api/tools/computer-use/status', method: 'GET' }),
            forward: value => transport.forward(value),
            confirm: () =>
              oneDialogAtATime(async () => {
                if (!transport.current() || !ui) {
                  return false
                }

                const copy = matrixComputerUseGrantConfirmationCopy(scope.context.locale, scope.context.agentName)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.request],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1 && transport.current()
              })
          })
          pagesComputerUseGrants.set(scope, grant)
        }

        return grant.request(request)
      }

      if (isMatrixProvidersRequest(request?.path) || isMatrixMcpRequest(request?.path)) {
        const transport = managementFor(scope)

        const openExternal = async (url: string) => {
          if (!transport.current()) {
            throw new Error('pages_agent_unavailable')
          }

          // URL is already validated by the native operation adapter, never taken
          // from a renderer-supplied open-link command.
          await shell.openExternal(url)

          if (!transport.current()) {
            throw new Error('pages_agent_unavailable')
          }
        }

        if (isMatrixProvidersRequest(request?.path)) {
          let providers = pagesProviders.get(scope)

          if (!providers) {
            const agentOfPage = pagesScopes.get(scope)!.agentRuntime

            providers = new MatrixPagesProvidersScope({
              surface: scope.context.page === 'providers' ? 'advanced' : 'connections',
              readPlanAcknowledgment: provider => {
                const bound = pagesScopes.get(scope)

                if (!transport.current() || !bound || !runtime) {
                  throw new Error('matrix_pages_agent_unavailable')
                }

                return readMatrixPlanAcknowledgment(runtime, bound.ownerPrincipal, provider)
              },
              savePlanAcknowledgment: acknowledgment => {
                const bound = pagesScopes.get(scope)

                if (!transport.current() || !bound || !runtime) {
                  throw new Error('matrix_pages_agent_unavailable')
                }

                saveMatrixPlanAcknowledgment(runtime, bound.ownerPrincipal, acknowledgment)
              },
              forward: request => transport.forward(request),
              isCurrent: () => transport.current(),
              confirm: request => confirmManagement(scope, request),
              openExternal,
              cancelOAuth: sessionId => transport.cancelOAuth(sessionId),
              selected: (provider, model, reasoning, capability) => {
                if (!transport.current()) {
                  throw new Error('pages_agent_unavailable')
                }

                const bound = pagesScopes.get(scope)!
                const own = provider !== MATRIX_MANAGED_ENDPOINT.id
                rememberOwnModel(
                  bound.executorId,
                  own,
                  bound.agentRuntime,
                  own
                    ? {
                        provider,
                        model,
                        ...(reasoning === undefined ? {} : { reasoning }),
                        ...(capability ? { capability } : {})
                      }
                    : undefined
                )
                pagesRecheck.set(scope, bound.agentRuntime)
                publish(state)
              },
              // The backend holding a sign-in stays up until the person has approved it
              // (holdsSignIn); what waited for it (a restart for a new jobs room or Google
              // tools) is tried again once the last one ends.
              signingIn: active => {
                agentOfPage.signIns = Math.max(0, agentOfPage.signIns + (active ? 1 : -1))

                if (!active && agentOfPage.signIns === 0) {
                  publish(state)
                }
              },
              // Saved where every assistant of this account reads it (codex-accounts.ts): the
              // others waiting on it check now; this one once its page closes, so its check
              // does not replace the backend the page still uses.
              signedIn: provider => {
                console.warn(`[Matrix] plan sign-in saved provider=${provider}`)
                pagesRecheck.set(scope, agentOfPage)

                for (const each of allAgents()) {
                  if (each !== agentOfPage && each.planSignIn && each.readiness?.current.phase === 'blocked') {
                    each.readiness.recheck()
                  }
                }
              },
              disconnected: provider => {
                const bound = pagesScopes.get(scope)

                // Hermes's disconnect clears this assistant's copy; the account's shared
                // sign-in would otherwise sign it straight back in.
                if (provider === 'openai-codex' && bound && runtime) {
                  forgetMatrixAccountCodexSignIn(runtime, bound.ownerPrincipal)
                }
              }
            })
            pagesProviders.set(scope, providers)
          }

          return providers.request(request)
        }

        let mcp = pagesMcps.get(scope)

        if (!mcp) {
          mcp = new MatrixPagesMcpScope({
            forward: request => transport.forward(request),
            isCurrent: () => transport.current(),
            confirm: request => confirmManagement(scope, request),
            reload: () => transport.reload(),
            openExternal
          })
          pagesMcps.set(scope, mcp)
        }

        return mcp.request(request)
      }

      const forward = async (normalized: Parameters<NonNullable<MatrixHermesConnection['pages']>>[0]) => {
        if (!pagesCurrent(scope)) {
          throw new Error('pages_agent_unavailable')
        }

        const selected = pagesScopes.get(scope)!.agentRuntime

        if (!selected.executor?.connected) {
          await startAssistantHermes(selected)
        }

        if (!pagesCurrent(scope)) {
          throw new Error('pages_agent_unavailable')
        }

        const connection = selected.executor?.connected

        if (!connection?.pages) {
          throw new Error('pages_hermes_starting')
        }

        const result = await connection.pages(normalized)

        if (!pagesCurrent(scope)) {
          throw new Error('pages_agent_unavailable')
        }

        return result
      }

      if (
        typeof request?.path === 'string' &&
        (request.path.startsWith('/api/skills/hub/') || request.path.startsWith('/api/actions/'))
      ) {
        let hub = pagesHubs.get(scope)

        if (!hub) {
          hub = createMatrixPagesHubScope({
            isCurrent: () => pagesCurrent(scope),
            forward,
            confirm: (identifier, operation) =>
              oneDialogAtATime(async () => {
                if (!pagesCurrent(scope) || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy =
                  operation === 'scan'
                    ? matrixPagesScanCopy(scope.context.locale)
                    : operation === 'archive'
                      ? matrixPagesArchiveCopy(scope.context.locale)
                      : operation === 'update' || operation === 'update-all'
                        ? matrixPagesUpdateCopy(scope.context.locale, operation === 'update-all')
                        : matrixPagesInstallCopy(scope.context.locale)

                const action =
                  operation === 'scan'
                    ? matrixPagesScanCopy(scope.context.locale).scan
                    : operation === 'archive'
                      ? matrixPagesArchiveCopy(scope.context.locale).archive
                      : operation === 'update' || operation === 'update-all'
                        ? matrixPagesUpdateCopy(scope.context.locale, operation === 'update-all').update
                        : matrixPagesInstallCopy(scope.context.locale).install

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail(scope.context.agentName, identifier),
                  buttons: [copy.cancel, action],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1
              })
          })
          pagesHubs.set(scope, hub)
        }

        return hub.request(request)
      }

      if (isMatrixAuxiliaryRequest(request?.path)) {
        let settings = pagesAuxiliary.get(scope)

        if (!settings) {
          settings = new MatrixPagesAuxiliaryScope({
            isCurrent: () => pagesCurrent(scope),
            forward,
            confirm: request =>
              oneDialogAtATime(async () => {
                if (!pagesCurrent(scope) || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixAuxiliaryConfirmationCopy(scope.context.locale, scope.context.agentName, request)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.apply],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1
              })
          })
          pagesAuxiliary.set(scope, settings)
        }

        return settings.request(request)
      }

      if (isMatrixVoiceSettingsRequest(request?.path)) {
        let settings = pagesVoiceSettings.get(scope)

        if (!settings) {
          settings = new MatrixPagesVoiceSettingsScope({
            isCurrent: () => pagesCurrent(scope),
            forward,
            confirm: request =>
              oneDialogAtATime(async () => {
                if (!pagesCurrent(scope) || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixVoiceSettingsConfirmationCopy(scope.context.locale, scope.context.agentName, request)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.apply],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1
              })
          })
          pagesVoiceSettings.set(scope, settings)
        }

        return settings.request(request)
      }

      if (isMatrixRuntimeRequest(request?.path)) {
        let settings = pagesRuntimes.get(scope)

        if (!settings) {
          settings = createMatrixPagesRuntimeScope({
            isCurrent: () => pagesCurrent(scope),
            forward,
            confirm: request =>
              oneDialogAtATime(async () => {
                if (!pagesCurrent(scope) || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixRuntimeConfirmationCopy(scope.context.locale, scope.context.agentName, request)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.apply],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1
              })
          })
          pagesRuntimes.set(scope, settings)
        }

        return settings.request(request)
      }

      if (isMatrixToolSettingsRequest(request?.path)) {
        let settings = pagesToolSettings.get(scope)

        if (!settings) {
          settings = new MatrixPagesToolSettingsScope({
            isCurrent: () => pagesCurrent(scope),
            forward,
            confirm: request =>
              oneDialogAtATime(async () => {
                if (!pagesCurrent(scope) || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixToolSettingsConfirmationCopy(scope.context.locale, scope.context.agentName, request)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.allow],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1
              })
          })
          pagesToolSettings.set(scope, settings)
        }

        return settings.request(request)
      }

      if (isMatrixCuratorRequest(request)) {
        let curator = pagesCurators.get(scope)

        if (!curator) {
          const transport = managementFor(scope)
          curator = new MatrixPagesCuratorScope({
            home: pagesScopes.get(scope)!.home,
            isCurrent: () => transport.current(),
            forward: request => transport.forward(request),
            confirm: action =>
              oneDialogAtATime(async () => {
                if (!transport.current() || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixCuratorConfirmation(scope.context.locale, scope.context.agentName, action)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.allow],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1 && transport.current()
              })
          })
          pagesCurators.set(scope, curator)
        }

        return curator.request(request)
      }

      if (isMatrixDebugShareRequest(request)) {
        let sharing = pagesDebugShares.get(scope)

        if (!sharing) {
          const transport = managementFor(scope)
          sharing = new MatrixPagesDebugShareScope({
            isCurrent: () => transport.current(),
            forward: request => transport.forward(request),
            open: url => shell.openExternal(url),
            copy: url => clipboard.writeText(url),
            confirm: value =>
              oneDialogAtATime(async () => {
                if (!transport.current() || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixDebugConfirmationCopy(scope.context.locale, scope.context.agentName, value)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.allow],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1 && transport.current()
              })
          })
          pagesDebugShares.set(scope, sharing)
        }

        return sharing.request(request)
      }

      if (isMatrixCommandCenterOpsRequest(request)) {
        let maintenance = pagesMaintenance.get(scope)

        if (!maintenance) {
          const transport = managementFor(scope)
          maintenance = new MatrixPagesCommandCenterOpsScope({
            home: pagesScopes.get(scope)!.home,
            isCurrent: () => transport.current(),
            forward: request => transport.forward(request),
            reveal: archive => shell.showItemInFolder(archive),
            confirm: action =>
              oneDialogAtATime(async () => {
                if (!transport.current() || !ui) {
                  throw new Error('pages_agent_unavailable')
                }

                const copy = matrixMaintenanceConfirmationCopy(scope.context.locale, scope.context.agentName, action)

                const result = await dialog.showMessageBox(ui, {
                  type: 'question',
                  title: copy.title,
                  message: copy.title,
                  detail: copy.detail,
                  buttons: [copy.cancel, copy.allow],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return result.response === 1 && transport.current()
              })
          })

          pagesMaintenance.set(scope, maintenance)
        }

        return maintenance.request(request)
      }

      if (isMatrixCommandCenterRequest(request)) {
        let commandCenter = pagesCommandCenters.get(scope)

        if (!commandCenter) {
          const transport = managementFor(scope)
          commandCenter = new MatrixPagesCommandCenterScope({
            isCurrent: () => transport.current(),
            forward: request => transport.forward(request)
          })
          pagesCommandCenters.set(scope, commandCenter)
        }

        return commandCenter.request(request)
      }

      if (isMatrixStarmapRequest(request)) {
        let starmap = pagesStarmaps.get(scope)

        if (!starmap) {
          const transport = managementFor(scope)
          starmap = new MatrixPagesStarmapScope({
            isCurrent: () => transport.current(),
            forward: request => transport.forward(request)
          })
          pagesStarmaps.set(scope, starmap)
        }

        return starmap.request(request)
      }

      return forwardMatrixPagesRequest(request, forward)
    },
    readMedia: async (scope, value) => {
      if (!pagesCurrent(scope)) {
        throw new Error('pages_agent_unavailable')
      }

      return readMatrixPagesMedia(pagesScopes.get(scope)!.home, value)
    },
    openExternal: async value => {
      const url = matrixExternalLink(value)

      if (!url) {
        throw new Error('pages_link_invalid')
      }

      await shell.openExternal(url)
    }
  })
  hermesPages.register()

  if (config.appWorkspace && config.domain) {
    matrixApps = createMatrixApps({
      account,
      resource: config.domain.resource,
      views: () => appViews,
      openExternal: url => shell.openExternal(url),
      openAuthorize: request => openAppAuthSheet(request, ui ?? null),
      locale: windowLocale,
      changed: () => publish(state),
      log: line => console.warn(line),
      // Catalog icons fetched once per account, so a slow link never falls back to initials again.
      iconCache: new AppIconDiskCache(path.join(app.getPath('userData'), 'app-icons')),
      lookAssets,
      // The setup card's link confirms by itself only while this fresh read shows consent.
      botStatus: slug => account.appBotRequest(slug, 'read'),
      // A catalog that could not be read is read again in the background (app-workspace.ts).
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms)
        timer.unref?.()

        return () => clearTimeout(timer)
      },
      // The exact return came back: focus Atum while guarded auto-confirm settles.
      returned: () => {
        if (ui && !ui.isDestroyed()) {
          if (ui.isMinimized()) {
            ui.restore()
          }

          ui.show()
          ui.focus()
        }
      },
      catalogChanged: ids => command({ kind: 'appCatalog', appIds: ids }),
      stopParticipants: slug => stopAppHosts(slug),
      withdrawParticipant: async slug => {
        await stopAppHosts(slug)
        await account.revokeApp(slug)
      },
      reconcileParticipants: async (catalog, active) => {
        // Restore only after the authenticated catalog has settled its reset.
        // Cached consent never authorizes a new app, version or revoked link.
        for (const slug of account.appEnrollments()) {
          if (!active()) {
            return
          }

          try {
            const enrolled = account.appEnrollment(slug)
            const current = catalog.find(app => app.app === slug)
            const disposition = appHostDisposition(enrolled, current)

            if (disposition === 'withdraw') {
              await account.revokeApp(slug)
            } else if (disposition === 'restore') {
              await startHost(`app:${slug}`)
            } else {
              // A temporary outage suspends rather than erases a valid device.
              // Ambiguous pending issuance is inert until explicit retry/withdraw.
              await stopAppHosts(slug)
            }
          } catch {
            await stopAppHosts(slug)
          }
        }
      }
    })
    appViews = createAppViewController({
      panelPreload: path.join(assets, 'matrix-app-panel-preload.js'),
      // The controller permits this main-proven plain-page path only for v1 manifests.
      openRouteWithoutSession: slug => {
        const app = matrixApps?.snapshot().apps.find(candidate => candidate.app === slug)
        const room = state.rooms.find(candidate => candidate.id === state.roomId)

        return Boolean(
          app &&
            room &&
            isBotApiRoomForApp(state.messages, app, room.encrypted, {
              room,
              ownUserId: state.identity?.userId
            })
        )
      },
      createView: preferences => new WebContentsView({ webPreferences: preferences }),
      sessionFromPartition: partition => session.fromPartition(partition),
      hostWindow: () => ui ?? null,
      zoomFactor: () => ui?.webContents.getZoomFactor() ?? 1,
      ipcMain: {
        handle: (name, handler) =>
          ipcMain.handle(name, (event, ...args) => {
            requireMatrixCaller(event, ui?.webContents, UI_URL)

            if (!matrixAppViewCommandAllowed(name, !anyOperation() && !closing && state.state === 'ready')) {
              return { error: 'account_unavailable' }
            }

            return handler(event, ...args)
          }),
        removeHandler: name => ipcMain.removeHandler(name)
      },
      surfaces: () => matrixApps?.surfaces ?? null,
      account: () => matrixApps?.account() ?? null,
      knownAppIds: () => matrixApps?.knownAppIds() ?? [],
      userDataPath: app.getPath('userData'),
      readDirectory: async directory => {
        try {
          return (await readdir(directory, { withFileTypes: true })).map(entry => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isSymbolicLink: entry.isSymbolicLink()
          }))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
          }

          throw error
        }
      },
      openExternal: url => shell.openExternal(url),
      onReturnToHost: () => {
        ui?.webContents.send('matrix:apps:return')
      }
    })

    try {
      await appViews.sweepAllPartitions()
    } catch {
      // App storage cleanup failure must disable this optional composition,
      // never start with dirty sessions or take down Hermes/human chat.
      appViews.dispose()
      matrixApps = undefined
    }
  }

  // Preserve the dedicated-session clearing policy across Electron 44, never
  // the legacy partition or the Matrix SDK session.
  const pdfSession = session.fromPartition('persist:matrix-pdf')
  let pdfSessionReady = clearPdfViewSessionStorage(pdfSession)
  clearPdfSession = () => (pdfSessionReady = pdfSessionReady.then(() => clearPdfViewSessionStorage(pdfSession)))
  pdf = new AtumPdfViewController({
    ready: () => pdfSessionReady,
    host: () => {
      const window = ui

      return window
        ? {
            contentView: {
              addChildView: view => window.contentView.addChildView(view as WebContentsView),
              removeChildView: view => window.contentView.removeChildView(view as WebContentsView)
            },
            getContentSize: () => window.getContentSize() as [number, number],
            isDestroyed: () => window.isDestroyed()
          }
        : null
    },
    createView: () =>
      new WebContentsView({
        webPreferences: {
          session: pdfSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          plugins: true
        }
      }),
    pathToUrl: file => pathToFileURL(file).href,
    zoomFactor: () => ui?.webContents.getZoomFactor() ?? 1,
    resolvePath: token =>
      state.state === 'ready' && state.identity && !closing
        ? (state.roomId
            ? documents.resolvePreview({ userId: state.identity.userId, roomId: state.roomId }, token)
            : null) ?? drive?.resolvePreview(token) ?? null
        : null
  })
  hardenPdfViewSession(pdfSession, url => pdf.isServing(url))

  // The window is shown once it has chosen its size for its first screen (window-launch.ts).
  const windowChoice = matrixWindowChoice()

  const productWindow = installMatrixWindow({
    onModeChosen: windowChoice.chosen,
    beforeAuth: () => {
      void nativeApps?.clear()
      void documents.hideWord()
    },
    getWindow: () => ui,
    isUiSender: sender => sender === ui?.webContents,
    getWorkArea: bounds => screen.getDisplayMatching(bounds).workArea,
    ipc: {
      handle: (name, handler) =>
        ipcMain.handle(name, (event, ...args) => {
          requireMatrixCaller(event, ui?.webContents, UI_URL)

          return handler(event, ...args)
        }),
      removeHandler: name => ipcMain.removeHandler(name)
    },
    overlayWidth: () => (process.platform === 'darwin' ? 0 : 138),
    // The vibrancy material follows the native appearance, which the shell pins to its own
    // light/dark choice (window.ts), so the glass is never the opposite of the palette on it.
    setNativeAppearance: appearance => {
      nativeTheme.themeSource = appearance
    },
    log: line => console.warn(line),
    publishFacts: facts => {
      if (ui && !ui.isDestroyed()) {
        ui.webContents.send(MATRIX_WINDOW_CHANNELS.factsChanged, facts)
      }
    }
  })

  await lockWindow(ui, UI_URL, 'ui')
  ipcMain.on(MATRIX_WINDOW_CHANNELS.documentCloseReady, (event, id: unknown, ok: unknown) => {
    try {
      requireMatrixCaller(event, ui?.webContents, UI_URL)
    } catch {
      return
    }

    documentClose.acknowledge(id, ok)
  })
  let documentWindowCloseReady = false
  ui.on('close', event => {
    if (!closing && state.state === 'ready' && allAgents().some(each => each.continuous?.enabled)) {
      event.preventDefault()
      ui?.hide()

      return
    }

    if (!closing && !documentWindowCloseReady && documents.hasTextPreview()) {
      event.preventDefault()
      const window = ui
      void prepareDocumentClose()
        .then(() => {
          if (window && ui === window && !window.isDestroyed()) {
            documentWindowCloseReady = true
            window.close()
          }
        })
        .catch(() => console.warn('[Matrix] document_close_refused'))

      return
    }

    if (!closing && process.platform === 'darwin') {
      event.preventDefault()
      ui?.hide()
    }
  })
  ui.on('closed', () => {
    productWindow.dispose()

    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
  // Preserve state, recovery and failure handling across interrupted operations.
  watchMatrixDisk({
    read: () => matrixFreeBytes(app.getPath('userData')),
    changed: health => {
      diskHealth = health
      publish(state)
    },
    log: line => console.warn(line)
  })
  ipcMain.handle(channel.sdkConfig, event => {
    const [role, host] = requireHost(event)

    const value = {
      ...boundSdkConfiguration(account, role, host.identity, host.refreshHandle),
      deviceIsolation: host.deviceIsolation,
      ...(role === 'human'
        ? { companyPrivateCosNotificationRoomIds: privateCosNotificationRoomIds() }
        : {})
    }

    if (host.refreshHandle) {
      host.holds = tokenDigest(value.accessToken)
    }

    return value
  })
  ipcMain.handle(channel.sdkRefresh, async (event, handle: string) => {
    const [role, host] = requireHost(event)

    // An agent's host takes the token main renewed; it never renews its own (sdk-host.ts).
    // An app's host has no handle, and is signed out as before.
    if (role !== 'human') {
      const { result, holds } = await matrixAgentSdkRefresh({
        handle,
        expected: host.refreshHandle,
        configuration: () => ({
          ...boundSdkConfiguration(account, role, host.identity, host.refreshHandle),
          deviceIsolation: host.deviceIsolation
        }),
        holds: host.holds,
        digest: tokenDigest,
        // The renewal in flight, or one that is due and now runs without the idle wait,
        // since the token it replaces was just refused (credential-renewal.ts).
        renewing: () => host.renewing ?? host.renewal?.expedite()
      })

      if (holds) {
        host.holds = holds
      }

      return result
    }

    const result = await account.refresh(handle)

    // Only the sign-in server refusing the grant ends the session (session-route.ts): the
    // compact sign-in, saying so. A passing failure leaves the engine to ask again; an old
    // engine's handle or a sign-out in progress belongs to main's own operation.
    if (matrixSessionAction(result, 'engine') === 'session_ended') {
      void endChatSession()
    } else if (result.ok === false && result.reauthenticate) {
      console.warn(`[Matrix] chat refresh not served cause=${result.cause ?? 'unknown'}`)
    }

    return result
  })
  ipcMain.on(channel.sdkGoogleFence, (event, value: unknown) => {
    try {
      const [role, host] = requireHost(event)
      // Agent and app hosts observe their own accounts: dropped without a word (google-fence.ts).
      const sender = matrixGoogleFenceSender(role, host, googleFenceOwner())

      if (sender === 'refuse') {
        throw matrixGoogleFenceSenderRefused()
      }

      if (sender === 'observe') {
        void googleFenceNotices?.observe(value).catch(error => googleFenceLog.failure(error))
      }
    } catch (error) {
      googleFenceLog.failure(error)
    }
  })
  // A message a host could not decrypt: a hashed, rate-limited line (undecryptable-log.ts).
  ipcMain.on(channel.sdkUndecryptable, (event, value: unknown) => {
    try {
      const [role] = requireHost(event)
      undecryptableLog.observe(role, value)
    } catch {
      /* Not one of this Mac's SDK hosts: nothing to say. */
    }
  })
  ipcMain.on(channel.sdkSnapshot, (event, snapshot: MatrixSnapshot) => {
    try {
      const [role, host] = requireHost(event)
      const agentRuntime = agentOfRole(role)
      host.profile = snapshot.ownProfile?.userId === host.identity.userId ? snapshot.ownProfile : undefined

      // A host whose sync is only reconnecting is degraded, not down (host-health.ts): it keeps
      // what it carries and takes no new claim. Its coming back, or going down for good, is
      // looked at again at once (the lease, the watches), since no other event says so.
      const liveness = matrixHostLiveness(snapshot)
      const degradedChanged = (host.degraded === true) !== (liveness === 'degraded')
      host.degraded = liveness === 'degraded'

      if (degradedChanged) {
        scheduleContinuousListening()
      }

      if (agentRuntime) {
        observeAssistantNames()
      }

      const humanReplacement = role === 'human' && ownerRepairPreservesWork()

      if (matrixHostEndsTurns(liveness, humanReplacement)) {
        // A host that is starting, offline or signed out cannot carry a turn's question or
        // answer. A model check never uses a host, and every new host says "connecting"
        // first, so it keeps running (matrixTurnsNeedingHost, G1-13). A host whose sync is
        // reconnecting is not one of these: its turn goes on and its answer goes out through the
        // SDK's own retry once the sync is back (host-health.ts).
        for (const turn of matrixTurnsNeedingHost(role, allAgents())) {
          turn.abort.abort()
        }

        if (role === 'human') {
          for (const each of allAgents()) {
            stopListening('unavailable', each)
          }
        } else if (agentRuntime) {
          stopListening('unavailable', agentRuntime)
        }
      }

      if (role === 'human' && snapshot.state === 'ready') {
        // Account-scoped and automatic. Repeated ready snapshots coalesce; the background cadence
        // retries and notices a server-side deletion after this immediate sign-in attempt.
        void reconcileDeviceControl()
        humanPrepared = true
        refreshOwnerReaderTrust()
      }

      if (role !== 'human') {
        const wasReady = Boolean(host.ready)
        host.ready = snapshot.state === 'ready'

        // The agent can post again: settle scheduled posts a failure left pending.
        if (agentRuntime && host.ready && !wasReady) {
          armGroupTurns(agentRuntime, host)
          armAgentTasks(agentRuntime, host)

          // Existing hosts must also learn an assistant added after their first sync. Keep
          // their cutoff: refreshing the roster neither scans history nor drops live work.
          for (const each of allAgents()) {
            const otherHost = hosts.get(each.role)

            if (each !== agentRuntime && !each.closed && otherHost?.ready && each.groupWatchSince !== undefined) {
              armGroupTurns(each, otherHost, each.groupWatchSince)
            }
          }

          void resumeAfterAgentTrust(
            () => ensureAgentTrust(agentRuntime),
            agentMainRoomPlain(agentRuntime),
            () => (isCloudOnlyAgent(agentRuntime) ? undefined : agentRuntime.cron?.resume())
          )
        }

        if (agentRuntime && snapshot.state === 'error') {
          void stopHermesExecutor(agentRuntime)
        }

        publish(state)

        return
      }

      // The person's engine stopping is a line in main.log, once per cause.
      const engineError = snapshot.state === 'error' ? matrixLogCode(snapshot.error) : null

      if (engineError !== humanEngineError) {
        humanEngineError = engineError

        if (engineError) {
          console.warn(`[Matrix] chat engine error code=${engineError}`)
        }
      }

      // The homeserver refused this engine's token. That alone is not the session ending
      // (matrix-js-sdk gives up without a refresh on a token it believes unexpired): main asks
      // the sign-in server itself before the window says anything (confirmChatSession).
      if (matrixChatTokenRefused(snapshot) && state.identity && !closing) {
        // Now, or once a command holding main ends: never dropped (MEDIUM 3).
        sessionChecks.refused(host)

        return
      }

      // Main owns account lifecycle. Sync cannot reopen a locally closed UI;
      // use main's state, not another Keychain decrypt on every timeline update.
      if (state.identity && state.error !== 'matrix_signed_out' && state.error !== 'matrix_sign_out_pending') {
        // Each agent's turn or watch ends when its own room stops being its room.
        for (const each of allAgents()) {
          const turn = each.invocation

          // A group turn ends when its group does, and never touches the agent's own room or
          // its listening (group-turns.ts).
          if (!humanReplacement && turn?.group) {
            if (
              turn.roomId &&
              matrixGroupTurnInvalidated(
                snapshot.rooms,
                turn.roomId,
                each.userId,
                turn.groupMode === 'meeting'
                  ? { ownerId: host.identity.userId, ownAgentIds: ownAgentUserIds() }
                  : undefined
              )
            ) {
              turn.abort.abort()
            }
          }

          const protectedRoom =
            (turn?.app || turn?.group ? undefined : turn?.roomId) ?? each.listener.snapshot()?.roomId

          if (!humanReplacement && assistantRoomInvalidated(snapshot.rooms, protectedRoom, host.identity.userId, each.identity?.userId)) {
            forgetContinuousListening(each)
            stopListening('unavailable', each)

            // A model check belongs to no room: only the watch on the room ends (G1-13).
            if (!turn?.setup) {
              turn?.abort.abort()
            }
          }
        }

        // Connecting snapshots from the replacement carry no room evidence yet. Keep the
        // signed-in shell and its room context while the new human SDK starts.
        const humanSnapshot = matrixHumanSnapshot(snapshot, host.identity)
        publish(humanReplacement && snapshot.state !== 'ready'
          ? { ...state, state: snapshot.state === 'signed_out' ? 'connecting' : snapshot.state,
              identity: host.identity, presence: undefined, error: snapshot.error }
          : humanSnapshot)
        const published = state
        if (role === 'human' && snapshot.state === 'ready') {
          void ownPresence.refresh()
        }
        deviceApproval.observe(snapshot.security)
        unverifiedDevices.observe(host, snapshot.security, snapshot.state === 'ready')

        // A device with no name of its own gets "Atum · {model}", so the person's other devices
        // never show a raw ID when it asks to be approved (device-name.ts).
        if (snapshot.state === 'ready' && deviceNamed !== host) {
          deviceNamed = host
          macModel ??= readMatrixMacModel()
          void macModel
            .then(model => host.queue.command({ kind: 'nameOwnDevice', name: matrixDeviceName(model) }, 30_000))
            .catch(() => console.warn('[Matrix] device name not set'))
        }

        // The person's device unlocks by itself once its account's recovery is known
        // (owner-unlock.ts): after the first sync, after a new sign-in, after a key arrives, and
        // again when the identity it verified was replaced while it runs (the reset shows now).
        if (
          snapshot.state === 'ready' &&
          snapshot.security?.storage === 'present' &&
          (ownerUnlock?.host !== host ||
            ownerUnlock.result.state === 'unknown' ||
            (ownerUnlock.result.state === 'unlocked' && ownerUnlock.identity !== ownerIdentityChanges(host))) &&
          !ownerUnlockRunning &&
          Date.now() >= ownerUnlockRetryAt
        ) {
          void unlockOwner('sync')
        }

        void enrichAppBotDisplay(published, host).then(enriched => {
          // A later sync already owns the UI; evidence for an older timeline
          // may never repaint over it.
          if (!closing && hosts.get('human') === host && state === published && enriched !== published) {
            publish(enriched)
          }
        })

        if (matrixApps && snapshot.state === 'ready' && appLoadHost !== host) {
          appLoadHost = host
          void matrixApps.refresh().catch(() => {})
        }
      }
    } catch {
      /* Reject foreign senders without logging their payload. */
    }
  })
  ipcMain.on(channel.sdkResult, (event, id: string, ok: boolean, value: unknown) => {
    try {
      const [, host] = requireHost(event)
      host.queue.result(id, ok, value)
    } catch {
      return
    }
  })
  ipcMain.on(channel.sdkInvocation, (event, hint: unknown) => {
    try {
      const [role, host] = requireHost(event)
      const agentRuntime = agentOfRole(role)

      if (agentRuntime && host.ready && state.state === 'ready' && !closing) {
        if ((hint as { watchId?: unknown })?.watchId === MATRIX_AGENT_TASK_WATCH_ID) {
          void offerAgentTask(agentRuntime, host, hint).catch(() => {})

          return
        }

        // The owner's message to the agent in a group (src/matrix/group-turns.ts), else its
        // own room's watch.
        if (AGENT_ONE_CONVERSATION && (hint as { watchId?: unknown })?.watchId === 'earlier') {
          void offerEarlierConversation(agentRuntime, host, hint).catch(() => {})

          return
        }

        const group = matrixGroupHint(hint)

        if (group) {
          offerGroupTurn(agentRuntime, host, group)
        } else {
          agentRuntime.listener.offer(hint)
        }
      }
    } catch {
      // Hints carry identifiers, never authority; foreign senders are rejected.
    }
  })
  ipcMain.on(channel.sdkNotification, (event, hint: unknown) => {
    try {
      const [role, host] = requireHost(event)
      notifications.offer(role, host, hint)
    } catch {
      // Only the current, frame-validated human SDK may offer native alerts.
    }
  })
  ipcMain.handle(
    channel.ui,
    logNotesSelfOpenFailures(logAppChatFailures(async (
      event: Electron.IpcMainInvokeEvent,
      request: {
        kind?: string
        id?: unknown
        target?: MatrixPetTarget
        revision?: number
        pet?: AtumPetBinding
        enabled?: unknown
        value?: unknown
        appId?: string
        name?: unknown
        persona?: unknown
        hireConfirmed?: unknown
        assistantId?: unknown
        principal?: unknown
        agentPrincipal?: unknown
        /** `modelDestinations` write: `cloud` or `mac:<device-service-id>`. */
        destination?: unknown
        /** `modelDestinations` cap: the whole Proton count; 0 is no limit. */
        dailyProtons?: unknown
        action?: unknown
        /** `appConnection` begin only: the setup card's flow confirms on the gated return. */
        autoConfirm?: unknown
        command?: unknown
        deviceId?: unknown
        roomId?: string
        eventId?: string
        locale?: string
        ending?: unknown
        /** Consent disclosure is a fixed positive version supplied by the renderer. */
        disclosureVersion?: unknown
        model?: unknown
        response?: unknown
        body?: unknown
        /** Declaration-driven official-bot intake values; account validates the closed shape. */
        values?: unknown
        /** Standard visible reply relation for an app-bot addressed message. */
        replyTo?: unknown
        /** Explicit app-bot quote; main requires it to equal `replyTo`. */
        quote?: unknown
        /** `sendTurn`: the message a local turn replies to (parseMatrixTurnReply). */
        reply?: unknown
        token?: string
        url?: unknown
        turnId?: unknown
        method?: unknown
        /** `signOut`: forget the recovery key kept on this Mac too. */
        forgetKey?: unknown
        /** `approvalPick`: which of the three symbols, or null for none of them. */
        index?: unknown
        always?: unknown
        bounds?: { x: number; y: number; width: number; height: number }
        before?: unknown
        /** Subscription sign-in polling: the opaque native session handle. */
        session?: unknown
        /** `appHistory`: provider-owned opaque keyset cursor. */
        cursor?: unknown
        input?: unknown
        update?: unknown
        off?: unknown
        operationId?: unknown
        idempotencyKey?: unknown
        packId?: unknown
        entitlementId?: unknown
        companyStoreRequest?: unknown
        companyRequest?: unknown
        companyNativeFamily?: unknown
        companyNativeRequest?: unknown
        photo?: unknown
        companySearch?: unknown
        companySearchOpen?: unknown
        companyDesktop?: unknown
        aliasRequest?: unknown
        result?: unknown
        show?: unknown
        draftRevision?: unknown
        identity?: unknown
        /** `openSourceNotices`: the window's title, the row's words (parseMatrixNoticesTitle). */
        title?: unknown
      }
    ) => {
      if (request?.kind === 'alias-pending') {
        return handleMatrixAliasPending({
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          closing,
          available: () => Boolean(config.domain && state.identity && account.appScope()),
          pending: () => account.aliasPending(),
          log: line => console.warn(line)
        })
      }

      if (request?.kind === 'alias') {
        return handleMatrixAliasRequest(request.aliasRequest, {
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          closing,
          available: () => Boolean(config.domain && state.identity && account.appScope()),
          request: input => account.alias(input, AbortSignal.timeout(15_000)),
          log: line => console.warn(line)
        })
      }

      if (request?.kind === 'founder-contact') {
        return handleMatrixFounderContact({
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          closing,
          contact: () => (state.identity ? founderChat?.contact() : undefined)
        })
      }

      if (request?.kind === 'company-pending') {
        return handleMatrixCompanyPending({
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          enabled: config.companyWorkspace === true,
          closing,
          available: () => Boolean(state.identity && account.appScope()),
          pending: () => account.companyPending()
        })
      }

      if (request?.kind === 'company-avatar-upload') {
        requireMatrixCaller(event, ui?.webContents, UI_URL)

        if (config.companyWorkspace !== true || closing || !state.identity || !account.appScope()) {
          throw new Error('matrix_company_avatar_unavailable')
        }

        const photo = matrixProfilePhoto(request.photo)
        const value = matrixProfileMxc(await command({ kind: 'companyAvatarUpload', photo }, 60_000))

        if (!value) {throw new Error('matrix_company_avatar_unavailable')}

        return value
      }

      if (request?.kind === 'company-avatar-read') {
        requireMatrixCaller(event, ui?.webContents, UI_URL)
        const roomId = typeof request.roomId === 'string' ? request.roomId : ''
        const room = state.rooms.find(candidate => candidate.id === roomId)

        if (config.companyWorkspace !== true || closing || !state.identity || !account.appScope() ||
            room?.membership !== 'join' || !room.companyChannel) {
          return null
        }

        try {
          const value = await command({ kind: 'companyAvatarRead', roomId }, 60_000) as {
            roomId?: unknown
            avatarMxc?: unknown
            avatarUrl?: unknown
          } | null
          const mxc = value?.avatarMxc === null ? null : matrixProfileMxc(value?.avatarMxc)
          const url = value?.avatarUrl

          if (value?.roomId !== roomId || (value.avatarMxc !== null && !mxc) ||
              !(url === null || typeof url === 'string' && url.startsWith('data:image/') && url.length <= 4_000_000)) {
            return null
          }

          return { roomId, avatarMxc: mxc, avatarUrl: url }
        } catch {
          return null
        }
      }

      if (request?.kind === 'company-store') {
        requireMatrixCaller(event, ui?.webContents, UI_URL)

        if (closing || !state.identity || !companyStore) { throw new Error('company_store_unavailable') }
        companyStore.activate(account.appScope() ?? null)

        return companyStore.request(request.companyStoreRequest)
      }

      if (request?.kind === 'company') {
        return handleMatrixCompanyCommand(request.companyRequest, {
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          enabled: config.companyWorkspace === true,
          closing,
          fundingEnabled: config.companyFunding === true,
          projectSourcesEnabled: config.companyProjectSources === true,
          projectReaderEnabled: config.companyProjectReader === true,
          available: () => Boolean(state.identity && account.appScope()),
          request: input => account.company(input, AbortSignal.timeout(15_000))
        })
      }

      if (request?.kind === 'company-native') {
        return handleMatrixCompanyNativeCommand(
          { family: request.companyNativeFamily, request: request.companyNativeRequest },
          {
            event,
            ui: ui?.webContents,
            uiUrl: UI_URL,
            enabled: config.companyWorkspace === true,
            closing,
            available: () => Boolean(state.identity && account.appScope()),
            request: (family, value) =>
              family === 'ai'
                ? account.companyAI(value, AbortSignal.timeout(15_000))
                : family === 'funding'
                  ? account.companyFunding(value, AbortSignal.timeout(15_000))
                  : family === 'board'
                    ? account.companyBoard(value, AbortSignal.timeout(15_000))
                    : account.companyProjectBrain(value, AbortSignal.timeout(15_000))
          }
        )
      }

      if (request?.kind === 'company-desktop') {
        return handleMatrixCompanyDesktop(request.companyDesktop, {
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          enabled: config.companyWorkspace === true,
          closing,
          available: () => Boolean(state.identity && account.appScope()),
          board: value => account.companyBoard(value, AbortSignal.timeout(15_000)),
          ai: value => account.companyAI(value, AbortSignal.timeout(15_000)),
          privateCos: requestCompanyPrivateCos,
          funding: value => account.companyFunding(value, AbortSignal.timeout(15_000)),
          projectBrain: value => account.companyProjectBrain(value, AbortSignal.timeout(15_000)),
          channels: companyId => readCompanyChannelDirectory(account, companyId, AbortSignal.timeout(15_000)),
          sdk: value => command(value, 30_000),
          openBoardAttachment: async (companyId, file) => {
            const owner = hosts.get('human')
            const companyFiles = config.companyDriveFiles === true && config.companyWorkspace === true && Boolean(config.domain)

            if (!owner || !companyFiles || state.state !== 'ready' || file.company_id !== companyId) {
              throw new Error('matrix_company_file_unavailable')
            }

            const current = () => {
              try {
                const identity = account.identity()

                return !closing && hosts.get('human') === owner && state.state === 'ready' &&
                  identity?.userId === owner.identity.userId && identity?.deviceId === owner.identity.deviceId
              } catch {
                return false
              }
            }

            await openMatrixCompanyBoardAttachment(file, {
              pending: () => null,
              remember: () => {},
              clear: () => {},
              platform: (value, signal) => account.companyFile(value, signal),
              sdk: async () => {
                throw new Error('matrix_company_file_unavailable')
              },
              current
            }, async opened => {
              const target = await dialog.showSaveDialog(ui!, {
                defaultPath: path.basename(opened.name).replace(/[\\/]|\p{Cc}/gu, '_')
              })

              if (!target.canceled && target.filePath) {
                await saveUserSelectedFile(target.filePath, opened.bytes)
              }
            }, AbortSignal.timeout(10 * 60_000))
          },
          openExternal: async url => {
            // The renderer and the platform body are both untrusted for this side effect: re-run
            // the one shared PayOS rule at the shell boundary, never the caller's own check.
            if (!isTrustedPayOSUrl(url)) {
              throw new Error('matrix_company_funding_checkout_url_invalid')
            }

            await shell.openExternal(url)
          }
        })
      }

      if (request?.kind === 'company-search' || request?.kind === 'company-search-open') {
        const context = {
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          enabled: config.companyWorkspace === true,
          closing,
          available: () => Boolean(state.identity && account.appScope()),
          channels: async (companyId: string) => readCompanyChannelDirectory(account, companyId, AbortSignal.timeout(15_000)),
          conversations: async (companyId: string) => account.company(
            { action: 'conversations', companyId }, AbortSignal.timeout(15_000)
          ) as Promise<CompanyConversationDirectory15Response>,
          resolveHandle: async (handle: string) => {
            try {
              const result = await account.alias({ action: 'lookup', handle }, AbortSignal.timeout(15_000))

              return result.kind === 'lookup' && result.state === 'assigned' ? result.matrixUser : null
            } catch {
              // Public handles are an accuracy rung, not a new search dependency. The SDK may
              // still resolve a visible Matrix member name; unresolved results are labelled loaded history.
              return null
            }
          },
          sdk: (value: MatrixSdkCommand) => command(value, 30_000)
        }

        return request.kind === 'company-search'
          ? handleMatrixCompanySearch(request.companySearch, context)
          : handleMatrixCompanySearchOpen(request.companySearchOpen, context)
      }

      if (request?.kind === 'people-search' || request?.kind === 'people-privacy') {
        const context = {
          event,
          ui: ui?.webContents,
          uiUrl: UI_URL,
          closing,
          available: () => Boolean(state.identity && account.appScope() && matrixHumanSdkReady(state.state, hosts.get('human'))),
          alias: (input: Parameters<typeof account.alias>[0]) => account.alias(input, AbortSignal.timeout(15_000)),
          sdk: (value: MatrixSdkCommand) => command(value, 30_000)
        }

        return request.kind === 'people-search'
          ? handleMatrixPeopleSearch(request.input, context)
          : handleMatrixPeoplePrivacy(request.input, context)
      }

      requireMatrixCaller(event, ui?.webContents, UI_URL)

      // Cancellation is scoped to repair's browser trip, even while its operation owns the lock.
      if (request?.kind === 'cancelOwnerDeviceRepair') {
        ownerDeviceRepair?.cancel()

        return
      }

      // WS-4: the device Stop fence runs synchronously right after the caller check, before any await
      // and before the `anyOperation` lock below — a pending operation must never keep a device
      // command running after the owner pressed sign-out. It is a local Stop (grants end, the
      // controller gets a signed Stop, the connection stays usable) because the request may still be
      // refused as `matrix_operation_pending`; the sign-out fence proper runs inside `case 'signOut'`.
      fenceDeviceBeforeOperationLock(request?.kind, matrixDeviceStopFence)

      // Diagnostics only, from this window alone: never refused by a pending operation or sign-in.
      if (request?.kind === 'windowFailureDiagnostic') {
        const line = formatMatrixWindowFailureDiagnostic(request.value)

        if (line) {
          console.warn(line)
        }

        return
      }

      if (request?.kind === 'petDiagnostic') {
        petDiagnosticLog.observe(request.value)

        return
      }

      if (request?.kind === 'aliasDiagnostic') {
        // The create sheet's line or the launch walk's: closed values only, anything else dropped.
        const line = formatMatrixHandleDiagnostic(request.value)

        if (line) {
          console.warn(line)
        }

        return
      }

      if (request?.kind === 'awarenessRead' || request?.kind === 'awarenessChange') {
        const human = hosts.get('human'),
          identity = state.identity

        // Readiness is the human snapshot's (`host.ready` is set only for agent and app hosts).
        if (closing || !matrixHumanSdkReady(state.state, human) || !identity) {
          throw Error('matrix_awareness_unavailable')
        }

        const live = () =>
          !closing &&
          state.state === 'ready' &&
          hosts.get('human') === human &&
          state.identity?.userId === identity.userId &&
          state.identity?.deviceId === identity.deviceId

        if (request.kind === 'awarenessChange') {
          const own = request.identity as Partial<MatrixIdentity> | null

          if (
            !own ||
            Object.keys(own).length !== 2 ||
            own.userId !== identity.userId ||
            own.deviceId !== identity.deviceId ||
            typeof request.roomId !== 'string' ||
            !/^![^\s:]+:[^\s]+$/.test(request.roomId) ||
            !['include', 'exclude', 'forget'].includes(String(request.action))
          ) {
            throw Error('matrix_awareness_invalid')
          }
        }

        const rooms = await human.queue.command(
          request.kind === 'awarenessRead'
            ? { kind: 'awarenessRooms' }
            : {
                kind: 'awarenessRoomChange',
                roomId: request.roomId!,
                action: request.action as 'include' | 'exclude' | 'forget'
              },
          60_000
        )

        if (!live()) {
          throw Error('matrix_awareness_stale')
        }

        // No controls room: no owner reader was ever enrolled, so Settings shows nothing.
        if (rooms === null) {
          return { available: false }
        }

        return { identity: { userId: identity.userId, deviceId: identity.deviceId }, rooms }
      }

      // 0333: the owner's own coarse location and its one switch. Native only, account-scoped,
      // and never cached: Settings shows exactly what the platform stored.
      if (request?.kind === 'ownerLocationRead' || request?.kind === 'ownerLocationSetEnabled') {
        if (closing) {
          throw Error('matrix_owner_location_unavailable')
        }
        const signal = AbortSignal.timeout(10_000)
        if (request.kind === 'ownerLocationRead') {
          return await account.ownerLocation(signal)
        }
        if (typeof request.enabled !== 'boolean') {
          throw Error('matrix_owner_location_invalid')
        }
        return await account.setOwnerLocationEnabled(request.enabled, signal)
      }

      if (
        [
          'checkoutRefresh',
          'checkoutStart',
          'checkoutStatus',
          'checkoutResume',
          'checkoutOpen',
          'checkoutDismiss'
        ].includes(request?.kind ?? '')
      ) {
        if (closing || !state.identity || !account.appScope() || !checkout) {
          throw new Error('matrix_checkout_unavailable')
        }

        if (request.kind === 'checkoutRefresh') {
          return checkout.refresh()
        }

        if (request.kind === 'checkoutStart' && typeof request.packId === 'string') {
          return checkout.start(request.packId)
        }

        if (request.kind === 'checkoutStatus' || request.kind === 'checkoutResume') {
          return checkout.resume()
        }

        if (request.kind === 'checkoutOpen') {
          return checkout.openCheckout()
        }

        if (request.kind === 'checkoutDismiss') {
          return checkout.dismissTerminal()
        }

        throw new Error('matrix_checkout_invalid')
      }

      if (['storeRefresh', 'storePurchase', 'storeResume', 'storeCancel'].includes(request?.kind ?? '')) {
        if (closing || !state.identity || !account.appScope() || !store) {
          throw new Error('matrix_store_unavailable')
        }

        if (request.kind === 'storeRefresh') {
          return store.refresh()
        }

        if (request.kind === 'storePurchase') {
          return store.purchase(request.input)
        }

        if (request.kind === 'storeResume' && typeof request.idempotencyKey === 'string') {
          return store.resume(request.idempotencyKey)
        }

        if (request.kind === 'storeCancel' && typeof request.entitlementId === 'string') {
          return store.cancel(request.entitlementId)
        }

        throw new Error('matrix_store_invalid')
      }

      if (request?.kind === 'walletRefresh') {
        await wallet?.refresh('manual')

        return
      }

      if (request?.kind === 'walletHistory') {
        if (
          closing ||
          !state.identity ||
          !account.appScope() ||
          (request.before !== undefined && !matrixWalletCursor(request.before))
        ) {
          throw new Error('matrix_wallet_unavailable')
        }

        return account.walletHistory(AbortSignal.timeout(15_000), request.before as string | undefined)
      }

      if (request?.kind === 'petPhoto') {
        if (closing || !state.identity || !account.appScope() || !ui) {
          throw new Error('matrix_pet_unavailable')
        }

        const selected = await dialog.showOpenDialog(ui, {
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
        })

        if (selected.canceled || selected.filePaths.length !== 1) {
          return null
        }

        const file = selected.filePaths[0]!
        const extension = path.extname(file).toLowerCase()

        const mime =
          extension === '.png'
            ? 'image/png'
            : extension === '.webp'
              ? 'image/webp'
              : ['.jpg', '.jpeg'].includes(extension)
                ? 'image/jpeg'
                : undefined

        if (!mime || statSync(file).size > 3 * 1_024 * 1_024) {
          throw new Error('matrix_pet_photo_invalid')
        }

        const bytes = readFileSync(file)

        if (!bytes.length || bytes.length > 3 * 1_024 * 1_024) {
          throw new Error('matrix_pet_photo_invalid')
        }

        // The source path stays in main. The bounded data URL exists only for
        // this in-memory generation call and the gateway strips photo metadata.
        const photo = { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, mimeType: mime } as const

        if (!validMatrixPetPhoto(photo)) {
          throw new Error('matrix_pet_photo_invalid')
        }

        return photo
      }

      if (request?.kind === 'petGenerate') {
        const input = request.input as Partial<MatrixPetGenerateInput>

        if (
          !input?.target ||
          !MATRIX_PET_OPERATION.test(String(input.operationId)) ||
          typeof input.prompt !== 'string' ||
          input.prompt.length > 300 ||
          (!input.prompt.trim() && !input.photo) ||
          !Number.isSafeInteger(input.count) ||
          input.count < 1 ||
          input.count > 4 ||
          (input.photo !== undefined && !validMatrixPetPhoto(input.photo))
        ) {
          throw new Error('matrix_pet_invalid')
        }

        const photo = input.photo

        const result = await withMatrixPetHatchGateway(
          input.target,
          input.operationId!,
          async (connection, managedHatch, signal) =>
            connection.gateway.request<{
              ok?: unknown
              token?: unknown
              drafts?: unknown
            }>(
              'pet.generate',
              {
                style: 'voxel',
                prompt: input.prompt!.trim(),
                count: input.count,
                opId: input.operationId,
                managedHatch,
                ...(photo ? { referenceImage: photo.dataUrl } : {})
              },
              125_000,
              signal
            )
        )

        if (
          !result?.ok ||
          typeof result.token !== 'string' ||
          !Array.isArray(result.drafts) ||
          result.drafts.length < 1 ||
          result.drafts.length > 4
        ) {
          throw new Error('matrix_pet_generate_failed')
        }

        const drafts: MatrixPetDraft[] = result.drafts.map(value => {
          const draft = value as Partial<MatrixPetDraft>

          if (
            !Number.isSafeInteger(draft.index) ||
            draft.index! < 0 ||
            typeof draft.dataUri !== 'string' ||
            draft.dataUri.length > 4_300_000 ||
            draft.kind !== 'voxel' ||
            typeof draft.draftId !== 'string' ||
            draft.draftId.length > 100
          ) {
            throw new Error('matrix_pet_generate_failed')
          }

          return {
            token: result.token as string,
            index: draft.index,
            dataUri: draft.dataUri,
            kind: 'voxel',
            draftId: draft.draftId,
            ...(typeof draft.summary === 'string' && draft.summary.length <= 1_000 ? { summary: draft.summary } : {})
          }
        })

        if (new Set(drafts.map(draft => draft.index)).size !== drafts.length) {
          throw new Error('matrix_pet_generate_failed')
        }

        return { token: result.token, drafts }
      }

      if (request?.kind === 'petHatch') {
        const input = request.input as Partial<MatrixPetHatchInput>
        const quote = input?.quote

        const validQuote =
          quote &&
          typeof quote === 'object' &&
          !Array.isArray(quote) &&
          ((quote.kind === 'credit' &&
            Object.keys(quote).length === 2 &&
            MATRIX_PET_UUID.test(String(quote.entitlementId))) ||
            (quote.kind === 'offer' &&
              Object.keys(quote).length === 4 &&
              MATRIX_PET_UUID.test(String(quote.id)) &&
              Number.isSafeInteger(quote.version) &&
              quote.version > 0 &&
              Number.isSafeInteger(quote.priceMicroProtons) &&
              quote.priceMicroProtons >= 0))

        if (
          !input?.target ||
          !MATRIX_PET_OPERATION.test(String(input.operationId)) ||
          typeof input.token !== 'string' ||
          !input.token ||
          input.token.length > 100 ||
          !Number.isSafeInteger(input.index) ||
          input.index < 0 ||
          !validMatrixPetText(input.displayName, 100, 400, true) ||
          !validMatrixPetText(input.description, 2_000, 8_000, false) ||
          !validQuote
        ) {
          throw new Error('matrix_pet_invalid')
        }

        const hatchQuote = quote as MatrixPetHatchQuote
        const targetInfo = matrixPetHatchTarget(input.target)
        let recovering: MatrixPetHatchIntent | undefined

        try {
          recovering = readMatrixPetHatchIntent(targetInfo.scope.accountKey)
        } catch {
          quarantineMatrixPetHatchIntent(targetInfo.scope.accountKey)
          throw new Error('matrix_pet_recovery_invalid')
        }

        if (recovering) {
          if (recovering.bindingConflict) {
            throw new Error('matrix_pet_adopt_required')
          }

          if (recovering.parked) {
            throw new Error('matrix_pet_recovery_parked')
          }

          return runMatrixPetHatch(recovering)
        }

        // Capture the explicit binding version at the user's confirmation,
        // before render/upload can take time. It is persisted with the artifact
        // before charge and deliberately fences any later device choice.
        const catalog = await pets!.catalog(input.target)

        // A quoted offer is a financial confirmation, not display-only data.
        // Reject an absent, stale, or differently-priced quote before render,
        // artifact persistence, or Store can spend anything.
        if (!matrixPetHatchQuoteMatches(catalog, hatchQuote)) {
          throw new Error('matrix_pet_price_changed')
        }

        const confirmedSelection = await pets!.read(input.target)

        if (confirmedSelection.freshness !== 'current') {
          throw new Error('matrix_pet_unavailable')
        }

        const artifact = await withMatrixPetHatchGateway(
          input.target,
          input.operationId!,
          async (connection, _managedHatch, signal) => {
            const hatched = await connection.gateway.request<{ ok?: unknown; slug?: unknown; opId?: unknown }>(
              'pet.hatch',
              {
                token: input.token,
                index: input.index,
                name: input.displayName.trim(),
                description: input.description,
                style: 'voxel',
                opId: input.operationId,
                cancelToken: input.operationId
              },
              125_000,
              signal
            )

            if (!hatched?.ok || typeof hatched.slug !== 'string' || hatched.opId !== input.operationId) {
              throw new Error('matrix_pet_hatch_failed')
            }

            return connection.gateway.request<{ ok?: unknown; bundle?: unknown }>(
              'pet.export_bundle',
              {
                slug: hatched.slug,
                operationId: input.operationId
              },
              30_000,
              signal
            )
          }
        )

        if (!artifact?.ok) {
          throw new Error('matrix_pet_hatch_failed')
        }

        const bundle = parsePetBundle(artifact.bundle)
        const offer = hatchQuote.kind === 'offer' ? catalog.hatch.offer : null

        const intent: MatrixPetHatchIntent = {
          version: 1,
          accountKey: targetInfo.scope.accountKey,
          target: input.target,
          operationId: input.operationId,
          displayName: input.displayName.trim(),
          description: input.description.trim(),
          bundle,
          offerId: offer?.id ?? '',
          offerVersion: offer?.version ?? 0,
          ...(hatchQuote.kind === 'credit' ? { creditEntitlementId: hatchQuote.entitlementId } : {}),
          expectedRevision: confirmedSelection.selection.revision,
          desiredScale: matrixPetHatchScale(confirmedSelection.selection.pet)
        }

        if (hatchQuote.kind === 'offer' && (!intent.offerId || intent.offerVersion < 1)) {
          throw new Error('matrix_pet_hatch_limit')
        }

        // Persist the exact immutable artifact before a charge is initiated. A
        // restart can only resume this record; it never creates a second key.
        saveMatrixPetHatchIntent(intent)

        return runMatrixPetHatch(intent, false, true)
      }

      if (request?.kind === 'petAdoptPending') {
        if (!request.target) {
          throw new Error('matrix_pet_invalid')
        }

        const targetInfo = matrixPetHatchTarget(request.target)
        let recovering: MatrixPetHatchIntent | undefined

        try {
          recovering = readMatrixPetHatchIntent(targetInfo.scope.accountKey)
        } catch {
          quarantineMatrixPetHatchIntent(targetInfo.scope.accountKey)
          throw new Error('matrix_pet_recovery_invalid')
        }

        if (!recovering || recovering.target.agent !== request.target.agent || !recovering.bindingConflict) {
          throw new Error('matrix_pet_recovery_missing')
        }

        return runMatrixPetHatch(recovering, true)
      }

      if (['petRecovery', 'petRetryPending', 'petDiscardPending'].includes(request?.kind ?? '')) {
        if (!request.target) {
          throw new Error('matrix_pet_invalid')
        }

        // Only a retry resumes the hatch; reading or discarding its record starts nothing.
        const targetInfo =
          request.kind === 'petRetryPending'
            ? matrixPetHatchTarget(request.target)
            : matrixPetRecoveryTarget(request.target)

        let recovering: MatrixPetHatchIntent | undefined

        try {
          recovering = readMatrixPetHatchIntent(targetInfo.scope.accountKey)
        } catch {
          quarantineMatrixPetHatchIntent(targetInfo.scope.accountKey)

          if (request.kind === 'petRecovery') {
            return { state: 'quarantined' as const, canDiscard: false }
          }

          throw new Error('matrix_pet_recovery_invalid')
        }

        if (request.kind === 'petRecovery') {
          if (
            matrixPetQuarantines.has(targetInfo.scope.accountKey) ||
            outcomeStore?.getItem(`${MATRIX_PET_HATCH_QUARANTINE}${targetInfo.scope.accountKey}`)
          ) {
            return { state: 'quarantined' as const, canDiscard: false }
          }

          return {
            state: !recovering
              ? 'none'
              : recovering.parked
                ? 'parked'
                : recovering.bindingConflict
                  ? 'adopt'
                  : 'pending',
            canDiscard: Boolean(
              recovering &&
              !recovering.purchaseKey &&
              !recovering.creditEntitlementId &&
              !matrixPetRecoveries.busy(targetInfo.scope.accountKey)
            )
          } as const
        }

        if (!recovering || recovering.target.agent !== request.target.agent) {
          throw new Error('matrix_pet_recovery_missing')
        }

        if (request.kind === 'petDiscardPending') {
          if (
            matrixPetRecoveries.busy(targetInfo.scope.accountKey) ||
            recovering.purchaseKey ||
            recovering.creditEntitlementId
          ) {
            throw new Error('matrix_pet_recovery_paid')
          }

          clearMatrixPetHatchIntent(targetInfo.scope.accountKey)

          return
        }

        if (!recovering.parked) {
          throw new Error('matrix_pet_recovery_missing')
        }

        return runMatrixPetHatch({ ...recovering, parked: undefined }, false)
      }

      if (request?.kind === 'petCancel') {
        const operationId = String(request.operationId ?? '')
        const running = matrixPetHatches.get(operationId)

        if (!MATRIX_PET_OPERATION.test(operationId) || !running) {
          return
        }

        if (running.connection && running.token) {
          void running.connection.gateway.request('pet.cancel', { token: running.token }, 2_000).catch(() => {})
        }

        running.abort.abort()

        return
      }

      if (['petPopOut', 'petDisplayRead', 'petDisplayWrite'].includes(request?.kind ?? '')) {
        if (!petOverlays || closing || !state.identity) {
          throw new Error('matrix_pet_overlay_unavailable')
        }

        if (request.kind === 'petDisplayRead') {
          return petOverlays.readPreferences()
        }

        if (request.kind === 'petDisplayWrite') {
          return petOverlays.writePreferences(request.value)
        }

        return petOverlays.open(request.target)
      }

      if (request?.kind === 'petChat' || request?.kind === 'petChatHistory') {
        const failure = (code: MatrixPetChatError['code']) => ({
          ok: false as const,
          code
        })

        try {
          if (request.kind === 'petChat') {
            const input = parsePetChatIpcInput(request.input)

            if (!input) {
              return failure('invalid_request')
            }

            return {
              ok: true as const,
              reply: await account.petChat(input, AbortSignal.timeout(60_000))
            }
          }

          const input = parsePetChatHistoryIpcInput(request.input)

          if (!input) {
            return failure('invalid_request')
          }

          return {
            ok: true as const,
            history: await account.petChatHistory(input.ref, AbortSignal.timeout(15_000))
          }
        } catch (error) {
          return failure(error instanceof MatrixPetChatError ? error.code : 'temporarily_unavailable')
        }
      }

      if (
        request?.kind === 'petRead' ||
        request?.kind === 'petWrite' ||
        request?.kind === 'petCatalog' ||
        request?.kind === 'petVisit'
      ) {
        if (!pets || !request.target) {
          throw new Error('matrix_pet_unavailable')
        }

        if (request.kind === 'petRead') {
          return pets.read(request.target)
        }

        if (request.kind === 'petCatalog') {
          return pets.catalog(request.target)
        }

        if (request.kind === 'petVisit') {
          return pets.beginVisit(request.target)
        }

        if (typeof request.revision !== 'number' || !request.pet) {
          throw new Error('matrix_pet_invalid')
        }

        return pets.write(request.target, request.revision, request.pet)
      }

      if (request?.kind === 'snapshot') {
        // The pull answers with the same projection as the push (a reload must not unhide a spoof).
        return {
          ...companyProjection(state),
          domainEnabled: Boolean(config.domain),
          companyWorkspaceEnabled: Boolean(config.companyWorkspace && config.domain),
          companyDriveFilesEnabled: Boolean(config.companyDriveFiles && config.companyWorkspace && config.domain),
          companyProjectSourcesEnabled: Boolean(config.companyProjectSources && config.companyWorkspace && config.domain),
          companyProjectReaderEnabled: Boolean(config.companyProjectReader && config.companyProjectSources && config.companyWorkspace && config.domain),
          companyFundingEnabled: Boolean(config.companyFunding && config.companyWorkspace && config.domain),
          homeserver: config.server
        }
      }

      if (
        [
          'appChat',
          'appGroup',
          'appSend',
          'appInvoke',
          'appWithdraw',
          'appBotStatus',
          'appBotConsent',
          'appBotRevoke',
          'appBotOutcome',
          'appBotMedia',
          'appBotIntakeStatus',
          'appBotIntakeSubmit',
          'appBotInvite'
        ].includes(request?.kind ?? '')
      ) {
        if (!matrixApps || typeof request.appId !== 'string' || request.appId.length !== 36) {
          throw new Error('matrix_not_ready')
        }

        const id = request.appId

        if (
          [
            'appBotStatus',
            'appBotConsent',
            'appBotRevoke',
            'appBotOutcome',
            'appBotMedia',
            'appBotIntakeStatus',
            'appBotIntakeSubmit'
          ].includes(request.kind)
        ) {
          const descriptor = matrixApps.snapshot().apps.find(app => app.app_id === id)

          if (!descriptor?.bot) {
            throw new Error('matrix_app_bot_unavailable')
          }

          if (request.kind === 'appBotStatus') {
            // The setup card in the bot's chat reads this when it opens and after each step.
            // The workspace owns single-flight and the shared rate-limit wait for this read.
            try {
              const status = await matrixApps.botStatus(id)
              console.warn(appBotStatusLogLine(descriptor.app, status))

              return status
            } catch (error) {
              console.warn(appBotStatusLogLine(descriptor.app, undefined))

              throw error
            }
          }

          if (request.kind === 'appBotRevoke') {
            // The setup card's link flow confirms by itself only while consent stands
            // (app-connection.ts gate): withdrawing consent ends any flow still open.
            await matrixApps.connection(id, 'cancel').catch(() => {})

            // Revocation is a per-app cleanup: withdraw the platform consent and clear
            // this account's app-view partition, including any guest browser session.
            const scope = account.appScope()
            const revoked = account.appBotRequest(descriptor.app, 'revoke')

            const [result] = await Promise.all([
              revoked,
              ...(scope ? [appViews.revokeApp({ ...scope, app: descriptor.app })] : [])
            ])

            return result
          }

          if (request.kind === 'appBotConsent') {
            if (
              typeof request.disclosureVersion !== 'number' ||
              !Number.isInteger(request.disclosureVersion) ||
              request.disclosureVersion < 1 ||
              !APP_BOT_CONSENT_LOCALES.includes(request.locale as (typeof APP_BOT_CONSENT_LOCALES)[number])
            ) {
              throw new Error('matrix_command_invalid')
            }

            return account.appBotRequest(descriptor.app, 'consent', {
              disclosure_version: request.disclosureVersion,
              locale: request.locale
            })
          }

          if (request.kind === 'appBotMedia') {
            // One authenticated photo of a bot-api message: the native engine reads the event
            // and its bytes; the window receives only an image data URL it may display.
            if (
              typeof request.roomId !== 'string' ||
              typeof request.eventId !== 'string' ||
              request.roomId.length > 1024 ||
              request.eventId.length > 1024
            ) {
              throw new Error('matrix_command_invalid')
            }

            const human = hosts.get('human')
            const mediaScope = account.appScope()

            if (!human || !mediaScope || state.state !== 'ready') {
              throw new Error('matrix_not_ready')
            }

            const stillCurrent = () => {
              const current = account.appScope()

              return !closing &&
                hosts.get('human') === human &&
                current?.accountKey === mediaScope.accountKey &&
                current?.generation === mediaScope.generation
            }

            const room = state.rooms.find(value => value.id === request.roomId)

            if (!room) {
              throw new Error('matrix_app_bot_unavailable')
            }

            // This is the human SDK, so the app-host-only `appBotReadEvent` command cannot
            // authorize the event. Reuse the display-evidence boundary instead: H1 extends it
            // for bot-api metadata and, in encrypted rooms, binds the event to the catalog's
            // pinned bot device. Plain rooms still re-read the exact event and sender there.
            if (
              !await authenticatedAppBotDisplay(human, descriptor, request.roomId, request.eventId) ||
              !stillCurrent()
            ) {
              throw new Error('matrix_app_bot_unavailable')
            }

            const media = await human.queue.command(
              { kind: 'appBotReadMedia', roomId: request.roomId, eventId: request.eventId },
              matrixSdkCommandTimeout({ kind: 'appBotReadMedia' })
            )
            const photo = appBotPhotoForRenderer(media)

            if (!stillCurrent() || !photo) {
              throw new Error('matrix_app_bot_unavailable')
            }

            return photo
          }

          if (request.kind === 'appBotIntakeStatus' || request.kind === 'appBotIntakeSubmit') {
            const status = await account.appBotRequest(descriptor.app, 'read')

            if (!appBotIntakeAuthorized(status, appBotDisclosureVersion(descriptor))) {
              throw new Error('matrix_app_bot_unavailable')
            }

            try {
              return parseAppIntakeStatus(
                await account.appIntakeRequest(
                  descriptor.app,
                  request.kind === 'appBotIntakeSubmit' ? 'submit' : 'read',
                  request.kind === 'appBotIntakeSubmit' ? request.values : undefined
                )
              )
            } catch (error) {
              const failure = appViewTransportFailure(error)
              const field = typeof failure?.details?.field === 'string' ? failure.details.field : null

              return {
                error: failure?.code ?? 'app_surface_failed',
                ...(field && /^[a-z][a-z0-9_]*$/.test(field) ? { field } : {})
              }
            }
          }

          if (
            typeof request.roomId !== 'string' ||
            typeof request.eventId !== 'string' ||
            request.roomId.length > 1024 ||
            request.eventId.length > 1024
          ) {
            throw new Error('matrix_command_invalid')
          }

          const outcome = await account.appBotRequest(descriptor.app, 'outcome', {
            room_id: request.roomId,
            event_id: request.eventId
          })

          await retireLegacyAppCopyAfterOfficialAnswer(descriptor, request.roomId, request.eventId, outcome)

          return outcome
        }

        if (request.kind === 'appWithdraw') {
          const descriptor = matrixApps.snapshot().apps.find(app => app.app_id === id)

          if (!descriptor) {
            throw new Error('matrix_app_unavailable')
          }

          try {
            // Withdrawal stops local readership even while another operation
            // runs or the human SDK is offline. Account owns durable revocation
            // and deduplicates concurrent requests; network failure stays pending.
            const stopped = stopAppHosts(descriptor.app)
            const revoked = Promise.resolve().then(() => account.revokeApp(descriptor.app))
            await Promise.all([stopped, revoked])
          } finally {
            publish(state)
          }

          return
        }

        // First-use setup belongs to the human's chat, independently of the
        // local assistant's model/turn readiness and the provider account link.
        if (request.kind === 'appChat' && matrixApps.snapshot().apps.some(app => app.app_id === id && app.bot)) {
          const human = hosts.get('human')
          const slug = matrixApps.snapshot().apps.find(app => app.app_id === id)?.app

          if (
            operation ||
            profileSelection ||
            lifecycle?.busy ||
            domainOperation ||
            closing ||
            state.state !== 'ready' ||
            !human ||
            !matrixHumanSdkReady(state.state, human) ||
            // This app's chat is already opening: asking again once it has ended is the retry.
            openingAppChats.get(id) === human
          ) {
            // The handler's wrapper writes the failed line (app-bots/open-chat.ts).
            throw new Error('matrix_not_ready')
          }

          // Not `operation`: the wait for the room must not hold up the person's other chats, their
          // sends, or signing out. The account this open is for is the one signed in now.
          openingAppChats.set(id, human)
          const signedIn = state.identity

          try {
            // One line per open in main.log (app-bots/open-chat.ts).
            const current = () => !closing && hosts.get('human') === human && state.state === 'ready'
            // Opening ends by waiting for the room to reach the SDK's store, which has its own time
            // on top of the ordinary one (`matrixSdkCommandTimeout`).
            const sdk = (command: unknown) => human.queue.command(command, matrixSdkCommandTimeout(command))
            const local = localAppChatRoom(command => sdk(command))

            return await startAppChat({
              descriptor: () => matrixApps!.botChat(id),
              current,
              // Signed out, or another account in, while the room was on its way.
              ended: () =>
                closing ||
                state.identity?.userId !== signedIn?.userId ||
                state.identity?.deviceId !== signedIn?.deviceId,
              // Legacy transport asks the platform to name the room first (canonical-room/v1.1).
              // A signed Bot API app uses the ordinary direct-room path; first-contact `/start`
              // injection belongs to the platform, not this legacy route.
              resolveRoom: platformAppChatRoom({
                start: (appSlug, body) => account.appBotStart(appSlug, body),
                command: command => sdk(command),
                fallback: local,
                requestId: () => randomUUID(),
                appVersion: app.getVersion(),
                current,
                log: line => console.warn(line)
              }),
              slug,
              log: line => console.warn(line)
            })
          } finally {
            if (openingAppChats.get(id) === human) {
              openingAppChats.delete(id)
            }
          }
        }

        const appTurnOwner = requireProductAgent()

        if (
          anyOperation() ||
          domainOperation ||
          closing ||
          state.state !== 'ready' ||
          appTurnOwner.invocation ||
          appTurnOwner.listener.snapshot()?.state === 'listening'
        ) {
          throw new Error('matrix_not_ready')
        }

        const descriptor = matrixApps.participant(id)
        const human = hosts.get('human')!
        const role = `app:${descriptor.app}` as const

        if (!human) {
          throw new Error('matrix_not_ready')
        }

        if (request.kind === 'appBotInvite') {
          if (typeof request.roomId !== 'string') {
            throw new Error('matrix_command_invalid')
          }

          const refusal = appBotTurnRefusal(descriptor, true)

          if (refusal || !descriptor.bot) {
            throw new Error(refusal ?? 'matrix_app_bot_unavailable')
          }

          const room = state.rooms.find(value => value.id === request.roomId)

          // Plain groups (0.20) and encrypted ones alike; only an encrypted group needs the bot's
          // device pinned, for its room keys (device-isolation.ts).
          if (!room || room.membership !== 'join' || !room.canInvite) {
            throw new Error('matrix_command_invalid')
          }

          operation = true

          try {
            const pinned = appBotPinRequired(room)

            if (pinned) {
              await pinOfficialAppBot(id, descriptor.bot, human)
            }

            console.warn(
              `[Matrix] app bot invite room=${room.encrypted ? 'encrypted' : 'plain'} pin=${pinned ? 'checked' : 'skipped'}`
            )
            await guardRoomCommand('invite', request.roomId)
            await human.queue.command({ kind: 'invite', roomId: request.roomId, userId: descriptor.bot.user_id })
          } finally {
            operation = false
            publish(state)
          }

          return
        }

        if (request.kind === 'appChat' || request.kind === 'appGroup') {
          const group = request.kind === 'appGroup'
          const parsed = group ? parseMatrixCommand({ kind: 'create', name: request.name, invite: [] }) : undefined
          const groupName = parsed?.kind === 'create' ? parsed.name : undefined

          if (group && !groupName?.trim()) {
            throw new Error('matrix_command_invalid')
          }

          if (group && descriptor.bot) {
            const refusal = appBotTurnRefusal(descriptor, true)

            if (refusal) {
              throw new Error(refusal)
            }

            operation = true

            try {
              // The group is made plain (createConversation's roomEncrypted), so no room keys go
              // to the bot's device and nothing needs pinning first.
              return (await human.queue.command({
                kind: 'create',
                name: groupName!,
                invite: [descriptor.bot.user_id],
                direct: false
              })) as string
            } finally {
              operation = false
              publish(state)
            }
          }

          operation = true

          try {
            return await createAppConversation({
              groupName,
              descriptor: () => matrixApps!.participant(id),
              account,
              human,
              active: () => !closing && hosts.get('human') === human && state.state === 'ready',
              start: async slug => {
                await startHost(`app:${slug}`)
                const host = hosts.get(`app:${slug}`)
                const deadline = Date.now() + 30_000

                while (host && !host.ready && !closing && hosts.get(`app:${slug}`) === host && Date.now() < deadline) {
                  await new Promise(resolve => setTimeout(resolve, 100))
                }

                if (!host?.ready || hosts.get(`app:${slug}`) !== host) {
                  throw new Error('matrix_app_unavailable')
                }

                return host
              },
              confirm: async app => {
                const copy = appChatCopy(request.locale)

                const choice = await dialog.showMessageBox(ui!, {
                  type: 'question',
                  title: group ? copy.newGroup : copy.newChat,
                  message: appLocalizedCopy(app.name, request.locale ?? 'en', app.app),
                  detail: group ? `${copy.groupInvite}\n\n${copy.groupDisclosure}` : copy.disclosure,
                  buttons: [copy.cancel, group ? copy.newGroup : copy.newChat],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true
                })

                return choice.response === 1
              }
            })
          } finally {
            operation = false
            sessionChecks.released()
            publish(state)
          }
        }

        if (request.kind === 'appInvoke') {
          const parsed = parseMatrixCommand({ kind: 'download', roomId: request.roomId, eventId: request.eventId })

          if (parsed.kind !== 'download') {
            throw new Error('matrix_command_invalid')
          }

          return runApp(id, parsed, true)
        }

        const parsedInput = parseMatrixCommand({
          kind: 'send',
          roomId: request.roomId,
          body: request.body,
          ...(typeof request.replyTo === 'string' ? { replyTo: request.replyTo } : {})
        })

        if (parsedInput.kind !== 'send') {
          throw new Error('matrix_command_invalid')
        }

        const input = parsedInput

        if (descriptor.bot) {
          // A guest turn is authorized only while a fresh platform read says the
          // current consent generation is ready. The catalog alone never proves it.
          let guestReady = false

          if (
            descriptor.bot.guest_enabled &&
            descriptor.bot.direct_profile === 'atum.turn-memory/2' &&
            descriptor.link.state !== 'linked'
          ) {
            try {
              guestReady = appBotGuestReady(
                parseAppBotStatus(await matrixApps.botStatus(id)),
                appBotDisclosureVersion(descriptor)
              )
            } catch {
              guestReady = false
            }
          }

          const refusal = appBotTurnRefusal(descriptor, false, guestReady)

          if (refusal) {
            throw new Error(refusal)
          }

          if (!descriptor.bot.groups || descriptor.link.state !== 'linked') {
            const ownerId = state.identity?.userId

            const officialDm = ownerId
              ? (await human.queue.command({
                  kind: 'isOfficialAppBotDm',
                  appId: descriptor.app_id,
                  userId: ownerId,
                  roomId: input.roomId
                })) === true
              : false

            if (!appBotSendAuthorized(descriptor, officialDm, guestReady)) {
              throw new Error('matrix_app_bot_unavailable')
            }
          }

          if (request.quote !== undefined && (typeof request.quote !== 'string' || request.quote !== input.replyTo)) {
            throw new Error('matrix_command_invalid')
          }

          operation = true

          try {
            // Only an encrypted chat shares room keys with the bot's device; a plain one (every
            // chat 0.20 makes) sends with no trust step. The room's truthful encryption state.
            const encrypted = appBotPinRequired(state.rooms.find(value => value.id === input.roomId))

            if (encrypted) {
              await pinOfficialAppBot(id, descriptor.bot, human)
            }

            const eventId = (await human.queue.command({
              kind: 'sendAppBotMessage',
              roomId: input.roomId,
              body: input.body,
              userId: descriptor.bot.user_id,
              ...(input.replyTo ? { replyTo: input.replyTo } : {}),
              ...(request.quote ? { quote: request.quote } : {})
            })) as string

            return { eventId, result: { state: 'published' } }
          } finally {
            operation = false
            publish(state)
          }
        }

        const host = hosts.get(role)

        if (input.kind !== 'send' || !host?.ready) {
          throw new Error('matrix_not_ready')
        }

        operation = true

        return sendAssistantMessage({
          check: () =>
            connectAppRoom(input.roomId, human, host, () => {
              const current = matrixApps!.participant(id)

              if (
                closing ||
                hosts.get('human') !== human ||
                hosts.get(role) !== host ||
                !host.ready ||
                current.app_version_id !== descriptor.app_version_id
              ) {
                throw new Error('matrix_not_ready')
              }
            }),
          send: async () => {
            const eventId = (await observeMessage(() =>
              human.queue.command({ ...input, kind: 'sendAppMessage', userId: host.identity.userId })
            )) as string

            // A plain app pair's message names no device: this is how its turn knows it was typed here.
            rememberSentHere(eventId)

            return eventId
          },
          release: () => {
            operation = false
            sessionChecks.released()
          },
          invoke: eventId => runApp(id, { roomId: input.roomId, eventId })
        })
      }

      if (['appsRefresh', 'appMenu', 'appHistory', 'appConnection'].includes(request?.kind ?? '')) {
        // Connect and its later steps say in main.log why they did not start (app-link-log.ts).
        const linkSlug =
          request.kind === 'appConnection' && typeof request.appId === 'string'
            ? (matrixApps?.snapshot().apps.find(app => app.app_id === request.appId)?.app ?? 'unknown')
            : undefined

        const linkAction = typeof request.action === 'string' ? request.action : undefined

        const refuse = (outcome: AppLinkOutcome) => {
          if (linkSlug) {
            console.warn(
              appLinkLogLine({ app: linkSlug, step: 'request', outcome, ...(linkAction ? { action: linkAction } : {}) })
            )
          }
        }

        if (!matrixApps || anyOperation() || closing || !account.identity()) {
          refuse(!account.identity() ? 'refused_signed_out' : 'refused_busy')
          throw new Error('matrix_app_unavailable')
        }

        try {
          if (request.kind === 'appsRefresh') {
            if (domainOperation) {
              throw new Error('matrix_app_pending')
            }

            domainOperation = true

            try {
              await matrixApps.refresh(true)
            } finally {
              domainOperation = false
            }

            return
          }

          if (typeof request.appId !== 'string' || request.appId.length !== 36) {
            throw new Error('matrix_app_invalid')
          }

          if (request.kind === 'appMenu') {
            try {
              return await matrixApps.menu(request.appId)
            } catch (error) {
              // The composer "+" menu and the panel are built from this; say why one did not appear.
              console.warn(
                appMenuFailedLogLine(matrixApps.snapshot().apps.find(app => app.app_id === request.appId)?.app ?? '', error)
              )

              throw error
            }
          }

          if (request.kind === 'appHistory') {
            const cursor = request.cursor

            if (cursor !== null && cursor !== undefined &&
              (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2048)) {
              throw new Error('matrix_app_invalid')
            }

            return await matrixApps.history(request.appId, typeof cursor === 'string' ? cursor : null)
          }

          if (
            !['read', 'begin', 'confirm', 'cancel', 'disconnect'].includes(String(request.action)) ||
            (request.autoConfirm !== undefined && (request.autoConfirm !== true || request.action !== 'begin'))
          ) {
            refuse('refused_invalid')
            throw new Error('matrix_app_invalid')
          }

          await matrixApps.connection(
            request.appId,
            request.action as 'read' | 'begin' | 'confirm' | 'cancel' | 'disconnect',
            request.autoConfirm === true ? { autoConfirm: true } : undefined
          )

          return
        } catch (error) {
          refuse(error instanceof AppSurfaceError ? 'refused_app' : 'failed')

          if (!account.appScope()) {
            await matrixApps.reset()
          }

          throw new Error('matrix_app_unavailable')
        }
      }

      if (request?.kind === 'openWebPreview' || request?.kind === 'dismissWebPreview') {
        const scope = webPreviewScope(state)

        if (!scope || closing || request.roomId !== state.roomId) {
          throw new Error('matrix_web_preview_unavailable')
        }

        if (request.kind === 'dismissWebPreview') {
          webPreviews.dismiss(scope, request.id)
          publish(state)

          return
        }

        try {
          return webPreviews.open(scope, request.id)
        } finally {
          publish(state)
        }
      }

      if (['terminalOpen', 'terminalClose', 'terminalRead', 'terminalRespond'].includes(String(request?.kind))) {
        const scope = webPreviewScope(state)

        if (!scope || closing || request.roomId !== state.roomId) {
          throw new Error('matrix_terminal_unavailable')
        }

        if (request.kind === 'terminalRead') {
          return terminals.read(scope, request.id)
        }

        if (request.kind === 'terminalRespond') {
          terminals.respond(scope, request.id, request.result)
        } else if (request.kind === 'terminalOpen') {
          terminals.open(scope, request.id)
        } else {
          terminals.close(scope, request.id)
        }

        return
      }

      if (request?.kind === 'closeDocumentPreview') {
        if (typeof request.token === 'string') {
          documents.closePreview(request.token)
        }

        return
      }

      if (request?.kind === 'textDocument') {
        const identity = state.identity
        const roomId = state.roomId

        if (
          closing ||
          state.state !== 'ready' ||
          !identity ||
          !roomId ||
          typeof request.token !== 'string' ||
          !state.rooms.some(room => room.id === roomId && usableAgentRoom(room))
        ) {
          throw new Error('matrix_document_unavailable')
        }

        const scope = { userId: identity.userId, roomId }
        const text = documents.textForPreview(scope, request.token)
        let result: unknown

        if (request.action === 'read') {
          result = await text.read()
        } else if (request.action === 'recoveryRead') {
          result = await text.recoveryRead()
        } else if (request.action === 'write') {
          const input = request.input as { expectedRevision?: unknown; text?: unknown } | null

          if (
            !input ||
            typeof input.expectedRevision !== 'string' ||
            !input.expectedRevision ||
            input.expectedRevision.length > 256 ||
            typeof input.text !== 'string' ||
            Buffer.byteLength(input.text) > 1024 * 1024
          ) {
            throw new Error('matrix_command_invalid')
          }

          result = await text.write({ expectedRevision: input.expectedRevision, text: input.text })
        } else if (request.action === 'recoveryWrite') {
          const input = request.input as Partial<AtumDocumentRecoveryWriteInput> | null

          if (
            !input ||
            typeof input.baseRevision !== 'string' ||
            typeof input.editorRevision !== 'string' ||
            (input.expectedDraftRevision !== null && typeof input.expectedDraftRevision !== 'string') ||
            typeof input.text !== 'string' ||
            Buffer.byteLength(input.text) > 1024 * 1024
          ) {
            throw new Error('matrix_command_invalid')
          }

          result = await text.recoveryWrite({
            baseRevision: input.baseRevision,
            editorRevision: input.editorRevision,
            expectedDraftRevision: input.expectedDraftRevision,
            text: input.text
          })
        } else if (request.action === 'recoveryDiscard' && typeof request.draftRevision === 'string') {
          result = await text.recoveryDiscard(request.draftRevision)
        } else {
          throw new Error('matrix_command_invalid')
        }

        // A close/reselection/room change during the await also fences readback.
        documents.textForPreview(scope, request.token)

        return result
      }

      if (request?.kind === 'pdfHide' || request?.kind === 'pdfClose') {
        if (typeof request.token !== 'string') {
          throw new Error('matrix_command_invalid')
        }

        // A hidden panel retains the preview; unmount closes its native view.
        if (request.kind === 'pdfClose') {
          pdf.close(request.token)
        } else {
          pdf.hide(request.token)
        }

        return
      }

      if (request?.kind === 'previewDocument' || request?.kind === 'pdfShow') {
        const identity = state.identity
        const roomId = state.roomId
        const drivePdf =
          request.kind === 'pdfShow' && typeof request.token === 'string' ? drive?.resolvePreview(request.token) : null
        const roomCanPreview = Boolean(
          roomId && state.rooms.some(room => room.id === roomId && usableAgentRoom(room))
        )

        if (
          closing ||
          (anyOperation() && request.kind === 'pdfShow') ||
          !identity ||
          state.state !== 'ready' ||
          (!drivePdf && !roomCanPreview)
        ) {
          throw new Error('matrix_document_unavailable')
        }

        if (request.kind === 'previewDocument') {
          if (!roomId || request.roomId !== roomId) {
            throw new Error('matrix_document_unavailable')
          }

          return documents.preview({ userId: identity.userId, roomId })
        }

        // Never cover the native controls/title row, even for forged geometry.
        if (
          typeof request.token !== 'string' ||
          !matrixPdfBelowTitlebar(request.bounds, ui?.webContents.getZoomFactor() ?? 1)
        ) {
          pdf.hide(request.token)

          return { shown: false }
        }

        return pdf.show(request.token, request.bounds)
      }

      if (request?.kind === 'endDeviceSession') {
        if (anyOperation() || closing) {
          throw new Error('matrix_not_ready')
        }

        return account.endDeviceSession(request.deviceId)
      }

      if (request?.kind === 'newSignInDismiss') {
        const target = parseMatrixNewSignInDismiss({
          closing,
          ready: state.state === 'ready',
          identity: state.identity,
          shown: state.newSignIn,
          deviceId: request.deviceId
        })

        newSignInLedger.acknowledge(target.identity, target.deviceId)
        // Re-read the list this Mac already has: another unknown device shows at once.
        observeNewSignIn(true)

        return
      }

      if (request?.kind === 'arrangeWord') {
        const identity = state.identity
        const roomId = state.roomId

        if (
          closing ||
          anyOperation() ||
          state.state !== 'ready' ||
          !identity ||
          !roomId ||
          request.roomId !== roomId ||
          typeof request.show !== 'boolean' ||
          !state.rooms.some(room => room.id === roomId && usableAgentRoom(room))
        ) {
          throw new Error('matrix_document_unavailable')
        }

        return documents.arrangeWord({ userId: identity.userId, roomId }, request.show)
      }

      if (request?.kind === 'document') {
        const parsed = parseMatrixCommand({ kind: 'select', roomId: request.roomId })
        const human = account.identity()
        const host = hosts.get('human')

        if (
          parsed.kind !== 'select' ||
          !human ||
          !host ||
          anyOperation() ||
          closing ||
          state.state !== 'ready' ||
          state.roomId !== parsed.roomId ||
          !state.rooms.some(room => room.id === parsed.roomId && usableAgentRoom(room)) ||
          !['choose', 'remove'].includes(String(request.action))
        ) {
          throw new Error('matrix_not_ready')
        }

        const scope = { userId: human.userId, roomId: parsed.roomId }
        const roomAgent = requireRoomAgent(parsed.roomId)
        // S1: no Word or linked document beside a cloud agent (S2).
        refuseCloudAgent(roomAgent)

        if (roomAgent.invocation) {
          throw new Error('matrix_not_ready')
        }

        stopListening('cancelled', roomAgent)
        // One native picker operation: listening, invocation and another picker
        // cannot overtake the user's still-pending choice.
        holdOperation(roomAgent, true)

        try {
          if (request.action === 'choose') {
            const agent = hosts.get(roomAgent.role)

            if (!agent) {
              throw new Error('matrix_agent_unavailable')
            }

            await requireAssistantRoom(scope.roomId, host, agent)
          }

          if (request.action === 'remove') {
            documents.remove(scope)
          } else {
            await documents.choose(scope, async () => {
              const selected = await dialog.showOpenDialog(ui!, { properties: ['openFile'] })

              if (
                closing ||
                hosts.get('human') !== host ||
                state.roomId !== scope.roomId ||
                !state.rooms.some(room => room.id === scope.roomId && usableAgentRoom(room))
              ) {
                throw new Error('matrix_not_ready')
              }

              return selected.canceled ? null : (selected.filePaths[0] ?? null)
            })
          }
        } catch (error) {
          const code = String(error).match(/\bWORD_[A-Z_]+\b/)?.[0]

          throw new Error(
            code &&
              [
                'WORD_NOT_INSTALLED',
                'WORD_AUTOMATION_DENIED',
                'WORD_EXIT_FULLSCREEN',
                'WORD_SCREEN_TOO_SMALL',
                'WORD_DOCUMENT_UNAVAILABLE',
                'WORD_LAYOUT_FAILED'
              ].includes(code)
              ? code
              : 'matrix_document_unavailable'
          )
        } finally {
          holdOperation(roomAgent, false)
          publish(state)
        }

        return
      }

      if (request?.kind === 'recoverHermes') {
        const humanHost = hosts.get('human')

        // Human readiness is the main snapshot; host.ready belongs to the
        // independently synced agent host and is unset on a human-only device.
        if (operation || domainOperation || closing || state.state !== 'ready' || !humanHost) {
          throw new Error('matrix_not_ready')
        }

        const parsed = parseMatrixCommand({ kind: 'download', roomId: request.roomId, eventId: request.eventId })

        if (parsed.kind !== 'download') {
          throw new Error('matrix_command_invalid')
        }

        const roomAgent = requireRoomAgent(parsed.roomId)

        if (roomAgent.invocation?.app || roomAgent.operation) {
          throw new Error('matrix_not_ready')
        }

        // Another agent's result is recovered only in its own room, read from the server, not
        // from display state (this Mac need not run that agent's host).
        if (roomAgent !== defaultAgent) {
          await humanHost.queue.command({
            kind: 'readAssistantRoom',
            roomId: parsed.roomId,
            ownerId: humanHost.identity.userId,
            agentId: roomAgent.userId
          })
        }

        stopListening('cancelled', roomAgent)
        const release = await roomAgent.lock.acquire(parsed.roomId, 'recover')

        if (roomAgent.invocation || closing) {
          release()
          throw new Error('matrix_not_ready')
        }

        const abort = new AbortController()

        const pending = (async () => {
          const domain = await account.readDomain(false)

          return recoverMatrixResult(
            {
              context: () => {
                const human = account.identity()

                if (!human || hosts.get('human') !== humanHost) {
                  throw new Error('matrix_not_ready')
                }

                return { human, domain }
              },
              read: command => humanHost.queue.command(command, 60_000),
              // Another agent's result is found under that agent (0146).
              authorize: input => {
                const principal = account.retainedAgentPrincipal(roomAgent.principal)

                if (!principal) {
                  throw new Error('matrix_agent_unavailable')
                }

                return account.invocation({ ...input, agentPrincipal: principal })
              }
            },
            { roomId: parsed.roomId, eventId: parsed.eventId },
            abort.signal
          )
        })()

        roomAgent.invocation = { abort, pending }
        publish(state)

        try {
          return await pending
        } finally {
          if (roomAgent.invocation?.abort === abort) {
            roomAgent.invocation = undefined
          }

          release()
          publish(state)
        }
      }

      if (request?.kind === 'openLink') {
        await shell.openExternal(matrixOpenLink(request.url))

        return
      }

      if (request?.kind === 'openSourceNotices') {
        await openSourceNotices.open(request.title)

        return
      }

      if (request?.kind === 'cancelHermes') {
        // A group's turns stop there; the agents' own rooms and listening are not touched.
        const groupTurns =
          typeof request.roomId === 'string' && !agentOfRoom(request.roomId)
            ? allAgents().filter(each => each.invocation?.group && each.invocation.roomId === request.roomId)
            : []

        if (groupTurns.length) {
          for (const each of groupTurns) {
            each.invocation?.abort.abort()
          }

          publish(state)

          return
        }

        const roomAgent = typeof request.roomId === 'string' ? requireRoomAgent(request.roomId) : requireProductAgent()

        // The person's own Stop, marked before anything is aborted so the turn it ends is never
        // queued again and never reported as unconfirmed (matrixTurnSettlement).
        if (roomAgent.invocation) {
          roomAgent.invocation.stopRequested = true
        }

        stopListening('cancelled', roomAgent)
        roomAgent.invocation?.abort.abort()
        publish(state)

        return
      }

      if (request?.kind === 'respondHermes') {
        // The answer goes to the agent whose turn asked.
        const asked = (request.response as { id?: unknown } | null | undefined)?.id
        const roomAgent = allAgents().find(each => each.invocation?.prompts?.asked(asked))
        const current = roomAgent?.invocation

        if (
          !roomAgent ||
          !current?.prompts ||
          current.abort.signal.aborted ||
          enrollmentOf(roomAgent).state !== 'ready'
        ) {
          throw new Error('matrix_hermes_prompt_expired')
        }

        current.prompts.respond(request.response)

        return
      }

      if (request?.kind === 'stopListeningHermes') {
        const selected =
          typeof request.roomId === 'string'
            ? (allAgents().find(each => each.continuous?.roomId === request.roomId) ?? agentOfRoom(request.roomId))
            : productAgent()

        if (!selected) {
          throw new Error('matrix_agent_unavailable')
        }

        if (isCloudAgent(selected)) {
          throw new Error(MATRIX_CLOUD_AGENT_UNSUPPORTED)
        }

        if (request.roomId && selected.continuous?.roomId && selected.continuous.roomId !== request.roomId) {
          throw new Error('matrix_room_invalid')
        }

        try {
          // The person's Stop: remembered as off, so keep listening's default never returns.
          selected.continuous?.switchOff()
        } finally {
          selected.listeningConsent?.abort()
          selected.listener.stop('cancelled')
          publish(state)
        }

        return
      }

      if (request?.kind === 'listenHermes' || request?.kind === 'setContinuousListening') {
        // Its native consent never overlaps another agent's (or the picker).
        if (anyOperation() || domainOperation || closing || state.state !== 'ready' || !runtime) {
          throw new Error('matrix_not_ready')
        }

        const parsed = parseMatrixCommand({ kind: 'select', roomId: request.roomId })

        if (parsed.kind !== 'select') {
          throw new Error('matrix_command_invalid')
        }

        const roomAgent = requireRoomAgent(parsed.roomId)

        // H-F listening is policy-owned and in memory; this per-chat preference never controls it.
        if (isCloudAgent(roomAgent)) {
          throw new Error(MATRIX_CLOUD_AGENT_UNSUPPORTED)
        }

        const continuous = request.kind === 'setContinuousListening'

        if (continuous && typeof request.enabled !== 'boolean') {
          throw new Error('matrix_command_invalid')
        }

        if (continuous && !request.enabled) {
          if (
            !agentOfRoom(parsed.roomId) ||
            (roomAgent.continuous?.roomId && roomAgent.continuous.roomId !== parsed.roomId)
          ) {
            throw new Error('matrix_room_invalid')
          }

          try {
            roomAgent.continuous?.switchOff()
          } finally {
            publish(state)
          }

          return
        }

        if (!continuous && roomAgent.continuous?.enabled) {
          throw new Error('matrix_listener_continuous_enabled')
        }

        if (roomAgent.invocation || roomAgent.operation || !hosts.get(roomAgent.role)?.ready) {
          throw new Error('matrix_not_ready')
        }

        const room = state.rooms.find(room => room.id === parsed.roomId && usableAgentRoom(room))
        const human = account.identity()
        const enrolled = enrollmentOf(roomAgent)
        const agentHost = hosts.get(roomAgent.role)!
        const humanHost = hosts.get('human')

        if (!room || !human || !humanHost || enrolled.state !== 'ready' || !enrolled.identity) {
          throw new Error('matrix_agent_unavailable')
        }

        if (documents.describe({ userId: human.userId, roomId: room.id })) {
          throw new Error('matrix_document_confirmation_required')
        }

        stopListening('cancelled', roomAgent)
        const abort = new AbortController()
        roomAgent.listeningConsent = abort
        holdOperation(roomAgent, true)

        try {
          await requireAssistantRoom(room.id, humanHost, agentHost, { forTurn: true })

          const copy = Object.hasOwn(matrixActionCopy, request.locale ?? '')
            ? matrixActionCopy[request.locale!]
            : matrixActionCopy.en

          const decision = await dialog.showMessageBox(ui!, {
            type: 'question',
            title: continuous ? copy.keepListeningHermes : copy.listenHermes,
            message: continuous ? copy.keepListeningHermes : copy.listenHermes,
            // A guest copy that keeps answering takes the agent over from its home Mac, without
            // that Mac's files and tools: say so before the person agrees.
            detail: `${continuous ? copy.keepListeningHelp : copy.listenHelp}${continuous && answersFromHome(roomAgent) ? `\n\n${copy.guestKeepListening}` : ''}\n\n${copy.fileHelp}\n\n${room.name}\n${room.id}`,
            buttons: [copy.consentCancel, continuous ? copy.keepListeningHermes : copy.listenHermes],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: abort.signal
          })

          abort.signal.throwIfAborted()

          if (decision.response !== 1) {
            return
          }

          await requireAssistantRoom(room.id, humanHost, agentHost, { forTurn: true })
          abort.signal.throwIfAborted()

          if (
            closing ||
            state.state !== 'ready' ||
            hosts.get(roomAgent.role) !== agentHost ||
            hosts.get('human') !== humanHost ||
            JSON.stringify(state.identity) !== JSON.stringify(human) ||
            !sameMatrixEnrollment(enrollmentOf(roomAgent), enrolled)
          ) {
            throw new Error('matrix_not_ready')
          }

          if (continuous) {
            const binding = continuousBinding(room.id, roomAgent)

            if (!binding || !roomAgent.continuous) {
              throw new Error('matrix_agent_unavailable')
            }

            roomAgent.continuous.enable(binding, room.id)
          } else {
            await armHermesWatch(roomAgent, room.id, abort.signal)
          }
        } catch (error) {
          void agentHost.queue.command({ kind: 'watchInvocations', watch: null }).catch(() => {})

          if (error instanceof EarlierConversationError || error instanceof ConversationUnavailableError) {
            throw error
          }

          if (!abort.signal.aborted) {
            throw new Error('matrix_listener_unavailable')
          }
        } finally {
          if (roomAgent.listeningConsent === abort) {
            roomAgent.listeningConsent = undefined
          }

          holdOperation(roomAgent, false)
          publish(state)
        }

        return
      }

      if (request?.kind === 'configureHermes') {
        const selected = requireProductAgent()

        // A plan sign-in the person is approving on this backend ends first (holdsSignIn).
        if (
          operation ||
          selected.operation ||
          domainOperation ||
          selected.invocation ||
          selected.holdsSignIn ||
          state.state !== 'ready' ||
          !runtime ||
          !hosts.get(selected.role)?.ready
        ) {
          throw new Error('matrix_not_ready')
        }

        const model = parseMatrixHermesModel(request.model)
        stopListening('cancelled', selected)
        const enrollment = enrollmentOf(selected)

        if (enrollment.state !== 'ready' || !enrollment.identity) {
          throw new Error('matrix_agent_unavailable')
        }

        const abort = new AbortController()
        const release = await selected.lock.acquire('*', 'configure')

        if (selected.invocation || selected.holdsSignIn) {
          release()
          throw new Error('matrix_not_ready')
        }

        // The person's own model replaces Atum's: the next launch checks the profile again,
        // whatever this setup leaves (model-check.ts).
        forgetMatrixModelCheck(selected.store, enrollment.identity.executorId)

        // Setup is an explicit runtime/configuration change. Never leave an old
        // cached agent running against the replaced model credential.
        const pending = stopHermesExecutor(selected).then(() =>
          withMatrixHermes(
            runtime!,
            {
              owner: enrollment.identity!.principal,
              executorId: enrollment.identity!.executorId,
              signal: abort.signal,
              home: agentHermesHome(selected, enrollment.identity!, runtime!),
              sharedCodex: sharedCodexHere()
            },
            async connection => {
              const result = await configureMatrixHermes(connection, model, abort.signal)

              // The person's own model is now the default: Atum's picker no longer applies.
              if (result.state === 'ready') {
                rememberOwnModel(enrollment.identity!.executorId, true, selected, {
                  provider: MATRIX_HERMES_ENDPOINT.id,
                  model: model.model
                })
              }

              await ensureFullHermes(connection, enrollment.identity!.executorId, abort.signal, selected)

              return result
            }
          )
        )

        // The person's own Hermes setup never uses a Matrix host (MatrixTurnSlot.setup).
        selected.invocation = { abort, pending, setup: true }
        publish(state)

        try {
          return await pending
        } catch {
          if (abort.signal.aborted) {
            return { state: 'cancelled' }
          }

          throw new Error('matrix_setup_failed')
        } finally {
          if (selected.invocation?.abort === abort) {
            selected.invocation = undefined
          }

          release()
          publish(state)
        }
      }

      // Back to Atum's AI after the person's own model: the same endpoint the launch-time check
      // writes (configureMatrixManagedModel), then the model check runs again next launch.
      if (request?.kind === 'useAtumModel') {
        parseMatrixUseAtumModel(request)
        const selected = requireProductAgent()

        // A plan sign-in the person is approving on this backend ends first (holdsSignIn).
        if (
          matrixAtumModelSwitchBlocked({
            operation,
            agentOperation: selected.operation,
            domainOperation,
            invocation: Boolean(selected.invocation),
            signIn: selected.holdsSignIn,
            accountReady: state.state === 'ready',
            runtime: Boolean(runtime),
            managedModel: Boolean(managedModel)
          })
        ) {
          throw new Error('matrix_not_ready')
        }

        const enrollment = enrollmentOf(selected)
        const apiKey = account.managedModelKey(selected.principal)

        if (enrollment.state !== 'ready' || !enrollment.identity) {
          throw new Error('matrix_agent_unavailable')
        }

        if (!apiKey) {
          throw new Error('matrix_setup_failed')
        }

        stopListening('cancelled', selected)
        const abort = new AbortController()
        const release = await selected.lock.acquire('*', 'configure')

        if (selected.invocation || selected.holdsSignIn) {
          release()
          throw new Error('matrix_not_ready')
        }

        const identity = enrollment.identity
        const proxy = { baseUrl: managedModel.baseUrl, apiKey, model: MATRIX_DEFAULT_MODEL }
        forgetMatrixModelCheck(selected.store, identity.executorId)

        const pending = stopHermesExecutor(selected).then(() =>
          withMatrixHermes(
            runtime!,
            {
              owner: identity.principal,
              executorId: identity.executorId,
              signal: abort.signal,
              home: agentHermesHome(selected, identity, runtime!),
              sharedCodex: sharedCodexHere()
            },
            async connection => {
              const result = await configureMatrixManagedModel(connection, proxy, abort.signal)

              if (result.state === 'ready') {
                rememberOwnModel(identity.executorId, false, selected)
              }

              await ensureFullHermes(connection, identity.executorId, abort.signal, selected)
              finishMatrixAtumModelSwitch(selected, result.state === 'ready')

              return result
            }
          )
        )

        selected.invocation = { abort, pending, setup: true }
        publish(state)

        try {
          return await pending
        } catch {
          if (abort.signal.aborted) {
            return { state: 'cancelled' }
          }

          throw new Error('matrix_setup_failed')
        } finally {
          if (selected.invocation?.abort === abort) {
            selected.invocation = undefined
          }

          release()
          publish(state)
        }
      }

      // Account subscriptions (2026-10-27): one account-level read for Settings, a Mac-hosted
      // agent's safe subscription catalog for the picker, and the native plan sign-in and key
      // store. No key or token crosses back; a sign-in handle is opaque and bound to this scope.
      if (request?.kind === 'subscriptionsStatus') {
        const identity = account?.identity()

        if (!identity || !runtime) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        const local = matrixSubscriptionsStatus({ accountAuthHome: subscriptionAuthHome(), keys: subscriptionKeys() })
        const [platform, relay] = await Promise.all([providerConnections?.refresh(), chatGptRelay?.refresh()])
        const connected = matrixSubscriptionsWithProviderConnections(local, platform)
        const me = deviceIdentity?.enrollment()?.deviceServiceId
        const localModels =
          chatGptLocalModels?.accountKey === account?.appScope()?.accountKey ? chatGptLocalModels?.models : undefined
        return matrixSubscriptionsWithChatGptRelay(connected, relay, me, Boolean(chatGptRelay), localModels)
      }

      if (request?.kind === 'subscriptionCatalog') {
        const roomId = request.roomId

        if (typeof roomId !== 'string') {
          throw new Error('matrix_command_invalid')
        }

        const agent = requireRoomAgent(roomId)
        const owner = account?.appScope()
        const enrolled = enrollmentOf(agent)
        const executorId = enrolled.identity?.executorId

        if (
          !owner ||
          !runtime ||
          !executorId ||
          closing ||
          state.state !== 'ready' ||
          enrolled.state !== 'ready' ||
          isCloudOnlyAgent(agent) ||
          isMovingAgent(agent) ||
          lifecycle.blocksRuntime(agent.principal)
        ) {
          throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
        }

        const transport = new MatrixPagesManagementTransport({
          isCurrent: () => {
            const fresh = enrollmentOf(agent)
            const scope = account.appScope()

            return (
              !closing &&
              !agent.closed &&
              allAgents().includes(agent) &&
              !isCloudOnlyAgent(agent) &&
              !isMovingAgent(agent) &&
              !lifecycle.blocksRuntime(agent.principal) &&
              scope?.accountKey === owner.accountKey &&
              scope.generation === owner.generation &&
              fresh.state === 'ready' &&
              fresh.identity?.executorId === executorId
            )
          },
          connection: () => agent.executor?.connected,
          connect: () => startAssistantHermes(agent),
          lock: agent.lock,
          busy: () =>
            Boolean(
              operation ||
              domainOperation ||
              agent.operation ||
              agent.invocation ||
              agent.setup ||
              agent.holdsSignIn ||
              agent.localTurns?.executionPending
            )
        })

        try {
          const catalog = await listMatrixSubscriptionCatalog({
            ...(agent.name ? { agentName: agent.name } : {}),
            forward: value => transport.forward(value),
            isCurrent: () => transport.current()
          })

          return matrixSubscriptionCatalogWithGrant(catalog, matrixChatGptGrant(subscriptionAuthHome()))
        } finally {
          transport.retire()
        }
      }

      if (request?.kind === 'subscriptionChatGptStart') {
        const subscription = requireSubscriptionAccount()
        const localConnected = matrixSubscriptionsStatus({
          accountAuthHome: matrixSubscriptionHostHome(runtime!, subscription.owner, subscription.accountKey),
          keys: subscriptionKeys()
        }).providers.find(provider => provider.id === 'openai-codex')?.connected === true

        // An already-saved account needs relay repair only; it is not a new device-code attempt.
        if (localConnected) {
          await repairChatGptSubscription().run()

          return { status: 'connected' as const }
        }

        const authLifecycle = new MatrixSubscriptionAuthLifecycle()
        authLifecycle.subscriptionStartReceived()
        const { scope } = subscriptionProvidersFor(authLifecycle)

        try {
          const consent = (await scope.request({
            path: '/api/provider-settings/oauth/acknowledge',
            method: 'POST',
            body: { provider: 'openai-codex' }
          })) as MatrixProviderWriteResult

          if (consent.status !== 'applied') {
            await retireSubscriptionProviders()
            authLifecycle.startIpcSettled('cancelled')

            return { status: 'cancelled' as const }
          }

          const session = (await scope.request({
            path: '/api/provider-settings/oauth/start',
            method: 'POST',
            body: { provider: 'openai-codex' }
          })) as MatrixProviderOAuthSession | MatrixProviderWriteResult

          if (session.status !== 'pending' || !session.userCode) {
            await retireSubscriptionProviders()
            authLifecycle.startIpcSettled('cancelled')

            return { status: 'cancelled' as const }
          }

          authLifecycle.startIpcSettled('pending')

          return {
            status: 'pending' as const,
            session: session.session,
            provider: 'openai-codex' as const,
            userCode: session.userCode,
            url: MATRIX_CHATGPT_SIGN_IN_URL,
            expiresIn: session.expiresIn,
            pollInterval: session.pollInterval
          }
        } catch (error) {
          await retireSubscriptionProviders()
          authLifecycle.startIpcSettled('failed')
          throw error
        }
      }

      if (request?.kind === 'subscriptionChatGptPoll') {
        const providers = subscriptionProvidersFor()
        const { scope } = providers

        const result = (await scope.request({
          path: '/api/provider-settings/oauth/poll',
          method: 'POST',
          body: { session: subscriptionSession(request.session) }
        })) as MatrixProviderOAuthResult

        const outcome = await finishMatrixSubscriptionChatGptPoll(result, {
          complete: () => repairChatGptSubscription(providers.diagnostics.current).run()
        })

        if (outcome.status !== 'pending') {
          await retireSubscriptionProviders()
        }

        return outcome
      }

      if (request?.kind === 'subscriptionChatGptCancel') {
        const { scope } = subscriptionProvidersFor()

        try {
          await scope
            .request({
              path: '/api/provider-settings/oauth/cancel',
              method: 'POST',
              body: { session: subscriptionSession(request.session) }
            })
            .catch(() => undefined)
        } finally {
          await retireSubscriptionProviders()
        }

        return
      }

      if (request?.kind === 'subscriptionChatGptDisconnect') {
        const { owner, accountKey } = requireSubscriptionAccount()
        const { scope } = subscriptionProvidersFor()
        try {
          stopSubscriptionFollowUpRepair()
          await configureThisMacAsChatGptRelay(false).catch(() => false)

          await scope
            .request({
              path: '/api/provider-settings/oauth/disconnect',
              method: 'POST',
              body: { provider: 'openai-codex' }
            })
            .catch(() => undefined)

          forgetSubscriptionChatGpt({ config: runtime!, owner, sharedCodex: sharedCodexHere() })
          chatGptLocalModels = undefined
          // Hermes's DELETE above is the native disconnect. If it did not land, Hermes's own locked
          // clear_provider_auth drops the grant from the account home (never another provider's
          // rows): once before the assistants stop, so a restart cannot borrow it, and once after,
          // so a refresh a stopping assistant was finishing cannot write it back.
          const accountHome = matrixSubscriptionHostHome(runtime!, owner, accountKey)
          await clearMatrixAccountChatGpt(runtime!, accountHome).catch(() => undefined)
          await refreshSubscriptionAgents(true)
          await clearMatrixAccountChatGpt(runtime!, accountHome)
        } finally {
          await retireSubscriptionProviders()
        }

        return
      }

      if (request?.kind === 'subscriptionChatGptRelay') {
        if (typeof request.enabled !== 'boolean') {
          throw new Error('matrix_command_invalid')
        }

        try {
          if (!request.enabled) {
            stopSubscriptionFollowUpRepair()
            return {
              status: await configureThisMacAsChatGptRelay(false) ? 'applied' as const : 'unavailable' as const
            }
          }

          const result = await repairChatGptSubscription().run()
          return {
            status: result.relay === 'ok' ? 'applied' as const : 'unavailable' as const
          }
        } finally {
          await retireSubscriptionProviders()
        }
      }

      if (request?.kind === 'subscriptionOpenCodeSave') {
        const value = subscriptionKey(request.value)
        const keys = subscriptionKeys()

        // The account-wide platform connection is authoritative. On a build with no platform
        // domain the pre-R1 local key keeps working exactly as before.
        if (providerConnections) {
          const connected = await providerConnections.connect(value)

          if (!connected) {
            throw new Error('matrix_subscriptions_failed')
          }
        } else if (!keys) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        // Mac-hosted agents still read the account key from this Mac's encrypted store until the
        // subscription edge reaches them (the R1 contract is cloud-only); the key never returns.
        keys?.save(value)
        await refreshSubscriptionAgents()

        return { status: 'applied' as const }
      }

      if (request?.kind === 'subscriptionOpenCodeDisconnect') {
        const keys = subscriptionKeys()

        if (providerConnections) {
          const disconnected = await providerConnections.disconnect()

          if (!disconnected) {
            throw new Error('matrix_subscriptions_failed')
          }
        }

        keys?.clear()
        await refreshSubscriptionAgents(true)

        return
      }

      // The composer picker's sanitized route catalog of the connection(s) the room's agent can
      // answer with: read from that agent's own Hermes provider snapshot and switched through the
      // Connections page's native select (connected-models.ts). The window names the room and an
      // opaque route id; main supplies the agent, account generation, destination and validation.
      if (request?.kind === 'modelCatalog' || request?.kind === 'selectModelRoute') {
        const input = parseMatrixConnectedModelRequest(request)
        const agent = requireRoomAgent(input.roomId)
        const owner = account.appScope()
        const enrolled = enrollmentOf(agent)
        const executorId = enrolled.identity?.executorId
        const connected = agent.ownModel ? agent.connectedModel : undefined
        // A managed Mac agent may switch to a subscription model without already being on one:
        // that pick is the agent's own profile switch (the same native select writes it).
        const subscriptionRoute =
          input.kind === 'selectModelRoute' ? parseMatrixModelRouteId(input.routeId) : undefined
        const subscriptionPick = parseMatrixSubscriptionProvider(subscriptionRoute?.provider) !== undefined

        if (
          !owner ||
          !runtime ||
          !executorId ||
          (!connected && !subscriptionPick) ||
          closing ||
          state.state !== 'ready' ||
          enrolled.state !== 'ready' ||
          isCloudOnlyAgent(agent) ||
          isMovingAgent(agent) ||
          lifecycle.blocksRuntime(agent.principal)
        ) {
          throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
        }

        const transport = new MatrixPagesManagementTransport({
          isCurrent: () => {
            const fresh = enrollmentOf(agent)
            const scope = account.appScope()

            return (
              !closing &&
              !agent.closed &&
              (agent.ownModel || subscriptionPick) &&
              allAgents().includes(agent) &&
              !isCloudOnlyAgent(agent) &&
              !lifecycle.blocksRuntime(agent.principal) &&
              scope?.accountKey === owner.accountKey &&
              scope.generation === owner.generation &&
              fresh.state === 'ready' &&
              fresh.identity?.executorId === executorId
            )
          },
          connection: () => agent.executor?.connected,
          connect: () => startAssistantHermes(agent),
          lock: agent.lock,
          // The Connections page's holds (managementFor), and a plan sign-in held by this backend.
          busy: () =>
            Boolean(
              operation ||
              domainOperation ||
              agent.operation ||
              agent.invocation ||
              agent.setup ||
              agent.holdsSignIn ||
              agent.localTurns?.executionPending
            )
        })

        const connection: MatrixConnectedModelsAgent = {
          connected:
            connected ??
            {
              provider: subscriptionRoute!.provider,
              model: subscriptionRoute!.model
            },
          ...(agent.name ? { agentName: agent.name } : {}),
          forward: value => transport.forward(value),
          isCurrent: () => transport.current(),
          confirmCost: cost =>
            oneDialogAtATime(async () => {
              if (!transport.current() || !ui) {
                return false
              }

              const copy = matrixManagementConfirmationCopy(windowLocale(), agent.name ?? 'Atum', {
                kind: 'expensive-model',
                ...cost
              })

              const result = await dialog.showMessageBox(ui, {
                type: 'question',
                title: copy.title,
                message: copy.title,
                detail: copy.detail,
                buttons: [copy.cancel, copy.apply],
                defaultId: 0,
                cancelId: 0,
                noLink: true
              })

              return result.response === 1 && transport.current()
            }),
          selected: model => {
            if (!transport.current()) {
              throw new Error('pages_agent_unavailable')
            }

            // As the Connections page does: only Hermes's readback is remembered, and a resumed
            // conversation switches to it at its next turn (matrixSessionModelSwitch).
            const own = model.provider !== MATRIX_MANAGED_ENDPOINT.id
            rememberOwnModel(executorId, own, agent, own ? model : undefined)

            if (agent.readiness?.current.phase === 'blocked') {
              agent.readiness.recheck()
            }

            publish(state)
          }
        }

        try {
          return input.kind === 'modelCatalog'
            ? await listMatrixModelCatalog(connection)
            : await selectMatrixModelRoute(connection, input.routeId)
        } finally {
          transport.retire()
        }
      }

      if (request?.kind === 'sendTurn') {
        if ((config.assistantPath ?? 'local') !== 'local' || closing) {
          throw new Error('matrix_not_ready')
        }

        const input = parseMatrixCommand({ kind: 'send', roomId: request.roomId, body: request.body })
        // A reply passes the message it answers to the assistant as context (never a turn of its own).
        const reply = parseMatrixTurnReply(request.reply)

        if (input.kind !== 'send') {
          throw new Error('matrix_command_invalid')
        }

        const human = account.identity()
        const room = state.rooms.find(value => value.id === input.roomId)
        // The agent whose own room this is: each agent answers only in its own room.
        const roomAgent = human ? agentOfRoom(input.roomId, state.rooms, human.userId) : undefined

        // A legacy cloud-only agent has no linked document or local server path. Policy-backed
        // takeover keeps the ordinary local document confirmation path.
        if (
          human &&
          room &&
          isCloudOnlyAgent(roomAgent) &&
          documents.describe({ userId: human.userId, roomId: room.id })
        ) {
          throw new Error(MATRIX_CLOUD_AGENT_UNSUPPORTED)
        }

        // Local turns are this person's own messages in their assistant room on this Mac.
        // A linked document keeps today's server path, with its confirmation.
        if (
          !human ||
          !room ||
          !usableAgentRoom(room) ||
          !roomAgent?.localTurns ||
          documents.describe({ userId: human.userId, roomId: room.id })
        ) {
          throw new Error('matrix_not_ready')
        }

        const humanHost = hosts.get('human')
        const agentId = roomAgent.userId

        if (!humanHost || !agentId) {
          throw new Error('matrix_not_ready')
        }

        // The turn is kept first, so the person's message shows at once. The room's full server
        // read (this agent's one conversation, then every candidate room) runs once, in the
        // pump, before the question is posted (`sendQuestion`): a room that fails it leaves the
        // turn not sent, with Try again, and nothing reaches the room.
        const current = account.identity()

        if (
          closing ||
          hosts.get('human') !== humanHost ||
          current?.userId !== human.userId ||
          current?.deviceId !== human.deviceId ||
          agentOfRoom(input.roomId) !== roomAgent
        ) {
          throw new Error('matrix_not_ready')
        }

        // The person's first words in the new account's chat answer the assistant's welcome, which
        // invited them to name it. The model never saw that welcome, so this one message carries a
        // note saying so, in the turn's hidden context only (first-run-naming.ts).
        const naming = matrixFirstRunNamingContext({
          snapshot: state,
          roomId: input.roomId,
          primary: roomAgent === productAgent(),
          replying: reply !== undefined,
          name: roomAgent.name
        })

        const turnId = roomAgent.localTurns.accept(input.roomId, input.body, reply, naming)
        noteCheckInOwnerMessage(roomAgent, input.body)

        return { turnId }
      }

      if (request?.kind === 'cloudAgent') {
        return cloudAgentRequest(request)
      }

      if (request?.kind === 'executionPolicy') {
        const principal = request.agentPrincipal

        if (
          !executionPolicies ||
          closing ||
          !account.identity() ||
          typeof principal !== 'string' ||
          !allAgents().some(agent => !agent.closed && cloudPrincipal(agent) === principal)
        ) {
          throw new Error('matrix_execution_policy_unavailable')
        }

        if (request.action === 'read') {
          return executionPolicies.read(principal)
        }

        if (request.action === 'save') {
          const result = await executionPolicies.save(principal, request.update)

          if (result.ok) {
            // Saving the first policy also changes the legacy roster route to cloud. Refresh that
            // projection before main decides which local writers the audited switch may keep.
            agentRoster.request()
            void syncAgents()
          }

          return result
        }

        // The per-agent off switch: back to the legacy local path. The platform route may not exist
        // yet; the cache offers this only after its capability check, and refuses it otherwise.
        if (request.action === 'off') {
          const result = await executionPolicies.turnOff(principal, request.off)

          if (result.ok) {
            // The agent leaves the cloud route: refresh the roster so its local writers come back.
            agentRoster.request()
            void syncAgents()
          }

          return result
        }

        throw new Error('matrix_command_invalid')
      }

      if (request?.kind === 'backgroundSweep') {
        const principal = request.agentPrincipal
        const agent = typeof principal === 'string'
          ? allAgents().find(each => !each.closed && cloudPrincipal(each) === principal)
          : undefined

        if (closing || !account.identity() || !agent?.assistantId) {
          throw new Error('matrix_background_sweep_unavailable')
        }

        if (request.action === 'read') {
          return account.agentBackgroundSweep(agent.assistantId, AbortSignal.timeout(15_000))
        }

        if (request.action === 'save') {
          return account.writeAgentBackgroundSweep(
            agent.assistantId,
            (request as { write?: unknown }).write as MatrixBackgroundSweepSettingWrite,
            AbortSignal.timeout(15_000)
          )
        }

        throw new Error('matrix_command_invalid')
      }

      if (request?.kind === 'agentHome') {
        const principal = request.agentPrincipal

        if (
          !agentHome ||
          closing ||
          !account.identity() ||
          typeof principal !== 'string' ||
          !allAgents().some(agent => !agent.closed && cloudPrincipal(agent) === principal)
        ) {
          throw new Error('matrix_agent_home_unavailable')
        }

        return handleAgentHomeOwnerRequest(request, principal, {
          owner: agentHome.owner,
          kick: agent => agentHome?.kick(agent),
          publish: () => publish(state),
          scope: agentHomeOwnerScope,
          refreshNames: refreshAgentHomeNames,
          view: agentHomeView,
          cloudOffers: cloudHomeOffers,
          loadCloudOffers: async agent => {
            await cloudModelChoices?.reload(agent)
          },
          cloudChoiceRevision: async agent => (await modelDestinations?.read(agent))?.dailyCap?.revision,
          prepare: (agent, signal) =>
            agentHome?.prepare(agent, signal) ?? Promise.resolve({ ok: false as const, reason: 'unavailable' as const }),
          retained: agentHomePreflights
        })
      }

      if (request?.kind === 'modelDestinations') {
        return handleMatrixModelDestinationsRequest(request, {
          destinations: modelDestinations,
          closing,
          signedIn: Boolean(account.identity()),
          open: principal => allAgents().some(agent => !agent.closed && cloudPrincipal(agent) === principal),
          cloudChoiceSaved: principal => void cloudModelChoices?.reload(principal)
        })
      }

      if (request?.kind === 'answerTurnHere') {
        if (typeof request.turnId !== 'string' || closing) {
          throw new Error('matrix_not_ready')
        }

        const roomAgent = matrixTurnAgent(request.turnId, allAgents())

        // Cloud-route questions stay on the shared ledger; `answerHere` is the Mac-to-Mac path.
        if (!roomAgent?.localTurns || isCloudAgent(roomAgent) || isMovingAgent(roomAgent)) {
          throw new Error('matrix_turn_unavailable')
        }

        // Run this turn here first: a stale or foreign turn throws before anything is kept.
        const turnId = roomAgent.localTurns.answerHere(request.turnId)

        // Always answer here: this agent's typed messages stay on this Mac from now on.
        if (request.always === true) {
          roomAgent.store.setItem(MATRIX_ANSWER_HERE, '1')
        }

        return { turnId }
      }

      if (request?.kind === 'retryTurn') {
        if (typeof request.turnId !== 'string' || closing) {
          throw new Error('matrix_not_ready')
        }

        // Retried by the agent that holds the turn.
        const turnId = request.turnId
        const roomAgent = matrixTurnAgent(turnId, allAgents())

        if (!roomAgent?.localTurns) {
          throw new Error('matrix_not_ready')
        }

        return { turnId: roomAgent.localTurns.retry(turnId) }
      }

      if (request?.kind === 'sendAssistant') {
        const input = parseMatrixCommand({ kind: 'send', roomId: request.roomId, body: request.body })

        if (input.kind !== 'send') {
          throw new Error('matrix_command_invalid')
        }

        const roomAgent = requireRoomAgent(input.roomId)

        if (isActivelyMovingAgent(roomAgent)) {
          throw new Error('matrix_agent_unavailable')
        }

        if (
          isCloudOnlyAgent(roomAgent) ||
          matrixCloudAgentAnswersInCloud({ cloudRoute: isCloudAgent(roomAgent), role: cloudAgentMacRole(roomAgent) })
        ) {
          // S1: post only the owner's message. The cloud inbox admits the turn; no local
          // host, listener, provider auth, runtime or executor is needed (or started) here.
          const humanHost = hosts.get('human')
          const owner = account.identity()

          if (operation || domainOperation || closing || state.state !== 'ready' || !owner || !humanHost) {
            throw new Error('matrix_not_ready')
          }

          await guardRoomCommand(input.kind, input.roomId)

          if (closing || state.state !== 'ready' || hosts.get('human') !== humanHost || account.identity()?.userId !== owner.userId) {
            throw new Error('matrix_not_ready')
          }

          if (isActivelyMovingAgent(roomAgent)) {
            throw new Error('matrix_agent_unavailable')
          }

          const eventId = (await command(input)) as string

          return { eventId, result: { state: 'published' as const } }
        }

        // Local execution keeps every writer fence, including placement stand-down.
        refuseCloudAgent(roomAgent)

        if (
          !runtime ||
          assistantBlocked({
            operation: operation || roomAgent.operation,
            domainOperation,
            invocation: Boolean(roomAgent.invocation),
            closing,
            ready: state.state === 'ready',
            agentReady: Boolean(hosts.get(roomAgent.role)?.ready),
            listening: roomAgent.listener.snapshot()?.state === 'listening'
          })
        ) {
          throw new Error('matrix_not_ready')
        }

        const humanHost = hosts.get('human')
        const agentHost = hosts.get(roomAgent.role)!

        if (!humanHost) {
          throw new Error('matrix_not_ready')
        }

        holdOperation(roomAgent, true)
        noteCheckInOwnerMessage(roomAgent, input.body)

        return sendAssistantMessage({
          check: () => requireAssistantRoom(input.roomId, humanHost, agentHost, { forTurn: true }),
          send: async () => {
            const eventId = (await observeMessage(() => humanHost.queue.command(input))) as string
            rememberSentHere(eventId)

            return eventId
          },
          release: () => {
            holdOperation(roomAgent, false)
          },
          invoke: eventId =>
            runHermes({ roomId: input.roomId, eventId }, request.locale, undefined, undefined, roomAgent).then(
              matrixInvocationResult
            )
        })
      }

      if (request?.kind === 'invokeHermes' || request?.kind === 'connectHermes') {
        const parsed = parseMatrixCommand({
          kind: 'download',
          roomId: request.roomId,
          eventId: request.eventId ?? '$connect'
        })

        if (parsed.kind !== 'download') {
          throw new Error('matrix_command_invalid')
        }

        const roomAgent = requireRoomAgent(parsed.roomId)
        // S1: never this Mac's server path for a cloud agent.
        refuseCloudAgent(roomAgent)

        if (
          operation ||
          domainOperation ||
          roomAgent.operation ||
          (request.kind === 'invokeHermes' && roomAgent.invocation?.app) ||
          state.state !== 'ready' ||
          !hosts.get(roomAgent.role)?.ready
        ) {
          throw new Error('matrix_not_ready')
        }

        const target = { roomId: parsed.roomId, eventId: parsed.eventId }
        const human = account.identity()
        const enrolled = enrollmentOf(roomAgent)

        if (!human || enrolled.state !== 'ready' || !enrolled.identity) {
          throw new Error('matrix_agent_unavailable')
        }

        const agentHost = hosts.get(roomAgent.role)!
        const humanHost = hosts.get('human')!

        if (request.kind === 'connectHermes') {
          if (!state.rooms.some(room => room.id === target.roomId && usableAgentRoom(room))) {
            throw new Error('matrix_encrypted_room_required')
          }

          holdOperation(roomAgent, true)

          try {
            await connectAgentRoom(roomAgent, target.roomId, humanHost, agentHost)

            return
          } finally {
            holdOperation(roomAgent, false)
          }
        }

        // Run in place: the owner's own unanswered message in their private chat with this
        // agent, one run per message at a time. The run still re-reads the event and claims
        // it once on the ledger before anything executes (invocation.ts).
        const refusal = matrixExplicitInvocationRefusal({
          ...target,
          ownerUserId: human.userId,
          agentUserId: agentHost.identity.userId,
          selectedRoomId: state.roomId,
          rooms: state.rooms,
          messages: state.messages
        })

        if (refusal) {
          throw new Error(refusal)
        }

        const release = explicitInvocations.take(target.roomId, target.eventId)

        if (!release) {
          throw new Error('matrix_not_ready')
        }

        try {
          return matrixInvocationResult(await runHermes(target, request.locale, undefined, undefined, roomAgent))
        } finally {
          release()
        }
      }

      if (request?.kind === 'createAgent' || request?.kind === 'importAgent') {
        const persona = typeof request.persona === 'string' ? request.persona : ''

        // The window checked the name; native checks again against this Mac's own assistants
        // and creates under the stored form.
        const checked = checkAssistantName(request.name, {
          primary: false,
          principal: '',
          others: allAgents().flatMap(each =>
            !each.closed && each.agentPrincipal ? [{ principal: each.agentPrincipal, name: each.name }] : []
          ),
          apps: appNames()
        })

        if (!checked.ok || Buffer.byteLength(persona) > 65_536) {
          throw new Error('matrix_command_invalid')
        }

        const name = checked.name

        if (
          !config.domain ||
          !agentCreation ||
          closing ||
          anyOperation() ||
          state.state !== 'ready' ||
          !account.identity()
        ) {
          throw new Error('matrix_not_ready')
        }

        try {
          if (request.kind === 'importAgent') {
            if (!runtime) {
              throw new Error('matrix_runtime_unavailable')
            }

            const owner = hosts.get('human')
            profileSelection = true

            try {
              const selected = await oneDialogAtATime(() =>
                dialog.showOpenDialog(ui!, { properties: ['openDirectory'] })
              )

              if (selected.canceled || !selected.filePaths[0]) {
                return { cancelled: true }
              }

              const prepared = selected.filePaths[0]
              const payload = await readMatrixProfileImport(runtime, prepared)

              if (closing || hosts.get('human') !== owner || state.state !== 'ready') {
                throw new Error('matrix_not_ready')
              }

              profileSelection = false

              return await lifecycle.create(
                name,
                '',
                { prepared, sha256: payload.sha256 },
                request.hireConfirmed === true
              )
            } finally {
              profileSelection = false
            }
          }

          return await lifecycle.create(name, persona, undefined, request.hireConfirmed === true)
        } catch (error) {
          // A final refusal is an answer, not a failure; nothing is kept to repeat.
          if (error instanceof MatrixAgentCreationRefused) {
            return { refused: error.reason }
          }

          // Never relay a server's error text; the creation resumes at the next launch.
          console.warn('[Matrix] agent creation did not finish:', setupFailureDetail(error))
          throw new Error('matrix_agent_unavailable')
        }
      }

      if (request?.kind === 'retireAgent') {
        const primary = requireProductAgent()
        const principal = typeof request.principal === 'string' ? request.principal : ''

        const agentRuntime = matrixRetirementTarget(
          principal,
          account.retainedAgentPrincipal(),
          defaultAgent,
          allAgents(),
          primary
        )

        if (
          !agentRuntime?.assistantId ||
          agentRuntime === primary ||
          anyOperation() ||
          closing ||
          !account.identity()
        ) {
          throw new Error('matrix_agent_unavailable')
        }

        agentRuntime.operation = true

        try {
          const sessionCleanup = await lifecycle.retire(
            principal,
            agentRuntime.assistantId,
            agentRuntime === defaultAgent
          )

          // The roster's tombstone confirms the retirement on this Mac too (retired-agent-rooms.ts).
          agentRoster.request()

          return { sessionCleanup }
        } catch (error) {
          console.warn('[Matrix] agent retirement did not finish:', setupFailureDetail(error))
          throw new Error('matrix_agent_unavailable')
        } finally {
          agentRuntime.operation = false
          publish(state)
        }
      }

      if (request?.kind === 'renewAgent') {
        const assistantId = typeof request.assistantId === 'string' ? request.assistantId : ''
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(assistantId) || closing || !account.identity()) {
          throw new Error('matrix_agent_unavailable')
        }
        const result = await account.renewAgentHire(assistantId, randomUUID(), AbortSignal.timeout(20_000))
        if ('renewed' in result) { agentRoster.request(); void syncAgents() }
        return result
      }

      if (request?.kind === 'cancelDomain') {
        if (domainOperation) {
          account.cancel()
        }

        return
      }

      if (request?.kind === 'setupAssistant') {
        const selected = requireProductAgent()

        if (!matrixEnrollmentAuthority(enrollmentOf(selected)).ok) {
          throw new Error('matrix_authority_withdrawn')
        }

        if (operation || selected.operation || domainOperation || !account.identity()) {
          throw new Error('matrix_not_ready')
        }

        try {
          return await (selected === defaultAgent ? setUpAssistant(true) : setUpAgent(selected))
        } finally {
          selected.readiness?.recheck()
        }
      }

      if (request?.kind === 'retryReadiness') {
        recheckAgents(true)

        return
      }

      // One-tap approval (device-approval.ts): the person's answer on the approving device, their
      // "This wasn't me" and its sign-out, closing a finished one, or asking again.
      if (
        request?.kind === 'approvalAccept' ||
        request?.kind === 'approvalPick' ||
        request?.kind === 'approvalDecline' ||
        request?.kind === 'approvalSignOut' ||
        request?.kind === 'approvalDismiss' ||
        request?.kind === 'approvalConfirm' ||
        request?.kind === 'approvalRetry'
      ) {
        if (closing || !state.identity || !hosts.get('human')) {
          throw new Error('matrix_not_ready')
        }

        switch (request.kind) {
          case 'approvalAccept':
            await deviceApproval.accept()

            return null
          case 'approvalPick': {
            const index = request.index

            if (index !== null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 2)) {
              throw new Error('matrix_command_invalid')
            }

            // A wrong row refuses that device, and the sheet offers to sign it out too.
            const refused = await deviceApproval.pick(index as number | null)

            if (refused) {
              declinedDevice = refused
            }

            return null
          }

          case 'approvalDecline':
            declinedDevice = await deviceApproval.decline()

            return null

          case 'approvalSignOut':
            // The sheet still showing a refusal knows its device (also a mismatch the other side
            // reported); a wrong row or "This wasn't me" left it here too.
            declinedDevice = deviceApproval.refusedDevice() ?? declinedDevice

            if (!declinedDevice) {
              throw new Error('matrix_approval_stale')
            }

            await account.endDeviceSession(declinedDevice)

            return null

          case 'approvalDismiss':
            deviceApproval.dismiss()

            return null

          case 'approvalConfirm':
            // The new Mac: "I picked them" (a Mac with nothing to check the identity against).
            await deviceApproval.confirmPicked()

            return null

          default:
            // Try again on the approving device, after a comparison that took too long: it asks
            // that device again, and the person picks the right row again.
            if (deviceApproval.view()?.role === 'approve') {
              await deviceApproval.again()

              return null
            }

            // Asking again: only a Mac that never had a key asks; a stale one types its key
            // (owner-unlock.ts).
            if (
              ownerUnlock?.host === hosts.get('human') &&
              ownerUnlock?.result.state === 'needs_key' &&
              !matrixMayAskOtherDevices(ownerUnlock.result)
            ) {
              throw new Error('matrix_approval_unavailable')
            }

            deviceApproval.dismiss()

            return (await deviceApproval.request()) ? null : Promise.reject(new Error('matrix_approval_unavailable'))
        }
      }

      // Keep the key in iCloud Keychain, or not (Settings › Privacy & Security). Turning it off
      // removes the item on every device of that Apple ID; this Mac keeps its own copy.
      if (request?.kind === 'icloudKeychain') {
        const humanHost = hosts.get('human')

        if (
          closing ||
          !humanHost ||
          !icloudKeychain ||
          icloudAvailable !== true ||
          typeof request.enabled !== 'boolean'
        ) {
          throw new Error('matrix_not_ready')
        }

        deviceTrustStore?.setItem('icloud-keychain', request.enabled ? 'on' : 'off')
        icloudPreference = request.enabled ? 'on' : 'off'
        icloudMirrored = undefined

        if (request.enabled) {
          mirrorOwnerKeyToICloud(humanHost.identity)
        } else if (!(await icloudKeychain.remove(humanHost.identity.userId))) {
          throw new Error('matrix_icloud_unavailable')
        }

        publish(state)

        return null
      }

      if (request?.kind === 'openStorageSettings') {
        await shell.openExternal('x-apple.systempreferences:com.apple.settings.Storage')

        return null
      }

      // The person's Reconnect for one agent whose executor needs replacing here (withdrawn by the
      // platform, today's automatic replacements used up, or a replacement left half done).
      if (request?.kind === 'reconnectAgent') {
        const selected =
          typeof request.principal === 'string'
            ? allAgents().find(each => each.agentPrincipal === request.principal)
            : undefined

        if (!selected || closing || selected.closed || !account.identity()) {
          throw new Error('matrix_agent_unavailable')
        }

        const result = await reenrollAgent(selected, 'person')

        if (result === 'failed') {
          throw new Error('matrix_agent_reconnect_failed')
        }

        return null
      }

      // One first-learning run on the primary assistant's current home. The older three requests
      // remain accepted for 0.20.19 renderers during an app/runtime upgrade.
      if (
        request?.kind === 'firstRunStart' ||
        request?.kind === 'firstRunAllow' ||
        request?.kind === 'firstRunDecline' ||
        request?.kind === 'firstRunFinish'
      ) {
        const primary = productAgent()

        if (
          closing ||
          state.state !== 'ready' ||
          !state.identity ||
          !primary ||
          !state.firstRunOpen
        ) {
          throw new Error('matrix_not_ready')
        }

        if (request.kind === 'firstRunDecline') {
          return firstRun.decline()
        }

        if (request.kind === 'firstRunFinish') {
          return firstRun.finish()
        }

        if (
          request.roomId !== undefined &&
          (typeof request.roomId !== 'string' || !/^!.+/.test(request.roomId) || request.roomId.length > 1024)
        ) {
          throw new Error('matrix_command_invalid')
        }

        if (
          request.kind === 'firstRunStart' &&
          request.ending !== 'done' &&
          request.ending !== 'dismissed'
        ) {
          throw new Error('matrix_command_invalid')
        }

        return firstRun.start({
          roomId: request.roomId,
          locale: isDesktopLocale(request.locale) ? request.locale : DEFAULT_DESKTOP_LOCALE,
          ending: request.kind === 'firstRunStart' && request.ending === 'dismissed' ? 'dismissed' : 'done'
        })
      }

      // The key this Mac keeps for the account, shown only when the person asks to write it
      // down (Settings › Privacy & Security, or before signing out), then confirmed written.
      // Never logged; nothing else in the window receives it.
      if (request?.kind === 'recoveryReveal' || request?.kind === 'recoveryWritten') {
        const owner = hosts.get('human')

        if (!owner || closing || !state.identity || state.identity.userId !== owner.identity.userId) {
          throw new Error('matrix_recovery_stale')
        }

        const kept = keptOwnerKey(owner.identity)
        const binding = ownerBinding(owner.identity)

        if (!kept || !binding || !ownerKeys) {
          throw new Error('matrix_recovery_unavailable')
        }

        // Any key this Mac keeps can be shown, not only one it made: the person may need it to
        // set up another device.
        if (request.kind === 'recoveryReveal') {
          return kept.key
        }

        ownerKeys.markWritten(binding)

        try {
          account.recoveryWritten(owner.identity)
        } catch {
          // The account record's copy (0.18.1 and earlier) may already be gone.
        }

        setOwnerRecoveryCustody(owner.identity, keptOwnerKey(owner.identity))
        publish(state)

        return null
      }

      if (request?.kind === 'openTopUp') {
        if (!config.domain) {
          throw new Error('matrix_not_ready')
        }

        await shell.openExternal(`${config.domain.resource}/payments/protons`)

        return
      }

      if (request?.kind === 'enrollment') {
        // Read-only local metadata must be available while the SDK is connecting;
        // the UI mounts before the outer sign-in operation has released its lock.
        const selected = productAgent()

        return selected ? enrollmentOf(selected) : { state: 'absent', identity: null }
      }

      if (['readDomain', 'enrollHermes', 'revokeHermes'].includes(request?.kind ?? '')) {
        const selected = request.kind === 'readDomain' ? defaultAgent : requireProductAgent()

        if (
          operation ||
          selected.operation ||
          domainOperation ||
          (selected.invocation && request.kind === 'readDomain') ||
          !account.identity()
        ) {
          throw new Error('matrix_not_ready')
        }

        domainOperation = true

        try {
          switch (request.kind) {
            case 'enrollHermes': {
              await stopHost(selected.role)

              const result =
                selected.principal === undefined
                  ? await account.enrollHermes()
                  : await account.enrollAgent(selected.principal)

              await startHost(selected.role)
              selected.localTurns?.resume()
              setImmediate(() => selected.readiness?.start())

              return result
            }

            case 'revokeHermes': {
              const identity = enrollmentOf(selected).identity
              await stopHost(selected.role)

              // Clear before deleting the last record of this partition. On a
              // failed remote revoke the same identity can retry cleanup safely.
              if (identity) {
                await clearDevice({ userId: identity.userId, deviceId: identity.deviceId })
              }

              const result =
                selected.principal === undefined
                  ? await account.revokeHermes()
                  : await account.revokeAgent(selected.principal)

              // Removing the assistant is explicit: the gate stays idle until set up again.
              selected.readiness?.stop()
              selected.localTurns?.stop()
              selected.signals?.stop()
              selected.identity = undefined
              selected.agentPrincipal = selected.principal

              // Its entries only: every other agent keeps its scope, and creations and
              // retirements in progress stay to be finished.
              if (selected === defaultAgent) {
                outcomeStore.clear([MATRIX_AGENT_SCOPES, MATRIX_AGENT_CREATIONS, MATRIX_AGENT_RETIREMENTS])
              } else {
                selected.store.clear()
              }

              publish(state)

              return result
            }

            default:
              return await account.readDomain()
          }
        } catch {
          // Never relay OAuth/server errors (which may contain request details).
          throw new Error('matrix_domain_unavailable')
        } finally {
          domainOperation = false
        }
      }

      if (request?.kind === 'cancelSignIn') {
        if (state.state !== 'signing_in') {
          return
        }

        account.cancel()

        // Matrix is already signed in and only the Atum account step was still in the
        // browser: stopping it ends the sign-in signed in, not signed out.
        let committed = false

        try {
          committed = Boolean(account.identity())
        } catch {
          // An unreadable vault is not a signed-in account.
        }

        if (!committed) {
          // An ended session's account still waits for its person: the notice stays.
          publish({
            state: 'signed_out',
            identity: null,
            rooms: [],
            roomId: null,
            messages: [],
            error: signedOutNotice()
          })
        }

        return
      }

      if (request?.kind === 'command') {
        // What is on screen is a presentation fact, not an operation: a long account or
        // agent operation must not keep a conversation the person is reading unread. Typing
        // is the same kind of signal.
        const presentation = (request.command as { kind?: unknown } | null)?.kind

        if ((presentation === 'attend' || presentation === 'typing') && account.identity()) {
          // Not an operation, but it names a room: the same room guard as every other command.
          return presentationCommand(request.command)
        }

        if (anyOperation() || !account.identity()) {
          throw new Error('matrix_not_ready')
        }

        const input = parseMatrixCommand(request.command)

        if (input.kind === 'setModel') {
          const agent = requireRoomAgent(input.roomId)
          const cloudPrincipalId = cloudPrincipal(agent)

          // The same view the window renders: on a cloud agent an own model is not used,
          // so Atum's managed model is the one this command may change.
          const view = matrixAgentModelView({
            managedModel: Boolean(managedModel),
            ownModel: agent.ownModel,
            connectedModel: agent.connectedModel,
            cloud: isCloudAgent(agent)
          })

          // A cloud agent's model is the platform's choice (`atum.model-choice/1.1`), never
          // this Mac's room account data. The offer's aliases are the only ones offered; the
          // server refuses anything else, and a refusal leaves the row where it was.
          if (isCloudAgent(agent) && view.atumModel) {
            // The destination record first: it replaces a saved plan choice (ChatGPT), where the
            // 1.1 offer path would refuse or leave the plan in place (writeMatrixCloudAtumChoice).
            // An OpenRouter shelf model keeps its own default level from the offer.
            const shelfEffort =
              input.model && parseMatrixShelfModel(input.model) && cloudPrincipalId
                ? cloudModelChoices?.offer(cloudPrincipalId)?.models.find(row => row.alias === input.model)?.defaultEffort
                : undefined

            const applied =
              input.model && !input.effort && cloudPrincipalId
                ? await writeMatrixCloudAtumChoice(cloudPrincipalId, input.model, {
                    ...(modelDestinations ? { destinations: modelDestinations } : {}),
                    ...(cloudModelChoices ? { legacy: cloudModelChoices } : {}),
                    ...(shelfEffort === 'low' || shelfEffort === 'medium' || shelfEffort === 'high'
                      ? { effort: shelfEffort }
                      : {})
                  })
                : false

            return { status: applied ? ('applied' as const) : ('refused' as const) }
          }

          // OpenRouter shelf models run in the cloud only; the gateway refuses them from a Mac.
          if (input.model && parseMatrixShelfModel(input.model)) {
            throw new Error('matrix_model_choice_unavailable')
          }

          requireMatrixSessionChoice(
            state.rooms.find(room => room.id === input.roomId),
            agent.agentPrincipal ?? enrollmentOf(agent).identity?.agentPrincipal
          )

          if (
            agent.ownModel &&
            (input.model ||
              !agent.connectedModel ||
              (input.effort && !matrixConnectedModelEfforts(agent.connectedModel).includes(input.effort)))
          ) {
            throw new Error('matrix_model_choice_unavailable')
          }
        }

        // The window never answers main's own check of an agent (it never sees one either).
        if (input.kind === 'verificationRespond' && backgroundVerifications.hidden(input.id)) {
          throw new Error('matrix_verification_background')
        }

        if (['selectApp', 'discoverApps', 'appShortcut'].includes(input.kind) && !matrixApps) {
          throw new Error('matrix_app_unavailable')
        }

        if (
          input.kind === 'selectApp' ||
          input.kind === 'discoverApps' ||
          input.kind === 'notesSelfOpen' ||
          (input.kind === 'select' && input.roomId !== state.roomId) ||
          ((input.kind === 'leave' || input.kind === 'forget') && input.roomId === state.roomId)
        ) {
          documents.closePreviews()
        }

        const owner = hosts.get('human')
        const sdkBusy = [...hosts.values()].some(host => host.queue.busy || host.renewing)
        // One check for every membership command, here and in main's own (an app bot's invitation): see the guard.
        await guardRoomCommand(input.kind, 'roomId' in input ? input.roomId : undefined)

        const commandRoom = 'roomId' in input ? state.rooms.find(room => room.id === input.roomId) : undefined
        const companyRoom = commandRoom?.roomType === MATRIX_COMPANY_CHANNEL_TYPE ? commandRoom : undefined
        const teamSpaceRoom = isTeamSpaceRoom(commandRoom) ? commandRoom : undefined

        const companyFiles = config.companyDriveFiles === true && config.companyWorkspace === true && Boolean(config.domain)

        const companyFilePorts = (): MatrixCompanyFileControllerPorts => {
          if (!owner || !companyFiles) {
            throw new Error('matrix_company_file_unavailable')
          }

          const current = () => {
            try {
              const identity = account.identity()

              return !closing && hosts.get('human') === owner && state.state === 'ready' &&
                identity?.userId === owner.identity.userId && identity?.deviceId === owner.identity.deviceId
            } catch {
              return false
            }
          }

          return {
            pending: () => account.companyFilePending(),
            remember: value => account.writeCompanyFilePending(value),
            clear: () => account.clearCompanyFilePending(),
            platform: (value, signal) => account.companyFile(value, signal),
            sdk: value => owner.queue.command(value, 150_000),
            current
          }
        }

        const companyFilePortsV2 = () => {
          if (!owner || !companyFiles || !config.domain) {
            throw new Error('matrix_company_file_unsupported')
          }
          const current = () => {
            try {
              const identity = account.identity()
              return !closing && hosts.get('human') === owner && state.state === 'ready' &&
                identity?.userId === owner.identity.userId && identity?.deviceId === owner.identity.deviceId
            } catch {
              return false
            }
          }
          return {
            platform: (value: Parameters<typeof account.companyFileV2>[0], signal: AbortSignal) =>
              account.companyFileV2(value, signal),
            sdk: (value: Parameters<MatrixCompanyFileControllerPorts['sdk']>[0]) => owner.queue.command(value, 150_000),
            current,
            serverUrl: config.domain.resource
          }
        }

        if (input.kind === 'attach' && teamSpaceRoom) {
          if (!owner || !companyFiles || sdkBusy || state.state !== 'ready') {
            throw new Error(companyFiles ? 'matrix_company_file_unavailable' : 'matrix_company_file_unsupported')
          }
          const signal = AbortSignal.timeout(10 * 60_000)
          const authority = await resolveCompanyFileAuthorityV2(account, teamSpaceRoom, 'upload', signal)
          const sendInput = {
            roomId: input.roomId, name: input.name,
            contentType: input.contentType ?? 'application/octet-stream', bytes: input.bytes,
            ...(input.threadRootId ? { threadRootId: input.threadRootId, replyTo: input.replyTo ?? input.threadRootId } : {})
          }
          return authority.kind === 'v2'
            ? sendCompanyFileV2(sendInput, authority.authority, companyFilePortsV2(), signal)
            : sendCompanyFile(sendInput, companyFilePorts(), signal)
        }

        if (input.kind === 'attach' && input.threadRootId) {
          throw new Error('matrix_company_file_unavailable')
        }

        if (input.kind === 'download' && input.companyFile === true) {
          if (!owner || !companyFiles || !teamSpaceRoom || sdkBusy || state.state !== 'ready') {
            throw new Error(companyFiles ? 'matrix_company_file_unavailable' : 'matrix_company_file_unsupported')
          }
          const downloadPorts = companyFilePortsV2()
          const sdk = downloadPorts.sdk
          const reference = await sdk({
            kind: 'companyFileReference', roomId: input.roomId, eventId: input.eventId
          }) as MatrixCompanyFileRef
          const signal = AbortSignal.timeout(10 * 60_000)
          const authority = await resolveCompanyFileAuthorityV2(account, teamSpaceRoom, 'download', signal)
          let file: { name: string; bytes: Uint8Array }
          if (reference.v === 2) {
            if (authority.kind !== 'v2') {
              throw new Error('matrix_company_file_unsupported')
            }
            file = await readCompanyFileV2(reference as MatrixCompanyFileRefV2, authority.authority,
              downloadPorts, signal)
          } else {
            const compatiblePublic = authority.kind === 'legacy-public'
              ? authority.companyId === reference.company_id && authority.channelId === reference.channel_id
              : authority.authority.audience.kind === 'channel' &&
              authority.authority.audience.visibility === 'public' &&
              authority.authority.companyId === reference.company_id &&
              authority.authority.audience.channel_id === reference.channel_id

            if (!compatiblePublic || !companyRoom) {
              throw new Error('matrix_company_file_denied')
            }
            const ports = companyFilePorts()
            const pendingCompanyFile = ports.pending()
            if (pendingCompanyFile?.fileId === reference.file_id &&
                (!pendingCompanyFile.eventId || pendingCompanyFile.eventId === input.eventId)) {
              await recoverCompanyFile(ports, signal)
            }
            file = await readCompanyFile(reference, ports, signal)
          }

          if (!downloadPorts.current()) {
            throw new Error('matrix_company_file_cancelled')
          }

          const target = await dialog.showSaveDialog(ui!, {
            defaultPath: path.basename(file.name).replace(/[\\/]|\p{Cc}/gu, '_')
          })

          if (!downloadPorts.current()) {
            throw new Error('matrix_company_file_cancelled')
          }

          if (!target.canceled && target.filePath) {
            await saveUserSelectedFile(target.filePath, file.bytes)
          }

          return null
        }

        if (input.kind === 'agentConversation') {
          requireMatrixDisplayIdentity(input.identity, state.identity)
          requireMatrixDisplayIdentity(input.identity, account.identity())
          requireMatrixDisplayIdentity(input.identity, owner?.identity)
          const agent = allAgents().find(each => !each.closed && each.userId === input.agentId)

          if (!owner || !agent || state.state !== 'ready') {
            throw new Error('matrix_conversation_unavailable')
          }

          return changeAgentConversation(agent, input.action, input.roomId)
        }

        if (AGENT_ONE_CONVERSATION && (input.kind === 'leave' || input.kind === 'forget')) {
          const agent = agentOfRoom(input.roomId)

          if (agent && owner) {
            const reads = (await owner.queue.command({
              kind: 'readConversationCandidates',
              ownerId: owner.identity.userId,
              agentId: agent.userId!
            })) as ConversationCandidateRead[]

            if (closing || hosts.get('human') !== owner) {
              throw new Error('matrix_not_ready')
            }

            if (!conversationRemovalAllowed(reads, input.roomId)) {
              throw new Error('matrix_conversation_main_required')
            }
          }
        }

        if (input.kind === 'deviceIsolation') {
          requireMatrixDisplayIdentity(input.identity, state.identity)
          requireMatrixDisplayIdentity(input.identity, account.identity())

          if (!isolationPolicy || isolationBusy() || sdkBusy) {
            throw new Error('matrix_device_isolation_pending')
          }

          const roles = [...hosts.keys()]
          const scope = petScopeToken()

          const current = () =>
            !closing &&
            scope === petScopeToken() &&
            account.identity()?.userId === input.identity.userId &&
            account.identity()?.deviceId === input.identity.deviceId

          operation = true

          try {
            await isolationPolicy.change(input.value, {
              current,
              stop: stopSdk,
              start: async () => {
                if (!current()) {
                  throw new Error('matrix_device_isolation_stale')
                }

                await startSdk()

                for (const role of roles) {
                  if (!current()) {
                    throw new Error('matrix_device_isolation_stale')
                  }

                  await startHost(role)
                }
              },
              changed: () => publish(state)
            })
            console.info(
              input.value === 'signed'
                ? '[matrix-trust] device_isolation_signed'
                : '[matrix-trust] device_isolation_all'
            )

            return null
          } catch {
            publish({ ...state, state: 'error', error: 'matrix_device_isolation_unavailable', canSend: false })
            throw new Error('matrix_device_isolation_unavailable')
          } finally {
            operation = false
            publish(state)
          }
        }

        if (input.kind === 'peerIdentity') {
          requireMatrixDisplayIdentity(input.identity, state.identity)
          requireMatrixDisplayIdentity(input.identity, owner?.identity)

          if (!owner || isolationBusy() || sdkBusy || state.state !== 'ready') {
            throw new Error('matrix_identity_review_invalid')
          }

          const scope = petScopeToken()
          const captured = new Map(hosts)

          const current = () =>
            !closing &&
            scope === petScopeToken() &&
            state.roomId === input.roomId &&
            state.state === 'ready' &&
            [...captured].every(([role, host]) => hosts.get(role) === host) &&
            account.identity()?.userId === input.identity.userId &&
            account.identity()?.deviceId === input.identity.deviceId &&
            input.userId !== input.identity.userId &&
            state.members?.some(member => member.userId === input.userId && member.membership === 'join')

          if (!current()) {
            throw new Error('matrix_identity_review_stale')
          }

          const query = { roomId: input.roomId, userId: input.userId }
          operation = true

          try {
            const status = await owner.queue.command({ kind: 'peerIdentityRead', ...query })

            if (!current()) {
              throw new Error('matrix_identity_review_stale')
            }

            if (input.action === 'read') {
              return status
            }

            if (status !== 'changed' && status !== 'verification_required') {
              throw new Error('matrix_identity_review_stale')
            }

            const locale = matrixAppMenuLocale(state, app.getPreferredSystemLanguages())
            const copy = matrixDeviceIsolationCopy[locale]
            const name = state.members?.find(member => member.userId === input.userId)?.name ?? ''
            const identityLine = status === 'changed' ? copy.identityChanged(name) : copy.verificationRequired(name)

            const approved = await oneDialogAtATime(async () => {
              if (!current() || !ui || ui.isDestroyed()) {
                return false
              }

              const result = await dialog.showMessageBox(ui, {
                type: 'question',
                title: copy.review,
                message: identityLine,
                detail: input.action === 'review' ? copy.compareHelp : copy.continueHelp,
                buttons: [
                  matrixActionCopy[locale].consentCancel,
                  input.action === 'review' ? copy.review : copy.continueWithoutVerification
                ],
                defaultId: 0,
                cancelId: 0,
                noLink: true
              })

              return result.response === 1 && current()
            })

            if (!approved) {
              return null
            }

            if (!current()) {
              throw new Error('matrix_identity_review_stale')
            }

            const result = await owner.queue.command({
              kind: input.action === 'review' ? 'peerIdentityStart' : 'peerIdentityContinue',
              ...query
            })

            if (!current()) {
              throw new Error('matrix_identity_review_stale')
            }

            return result
          } finally {
            operation = false
            publish(state)
          }
        }

        if (input.kind === 'groupPolicy') {
          requireMatrixDisplayIdentity(input.identity, state.identity)
          requireMatrixDisplayIdentity(input.identity, owner?.identity)

          const members = new Set(
            state.rooms
              .find(room => room.id === input.roomId)
              ?.participants?.filter(member => member.membership === 'join')
              .map(member => member.userId)
          )

          const agentIds = allAgents()
            .filter(
              each =>
                !each.closed &&
                matrixEnrollmentAuthority(enrollmentOf(each)).ok &&
                each.userId &&
                members.has(each.userId)
            )
            .map(each => each.userId!)

          if (!owner || closing || !agentIds.length) {
            throw new Error('matrix_group_room_required')
          }

          const result = await owner.queue.command({
            kind: 'ownerGroupPolicy',
            roomId: input.roomId,
            ownerId: owner.identity.userId,
            agentIds,
            ...(input.change ? { change: input.change } : {})
          })

          requireMatrixDisplayIdentity(input.identity, state.identity)

          if (closing || hosts.get('human') !== owner) {
            throw new Error('matrix_group_changed')
          }

          return result
        }

        if (input.kind === 'starterSeen') {
          requireMatrixStarterAcknowledgement(input, state.identity, petScopeToken(), state.starter)
          requireMatrixStarterAcknowledgement(input, owner?.identity, petScopeToken(), state.starter)

          if (!owner || closing) {
            throw new Error('matrix_starter_stale')
          }

          const result = await owner.queue.command(input)

          if (closing || hosts.get('human') !== owner || input.scope !== petScopeToken()) {
            throw new Error('matrix_starter_stale')
          }

          return result
        }

        if (
          input.kind === 'displayPreference' ||
          input.kind === 'checkInsChange' ||
          input.kind === 'checkInsFeedback'
        ) {
          requireMatrixDisplayIdentity(input.identity, state.identity)
          requireMatrixDisplayIdentity(input.identity, owner?.identity)
        }

        if (input.kind === 'checkInsChange' && input.change.field === 'enabled' && input.change.value) {
          const result = await command(input)
          // Turned back on: the job is there again on this Mac at once (others at their start).
          ensureCheckInJob(true)

          return result
        }

        if (input.kind === 'recoveryRestore' || input.kind === 'recoverySetUp') {
          return serializeSecurity(async () => {
            if (!owner || closing || hosts.get('human') !== owner) {
              throw new Error('matrix_recovery_stale')
            }

            const key = await owner.queue.command({ kind: 'ownerRecovery', command: input }, 120_000)

            if (closing || hosts.get('human') !== owner || typeof key !== 'string') {
              throw new Error('matrix_recovery_stale')
            }

            // The person saw or typed this key: it is no longer this Mac's alone. Kept for the
            // person (owner-keys.ts), so signing in again here never asks for it. Only a typed key
            // replaces a kept key, or a recovery the person just made here (the SDK makes one
            // only on an account that has none).
            retainOwnerKey(
              owner.identity,
              key,
              input.kind === 'recoveryRestore' ? { source: 'typed' } : { source: 'created', byPerson: true }
            )
            ownerKeyChanged()
            // The explicit recovery completed. Wake the blocked gates without
            // returning the remembered key to the visible renderer.
            setImmediate(() => {
              for (const each of allAgents()) {
                each.readiness?.start()
              }
            })

            return null
          })
        }

        const sdkCommand = assistantCommand(
          input,
          productAgent()?.userId,
          domainOperation,
          allAgents()
            .filter(each => !each.closed && matrixEnrollmentAuthority(enrollmentOf(each)).ok)
            .flatMap(each => (each.userId ? [each.userId] : [])),
          allAgents()
            .filter(
              each =>
                !each.closed &&
                matrixEnrollmentAuthority(enrollmentOf(each)).ok &&
                assistantInviteAdoptionEnabled({ cloud: isCloudAgent(each), cloudOnly: isCloudOnlyAgent(each) })
            )
            .flatMap(each => (each.userId ? [each.userId] : []))
        )

        const appSlug = (appId: string) => matrixApps?.snapshot().apps.find(app => app.app_id === appId)?.app

        const result = await command(sdkCommand).catch((error: unknown) => {
          // Delete chat on Moon's or Andy's chat that failed to keep it out of sight.
          const failed =
            sdkCommand.kind === 'forget'
              ? appBotChatHideFailedLine(
                  state.rooms.find(room => room.id === sdkCommand.roomId)?.appBot,
                  appSlug,
                  error
                )
              : null

          if (failed) {
            console.warn(failed)
          }

          // A company channel that would not open: which step refused it, in closed words (OB1 diagnostics).
          if ((sdkCommand.kind === 'select' || sdkCommand.kind === 'join') && companyRoom) {
            console.warn(companyChannelOpenFailedLine(sdkCommand.kind, error))
          }

          throw error
        })

        // The owner's own assistants invited to a group: each joins through its host here.
        if (sdkCommand.kind === 'createGroup' && typeof result === 'string') {
          // The group exists whatever happens next: an assistant that hasn't joined stays
          // invited, and adding it again from Members asks it to join again.
          await joinGroupAgents(result, sdkCommand.agents).catch(() =>
            console.warn('[Matrix] group made; an assistant has not joined it yet')
          )
        } else if (sdkCommand.kind === 'inviteAgent') {
          await joinGroupAgents(sdkCommand.roomId, [sdkCommand.userId])
        } else if (sdkCommand.kind === 'select') {
          // Moon's or Andy's chat opened as a plain chat (its row while the bot is down, or ⌘K).
          const selected = appBotChatSelectedLine(
            state.rooms.find(room => room.id === sdkCommand.roomId)?.appBot,
            sdkCommand.roomId,
            appId => {
              const app = matrixApps?.snapshot().apps.find(each => each.app_id === appId)

              return app ? { slug: app.app, bot: app.bot?.state } : undefined
            }
          )

          if (selected) {
            console.warn(selected)
          }

          // A company channel opened: whether the window is shown it, held back for its directory read, or shown as
          // an ordinary room. The renderer has no log of its own, so this is the evidence for a blank channel pane.
          const channelRoom = state.rooms.find(room => room.id === sdkCommand.roomId)
          const channelLine = companyChannelSelectedLine(companyChannelConfirmations.status(channelRoom), channelRoom?.membership)

          if (channelLine) {
            console.warn(channelLine)
          }
        } else if (sdkCommand.kind === 'forget') {
          // Delete chat on Moon's or Andy's chat keeps the room, out of sight (app-bot-dm.ts).
          const hidden = appBotChatHiddenLine(result, sdkCommand.roomId, appSlug)

          if (hidden) {
            console.warn(hidden)
          }
        }

        if (input.kind === 'download') {
          if (anyOperation() || closing || hosts.get('human') !== owner) {
            throw new Error('matrix_not_ready')
          }

          const file = result as { name: string; bytes: Uint8Array }

          if (
            typeof file?.name !== 'string' ||
            !(file.bytes instanceof Uint8Array) ||
            file.bytes.byteLength > MATRIX_MAX_FILE_BYTES
          ) {
            throw new Error('matrix_file_invalid')
          }

          const target = await dialog.showSaveDialog(ui!, {
            defaultPath: path.basename(file.name).replace(/[\\/]|\p{Cc}/gu, '_')
          })

          // The dialog can outlive logout or SDK replacement. Decrypted bytes
          // belong only to the originating account/host, never its successor.
          if (anyOperation() || closing || hosts.get('human') !== owner) {
            throw new Error('matrix_not_ready')
          }

          if (!target.canceled && target.filePath) {
            await saveUserSelectedFile(target.filePath, file.bytes)
          }

          return null
        }

        return result
      }

      if (anyOperation()) {
        throw new Error('matrix_operation_pending')
      }

      operation = true

      try {
        switch (request?.kind) {
          case 'repairOwnerDevice': {
            if (closing) { throw new Error('matrix_owner_repair_stale') }
            const result = await ownerRepairController().run(parseMatrixSignInMethod(request.method))

            if (result.state === 'repaired') {
              await reconcileDeviceControl(true).catch(() => console.warn('[Device] owner binding check pending'))
            }

            return result
          }

          case 'signIn': {
            const method = parseMatrixSignInMethod(request.method)
            publish({ ...state, state: 'signing_in', error: null, signInReturned: false, signInBrowser: false })
            const signedIn = await account.signIn(method)
            desktopServices?.capture({ name: 'matrix_signin_finished', properties: { outcome: 'completed' } })
            // Already in front since the browser came back (the account's `returned`); again
            // here in case the person moved away meanwhile. Repeating it is harmless.
            bringToFront()

            if (config.domain) {
              startupState = { step: 'assistant', state: 'working' }
            }

            const replaced = signedIn.replaced

            if (replaced) {
              // Signed in again over an ended session: the ended device's local store is no
              // one's any more (its keys come back from backup with the remembered key).
              console.warn('[Matrix] signed in again over an ended session')
              sessionRestartedAt = undefined
              // A fresh sign-in is a fresh session: placements from the one it replaced are not
              // the new session's (this path never ran sign-out).
              placedAgents.reset()
              void clearDevice(replaced).catch(() => console.warn('[Matrix] ended device cleanup failed'))
            }

            await startSdk()
            defaultAgent.localTurns?.resume()

            // The agents this Mac kept through the ended session resume where they paused. The
            // sign-in has succeeded: a vault that can't be read now only pauses their turns.
            if (replaced) {
              for (const each of agents.values()) {
                try {
                  each.localTurns?.resume()
                } catch {
                  console.warn('[Matrix] an agent’s local turns could not resume: vault unavailable')
                }
              }
            }

            // After the operation lock is released below. The browser already had its two
            // tries at the Atum account (account.signIn): without the grant, setup asks once
            // in the compact window rather than opening the browser a third time.
            setImmediate(() => {
              gateInteractive = signedIn.domain

              if (!signedIn.domain) {
                console.warn('[Matrix] sign-in finished without the Atum account grant')
              }

              if (!unusedRoot()) {
                defaultAgent.readiness?.start()
              }

              if (replaced) {
                for (const each of agents.values()) {
                  each.readiness?.start()
                }
              }
            })

            break
          }

          case 'signOut': {
            ownerDeviceRepair = undefined
            deviceControlOwner = undefined
            // WS-4: a local Stop already ran above the operation lock; now that sign-out is really
            // happening, fence with sign_out FIRST, synchronously, before any await (account epoch bump).
            matrixDeviceStopFence?.('sign_out')
            // S1 WS-3b: the device fence comes first and is synchronous: the account epoch moves on
            // and the hub connection closes with a signed Stop (WS-4's stop.ts joins it here).
            deviceIdentity?.signOut('sign_out')
            await ownPresence.offline()
            executionDeviceNames.invalidate()
            scheduleContinuousListening()
            cloudEnrollments?.stop()
            petOverlays?.clear()

            moveGeneration += 1

            for (const each of moveAborts) {
              each.abort()
            }

            if (defaultAgent.assistantId) {
              const authority = await account.firstRunGoogleAuthority(defaultAgent.assistantId).catch(() => undefined)
              await firstRunGoogleValue.cancel(authority)
            }

            await deviceBootstrap?.signedOut()

            agentMoves.clear()
            cloudAgents.clear()
            hostRuntimeAgents.clear()
            placedAgents.reset()
            movingAgents.clear()
            scheduleContinuousListening()
            // The recovery key stays on this Mac for the person (owner-keys.ts) unless they
            // choose to forget it (selling or giving the Mac away): then it goes first, so it is
            // gone even if the rest of the sign-out has to be finished later.
            const forgetIdentity = request.forgetKey === true ? account.identity() : null
            const forgetBinding = forgetIdentity ? ownerBinding(forgetIdentity) : undefined

            if (forgetIdentity && forgetBinding) {
              // Both copies: the account record's would otherwise come back as the kept key the
              // next time anything reads it, even later in this same sign-out.
              forgetMatrixOwnerKey(ownerKeys, forgetBinding, ownerKeyLegacy(forgetIdentity))
              console.warn('[Matrix] recovery key forgotten on this Mac at sign-out')
            }

            ownerUnlock = undefined
            // Forgotten: known to be gone, never read back from the vault during the sign-out.
            recoveryCustody = forgetIdentity
              ? { owner: `${forgetIdentity.userId}\n${forgetIdentity.deviceId}`, kept: false }
              : undefined

            // The device goes with the sign-out; a new one gets its own entry.
            if (state.identity) {
              deviceLedger?.forget(state.identity)
            }

            ownDeviceDamaged = undefined
            icloudMirrored = undefined
            deviceApproval.reset()
            approvalAsked = undefined
            declinedDevice = undefined
            const driveCleanup = drive?.disconnect().catch(() => console.warn('[Matrix] matrix_drive_cleanup_pending'))
            brainActive = false
            brainOwner = null
            // Fence now; account.signOut below awaits the same shutdown through
            // stopSdk before completing the account transition.
            void localBrain?.stop().catch(() => console.warn('[Matrix] local_brain_cleanup_failed'))
            hermesPages?.clearAll()
            startupState = undefined
            agentRoster.invalidate()
            sourceGateSync?.stop()

            for (const each of allAgents()) {
              forgetContinuousListening(each)
              leaseHandover.forget(each)
              each.readiness?.stop()
              void each.lease?.stop()
              stopListening('cancelled', each)
              each.listener.clear()
            }

            // The account's ChatGPT sign-in on this Mac goes with it (matrixAccountCodexScope):
            // before the sign-out, so it is gone even if the rest has to be finished later, and
            // again after, in case an assistant refreshed it while stopping.
            const codexOwners = signingOutCodexOwners()
            forgetCodexOwners(codexOwners)
            forgetSubscriptionKey(account.appScope()?.accountKey)

            publish({ state: 'connecting', identity: null, rooms: [], messages: [], roomId: null, error: null })
            // The renderer removes its keyed webview guests as identity clears;
            // clear their sessions here as well so a failed/unmounted renderer
            // cannot retain an isolated browser session past sign-out.
            await matrixConsumerBrowser.releaseConsumerPartitions().catch(() => {
              // Browser network authority is already revoked. Ephemeral cache
              // cleanup failure must never prevent Matrix credential revocation.
              console.warn('[Matrix] Ephemeral browser cleanup failed during sign-out')
            })
            await account.signOut(async (identity, agentIdentity, others) => {
              await stopSdk()

              for (const device of [identity, ...(agentIdentity ? [agentIdentity] : []), ...(others ?? [])]) {
                await clearDevice(device)
              }
            })
            await driveCleanup
            await forgetAgents()
            forgetCodexOwners(codexOwners)

            try {
              agentCleanupRequired = account.hasOrphanedEnrollments()
              orphanedEnrollmentsTried = false
              defaultAgent.localTurns?.stop()
              defaultAgent.signals?.stop()
              outcomeStore.clear()
              publish({ ...state, state: 'signed_out', error: null })
            } catch {
              // Logout already finished. A status-only vault read must not
              // relabel it as pending or disable the next sign-in attempt.
              publish({ ...state, state: 'signed_out', error: 'matrix_vault_unavailable' })
            }

            break
          }

          case 'retry':
            await stopSdk()
            agentCleanupRequired = account.hasOrphanedEnrollments()
            await startSdk()

            // Nothing saved here to reconnect (the account is gone, or was never readable
            // after all): Try again ends on the sign-in screen, not on the same error. An
            // unfinished sign-out keeps its own state.
            if (!account.identity() && !account.signOutPending()) {
              publish({ ...state, state: 'signed_out', identity: null, error: signedOutNotice() })

              break
            }

            setImmediate(() => {
              for (const each of allAgents()) {
                each.readiness?.start()
              }
            })

            break

          default:
            throw new Error('matrix_command_invalid')
        }
      } catch (error) {
        if (request.kind === 'repairOwnerDevice') { throw matrixOwnerRepairError(error) }

        if (request.kind === 'signIn' && !account.identity()) {
          desktopServices?.capture({
            name: 'matrix_signin_finished',
            properties: {
              outcome: error instanceof Error && error.message === 'matrix_login_cancelled' ? 'cancelled' : 'failed'
            }
          })
        }

        if (request.kind === 'signOut') {
          // Vault read/write can fail before closeDevice is reached. Local SDK
          // access still closes; never let its next snapshot undo pending logout.
          await stopSdk()
          await forgetAgents()
        }

        if (error instanceof Error && error.message === 'matrix_login_cancelled') {
          publish({ ...state, state: 'signed_out', error: signedOutNotice() })

          // An explicit cancellation is a completed UI operation, not a generic
          // rejected IPC call that the renderer would turn back into an error.
          return
        } else if (error instanceof Error && error.message === 'matrix_account_mismatch') {
          // Another person's account over this Mac's ended session: nothing changed, and the
          // window says so, with signing out (confirmed) as the way to switch accounts.
          publish({ ...state, state: 'signed_out', identity: null, error: 'matrix_account_mismatch' })

          return
        } else if (error instanceof Error && error.message === 'matrix_password_unavailable') {
          // The server has no email sign-in yet: one plain sentence in the window, no
          // browser opened, and nothing failed.
          emailSignIn.learn('unavailable')
          publish({ ...state, state: 'signed_out', error: 'matrix_password_unavailable' })

          return
        } else if (error instanceof Error && error.message === 'matrix_login_timed_out') {
          publish({ ...state, state: 'signed_out', error: 'matrix_login_timed_out' })
        } else {
          publish({
            ...state,
            state: 'error',
            error: request.kind === 'signOut' ? 'matrix_sign_out_pending' : 'matrix_connection_failed'
          })
        }

        throw new Error('matrix_operation_failed')
      } finally {
        operation = false
        sessionChecks.released()
        desktopServices?.refreshBusy()
      }
    }, {
      // An app's chat that fails anywhere in main leaves its line in main.log, even before
      // `startAppChat` is reached (app-bots/open-chat.ts).
      slug: appId => matrixApps?.snapshot().apps.find(app => app.app_id === appId)?.app,
      log: line => console.warn(line)
    }), line => console.warn(line))
  )
  // A saved account is never shown signed out, not even for the first frame: the window's
  // first snapshot already carries it (connecting), so it opens on the launch in the product
  // window. The compact sign-in window is only for a Mac with no account (window-mode.ts).
  // startSdk publishes the same account a moment later.
  const savedIdentity = matrixSavedIdentity(account)

  if (savedIdentity) {
    state = { ...state, state: 'connecting', identity: savedIdentity }
  } else if (matrixEndedSession(account)) {
    // A session the sign-in server ended opens straight on the compact sign-in, saying so.
    state = matrixSessionEndedSnapshot(state)
  }

  await ui.loadURL(UI_URL)
  // Shown once the renderer has drawn that first screen and asked for its size (compact for
  // signing in, the product window otherwise), so no other screen or size flashes first.
  await windowChoice.wait(1_500)

  // Back from Restart to update: open exactly where the old window was (the chat itself is
  // already remembered per device, room-navigation.ts).
  if (previousRestart?.bounds && !productWindow.isAuthMode()) {
    ui.setBounds(restoredUpdateBounds(previousRestart.bounds, screen.getDisplayMatching(previousRestart.bounds).workArea))
  }

  if (deviceLaunch !== 'login_hidden') {
    ui.show()
    // The restart progress window closes the moment this one is up.
    updateHandoff?.shown()
  }

  // Healthy start-up, with or without a window: a hidden login launch after an install on Quit never shows one,
  // and would otherwise be rolled back at the next launch with its rollback copy kept for ever (re-review F3).
  if (app.isPackaged && process.platform === 'darwin') {
    confirmHealthyStart({
      hidden: deviceLaunch === 'login_hidden',
      home: app.getPath('home'),
      id: STAGED_APP_ID,
      bundle: path.resolve(process.resourcesPath, '..', '..'),
      handoffDirectory: path.join(app.getPath('userData'), 'update-handoff'),
      log: line => console.warn(line)
    })
  }

  // Time from the process's start to a visible window: the part of a cold start before the
  // readiness gate's own steps, where a Keychain prompt waits (G1-13, G1-30).
  console.warn(
    `[Matrix] launch ${deviceLaunch === 'login_hidden' ? 'hidden' : 'window'} ms=${Math.round(process.uptime() * 1000)}`
  )

  try {
    agentCleanupRequired = account.hasOrphanedEnrollments()
    publish(state)

    if (account.signOutPending()) {
      publish({ ...state, state: 'error', error: 'matrix_sign_out_pending' })
    } else if (account.sessionEnded()) {
      // Ended at the sign-in server: no chat engine to start until the person signs in again.
      console.warn('[Matrix] launch: the chat session saved here was ended; asking to sign in again')
      publish(matrixSessionEndedSnapshot(state))
    } else {
      if (config.domain && account.identity()) {
        startupState = { step: 'assistant', state: 'working' }
      }

      await startSdk()

      if (!unusedRoot()) {
        defaultAgent.readiness?.start()
      }

      void reconcileOrphanedEnrollments()
    }
  } catch {
    startupState = undefined
    publish({ ...state, state: 'error', error: 'matrix_vault_unavailable' })
  }
}

// Recovery runs before the normal single-instance lock: a failed replacement may still be alive, and it works
// whichever copy launched (the new version, the signed backup, or the staged copy in Caches).
const stagedRecovery = app.isPackaged && process.platform === 'darwin'
  ? await recoverAtStartup({
      home: app.getPath('home'),
      id: STAGED_APP_ID,
      bundle: path.resolve(process.resourcesPath, '..', '..'),
      handoffDirectory: path.join(app.getPath('userData'), 'update-handoff'),
      exit: () => app.exit(0),
      log: line => console.warn(line)
    })
  : 'continue'

// A filesystem/permission failure must not make the complete signed backup unusable. Keep its ordinary UI
// available, but never let Squirrel target this backup path.
stagedRecoveryFailed = stagedRecovery === 'failed'

if (stagedRecovery === 'exiting') {
  // Recovery took over and called app.exit(0): take no instance lock and start nothing, so a copy in Caches
  // can never win the lock and run from there (re-review F5).
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Liveness signal for the update launcher: this process owns the instance lock, so a slow start is not a dead one.
  if (app.isPackaged && process.platform === 'darwin') {markStarted(path.join(app.getPath('userData'), 'update-handoff'), process.pid)}

  app.on('second-instance', (_event, argv) => {
    const link = matrixMessageLinkArg(argv)
    if (link) {deliverMatrixMessageLink(link)}
    const invite = argv.find(value => isMatrixInviteDeepLinkCandidate(value))
    if (invite) {deliverMatrixInviteLink(invite)}

    ui?.show()
    ui?.focus()
  })
  app.on('activate', () => {
    ui?.show()
    ui?.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
  // Known the moment a quit is asked for, before the quit handler's asynchronous shutdown
  // sets `closing`: a launch the person or macOS ends is not a failure (startup-end.ts).
  const quitRequested = trackMatrixQuit(app)
  app.on('before-quit', () => workspaceStartup?.stop())
  app.on(
    'before-quit',
    createMatrixQuitHandler(
      async () => {
        // Presence is network best effort; it must not gate local credential saves.
        void ownPresence.offline().catch(() => {})

        // Main owns Hermes, not either renderer. Refuse new work and let each already-admitted
        // room turn finish under its exact yielding term before ordinary quit teardown stops SDKs
        // or processes. A rejected turn is contained by the drain helper and its normal settlement.
        const drainStarted = performance.now()
        const drained = await drainMatrixRuntimes(allAgents(), {
          holdOperations: true,
          reason: 'cancelled',
          timeoutMs: MATRIX_RUNTIME_DRAIN_TIMEOUT_MS
        })

        console.warn(`[updates] restart phase=drain ms=${Math.round(performance.now() - drainStarted)}`)
        if (drained.timedOut) {
          console.warn('[Matrix] quit drain timed out; checkpointing admitted turns before teardown')
        }

        // Drive first: once `closing` is set its owner reads as signed out, and a quit must not
        // withdraw Drive's sign-in the way a sign-out does (drive.ts dispose).
        const timedStop = async (phase: string, stop: () => unknown) => {
          const started = performance.now()
          try {return await stop()} finally {console.warn(`[updates] restart phase=${phase} ms=${Math.round(performance.now() - started)}`)}
        }
        const driveStop = timedStop('drive', () => drive?.dispose())
        closing = true
        ownPresence.stop()
        backgroundSweeps?.stop()
        agentHome?.service.stop()
        companyChannelConfirmations.stop()
        companyConversationConfirmations.stop()
        petOverlays?.dispose()
        driveImport?.dispose()
        brainActive = false
        // WS-4: fence the device service synchronously on quit too, so no device command outlives the app.
        matrixDeviceStopFence?.('local_stop')
        deviceIdentity?.signOut('sign_out')
        executionDeviceNames.invalidate()
        const deviceStop = timedStop('device', () => deviceBootstrap?.dispose())
        // Do not defer process withdrawal behind network-dependent lease release.
        const brainStop = localBrain?.stop()
        void brainStop?.catch(() => console.warn('[Matrix] local_brain_cleanup_failed'))
        atumKeepAwake.stop()
        hermesPages?.dispose()
        const clearNativeApps = nativeApps?.clear()

        for (const each of allAgents()) {
          each.continuous?.dispose()
          each.readiness?.stop()
        }

        // Every agent's lease is released, so another Mac takes over at once.
        const release = timedStop('lease', () => Promise.all(allAgents().map(each => each.lease?.stop())))

        // Credential/SDK shutdown starts beside lease release, never behind it.
        try {
          await Promise.allSettled([
            release, clearNativeApps, brainStop, driveStop, deviceStop,
            timedStop('sdk', () => account ? account.close(stopSdk) : stopSdk()),
            matrixConsumerBrowser.releaseConsumerPartitions()
          ])
        } finally {
          matrixConsumerBrowser.dispose()
        }
      },
      () => app.quit(),
      success => matrixAfterClose(desktopServices, success, documentCloseFailed),
      {
        prepare: async () => {
          documentCloseFailed = false

          try {await prepareDocumentClose()} catch (error) {documentCloseFailed = true; throw error}
        },
        // No new work is admitted after the document checkpoint. Window-close
        // handlers must allow native quitAndInstall to close every SDK window.
        forceExit: () => app.exit(0),
        log: line => console.warn(line),
        forceCleanup: () => {
          closing = true
          localBrain?.killNow()
          ownedBackgroundChildren.killNow()
        }
      }
    )
  )
  // The local brain runs this app's own executable in its own process group; whatever
  // teardown managed, none may outlive the main process (an installer counts copies).
  installMatrixExitBarrier({ app, process, kill: () => {localBrain?.killNow(); ownedBackgroundChildren.killNow()}, log: line => console.warn(line) })
  void app
    .whenReady()
    .then(start)
    .catch(error =>
      endMatrixStartup(error, {
        quitRequested: () => quitRequested() || closing,
        windowClosed: () => ui?.isDestroyed() ?? false,
        describe: setupFailureDetail,
        report: failure => {
          const value = failure as { name?: unknown; stack?: unknown } | undefined

          desktopServices?.error({
            operation: 'main',
            // Reporting keeps only the standard error names; anything else is 'Error'.
            kind: typeof value?.name === 'string' ? value.name : 'Error',
            stack: typeof value?.stack === 'string' ? value.stack : undefined
          })
        },
        log: line => console.warn(line),
        alert: () =>
          dialog.showErrorBox(
            'Atum',
            'Atum chưa khởi động được. Dữ liệu của bạn không bị thay đổi. Hãy mở lại Atum.\n\n' +
              'Atum couldn’t start. Your data wasn’t changed. Open Atum again.'
          ),
        quit: () => app.quit()
      })
    )
}
