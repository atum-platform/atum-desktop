import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import * as oidc from 'openid-client'

import type { AgentProfileRequest, AgentProfileResult } from '../../shared/agent-profile-management'
import type {
  MatrixAgentRoutine,
  MatrixAgentRoutineMutation,
  MatrixAgentRoutineRunsSnapshot,
  MatrixAgentRoutinesSnapshot
} from '../../shared/agent-routines'
import {
  APP_CATALOG_V2_NEGOTIATION_HEADER,
  APP_CATALOG_V2_NEGOTIATION_VALUE
} from '../../shared/app-catalog'
import { APP_PANEL_NEGOTIATION_HEADER, APP_PANEL_PROFILE } from '../../shared/app-panel'
import { APP_LAUNCH_NEGOTIATION_HEADER, APP_LAUNCH_NEGOTIATION_VALUE, APP_LAUNCH_REFUSALS, AppSurfaceError } from '../../shared/app-view/protocol'
import type { AtumPersonalPet } from '../../shared/atum-account-pets'
import type { AtumPetBinding } from '../../shared/atum-account-preferences'
import type { AtumCloudMemory, AtumMemorySnapshot, AtumSkillBundle } from '../../shared/atum-agent-content'
import type { AtumAssistantDefinitionWrite } from '../../shared/atum-agent-portability'
import type {
  MatrixBackgroundSweepSaveResult,
  MatrixBackgroundSweepSetting,
  MatrixBackgroundSweepSettingWrite
} from '../../shared/background-sweep'
import { LOOK_PACK_NEGOTIATION_HEADER, LOOK_PACK_NEGOTIATION_VALUE } from '../../shared/look-pack'
import type {
  MatrixAppEnrollment,
  MatrixDomainIdentity,
  MatrixEmailSignIn,
  MatrixEnrollment,
  MatrixIdentity,
  MatrixRefreshCause,
  MatrixRefreshResult,
  MatrixSdkConfiguration,
  MatrixSignInMethod
} from '../../shared/matrix'
import type { MatrixAliasChange, MatrixAliasRequest } from '../../shared/matrix-aliases'
import { isCanonicalMatrixRoomId } from '../../shared/matrix-app-bot-dm'
import type { MatrixCompanyMutation, MatrixCompanyNativeFamily, MatrixCompanyRequest } from '../../shared/matrix-company'
import type { MatrixCompanyIntentJournal, MatrixCompanyNativeContext } from '../../shared/matrix-company-ai'
import { MatrixCompanyNativeError, parseMatrixCompanyAIRequest } from '../../shared/matrix-company-ai'
import { parseMatrixCompanyBoardNegotiatedRequest } from '../../shared/matrix-company-board-negotiated'
import { parseMatrixCompanyFundingRequest } from '../../shared/matrix-company-funding'
import { parseMatrixCompanyPrivateCosRequest } from '../../shared/matrix-company-private-cos'
import { parseMatrixCompanyBrainRequest } from '../../shared/matrix-company-project-brain'
import { isDefinitiveCompanyRefusal } from '../../shared/matrix-company-team-space'
import type { MatrixOfficialAccounts } from '../../shared/matrix-founder'
import type { MatrixGroupNoticeRequest } from '../../shared/matrix-group-notice'
import type { MatrixOwnerLocationView } from '../../shared/matrix-owner-location'
import type { MatrixPetCatalog } from '../../shared/matrix-pet'
import type { MatrixWalletHistory, MatrixWalletView } from '../../shared/matrix-wallet'
import type {
  AtumPetChatHistory,
  AtumPetChatRef,
  AtumPetChatReply,
  AtumPetChatRequest
} from '../../shared/pet-chat/atum-pet-chat'
import type { EncryptedStore } from '../encrypted-store'

import {
  type MatrixAccountClient,
  type MatrixAccountEvent,
  matrixClosedCode,
  type MatrixGrantRevocationReason,
  matrixOAuthRefusal,
  matrixRefreshFailureCause,
  type MatrixSessionEndCause
} from './account-events'
import {
  createMatrixAgent,
  getMatrixAgentSkill,
  getMatrixPersonalPetContent,
  listMatrixAgentDefinitions,
  listMatrixPersonalPets,
  type MatrixAgentCloudPlacement,
  MatrixAgentDefinitionError,
  type MatrixAgentDefinitionRecord,
  type MatrixAgentDefinitionSnapshot,
  type MatrixAgentRetirement,
  publishMatrixPersonalPet,
  putMatrixAgentSkill,
  readMatrixAgentDefinition,
  readMatrixAgentMemory,
  requestMatrixAgentPet,
  requestMatrixAgentPetCatalog,
  requestMatrixAgentPetVisit,
  requestMatrixAgentProfiles,
  retireMatrixAgent,
  writeMatrixAgentAvatar,
  writeMatrixAgentDefinition,
  writeMatrixAgentMemory
} from './agent-definition'
import {
  mutateMatrixAgentRoutine,
  readMatrixAgentRoutineRuns,
  readMatrixAgentRoutines
} from './agent-routines'
import { MatrixAliasError, parseMatrixAliasRequest, requestMatrixAlias } from './aliases'
import { authorizeNative, type NativeGrant } from './authorization'
import {
  readMatrixBackgroundSweepSetting,
  writeMatrixBackgroundSweepSetting
} from './background-sweep-settings'
import { isMatrixCompanyMutation, MatrixCompanyError, parseMatrixCompanyRequest, requestMatrixCompany } from './company'
import { requestMatrixCompanyAI } from './company-ai'
import { requestMatrixCompanyBoard } from './company-board'
import {
  MatrixCompanyFileError,
  type MatrixCompanyFileRequest,
  type MatrixCompanyFileValue,
  parseMatrixCompanyFileRequest,
  requestMatrixCompanyFile
} from './company-files'
import {
  type MatrixCompanyFileRequestV2,
  type MatrixCompanyFileValueV2,
  parseMatrixCompanyFileRequestV2,
  requestMatrixCompanyFileV2
} from './company-files-v2'
import { requestMatrixCompanyFunding } from './company-funding'
import { requestMatrixCompanyPrivateCos } from './company-private-cos'
import { requestMatrixCompanyBrain } from './company-project-brain'
import { type MatrixConfig, matrixConfigurationKey } from './config'
import type { MatrixDiskReserve } from './disk-reserve'
import { ensureDomainAssistant, readDomainIdentity, readDomainJson } from './domain'
import type { NativeCloudFileGrant } from './drive-task'
import {
  agentCredential,
  type AgentCredential,
  appCredential,
  type AppCredential,
  appEnrollmentIdentity,
  type AppEnrollmentSelection,
  enrollmentIdentity,
  MatrixEnrollmentRateLimited,
  matrixExecutorPath,
  printableDeviceId,
  requestAgentIdentity,
  requestAppTurn,
  requestEnrollment,
  requestGroupNotice,
  requestInvocation,
  requestLease,
  requestLocalEnrollmentCapabilities,
  validateAppEnrollmentSelection
} from './enrollment'
import type { FirstRunGoogleAuthority } from './first-run-google'
import type { MatrixAppTurn } from './invocation'
import { MatrixOfficialAccountsError, requestMatrixOfficialAccounts } from './official-accounts'
import { type OwnerLanguage, OwnerLanguageReports } from './owner-language'
import type { OwnerReaderTrustEnrollment, OwnerReaderVerification } from './owner-reader-trust'
import {
  MatrixPetChatAuthenticationError,
  requestMatrixPetChat,
  requestMatrixPetChatHistory
} from './pet-chat-client'
import { readMatrixPetRoaming } from './pet-roaming'
import { matrixEmailSignIn, matrixSignInEntry } from './sign-in-entry'
import { requestMatrixStore, type StoreResource } from './store'
import { currentIanaTimeZone, OwnerTimeZoneReports } from './time-zone'
import { readMatrixWallet } from './wallet'

interface DomainGrant extends NativeGrant {
  sessionId: string
}

/** An agent's renewed credential the vault could not keep (heldAgents): the record it belongs
 * to (`storageKey`, `executorId`) and the credential it replaces there. */
interface HeldAgentCredential {
  storageKey: string
  executorId: string
  replaces: string
  credential: AgentCredential
}

interface Revocation extends NativeGrant {
  clientId?: string // Older Matrix-only vault entries use nativeClientId.
  /** Drains this entry failed so far (drainRevocationsOnce). */
  attempts?: number
}

/** A queued revocation the sign-in server refuses (an OAuth error, e.g. 401 `invalid_client`) is
 * given up after this many drains; one it never answers (offline, a 5xx) after many more, so a
 * long outage keeps it. Either way it never holds up the entries behind it. */
const REVOCATION_REFUSED_ATTEMPTS = 3
const REVOCATION_UNANSWERED_ATTEMPTS = 50
const APP_INTAKE_FIELD_NAME = /^[a-z][a-z0-9_]*$/
const APP_INTAKE_MAX_FIELDS = 32
const APP_INTAKE_MAX_VALUE_LENGTH = 512

/**
 * The one thing of the sign-in server's account app that Atum opens: MSC4191's "end this session"
 * for a single device, the action Atum's platform lets through its gate (atum-platform,
 * deploy/chat/templates.py ACCOUNT_ACTION / ACCOUNT_DEVICE_ID, and nothing else of that app). A
 * device ID outside the gate's pattern would only land on Atum's own page, so it is refused here.
 */
export const END_DEVICE_SESSION_ACTION = 'org.matrix.device_delete'
export const END_DEVICE_SESSION_ID = /^[A-Za-z0-9._~-]{1,128}$/

interface EnrollmentRecord {
  executorId: string
  state: 'pending' | 'ready' | 'revoking' | 'withdrawn'
  /** Authenticated agent selection, pinned before issuance; never execution authority. */
  agentPrincipal?: string
  /** Native human device retained at local-executor creation, never renderer input. */
  hostDevice?: string
  storageKey?: string
  credential?: AgentCredential | AppCredential
  /** Persisted before issuance, never inferred from a linked account or shortcut. */
  app?: AppEnrollmentSelection & { disclosedAt: number; ownerPrincipal: string }
  cleanupIdentity?: MatrixIdentity
}

function revokingParticipant(enrollment: EnrollmentRecord, app: boolean): EnrollmentRecord {
  const identity =
    enrollment.cleanupIdentity ??
    (enrollment.credential
      ? { userId: enrollment.credential.userId, deviceId: enrollment.credential.deviceId }
      : undefined)

  return {
    executorId: enrollment.executorId,
    state: 'revoking',
    ...(enrollment.app ? { app: enrollment.app } : {}),
    ...(app && identity ? { cleanupIdentity: identity } : {})
  }
}

/**
 * Whose vault slot: the default agent (`undefined`), an integrated app (its slug), or
 * another of the person's agents (`{ agent }`; 
 * §2.2). An agent is never a bare string, so it can never reach an app's or the default
 * agent's slot.
 */
type Participant = string | undefined | { agent: string }

const participantKey = (selector: Participant) =>
  typeof selector === 'object' ? `agent:${selector.agent}` : (selector ?? '')

function participant(record: AccountRecord, selector?: Participant): EnrollmentRecord | undefined {
  if (typeof selector === 'object') {
    return Object.hasOwn(record.agentEnrollments ?? {}, selector.agent)
      ? record.agentEnrollments![selector.agent]
      : undefined
  }

  return selector === undefined
    ? record.enrollment
    : Object.hasOwn(record.apps ?? {}, selector)
      ? record.apps![selector]
      : undefined
}

function setParticipant(
  record: AccountRecord,
  value: EnrollmentRecord | undefined,
  selector?: Participant
): AccountRecord {
  if (selector === undefined) {
    return { ...record, enrollment: value }
  }

  const key = typeof selector === 'object' ? selector.agent : selector
  const slots = { ...(typeof selector === 'object' ? record.agentEnrollments : record.apps) }

  if (value) {
    slots[key] = value
  } else {
    delete slots[key]
  }

  return typeof selector === 'object' ? { ...record, agentEnrollments: slots } : { ...record, apps: slots }
}

/** Every participant, the default agent first: sign-out and uniqueness checks see all. */
function participantSelectors(record: AccountRecord): Participant[] {
  return [
    undefined,
    ...Object.keys(record.apps ?? {}),
    ...Object.keys(record.agentEnrollments ?? {}).map(agent => ({ agent }))
  ]
}

function allParticipants(record: AccountRecord): Array<EnrollmentRecord | undefined> {
  return participantSelectors(record).map(selector => participant(record, selector))
}

function participantAgentPrincipal(record: AccountRecord, selector?: Participant): string | undefined {
  if (typeof selector === 'string') {
    return undefined
  }

  const enrolled = participant(record, selector)

  return (
    enrolled?.credential?.agentPrincipal ??
    (enrolled ? (selector === undefined ? enrolled.agentPrincipal : selector.agent) : undefined)
  )
}

interface AccountRecord extends NativeGrant, MatrixIdentity {
  version: 1
  configurationKey: string
  storageKey: string
  /** Validated explicit recovery, encrypted by native safeStorage with this account. */
  ownerRecoveryKey?: string
  /** `device`: the key was made quietly on this first Mac (owner-recovery.ts) and the person
   * has not confirmed writing it down; it leaves with this record at sign-out. */
  ownerRecoveryCustody?: 'device'
  signingOut?: boolean
  /** The sign-in server refused this Mac's chat grant: the chat session is over, and only the
   * same person signing in again resumes it (signIn). Everything else on the record stays. */
  sessionEnded?: MatrixSessionEnd
  localHermes?: { home: string; executorId: string; cleanupPending?: boolean }
  domain?: DomainGrant
  enrollment?: EnrollmentRecord
  apps?: Record<string, EnrollmentRecord>
  /** The person's other agents, by principal (0146). */
  agentEnrollments?: Record<string, EnrollmentRecord>
  /** Each other agent's retained Hermes profile, as `localHermes` is the default agent's. */
  agentHermes?: Record<string, { home: string; executorId: string; cleanupPending?: boolean }>
}

/** When and why the sign-in server ended this Mac's chat session (MatrixAccount.sessionEnded). */
export interface MatrixSessionEnd {
  cause: MatrixSessionEndCause
  at: number
}

/**
 * A rotation the vault could not keep (a full disk): the newest token pair at the sign-in
 * server, held in memory and handed to nobody until it is saved. MAS 1.24 takes the spent,
 * saved refresh token again as long as the pair that replaced it is unused: its refresh token
 * never redeemed, its access token never shown to the homeserver (token.rs:672-761,
 * introspection.rs:359-365). So until the held pair is saved, the saved grant still works after
 * a crash, a power cut or a quit; served from memory instead, one request with it would make a
 * crash end the session (the Mac mini, 2026-10-04). Saved, it is the grant (saveHeld). A
 * sign-out meanwhile revokes it too: revoking only the spent, saved tokens is answered 200 and
 * ends nothing (revoke.rs:184-193).
 */
interface HeldRotation {
  storageKey: string
  accessToken: string
  refreshToken: string
  expiresAt?: number
}

export interface MatrixCompanyFilePending {
  schemaVersion: 1
  phase: 'reserved' | 'writing' | 'unknown' | 'ready' | 'published' | 'cancelled'
  requestId: string
  companyId: string
  channelId: string
  roomId: string
  name: string
  contentType: string
  size: number
  sha256: string
  transactionId: string
  fileId?: string
  revision?: 1
  eventId?: string
  threadRootId?: string
  replyTo?: string
}

const COMPANY_FILE_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const COMPANY_FILE_ROOM = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const COMPANY_FILE_EVENT = /^\$[!-~]{1,511}$/u
const COMPANY_FILE_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u
const COMPANY_FILE_HASH = /^[a-f0-9]{64}$/u
const COMPANY_FILE_PHASES = new Set<MatrixCompanyFilePending['phase']>([
  'reserved', 'writing', 'unknown', 'ready', 'published', 'cancelled'
])

function companyFileRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactCompanyFileKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',')
}

/** Strict journal parser: it deliberately excludes bytes, paths, grants, URLs and provider state. */
export function parseMatrixCompanyFilePending(value: unknown): MatrixCompanyFilePending {
  if (!companyFileRecord(value)) {
    throw new MatrixCompanyFileError('invalid')
  }
  const optional = ['fileId', 'revision', 'eventId', 'threadRootId', 'replyTo'].filter(key => Object.hasOwn(value, key))
  const names = ['schemaVersion', 'phase', 'requestId', 'companyId', 'channelId', 'roomId', 'name', 'contentType', 'size', 'sha256', 'transactionId', ...optional]
  const name = (candidate: unknown) => typeof candidate === 'string' && candidate.trim().length > 0 && [...candidate].length <= 255 &&
    [...candidate].every(character => character.codePointAt(0)! > 31 && character.codePointAt(0) !== 127)
  const event = (candidate: unknown) => typeof candidate === 'string' && COMPANY_FILE_EVENT.test(candidate)
  const hasFile = Object.hasOwn(value, 'fileId')
  const hasRevision = Object.hasOwn(value, 'revision')
  const hasEvent = Object.hasOwn(value, 'eventId')
  const hasThreadRoot = Object.hasOwn(value, 'threadRootId')
  const hasReply = Object.hasOwn(value, 'replyTo')

  if (!exactCompanyFileKeys(value, names) || value.schemaVersion !== 1 || typeof value.phase !== 'string' ||
    !COMPANY_FILE_PHASES.has(value.phase as MatrixCompanyFilePending['phase']) || typeof value.requestId !== 'string' ||
    !COMPANY_FILE_UUID.test(value.requestId) || typeof value.companyId !== 'string' || !COMPANY_FILE_UUID.test(value.companyId) ||
    typeof value.channelId !== 'string' || !COMPANY_FILE_UUID.test(value.channelId) || typeof value.roomId !== 'string' ||
    !COMPANY_FILE_ROOM.test(value.roomId) || !name(value.name) || typeof value.contentType !== 'string' ||
    !COMPANY_FILE_TYPE.test(value.contentType) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 20 * 1024 * 1024 ||
    typeof value.sha256 !== 'string' || !COMPANY_FILE_HASH.test(value.sha256) || typeof value.transactionId !== 'string' ||
    value.transactionId !== `atum-cf-${value.requestId}` ||
    (hasFile && (typeof value.fileId !== 'string' || !COMPANY_FILE_UUID.test(value.fileId))) ||
    (hasRevision && value.revision !== 1) ||
    (hasEvent && !event(value.eventId)) ||
    (hasThreadRoot && !event(value.threadRootId)) ||
    (hasReply && !event(value.replyTo)) ||
    hasFile !== hasRevision || hasThreadRoot !== hasReply ||
    ((value.phase === 'ready' || value.phase === 'published') && !hasFile) ||
    (value.phase === 'published' && !hasEvent) ||
    (value.phase !== 'published' && hasEvent)) {
    throw new MatrixCompanyFileError('invalid')
  }

  return value as unknown as MatrixCompanyFilePending
}

/** What main lends the account beyond its vault and browser (all optional). */
export interface MatrixAccountHooks {
  /** Room kept on the disk for a save that finds it full (disk-reserve.ts). */
  reserve?: MatrixDiskReserve
  /** A rotation the vault could not keep is saved now: what waited on it (the chat engine,
   * for `matrix`) can use the sign-in again. */
  renewed?: (client: MatrixAccountClient) => void
  /** The person is back from the browser (a sign-in's, or a Connect's, callback arrived): the
   * app comes to the front while the rest finishes behind it. */
  returned?: () => void
  /** Whether this Mac still owes an agent a local executor. Main answers with the same
   * cloud-only decision the launch uses (`matrixAssistantSetupRunsLocally`): a cloud-only
   * assistant is already served by the platform, and its local-executor POST is fenced with
   * `cloud_answering`. Absent keeps the historical local behaviour. */
  localExecutorRequired?: (agent: string | undefined) => boolean
  /** This app's version (`app.getVersion`), sent with every Store request (requestMatrixStore). */
  desktopVersion?: string
  /** The owner's language for the roster read's report (atum.owner-language/1): the saved choice, else
   * the supported system language once sync confirmed none is saved; undefined sends nothing. */
  ownerLanguage?: () => OwnerLanguage | undefined
  /** Optional next authorization after the Atum-account grant commits. Its own cancellation is
   * joined to this browser trip, while a missing or failed continuation never fails the grant. */
  domainContinuation?: {
    continueTo(): string | undefined | Promise<string | undefined>
    cancel(): void
  }
}

/** A held rotation is saved again after these delays, then every minute until it lands. Each
 * try is a local write: the sign-in server is not asked again while a rotation is held. */
const HELD_SAVE_RETRY_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const
/** A saved access token this close to its expiry is rotated rather than handed over. */
const TOKEN_FRESH_MS = 30_000
/** After the platform refused even a freshly rotated Atum account token: no rotation on its
 * refusals for this long (readDomain). Seven agents' renewals must not rotate it in a loop. */
const DOMAIN_REFUSED_MS = 5 * 60_000
/** A returning person's Atum account sign-in proves itself with one rotation before the browser
 * opens; one that takes longer is asked for again in the same trip instead. */
const DOMAIN_PROOF_MS = 5_000
/** A sign-in, or connecting the Atum account, waits this long for grants nobody holds to be
 * revoked before it opens the browser; the rest go on behind it (each can take ten seconds). */
const REVOCATION_DRAIN_WAIT_MS = 2_000

/** The local key between one Hermes executor and the loopback model proxy: derived from
 * that enrollment's storage key, so every agent's executor has its own. */
export function matrixManagedModelKey(storageKey: string): string {
  return createHmac('sha256', Buffer.from(storageKey, 'base64')).update('atum-managed-model-v1').digest('hex')
}

/** How long the chained domain step may take after the Matrix callback (normally seconds). */
const DOMAIN_SAME_TRIP_MS = 60_000
/** At the sign-in's callback, how long the chained Atum account step may take to be ready. */
const DOMAIN_CONTINUE_WAIT_MS = 2_000
/** Quick retries while preparing the domain authorization. */
const DOMAIN_PREPARE_RETRY_MS = [250, 1_000] as const

/**
 * The sign-in server refusing the grant itself: the only answer that ends a session. At MAS 1.24
 * that is `invalid_grant` (token.rs:243-252: an unknown, replayed or mismatched refresh token, a
 * finished session). `invalid_client` means MAS did not recognise this app (token.rs:202-205), a
 * deploy or configuration problem on its side: a passing refusal, asked again later.
 */
function sessionEndCause(error: unknown): MatrixSessionEndCause | undefined {
  return error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant'
    ? 'refresh_rejected:invalid_grant'
    : undefined
}

/** The promise's value within `ms`, else undefined; a value that arrives later goes to `late`. */
async function within<T>(promise: Promise<T>, ms: number, late: (value: T) => void = () => {}): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false

  try {
    return await Promise.race([
      promise.then(value => {
        if (settled) {
          late(value)

          return undefined
        }

        return value
      }),
      new Promise<undefined>(resolve => (timer = setTimeout(() => resolve(undefined), ms)))
    ])
  } finally {
    settled = true
    clearTimeout(timer)
  }
}

/** Whether the promise fulfils within `ms`; a rejection or the deadline is false. */
async function succeedsWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false
      ),
      new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(false), ms)))
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the sign-in server takes new accounts by email: its discovery lists `prompt=create`
 * only while password registration is on (MAS discovery.rs:142-148). */
function takesRegistration(config: oidc.Configuration): boolean {
  try {
    const prompts = config.serverMetadata().prompt_values_supported

    return Array.isArray(prompts) && prompts.includes('create')
  } catch {
    return false
  }
}

export class MatrixAccount {
  private configurations = new Map<string, Promise<oidc.Configuration>>()
  private login?: { cancel: () => void }
  private refreshPending?: Promise<MatrixRefreshResult>
  private domainRefreshPending?: Promise<DomainGrant>
  private enrollmentPending = new Map<string, Promise<MatrixEnrollment>>()
  private enrollmentSelections = new Map<string, AppEnrollmentSelection | undefined>()
  private withdrawingApps = new Map<string, Promise<MatrixAppEnrollment>>()
  private enrollmentRevocationPending = new Map<string, Promise<void>>()
  /** An agent's credential renewal in flight (renewAgentExecutor), by participant. */
  private renewalPending = new Map<string, Promise<MatrixEnrollment>>()
  /** Until when the platform asked an agent's enrollments to wait (0150, Retry-After), by
   * account and participant. In memory: a restart asks once and is told again. */
  private enrollmentWaits = new Map<string, number>()
  /** The sign-in server refused the Atum account grant (invalid_grant) this run. Only the
   * person connecting it again replaces it (readDomain, interactive). */
  private domainRevoked = false
  /** The platform refused this Atum account sign-in's freshly rotated token (readDomain). */
  private domainRefused?: { sessionId: string; until: number }
  private revocationsPending?: Promise<void>
  /** Coalesce a background renewal outage until a lease succeeds again. */
  private leaseFailureCode?: 'authentication' | 'unavailable'
  private generation = 0
  private ownerRepair?: { cancelled: boolean; committed: boolean }
  private handle = randomUUID()
  /** The sign-in server ended the chat session in this run (also kept on the record when the
   * vault can take it: `sessionEnded`). The only thing that closes chat access short of the
   * person signing out. */
  private ended?: MatrixSessionEnd
  /** The chat sign-in's last rotation, which the vault could not keep yet (HeldRotation). */
  private held?: HeldRotation
  /** The same for the Atum account sign-in, by its sessionId. */
  private heldDomain?: DomainGrant
  private heldRetry?: ReturnType<typeof setTimeout>
  private heldAttempts = 0
  /** The closed code of the held rotations' last failed save (heldCause). */
  private heldFailure?: string
  /** An agent's renewed credential the vault could not keep, by participant key, with the
   * credential it replaces: saved by that agent's next renewal before anything is re-issued. */
  private heldAgents = new Map<string, HeldAgentCredential>()
  /** The last passing refresh failure logged per sign-in: an outage is one line, not one a try. */
  private refreshFailures: Partial<Record<MatrixAccountClient, string>> = {}
  private orphanReconcile?: Promise<{ attempted: boolean; cleared: number; remaining: number }>
  /** A38: one acknowledged time zone per account, carried by the roster read. */
  private readonly timeZoneReports: OwnerTimeZoneReports
  /** atum.owner-language/1: one acknowledged language per account, on the same roster read. */
  private readonly languageReports: OwnerLanguageReports

  constructor(
    private readonly config: MatrixConfig,
    private readonly store: EncryptedStore,
    private readonly openBrowser: (url: string) => Promise<void>,
    /** Stops the agent's backend and clears its Hermes credentials; `agent` is undefined
     * for the default agent. */
    private readonly clearLocalHermes: (home: string, agent?: string) => Promise<void> = async () => {
      throw new Error('matrix_local_cleanup_pending')
    },
    private readonly clearAppDevice: (slug: string, identity: MatrixIdentity) => Promise<void> = async () => {
      throw new Error('matrix_local_cleanup_pending')
    },
    /** Every sign-in this Mac ends, revokes or fails to keep, with its cause (account-events.ts). */
    private readonly log: (event: MatrixAccountEvent) => void = () => {},
    private readonly hooks: MatrixAccountHooks = {}
  ) {
    this.timeZoneReports = new OwnerTimeZoneReports({
      store: this.store,
      scope: () => this.appScope(),
      zone: () => currentIanaTimeZone()
    })
    this.languageReports = new OwnerLanguageReports({
      store: this.store,
      scope: () => this.appScope(),
      language: () => this.hooks.ownerLanguage?.()
    })
  }

  private oidc(clientId = this.config.nativeClientId) {
    let configuration = this.configurations.get(clientId)

    if (!configuration) {
      configuration = oidc
        .discovery(new URL(this.config.issuer), clientId, undefined, oidc.None(), {
          execute: this.config.issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
          timeout: 10
        })
        .catch(() => {
          this.configurations.delete(clientId)
          throw new Error('matrix_identity_unavailable')
        })
      this.configurations.set(clientId, configuration)
    }

    return configuration
  }

  private read(): AccountRecord | null {
    const raw = this.store.getItem('matrix-account')

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    if (!raw) {
      return null
    }

    const record = JSON.parse(raw) as AccountRecord

    if (
      record.version !== 1 ||
      record.configurationKey !== matrixConfigurationKey(this.config) ||
      record.issuer !== this.config.issuer ||
      !record.subject ||
      !record.userId?.startsWith('@') ||
      !record.deviceId ||
      !record.accessToken ||
      !record.refreshToken ||
      Buffer.from(record.storageKey ?? '', 'base64').length !== 32
    ) {
      throw new Error('matrix_vault_invalid')
    }

    return record
  }

  /**
   * Saves the record. A full disk (`auth_storage_disk_full`) gets the room kept for this
   * (disk-reserve.ts) and one more try; any other failure, or no room kept, throws as it is. A save that lands keeps the
   * reserve made (at most every few minutes, and only with room to spare).
   */
  private write(record: AccountRecord) {
    const value = JSON.stringify(record)

    try {
      this.store.setItem('matrix-account', value)
    } catch (error) {
      if (this.store.failureCode() !== 'auth_storage_disk_full' || !this.hooks.reserve?.release()) {
        throw error
      }

      this.log({ event: 'disk_reserve_used' })
      this.store.setItem('matrix-account', value)
    }

    this.hooks.reserve?.ensure()
  }

  /** Whether the chat session on this record is over: ended by the sign-in server, this run or
   * an earlier one. */
  private sessionOver(record: AccountRecord): boolean {
    return Boolean(record.sessionEnded ?? this.ended)
  }

  identity(): MatrixIdentity | null {
    const record = this.read()

    return record && !record.signingOut && !this.sessionOver(record)
      ? { userId: record.userId, deviceId: record.deviceId }
      : null
  }

  /**
   * When the sign-in server ended the chat session saved here, if it did: the account stays on
   * this Mac, signed out, until the same person signs in again (signIn keeps everything else).
   * Null for a live session, no account, or a sign-out in progress.
   */
  sessionEnded(): MatrixSessionEnd | null {
    const record = this.read()

    return record && !record.signingOut ? (record.sessionEnded ?? this.ended ?? null) : null
  }

  /** Main-only identity facts from the verified MAS grant. Never a Drive bearer. */
  driveOwner(): { issuer: string; subject: string; generation: number } | null {
    const record = this.read()

    return record && this.identity()
      ? { issuer: record.issuer, subject: record.subject, generation: this.generation }
      : null
  }

  /** Main-only; the visible renderer receives the remembered key only through the person's
   * own request to write it down (`revealRecoveryKey`). A key the person saw or typed clears
   * the device-only mark; one made quietly on this first Mac carries `custody: 'device'`. */
  recoveryKey(expected: MatrixIdentity, validatedKey?: string, custody?: 'device'): string | undefined {
    const record = this.currentRecord(expected)

    if (validatedKey !== undefined) {
      if (typeof validatedKey !== 'string' || !validatedKey || validatedKey.length > 256) {
        throw new Error('matrix_recovery_invalid')
      }

      const { ownerRecoveryCustody: _previous, ...rest } = record
      this.write({ ...rest, ownerRecoveryKey: validatedKey, ...(custody === 'device' ? { ownerRecoveryCustody: custody } : {}) })
    }

    return validatedKey ?? record.ownerRecoveryKey
  }

  /** `device` while the remembered key lives only on this Mac (never written down). */
  recoveryCustody(expected: MatrixIdentity): 'device' | undefined {
    const record = this.currentRecord(expected)

    return record.ownerRecoveryKey && record.ownerRecoveryCustody === 'device' ? 'device' : undefined
  }

  /** The remembered key, for the person to write down (Settings, or before signing out). */
  revealRecoveryKey(expected: MatrixIdentity): string {
    const key = this.currentRecord(expected).ownerRecoveryKey

    if (!key) {
      throw new Error('matrix_recovery_unavailable')
    }

    return key
  }

  /** The person confirmed they wrote the key down: it is no longer this Mac's alone. */
  recoveryWritten(expected: MatrixIdentity): void {
    const record = this.currentRecord(expected)

    if (!record.ownerRecoveryKey) {
      throw new Error('matrix_recovery_unavailable')
    }

    if (record.ownerRecoveryCustody) {
      const { ownerRecoveryCustody: _done, ...rest } = record
      this.write(rest)
    }
  }

  /** Forget the key on this Mac (owner-keys.ts `forgetMatrixOwnerKey`): the record's copy and
   * its mark go; nothing else changes. */
  forgetRecoveryKey(expected: MatrixIdentity): void {
    const record = this.currentRecord(expected)

    if (record.ownerRecoveryKey === undefined && record.ownerRecoveryCustody === undefined) {
      return
    }

    const { ownerRecoveryKey: _key, ownerRecoveryCustody: _custody, ...rest } = record
    this.write(rest)
  }

  private currentRecord(expected: MatrixIdentity): AccountRecord {
    const current = this.identity()
    const record = this.read()

    if (!current || !record || current.userId !== expected.userId || current.deviceId !== expected.deviceId) {
      throw new Error('matrix_recovery_stale')
    }

    return record
  }

  /** Exact native enrollment only; never accepts a caller's owner or Matrix user. */
  async agentIdentity(executorId: string): Promise<boolean> {
    const generation = this.generation
    const record = this.domainOwner()
    const enrolled = allParticipants(record).find(value => value?.executorId === executorId)

    if (!enrolled || enrolled.app || enrolled.state !== 'ready' || !enrolled.credential) {
      throw new Error('matrix_agent_identity_invalid')
    }

    const expected = enrolled.credential
    const response = await requestAgentIdentity(this.config.domain!.resource, await this.agentGrant(), executorId)
    const current = this.domainOwner()
    const still = allParticipants(current).find(value => value?.executorId === executorId)

    if (
      generation !== this.generation ||
      current.storageKey !== record.storageKey ||
      still?.state !== 'ready' ||
      still.credential?.deviceId !== expected.deviceId ||
      still.credential?.userId !== expected.userId
    ) {
      throw new Error('matrix_agent_identity_stale')
    }

    const value = response as {
      initializer?: unknown
      executorId?: unknown
      agentPrincipal?: unknown
      userId?: unknown
      deviceId?: unknown
    } | null

    if (
      !value ||
      typeof value.initializer !== 'boolean' ||
      value.executorId !== executorId ||
      value.agentPrincipal !== expected.agentPrincipal ||
      value.userId !== expected.userId ||
      value.deviceId !== expected.deviceId
    ) {
      throw new Error('matrix_agent_identity_invalid')
    }

    return value.initializer
  }

  /**
   * Opens the sign-in server's own page for ending one device's session, in the browser: the
   * discovered account-management address with exactly MSC4191's `org.matrix.device_delete` action
   * and that device. The server signs the person in first if the browser has no session, then shows
   * that session with one confirmed button. Never the session list, the profile or anything else of
   * the account app, and no Atum session authority.
   */
  async endDeviceSession(deviceId?: unknown): Promise<void> {
    if (typeof deviceId !== 'string' || !END_DEVICE_SESSION_ID.test(deviceId)) {
      throw new Error('matrix_command_invalid')
    }

    if (!this.identity()) {
      throw new Error('matrix_signed_out')
    }

    const generation = this.generation
    const metadata = (await this.oidc()).serverMetadata()
    const raw = metadata.account_management_uri

    if (typeof raw !== 'string') {
      throw new Error('matrix_account_management_unavailable')
    }

    const url = new URL(raw)
    const issuer = new URL(this.config.issuer)

    // No renderer URL, credentials, or cross-origin discovery redirect.
    if (url.origin !== issuer.origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
      throw new Error('matrix_account_management_invalid')
    }

    const actions = metadata.account_management_actions_supported

    if (!Array.isArray(actions) || !actions.includes(END_DEVICE_SESSION_ACTION)) {
      throw new Error('matrix_account_management_unavailable')
    }

    // Exactly the action and the device: whatever else the discovered address carried is dropped.
    url.search = ''
    url.hash = ''
    url.searchParams.set('action', END_DEVICE_SESSION_ACTION)
    url.searchParams.set('device_id', deviceId)

    if (generation !== this.generation || !this.identity()) {
      throw new Error('matrix_signed_out')
    }

    await this.openBrowser(url.href)
  }

  signOutPending(): boolean {
    return Boolean(this.read()?.signingOut)
  }

  /** Main derives this path from the frozen runtime + enrollment, before any
   * provider write. Retain the actual location across runtime configuration
   * changes, token renewal, remote revocation and interrupted cleanup. */
  retainHermesProfile(home: string, agent?: string) {
    if (agent !== undefined) {
      this.retainAgentHermesProfile(home, agent)

      return
    }

    const record = this.domainOwner()
    const enrollment = record.enrollment

    if (enrollment?.state !== 'ready' || record.localHermes?.cleanupPending) {
      throw new Error('matrix_agent_unavailable')
    }

    if (record.localHermes) {
      if (record.localHermes.home !== home || record.localHermes.executorId !== enrollment.executorId) {
        throw new Error('matrix_local_cleanup_pending')
      }

      return
    }

    this.write({ ...record, localHermes: { home, executorId: enrollment.executorId } })
  }

  private retainAgentHermesProfile(home: string, agent: string) {
    const record = this.domainOwner()
    const enrollment = participant(record, { agent })
    const retained = record.agentHermes?.[agent]

    if (enrollment?.state !== 'ready' || retained?.cleanupPending) {
      throw new Error('matrix_agent_unavailable')
    }

    if (retained) {
      if (retained.home !== home || retained.executorId !== enrollment.executorId) {
        throw new Error('matrix_local_cleanup_pending')
      }

      return
    }

    this.write({
      ...record,
      agentHermes: { ...record.agentHermes, [agent]: { home, executorId: enrollment.executorId } }
    })
  }

  /** The home retained for the root custody slot's current executor. None while cleanup waits. */
  retainedHermesProfile(): { home: string; executorId: string } | undefined {
    const retained = this.domainOwner().localHermes

    return retained && !retained.cleanupPending ? { home: retained.home, executorId: retained.executorId } : undefined
  }

  /** The home this Mac retains for another agent's executor, read only (agent-home.ts reads it
   * before the home is retained again). None while its cleanup is pending. */
  retainedAgentHermes(agent: string): { home: string; executorId: string } | undefined {
    const retained = this.domainOwner().agentHermes?.[agent]

    return retained && !retained.cleanupPending ? { home: retained.home, executorId: retained.executorId } : undefined
  }

  /** Every Hermes home this Mac retains, the default agent's included: none of them may become
   * another agent's home. */
  retainedHermesHomes(): string[] {
    const record = this.domainOwner()

    return [record.localHermes?.home, ...Object.values(record.agentHermes ?? {}).map(value => value.home)].filter(
      (home): home is string => typeof home === 'string'
    )
  }

  /** Another agent's current executor moves to the home that is the agent's own (agent-home.ts):
   * the same rules as retaining, from exactly the home retained now. Its revocation then clears
   * the credentials in the new home, where its Hermes runs. */
  rebindAgentHermesProfile(agent: string, executorId: string, from: string, to: string) {
    const record = this.domainOwner()
    const enrollment = participant(record, { agent })
    const retained = record.agentHermes?.[agent]

    if (
      enrollment?.state !== 'ready' ||
      enrollment.executorId !== executorId ||
      !retained ||
      retained.cleanupPending ||
      retained.executorId !== executorId ||
      retained.home !== from ||
      !path.isAbsolute(to)
    ) {
      throw new Error('matrix_local_cleanup_pending')
    }

    if (from !== to) {
      this.write({ ...record, agentHermes: { ...record.agentHermes, [agent]: { home: to, executorId } } })
    }
  }

  /**
   * The root custody slot adopts the stable home bound to its agent (agent-home.ts), under
   * the same exact-executor/from-path fence as a named agent. The enrollment and credentials
   * stay root-owned; only the retained local home changes.
   */
  rebindHermesProfile(executorId: string, from: string, to: string) {
    const record = this.domainOwner()
    const enrollment = record.enrollment
    const retained = record.localHermes

    if (
      enrollment?.state !== 'ready' ||
      enrollment.executorId !== executorId ||
      !retained ||
      retained.cleanupPending ||
      retained.executorId !== executorId ||
      retained.home !== from ||
      !path.isAbsolute(to)
    ) {
      throw new Error('matrix_local_cleanup_pending')
    }

    if (from !== to) {
      this.write({ ...record, localHermes: { home: to, executorId } })
    }
  }

  cancel() {
    this.generation++
    this.login?.cancel()
    this.login = undefined
  }

  /** Which sign-in a client id belongs to, for the log. */
  private clientOf(clientId: string): MatrixAccountClient {
    return clientId === this.config.domain?.nativeClientId ? 'domain' : 'matrix'
  }

  /**
   * Revokes a grant nobody holds any more, for a deliberate change only (`reason`): a cancelled
   * or mismatched sign-in, an account replaced or signed out while it rotated. Never for a
   * grant the vault failed to save: that one is the live session (refreshOnce).
   */
  private async discard(
    grant: NativeGrant,
    reason: MatrixGrantRevocationReason,
    clientId = this.config.nativeClientId,
    onlyThisGrant = false
  ) {
    this.log({ event: 'grant_revoked', client: this.clientOf(clientId), reason })

    // Queue before network: cancellation can outlive the callback/browser. Never
    // silently forget an issued credential when the provider is temporarily down.
    try {
      this.queueRevocation(grant, clientId)
    } catch {
      // If the vault itself failed, still attempt provider cleanup immediately.
      // Never report that a credential was durably queued when it was not.
      await this.revoke({ ...grant, clientId })

      return
    }

    await this.drainRevocations(onlyThisGrant ? [grant] : undefined)
  }

  private queueRevocation(grant: NativeGrant, clientId = this.config.nativeClientId) {
    const previous = this.store.getItem('matrix-revocations')

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    const pending = previous ? (JSON.parse(previous) as Revocation[]) : []

    if (!pending.some(item => item.accessToken === grant.accessToken && item.refreshToken === grant.refreshToken)) {
      pending.push({
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        issuer: grant.issuer,
        subject: grant.subject,
        clientId
      })
    }

    this.store.setItem('matrix-revocations', JSON.stringify(pending))
  }

  private async revoke(grant: Revocation) {
    const config = await this.oidc(grant.clientId)
    await Promise.all([
      ...(grant.refreshToken
        ? [oidc.tokenRevocation(config, grant.refreshToken, { token_type_hint: 'refresh_token' })]
        : []),
      oidc.tokenRevocation(config, grant.accessToken, { token_type_hint: 'access_token' })
    ])
  }

  drainRevocations(only?: readonly NativeGrant[]): Promise<void> {
    // Each caller queues a drain after the current one, including callers that
    // append while a provider request is in flight. A failure retains the queue.
    const pending = (this.revocationsPending ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.drainRevocationsOnce(only))

    this.revocationsPending = pending

    return pending.finally(() => {
      if (this.revocationsPending === pending) {
        this.revocationsPending = undefined
      }
    })
  }

  private async drainRevocationsOnce(only?: readonly NativeGrant[]) {
    const raw = this.store.getItem('matrix-revocations')

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    if (!raw) {
      return
    }

    const same = (a: NativeGrant, b: NativeGrant) => a.accessToken === b.accessToken && a.refreshToken === b.refreshToken
    // A device repair cleans up only its own replaced/discarded human grants. Existing
    // queued domain or other-session revocations remain the ordinary drain's responsibility.
    const pending = (JSON.parse(raw) as Revocation[]).filter(grant => !only || only.some(item => same(item, grant)))
    // Each entry on its own: one the server keeps refusing never holds up the rest.
    const failed: Array<{ grant: Revocation; error: unknown }> = []

    for (const grant of pending) {
      try {
        await this.revoke(grant)
      } catch (error) {
        failed.push({ grant, error })
      }
    }

    const current = this.store.getItem('matrix-revocations')

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    let retained: { error: unknown } | undefined

    const remaining = (current ? (JSON.parse(current) as Revocation[]) : []).flatMap(grant => {
      const failure = failed.find(item => same(item.grant, grant))

      if (!failure) {
        // Revoked now, or queued while this drain ran (the next drain takes it).
        return pending.some(done => same(done, grant)) ? [] : [grant]
      }

      const attempts = (grant.attempts ?? 0) + 1
      const cause = matrixRefreshFailureCause(failure.error)
      const oauth = matrixOAuthRefusal(failure.error)

      if (attempts >= (oauth ? REVOCATION_REFUSED_ATTEMPTS : REVOCATION_UNANSWERED_ATTEMPTS)) {
        this.log({
          event: 'revocation_dropped',
          client: this.clientOf(grant.clientId ?? this.config.nativeClientId),
          cause,
          ...(oauth ? { oauth } : {}),
          attempts
        })

        return []
      }

      retained ??= failure

      return [{ ...grant, attempts }]
    })

    if (remaining.length) {
      this.store.setItem('matrix-revocations', JSON.stringify(remaining))
    } else {
      this.store.removeItem('matrix-revocations')
    }

    // Still queued: a caller that must know (a sign-out) hears why; the rest go on regardless.
    if (retained) {
      throw retained.error
    }
  }

  /**
   * Whether the sign-in server takes email sign-in (sign-in-entry.ts), for the sign-in
   * window's ways in. A throwaway authorization of this app's own, never opened in a browser
   * and never answered: nothing listens on its callback, and MAS lets the grant expire.
   */
  async emailSignIn(): Promise<MatrixEmailSignIn> {
    try {
      const config = await this.oidc()

      const authorizationUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: `http://127.0.0.1:${this.config.callbackPort}/callback`,
        response_type: 'code',
        scope: 'openid',
        state: oidc.randomState(),
        code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()),
        code_challenge_method: 'S256'
      }).href

      return await matrixEmailSignIn({ authorizationUrl })
    } catch {
      return 'unknown'
    }
  }

  /**
   * Sign in through the browser, one trip for both grants, like the old app. `method` picks
   * the way in (sign-in-entry.ts): Google's account picker, MAS's sign-in page, or its
   * registration form.
   *
   * The moment the browser comes back (the Matrix callback, before its code is redeemed), the
   * app is brought to the front (`hooks.returned`): "Atum OAuth, then right back to Atum". The
   * same tab continues into the domain authorization behind it, which MAS completes from the
   * session it just made (its consent page continues by itself for Atum's own apps). That
   * authorization is prepared while the person is in the browser, and the callback waits at most
   * two seconds for it. The browser is never opened a second time over the app: an Atum account
   * step that did not finish in the tab is left for setup to ask about in the window, with one
   * click. Resolves once Matrix is signed in, saying whether the domain grant is in; nothing
   * after the Matrix commit fails the sign-in.
   *
   * Over a chat session the sign-in server ended (`sessionEnded`), the same person signs in
   * again on the same record: new tokens, a new device and a new storage key, and everything
   * else this Mac keeps for them stays: the Atum account sign-in (only once a rotation of it
   * lands now; otherwise it is asked for again in the same trip), the agents with their homes,
   * and the remembered recovery key, so the new device restores its keys by itself. The grants
   * it replaced are revoked behind it. Another person's account is refused
   * (`matrix_account_mismatch`): signing out first is how to switch. `replaced` is the ended
   * device, whose local data main clears.
   */
  async signIn(method: MatrixSignInMethod = 'google'): Promise<{ domain: boolean; replaced?: MatrixIdentity }> {
    if (this.ownerRepair) {
      throw new Error('matrix_operation_pending')
    }

    return this.signInOwner(method)
  }

  /**
   * Main-only, explicit repair of the HUMAN device identified by the device ledger.
   * The caller checks damage; this boundary checks ownership again. Never mark a healthy
   * grant rejected, sign out, rotate the domain grant, or touch participant custody.
   * Only the same issuer/subject/Matrix user may replace the human grant atomically.
   */
  async repairOwnerDevice(
    expected: MatrixIdentity,
    method: MatrixSignInMethod = 'google'
  ): Promise<{ domain: boolean; replaced: MatrixIdentity }> {
    if (this.ownerRepair || this.login) {
      throw new Error('matrix_operation_pending')
    }
    if (method !== 'google' && method !== 'email') {
      throw new Error('matrix_owner_repair_method_invalid')
    }
    this.currentRecord(expected)
    this.assertOwnerRepairIdle()
    const repair = { cancelled: false, committed: false }
    this.ownerRepair = repair

    try {
      const result = await this.signInOwner(method, expected)

      return { ...result, replaced: { userId: expected.userId, deviceId: expected.deviceId } }
    } finally {
      if (this.ownerRepair === repair) {
        this.ownerRepair = undefined
      }
    }
  }

  /** Cancel just the repair's browser trip; agent operations retain their generation. */
  cancelOwnerDeviceRepair(): void {
    if (this.ownerRepair && !this.ownerRepair.committed) {
      this.ownerRepair.cancelled = true
      this.login?.cancel()
    }
  }

  private assertOwnerRepairIdle(): void {
    // A rotation/issuance already at the provider must land on its original record first.
    // Refuse this repair instead of cancelling that work or losing a held agent credential.
    if (
      this.enrollmentPending.size ||
      this.renewalPending.size ||
      this.enrollmentRevocationPending.size ||
      this.withdrawingApps.size ||
      this.heldAgents.size ||
      this.refreshPending ||
      this.domainRefreshPending ||
      this.heldDomain
    ) {
      throw new Error('matrix_owner_repair_busy')
    }
  }

  private async signInOwner(
    method: MatrixSignInMethod,
    repairOwner?: MatrixIdentity
  ): Promise<{ domain: boolean; replaced?: MatrixIdentity }> {
    this.store.assertEncryptionAvailable()
    const saved = this.read()
    const ended = saved && !saved.signingOut && (repairOwner || this.sessionOver(saved)) ? saved : null

    if (saved && !ended) {
      throw new Error('matrix_sign_out_first')
    }

    if (repairOwner) {
      this.currentRecord(repairOwner)
    } else {
      this.cancel()
    }
    const generation = this.generation
    const repair = this.ownerRepair
    const cancelled = () => generation !== this.generation || Boolean(repair?.cancelled)
    // Grants nobody holds, revoked first; one the server keeps refusing, or never answers, never
    // holds up a sign-in: after two seconds the browser opens and the drain goes on behind it.
    if (!repairOwner) {
      await within(this.drainRevocations().catch(() => {}), REVOCATION_DRAIN_WAIT_MS)
    }
    const config = await this.oidc()

    if (cancelled()) {
      throw new Error('matrix_login_cancelled')
    }

    const deviceId = `ATUM_${randomBytes(12).toString('hex')}`

    // A returning person skips the Atum account step only when their sign-in proves itself now: a
    // rotation the sign-in server accepts and the vault keeps. A missing, refused, held or slow
    // one is asked for again in the same trip, as at a first sign-in. Asking is all this decides:
    // the record drops the old sign-in only once the server refused it (domainRevoked, in
    // memory: after a restart only asking tells); otherwise it is replaced, and revoked, only by
    // the new one landing (domainAuthorization's commit). An unreachable server is not a refusal.
    // Repair keeps the domain grant exactly as it is; proving/rotating that independent
    // authorization is deliberately left to its normal lifecycle.
    const keepsDomain = repairOwner
      ? this.holdsDomain()
      : Boolean(ended?.domain) &&
        !this.domainRevoked &&
        Boolean(
          await within(
            this.refreshDomain().then(
              () => true,
              () => false
            ),
            DOMAIN_PROOF_MS
          )
        )

    if (cancelled()) {
      throw new Error('matrix_login_cancelled')
    }

    // Prepared while the person is in the browser, not before it opens. Registration, email
    // verification and upstream MFA all happen before the tab gets back, so the chained step
    // keeps the Matrix sign-in's own fifteen minutes.
    // Over an ended session the step may replace an Atum account sign-in the server refuses while
    // the person is in the browser (a slow proof): it is the person's own sign-in, as Connect is.
    const domainReady =
      !repairOwner && this.config.domain && !keepsDomain
        ? this.prepareDomain(generation, 15 * 60_000, Boolean(ended))
        : undefined

    let domain: Awaited<ReturnType<MatrixAccount['prepareDomain']>>
    let mismatch = false
    const replacedGrants: NativeGrant[] = []
    let login: Awaited<ReturnType<typeof authorizeNative<AccountRecord>>>

    try {
      login = await authorizeNative<AccountRecord>({
        config,
        issuer: this.config.issuer,
        port: this.config.callbackPort,
        scope: `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`,
        ...(method === 'create' ? { prompt: 'create' as const } : {}),
        prepare: async grant => {
          const response = await fetch(`${this.config.server}/_matrix/client/v3/account/whoami`, {
            headers: { Authorization: `Bearer ${grant.accessToken}` },
            redirect: 'error',
            signal: AbortSignal.timeout(10000)
          })

          if (!response.ok) {
            throw new Error('matrix_identity_unavailable')
          }

          const identity = (await response.json()) as { user_id?: string; device_id?: string }

          if (!identity.user_id?.startsWith('@') || identity.device_id !== deviceId) {
            throw new Error('matrix_identity_invalid')
          }

          return {
            ...grant,
            version: 1,
            configurationKey: matrixConfigurationKey(this.config),
            userId: identity.user_id,
            deviceId,
            storageKey: randomBytes(32).toString('base64')
          }
        },
        commit: record => {
          if (cancelled()) {
            throw new Error('matrix_login_cancelled')
          }

          if (repairOwner) {
            this.assertOwnerRepairIdle()
          }
          const resumed = ended
            ? this.resumedRecord(ended, record, () => (mismatch = true), Boolean(repairOwner))
            : { record }
          const held = this.held?.storageKey === ended?.storageKey ? this.held : undefined

          try {
            this.write(resumed.record)
          } catch (error) {
            // Nothing keeps this grant now: the caller revokes it (discard). Say why first.
            this.log({
              event: 'credential_save_failed',
              client: 'matrix',
              code: this.store.failureCode() ?? matrixClosedCode(error)
            })

            throw error
          }

          if (repair) {
            repair.committed = true
          }
          this.ended = undefined
          this.held = undefined

          // Only an Atum account sign-in the record no longer holds takes its state with it.
          if (!resumed.record.domain) {
            this.domainRevoked = false
            this.domainRefused = undefined
            this.heldDomain = undefined
          }

          // A proof rotation the vault could not keep is saved now that it took a write (else
          // retried as before): never left unsaved and unrevoked at the sign-in server.
          this.saveHeld()
          this.handle = randomUUID()

          // The ended grant, and an Atum account sign-in the server refused, belong to nobody now:
          // revoked behind the new one, best effort (MAS answers 200 to a grant already dead).
          if (resumed.replaced) {
            replacedGrants.push(resumed.replaced)
            this.queueReplaced(resumed.replaced, this.config.nativeClientId)
            if (held) {
              replacedGrants.push({ ...resumed.replaced, ...held })
              this.queueReplaced({ ...resumed.replaced, ...held }, this.config.nativeClientId)
            }
          }

          for (const dropped of resumed.droppedDomain ?? []) {
            this.queueReplaced(dropped, this.config.domain!.nativeClientId)
          }
        },
        discard: grant =>
          this.discard(
            grant,
            mismatch ? 'account_mismatch' : 'sign_in_cancelled',
            this.config.nativeClientId,
            Boolean(repairOwner)
          ),
        // The person is back: the app comes to the front before the code is even redeemed, and
        // everything after plays behind it (the second consent page included).
        onCallback: () => this.hooks.returned?.(),
        // Then the same tab goes on to the Atum account step if it is ready within two seconds;
        // otherwise the tab ends on Atum's signed-in page and setup asks in the app.
        continueTo: async () => {
          domain ??= domainReady
            ? await within(domainReady, DOMAIN_CONTINUE_WAIT_MS, late => late?.cancel())
            : undefined

          return domain?.authorizationUrl
        }
      })
    } catch (error) {
      void domainReady?.then(late => late?.cancel())
      throw error
    }

    // Cancels the Atum account step too, prepared or still being prepared.
    const flight = {
      cancel: () => {
        login.cancel()
        domain?.cancel()
        void domainReady?.then(late => late?.cancel())
      }
    }

    if (cancelled()) {
      flight.cancel()
      throw new Error('matrix_login_cancelled')
    }

    this.login = flight

    try {
      try {
        const entry = await matrixSignInEntry({
          authorizationUrl: login.authorizationUrl,
          method,
          registration: takesRegistration(config)
        })

        if (cancelled()) {
          throw new Error('matrix_login_cancelled')
        }

        await this.openBrowser(entry)
        await login.completed

        if (cancelled()) {
          throw new Error('matrix_login_cancelled')
        }
      } catch (error) {
        flight.cancel()
        // The browser's own failure page says nothing about whose account it was: say it here.
        throw mismatch ? new Error('matrix_account_mismatch') : error
      }

      const replaced = ended ? { replaced: { userId: ended.userId, deviceId: ended.deviceId } } : {}

      if (ended) {
        void this.drainRevocations(repairOwner ? replacedGrants : undefined).catch(() => {})
      }

      // A returning person's Atum account sign-in carried over, proved a moment ago, if the record
      // still holds it: a refusal can land between the proof and the commit.
      if (keepsDomain) {
        return { domain: this.holdsDomain(), ...replaced }
      }

      // Matrix is signed in. The chained step normally lands within seconds.
      if (domain && (await succeedsWithin(domain.completed, DOMAIN_SAME_TRIP_MS))) {
        return { domain: true, ...replaced }
      }

      // Never a second browser trip over the app: setup asks for the Atum account in the window,
      // with one click (the person's own step, main.ts).
      domain?.cancel()
      void domainReady?.then(late => late?.cancel())

      return { domain: false, ...replaced }
    } finally {
      if (this.login === flight) {
        this.login = undefined
      }
    }
  }

  /**
   * The ended record, resumed by a new sign-in of the same person (signIn's commit): the new
   * grant's tokens, device and storage key over everything this Mac keeps for them. Another
   * person's grant, or a record that changed since the sign-in began, is refused (the grant is
   * then revoked by the caller's discard). Also says which grants the new record no longer
   * holds: the ended chat grant, and the Atum account sign-in only when the sign-in server
   * refused it (with a rotation of it still held). Any other Atum account sign-in stays until
   * a new one is saved in its place: a sign-in that could not prove itself because the server
   * was unreachable, slow or the disk full is still the person's only one.
   */
  private resumedRecord(
    ended: AccountRecord,
    grant: AccountRecord,
    mismatched: () => void,
    repairOwner = false
  ): { record: AccountRecord; replaced?: NativeGrant; droppedDomain?: DomainGrant[] } {
    const current = this.read()

    if (
      !current ||
      current.signingOut ||
      current.storageKey !== ended.storageKey ||
      current.deviceId !== ended.deviceId ||
      current.userId !== ended.userId ||
      current.issuer !== ended.issuer ||
      current.subject !== ended.subject ||
      (!repairOwner && !this.sessionOver(current))
    ) {
      throw new Error('matrix_login_cancelled')
    }

    if (grant.issuer !== current.issuer || grant.subject !== current.subject || grant.userId !== current.userId) {
      mismatched()

      throw new Error('matrix_account_mismatch')
    }

    const { sessionEnded: _ended, domain: retained, ...kept } = current
    const dropped = !repairOwner && retained && this.domainRevoked ? retained : undefined
    const heldDropped = dropped && this.heldDomain?.sessionId === dropped.sessionId ? this.heldDomain : undefined

    return {
      record: {
        ...kept,
        ...(retained && !dropped ? { domain: retained } : {}),
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        deviceId: grant.deviceId,
        storageKey: grant.storageKey
      },
      replaced: current,
      ...(dropped ? { droppedDomain: heldDropped ? [dropped, heldDropped] : [dropped] } : {})
    }
  }

  /** A grant a new sign-in of the same person replaced, revoked behind it, best effort. */
  private queueReplaced(grant: NativeGrant, clientId: string) {
    try {
      this.queueRevocation(grant, clientId)
      this.log({ event: 'grant_revoked', client: this.clientOf(clientId), reason: 'session_replaced' })
    } catch {
      // The vault can't queue it now. The grant may still be live (an Atum account sign-in a new
      // one replaced without the server refusing it): revoked now, once, best effort.
      void this.revoke({ ...grant, clientId }).catch(() => {})
    }
  }

  /** Whether the record holds an Atum account sign-in the server has not refused; an unreadable
   * vault says no (a sign-in's result, which nothing after its commit fails). */
  private holdsDomain(): boolean {
    try {
      return Boolean(this.read()?.domain) && !this.domainRevoked
    } catch {
      return false
    }
  }

  /** The domain authorization; discovery or its loopback port can be briefly unavailable. */
  private async prepareDomain(generation: number, timeoutMs: number, replacing = false) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.domainAuthorization(generation, timeoutMs, undefined, { replacing })
      } catch {
        const delay = DOMAIN_PREPARE_RETRY_MS[attempt]

        if (delay === undefined || generation !== this.generation) {
          return undefined
        }

        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  sdkConfiguration(): MatrixSdkConfiguration & { refreshToken: string } {
    const record = this.read()

    if (!record || record.signingOut || this.sessionOver(record)) {
      throw new Error('matrix_signed_out')
    }

    return {
      baseUrl: this.config.server,
      userId: record.userId,
      deviceId: record.deviceId,
      accessToken: record.accessToken,
      refreshToken: this.handle,
      storageKey: record.storageKey
    }
  }

  async refresh(handle: string): Promise<MatrixRefreshResult> {
    if (handle !== this.handle) {
      return { ok: false, reauthenticate: true, cause: 'stale' }
    }

    if (this.ended) {
      return { ok: false, reauthenticate: true, cause: 'session_ended' }
    }

    this.refreshPending ??= this.refreshOnce().finally(() => {
      this.refreshPending = undefined
    })

    return this.refreshPending
  }

  /**
   * Main's own question to the sign-in server once the homeserver refused this Mac's chat
   * token. That refusal alone proves nothing (matrix-js-sdk gives up without a refresh when it
   * believes the token unexpired): the session is over only if the sign-in server refuses the
   * grant. The same rotation the engine's own refresh runs, coalesced with it.
   */
  confirmSession(): Promise<MatrixRefreshResult> {
    return this.refresh(this.handle)
  }

  /** Only the separate agent SDK host may receive this projection. */
  agentSdkConfiguration(slug?: string | { agent: string }): MatrixSdkConfiguration {
    const record = this.domainOwner()
    const enrollment = participant(record, slug)

    if (
      (slug === undefined && record.localHermes?.cleanupPending) ||
      (typeof slug === 'object' && record.agentHermes?.[slug.agent]?.cleanupPending) ||
      enrollment?.state !== 'ready' ||
      !enrollment.credential ||
      enrollment.credential.expiresAt <= Date.now()
    ) {
      throw new Error('matrix_agent_unavailable')
    }

    // Upgrade old enrollment records before opening their first crypto store.
    // Never use the human key or silently replace a malformed retained key.
    if (enrollment.storageKey === undefined) {
      if (slug !== undefined) {
        throw new Error('matrix_agent_key_invalid')
      }

      enrollment.storageKey = randomBytes(32).toString('base64')
      this.write(record)
    }

    const others = allParticipants(record).filter(value => value !== enrollment)

    if (
      Buffer.from(enrollment.storageKey, 'base64').length !== 32 ||
      enrollment.storageKey === record.storageKey ||
      others.some(value => value?.storageKey === enrollment.storageKey)
    ) {
      throw new Error('matrix_agent_key_invalid')
    }

    if (typeof slug === 'string') {
      this.appEnrollment(slug)
    }

    return {
      baseUrl: this.config.server,
      userId: enrollment.credential.userId,
      deviceId: enrollment.credential.deviceId,
      accessToken: enrollment.credential.accessToken,
      storageKey: enrollment.storageKey
    }
  }

  private async refreshOnce(): Promise<MatrixRefreshResult> {
    let record: AccountRecord | null

    try {
      record = this.read()
    } catch (error) {
      return { ok: false, reauthenticate: false, cause: this.refreshFailed('matrix', error) }
    }

    if (!record || record.signingOut) {
      return { ok: false, reauthenticate: true, cause: 'signed_out' }
    }

    if (this.sessionOver(record)) {
      return { ok: false, reauthenticate: true, cause: 'session_ended' }
    }

    // A rotation the vault could not keep is the newest grant: it is saved first and never
    // rotated past, so the saved grant keeps working until it lands (HeldRotation). Nobody gets
    // a token meanwhile: the one before the rotation is already revoked at the server.
    if (this.held?.storageKey === record.storageKey) {
      if (!this.saveHeld()) {
        return { ok: false, reauthenticate: false, cause: this.heldCause() }
      }

      try {
        record = this.read()
      } catch (error) {
        return { ok: false, reauthenticate: false, cause: this.refreshFailed('matrix', error) }
      }

      if (!record || record.signingOut || this.sessionOver(record)) {
        return { ok: false, reauthenticate: true, cause: record && !record.signingOut ? 'session_ended' : 'signed_out' }
      }

      // Saved a moment ago and still fresh: the engine takes it as it is.
      if (record.expiresAt === undefined || record.expiresAt > Date.now() + TOKEN_FRESH_MS) {
        return this.served(record)
      }
    }

    let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>

    try {
      tokens = await oidc.refreshTokenGrant(await this.oidc(), record.refreshToken)
    } catch (error) {
      const end = sessionEndCause(error)

      if (end) {
        this.endSession(end)

        return { ok: false, reauthenticate: true, cause: 'session_ended' }
      }

      return { ok: false, reauthenticate: false, cause: this.refreshFailed('matrix', error) }
    }

    delete this.refreshFailures.matrix

    const grant = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? record.refreshToken,
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined
    }

    // An unreadable vault is still this account, never a sign-out.
    let current: AccountRecord | null | undefined

    try {
      current = this.read()
    } catch {
      current = undefined
    }

    if (current === null || current?.signingOut || (current && current.storageKey !== record.storageKey)) {
      // Signed out, signing out or replaced while the sign-in server rotated: nobody will hold
      // these tokens, so they are revoked like any other grant nobody holds.
      await this.discard({ ...record, ...grant }, 'account_changed').catch(() => {})

      return { ok: false, reauthenticate: true, cause: 'signed_out' }
    }

    try {
      if (!current) {
        throw new Error(this.store.failureCode() ?? 'auth_storage_read_failed')
      }

      // Domain authorization/rotation can finish while Matrix rotates. Merge
      // into the current account, never overwrite another credential class.
      this.write({ ...current, ...grant })
    } catch (error) {
      // Never revoked for a failed save (that ended the Mac mini's session on a full disk,
      // 2026-10-04), and never served unsaved either: held until the vault takes it.
      this.held = { storageKey: record.storageKey, ...grant }
      this.heldFailure = this.store.failureCode() ?? matrixClosedCode(error)
      this.log({ event: 'credential_save_failed', client: 'matrix', code: this.heldFailure })
      this.retryHeld()

      return { ok: false, reauthenticate: false, cause: this.heldCause() }
    }

    return this.served(grant)
  }

  /** Why the held rotation's last save failed: a write the disk had no room for (ENOSPC or
   * EDQUOT, `auth_storage_disk_full`), even in the room kept for it (write), is `disk_full`,
   * which the window names; any other failure, a permission or I/O error included, `vault`. */
  private heldCause(): MatrixRefreshCause {
    return this.heldFailure === 'auth_storage_disk_full' ? 'disk_full' : 'vault'
  }

  /** A saved chat token, for the engine. */
  private served(grant: { accessToken: string; expiresAt?: number }): MatrixRefreshResult {
    return {
      ok: true,
      accessToken: grant.accessToken,
      refreshToken: this.handle,
      ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {})
    }
  }

  /**
   * The sign-in server refused this Mac's chat grant: the session is over. Nothing is revoked
   * and nothing is signed out. The account stays saved and marked, so the window asks the
   * same person to sign in again, and that sign-in keeps everything else (signIn).
   */
  private endSession(cause: MatrixSessionEndCause) {
    const end = { cause, at: Date.now() }
    this.ended = end
    this.held = undefined
    this.settleHeld()
    this.log({ event: 'session_ended', client: 'matrix', cause })

    try {
      const record = this.read()

      if (record && !record.signingOut && !record.sessionEnded) {
        this.write({ ...record, sessionEnded: end })
      }
    } catch {
      // Best effort: this run knows already, and the next launch hears it from the server again.
    }
  }

  /** A refresh that settled nothing, logged once per outage (with the server's OAuth code, if
   * any); the caller asks again later. */
  private refreshFailed(client: MatrixAccountClient, error: unknown) {
    const cause = matrixRefreshFailureCause(error)
    const oauth = matrixOAuthRefusal(error)
    const outage = `${cause}:${oauth ?? ''}`

    if (this.refreshFailures[client] !== outage) {
      this.refreshFailures[client] = outage
      this.log({ event: 'refresh_unavailable', client, cause, ...(oauth ? { oauth } : {}) })
    }

    return cause
  }

  /** Saves the held rotations again: soon, then every minute, until they land. */
  private retryHeld() {
    if (this.heldRetry) {
      return
    }

    const delay = HELD_SAVE_RETRY_MS[Math.min(this.heldAttempts, HELD_SAVE_RETRY_MS.length - 1)]
    this.heldAttempts++
    this.heldRetry = setTimeout(() => {
      this.heldRetry = undefined

      if (!this.saveHeld()) {
        this.retryHeld()
      }
    }, delay)
    this.heldRetry.unref?.()
  }

  /** Stops trying once nothing is held. */
  private settleHeld() {
    if (this.held || this.heldDomain) {
      return
    }

    clearTimeout(this.heldRetry)
    this.heldRetry = undefined
    this.heldAttempts = 0
  }

  /**
   * Saves the rotations the vault could not keep (HeldRotation), each into the record as it is
   * now: never an older copy of anything else. True once nothing is held: saved (`renewed` tells
   * main), or no longer this account's sign-in (signed out, signed in again, or the Atum account
   * replaced), which drops it; a sign-out revokes what it held itself (signOutOnce).
   */
  private saveHeld(): boolean {
    if (!this.held && !this.heldDomain) {
      this.settleHeld()

      return true
    }

    let record: AccountRecord | null

    try {
      record = this.read()
    } catch (error) {
      this.heldFailure = this.store.failureCode() ?? matrixClosedCode(error)

      return false
    }

    if (this.held && this.held.storageKey !== record?.storageKey) {
      this.held = undefined
    }

    if (this.heldDomain && this.heldDomain.sessionId !== record?.domain?.sessionId) {
      this.heldDomain = undefined
    }

    const matrix = this.held
    const domain = this.heldDomain

    if (record && (matrix || domain)) {
      try {
        this.write({
          ...record,
          ...(matrix
            ? { accessToken: matrix.accessToken, refreshToken: matrix.refreshToken, expiresAt: matrix.expiresAt }
            : {}),
          ...(domain ? { domain } : {})
        })
      } catch (error) {
        this.heldFailure = this.store.failureCode() ?? matrixClosedCode(error)

        return false
      }

      this.held = undefined
      this.heldDomain = undefined

      for (const [client, saved] of [
        ['matrix', matrix],
        ['domain', domain]
      ] as const) {
        if (saved) {
          this.log({ event: 'credential_saved', client })
          this.hooks.renewed?.(client)
        }
      }
    }

    this.settleHeld()

    return true
  }

  async settleRefresh(): Promise<void> {
    // A normal process quit must let a provider rotation persist, not revoke it
    // as if the user had explicitly logged out. Provider calls have a timeout.
    await Promise.allSettled([this.refreshPending, this.domainRefreshPending])
  }

  async close(closeDevice: () => Promise<void>): Promise<void> {
    this.cancel()

    try {
      // Stop the producer first: it can request a refresh while stopping.
      await closeDevice()
    } finally {
      await this.settleRefresh()
      await Promise.allSettled(this.enrollmentPending.values())
      await Promise.allSettled(this.enrollmentRevocationPending.values())

      // Quitting: one last try to keep what the sign-in server rotated (the disk may have room
      // by now). A rotation still held is lost with this run, and nothing more: it was never
      // used, so the next launch rotates from the saved grant again (HeldRotation).
      if (!this.saveHeld()) {
        const code = this.store.failureCode() ?? 'auth_storage_write_failed'

        if (this.held) {
          this.log({ event: 'credential_save_failed', client: 'matrix', code })
        }

        if (this.heldDomain) {
          this.log({ event: 'credential_save_failed', client: 'domain', code })
        }
      }

      clearTimeout(this.heldRetry)
      this.heldRetry = undefined
    }
  }

  /** The person signs out (the window's Sign out): every grant this Mac holds is revoked. */
  async signOut(
    closeDevice?: (identity: MatrixIdentity, agent?: MatrixIdentity, agents?: MatrixIdentity[]) => Promise<void>
  ) {
    try {
      await this.signOutOnce(closeDevice)
    } catch (error) {
      this.log({ event: 'user_sign_out', result: 'pending', code: matrixClosedCode(error) })

      throw error
    }

    this.log({ event: 'user_sign_out', result: 'completed' })
  }

  private async signOutOnce(
    closeDevice?: (identity: MatrixIdentity, agent?: MatrixIdentity, agents?: MatrixIdentity[]) => Promise<void>
  ) {
    this.cancel()
    let record = this.read()

    if (record) {
      this.write({ ...record, signingOut: true })
      const agent = record.enrollment?.credential

      const agents = Object.values(record.agentEnrollments ?? {}).flatMap(value =>
        value.credential ? [{ userId: value.credential.userId, deviceId: value.credential.deviceId }] : []
      )

      await closeDevice?.(
        { userId: record.userId, deviceId: record.deviceId },
        agent ? { userId: agent.userId, deviceId: agent.deviceId } : undefined,
        ...(agents.length ? [agents] : [])
      )
      await this.settleRefresh()
      await Promise.allSettled(this.enrollmentPending.values())
      // A rotation the vault could not keep is the live grant at the sign-in server: saved into
      // the record now if the vault takes it, and revoked either way (the spent, saved tokens
      // alone end nothing at the server).
      this.saveHeld()
      record = this.read()!
      const hadEnrollment = allParticipants(record).some(Boolean)
      // Matrix logout must not depend on availability of the domain resource.
      // Keep only the domain grant until the scoped agent has been cleaned up.
      this.queueRevocation(record)

      if (this.held?.storageKey === record.storageKey) {
        this.queueRevocation({ ...record, ...this.held })
      }

      this.log({ event: 'grant_revoked', client: 'matrix', reason: 'user_sign_out' })

      if (!hadEnrollment && record.domain) {
        this.queueDomainSignOut(record.domain)
      }

      // The queue remains durable on provider failure. Still clean the local
      // model key and attempt agent revocation; the final drain must succeed.
      let humanRevocationFailure: unknown
      await this.drainRevocations().catch(error => {
        humanRevocationFailure = error
      })

      let participantFailure: unknown

      for (const slug of participantSelectors(record)) {
        try {
          await this.revokeEnrollment(slug)
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'matrix_domain_signed_out') {
            participantFailure ??= error

            continue
          }

          // Lost owner authority needs durable operator reconciliation, not an
          // unusable login lock. Never report that the agent was remotely revoked.
          const current = this.read()!
          const orphans = this.orphanedEnrollments()
          const enrollment = participant(current, slug)

          if (!enrollment || enrollment.cleanupIdentity) {
            participantFailure ??= error

            continue
          }

          const executorId = enrollment.executorId

          if (!orphans.some(item => item.executorId === executorId)) {
            orphans.push({
              executorId,
              issuer: current.issuer,
              subject: current.subject,
              resource: this.config.domain!.resource,
              ...(typeof slug === 'string' ? { app: slug } : {}),
              ...(typeof slug === 'object' ? { agent: slug.agent } : {}),
              reason: 'domain_authority_lost',
              recordedAt: Date.now()
            })
            this.store.setItem('matrix-orphaned-enrollments', JSON.stringify(orphans))
          }

          this.write(setParticipant(current, undefined, slug))
        }
      }

      if (participantFailure) {
        throw participantFailure
      }

      record = this.read()!

      if (hadEnrollment && record.domain) {
        this.queueDomainSignOut(record.domain)
      }

      if (humanRevocationFailure) {
        throw humanRevocationFailure
      }

      await this.drainRevocations()

      const remaining = this.read()

      if (remaining?.localHermes || Object.keys(remaining?.agentHermes ?? {}).length) {
        throw new Error('matrix_local_cleanup_pending')
      }

      if (remaining && this.config.domain) {
        // A38: the next sign-in of this person reports its Mac's zone afresh.
        this.timeZoneReports.clear(this.accountKey(remaining))
        this.languageReports.clear(this.accountKey(remaining))
      }

      this.store.removeItem('matrix-account')
    }

    await this.drainRevocations()
    this.handle = randomUUID()
    this.ended = undefined
    this.domainRevoked = false
    this.domainRefused = undefined
    this.held = undefined
    this.heldDomain = undefined
    this.refreshFailures = {}
    this.settleHeld()
  }

  /** The person signing out revokes the Atum account sign-in, a rotation of it still held too. */
  private queueDomainSignOut(domain: DomainGrant) {
    const clientId = this.config.domain!.nativeClientId
    this.queueRevocation(domain, clientId)

    if (this.heldDomain?.sessionId === domain.sessionId) {
      this.queueRevocation(this.heldDomain, clientId)
    }

    this.log({ event: 'grant_revoked', client: 'domain', reason: 'user_sign_out' })
  }

  private orphanedEnrollments(): Array<{
    executorId: string
    issuer: string
    subject: string
    resource: string
    app?: string
    agent?: string
    reason: string
    recordedAt: number
  }> {
    const value = this.store.getItem('matrix-orphaned-enrollments')

    if (this.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    return value ? JSON.parse(value) : []
  }

  hasOrphanedEnrollments(): boolean {
    return this.orphanedEnrollments().length > 0
  }

  /**
   * Finishes the executor revocations a sign-out could not (`matrix-orphaned-enrollments`). Once
   * the same person is signed in again with platform authority, each orphan is withdrawn the way
   * that sign-out would have (the same idempotent DELETE) and dropped once the platform confirms
   * it. Records of another account or resource, an executor still in use here, and ones the
   * platform can't confirm yet stay recorded for support. Never interactive; eight per call.
   * `attempted` is false when there was no platform authority to try with.
   */
  reconcileOrphanedEnrollments(): Promise<{ attempted: boolean; cleared: number; remaining: number }> {
    this.orphanReconcile ??= this.reconcileOrphanedEnrollmentsOnce().finally(() => {
      this.orphanReconcile = undefined
    })

    return this.orphanReconcile
  }

  private async reconcileOrphanedEnrollmentsOnce(): Promise<{ attempted: boolean; cleared: number; remaining: number }> {
    const orphans = this.orphanedEnrollments()
    let owner: AccountRecord

    try {
      owner = this.domainOwner()
    } catch {
      return { attempted: false, cleared: 0, remaining: orphans.length }
    }

    if (!owner.domain || !this.config.domain) {
      return { attempted: false, cleared: 0, remaining: orphans.length }
    }

    if (!orphans.length) {
      return { attempted: true, cleared: 0, remaining: 0 }
    }

    const generation = this.generation
    const resource = this.config.domain.resource
    const inUse = new Set(allParticipants(owner).flatMap(value => (value?.executorId ? [value.executorId] : [])))

    const eligible = orphans
      .filter(
        orphan =>
          orphan.issuer === owner.issuer &&
          orphan.subject === owner.subject &&
          orphan.resource === resource &&
          !inUse.has(orphan.executorId)
      )
      .slice(0, 8)

    const cleared = new Set<string>()
    let grant = owner.domain

    for (const orphan of eligible) {
      if (generation !== this.generation) {
        break
      }

      const revoke = () =>
        orphan.app
          ? requestEnrollment(resource, grant, orphan.executorId, 'DELETE', { slug: orphan.app })
          : requestEnrollment(resource, grant, orphan.executorId, 'DELETE')

      try {
        if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000) {
          grant = await this.refreshDomain()
        }

        try {
          await revoke()
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'matrix_enrollment_authentication') {
            throw error
          }

          grant = await this.refreshDomain()
          await revoke()
        }

        cleared.add(orphan.executorId)
      } catch (error) {
        // Asked to wait, or authority gone: the rest wait for the next launch.
        if (
          error instanceof MatrixEnrollmentRateLimited ||
          (error instanceof Error && error.message === 'matrix_domain_signed_out')
        ) {
          break
        }
      }
    }

    // Read again: a sign-out may have recorded more while these were in flight.
    const latest = this.orphanedEnrollments()
    const remaining = latest.filter(orphan => !cleared.has(orphan.executorId))

    if (remaining.length !== latest.length) {
      if (remaining.length) {
        this.store.setItem('matrix-orphaned-enrollments', JSON.stringify(remaining))
      } else {
        this.store.removeItem('matrix-orphaned-enrollments')
      }
    }

    return { attempted: true, cleared: latest.length - remaining.length, remaining: remaining.length }
  }

  /**
   * The account the Atum account sign-in belongs to. Its own grant decides, not the chat
   * session's: agents keep working on a live Atum account sign-in while the person is asked to
   * sign in to their chats again (sessionEnded). Only a sign-out, or the sign-in server
   * refusing the Atum account grant itself, ends it.
   */
  private domainOwner(allowSigningOut = false, allowRefused = false): AccountRecord {
    const record = this.read()

    if (
      !this.config.domain ||
      !record ||
      (!allowSigningOut && record.signingOut) ||
      (this.domainRevoked && !allowRefused)
    ) {
      throw new Error('matrix_domain_signed_out')
    }

    if (
      record.domain &&
      (record.domain.issuer !== record.issuer ||
        record.domain.subject !== record.subject ||
        !record.domain.accessToken ||
        !record.domain.refreshToken ||
        !record.domain.sessionId)
    ) {
      throw new Error('matrix_vault_invalid')
    }

    return record
  }

  /**
   * The person connects their Atum account in the browser (readDomain, interactive): a first
   * connection, or a new sign-in over one the sign-in server refused this run, which it replaces.
   */
  private async connectDomain() {
    const owner = this.domainOwner(false, true)
    this.store.assertEncryptionAvailable()
    this.cancel()
    const generation = this.generation
    // As at sign-in: a slow drain goes on behind the browser, never in front of it.
    await within(this.drainRevocations().catch(() => {}), REVOCATION_DRAIN_WAIT_MS)

    if (generation !== this.generation) {
      throw new Error('matrix_login_cancelled')
    }

    // Already-authenticated account consent, not onboarding. The app comes back to the front
    // the moment the browser does.
    const login = await this.domainAuthorization(generation, 180_000, owner.storageKey, {
      replacing: true,
      onCallback: () => this.hooks.returned?.()
    })

    if (generation !== this.generation) {
      login.cancel()
      throw new Error('matrix_login_cancelled')
    }

    this.login = login

    try {
      await this.openBrowser(login.authorizationUrl)
      await login.completed

      if (generation !== this.generation) {
        throw new Error('matrix_login_cancelled')
      }

      return generation
    } catch (error) {
      login.cancel()
      throw error
    } finally {
      if (this.login === login) {
        this.login = undefined
      }
    }
  }

  /**
   * The domain grant's browser authorization. The owner is read when the callback
   * arrives: in a one-trip sign-in the account itself is created moments earlier.
   * `replacing`: the person's own Connect, which may replace a sign-in the server refused.
   */
  private async domainAuthorization(
    generation: number,
    timeoutMs: number,
    storageKey?: string,
    { replacing = false, onCallback }: { replacing?: boolean; onCallback?: () => void } = {}
  ) {
    const clientId = this.config.domain!.nativeClientId
    const config = await this.oidc(clientId)

    let mismatch = false

    const authorization = await authorizeNative<DomainGrant>({
      config,
      issuer: this.config.issuer,
      port: this.config.domain!.callbackPort ?? 21884,
      scope: 'openid',
      timeoutMs,
      prepare: async grant => {
        // A browser SSO session can belong to another human. Never infer an
        // account link from the Matrix localpart, email, or current browser.
        const owner = this.domainOwner(false, replacing)

        if (grant.issuer !== owner.issuer || grant.subject !== owner.subject) {
          mismatch = true

          throw new Error('matrix_domain_identity_mismatch')
        }

        return { ...grant, sessionId: randomUUID() }
      },
      commit: grant => {
        const current = this.domainOwner(false, replacing)

        if (generation !== this.generation || (storageKey !== undefined && current.storageKey !== storageKey)) {
          throw new Error('matrix_login_cancelled')
        }

        this.write({ ...current, domain: grant })
        // A rotation of the replaced sign-in the vault could not keep is revoked with it.
        const held = this.heldDomain?.sessionId === current.domain?.sessionId ? this.heldDomain : undefined

        // A sign-in the server refused is replaced only now that the new one is saved.
        if (this.domainRevoked || this.domainRefused || this.heldDomain) {
          this.domainRevoked = false
          this.domainRefused = undefined
          this.heldDomain = undefined
          this.settleHeld()
        }

        if (current.domain && current.domain.sessionId !== grant.sessionId) {
          this.queueReplaced(current.domain, clientId)

          if (held) {
            this.queueReplaced(held, clientId)
          }

          void this.drainRevocations().catch(() => {})
        }
      },
      discard: grant => this.discard(grant, mismatch ? 'account_mismatch' : 'sign_in_cancelled', clientId),
      ...(this.hooks.domainContinuation ? { continueTo: () => this.hooks.domainContinuation?.continueTo() } : {}),
      ...(onCallback ? { onCallback } : {})
    })

    if (!this.hooks.domainContinuation) {
      return authorization
    }

    return {
      ...authorization,
      cancel: () => {
        authorization.cancel()
        this.hooks.domainContinuation?.cancel()
      }
    }
  }

  private refreshDomain(): Promise<DomainGrant> {
    this.domainRefreshPending ??= this.refreshDomainOnce().finally(() => {
      this.domainRefreshPending = undefined
    })

    return this.domainRefreshPending
  }

  private async refreshDomainOnce(): Promise<DomainGrant> {
    let owner = this.domainOwner(true)
    const clientId = this.config.domain!.nativeClientId
    const held = this.heldDomain

    // A rotation the vault could not keep is the newest grant: saved first and never rotated
    // past (HeldRotation). A sign-out in progress may use it unsaved: it revokes it moments later.
    if (held && held.sessionId === owner.domain?.sessionId) {
      if (!this.saveHeld()) {
        if (owner.signingOut) {
          return held
        }

        throw new Error('matrix_domain_unavailable')
      }

      owner = this.domainOwner(true)
      const saved = owner.domain

      if (
        saved?.sessionId === held.sessionId &&
        (saved.expiresAt === undefined || saved.expiresAt > Date.now() + TOKEN_FRESH_MS)
      ) {
        return saved
      }
    }

    const previous = owner.domain

    if (!previous) {
      throw new Error('matrix_domain_connection_required')
    }

    let tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>

    try {
      tokens = await oidc.refreshTokenGrant(await this.oidc(clientId), previous.refreshToken)
    } catch (error) {
      const end = sessionEndCause(error)

      if (end) {
        let still: AccountRecord | null | undefined

        try {
          still = this.read()
        } catch {
          still = undefined
        }

        // Replaced while this refresh was in flight (a sign-in's Atum account step): the refusal
        // is of a sign-in nobody holds now, never of the one that replaced it.
        if (still && still.domain?.sessionId !== previous.sessionId) {
          throw new Error('matrix_domain_unavailable')
        }

        this.domainRevoked = true
        this.log({ event: 'session_ended', client: 'domain', cause: end })

        throw new Error('matrix_domain_signed_out')
      }

      this.refreshFailed('domain', error)

      throw new Error('matrix_domain_unavailable')
    }

    delete this.refreshFailures.domain

    const grant: DomainGrant = {
      ...previous,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous.refreshToken,
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined
    }

    // An unreadable vault is still this sign-in, never a sign-out.
    let current: AccountRecord | null | undefined

    try {
      current = this.read()
    } catch {
      current = undefined
    }

    // The sign-in is its sessionId: a person signing in to their chats again keeps it.
    if (current === null || (current && current.domain?.sessionId !== previous.sessionId)) {
      // Signed out, or this Atum account sign-in was replaced while it rotated: nobody will hold
      // these tokens. Its caller finds it unavailable; the current sign-in is not touched.
      await this.discard(grant, current === null ? 'account_changed' : 'domain_replaced', clientId).catch(() => {})

      throw new Error(current === null ? 'matrix_domain_signed_out' : 'matrix_domain_unavailable')
    }

    try {
      if (!current) {
        throw new Error(this.store.failureCode() ?? 'auth_storage_read_failed')
      }

      // Logout can need this rotated grant to revoke the agent enrollment.
      // Persist under the existing signingOut flag; readDomain's generation
      // and owner checks still deny any late UI result.
      this.write({ ...current, domain: grant })
    } catch (error) {
      // As for the chat sign-in: never revoked for a failed save, never used unsaved (but by a
      // sign-out, which revokes it), held until the vault takes it.
      this.heldDomain = grant
      this.log({
        event: 'credential_save_failed',
        client: 'domain',
        code: this.store.failureCode() ?? matrixClosedCode(error)
      })
      this.retryHeld()

      if (current?.signingOut) {
        return grant
      }

      throw new Error('matrix_domain_unavailable')
    }

    return grant
  }

  async readDomain(interactive = true): Promise<MatrixDomainIdentity> {
    // A sign-in the server refused this run is replaced only by the person connecting again
    // (connectDomain); in the background that is one click to ask for, like a missing one.
    const owner = this.domainOwner(false, true)

    if (!interactive && (!owner.domain || this.domainRevoked)) {
      throw new Error('matrix_domain_connection_required')
    }

    const generation = owner.domain && !this.domainRevoked ? this.generation : await this.connectDomain()

    if (generation !== this.generation) {
      throw new Error('matrix_login_cancelled')
    }

    let grant = this.domainOwner().domain!
    let refreshed = false

    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000) {
      grant = await this.refreshDomain()
      refreshed = true
    }

    let identity = await readDomainIdentity(this.config.domain!.resource, grant)

    if (generation !== this.generation) {
      throw new Error('matrix_login_cancelled')
    }

    if (!identity && !refreshed) {
      // The platform refused this token: one rotation answers that, but not again for a while
      // once even a fresh token was refused (every agent's renewal reads this).
      const refused = this.domainRefused

      if (refused?.sessionId === grant.sessionId && Date.now() < refused.until) {
        throw new Error('matrix_domain_unavailable')
      }

      grant = await this.refreshDomain()
      identity = await readDomainIdentity(this.config.domain!.resource, grant)
    }

    // A response that arrives after logout/cancel/account replacement must not
    // repopulate the UI, even if its original access token was still accepted.
    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== grant.sessionId) {
      throw new Error('matrix_login_cancelled')
    }

    if (!identity) {
      // The platform refused a freshly rotated token too. That is not the sign-in server
      // ending the sign-in (only its invalid_grant is, in refreshDomainOnce): unavailable,
      // with nothing signed out, and not rotated on a refusal again for DOMAIN_REFUSED_MS.
      this.domainRefused = { sessionId: grant.sessionId, until: Date.now() + DOMAIN_REFUSED_MS }
      this.log({ event: 'domain_refused' })

      throw new Error('matrix_domain_unavailable')
    }

    if (this.domainRefused?.sessionId === grant.sessionId) {
      this.domainRefused = undefined
    }

    return identity
  }

  /** Persistent partition identity excludes bearer, display name and generation. */
  appScope(): { accountKey: string; generation: number } | null {
    try {
      const owner = this.domainOwner()

      if (!owner.domain) {
        return null
      }

      return { accountKey: this.accountKey(owner), generation: this.generation }
    } catch {
      return null
    }
  }

  /** A38: the owner zone the platform last acknowledged for this sign-in, if any. A new routine
   * defaults to it; the stored per-routine zone keeps its own value. */
  ownerTimeZone(): string | undefined {
    return this.timeZoneReports.ownerZone()
  }

  /** The owner's own coarse location and switch (0333). The platform is authoritative; this
   * returns exactly its bounded view or refuses. Never cached: Settings is a deliberate read. */
  ownerLocation(signal?: AbortSignal): Promise<MatrixOwnerLocationView> {
    return this.ownerLocationRequest('GET', undefined, signal)
  }

  /** The one switch. Off clears the platform's coarse value and stops later reports. */
  setOwnerLocationEnabled(enabled: boolean, signal?: AbortSignal): Promise<MatrixOwnerLocationView> {
    return this.ownerLocationRequest('PUT', { enabled }, signal)
  }

  private async ownerLocationRequest(
    method: 'GET' | 'PUT',
    body: { enabled: boolean } | undefined,
    signal: AbortSignal | undefined
  ): Promise<MatrixOwnerLocationView> {
    const grant = await this.agentGrant()
    const response = await fetch(`${this.config.domain!.resource}/owner-location`, {
      method,
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit'
    })
    const value = response.ok ? ((await response.json().catch(() => null)) as unknown) : null

    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof (value as { enabled?: unknown }).enabled !== 'boolean' ||
      !Object.keys(value).every(key => ['enabled', 'city', 'region', 'country'].includes(key)) ||
      ['city', 'region', 'country'].some(
        key => (value as Record<string, unknown>)[key] !== undefined && typeof (value as Record<string, unknown>)[key] !== 'string'
      )
    ) {
      throw new Error('matrix_owner_location_unavailable')
    }

    return value as MatrixOwnerLocationView
  }

  /** The account's local identity (its sign-in server and subject), never its bearer. */
  private accountKey(record: AccountRecord): string {
    return createHash('sha256')
      .update(JSON.stringify([this.config.domain!.resource, record.issuer, record.subject]))
      .digest('hex')
  }

  /** Fixed app namespace, existing MAS-domain grant. No renderer URL/token and
   * no automatic replay of a mutation after an ambiguous response. */
  async appRequest(
    resource: { app?: string; action?: 'manifest' | 'launch' | 'history' | 'connection' | 'connect' | 'confirm' | 'disconnect' | 'panel-link' },
    body?: Record<string, unknown>
  ): Promise<unknown> {
    if (resource.app !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(resource.app)) {
      throw new Error('matrix_app_invalid')
    }

    if (Boolean(resource.app) !== Boolean(resource.action)) {
      throw new Error('matrix_app_invalid')
    }

    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()
    const action = resource.action === 'confirm' ? 'connect/confirm' : resource.action
    const route = resource.app ? `/apps/${resource.app}/${action}` : '/apps'
    const mutation = (resource.action === 'panel-link' && body !== undefined) || ['launch', 'history', 'connect', 'confirm', 'disconnect'].includes(resource.action ?? '')
    const catalog = !resource.app

    const response = await fetch(`${this.config.domain!.resource}${route}`, {
      method: mutation ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${owner.domain!.accessToken}`,
        ...(catalog
          ? {
              Accept: 'application/json',
              [APP_CATALOG_V2_NEGOTIATION_HEADER]: APP_CATALOG_V2_NEGOTIATION_VALUE,
              [LOOK_PACK_NEGOTIATION_HEADER]: LOOK_PACK_NEGOTIATION_VALUE
            }
          : {}),
        ...(['manifest', 'launch'].includes(resource.action ?? '')
          ? { [APP_LAUNCH_NEGOTIATION_HEADER]: APP_LAUNCH_NEGOTIATION_VALUE }
          : {}),
        ...(resource.action === 'manifest' ? { [APP_PANEL_NEGOTIATION_HEADER]: APP_PANEL_PROFILE } : {}),
        ...(mutation ? { 'Content-Type': 'application/json' } : {})
      },
      ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })

    if (response.status === 401) {
      await response.body?.cancel()
      // App-local refusal, not evidence that the shared Hermes domain grant is
      // revoked. A later /me read owns refresh/revocation; never replay this call.
      throw new AppSurfaceError('account_unavailable')
    }

    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('matrix_app_unavailable')
    }

    const value = await readDomainJson(response, 1024 * 1024)
    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId) {
      throw new Error('matrix_app_cancelled')
    }

    if (!response.ok) {
      const code = (value as { details?: { launch_error?: unknown } } | null)?.details?.launch_error
      const allowed = APP_LAUNCH_REFUSALS as readonly string[]
      throw new AppSurfaceError(
        response.status === 429
          ? 'rate_limited'
          : typeof code === 'string' && allowed.includes(code)
            ? code
            : response.status >= 500
              ? 'temporarily_unavailable'
              : 'app_unavailable',
        response.status,
        response.status === 429
          ? Math.min(30_000, Math.max(1000, (Number(response.headers.get('retry-after')) || 1) * 1000))
          : null
      )
    }

    return value
  }

  /** Optional L1 look gallery. A 404 is capability absence until that slice deploys. */
  async lookGalleryRequest(): Promise<unknown | null> {
    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()
    const response = await fetch(`${this.config.domain!.resource}/looks/gallery`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${owner.domain!.accessToken}`,
        Accept: 'application/json',
        [LOOK_PACK_NEGOTIATION_HEADER]: LOOK_PACK_NEGOTIATION_VALUE
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })

    if (response.status === 404) {
      await response.body?.cancel()

      return null
    }

    if (response.status === 401) {
      await response.body?.cancel()
      throw new AppSurfaceError('account_unavailable')
    }

    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('matrix_look_gallery_unavailable')
    }

    const value = await readDomainJson(response, 1024 * 1024)
    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId) {
      throw new Error('matrix_app_cancelled')
    }

    return value
  }

  /** Fixed app-bot routes. The renderer selects neither an origin nor a bearer. */
  async appBotRequest(
    slug: string,
    action: 'read' | 'consent' | 'revoke' | 'outcome',
    body?: Record<string, unknown>
  ): Promise<unknown> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) {
      throw new Error('matrix_app_invalid')
    }

    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()
    const suffix = action === 'read' ? 'bot' : action === 'outcome' ? 'bot/outcome' : 'bot/consent'
    const response = await fetch(`${this.config.domain!.resource}/apps/${slug}/${suffix}`, {
      method: action === 'read' ? 'GET' : action === 'revoke' ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${owner.domain!.accessToken}`, ...(action === 'read' || action === 'revoke' ? {} : { 'Content-Type': 'application/json' }) },
      ...(action === 'consent' || action === 'outcome' ? { body: JSON.stringify(body ?? {}) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(15_000)
    })

    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('matrix_app_bot_unavailable')
    }
    const value = await readDomainJson(response, 64 * 1024)
    const current = this.domainOwner()
    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId || !response.ok) {
      throw new Error('matrix_app_bot_unavailable')
    }
    return value
  }

  /**
   * `POST /apps/{slug}/bot/start` (spec/canonical-room/v1.1): the platform names the room that is an
   * app bot's one chat with the owner, so devices that start at once end in the same room. The body is
   * only the attempt's id, this app's version as a hint, and the room this device offers; the owner
   * comes from the bearer and the app and bot from the catalog, never from here. Answers the status and
   * the JSON body as read, for the caller to read (a body that is not JSON, or is too large, is
   * absent). Nothing is replayed here: the route is idempotent on `requestId`, so a retry is the
   * caller's, with the same body. The renderer chooses no origin, path or credential.
   */
  async appBotStart(
    slug: string,
    request: { requestId: string; appVersion?: string; roomId?: string }
  ): Promise<{ status: number; body?: unknown }> {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(slug) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(request.requestId) ||
      (request.appVersion !== undefined && !/^[!-~]{1,100}$/.test(request.appVersion)) ||
      (request.roomId !== undefined && !isCanonicalMatrixRoomId(request.roomId))
    ) {
      throw new Error('matrix_app_invalid')
    }

    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()

    const response = await fetch(`${this.config.domain!.resource}/apps/${slug}/bot/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.domain!.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })

    let body: unknown

    if (response.headers.get('content-type')?.startsWith('application/json')) {
      body = await readDomainJson(response, 16 * 1024).catch(() => undefined)
    } else {
      await response.body?.cancel()
    }

    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId) {
      throw new Error('matrix_not_ready')
    }

    return { status: response.status, ...(body === undefined ? {} : { body }) }
  }

  /** Fixed MAS-authenticated intake route used by an official bot's
   * canonical Matrix DM. The renderer chooses only the catalog app and field
   * values; it never supplies an origin, path or credential. Mutations are not
   * replayed after an ambiguous response. */
  async appIntakeRequest(
    slug: string,
    action: 'read' | 'submit',
    values?: unknown
  ): Promise<unknown> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) {
      throw new Error('matrix_app_invalid')
    }

    let payload: Record<string, string> | undefined

    if (action === 'submit') {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new AppSurfaceError('intake_values_invalid', 400)
      }

      const entries: Array<[string, unknown]> = []

      for (const name in values) {
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
          continue
        }

        if (entries.length >= APP_INTAKE_MAX_FIELDS) {
          throw new AppSurfaceError('intake_values_invalid', 400)
        }

        entries.push([name, (values as Record<string, unknown>)[name]])
      }

      if (entries.length === 0) {
        throw new AppSurfaceError('intake_values_invalid', 400)
      }

      payload = {}

      for (const [name, value] of entries) {
        if (
          !APP_INTAKE_FIELD_NAME.test(name) ||
          typeof value !== 'string' ||
          value.length > APP_INTAKE_MAX_VALUE_LENGTH
        ) {
          throw new AppSurfaceError('intake_values_invalid', 400)
        }

        payload[name] = value
      }
    }

    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()
    const response = await fetch(
      `${this.config.domain!.resource}/apps/${encodeURIComponent(slug)}/bot/intake`,
      {
        method: action === 'submit' ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${owner.domain!.accessToken}`,
          Accept: 'application/json',
          ...(action === 'submit' ? { 'Content-Type': 'application/json; charset=utf-8' } : {})
        },
        ...(action === 'submit' ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      }
    )

    if (response.status === 401) {
      await response.body?.cancel()
      throw new AppSurfaceError('account_unavailable', 401)
    }

    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new AppSurfaceError('app_surface_unavailable', response.status)
    }

    const value = await readDomainJson(response, 64 * 1024)
    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId) {
      throw new AppSurfaceError('app_surface_cancelled')
    }

    if (!response.ok) {
      const body = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const field = typeof body?.field === 'string' && APP_INTAKE_FIELD_NAME.test(body.field)
        ? body.field
        : null

      throw new AppSurfaceError(
        response.status === 404 ? 'app_surface_absent' : 'app_surface_request_failed',
        response.status,
        null,
        field ? { field } : null
      )
    }

    return value
  }

  /** Narrow owner-domain calls. Tokens and remote resource descriptors never enter IPC. */
  async ownerReaderTrustEnrollment(executorId?: string): Promise<OwnerReaderTrustEnrollment | null> {
    return (await this.ownerReaderTrustState(executorId)).enrollment
  }

  /**
   * Same read, plus whether any owner_reader enrollment is still provisioning or
   * awaiting trust. `pending` is what keeps the desktop's trust poll fast; an
   * account with no such enrollment (or a shell that refuses the read) backs off.
   */
  async ownerReaderTrustState(executorId?: string): Promise<{ pending: boolean; enrollment: OwnerReaderTrustEnrollment | null }> {
    const identity = await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

    if (executorId !== undefined && !uuid.test(executorId)) {throw new Error('matrix_owner_reader_invalid')}

    const read = async (route: string, body?: { ownerDevice: string }): Promise<any> => {
      const response = await fetch(`${this.config.domain!.resource}/cloud/${route}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { Authorization: `Bearer ${owner.domain!.accessToken}`, ...(body ? { 'Content-Type':'application/json' } : {}) },
        ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(5000)
      })

      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel()
        throw new Error('matrix_owner_reader_unavailable')
      }

      const result = await readDomainJson(response,65536)
      const current = this.domainOwner()

      if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId ||
        current.userId !== owner.userId || current.deviceId !== owner.deviceId) {throw new Error('matrix_owner_reader_stale')}

      return result
    }

    const response = await read('enrollments')

    if (!response || Object.keys(response).join(',') !== 'enrollments' || !Array.isArray(response.enrollments) ||
      response.enrollments.length > 64) {throw new Error('matrix_owner_reader_invalid')}

    let row = response.enrollments.find((value:any) => value?.kind === 'owner_reader' &&
      ['provisioning','awaiting_trust'].includes(value.state) &&
      (executorId === undefined || value.executorId === executorId))

    if (!row) {return {pending:false,enrollment:null}}

    const valid = (v:any) => v && v.kind === 'owner_reader' && v.agentPrincipal === undefined && v.agentUserId === undefined && uuid.test(v.executorId) &&
      uuid.test(v.enrollmentId) && v.deviceId === 'ATUM_COMPANION_'+v.executorId &&
      ['provisioning','awaiting_trust'].includes(v.state) && v.trust === 'pending' &&
      Number.isSafeInteger(v.disclosureVersion) && v.disclosureVersion >= 1

    if (!valid(row)) {throw new Error('matrix_owner_reader_invalid')}

    // Initial handoff is an existing owner-authorized enrollment transition,
    // not enrollment or disclosure acceptance. A reread never renews its window.
    if (executorId === undefined && (row.ownerDevice !== owner.deviceId || !Number.isSafeInteger(row.handoffUntil) || row.handoffUntil <= Date.now())) {
      const result = await read(`enrollments/${row.enrollmentId}/handoff`,{ownerDevice:owner.deviceId})

      if (!valid(result?.enrollment) || result.enrollment.executorId !== row.executorId ||
        result.enrollment.enrollmentId !== row.enrollmentId) {throw new Error('matrix_owner_reader_stale')}

      row = result.enrollment
    }

    if (row.state !== 'awaiting_trust' || row.ownerDevice !== owner.deviceId ||
      !Number.isSafeInteger(row.handoffUntil) || row.handoffUntil <= Date.now()) {return {pending:true,enrollment:null}}

    return {pending:true,enrollment:{executorId:row.executorId,enrollmentId:row.enrollmentId,kind:'owner_reader',ownerPrincipal:identity.principal,
      ownerUserId:owner.userId,deviceId:row.deviceId,enrollmentState:'awaiting_trust',trust:'pending',
      disclosureVersion:row.disclosureVersion,ownerDevice:row.ownerDevice,handoffUntil:row.handoffUntil}}
  }

  async ownerReaderVerification(enrollmentId: string, body?: {flowId:string;ownerDevice:string;decimal:[number,number,number]}): Promise<OwnerReaderVerification | null> {
    await this.readDomain(false)
    const generation=this.generation, owner=this.domainOwner()

    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(enrollmentId) ||
      body && (body.ownerDevice !== owner.deviceId || !/^[!-~]{1,255}$/.test(body.flowId) ||
        !Array.isArray(body.decimal) || body.decimal.length!==3 || !body.decimal.every(n=>Number.isSafeInteger(n) && n>=1000 && n<=9191)))
      {throw Error('matrix_owner_reader_invalid')}

    const response=await fetch(`${this.config.domain!.resource}/cloud/enrollments/${enrollmentId}/verification`,{
      method:body ? 'POST' : 'GET',redirect:'error',cache:'no-store',credentials:'omit',
      headers:{Authorization:`Bearer ${owner.domain!.accessToken}`,...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(5000)
    })

    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw Error('matrix_owner_reader_unavailable')
    }

    const result=await readDomainJson(response,8192) as Record<string,any>
    const current=this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId ||
      current.userId !== owner.userId || current.deviceId !== owner.deviceId) {throw Error('matrix_owner_reader_stale')}

    if (!result || Object.keys(result).join(',') !== 'verification') {throw Error('matrix_owner_reader_invalid')}
    const v=result.verification

    if (v===null) {return null}

    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'decimal,deviceId,expiresAt,flowId,ownerDevice,state' ||
      typeof v.flowId !== 'string' || !/^[!-~]{1,255}$/.test(v.flowId) || v.ownerDevice !== owner.deviceId ||
      typeof v.deviceId !== 'string' || !/^ATUM_COMPANION_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v.deviceId) ||
      !Array.isArray(v.decimal) || v.decimal.length!==3 || !v.decimal.every((n:unknown)=>Number.isSafeInteger(n) && Number(n)>=1000 && Number(n)<=9191) ||
      !Number.isSafeInteger(v.expiresAt) || v.expiresAt>Date.now()+120001 ||
      !['pending','confirmed','cancelled','expired'].includes(v.state) || v.state !== 'expired' && v.expiresAt<=Date.now()) {throw Error('matrix_owner_reader_invalid')}

    return v
  }

  private async cloudFileRequest(kind: 'status' | 'grant', input?: NativeCloudFileGrant): Promise<unknown> {
    await this.readDomain(false)
    const generation = this.generation
    const owner = this.domainOwner()

    const response = await fetch(
      `${this.config.domain!.resource}/cloud/${kind === 'status' ? 'file-status' : 'file-grants'}`,
      {
        method: kind === 'status' ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${owner.domain!.accessToken}`,
          ...(kind === 'grant' ? { 'Content-Type': 'application/json' } : {})
        },
        ...(kind === 'grant' ? { body: JSON.stringify(input) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000)
      }
    )

    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()
      throw new Error('matrix_drive_task_unavailable')
    }

    const value = await readDomainJson(response, 32_768)
    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== owner.domain?.sessionId || !response.ok) {
      throw new Error('matrix_drive_task_unavailable')
    }

    return value
  }

  async cloudFileAvailable(agentPrincipal: string): Promise<boolean> {
    const value = await this.cloudFileRequest('status')
    const row = value as { agents?: unknown } | null

    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).join(',') !== 'agents' ||
      !Array.isArray(row.agents) ||
      row.agents.length > 128
    ) {
      throw new Error('matrix_drive_task_unavailable')
    }

    const seen = new Set<string>()
    let available = false

    for (const item of row.agents) {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'agentPrincipal,available' ||
        typeof item.agentPrincipal !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.agentPrincipal) ||
        typeof item.available !== 'boolean' ||
        seen.has(item.agentPrincipal)
      ) {
        throw new Error('matrix_drive_task_unavailable')
      }

      seen.add(item.agentPrincipal)

      if (item.agentPrincipal === agentPrincipal) {
        available = item.available
      }
    }

    return available
  }

  async issueCloudFileGrant(input: NativeCloudFileGrant): Promise<void> {
    const value = await this.cloudFileRequest('grant', input)
    const grant = value as { grantId?: unknown; mode?: unknown; expiresAt?: unknown } | null

    if (
      !grant ||
      typeof grant !== 'object' ||
      Array.isArray(grant) ||
      Object.keys(grant).sort().join(',') !== 'expiresAt,grantId,mode' ||
      typeof grant.grantId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(grant.grantId) ||
      grant.mode !== input.mode ||
      !Number.isSafeInteger(grant.expiresAt) ||
      Number(grant.expiresAt) <= Date.now()
    ) {
      throw new Error('matrix_drive_task_unavailable')
    }
  }

  /** Main-only resource call. UI cannot select an endpoint or read the grant.
   * Never automatically repeat a mutation after a lost response or 401. */
  async invocation(input: Record<string, unknown>, app?: string): Promise<unknown> {
    await this.readDomain(input.operation !== 'recover')
    const generation = this.generation
    const record = this.domainOwner()

    const value = await requestInvocation(
      this.config.domain!.resource,
      record.domain!,
      !app && input.operation !== 'recover' && input.protocol === undefined
        ? { ...input, protocol: 2, admission: 'interactive' }
        : input,
      app
    )

    const current = this.domainOwner()

    if (generation !== this.generation || current.domain?.sessionId !== record.domain?.sessionId) {
      throw new Error('matrix_invocation_cancelled')
    }

    return value
  }

  /** Native-only free publication reservation; no automatic mutation retries. */
  async groupNotice(input: MatrixGroupNoticeRequest): Promise<unknown> {
    await this.readDomain(true)
    const generation = this.generation
    const record = this.domainOwner()
    const value = await requestGroupNotice(this.config.domain!.resource, record.domain!, input)

    if (generation !== this.generation || this.domainOwner().domain?.sessionId !== record.domain?.sessionId) {
      throw new Error('matrix_invocation_cancelled')
    }

    return value
  }

  /** Never include provider text, status detail, headers, or a bearer in a local log. */
  private reportLeaseFailure(error: unknown): void {
    if (
      error instanceof Error &&
      (error.message === 'matrix_invocation_cancelled' || error.message === 'matrix_domain_signed_out')
    ) {
      return
    }

    const code =
      error instanceof Error && error.message === 'matrix_lease_authentication' ? 'authentication' : 'unavailable'

    if (this.leaseFailureCode !== code) {
      this.leaseFailureCode = code
      console.warn(`[Matrix] lease ${code}`)
    }
  }

  /** A refusal belongs to this exact custody, not whichever enrollment is current when
   * it arrives. Keep the device/key/profile for explicit recovery; none is active. */
  private withdrawAgentExecutor(
    record: AccountRecord,
    selector: undefined | { agent: string },
    enrolled: EnrollmentRecord,
    generation: number,
    grant: DomainGrant,
    expected = enrolled
  ): void {
    if (generation !== this.generation || this.ended || this.domainRevoked || !enrolled.credential || enrolled.app) {
      return
    }

    const current = this.read()
    const still = current && participant(current, selector)

    if (
      !current ||
      current.signingOut ||
      current.subject !== record.subject ||
      current.userId !== record.userId ||
      current.deviceId !== record.deviceId ||
      current.storageKey !== record.storageKey ||
      current.domain?.sessionId !== record.domain?.sessionId ||
      current.domain?.accessToken !== grant.accessToken ||
      still?.state !== expected.state ||
      still.executorId !== expected.executorId ||
      still.storageKey !== expected.storageKey ||
      still.credential?.accessToken !== expected.credential?.accessToken ||
      still.credential?.agentPrincipal !== expected.credential?.agentPrincipal ||
      still.credential?.userId !== expected.credential?.userId ||
      still.credential?.deviceId !== expected.credential?.deviceId
    ) {
      return
    }

    this.write(setParticipant(current, { ...still, state: 'withdrawn' }, selector))
  }

  /** The answering lease: once per session and on each background renewal. It uses the
   * current domain grant (refreshed only near expiry), never a per-call identity read.
   * A lease acquire/release is idempotent, so a confirmed auth rejection gets one
   * fenced domain-token rotation and one replay. Invocation mutations never use this. */
  async lease(
    operation: 'acquire' | 'release',
    executorId: string,
    metadata?: { protocol: 2; leaseToken?: string }
  ): Promise<unknown> {
    try {
      const generation = this.generation
      const record = this.domainOwner()

      if (!record.domain) {
        throw new Error('matrix_domain_connection_required')
      }

      const agent = [
        { selector: undefined, enrollment: record.enrollment },
        ...Object.entries(record.agentEnrollments ?? {}).map(([principal, enrollment]) => ({
          selector: { agent: principal },
          enrollment
        }))
      ].find(each => each.enrollment?.executorId === executorId)

      if (operation === 'acquire' && agent?.enrollment?.state === 'withdrawn') {
        throw new Error('matrix_lease_denied')
      }

      let grant = record.domain

      if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000) {
        grant = await this.refreshDomain()
      }

      const live = () => {
        const current = this.domainOwner()

        if (
          generation !== this.generation ||
          current.subject !== record.subject ||
          current.userId !== record.userId ||
          current.deviceId !== record.deviceId ||
          current.storageKey !== record.storageKey ||
          current.domain?.sessionId !== record.domain!.sessionId
        ) {
          throw new Error('matrix_invocation_cancelled')
        }
      }

      live()
      let value: unknown

      const request = async () => {
        try {
          return await requestLease(this.config.domain!.resource, grant, { operation, executorId, ...metadata })
        } catch (error) {
          // Contention/stale terms are held:false. A lease403 can also see the provider's
          // temporary rotating state, an expired credential or a superseded request token.
          // Those are retryable only inside this exact live account/participant custody.
          if (operation === 'acquire' && error instanceof Error && error.message === 'matrix_lease_denied') {
            live()
            const current = this.domainOwner()
            const still = agent && participant(current, agent.selector)

            if (
              agent?.enrollment?.credential &&
              still?.executorId === executorId &&
              still.storageKey === agent.enrollment.storageKey &&
              still.credential?.agentPrincipal === agent.enrollment.credential.agentPrincipal &&
              still.credential?.userId === agent.enrollment.credential.userId &&
              still.credential?.deviceId === agent.enrollment.credential.deviceId &&
              ['ready', 'pending'].includes(still.state) &&
              !still.app &&
              (current.domain?.accessToken !== grant.accessToken ||
                !still.credential ||
                still.credential.accessToken !== agent.enrollment.credential.accessToken ||
                agent.enrollment.credential.expiresAt <= Date.now() ||
                still.credential.expiresAt <= Date.now() ||
                this.renewalPending.has(participantKey(agent.selector)) ||
                this.enrollmentPending.has(participantKey(agent.selector)))
            ) {
              throw new Error('matrix_lease_unavailable')
            }

            if (agent?.enrollment?.state === 'ready' && agent.enrollment.credential) {
              this.withdrawAgentExecutor(record, agent.selector, agent.enrollment, generation, grant)
            }
          }

          throw error
        }
      }

      try {
        value = await request()
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'matrix_lease_authentication') {
          throw error
        }

        // A response can arrive after cancellation or an account replacement. Do
        // not rotate or replay into whichever authority happens to be current now.
        live()
        const currentGrant = this.domainOwner().domain!
        // Another renewal can finish while this request is still in flight. Its
        // rotated grant is already the authoritative replay credential; refreshing
        // it again would consume a second rotation on a stale 401.
        grant = currentGrant.accessToken === grant.accessToken ? await this.refreshDomain() : currentGrant
        live()
        value = await request()
      }

      live()
      this.leaseFailureCode = undefined

      return value
    } catch (error) {
      this.reportLeaseFailure(error)
      throw error
    }
  }

  /** The person's ledger reads: main-only, fenced by account and domain session. */
  async wallet(signal: AbortSignal): Promise<MatrixWalletView> {
    return this.walletRead('wallet', signal) as Promise<MatrixWalletView>
  }

  async walletHistory(signal: AbortSignal, before?: string): Promise<MatrixWalletHistory> {
    return this.walletRead('history', signal, before) as Promise<MatrixWalletHistory>
  }

  private async walletRead(kind: 'wallet' | 'history', signal: AbortSignal, before?: string) {
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== owner.storageKey ||
        current.domain?.sessionId !== grant.sessionId
      ) {
        throw new Error('matrix_wallet_cancelled')
      }
    }

    live()
    const request = () => readMatrixWallet(this.config.domain!.resource, grant, kind, signal, before)
    let result: MatrixWalletView | MatrixWalletHistory

    try {
      result = await request()
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'matrix_wallet_authentication') {
        throw error
      }
      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()
      result = await request()
    }

    live()

    return result
  }

  /** Store requests retain their exact intent through a confirmed authentication renewal. */
  async storeRequest(endpoint: StoreResource, signal: AbortSignal, input?: unknown): Promise<unknown> {
    const owner = this.appScope()

    if (!owner || !this.config.domain) {
      throw new Error('matrix_store_unavailable')
    }

    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.appScope()

      if (!current || current.accountKey !== owner.accountKey || current.generation !== owner.generation) {
        throw new Error('matrix_store_cancelled')
      }
    }

    live()

    const send = () =>
      requestMatrixStore(
        this.config.domain!.resource,
        grant.accessToken,
        endpoint,
        signal,
        input,
        this.hooks.desktopVersion
      )

    let result: unknown

    try {
      result = await send()
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'matrix_store_authentication') {
        throw error
      }

      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()
      result = await send()
    }

    live()

    return result
  }

  /**
   * S1 (one agent everywhere) owner routes: the device-service registry, answering mode and the
   * cloud enrollment (`device/cloud-agent.ts` names each one; never a renderer-selected URL).
   * `send` gets the native bearer and the domain resource; one refresh after a 401
   * (`matrix_s1_authentication`), as for the store. A lost answer is never repeated here.
   */
  async s1Request<T>(send: (accessToken: string, resource: string, requestSignal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    deadline.throwIfAborted()
    let aborted: (() => void) | undefined
    try {
      return await Promise.race([this.s1RequestWithin(send, deadline), new Promise<never>((_resolve, reject) => {
        aborted = () => reject(deadline.reason)
        deadline.addEventListener('abort', aborted, { once: true })
      })])
    } finally { if (aborted) {deadline.removeEventListener('abort', aborted)} }
  }

  private async s1RequestWithin<T>(send: (accessToken: string, resource: string, requestSignal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const owner = this.appScope()

    if (!owner || !this.config.domain) {
      throw new Error('matrix_domain_connection_required')
    }

    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.appScope()

      if (!current || current.accountKey !== owner.accountKey || current.generation !== owner.generation) {
        throw new Error('matrix_s1_cancelled')
      }
    }

    live()

    try {
      const result = await send(grant.accessToken, this.config.domain.resource, signal)
      live()
      return result
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'matrix_s1_authentication') {
        throw error
      }

      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()

      const result = await send(grant.accessToken, this.config.domain.resource, signal)
      live()
      return result
    }
  }

  private aliasJournalKey(): string {
    const scope = this.appScope()
    if (!scope) { throw new Error('matrix_domain_signed_out') }
    return `matrix-alias-pending:${scope.accountKey}`
  }

  /** Unknown claims and renames retain the same encrypted intent across renderer loss/restart. */
  aliasPending(): MatrixAliasChange | null {
    const raw = this.store.getItem(this.aliasJournalKey())
    if (this.store.failureCode()) { throw new MatrixAliasError('unavailable') }
    if (raw === null) { return null }
    try {
      const record = JSON.parse(raw)
      if (!record || record.schemaVersion !== 1 || Object.keys(record).length !== 2) { throw new Error('invalid') }
      const input = parseMatrixAliasRequest(record.input)
      if (input.action !== 'claim' && input.action !== 'rename') { throw new Error('invalid') }
      return input
    } catch { throw new MatrixAliasError('unavailable') }
  }

  async alias(value: MatrixAliasRequest, signal: AbortSignal) {
    const input = parseMatrixAliasRequest(value)
    signal.throwIfAborted()
    const scope = this.appScope()
    const owner = this.domainOwner()
    if (!scope) { throw new MatrixAliasError('authentication') }
    const journalKey = this.aliasJournalKey()
    const change = input.action === 'claim' || input.action === 'rename'
    if (change) {
      const pending = this.aliasPending()
      if (pending && JSON.stringify(pending) !== JSON.stringify(input)) { throw new MatrixAliasError('conflict') }
      // Synchronous admission precedes the first await, so different concurrent
      // intents cannot both issue. A failed durable write must not send a change.
      this.store.setItem(journalKey, JSON.stringify({ schemaVersion: 1, input }))
    }
    let grant = await this.agentGrant()
    const live = () => {
      signal.throwIfAborted()
      const current = this.appScope()
      if (!current || current.accountKey !== scope.accountKey || current.generation !== scope.generation ||
        this.domainOwner().storageKey !== owner.storageKey || this.domainOwner().domain?.sessionId !== grant.sessionId) { throw new MatrixAliasError('cancelled') }
    }
    const clear = () => {
      if (change && JSON.stringify(this.aliasPending()) === JSON.stringify(input)) { this.store.removeItem(journalKey) }
    }
    try {
      live()
      const send = () => requestMatrixAlias(this.config.domain!.resource, grant, input, signal)
      let result
      try { result = await send() }
      catch (error) {
        if (!(error instanceof MatrixAliasError) || error.code !== 'authentication') { throw error }
        live()
        const current = this.domainOwner().domain!
        grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
        live()
        result = await send()
      }
      live()
      clear()
      return result
    } catch (error) {
      // Confirmed refusals end the intent; a rename's 429 is its 30-day wait, as definite as a 409.
      if (error instanceof MatrixAliasError && (['invalid', 'denied', 'closed', 'missing', 'conflict'].includes(error.code) ||
        (input.action === 'rename' && error.code === 'limit'))) { live(); clear() }
      throw error
    }
  }

  /**
   * The platform's official accounts (spec/official-accounts/v1): main-only, fenced by account
   * and domain session, with one domain refresh on a refused token, as the alias reads have.
   */
  async officialAccounts(signal: AbortSignal): Promise<MatrixOfficialAccounts> {
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== owner.storageKey ||
        current.domain?.sessionId !== grant.sessionId
      ) {
        throw new MatrixOfficialAccountsError('cancelled')
      }
    }

    live()
    const send = () => requestMatrixOfficialAccounts(this.config.domain!.resource, grant, signal)
    let result: MatrixOfficialAccounts

    try {
      result = await send()
    } catch (error) {
      if (!(error instanceof MatrixOfficialAccountsError) || error.code !== 'authentication') {
        throw error
      }

      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()
      result = await send()
    }

    live()

    return result
  }

  private companyJournalKey(): string {
    const scope = this.appScope()

    if (!scope) {
      throw new Error('matrix_domain_signed_out')
    }

    return `matrix-company-pending:${scope.accountKey}`
  }

  /** Account-owned encrypted intent: a lost renderer/restart never creates a new request UUID. */
  companyPending(): MatrixCompanyMutation | null {
    const raw = this.store.getItem(this.companyJournalKey())

    if (this.store.failureCode()) {
      throw new MatrixCompanyError('unavailable')
    }

    if (raw === null) {
      return null
    }

    try {
      const record = JSON.parse(raw)

      if (!record || record.schemaVersion !== 1 || Object.keys(record).length !== 2) {
        throw new Error('invalid')
      }
      const input = parseMatrixCompanyRequest(record.input)

      if (!isMatrixCompanyMutation(input)) {
        throw new Error('invalid')
      }

      return input
    } catch {
      throw new MatrixCompanyError('unavailable')
    }
  }

  async company(input: MatrixCompanyRequest, signal: AbortSignal) {
    input = parseMatrixCompanyRequest(input)
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    const mutation = isMatrixCompanyMutation(input)
    const journalKey = this.companyJournalKey()

    // Admission is synchronous, before the first await: simultaneous different
    // IPC intents cannot both pass an empty journal and issue separate creates.
    if (mutation) {
      const pending = this.companyPending()

      if (pending && JSON.stringify(pending) !== JSON.stringify(input)) {
        throw new MatrixCompanyError('conflict')
      }
      this.store.setItem(journalKey, JSON.stringify({ schemaVersion: 1, input }))
    }

    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== owner.storageKey ||
        current.domain?.sessionId !== grant.sessionId
      ) {
        throw new MatrixCompanyError('cancelled')
      }
    }

    const clear = () => {
      if (mutation && JSON.stringify(this.companyPending()) === JSON.stringify(input)) {
        this.store.removeItem(journalKey)
      }
    }

    try {
      live()
      const request = () => requestMatrixCompany(this.config.domain!.resource, grant, input, signal)
      let result

      try {
        result = await request()
      } catch (error) {
        if (!(error instanceof MatrixCompanyError) || error.code !== 'authentication') {
          throw error
        }
        live()
        const current = this.domainOwner().domain!
        grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
        live()
        result = await request()
      }

      live()
      // A leave acknowledgement is kept until revocation is witnessed: a lost
      // answer or a restart replays the same requestId and reaches `removed`.
      const leaveStillRevoking = input.action === 'leave' && 'state' in result && result.state === 'revoking'

      if (!leaveStillRevoking) { clear() }

      return result
    } catch (error) {
      // A definitive refusal releases the journal: the platform's answer is final, or (a typed add/email-invite 429) it
      // recorded nothing, so the next action is a fresh request. A lost answer or a 5xx keeps it for an exact replay.
      if (error instanceof MatrixCompanyError && isDefinitiveCompanyRefusal(input.action, error.code, error.reason)) {
        live()
        clear()
      }

      throw error
    }
  }

  private companyNativeJournalKey(family: MatrixCompanyNativeFamily | 'private-cos', companyId: string): string {
    const scope = this.appScope()

    if (!scope) {
      throw new Error('matrix_domain_signed_out')
    }

    return `matrix-company-${family}-pending:${scope.accountKey}:${companyId}`
  }

  private companyNativeJournal(key: string): MatrixCompanyIntentJournal {
    const store = this.store
    const decode = (raw: string): string => {
      const record = JSON.parse(raw)

      if (!record || record.schemaVersion !== 1 || record.key !== key || typeof record.value !== 'string') {
        throw new MatrixCompanyNativeError('unavailable')
      }

      return record.value
    }

    return {
      read: () => {
        if (store.failureCode()) {
          throw new MatrixCompanyNativeError('unavailable')
        }
        const raw = store.getItem(key)

        return raw === null ? null : decode(raw)
      },
      write: (_scope, value) => {
        store.setItem(key, JSON.stringify({ schemaVersion: 1, key, value }))

        if (store.failureCode()) {
          throw new MatrixCompanyNativeError('unavailable')
        }
      },
      clear: (_scope, value) => {
        if (store.failureCode()) {
          return
        }
        const raw = store.getItem(key)

        if (raw !== null && decode(raw) === value) {
          store.removeItem(key)
        }
      }
    }
  }

  private async companyNative<T>(
    family: MatrixCompanyNativeFamily | 'private-cos',
    companyId: string,
    run: (context: MatrixCompanyNativeContext) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    const accountScope = this.appScope()

    if (!accountScope) {
      throw new Error('matrix_domain_signed_out')
    }

    const journal = this.companyNativeJournal(this.companyNativeJournalKey(family, companyId))
    const scope = `${accountScope.accountKey}\u0000${companyId}`
    let grant = await this.agentGrant()
    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== owner.storageKey ||
        current.domain?.sessionId !== grant.sessionId
      ) {
        throw new MatrixCompanyNativeError('cancelled')
      }
    }
    const make = (): MatrixCompanyNativeContext => ({
      resource: this.config.domain!.resource,
      accessToken: grant.accessToken,
      signal,
      scope,
      journal,
      assertCurrent: live
    })

    try {
      live()

      return await run(make())
    } catch (error) {
      if (!(error instanceof MatrixCompanyNativeError) || error.code !== 'authentication') {
        throw error
      }
      live()
      const current = this.domainOwner().domain!

      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()

      return run(make())
    }
  }

  async companyAI(input: unknown, signal: AbortSignal) {
    const parsed = parseMatrixCompanyAIRequest(input)

    return this.companyNative('ai', parsed.companyId, context => requestMatrixCompanyAI(context, parsed), signal)
  }

  async companyPrivateCos(input: unknown, signal: AbortSignal) {
    const parsed = parseMatrixCompanyPrivateCosRequest(input)

    return this.companyNative(
      'private-cos',
      parsed.companyId,
      context => requestMatrixCompanyPrivateCos(context, parsed),
      signal
    )
  }

  async companyFunding(input: unknown, signal: AbortSignal) {
    const parsed = parseMatrixCompanyFundingRequest(input)

    return this.companyNative('funding', parsed.companyId, context => requestMatrixCompanyFunding(context, parsed), signal)
  }

  async companyBoard(input: unknown, signal: AbortSignal) {
    const parsed = parseMatrixCompanyBoardNegotiatedRequest(input)

    return this.companyNative('board', parsed.companyId, context => requestMatrixCompanyBoard(context, parsed), signal)
  }

  async companyProjectBrain(input: unknown, signal: AbortSignal) {
    const parsed = parseMatrixCompanyBrainRequest(input)

    return this.companyNative('project-brain', parsed.companyId, context => requestMatrixCompanyBrain(context, parsed), signal)
  }

  private companyFileJournalKey(): string {
    const scope = this.appScope()

    if (!scope) {
      throw new Error('matrix_domain_signed_out')
    }

    return `matrix-company-file-pending:${scope.accountKey}`
  }

  /**
   * An account-owned, encrypted recovery record. The caller owns lifecycle
   * transitions; this seam only accepts the frozen public metadata and refuses
   * a corrupt/foreign record rather than treating it as an empty journal.
   */
  companyFilePending(): MatrixCompanyFilePending | null {
    const raw = this.store.getItem(this.companyFileJournalKey())

    if (this.store.failureCode()) {
      throw new MatrixCompanyFileError('unavailable')
    }

    if (raw === null) {
      return null
    }

    try {
      return parseMatrixCompanyFilePending(JSON.parse(raw))
    } catch {
      throw new MatrixCompanyFileError('unavailable')
    }
  }

  writeCompanyFilePending(value: MatrixCompanyFilePending): void {
    const pending = parseMatrixCompanyFilePending(value)
    this.store.setItem(this.companyFileJournalKey(), JSON.stringify(pending))
    if (this.store.failureCode()) {
      throw new MatrixCompanyFileError('unavailable')
    }
  }

  clearCompanyFilePending(): void {
    this.store.removeItem(this.companyFileJournalKey())
    if (this.store.failureCode()) {
      throw new MatrixCompanyFileError('unavailable')
    }
  }

  /** A separate native-only platform call: it never widens MatrixCompanyRequest/IPC. */
  async companyFile(input: MatrixCompanyFileRequest, signal: AbortSignal): Promise<MatrixCompanyFileValue> {
    input = parseMatrixCompanyFileRequest(input)
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== owner.storageKey ||
        current.domain?.sessionId !== grant.sessionId
      ) {
        throw new MatrixCompanyFileError('cancelled')
      }
    }

    const request = () => requestMatrixCompanyFile(this.config.domain!.resource, grant, input, signal)
    live()
    let result: MatrixCompanyFileValue

    try {
      result = await request()
    } catch (error) {
      if (!(error instanceof MatrixCompanyFileError) || error.code !== 'authentication') {
        throw error
      }
      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()
      result = await request()
    }

    live()
    return result
  }

  /** The additive 1.2 audience-scoped family. A 404 is an explicit unsupported capability, never a media fallback. */
  async companyFileV2(input: MatrixCompanyFileRequestV2, signal: AbortSignal): Promise<MatrixCompanyFileValueV2> {
    input = parseMatrixCompanyFileRequestV2(input)
    signal.throwIfAborted()
    const generation = this.generation
    const owner = this.domainOwner()
    let grant = await this.agentGrant()

    const live = () => {
      signal.throwIfAborted()
      const current = this.domainOwner()
      if (generation !== this.generation || current.storageKey !== owner.storageKey ||
          current.domain?.sessionId !== grant.sessionId) {
        throw new MatrixCompanyFileError('cancelled')
      }
    }

    const request = () => requestMatrixCompanyFileV2(this.config.domain!.resource, grant, input, signal)
    live()
    try {
      const result = await request()
      live()
      return result
    } catch (error) {
      if (!(error instanceof MatrixCompanyFileError) || error.code !== 'authentication') {
        throw error
      }
      live()
      const current = this.domainOwner().domain!
      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      live()
      const result = await request()
      live()
      return result
    }
  }

  /** The person's agents (roster, 0146): main-only, with the current domain grant. It is also
   * the one carrier of the Mac's time zone when it changed since this account's last ack (A38), and of
   * the owner's language until the platform acknowledged it (atum.owner-language/1). */
  async agents(signal: AbortSignal): Promise<MatrixAgentDefinitionRecord[]> {
    const grant = await this.agentGrant()
    const report = this.timeZoneReports.begin()
    const language = this.languageReports.begin()

    return listMatrixAgentDefinitions(this.config.domain!.resource, grant, signal, {
      ...(report || language ? { headers: { ...report?.headers, ...language?.headers } } : {}),
      ...(report ? { onTimeZoneAck: ack => report.settle(ack) } : {}),
      ...(language ? { onLanguageAck: ack => language.settle(ack) } : {})
    })
  }

  /** True when the owner's language just became known or changed and is not yet acknowledged:
   * the caller asks for a roster read so it is reported now (atum.owner-language/1). */
  ownerLanguageChanged(): boolean {
    return this.languageReports.observe()
  }

  /** Creates another agent; the request ID makes a retry return the same agent. */
  async createAgent(
    input: { requestId: string; displayName: string; hireConfirmed?: boolean },
    signal: AbortSignal
  ): Promise<MatrixAgentDefinitionRecord & { matrixUser: string; cloudPlacement?: MatrixAgentCloudPlacement }> {
    return createMatrixAgent(this.config.domain!.resource, await this.agentGrant(), input, signal)
  }

  async renewAgentHire(assistantId: string, requestId: string, signal: AbortSignal): Promise<{ renewed: true } | { refused: 'short' }> {
    const response = await fetch(`${this.config.domain!.resource}/agents/${encodeURIComponent(assistantId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${(await this.agentGrant()).accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }), signal, redirect: 'error', cache: 'no-store', credentials: 'omit'
    })
    if (response.status === 409) {
      const body = await response.json().catch(() => null) as { details?: { reason?: string } } | null
      if (body?.details?.reason === 'hire_insufficient_protons') {
        return { refused: 'short' }
      }
    }
    if (!response.ok) {
      throw new Error('agent_hire_renew_unavailable')
    }
    return { renewed: true }
  }

  /** One agent's definition (persona, model), read with the current domain grant. */
  async agentDefinition(assistantId: string, signal: AbortSignal): Promise<MatrixAgentDefinitionSnapshot> {
    return readMatrixAgentDefinition(this.config.domain!.resource, await this.agentGrant(), assistantId, signal)
  }

  /** Capture a bearer before account hand-off; cancellation must target the outgoing account. */
  async firstRunGoogleAuthority(assistantId: string): Promise<FirstRunGoogleAuthority> {
    const resource = this.config.domain!.resource
    const { accessToken } = await this.agentGrant()

    return {
      request: async (action, locale) => {
        const response = await fetch(`${resource}/agents/${encodeURIComponent(assistantId)}/routines`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'first_run_google', action, locale }),
          signal: AbortSignal.timeout(20_000),
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit'
        })

        if (!response.ok) {
          throw new Error('first_run_google_unavailable')
        }

        const result = await response.json() as Awaited<ReturnType<FirstRunGoogleAuthority['request']>>

        if (!['created', 'existing', 'cancelled', 'in_flight'].includes(result.state)) {
          throw new Error('first_run_google_invalid')
        }

        return result
      }
    }
  }

  /** One agent's routines (owner route), with the current domain grant. */
  async agentRoutines(assistantId: string, signal: AbortSignal): Promise<MatrixAgentRoutinesSnapshot> {
    return readMatrixAgentRoutines(
      this.config.domain!.resource,
      (await this.agentGrant()).accessToken,
      assistantId,
      signal
    )
  }

  /** The platform-owned background follow-up flag for one owned assistant. */
  async agentBackgroundSweep(
    assistantId: string,
    signal: AbortSignal
  ): Promise<MatrixBackgroundSweepSetting> {
    return readMatrixBackgroundSweepSetting(
      this.config.domain!.resource,
      (await this.agentGrant()).accessToken,
      assistantId,
      signal
    )
  }

  /** One revision-fenced owner update; no renderer identity or runtime authority crosses here. */
  async writeAgentBackgroundSweep(
    assistantId: string,
    write: MatrixBackgroundSweepSettingWrite,
    signal: AbortSignal
  ): Promise<MatrixBackgroundSweepSaveResult> {
    return writeMatrixBackgroundSweepSetting(
      this.config.domain!.resource,
      (await this.agentGrant()).accessToken,
      assistantId,
      write,
      signal
    )
  }

  /** One routine mutation; the caller's request id makes a retry one mutation. */
  async mutateAgentRoutine(
    assistantId: string,
    input: MatrixAgentRoutineMutation,
    signal: AbortSignal
  ): Promise<MatrixAgentRoutine | { id: string; revision: number }> {
    return mutateMatrixAgentRoutine(this.config.domain!.resource, (await this.agentGrant()).accessToken, assistantId, input, signal)
  }

  /** One routine's recent runs, newest first. */
  async agentRoutineRuns(
    assistantId: string,
    routineId: string,
    signal: AbortSignal
  ): Promise<MatrixAgentRoutineRunsSnapshot> {
    return readMatrixAgentRoutineRuns(
      this.config.domain!.resource,
      (await this.agentGrant()).accessToken,
      assistantId,
      routineId,
      signal
    )
  }

  /** Writes one agent's definition, fenced by the revisions it was read at. */
  async writeAgentDefinition(
    assistantId: string,
    input: AtumAssistantDefinitionWrite,
    signal: AbortSignal
  ): Promise<MatrixAgentDefinitionSnapshot> {
    return writeMatrixAgentDefinition(this.config.domain!.resource, await this.agentGrant(), assistantId, input, signal)
  }

  /** Writes one agent's canonical platform photo with the live originating principal. */
  async writeAgentAvatar(
    assistantId: string,
    originPrincipal: string | null,
    targetPrincipal: string,
    avatar: { type: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array } | null,
    signal: AbortSignal
  ): Promise<MatrixAgentDefinitionSnapshot> {
    return writeMatrixAgentAvatar(
      this.config.domain!.resource,
      await this.agentGrant(),
      assistantId,
      originPrincipal,
      targetPrincipal,
      avatar,
      signal
    )
  }

  /** Live server-authorized profile management for a Hermes turn. */
  async agentProfiles(
    originPrincipal: string,
    input: Exclude<AgentProfileRequest, { operation: 'avatar' }>,
    signal: AbortSignal
  ): Promise<AgentProfileResult> {
    return requestMatrixAgentProfiles(
      this.config.domain!.resource,
      await this.agentGrant(),
      originPrincipal,
      input,
      signal
    )
  }

  /** Owner-private immutable skill bytes; never expose the domain grant to the renderer. */
  async putAgentSkill(assistantId: string, bundle: AtumSkillBundle, signal: AbortSignal) {
    return putMatrixAgentSkill(this.config.domain!.resource, await this.agentGrant(), assistantId, bundle, signal)
  }

  /** The same bytes back, exactly by hash, for this Mac's copy of the agent (agent-content). */
  async agentSkill(assistantId: string, sha256: string, signal: AbortSignal): Promise<AtumSkillBundle> {
    return getMatrixAgentSkill(this.config.domain!.resource, await this.agentGrant(), assistantId, sha256, signal)
  }

  /** Portable local-memory relay for this owned agent; the native grant never reaches Hermes. */
  async agentMemory(assistantId: string, signal: AbortSignal): Promise<AtumCloudMemory> {
    return readMatrixAgentMemory(this.config.domain!.resource, await this.agentGrant(), assistantId, signal)
  }

  /** Revision-fenced portable-memory write; raw memory never crosses renderer IPC. */
  async writeAgentMemory(
    assistantId: string,
    input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
    signal: AbortSignal,
    permitted: () => boolean = () => true
  ): Promise<AtumCloudMemory> {
    if (!permitted()) {
      throw new MatrixAgentDefinitionError('denied')
    }

    const grant = await this.agentGrant()
    signal.throwIfAborted()

    if (!permitted()) {
      throw new MatrixAgentDefinitionError('denied')
    }

    return writeMatrixAgentMemory(this.config.domain!.resource, grant, assistantId, input, signal)
  }

  /** Retires an agent for good on the platform; its local cleanup is revokeAgent. */
  async retireAgent(assistantId: string, signal: AbortSignal): Promise<MatrixAgentRetirement> {
    return retireMatrixAgent(this.config.domain!.resource, await this.agentGrant(), assistantId, signal)
  }

  /** Existing owner account flag, with the same native account/generation fence. */
  async petRoaming(owner: string, signal: AbortSignal): Promise<boolean> {
    const generation = this.generation
    const scope = this.appScope()
    const grant = await this.agentGrant()
    signal.throwIfAborted()
    if (!scope || generation !== this.generation || this.appScope()?.accountKey !== scope.accountKey) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await readMatrixPetRoaming(this.config.domain!.resource, grant, owner, signal)
    signal.throwIfAborted()
    if (generation !== this.generation || this.appScope()?.accountKey !== scope.accountKey) {
      throw new Error('matrix_pet_cancelled')
    }
    return result
  }

  /** Portable pet choice, with no local executor enrollment or runtime needed. */
  async agentPet(
    assistantId: string,
    expected: { owner: string; agent: string },
    signal: AbortSignal,
    write?: { revision: number; pet: AtumPetBinding }
  ) {
    const generation = this.generation

    const grant = await this.agentGrant().catch(error => {
      if (error instanceof Error && error.message === 'matrix_domain_unavailable') {
        throw new MatrixAgentDefinitionError('unavailable')
      }
      throw error
    })

    signal.throwIfAborted()

    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await requestMatrixAgentPet(
      this.config.domain!.resource,
      grant,
      assistantId,
      expected,
      signal,
      write
    )

    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  /** The signed-in account's pet shelf for one Matrix assistant. */
  async agentPets(
    assistantId: string,
    expected: { owner: string; agent: string },
    signal: AbortSignal
  ): Promise<MatrixPetCatalog> {
    const generation = this.generation
    const grant = await this.agentGrant().catch(error => {
      if (error instanceof Error && error.message === 'matrix_domain_unavailable') {
        throw new MatrixAgentDefinitionError('unavailable')
      }
      throw error
    })

    signal.throwIfAborted()
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await requestMatrixAgentPetCatalog(
      this.config.domain!.resource,
      grant,
      assistantId,
      expected,
      signal
    )
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  /** First visual read of the creation-default agent starts Gigi's server
   * visit. It is idempotent and intentionally has no local-clock fallback. */
  async beginAgentPetVisit(assistantId: string, signal: AbortSignal): Promise<void> {
    const generation = this.generation
    const grant = await this.agentGrant().catch(error => {
      if (error instanceof Error && error.message === 'matrix_domain_unavailable') {
        throw new MatrixAgentDefinitionError('unavailable')
      }
      throw error
    })

    signal.throwIfAborted()
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    await requestMatrixAgentPetVisit(this.config.domain!.resource, grant, assistantId, signal)
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
  }

  /** The owner's companion chat. Pet-scoped and account-bearer only: no
   * assistant, room or agent credential is read or sent. */
  async petChat(input: AtumPetChatRequest, signal: AbortSignal): Promise<AtumPetChatReply> {
    const generation = this.generation
    let grant = await this.agentGrant()
    signal.throwIfAborted()

    if (generation !== this.generation || !this.appScope() || !this.config.domain) {
      throw new Error('matrix_pet_cancelled')
    }

    const send = () => requestMatrixPetChat(this.config.domain!.resource, grant, input, signal)
    let result: AtumPetChatReply

    try {
      result = await send()
    } catch (error) {
      if (!(error instanceof MatrixPetChatAuthenticationError)) {
        throw error
      }

      if (generation !== this.generation || !this.appScope() || !this.config.domain) {
        throw new Error('matrix_pet_cancelled')
      }

      const current = this.domainOwner().domain

      if (!current) {
        throw new Error('matrix_domain_connection_required')
      }

      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      result = await send()
    }

    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  /** The companion's own personality, summary and last turns. No model call. */
  async petChatHistory(ref: AtumPetChatRef, signal: AbortSignal): Promise<AtumPetChatHistory> {
    const generation = this.generation
    let grant = await this.agentGrant()
    signal.throwIfAborted()

    if (generation !== this.generation || !this.appScope() || !this.config.domain) {
      throw new Error('matrix_pet_cancelled')
    }

    const send = () => requestMatrixPetChatHistory(this.config.domain!.resource, grant, ref, signal)
    let result: AtumPetChatHistory

    try {
      result = await send()
    } catch (error) {
      if (!(error instanceof MatrixPetChatAuthenticationError)) {
        throw error
      }

      if (generation !== this.generation || !this.appScope() || !this.config.domain) {
        throw new Error('matrix_pet_cancelled')
      }

      const current = this.domainOwner().domain

      if (!current) {
        throw new Error('matrix_domain_connection_required')
      }

      grant = current.accessToken === grant.accessToken ? await this.refreshDomain() : current
      result = await send()
    }

    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  /** Private personal-pet metadata and content, kept in main only. */
  async personalPets(signal: AbortSignal): Promise<AtumPersonalPet[]> {
    const generation = this.generation
    const grant = await this.agentGrant()
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await listMatrixPersonalPets(this.config.domain!.resource, grant, signal)
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  async personalPetContent(sha256: string, signal: AbortSignal): Promise<AtumSkillBundle> {
    const generation = this.generation
    const grant = await this.agentGrant()
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await getMatrixPersonalPetContent(this.config.domain!.resource, grant, sha256, signal)
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }

    return result
  }

  /** Main-process-only delivery of a Store-credit-backed personal pet. */
  async publishPersonalPet(
    input: {
      requestId: string
      creditEntitlementId: string
      displayName: string
      description: string
      bundle: AtumSkillBundle
    },
    signal: AbortSignal
  ): Promise<AtumPersonalPet> {
    const generation = this.generation
    const grant = await this.agentGrant()
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    const result = await publishMatrixPersonalPet(this.config.domain!.resource, grant, input, signal)
    if (generation !== this.generation || !this.appScope()) {
      throw new Error('matrix_pet_cancelled')
    }
    return result
  }

  /** The domain grant for roster calls, renewed only near expiry, as the lease does. */
  private async agentGrant(): Promise<DomainGrant> {
    const record = this.domainOwner()

    if (!record.domain || !this.config.domain) {
      throw new Error('matrix_domain_connection_required')
    }

    return record.domain.expiresAt !== undefined && record.domain.expiresAt <= Date.now() + 30_000
      ? this.refreshDomain()
      : record.domain
  }

  async appTurn(slug: string, input: MatrixAppTurn): Promise<{ text: string }> {
    input.signal.throwIfAborted()
    const generation = this.generation
    const enrolled = JSON.stringify(this.appEnrollment(slug))
    await this.readDomain(false)
    const record = this.domainOwner()

    const live = () => {
      input.signal.throwIfAborted()

      if (
        generation !== this.generation ||
        JSON.stringify(this.appEnrollment(slug)) !== enrolled ||
        this.domainOwner().domain?.sessionId !== record.domain?.sessionId
      ) {
        throw new Error('matrix_invocation_cancelled')
      }
    }

    live()
    const result = await requestAppTurn(this.config.domain!.resource, record.domain!, slug, input)
    live()

    return result
  }

  enrollment(slug?: string): MatrixEnrollment {
    return this.participantEnrollment(slug)
  }

  /** Another of the person's agents (0146), by principal. */
  agentEnrollment(agent: string): MatrixEnrollment {
    return this.participantEnrollment({ agent })
  }

  /** Native-only custody metadata, not enrollment authority. A withdrawn credential stays
   * inert in its physical slot so roster metadata and recovery never borrow a new default's
   * principal. No token, device or usable identity leaves this projection. */
  retainedAgentPrincipal(agent?: string): string | undefined {
    return participantAgentPrincipal(this.domainOwner(), agent === undefined ? undefined : { agent })
  }

  /** Physical device metadata for local erasure, including an inert withdrawn
   * enrollment. It conveys neither a token nor authority to start an SDK host. */
  retainedAgentDevice(agent?: string): MatrixIdentity | undefined {
    const enrolled = participant(this.domainOwner(), agent === undefined ? undefined : { agent })
    const identity = enrolled?.credential ?? enrolled?.cleanupIdentity

    return identity ? { userId: identity.userId, deviceId: identity.deviceId } : undefined
  }

  /** The person's other agents enrolled on this Mac. */
  agentEnrollments(): string[] {
    return Object.keys(this.domainOwner().agentEnrollments ?? {})
  }

  /** Device IDs of the non-human participants this Mac enrolled (agents and integrated apps):
   * their Matrix sessions are Atum's, never a person signing in (new-sign-in-alert.ts). */
  agentDeviceIds(): string[] {
    const record = this.read()

    if (!record || record.signingOut) {
      return []
    }

    return allParticipants(record).flatMap(value => (value?.credential ? [value.credential.deviceId] : []))
  }

  private participantEnrollment(slug: Participant): MatrixEnrollment {
    const record = this.domainOwner()
    const enrollment = participant(record, slug)

    if (
      (slug === undefined && record.localHermes?.cleanupPending) ||
      (typeof slug === 'object' && record.agentHermes?.[slug.agent]?.cleanupPending)
    ) {
      return { state: 'revoking', identity: null }
    }

    if (!enrollment) {
      return { state: 'absent', identity: null }
    }

    if (enrollment.state === 'withdrawn') {
      return { state: 'withdrawn', identity: null }
    }

    if (enrollment.state !== 'ready' || !enrollment.credential) {
      return { state: enrollment.state === 'revoking' ? 'revoking' : 'pending', identity: null }
    }

    return {
      state: enrollment.credential.expiresAt <= Date.now() ? 'expired' : 'ready',
      identity:
        typeof slug === 'string'
          ? appEnrollmentIdentity(enrollment.credential as AppCredential)
          : enrollmentIdentity(enrollment.credential)
    }
  }

  /** Non-interactive setup never opens the browser; it needs an existing domain grant. */
  enrollHermes(interactive = true): Promise<MatrixEnrollment> {
    return this.enrollParticipant(undefined, interactive)
  }

  /** Enrolls this Mac's executor for another of the person's agents (0146). */
  enrollAgent(agent: string, interactive = false): Promise<MatrixEnrollment> {
    return this.enrollParticipant({ agent }, interactive)
  }

  /**
   * Renews an agent's ready executor credential before it expires (the default agent's
   * when `agent` is undefined). The platform rotates the same executor (0146's `rotate`):
   * the same MAS session and device, a new token and a new hour. MAS revokes the old token
   * as it issues the new one, so the caller hands the new one to the agent's SDK at once.
   *
   * - Only an agent's: an app's session keeps its own consent rules and is not renewed.
   * - Never beside an enrollment or revocation of the same agent: those wait for it, and it
   *   refuses to start while one runs.
   * - The same agent, user and device, or nothing is written.
   * - A refusal under 0150's bounds waits for its Retry-After (MatrixEnrollmentRateLimited).
   * - Nothing is written after a sign-out, an account change or a replaced enrollment.
   */
  renewAgentExecutor(agent?: string): Promise<MatrixEnrollment> {
    const selector: Participant = agent === undefined ? undefined : { agent }
    const key = participantKey(selector)
    let pending = this.renewalPending.get(key)

    if (!pending) {
      pending = this.renewAgentExecutorOnce(selector).finally(() => this.renewalPending.delete(key))
      this.renewalPending.set(key, pending)
    }

    return pending
  }

  private async renewAgentExecutorOnce(selector: undefined | { agent: string }): Promise<MatrixEnrollment> {
    const key = participantKey(selector)
    const generation = this.generation
    const record = this.domainOwner()
    const enrolled = participant(record, selector)

    if (
      this.enrollmentPending.has(key) ||
      this.enrollmentRevocationPending.has(key) ||
      (selector === undefined && record.localHermes?.cleanupPending) ||
      (selector !== undefined && record.agentHermes?.[selector.agent]?.cleanupPending)
    ) {
      throw new Error('matrix_enrollment_pending')
    }

    // The last renewal the vault could not keep is saved first (the next try after a full disk),
    // never re-issued: the platform has already rotated to it.
    const held = this.heldAgents.get(key)
    this.heldAgents.delete(key)

    if (
      held &&
      enrolled?.state === 'ready' &&
      !enrolled.app &&
      held.storageKey === record.storageKey &&
      held.executorId === enrolled.executorId &&
      enrolled.credential?.accessToken === held.replaces &&
      held.credential.expiresAt > Date.now()
    ) {
      this.keepRenewed(record, selector, { ...enrolled, credential: held.credential }, held)

      return this.participantEnrollment(selector)
    }

    if (
      enrolled?.state !== 'ready' ||
      !enrolled.credential ||
      enrolled.app ||
      enrolled.credential.expiresAt <= Date.now() ||
      !record.domain ||
      !this.config.domain
    ) {
      throw new Error('matrix_agent_unavailable')
    }

    this.requireEnrollmentAllowed(this.waitKey(record, selector))
    const previous = enrolled.credential
    const agentPrincipal = selector?.agent ?? previous.agentPrincipal
    const hostDevice = this.retainedHostDevice(enrolled)
    const owner = { issuer: previous.issuer, subject: previous.subject, principal: previous.principal }

    let grant: DomainGrant | undefined

    const rotate = (used: DomainGrant) => {
      grant = used

      // The provider already binds an existing executor to its agent (0146/0150). Name the
      // retained principal too, so an absent/recreated executor cannot resolve a new default.
      return hostDevice === undefined
        ? requestEnrollment(this.config.domain!.resource, used, enrolled.executorId, 'POST', undefined, agentPrincipal)
        : requestEnrollment(
            this.config.domain!.resource,
            used,
            enrolled.executorId,
            'POST',
            undefined,
            agentPrincipal,
            hostDevice
          )
    }

    let response: unknown

    try {
      try {
        response = await rotate(await this.agentGrant())
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'matrix_enrollment_authentication') {
          throw error
        }

        // As the lease does: refresh the domain grant once, never into another account.
        if (generation !== this.generation || this.domainOwner().domain?.sessionId !== record.domain.sessionId) {
          throw new Error('matrix_login_cancelled')
        }

        response = await rotate(await this.refreshDomain())
      }
    } catch (error) {
      this.noteEnrollmentRefusal(this.waitKey(record, selector), error)

      if (grant && error instanceof Error && error.message === 'matrix_enrollment_denied') {
        this.withdrawAgentExecutor(record, selector, enrolled, generation, grant)
      }

      throw error
    }

    const credential = agentCredential(response, owner, enrolled.executorId, {
      agentPrincipal
    })

    // A rotation keeps the session, so its agent, user and device: a hot swap into the
    // agent's running SDK depends on it.
    if (
      credential.agentPrincipal !== previous.agentPrincipal ||
      credential.userId !== previous.userId ||
      credential.deviceId !== previous.deviceId
    ) {
      throw new Error('matrix_enrollment_invalid')
    }

    const current = this.domainOwner()
    const still = participant(current, selector)

    if (
      generation !== this.generation ||
      current.storageKey !== record.storageKey ||
      still?.state !== 'ready' ||
      still.executorId !== enrolled.executorId ||
      still.credential?.accessToken !== previous.accessToken
    ) {
      throw new Error('matrix_login_cancelled')
    }

    this.keepRenewed(current, selector, { ...still, credential }, {
      storageKey: current.storageKey,
      executorId: still.executorId,
      replaces: previous.accessToken,
      credential
    })

    return this.participantEnrollment(selector)
  }

  /** Saves an agent's renewed credential; one the vault can't keep is held for that agent's next
   * renewal (heldAgents) rather than lost, and the renewal fails as a passing vault error. */
  private keepRenewed(
    record: AccountRecord,
    selector: undefined | { agent: string },
    renewed: EnrollmentRecord,
    held: HeldAgentCredential
  ) {
    try {
      this.write(setParticipant(record, renewed, selector))
    } catch {
      this.heldAgents.set(participantKey(selector), held)

      throw new Error('matrix_vault_unavailable')
    }
  }

  /** Whose wait: this account's (its storage key), this participant's, enrolling (which
   * includes renewing) or revoking. */
  private waitKey(record: AccountRecord, selector: Participant, kind: 'enroll' | 'revoke' = 'enroll'): string {
    return `${kind}:${record.storageKey}:${participantKey(selector)}`
  }

  /** While the platform asked to wait (Retry-After), nothing of that kind is sent. */
  private requireEnrollmentAllowed(key: string): void {
    const until = this.enrollmentWaits.get(key)

    if (until === undefined) {
      return
    }

    if (until > Date.now()) {
      throw new MatrixEnrollmentRateLimited(until - Date.now())
    }

    this.enrollmentWaits.delete(key)
  }

  private noteEnrollmentRefusal(key: string, error: unknown): void {
    if (error instanceof MatrixEnrollmentRateLimited) {
      this.enrollmentWaits.set(key, Math.max(this.enrollmentWaits.get(key) ?? 0, Date.now() + error.retryAfterMs))
    }
  }

  /**
   * Bearer for the loopback managed-model proxy: the current domain grant, refreshed
   * when due or when the gateway refused it. Never opens a browser; null when the
   * person must sign in (again).
   */
  async managedModelBearer(refresh = false): Promise<string | null> {
    let grant: DomainGrant | undefined

    try {
      grant = this.domainOwner().domain
    } catch {
      return null
    }

    if (!grant) {
      return null
    }

    if (refresh || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000)) {
      try {
        grant = await this.refreshDomain()
      } catch {
        return null
      }
    }

    return grant.accessToken
  }

  /**
   * The person's own Atum account grant for the Drive engine, handed over their local channel
   * (`atum.drive-app-credential/1`). The engine gets only this short-lived access token; the
   * refresh token never leaves this process, and a renewal is another call here. Main-only:
   * never returned to the renderer. Null when this Mac has no account grant.
   *
   * `refused` is the token the engine just had refused. A rotation replaces the person's grant for
   * every caller on this Mac, so it happens only while that token is still current; a newer token
   * from another caller is handed over as is. `expected` is the identity the engine pinned in its
   * `start` frame: a token handed over after the first one must still resolve to it at `/me`, never
   * silently become another person's.
   */
  async driveCredential(
    refused?: string,
    expected?: { issuer: string; subject: string }
  ): Promise<{ accessToken: string; expiresAt?: number } | null> {
    let grant: DomainGrant | undefined

    try {
      grant = this.domainOwner().domain
    } catch {
      return null
    }

    if (!grant) {
      return null
    }

    let rotated = false
    const rotate = refused !== undefined && grant.accessToken === refused

    if (rotate || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + TOKEN_FRESH_MS)) {
      try {
        grant = await this.refreshDomain()
        rotated = true
      } catch {
        return null
      }
    }

    // A fresh sign-in already proves its subject. Every later handoff (a rotation, or the token
    // another caller rotated) must still resolve to the identity the engine pinned at `start`.
    // Offline (the request itself failed or did not answer) the saved grant stands; a definitive
    // 401 or a different issuer/subject refuses it.
    if (rotated || expected) {
      const want = expected ?? { issuer: grant.issuer, subject: grant.subject }
      const pinned = { ...grant, issuer: want.issuer, subject: want.subject }
      let identity: Awaited<ReturnType<typeof readDomainIdentity>> | undefined

      try {
        identity = await readDomainIdentity(this.config.domain!.resource, pinned)
      } catch (error) {
        // Only another issuer/subject is a refusal; an unreachable platform is not.
        identity = error instanceof Error && error.message === 'matrix_domain_invalid' ? null : undefined
      }

      if (identity === null || (identity && (identity.issuer !== want.issuer || identity.subject !== want.subject))) {
        return null
      }
    }

    return { accessToken: grant.accessToken, ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}) }
  }

  /** Local-only key between Hermes and the proxy, derived per ready Hermes executor. */
  managedModelKey(agent?: string): string | null {
    try {
      const enrollment = participant(this.domainOwner(), agent === undefined ? undefined : { agent })

      if (enrollment?.state !== 'ready' || !enrollment.storageKey) {
        return null
      }

      return matrixManagedModelKey(enrollment.storageKey)
    } catch {
      return null
    }
  }

  /** Every ready executor's proxy key on this Mac, each with its agent (undefined for the
   * default), read in one pass for the loopback proxy (per-agent runtime plan §2.5). */
  managedModelKeys(): Array<{ key: string; agent?: string }> {
    try {
      const record = this.domainOwner()

      return [undefined, ...Object.keys(record.agentEnrollments ?? {})].flatMap(agent => {
        const enrollment = participant(record, agent === undefined ? undefined : { agent })

        return enrollment?.state === 'ready' && enrollment.storageKey
          ? [{ key: matrixManagedModelKey(enrollment.storageKey), ...(agent === undefined ? {} : { agent }) }]
          : []
      })
    } catch {
      return []
    }
  }

  appEnrollments(): string[] {
    return Object.keys(this.domainOwner().apps ?? {})
  }

  appEnrollment(slug: string): MatrixAppEnrollment {
    matrixExecutorPath(slug)
    const record = this.domainOwner()
    const stored = participant(record, slug)

    if (stored) {
      if (
        !stored.app ||
        stored.app.slug !== slug ||
        !Number.isFinite(stored.app.disclosedAt) ||
        typeof stored.app.ownerPrincipal !== 'string'
      ) {
        throw new Error('matrix_enrollment_invalid')
      }

      validateAppEnrollmentSelection(stored.app)

      if (stored.credential) {
        appCredential(
          stored.credential,
          { issuer: record.issuer, subject: record.subject, principal: stored.app.ownerPrincipal },
          stored.executorId,
          { ...stored.app, ownerUserId: record.userId },
          { allowExpired: true }
        )
      }
    }

    const enrollment = this.enrollment(slug)

    return {
      ...enrollment,
      identity: enrollment.identity as MatrixAppEnrollment['identity'],
      selection: stored?.app ? { appId: stored.app.appId, appVersionId: stored.app.appVersionId } : null
    }
  }

  enrollApp(app: AppEnrollmentSelection, disclosureAccepted: true): Promise<MatrixAppEnrollment> {
    validateAppEnrollmentSelection(app)

    if (disclosureAccepted !== true) {
      throw new Error('matrix_disclosure_required')
    }

    return this.enrollParticipant({
      slug: app.slug,
      appId: app.appId,
      appVersionId: app.appVersionId
    }) as Promise<MatrixAppEnrollment>
  }

  private enrollParticipant(
    target?: AppEnrollmentSelection | { agent: string },
    interactive = true
  ): Promise<MatrixEnrollment> {
    const app = target && 'slug' in target ? target : undefined

    if (app && this.withdrawingApps.has(app.slug)) {
      throw new Error('matrix_enrollment_revoke_pending')
    }

    const selector: Participant = app ? app.slug : target && 'agent' in target ? { agent: target.agent } : undefined
    const key = participantKey(selector)
    const existing = participant(this.domainOwner(), selector)

    if (existing?.state === 'withdrawn') {
      return Promise.reject(new Error('matrix_enrollment_withdrawn'))
    }

    if (app && existing && (existing.app?.appId !== app.appId || existing.app.appVersionId !== app.appVersionId)) {
      throw new Error('matrix_app_enrollment_changed')
    }

    let pending = this.enrollmentPending.get(key)

    if (pending && JSON.stringify(this.enrollmentSelections.get(key)) !== JSON.stringify(app)) {
      throw new Error('matrix_app_enrollment_changed')
    }

    if (!pending) {
      this.enrollmentSelections.set(key, app)
      pending = this.enrollParticipantOnce(target, interactive).finally(() => {
        this.enrollmentPending.delete(key)
        this.enrollmentSelections.delete(key)
      })
      this.enrollmentPending.set(key, pending)
    }

    return pending
  }

  private async enrollParticipantOnce(
    target?: AppEnrollmentSelection | { agent: string },
    interactive = true
  ): Promise<MatrixEnrollment> {
    const app = target && 'slug' in target ? target : undefined
    const agent = target && 'agent' in target ? target.agent : undefined
    const selector: Participant = app ? app.slug : agent !== undefined ? { agent } : undefined

    const result = () =>
      app ? this.appEnrollment(app.slug) : agent !== undefined ? this.agentEnrollment(agent) : this.enrollment()

    // A renewal of the same agent finishes first: two rotations of one executor never race.
    await this.renewalPending.get(participantKey(selector))?.catch(() => {})

    if (participant(this.domainOwner(), selector)?.state === 'withdrawn') {
      throw new Error('matrix_enrollment_withdrawn')
    }

    const owner = await this.readDomain(interactive)
    const generation = this.generation
    let initialPrincipal: string | undefined

    // A new person has no agent account yet; the platform creates it (idempotently)
    // before any enrollment intent is recorded, so a failure leaves nothing pending.
    if (!app && agent === undefined && !participantAgentPrincipal(this.domainOwner())) {
      const ensured = await ensureDomainAssistant(this.config.domain!.resource, this.domainOwner().domain!)

      if (generation !== this.generation) {
        throw new Error('matrix_login_cancelled')
      }

      if (!ensured) {
        throw new Error('matrix_assistant_unavailable')
      }

      initialPrincipal = ensured.agentPrincipal
    }

    let record = this.domainOwner()
    const previous = participant(record, selector)

    if (previous?.state === 'withdrawn') {
      throw new Error('matrix_enrollment_withdrawn')
    }

    if (
      (!app && agent === undefined && record.localHermes?.cleanupPending) ||
      (agent !== undefined && record.agentHermes?.[agent]?.cleanupPending) ||
      (app && this.withdrawingApps.has(app.slug)) ||
      previous?.state === 'revoking' ||
      this.enrollmentRevocationPending.has(participantKey(selector))
    ) {
      throw new Error('matrix_enrollment_revoke_pending')
    }

    if (previous?.state === 'ready' && previous.credential!.expiresAt > Date.now()) {
      return result()
    }

    // An expired app session needs explicit withdrawal and fresh disclosure;
    // never erase the old device/key or silently accept a replacement link.
    if (app && previous?.credential) {
      throw new Error('matrix_app_enrollment_changed')
    }

    // A cloud-only assistant is answered for by the cloud: no local executor is created, so
    // no POST is sent (the platform fences it with `cloud_answering`). Report the custody
    // that already exists; an absent local enrollment is the expected state, not a failure.
    if (!app && this.hooks.localExecutorRequired?.(agent) === false) {
      return result()
    }

    // Asked to wait (0150): nothing is sent, and the record is left as it is.
    this.requireEnrollmentAllowed(this.waitKey(record, selector))

    const hostDevice = previous
      ? this.retainedHostDevice(previous)
      : await this.creationHostDevice(generation, record, app)

    // Capability discovery is a read that may yield; reload before writing so a concurrent
    // app enrollment cannot be overwritten by the otherwise unchanged local intent.
    if (!previous) {
      record = this.domainOwner()

      if (participant(record, selector)) {
        throw new Error('matrix_login_cancelled')
      }
    }

    const executorId = previous?.executorId ?? randomUUID()
    const storageKey = previous?.storageKey ?? randomBytes(32).toString('base64')
    // Root is a physical custody slot, not the mutable platform default role. Only its
    // first provisioning resolves the default; subsequent issuance stays with its owner.
    const agentPrincipal = agent ?? (!app ? (participantAgentPrincipal(record) ?? initialPrincipal) : undefined)

    // A root and a named slot must never issue for the same agent. Include pending
    // intent so concurrent setup/restart cannot create then revoke duplicate devices.
    // (The root's selector is `undefined`, so the match is a list, never a bare find.)
    const duplicates = app
      ? []
      : participantSelectors(record).filter(
          other =>
            participantKey(other) !== participantKey(selector) &&
            participantAgentPrincipal(record, other) === agentPrincipal
        )

    if (duplicates.length) {
      await this.releaseStaleDuplicate(record, selector, duplicates[0], agentPrincipal)

      throw new Error('matrix_enrollment_invalid')
    }

    // Persist intent BEFORE issuance. Lost delivery/restart uses this same ID,
    // never an untracked replacement. Only main can choose it.
    const intent: EnrollmentRecord = {
      executorId,
      state: 'pending',
      storageKey,
      ...(!app && agentPrincipal ? { agentPrincipal } : {}),
      ...(!app && hostDevice ? { hostDevice } : {}),
      // An expired agent's key/device/token remain inert custody during a retry, including
      // after restart. Apps keep their separate explicit withdrawal/disclosure contract.
      ...(!app && previous?.credential ? { credential: previous.credential } : {}),
      ...(app ? { app: previous?.app ?? { ...app, disclosedAt: Date.now(), ownerPrincipal: owner.principal } } : {})
    }

    this.write(setParticipant(record, intent, selector))

    try {
      const response = app
        ? await requestEnrollment(this.config.domain!.resource, record.domain!, executorId, 'POST', {
            slug: app.slug,
            appVersionId: app.appVersionId,
            disclosureAccepted: true
          })
        : agentPrincipal !== undefined
          ? hostDevice === undefined
            ? await requestEnrollment(
                this.config.domain!.resource,
                record.domain!,
                executorId,
                'POST',
                undefined,
                agentPrincipal
              )
            : await requestEnrollment(
                this.config.domain!.resource,
                record.domain!,
                executorId,
                'POST',
                undefined,
                agentPrincipal,
                hostDevice
              )
          : hostDevice === undefined
            ? await requestEnrollment(this.config.domain!.resource, record.domain!, executorId, 'POST')
            : await requestEnrollment(
                this.config.domain!.resource,
                record.domain!,
                executorId,
                'POST',
                undefined,
                undefined,
                hostDevice
              )

      const credential = app
        ? appCredential(response, owner, executorId, { ...app, ownerUserId: record.userId })
        : agentCredential(response, owner, executorId, { agentPrincipal })

      if (!app && previous?.credential) {
        // Names of the fields that differ, never their values.
        const changed = (['issuer', 'subject', 'principal', 'agentPrincipal', 'userId', 'deviceId'] as const).filter(
          field => credential[field] !== previous.credential![field]
        )

        if (changed.length) {
          console.warn(`[Matrix] enrollment refused: the issued identity differs from this slot's (${changed.join(', ')})`)

          throw new Error('matrix_enrollment_invalid')
        }
      }

      const current = this.domainOwner()

      if (
        generation !== this.generation ||
        current.storageKey !== record.storageKey ||
        participant(current, selector)?.state !== 'pending'
      ) {
        throw new Error('matrix_login_cancelled')
      }

      if (
        credential.userId === record.userId ||
        allParticipants(current).some(
          value => value?.executorId !== executorId && value?.credential?.userId === credential.userId
        )
      ) {
        console.warn(
          `[Matrix] enrollment refused: the issued Matrix user is ${credential.userId === record.userId ? "the person's own" : 'already held by another slot here'}`
        )

        throw new Error('matrix_enrollment_invalid')
      }

      this.write(setParticipant(current, { ...intent, state: 'ready', credential }, selector))

      return result()
    } catch (error) {
      this.noteEnrollmentRefusal(this.waitKey(record, selector), error)

      if (!app && error instanceof Error && error.message === 'matrix_enrollment_denied' && previous?.credential) {
        this.withdrawAgentExecutor(
          record,
          agent === undefined ? undefined : { agent },
          previous,
          generation,
          record.domain!,
          intent
        )
      }

      // Preserve the same executor on transient failures or failed vault writes.
      // Cancellation/logout still reclaims an issuance. A rejected first identity has no
      // custody to preserve, but a mismatch must never destroy an existing agent's inert
      // credential, crypto key or retained Hermes profile.
      if (
        generation !== this.generation ||
        (!previous?.credential && error instanceof Error && error.message === 'matrix_enrollment_invalid')
      ) {
        const current = this.read()
        const still = current && participant(current, selector)

        // Cleanup must not revoke whichever successor now occupies the same slot.
        if (
          current?.storageKey === record.storageKey &&
          current.domain?.sessionId === record.domain?.sessionId &&
          still?.state === 'pending' &&
          still.executorId === intent.executorId &&
          still.storageKey === intent.storageKey &&
          still.credential?.accessToken === intent.credential?.accessToken
        ) {
          await this.revokeEnrollment(selector).catch(() => {})
        }
      }

      throw error
    }
  }

  /**
   * The root and a named slot both name one agent here, so neither may issue (the guard
   * above). One of them can be a dead end: an intent that was never issued (no credential,
   * so no device, key or token to keep) left by an earlier build or launch. A root pinned
   * by such an intent keeps refusing setup and keeps the agent's named slot from running
   * here, so the agent has no runtime on this Mac until someone clears it (Mac mini,
   * 2026-10-04). Withdraw exactly that intent, through the ordinary revocation (the
   * platform revokes or tombstones its executor): the root's when the named slot serves
   * the agent (2026-10-02: a default with named custody stays in that slot), the named
   * one's when the root holds the agent's credential. Never an intent whose issuance is in
   * flight in this process, never a slot with a credential. The refused attempt still fails;
   * the next one sees the cleared slot.
   */
  private async releaseStaleDuplicate(
    record: AccountRecord,
    selector: Participant,
    duplicate: Participant,
    agentPrincipal: string | undefined
  ): Promise<void> {
    const slotName = (slot: Participant) => (slot === undefined ? 'root' : 'named')
    const agentName = (agentPrincipal ?? 'unknown').slice(0, 8)
    const stale = (slot: Participant) => {
      const value = participant(record, slot)

      return (
        value?.state === 'pending' &&
        !value.credential &&
        // The slot being enrolled now is this call; any other one must not be in flight.
        (participantKey(slot) === participantKey(selector) || !this.enrollmentPending.has(participantKey(slot))) &&
        !this.enrollmentRevocationPending.has(participantKey(slot))
      )
    }

    const root = selector === undefined ? selector : duplicate
    const named = selector === undefined ? duplicate : selector
    const namedValue = participant(record, named)
    const rootValue = participant(record, root)
    const release =
      agentPrincipal !== undefined && root === undefined && typeof named === 'object'
        ? stale(root) && namedValue !== undefined && namedValue.state !== 'withdrawn'
          ? root
          : stale(named) && rootValue?.credential
            ? named
            : null
        : null

    console.warn(
      `[Matrix] enrollment refused: the ${slotName(selector)} slot and a ${slotName(duplicate)} slot both hold ` +
        `agent ${agentName} here${release === null ? '' : `; withdrawing the ${slotName(release)} intent that was never issued`}`
    )

    if (release !== null) {
      await this.revokeEnrollment(release).catch(() => {
        console.warn(`[Matrix] the ${slotName(release)} intent for agent ${agentName} is still being withdrawn`)
      })
    }
  }

  /** A stored creation binding is immutable: bad custody is never silently cleared. */
  private retainedHostDevice(enrollment: EnrollmentRecord): string | undefined {
    if (enrollment.hostDevice !== undefined && !printableDeviceId(enrollment.hostDevice)) {
      throw new Error('matrix_enrollment_invalid')
    }

    return enrollment.hostDevice
  }

  /** Probe only before a new local creation intent; old/pending intent bodies never change. */
  private async creationHostDevice(
    generation: number,
    record: AccountRecord,
    app: AppEnrollmentSelection | undefined
  ): Promise<string | undefined> {
    if (app) {
      return undefined
    }

    const hostDevice = record.deviceId

    if (!printableDeviceId(hostDevice)) {
      throw new Error('matrix_enrollment_invalid')
    }

    const supported = await requestLocalEnrollmentCapabilities(this.config.domain!.resource, record.domain!)
    const current = this.domainOwner()

    if (
      generation !== this.generation ||
      current.storageKey !== record.storageKey ||
      current.domain?.sessionId !== record.domain?.sessionId
    ) {
      throw new Error('matrix_login_cancelled')
    }

    return supported ? hostDevice : undefined
  }

  private revokeEnrollment(slug?: Participant): Promise<void> {
    const key = participantKey(slug)
    let pending = this.enrollmentRevocationPending.get(key)

    if (!pending) {
      pending = this.revokeEnrollmentOnce(slug).finally(() => this.enrollmentRevocationPending.delete(key))
      this.enrollmentRevocationPending.set(key, pending)
    }

    return pending
  }

  private async revokeEnrollmentOnce(slug?: Participant): Promise<void> {
    // A renewal in flight finishes first; revocation then withdraws whatever it left.
    await this.renewalPending.get(participantKey(slug))?.catch(() => {})
    let record = this.read()
    let localFailure = false

    const agentHome = typeof slug === 'object' ? record?.agentHermes?.[slug.agent] : undefined

    if (typeof slug === 'object' && record && agentHome) {
      // As the default agent's profile below: both intents persist together.
      agentHome.cleanupPending = true
      const enrolled = participant(record, slug)

      if (enrolled) {
        record = setParticipant(record, { executorId: enrolled.executorId, state: 'revoking' }, slug)
      }

      this.write({ ...record, agentHermes: { ...record.agentHermes, [slug.agent]: agentHome } })

      try {
        await this.clearLocalHermes(agentHome.home, slug.agent)
        const current = this.read()!
        const homes = { ...current.agentHermes }
        delete homes[slug.agent]
        this.write({ ...current, agentHermes: homes })
      } catch {
        localFailure = true
      }

      record = this.read()
    }

    if (slug === undefined && record?.localHermes) {
      record.localHermes.cleanupPending = true

      // Persist BOTH intents together: a crash after removing the local marker
      // must not revive an enrollment whose remote revocation has yet to run.
      if (record.enrollment) {
        record.enrollment = { executorId: record.enrollment.executorId, state: 'revoking' }
      }

      this.write(record)

      try {
        await this.clearLocalHermes(record.localHermes.home)
        const current = this.read()!
        delete current.localHermes
        this.write(current)
      } catch {
        // Still attempt remote revocation. A local disk/runtime failure must
        // neither keep the agent authorized nor discard this cleanup intent.
        localFailure = true
      }

      record = this.read()
    }

    const enrolled = record && participant(record, slug)

    if (!record || !enrolled) {
      if (localFailure) {
        throw new Error('matrix_local_cleanup_pending')
      }

      return
    }

    const executorId = enrolled.executorId

    const revoking = revokingParticipant(enrolled, typeof slug === 'string')
    const identity = revoking.cleanupIdentity
    this.write(setParticipant(record, revoking, slug))

    if (typeof slug === 'string' && identity) {
      try {
        await this.clearAppDevice(slug, identity)
        const current = this.read()!
        const pending = participant(current, slug)!
        delete pending.cleanupIdentity
        this.write(current)
      } catch {
        localFailure = true
      }
    }

    if (!record.domain || !this.config.domain) {
      throw new Error('matrix_enrollment_revoke_pending')
    }

    let grant = record.domain

    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000) {
      grant = await this.refreshDomain()
    }

    // An agent's executor is revoked like the default's: the platform knows its agent.
    const revoke = () =>
      typeof slug === 'string'
        ? requestEnrollment(this.config.domain!.resource, grant, executorId, 'DELETE', { slug })
        : requestEnrollment(this.config.domain!.resource, grant, executorId, 'DELETE')

    // Only withdrawing an executor the platform never recorded is bounded (0150's tombstones),
    // under its own key: a wait for an enrollment never holds up a revocation.
    const waited = this.waitKey(record, slug, 'revoke')
    this.requireEnrollmentAllowed(waited)

    try {
      try {
        await revoke()
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'matrix_enrollment_authentication') {
          throw error
        }

        grant = await this.refreshDomain()
        await revoke()
      }
    } catch (error) {
      this.noteEnrollmentRefusal(waited, error)

      throw error
    }

    const current = this.read()

    if (!current || participant(current, slug)?.executorId !== executorId) {
      throw new Error('matrix_enrollment_invalid')
    }

    // Hermes has its separate retained profile-cleanup marker. Apps retain
    // this enrollment's cleanup identity until Chromium erasure also succeeds.
    if (!localFailure || typeof slug !== 'string') {
      this.write(setParticipant(current, undefined, slug))
    }

    if (localFailure) {
      throw new Error('matrix_local_cleanup_pending')
    }
  }

  /** Revokes this Mac's executor for another agent (retire, sign-out): its Hermes
   * credentials are cleared locally first, and its profile folder is kept. */
  async revokeAgent(agent: string): Promise<MatrixEnrollment> {
    this.domainOwner()
    await this.enrollmentPending.get(participantKey({ agent }))?.catch(() => {})
    await this.revokeEnrollment({ agent })

    return this.agentEnrollment(agent)
  }

  async revokeHermes(): Promise<MatrixEnrollment> {
    this.domainOwner()
    this.cancel()
    await this.enrollmentPending.get('')?.catch(() => {})
    await this.revokeEnrollment()

    return this.enrollment()
  }

  revokeApp(slug: string): Promise<MatrixAppEnrollment> {
    matrixExecutorPath(slug)
    this.domainOwner()
    let pending = this.withdrawingApps.get(slug)

    if (!pending) {
      pending = this.revokeAppOnce(slug).finally(() => this.withdrawingApps.delete(slug))
      this.withdrawingApps.set(slug, pending)
    }

    return pending
  }

  private async revokeAppOnce(slug: string): Promise<MatrixAppEnrollment> {
    // Mark pending enrollment closed before awaiting a late issuance response.
    const record = this.read()!
    const current = participant(record, slug)

    if (current) {
      this.write(setParticipant(record, revokingParticipant(current, true), slug))
    }

    await this.enrollmentPending.get(slug)?.catch(() => {})
    await this.revokeEnrollment(slug)

    return this.appEnrollment(slug)
  }
}
