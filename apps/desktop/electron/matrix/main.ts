import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
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
  taskFilesConversationStatus
} from '../../shared/agent-conversation'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { ConversationCandidateRead } from '../../shared/agent-conversation/view'
import type {
  AgentProfileDetail,
  AgentProfileRequest,
  AgentProfileResult
} from '../../shared/agent-profile-management'
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
  type MatrixAgentServiceStatus,
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
  type MatrixIdentity,
  type MatrixMessage,
  type MatrixNewSignIn,
  type MatrixOwnerReaderStatus,
  type MatrixSdkCommand,
  type MatrixSnapshot
} from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import type { MatrixHostAgentControl } from '../../shared/matrix-agent-desk'
import { appBotTurnRefusal } from '../../shared/matrix-app-bot-failure'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import { matrixApprovalCopy } from '../../shared/matrix-approval-copy'
import { checkAssistantName } from '../../shared/matrix-assistant-name'
import { usableAgentRoom } from '../../shared/matrix-assistant-room'
import { isTeamSpaceRoom, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import type { MatrixCompanyFileRef, MatrixCompanyFileRefV2 } from '../../shared/matrix-company-files'
import { isTrustedPayOSUrl } from '../../shared/matrix-company-funding'
import type { CompanyConversationDirectory15Response } from '../../shared/matrix-company-team-space'
import { MATRIX_DESKTOP_SERVICES } from '../../shared/matrix-desktop-services'
import type { MatrixDeviceIsolation } from '../../shared/matrix-device-isolation'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'
import { MATRIX_DRIVE_IPC } from '../../shared/matrix-drive'
import { MATRIX_DRIVE_IMPORT_LABELS } from '../../shared/matrix-drive-import-copy'
import { MATRIX_GOOGLE_CONNECTION_IPC, MATRIX_GOOGLE_WRITE_IPC } from '../../shared/matrix-google-connections'
import { formatMatrixHandleDiagnostic } from '../../shared/matrix-handle-diagnostic'
import {
  isMatrixInviteDeepLinkCandidate,
  MATRIX_INVITE_LINK_IPC
} from '../../shared/matrix-invite-link'
import { MATRIX_KEEP_AWAKE } from '../../shared/matrix-keep-awake'
import { matrixManagementConfirmationCopy } from '../../shared/matrix-management-copy'
import {
  isMatrixMessageLinkCandidate,
  MATRIX_MESSAGE_LINK_IPC,
  type MatrixMessageLinkTarget
} from '../../shared/matrix-message-link'
import {
  MATRIX_DEFAULT_MODEL
} from '../../shared/matrix-models'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import { MATRIX_NATIVE_MAC_IPC } from '../../shared/matrix-native-mac'
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
import { type MatrixProfileMetadata, matrixProfileMxc, matrixProfilePhoto } from '../../shared/matrix-profile'
import type {
  MatrixProviderOAuthResult,
  MatrixProviderOAuthSession,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'
import type {
  MatrixOwnDevices,
  MatrixOwnerRestore,
  MatrixOwnerStatus,
  MatrixRecoveryCheck,
  MatrixSecurity
} from '../../shared/matrix-security'
import { MATRIX_CHATGPT_SIGN_IN_URL } from '../../shared/matrix-subscriptions'
import { MATRIX_WINDOW_CHANNELS } from '../../shared/matrix-window'
import { formatMatrixWindowFailureDiagnostic } from '../../shared/matrix-window-failure'
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
import { reportBackendExit, reportChildProcessGone } from '../process-exit-reports'
import { createUpdateHandoff, restoredUpdateBounds, type UpdateHandoff, type UpdateHandoffResult } from '../update-handoff'
import { saveUserSelectedFile } from '../user-selected-file-save'
import { createWordMacAdapter } from '../word-companion-mac'
import { createWordLiveMacAdapter } from '../word-live-mac'
import { fetchConnectAssertion } from '../work/sidecar/connect-assertion'

import { MatrixAccount } from './account'
import { matrixAccountLogLine } from './account-events'
import {
  disconnectMatrixSubscriptionChatGpt,
  finishMatrixSubscriptionChatGptPoll,
  matrixSubscriptionAccountAvailable,
  MatrixSubscriptionFollowUpRepair,
  matrixSubscriptionHostExecutor,
  matrixSubscriptionHostHome
} from './account-subscription-flow'
import {
  matrixSubscriptionKeyStore,
  type MatrixSubscriptionKeyStore,
  matrixSubscriptionsStatus
} from './account-subscriptions'
import { MatrixAgentActionsLog } from './agent-actions-log'
import { MatrixAgentAvatarProjection } from './agent-avatar'
import {
  MatrixAgentDefinitionError,
  type MatrixAgentDefinitionRecord,
  type MatrixAgentDefinitionSnapshot
} from './agent-definition'
import {
  MatrixAgentCreationRefused,
  MatrixAgentLifecycle,
  type MatrixCreatedAgent
} from './agent-lifecycle'
import { MatrixAgentRoutines, registerMatrixAgentRoutinesIpc } from './agent-routines'
import {
  matrixAgentHomeRoom,
  matrixDefaultAgent,
  matrixDefaultRuntime,
  matrixRetiredRootCustody,
  matrixRetirementTarget,
  matrixRoomAgent,
  matrixRootEnrollmentPrincipal,
  matrixRosterChanges
} from './agent-routing'
import {
  MatrixAgentRuntime,
  matrixAgentScope
} from './agent-runtime'
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
import { createAppConversation } from './app-conversation'
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
import {
  assistantCommand,
  assistantInviteCoexistences,
  projectAssistantRooms
} from './assistant-policy'
import { MatrixBackgroundVerifications, MatrixLaunchSummary } from './background-verification'
import { appBotPhotoForRenderer } from './bot-api-media'
import { createBrowserImport } from './browser-import/compose'
import { registerBrowserImportIpc } from './browser-import/ipc'
import { carryCustody, ChatGptCarry, requestChatGptCarry } from './chatgpt-carry'
import {
  FileChatGptTrainingRevokeJournal,
  MatrixChatGptTrainingConfirmation,
  requestMatrixChatGptTraining
} from './chatgpt-training-confirmation'
import { FileCheckoutJournal, MatrixCheckoutController } from './checkout'
import { registerMatrixClipboard } from './clipboard'
import {
  matrixCloudManagedSelection,
  MatrixCloudModelChoices,
  requestMatrixCloudModelChoice
} from './cloud-model-choice'
import { MatrixModelDestinations, requestMatrixModelDestinations, writeMatrixCloudAtumChoice } from './cloud-model-destinations'
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
import { matrixConfigurationKey } from './config'
import { conversationRemovalAllowed } from './conversation/removal'
import type {
  MatrixCredentialRenewal} from './credential-renewal';
import { matrixAfterClose, MatrixDesktopServices } from './desktop-services'
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
import {
  acceptCloudTrial,
  CloudAccessLog,
  CloudAgentEnrollment,
  type CloudTrialOffer,
  deviceEnrollmentCode,
  type DeviceOwnerRefusal,
  hasEnrolledCloudMac,
  macComputerName,
  MacDeviceIdentity,
  parseAgentServiceStatus,
  parseCloudAccess,
  parseCloudTrial,
  requestS1,
  resolveDeviceOwner,
  type S1Resource,
  s1Route,
  sameCloudTrial,
  shownCloudTrial,
  workspaceLabelFor
} from './device/cloud-agent'
import { deviceHubUrl } from './device/connection'
import { type DeviceEnrollmentOwner, DeviceRegistryError } from './device/enrollment'
import { requestHostAgentControl } from './device/host-agent-control'
import { requestHostDesk } from './device/host-desk'
import { resolveDisclaimLauncher } from './device/launcher'
import { confirmNativeCommand } from './device/native-command-confirm'
import { NativeMacSsh, REMOTE_LOGIN_SETTINGS } from './device/native-ssh'
import { createNativeSshSystem } from './device/native-ssh-system'
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
import { installMatrixExitBarrier } from './exit-barrier'
import { MatrixFirstRunWelcome } from './first-run-welcome'
import { folderAccessPolicyFile, MatrixFolderAccess, registerMatrixFolderAccessIpc } from './folder-access'
import {
  createMatrixFounderChat,
  FOUNDER_CHAT_COMMAND_MS,
  handleMatrixFounderContact,
  matrixFounderView
} from './founder-chat'
import { probeFullDiskAccess } from './full-disk-access'
import { createMatrixGoogleConnectionIpcHandler, createMatrixGoogleWriteIpcHandler, matrixGoogleWriteProposals, publishMatrixGoogleFence, requestMatrixGoogleAccountConnect, requestMatrixGoogleAccountStatus } from './google-connection-boundary'
import { type MatrixGoogleConnectionOwner, MatrixGoogleConnections } from './google-connections'
import { matrixGoogleWriteCopy } from './google-write-copy'
import { migrateMatrixCodexAccounts } from './hermes-codex-migration'
import {
  clearMatrixAccountChatGpt,
  clearMatrixHermesCredentials,
  forgetMatrixAccountCodex,
  MATRIX_ATUM_FOLDER,
  type MatrixHermesConnection,
  matrixHermesHome,
  type MatrixHermesRuntimeConfig,
  openMatrixHermes,
  withMatrixHermes
} from './hermes-utilities'
import { MatrixICloudKeychain, matrixKeychainHelper } from './icloud-keychain'
import { MatrixInviteLinkBroker } from './invite-link-broker'
import {
  matrixAppViewCommandAllowed,
  matrixOpenLink,
  matrixPdfBelowTitlebar,
  parseMatrixCommand,
  parseMatrixNewSignInDismiss,
  parseMatrixSignInMethod,
  requireMatrixCaller
} from './ipc-policy'
import {
  MATRIX_BUNDLED_CONFIG_NAME,
  matrixLaunchConfigurationErrorCopy,
  readMatrixLaunchConfig
} from './launch-config'
import { fileLoginStartupMemory, MatrixLoginStartup, registerMatrixLoginStartupIpc } from './login-startup'
import { LookAssetDiskCache, MatrixLookAssets } from './look-asset'
import { MatrixManagedModel } from './loopback-model-proxy'
import { handleMatrixAliasPending, handleMatrixAliasRequest } from './main-aliases'
import {
  handleMatrixCompanyCommand,
  handleMatrixCompanyNativeCommand,
  handleMatrixCompanyPending
} from './main-company'
import { handleMatrixCompanyDesktop } from './main-company-desktop'
import { handleMatrixCompanySearch, handleMatrixCompanySearchOpen } from './main-company-search'
import {
  readMatrixAgentPresentation
} from './main-enrollment'
import { dispatchMatrixStop } from './main-host-stop'
import { registerMatrixLinkPreviewIpc } from './main-link-previews'
import { mirrorTaggedConsole } from './main-log'
import { handleMatrixPeoplePrivacy, handleMatrixPeopleSearch } from './main-people-search'
import {
  matrixMainProfileHost,
  matrixMemberAvatarRoom,
  registerMatrixMemberAvatarIpc,
  registerMatrixProfilesIpc
} from './main-profiles'
import { createMatrixWork, MATRIX_WORK_MODEL_ROLE, type MatrixWork } from './main-work'
import { MatrixMessageLinkBroker } from './message-link-broker'
import { registerMatrixNativeApps } from './native-apps'
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
import { FileOwnerConsentRevokeJournal } from './owner-consent'
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
import { matrixMayAskOtherDevices, type MatrixOwnerUnlock, unlockMatrixOwner } from './owner-unlock'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixPagesProvidersScope } from './pages-providers'
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
import { MatrixPetDisplay } from './pet-overlay-preferences'
import { MatrixPetOverlayService } from './pet-overlay-service'
import { MatrixPets } from './pets'
import { readMatrixPlanAcknowledgment, saveMatrixPlanAcknowledgment } from './plan-acknowledgment'
import { createMatrixPresenceLifecycle } from './presence-lifecycle'
import { MatrixProfiles } from './profile'
import { publishMatrixProfileImport, readMatrixProfileImport } from './profile-import'
import {
  MatrixProviderConnections,
  matrixSubscriptionsWithProviderConnections,
  requestMatrixProviderConnections
} from './provider-connections'
import { MATRIX_PROVIDER_MODEL_ID_PATTERN } from './provider-connections'
import { createMatrixQuitHandler } from './quit'
import {
  type MatrixReadinessCheck
} from './readiness'
import { fetchMatrixReporting } from './reporting-transport'
import { MatrixRetiredAgentRooms } from './retired-agent-rooms'
import { MatrixRosterRecovery, type MatrixRosterScope, refreshMatrixRosterOnWake } from './roster-recovery'
import { matrixRuntimeFailureCode, selectMatrixHermesRuntime } from './runtime-selection'
import {
  appHostDisposition,
  boundSdkConfiguration,
  matrixHostApp,
  type MatrixHostRole,
  matrixHumanSdkReady,
  MatrixSdkHost,
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
import { matrixStarterNotice, requireMatrixStarterAcknowledgement } from './starter-notice'
import { endMatrixStartup, trackMatrixQuit } from './startup-end'
import { FileStoreJournal, matrixScopedHireTargetLive, MatrixStoreController } from './store'
import { MatrixSubscriptionAuthLifecycle } from './subscription-auth-lifecycle'
import { MatrixTerminals } from './terminals'
import { MatrixTextDocument } from './text-document'
import { MatrixHermesTurnLock } from './turn-lock'
import { MatrixUndecryptableLog } from './undecryptable-log'
import { MatrixUnverifiedDevices } from './unverified-devices'
import { MatrixVideoGenerationConsent, requestMatrixVideoConsent } from './video-generation-consent'
import { MatrixWalletController, matrixWalletCursor } from './wallet'
import { installMatrixWindow, matrixWindowOptions } from './window'
import { matrixEndedSession, matrixHumanSnapshot, matrixSavedIdentity, matrixWindowChoice } from './window-launch'
import { MatrixWindowedLog } from './windowed-log'
import { MatrixWordDocument } from './word-document'
import { MatrixWebPreviewOffers } from './workbench-preview'
import { readMatrixWorkspaceDriveRoots } from './workspace-root-facts'

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
        void nativeMacSsh?.start()

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

      // Trust existing ready agents; never provision/re-enroll one as part of repair.

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

let appViews: AppViewController
let nativeApps: NativeAppsController | undefined
let desktopServices: MatrixDesktopServices | undefined
/** Restart-to-update continuity: the progress window, the saved place, and what the last Restart left. */
let stagedRecoveryFailed = false
let updateHandoff: UpdateHandoff | null = null
let previousRestart: UpdateHandoffResult | null = null
let matrixApps: ReturnType<typeof createMatrixApps> | undefined
/** Self-work slice A: the Work page, its server and the assistants' route, for the signed-in account (main-work.ts). */
let work: MatrixWork | undefined
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
let nativeMacSsh: NativeMacSsh | undefined
let deviceBootstrap: DeviceServiceBootstrap | undefined
let deviceNativeUi: ReturnType<typeof createDeviceNativeUi> | undefined
let deviceWorkspace: DriveWorkspaceCopies | undefined
let deviceLaunch: DeviceLaunch = 'interactive'
let cloudEnrollments: CloudAgentEnrollment | undefined
let cloudModelChoices: MatrixCloudModelChoices | undefined
let providerConnections: MatrixProviderConnections | undefined
let chatGptCarry: ChatGptCarry | undefined
let chatGptTraining: MatrixChatGptTrainingConfirmation | undefined
let videoConsent: MatrixVideoGenerationConsent | undefined
let modelDestinations: MatrixModelDestinations | undefined
/** The agents the roster says answer in the cloud, by principal (atum.cloud-answering/1). */
const cloudAgents = new Set<string>()
const hostRuntimeAgents = new Set<string>()
/** This Mac's Matrix device fingerprints (a device's never changes). */
const deviceFingerprints = new Map<string, string>()

function cloudPrincipal(agentRuntime: MatrixAgentRuntime | undefined): string | undefined {
  return agentRuntime?.agentPrincipal ?? agentRuntime?.principal
}

function isCloudAgent(agent: MatrixAgentRuntime | undefined): boolean {
  return Boolean(agent && !agent.closed && cloudPrincipal(agent) && agent.userId)
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
    hubRequired: controllerHubRequired,
    call: async (resource, signal) => {
      const localDevice = deviceIdentity?.enrollment()?.deviceServiceId
      const result = await s1Call(resource, signal)

      if (resource.kind === 'device-revoke' && resource.deviceServiceId === localDevice) {
        await work?.revokeT3Mcp(localDevice)
      }

      return result
    },
    onRevoked: deviceServiceId => { void work?.revokeT3Mcp(deviceServiceId) },
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
                closed: each.closed
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

function applyAnswering(roster: MatrixAgentDefinitionRecord[]): void {
  cloudAgents.clear()
  hostRuntimeAgents.clear()

  for (const agent of roster) {
    if (agent.status !== 'active') {continue}
    cloudAgents.add(agent.principal)

    if (agent.runtime === 'hermes') {hostRuntimeAgents.add(agent.principal)}
  }

  if (cloudAgents.size) {
    void deviceIdentity?.activate().catch(() => console.warn('[Device] device service not started'))
  }
}

let trialShown: { owner: string; offer: CloudTrialOffer } | undefined
/** The last access fact logged per account, so the line appears when the fact changes. */
const lastCloudAccess = new CloudAccessLog()

async function cloudAgentRequest(request: {
  action?: unknown
  principal?: unknown
  roomId?: unknown
  eventId?: unknown
  schedule?: unknown
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

  if ((request.action === 'stopTurn' || request.action === 'stopSchedule') && typeof request.roomId === 'string') {
    const { roomId } = request
    const scope = account.appScope()
    const agent = requireRoomAgent(roomId)
    const principal = cloudPrincipal(agent)

    const outcome = await dispatchMatrixStop({
      principal, cloud: isCloudAgent(agent), host: Boolean(principal && hostRuntimeAgents.has(principal)),
      ready: Boolean(scope && config.domain),
      request: request.action === 'stopSchedule'
        ? { action: 'stopSchedule', roomId, schedule: request.schedule }
        : { action: 'stopTurn', roomId, eventId: request.eventId }
    }, {
      s1Request: account.s1Request.bind(account), s1Call,
      fetcher: (url, init) => session.defaultSession.fetch(url, init)
    })

    const current = account.appScope()

    if (closing || !scope || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_not_ready')
    }

    return outcome
  }

  throw new Error('matrix_command_invalid')
}

function petScopeToken() {
  const scope = account?.appScope()

  return scope ? `${scope.accountKey}:${scope.generation}` : undefined
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
    identity: (agent: MatrixAgentRuntime) => {
      const principal = currentRosterOwner()

      return principal && agent.assistantId ? { principal, executorId: `pet:${agent.assistantId}` } : null
    }
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
        home: matrixHermesHome(targetInfo.selectedRuntime, targetInfo.identity.principal, targetInfo.identity.executorId)
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
let rosterOwner: { accountKey: string; generation: number; principal: string } | undefined

function currentRosterOwner() {
  const scope = account.appScope()

  return scope && rosterOwner?.accountKey === scope.accountKey && rosterOwner.generation === scope.generation
    ? rosterOwner.principal
    : undefined
}

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

const agents = new Map<string, MatrixAgentRuntime>()

const agentAvatars = new MatrixAgentAvatarProjection<MatrixAgentRuntime>({
  allowLocal: !app.isPackaged,
  changed: () => publish(state)
})

function allAgents(): MatrixAgentRuntime[] {
  return [defaultAgent, ...agents.values()]
}

/** The agent runtime an SDK host role belongs to; none for the human and app hosts. */

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

/** A subscription changed: idle assistants restart so their next turn sees it. A running turn is
 * never interrupted for a new connection; an explicit Disconnect forces every assistant down, so
 * the credential and its models are gone at once. */

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
    refresh: async () => {
      agentRoster.request()
      await syncAgents()
    },
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
function holdOperation(agent: MatrixAgentRuntime, held: boolean): void {
  agent.operation = held
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
    (verification && verification !== 'done' && verification !== 'cancelled')
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

let managedModel: MatrixManagedModel | undefined
let agentRosterReadiness: MatrixSnapshot['agentRoster']

function setAgentRosterReadiness(next: NonNullable<MatrixSnapshot['agentRoster']>['state']): void {
  if (agentRosterReadiness?.state !== next) {
    agentRosterReadiness = { state: next, since: Date.now() }
  }
}

// The human host has been ready once (from its cache or initial sync) since it started.
let humanPrepared = false
// The next gate may open the browser once for the domain grant (right after sign-in).

let operation = false
let domainOperation = false
/** The official bots whose chat is being opened (`appChat`), each with the human host it was asked of.
 * An open ends by waiting for its room to sync, up to a quarter of a minute (app-bot-room-wait.ts), so
 * it is not an account operation: nothing else waits for it, and the person can switch chats, send, or
 * sign out meanwhile (the SDK drops a stale selection, and its stop ends the wait). One open per app at
 * a time; an entry for a host that has since been replaced does not hold the app. */
const openingAppChats = new Map<string, Host>()
// The messages being run in place right now (invokeHermes): one run per message at a time.
let closing = false
// The stamped build (a commit), or 'development'; set once at start.
let buildRevision = 'development'
let agentCleanupRequired = false
/** Set once this launch, or this sign-in, has tried to finish an old sign-out's revocations. */
let orphanedEnrollmentsTried = false
let state: MatrixSnapshot = { state: 'signed_out', identity: null, rooms: [], roomId: null, messages: [], error: null }
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
interface MatrixKeepAwakePreference { on: boolean; noticeShown: boolean }

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

    return keepAwakePreference.on
  })

  // FC D3: a power change moves this Mac in or out of every cloud agent's failover chain at once.
  powerMonitor.on('on-battery', () => {
    atumKeepAwake.setOnBattery(true)

  })
  powerMonitor.on('on-ac', () => {
    atumKeepAwake.setOnBattery(false)

  })
}

/** armHermesWatch's failure line (0.20.1): a refusal retries for as long as the lease is held. */
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

  wallet?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  checkout?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  companyStore?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  store?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  officialAccounts?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)

  // Work binds to the account once the window is ready; it is torn down by sign-out, never by a transient state.
  if (!closing && next.state === 'ready' && next.identity) {void work?.activate()}
  // Company-channel confirmations belong to one signed-in session: a new session (or quit) voids them.
  companyChannelConfirmations.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  companyConversationConfirmations.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)

  if (!closing && next.state === 'ready' && next.identity && pendingMatrixDrafts) {
    void pendingMatrixDrafts.drain(next.identity, draft => dispatchSdkCommand(draft)).catch(() => {})
  }

  cloudModelChoices?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  providerConnections?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  chatGptTraining?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)
  videoConsent?.activate(!closing && next.identity ? (account?.appScope() ?? null) : null)

  if (!closing && next.state === 'ready' && next.identity) {void chatGptCarry?.sync()}
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
    cloudAgents.clear()
    founderChat?.reset()
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
    defaultAgent.identity = undefined
    defaultAgent.closed = false
    defaultAgent.agentPrincipal = undefined
    defaultAgent.matrixUser = undefined
  }

  const apps = next.identity ? appsSnapshot() : undefined
  const official = next.identity ? officialAccounts?.snapshot() : undefined

  if (!next.identity) {
    firstRunWelcome.reset()
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
    deviceAccessRepair: (controllerHubRequired() && deviceIdentity?.connection()?.needsRepair()) || undefined,
    deviceControlRequired: next.identity && deviceControlOwner?.userId === next.identity.userId &&
      deviceControlOwner?.deviceId === next.identity.deviceId ? true : undefined,
    newSignIn,
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
    rooms: projectedRooms,
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
    atumModel: Boolean(primary),
    ownModel: false,
    agentCleanupRequired,
    agents: agentList,
    agentRoster: next.identity ? agentRosterReadiness : undefined,
    agentCreation: next.identity ? agentCreation : undefined,
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
function cloudModelView(principal: string) {
  const base = cloudModelChoices?.view(principal)
  const choice = modelDestinations?.cloudChoice(principal)
  const connection = providerConnections?.view()?.connection
  const subscription = choice?.source === 'opencode_go' || choice?.source === 'chatgpt_plan' ? choice : undefined

  // No Mac serves a ChatGPT plan to a cloud assistant any more (the SSH relay is gone, self-work plan §12): a plan choice has no
  // connection to read here, and the picker greys it (D6). A plan on this Mac is used through Work, never by the relay.
  const subscriptionState = subscription
    ? subscription.source === 'chatgpt_plan'
      ? ('unavailable' as const)
      : connection?.state === 'connected' ? ('connected' as const) : connection ? ('revoked' as const) : ('unavailable' as const)
    : connection?.state === 'connected'
      ? ('connected' as const)
      : connection
        ? ('disconnected' as const)
        : ('unavailable' as const)

  const models = subscription?.source === 'chatgpt_plan' ? [] : connection?.state === 'connected' ? connection.models : []

  if (!base && !subscription) {
    return undefined
  }

  return {
    offered: base?.offered ?? [],
    ...(base?.current ? { current: base.current } : {}),
    ...(base?.effort ? { effort: base.effort } : {}),
    ...(base?.models ? { models: base.models } : {}),
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
  return allAgents().flatMap(agent => {
    const principal = cloudPrincipal(agent)
    const userId = agent.userId

    if (!principal || !userId || agent.closed) {return []}

    const cloudModel = cloudModelView(principal)

    return [{
      principal,
      userId,
      ...(agent.assistantId ? { assistantId: agent.assistantId } : {}),
      avatarUrl: agent.avatarUrl,
      ...(agent.name ? { name: agent.name } : {}),
      ...(agent.title ? { title: agent.title } : {}),
      ...(agent.mark ? { mark: agent.mark } : {}),
      ...(agent.hire ? { hire: agent.hire } : {}),
      isDefault: agent === productAgent(),
      ready: true,
      hermes: 'unavailable',
      answering: 'cloud',
      atumModel: true,
      ownModel: false,
      ...(hostRuntimeAgents.has(principal) ? { runtime: 'hermes' as const } : {}),
      ...(cloudModel ? { cloudModel } : {})
    }]
  })
}

function dispatchSdkCommand(value: unknown, timeoutMs = matrixSdkCommandTimeout(value)) {
  const send = () =>
    hosts.get('human')?.queue.command(value, timeoutMs) ?? Promise.reject(new Error('matrix_sdk_unavailable'))

  return (value as { kind?: unknown })?.kind === 'send' ? observeMessage(send) : send()
}

function command(value: unknown, timeoutMs = matrixSdkCommandTimeout(value)) {
  return (value as { kind?: string })?.kind === 'draft' && pendingMatrixDrafts
    ? pendingMatrixDrafts.submit(
        value as Extract<MatrixCommand, { kind: 'draft' }>,
        draft => dispatchSdkCommand(draft, timeoutMs)
      )
    : dispatchSdkCommand(value, timeoutMs)
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

/**
 * The owner's assistants just invited to a group join it, each through its own host on this
 * Mac (an agent never joins a room by itself). Any that couldn't stay invited. The picker has
 * already shown the routing disclosure; after a successful join, record that fact in the
 * owner's room policy. Older groups without the marker disclose inside the room before routing.
 */

/**
 * An agent host's watch over its groups (src/matrix/group-turns.ts): from now on, the owner's
 * new messages there that name the agent or reply to it become hints. Armed each time the host
 * comes up; a message sent while it was away is not answered.
 */
async function stopHost(role: MatrixHostRole) {
  sdkRendererRecovery.cancel(role)

  if (role === 'human') {
    notifications.clear()
    await nativeApps?.clear()
    humanPrepared = false
    resetDeviceControlReadyChecks()
    documents?.reset()
    // Revoke views synchronously; storage cleanup gates future PDF placement,
    // never authentication or quit if Chromium's cache cleanup stalls.
    void clearPdfSession()
  }

  const target = hosts.get(role)

  if (!target) {return}
  clearTimeout(target.expiry)
  target.renewal?.stop()
  await target.queue.stop()

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
    publish(state)
  },
  exhausted: role => {
    void (async () => {
      console.warn(`[Matrix] ${role === 'human' ? 'chat' : 'agent'} engine restart exhausted`)
      await stopHost(role)

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

/** The sign-in ended: Work's route is cut, its stops settled and its server stopped. Bounded, and never throws. */
async function retireWork(deviceServiceId?: string) {
  if (!work) {
    return
  }

  await Promise.race([
    work.retire(deviceServiceId).catch(() => console.warn('[Matrix] work_retire_failed')),
    new Promise<void>(resolve => setTimeout(resolve, 60_000).unref())
  ])
}

async function stopSdk() {
  petOverlays?.clear()
  ownerReaderTrustPoller.stop()
  signedOwnerReaders.clear()
  profiles.stop()

  appLoadHost = undefined
  // Start every app stop before slower pane/SDK teardown can fail.
  const appStops = stopAppHosts()

  await stopSdkWithApps(
    async () => {await matrixApps?.reset()},
    () => stopHost('human'),
    () => appStops,
    () => console.warn('[matrix-apps] local_cleanup_failed')
  )
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
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)

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
  const enrollment = slug === undefined ? null : account.appEnrollment(slug)
  const source = role === 'human' ? account.identity() : enrollment?.state === 'ready' ? enrollment.identity : null

  if (!source) {
    return
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
    queue: sdkQueue
  }

  hosts.set(role, host)

  if (enrollment?.identity) {
    host.expire = () => {
      host.queue.close()

      if (hosts.get(role) === host) {
        hosts.delete(role)
      }

      publish(state)
    }

    armHostExpiry(host, enrollment.identity.expiresAt)

    // Each agent's host takes main's renewed token with its own handle (never an app's), and
    // its credential is renewed ahead of expiry from now on: before its page loads, so a token
    // refused at its first request can already wait for a renewal (expedite). Expiry stays
    // the backstop.

  }

  await lockWindow(target, SDK_URL, 'sdk')

  if (closing || hosts.get(role) !== host || target.isDestroyed()) {
    host.renewal?.stop()
    host.queue.close()

    return
  }

  target.webContents.on('render-process-gone', (_event, details) => {
    if (hosts.get(role) === host) {
      const restartable = role === 'human'

      if (restartable) {
        console.warn(
          `[Matrix] chat engine exited reason=${/^[a-z-]{1,32}$/.test(details.reason) ? details.reason : 'unexpected'}`
        )
      }

      clearTimeout(host.expiry)
      host.renewal?.stop()
      hosts.delete(role)
      host.queue.close()

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

/** An agent host's renewal schedule (credential-renewal.ts). */

/** One renewal of an agent host's executor credential (credential-renewal.ts). */

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

    agents.set(principal, agentRuntime)
  }

  return agentRuntime
}

/** Stops another agent's runtime on this Mac for good: its gate, lease, watch, turns,
function stopAgentRuntime(agent: MatrixAgentRuntime): void {
  agent.closed = true
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
    void syncAgents()
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

function forgetAgents(): void {
  // Not in the sign-out handler: main's tests run that callback alone, with only its own globals.
  hostRuntimeAgents.clear()
  productDefaultPrincipal = undefined
  rosterOwner = undefined
  agentCreation = false
  agentRosterReadiness = undefined
  agents.clear()
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

/** Placement is metadata from this authenticated account generation, never missing local custody. */
function controllerHubRequired(): boolean | undefined {
  const scope = account?.appScope()

  if (!scope || !hireRoster || hireRoster.scope.accountKey !== scope.accountKey ||
    hireRoster.scope.generation !== scope.generation) {return undefined}

  return hireRoster.roster.some(row => row.status === 'active' && row.runtime !== 'hermes')
}

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
      const ownerDomain = await account.readDomain(false)

      if (closing || !agentRoster.isCurrent(result, account.appScope())) {
        agentRoster.request()

        return readinessPass
      }

      rosterOwner = { ...result.scope, principal: ownerDomain.principal }

      // Its tombstones also retire the Store's reusable hire targets for those agents.
      hireRoster = { scope: result.scope, roster }
      store?.pruneHireTargets()
      // Its tombstones name the retired agents whose chats leave the chat list.
      retiredAgentRooms.roster(account.identity()?.userId, roster)
      deviceIdentity?.connection()?.start()
      applyAnswering(roster)
      const own = account.retainedAgentPrincipal()
      const primary = matrixDefaultAgent(roster)

      const rootPrincipal = matrixRootEnrollmentPrincipal(
        own, primary.principal, new Set([...agents.keys(), ...account.agentEnrollments()])
      )

      const mine = roster.find(agent => agent.principal === rootPrincipal)

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

      if (closing || !agentRoster.isCurrent(result, account.appScope())) {
        agentRoster.request()

        return readinessPass
      }

      if (mine && mine.status === 'active') {
        // Roster identity is display/routing metadata, never local executor authority.
        defaultAgent.agentPrincipal = mine.principal
        defaultAgent.matrixUser = mine.matrixUser
        defaultAgent.assistantId = mine.id
        defaultAgent.name = mine.displayName
        defaultAgent.title = mine.title
        defaultAgent.mark = mine.mark
        defaultAgent.hire = mine.hire
        agentAvatars.project(defaultAgent, mine.id, mine.avatarUrl)
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
        defaultPrincipal: rootPrincipal,
        known: [...agents.keys(), ...account.agentEnrollments()],
        keep: new Set([...lifecycle.creating(), ...retiring])
      })

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

        const agentRuntime = agentRuntimeFor(record.principal)
        agentRuntime.assistantId = record.id
        agentRuntime.name = record.displayName
        agentRuntime.title = record.title
        agentRuntime.mark = record.mark
        agentRuntime.hire = record.hire
        agentAvatars.project(agentRuntime, record.id, record.avatarUrl)
        agentRuntime.matrixUser = record.matrixUser
      }

      keepRosterFresh()

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
    placed: () => {agentRoster.request(); void syncAgents()},
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

/** This Mac's part of a retirement, safe to repeat. A named agent loses its runtime,
 * device, executor credentials and vault scope. A retired root instead loses only its
 * runtime, device and root executor credentials, keeping history and named-agent custody. */
async function forgetRetiredAgent(principal: string, rootCustody?: true) {
  const agentRuntime = rootCustody ? defaultAgent : agents.get(principal)
  let device = agentRuntime?.identity
  const matrixUser = agentRuntime?.userId

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

  if (agentRuntime) {
    agentRuntime.closed = true
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

      publish(target.kind === 'human' ? { ...state, ownProfile: metadata } : state)
    }
  }
})

/**
 * What other people see an assistant called (assistant-name-sync.ts): each assistant whose
 * Matrix session this Mac holds, its record's name against its session's. A primary whose
 * name is locked (owner decision D1) is left alone.
 */

/** The definition revision whose persona this Mac's copy of each assistant last reconciled. */
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
  saved: (agent, written) => {
    for (const each of allAgents()) {
      if (each.agentPrincipal !== agent.principal || each.closed) {
        continue
      }

      each.name = written.assistant.displayName

    }

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

  }

  agentRoster.request()
  publish(state)
  void syncAgents()
}

function macSourcesPolicyFileFor(accountKey: string): string {
  return path.join(app.getPath('userData'), 'source-policy', `${accountKey}.json`)
}

/** A launch always carries a fixed path; handlers fail closed if this refresh cannot land. */
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

function setupFailureDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error

  return text.replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, '<masked>').slice(0, 240)
}

/** The agent's own room with its owner: where its scheduled jobs post (D7, one room per
 * agent). The marked main wins; legacy rooms retain their stable lowest-ID order. */

/**
 * The main this Mac's own conversation move just finished, while this Mac's synced view of the
 * markers is still the one it finished against (the projection has not caught up). Once that view
 * changes, the markers decide again and the override is dropped.
 */

/** Whether this Mac runs the agent's scheduled jobs. The Mac that is always on does; a
 * second Mac is switched off (`matrix-run-jobs` = '0') so no job runs twice. */
function humanHost() {
  const host = hosts.get('human')

  if (!host || closing) {
    throw new Error('matrix_not_ready')
  }

  return host
}

/** Backends whose hire skills are in place, with the hires they were checked for, and a
 * check in flight (so the backend's start and a Store change never install twice at once). */

/** After a Store read or a hire: every assistant's jobs and hire skills, once per burst. */

/** The default assistant's check-ins: the gate its job asks, the claims and the posts. */
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

async function startSdk() {
  await startHost('human')

  if (account.identity()) {
    // A prior DELETE may have durably entered `revoking` before its MAS session existed. The
    // authoritative list survives a desktop restart, so this sweep finishes that old intent.
    void cloudEnrollments?.sweepRevocations(AbortSignal.timeout(30_000))
  }

  if (account.identity() && !account.sessionEnded() && !account.signOutPending()) {
    await deviceBootstrap?.accountReady(deviceLaunch).catch(() => console.warn('[Device] service not running'))
  }

  if (config.domain && hosts.has('human')) {
    // On an existing account the root slot may no longer be the product default.
    // Read the authoritative role even if that slot cannot start its SDK.
    if (account.appScope()) {
      setAgentRosterReadiness('loading')
      publish(state)
      agentRoster.request()
      await syncAgents()
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
    await nativeMacSsh?.disconnect().catch(() => console.warn('[Device] native SSH revoke pending after session end'))
    const workDevice = deviceIdentity?.enrollment()?.deviceServiceId
    deviceIdentity?.signOut('sign_out')
    cloudEnrollments?.stop()
    const deviceStop = deviceBootstrap?.signedOut()
    console.warn('[Matrix] chat session ended; asking the person to sign in again')

    publish(matrixSessionEndedSnapshot(state))
    await retireWork(workDevice)
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
    busy: () => closing || anyOperation() || domainOperation,
    quit: () => app.quit(),
    bundlePath: path.resolve(process.resourcesPath, '..', '..'),
    temporaryPath: app.getPath('temp'),
    forceExit: () => { ownedBackgroundChildren.killNow(); app.exit(0)},
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

  if (process.platform === 'darwin') {
    nativeMacSsh = new NativeMacSsh({
      enrollment: () => deviceIdentity?.enrollment() ?? null,
      setPlanFactsEnabled: async (deviceServiceId, enabled) => work?.setMacPlanFactsEnabled(deviceServiceId, enabled),
      call: request => s1Call({ kind: 'native-ssh', request }, AbortSignal.timeout(20_000)),
      system: createNativeSshSystem(),
      settings: outcomeStore
    })
    ipcMain.handle(MATRIX_NATIVE_MAC_IPC.ssh, async (event, action: unknown) => {
      requireMatrixCaller(event, ui?.webContents, UI_URL)

      if (!account.identity() || account.sessionEnded() || account.signOutPending()) {
        throw new Error('signed_out')
      }

      switch (action) {
        case 'status':
          return nativeMacSsh!.status()

        case 'refresh':
          await nativeMacSsh!.start()

          break

        case 'connect':
          await nativeMacSsh!.start(true)

          break

        case 'enable_remote_login':
          await nativeMacSsh!.enableRemoteLogin()

          break

        case 'disconnect':
          await nativeMacSsh!.disconnect({ accountConnection: true })

          break

        case 'full_disk_access_hint': return nativeMacSsh!.fullDiskAccessHint()

        case 'open_settings':
          await shell.openExternal(REMOTE_LOGIN_SETTINGS)
          nativeMacSsh!.acknowledgeFullDiskAccessHint()

          break

        default: throw new Error('invalid_native_ssh_action')
      }

      return nativeMacSsh!.status()
    })
    // A command approval in a chat (Hermes's own answer is the window's reaction): one fresh Touch ID first.
    ipcMain.handle(MATRIX_NATIVE_MAC_IPC.confirmCommand, (event, command: unknown) => {
      requireMatrixCaller(event, ui?.webContents, UI_URL)

      if (!account.identity() || account.sessionEnded() || account.signOutPending()) {
        throw new Error('signed_out')
      }

      return confirmNativeCommand(command, {
        touchId: {
          can: () => systemPreferences.canPromptTouchID(),
          prompt: reason => systemPreferences.promptTouchID(reason)
        },
        locale: deviceLocale
      })
    })
  }

  cloudEnrollments = createCloudEnrollments()
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

  }, 15_000).unref()

  // The operator's single-shot trigger for the owner's home move (operator-move.ts). It lives in
  // the app's private data folder, is gated by the same allow-list as the migration itself and by
  // the agent being ready, and has no IPC or UI surface.

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
      const owner = currentRosterOwner()

      return agent?.assistantId && owner
        ? {
            key: scope.accountKey,
            generation: scope.generation,
            owner,
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

    return agent?.assistantId && currentRosterOwner()
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
  lifecycle = createLifecycle()

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

  deviceLedger = new MatrixDeviceLedger({
    read: () => deviceTrust.getItem('device-ledger'),
    write: value => deviceTrust.setItem('device-ledger', value)
  })
  credentialStore = new EncryptedStore(path.join(app.getPath('userData'), 'credentials.json'), safeStorage)

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
      localExecutorRequired: () => false,
      domainContinuation: matrixDriveChain(() => drive)
    }
  )

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

  chatGptCarry = config.domain ? new ChatGptCarry({
    scope: () => account.appScope(),
    home: subscriptionAuthHome,
    custody: (home, action) => {
      if (!runtime) {throw new Error('carry_unavailable')}

      return carryCustody(runtime.python, runtime.source, home, action)
    },
    drain: async () => {
      // Do not use refreshSubscriptionAgents: that helper immediately restarts consumers.
      for (const each of allAgents()) {if (!each.closed) {await stopHost(each.role)}}
      await retireSubscriptionProviders()
    },
    carried: () => { recheckAgents() },
    restored: () => { recheckAgents() },
    call: (body, signal) => account.s1Request(
      (accessToken, resource) => requestChatGptCarry(resource, accessToken, body, signal), signal)
  }) : undefined

  chatGptTraining = config.domain
    ? new MatrixChatGptTrainingConfirmation({
        scope: () => account.appScope(),
        // A pending revocation's key, per account, so a restart resumes it with the same key.
        journal: new FileChatGptTrainingRevokeJournal(path.join(app.getPath('userData'), 'chatgpt-training')),
        call: (method, signal, init) => account.s1Request(
          (accessToken, resource) => requestMatrixChatGptTraining(resource, accessToken, method, signal, init), signal),
        // Google connected now, or the owner's Google fence was ever set (a latched assistant
        // stays latched after Google is disconnected). Server-side latches remain authoritative.
        required: () => {
          return Object.values(googleConnections?.services() ?? {}).some(Boolean)
        }
      })
    : undefined

  videoConsent = config.domain
    ? new MatrixVideoGenerationConsent({
        scope: () => account.appScope(),
        // A pending turn-off's key, per account, so a restart resumes it with the same key.
        journal: new FileOwnerConsentRevokeJournal(path.join(app.getPath('userData'), 'video-consent')),
        call: (method, signal, init) => account.s1Request(
          (accessToken, resource) => requestMatrixVideoConsent(resource, accessToken, method, signal, init), signal)
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
        deviceNames: async () => ({}),
        supersededDeviceIds: () => [],
        offer: principal => cloudModelChoices?.view(principal),
        here: () => 'cloud',
        thisDevice: () => undefined,
        changed: () => publish(state)
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
    chooseUpload: async kind => {
      if (!ui || ui.isDestroyed()) {
        return undefined
      }

      const selected = await dialog.showOpenDialog(ui, {
        properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
      })

      return selected.canceled ? undefined : selected.filePaths
    },
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

          if (target.agent.operation) {
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
                return send()
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

    })
  )
  // Google write cards: the pending list and each card's delivered/approve/decline, sent with the
  // owner's bearer (never the renderer's). Nothing is posted into any room.
  ipcMain.handle(
    MATRIX_GOOGLE_WRITE_IPC,
    createMatrixGoogleWriteIpcHandler({
      assertSender: (event: Electron.IpcMainInvokeEvent) => requireMatrixCaller(event, ui?.webContents, UI_URL),
      proposals: () => (config.domain && state.identity ? matrixGoogleWriteProposals(account) : undefined)
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
      hireReady: () => Promise.resolve(true),
      changed: () => {
        publish(state)

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

  if (config.domain) {
    powerMonitor.on('resume', () => {resumeHosts()})
    refreshMatrixRosterOnWake(powerMonitor, agentRoster, () => void syncAgents())
    let online = net.isOnline()
    setInterval(() => {
      if (!closing && account.identity()) {
        void syncAgents()
        void store?.refresh(true)
        drive?.recoverConnectivity()
        void resumeMatrixPetHatch()
      }

      if (net.isOnline() !== online) {
        online = !online

        if (online) {
          void reconcileDeviceControl(true)
          drive?.recoverConnectivity(true)
        }
      }
    }, 5_000).unref()
  }

  if (config.managedModel) {
    const candidate = new MatrixManagedModel({
      gateway: config.managedModel.gateway,
      port: config.managedModel.port,
      keys: () => [
        // Work's own gateways present one key; the proxy attributes it to no agent.
        ...(work?.modelKeys() ?? []),
        ...Array.from(matrixPetHatchKeys.entries())
          .filter(([, run]) => !run.abort.signal.aborted && run.accountKey === account.appScope()?.accountKey)
          .map(([key, run]) => [key, run.role] as const)
      ],
      bearer: refresh => account.managedModelBearer(refresh),
      route: role => role === MATRIX_WORK_MODEL_ROLE ? (work?.modelRoute() ?? 'refused') : 'open',
      hatchKey: (role, key) =>
        Array.from(matrixPetHatches.values()).some(
          run =>
            run.proxyKey === key &&
            !run.abort.signal.aborted &&
            run.role === role &&
            run.accountKey === account.appScope()?.accountKey
        ),
      model: () => MATRIX_DEFAULT_MODEL,
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
  registerMatrixFolderAccessIpc(ipcMain, {
    assertTrusted: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
    access: {
      read: () => matrixFolderAccess().read(),
      apply: choices => matrixFolderAccess().apply(choices),
      add: () => matrixFolderAccess().add(),
      remove: id => matrixFolderAccess().remove(id)
    }
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
    getLocationAccessStatus: () => 'not-determined',
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
    readiness: async () => {throw new Error('matrix_native_apps_unavailable')}
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

  // Self-work slice A: Work (the owner's own server view and the assistants' route) for the signed-in account.
  // Everything it needs from this window is a port here; `main-work.ts` holds no account logic of its own.
  if (config.domain) {
    const domain = config.domain

    const ownerPrincipal = async () => {
      try {
        return (await account.readDomain(false)).principal
      } catch {
        return undefined
      }
    }

    work = createMatrixWork({
      userData: app.getPath('userData'),
      home: app.getPath('home'),
      resources: process.resourcesPath,
      workPreload: path.join(assets, 'matrix-work-preload.js'),
      safeStorage,
      ui: () => ui,
      ipcMain,
      requireUi: event => requireMatrixCaller(event, ui?.webContents, UI_URL),
      zoomFactor: () => ui?.webContents.getZoomFactor() ?? 1,
      sessionFromPartition: partition => session.fromPartition(partition),
      model: {
        baseUrl: () => managedModel?.baseUrl,
        probe: (role, signal) =>
          managedModel?.probe(role, signal) ?? Promise.resolve({ ok: false as const, code: 'setup_required' as const }),
        abortRole: role => managedModel?.abortAgent(role)
      },
      wallet: signal => account.wallet(signal),
      scope: () => account.appScope(),
      ownerPrincipal,
      deviceServiceId: () => {
        const enrollment = deviceIdentity?.enrollment()

        return enrollment?.state === 'active' ? enrollment.deviceServiceId : undefined
      },
      localDeviceServiceId: () => deviceIdentity?.enrollment()?.deviceServiceId,
      deviceServicesEndpoint: () => `${domain.resource}/device-services`,
      bearer: () => account.s1Request(accessToken => Promise.resolve(accessToken), AbortSignal.timeout(15_000)),
      connectAssertion: () => account.s1Request(
        (token, base, signal) => fetchConnectAssertion(token, base, signal, session.defaultSession.fetch.bind(session.defaultSession)),
        AbortSignal.timeout(15_000)
      ),
      prepareChatGptConnect: () => account.s1Request(async (token, base, signal) => {
        // The Shell route checks status first and performs the idempotent account retirement only if needed.
        const response = await session.defaultSession.fetch(`${base}/api/connections/openai-codex/uncarry`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
          redirect: 'error',
          signal
        })

        if (response.status === 401) {
          throw new Error('matrix_s1_authentication')
        }

        const status = response.ok ? await response.json() as { state?: unknown } | null : null

        if (status?.state !== 'work') {
          throw new Error('work_chatgpt_custody_pending')
        }
      }, AbortSignal.timeout(60_000), { timeoutMs: 60_000 }),
      ownerHost: () => {
        const owner = hosts.get('human')

        return owner && !closing
          ? { userId: owner.identity.userId, command: command => owner.queue.command(command) }
          : undefined
      },
      agentMatrixUser: async principal => {
        const agent = (await account.agents(AbortSignal.timeout(15_000))).find(
          each => each.principal === principal && each.status === 'active'
        )

        return agent?.matrixUser ?? null
      },
      agentName: principal => allAgents().find(each => each.agentPrincipal === principal)?.name,
      agentDefinition: async principal => {
        const agent = (await account.agents(AbortSignal.timeout(15_000))).find(
          each => each.principal === principal && each.status === 'active'
        )

        if (!agent) {
          throw new Error('relay_assistant_unavailable')
        }

        return account.agentDefinition(agent.id, AbortSignal.timeout(15_000))
      },
      openProtons: () => shell.openExternal(`${domain.resource}/payments/protons`),
      publish: (channel, projection) => ui?.webContents.send(channel, projection),
      closing: () => closing,
      log: line => console.warn(line)
    })
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
      ...boundSdkConfiguration(account, role, host.identity),
      deviceIsolation: host.deviceIsolation,
      ...(role === 'human'
        ? { companyPrivateCosNotificationRoomIds: privateCosNotificationRoomIds() }
        : {})
    }

    return value
  })
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
      host.profile = snapshot.ownProfile?.userId === host.identity.userId ? snapshot.ownProfile : undefined
      const humanReplacement = role === 'human' && ownerRepairPreservesWork()

      if (role === 'human' && snapshot.state === 'ready') {
        host.ready = true
        void reconcileDeviceControl()
        humanPrepared = true
        refreshOwnerReaderTrust()
      }

      if (role !== 'human') {
        host.ready = snapshot.state === 'ready'
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
        listingId?: unknown
        assistantId?: unknown
        /** `subscriptionChatGptTrainingConfirm`: the relay connection the card read. */
        connectionId?: unknown
        principal?: unknown
        agentPrincipal?: unknown
        /** `agentDesk`: which read of the agent's cloud home, and its folder for `files`. */
        read?: unknown
        path?: unknown
        /** `agentControl`: the routine's native job ID for `routine_on` / `routine_off`. */
        job?: unknown
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

        if (
          anyOperation() ||
          domainOperation ||
          closing ||
          state.state !== 'ready'
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

        throw new Error('matrix_app_unavailable')
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

      if (request?.kind === 'document' && request.action === 'remove') {
        const identity = account.identity()
        const roomId = state.roomId

        if (
          closing || anyOperation() || state.state !== 'ready' || !identity || !roomId ||
          state.identity?.userId !== identity.userId || state.identity.deviceId !== identity.deviceId ||
          request.roomId !== roomId ||
          !state.rooms.some(room => room.id === roomId && usableAgentRoom(room))
        ) {
          throw new Error('matrix_document_unavailable')
        }

        documents.remove({ userId: identity.userId, roomId })
        publish(state)

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

      if (request?.kind === 'openLink') {
        await shell.openExternal(matrixOpenLink(request.url))

        return
      }

      if (request?.kind === 'openSourceNotices') {
        await openSourceNotices.open(request.title)

        return
      }

      if (request?.kind === 'subscriptionsStatus') {
        const identity = account?.identity()

        if (!identity || !runtime) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        const local = matrixSubscriptionsStatus({ accountAuthHome: subscriptionAuthHome(), keys: subscriptionKeys() })
        const platform = await providerConnections?.refresh()

        return matrixSubscriptionsWithProviderConnections(local, platform)
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
          // A new sign-in, so a new relay session: a confirmation never carries to another account.
          complete: () => repairChatGptSubscription(providers.diagnostics.current).renew()
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
          await disconnectMatrixSubscriptionChatGpt({
            stopRepair: stopSubscriptionFollowUpRepair,
            disconnect: async () => {
              await scope.request({
                path: '/api/provider-settings/oauth/disconnect',
                method: 'POST',
                body: { provider: 'openai-codex' }
              })
            },
            forget: async () => {
              // Hermes's DELETE above is the native disconnect. If it did not land, Hermes's own locked
              // clear_provider_auth drops the grant from the account home (never another provider's
              // rows): once before the assistants stop, so a restart cannot borrow it, and once after,
              // so a refresh a stopping assistant was finishing cannot write it back.
              const accountHome = matrixSubscriptionHostHome(runtime!, owner, accountKey)
              await clearMatrixAccountChatGpt(runtime!, accountHome).catch(() => undefined)

              await clearMatrixAccountChatGpt(runtime!, accountHome)
            }
          })
        } finally {
          await retireSubscriptionProviders()
        }

        return
      }

      // The one-time ChatGPT-with-Google confirmation (Shell training-confirmation r3). Main only
      // forwards the person's explicit Confirm and Revoke; the server owns the record.
      if (request?.kind === 'subscriptionChatGptTraining') {
        if (!chatGptTraining) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        return chatGptTraining.read()
      }

      if (request?.kind === 'subscriptionChatGptTrainingConfirm') {
        return chatGptTraining ? chatGptTraining.confirm(request.connectionId) : { status: 'unavailable' as const }
      }

      if (request?.kind === 'subscriptionChatGptTrainingRevoke') {
        return chatGptTraining ? chatGptTraining.revoke() : { status: 'unavailable' as const }
      }

      // The one-time video-generation consent (Shell video-generation/consent). Main only forwards
      // the person's explicit Allow and Turn off; the server owns the record and its locale.
      if (request?.kind === 'videoConsent') {
        if (!videoConsent) {
          throw new Error('matrix_subscriptions_unavailable')
        }

        return videoConsent.read()
      }

      if (request?.kind === 'videoConsentAllow') {
        return videoConsent ? videoConsent.allow() : { status: 'unavailable' as const }
      }

      if (request?.kind === 'videoConsentRevoke') {
        return videoConsent ? videoConsent.revoke() : { status: 'unavailable' as const }
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

        return
      }

      // The composer picker's sanitized route catalog of the connection(s) the room's agent can
      // answer with: read from that agent's own Hermes provider snapshot and switched through the
      // Connections page's native select (connected-models.ts). The window names the room and an
      // opaque route id; main supplies the agent, account generation, destination and validation.
      if (request?.kind === 'cloudAgent') {
        return cloudAgentRequest(request)
      }

      if (request?.kind === 'agentControl') {
        // The agent tab's Pause / Resume and per-routine switches: native cron through G14.
        const principal = typeof request.agentPrincipal === 'string' ? request.agentPrincipal : ''
        const action = request.action
        const job = typeof request.job === 'string' ? request.job : undefined
        const scope = account.appScope()

        const control: MatrixHostAgentControl | undefined =
          action === 'pause' || action === 'resume'
            ? (job === undefined ? { action: action as 'pause' | 'resume' } : undefined)
            : (action === 'routine_on' || action === 'routine_off') && job !== undefined
              ? { action: action as 'routine_on' | 'routine_off', job }
              : undefined

        if (closing || !scope || !config.domain || !hostRuntimeAgents.has(principal) || !control) {
          throw new Error('matrix_not_ready')
        }

        const result = await account.s1Request(
          (token, base, signal) =>
            requestHostAgentControl(base, token, principal, control, signal, (url, init) => session.defaultSession.fetch(url, init)),
          AbortSignal.timeout(15_000), { timeoutMs: 15_000 })

        const current = account.appScope()

        if (closing || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
          throw new Error('matrix_not_ready')
        }

        return result
      }

      if (request?.kind === 'agentDesk') {
        // The side panel's agent tab: one read-only view of an owned native Hermes agent's cloud
        // home. Only roster `runtime: 'hermes'` agents; the Shell resolves the owner from the bearer.
        const principal = typeof request.agentPrincipal === 'string' ? request.agentPrincipal : ''
        const read = request.read
        const path = typeof request.path === 'string' ? request.path : undefined
        const scope = account.appScope()

        if (
          closing || !scope || !config.domain || !hostRuntimeAgents.has(principal) ||
          (read !== 'schedule' && read !== 'memory' && read !== 'files') ||
          (path !== undefined && read !== 'files')
        ) {
          throw new Error('matrix_not_ready')
        }

        const result = await account.s1Request(
          (token, base, signal) =>
            requestHostDesk(base, token, principal, read === 'files' ? { read, ...(path !== undefined ? { path } : {}) } : { read },
              signal, (url, init) => session.defaultSession.fetch(url, init)),
          AbortSignal.timeout(15_000), { timeoutMs: 15_000 })

        const current = account.appScope()

        if (closing || current?.accountKey !== scope.accountKey || current.generation !== scope.generation) {
          throw new Error('matrix_not_ready')
        }

        return result
      }

      if (request?.kind === 'modelDestinations' && request.action === 'writeSubscription') {
        const { agentPrincipal, source, model, effort } = request as {
          agentPrincipal?: unknown
          source?: unknown
          model?: unknown
          effort?: unknown
        }

        if (
          closing ||
          !account.appScope() ||
          !modelDestinations ||
          typeof agentPrincipal !== 'string' ||
          !cloudAgents.has(agentPrincipal) ||
          (source !== 'opencode_go' && source !== 'chatgpt_plan') ||
          typeof model !== 'string' ||
          !MATRIX_PROVIDER_MODEL_ID_PATTERN.test(model) ||
          (effort !== 'low' && effort !== 'medium' && effort !== 'high')
        ) {
          throw new Error('matrix_model_destinations_unavailable')
        }

        const saved = await modelDestinations.writeSubscription(agentPrincipal, source, model, effort)

        if (saved) {void cloudModelChoices?.reload(agentPrincipal)}

        return { status: saved ? 'saved' : 'refused' }
      }

      if (request?.kind === 'sendAssistant') {
        const input = parseMatrixCommand({
          kind: 'send', roomId: request.roomId, body: request.body, replyTo: request.replyTo
        })

        if (input.kind !== 'send') {throw new Error('matrix_command_invalid')}
        const agent = requireRoomAgent(input.roomId)
        const humanHost = hosts.get('human')
        const owner = account.identity()

        if (operation || domainOperation || closing || state.state !== 'ready' || !owner || !humanHost) {
          throw new Error('matrix_not_ready')
        }

        await guardRoomCommand(input.kind, input.roomId)

        const current = account.identity()

        if (
          closing ||
          state.state !== 'ready' ||
          hosts.get('human') !== humanHost ||
          current?.userId !== owner.userId ||
          current.deviceId !== owner.deviceId ||
          agentOfRoom(input.roomId) !== agent
        ) {
          throw new Error('matrix_not_ready')
        }

        const eventId = (await command(input)) as string

        return { eventId, result: { state: 'published' as const } }
      }

      if (request?.kind === 'openAgents') {
        if (!config.domain || !agentCreation || closing || state.state !== 'ready' || !account.identity()) {
          return []
        }

        try {
          return await account.openAgents(AbortSignal.timeout(20_000))
        } catch (error) {
          // The shelf is optional: an unreachable catalog hides it, and the sheet still makes one.
          console.warn('[Matrix] open listings not read:', setupFailureDetail(error))

          return []
        }
      }

      if (request?.kind === 'hireAgent') {
        const listingId = typeof request.listingId === 'string' ? request.listingId : ''

        const checked = checkAssistantName(request.name, {
          primary: false,
          principal: '',
          others: allAgents().flatMap(each =>
            !each.closed && each.agentPrincipal ? [{ principal: each.agentPrincipal, name: each.name }] : []
          ),
          apps: appNames()
        })

        if (!checked.ok || listingId.length < 1 || listingId.length > 128) {
          throw new Error('matrix_command_invalid')
        }

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
          // The platform seeds the listing's persona and skills; no persona write follows (0535).
          const hired = await lifecycle.hire(checked.name, listingId, request.hireConfirmed === true)

          return { principal: hired.principal, assistantId: hired.assistantId }
        } catch (error) {
          if (error instanceof MatrixAgentCreationRefused) {
            return { refused: error.reason }
          }

          // Never relay a server's error text; the same hire resumes on Retry or at next launch.
          console.warn('[Matrix] listing hire did not finish:', setupFailureDetail(error))
          throw new Error('matrix_agent_unavailable')
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

      if (request?.kind === 'readDomain') {
        if (operation || domainOperation || !account.identity()) {
          throw new Error('matrix_not_ready')
        }

        domainOperation = true

        try {
          const domain = await account.readDomain()
          agentRoster.request()
          void syncAgents()

          return domain
        } catch {
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
          const principal = cloudPrincipal(agent)
          const offer = principal ? cloudModelChoices?.offer(principal) : undefined
          const selection = matrixCloudManagedSelection(offer, input)

          const applied = selection && principal
            ? await writeMatrixCloudAtumChoice(principal, selection.model, {
                ...(modelDestinations ? { destinations: modelDestinations } : {}),
                ...(cloudModelChoices ? { legacy: cloudModelChoices } : {}),
                ...(selection.effort ? { effort: selection.effort } : {})
              })
            : false

          return { status: applied ? ('applied' as const) : ('refused' as const) }
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

            return null
          })
        }

        const sdkCommand = assistantCommand(
          input,
          productAgent()?.userId,
          domainOperation,
          allAgents().flatMap(each => !each.closed && each.userId ? [each.userId] : []),
          []
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

        if (sdkCommand.kind === 'select') {
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
          case 'repairDeviceAccess': {
            if (!controllerHubRequired()) { return }
            await deviceIdentity?.repairConnection()
            publish(state)

            return
          }

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

            const replaced = signedIn.replaced

            if (replaced) {
              // Signed in again over an ended session: the ended device's local store is no
              // one's any more (its keys come back from backup with the remembered key).
              console.warn('[Matrix] signed in again over an ended session')
              sessionRestartedAt = undefined
              // A fresh sign-in is a fresh session: placements from the one it replaced are not
              // the new session's (this path never ran sign-out).

              void clearDevice(replaced).catch(() => console.warn('[Matrix] ended device cleanup failed'))
            }

            await startSdk()

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
            await nativeMacSsh?.disconnect()
            const workDevice = deviceIdentity?.enrollment()?.deviceServiceId
            deviceIdentity?.signOut('sign_out')
            const workRetirement = retireWork(workDevice)
            await ownPresence.offline()
            cloudEnrollments?.stop()
            petOverlays?.clear()

            await deviceBootstrap?.signedOut()

            cloudAgents.clear()
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
            agentRoster.invalidate()

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
            // Work first, while its server still runs: the assistants' route is cut and what they started is
            // stopped before the account is revoked. A slow server must not hold the sign-out for ever.
            await workRetirement
            await account.signOut(async (identity, agentIdentity, others) => {
              await stopSdk()

              for (const device of [identity, ...(agentIdentity ? [agentIdentity] : []), ...(others ?? [])]) {
                await clearDevice(device)
              }
            })
            await driveCleanup
            forgetAgents()
            forgetCodexOwners(codexOwners)

            try {
              agentCleanupRequired = account.hasOrphanedEnrollments()
              orphanedEnrollmentsTried = false
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
          await retireWork()
          await stopSdk()
          forgetAgents()
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
      await startSdk()

      void reconcileOrphanedEnrollments()
    }
  } catch {
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

  app.on(
    'before-quit',
    createMatrixQuitHandler(
      async () => {
        // Presence is network best effort; it must not gate local credential saves.
        void ownPresence.offline().catch(() => {})

        // Drive first: once `closing` is set its owner reads as signed out, and a quit must not
        // withdraw Drive's sign-in the way a sign-out does (drive.ts dispose).
        const timedStop = async (phase: string, stop: () => unknown) => {
          const started = performance.now()

          try {return await stop()} finally {console.warn(`[updates] restart phase=${phase} ms=${Math.round(performance.now() - started)}`)}
        }

        const driveStop = timedStop('drive', () => drive?.dispose())
        closing = true
        // Quitting is not a revocation: Work's gate closes without a cutoff, then its server stops.
        const workStop = timedStop('work', () => work?.quit())
        ownPresence.stop()
        companyChannelConfirmations.stop()
        companyConversationConfirmations.stop()
        petOverlays?.dispose()
        driveImport?.dispose()
        // WS-4: fence the device service synchronously on quit too, so no device command outlives the app.
        matrixDeviceStopFence?.('local_stop')
        deviceIdentity?.signOut('sign_out')
        const deviceStop = timedStop('device', () => deviceBootstrap?.dispose())
        atumKeepAwake.stop()
        const clearNativeApps = nativeApps?.clear()

        try {
          await Promise.allSettled([
            clearNativeApps, driveStop, deviceStop, workStop,
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

          ownedBackgroundChildren.killNow()
        }
      }
    )
  )
  // The local brain runs this app's own executable in its own process group; whatever
  // teardown managed, none may outlive the main process (an installer counts copies).
  installMatrixExitBarrier({ app, process, kill: () => { ownedBackgroundChildren.killNow()}, log: line => console.warn(line) })
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
