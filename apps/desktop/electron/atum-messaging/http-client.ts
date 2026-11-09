import { randomUUID } from 'node:crypto'

import { type AtumPetWrite, parsePersonalPet, parsePetBundle, parsePetList } from '../../shared/atum-account-pets'
import { type AtumAccountPreferences, parseCloudPreferences } from '../../shared/atum-account-preferences'
import {
  type AdvisorySearchRequest,
  type AdvisorySearchResult,
  parseAdvisorySearchResult
} from '../../shared/atum-advisory-search'
import { type AtumMemorySnapshot, type AtumSkillBundle, parseCloudMemory, parseSkillBundle } from '../../shared/atum-agent-content'
import {
  assistantDefinitionWriteWire,
  type AtumAssistantDefinitionSnapshot,
  type AtumAssistantDefinitionWrite
} from '../../shared/atum-agent-portability'
import {
  GROUP_ADDRESSING_HEADER,
  GROUP_CONVERSATIONS_HEADER,
  GROUP_SHARED_AGENTS_HEADER,
  type GroupOperationInput,
  PRIVATE_ADVISORY_HEADER
} from '../../shared/atum-group-conversations'
import { type AtumAgentHire, type AtumExecutionTask, type AtumHireResult, parseAgentHire, parseAgentHires, parseExecutionTask, parseHireResult } from '../../shared/atum-hiring'
import { PARTICIPANT_REFS_HEADER } from '../../shared/atum-participants'
import { parseProtonRewardClaim, parseProtonRewards, type ProtonRewardClaim, type ProtonRewardKind, type ProtonRewards } from '../../shared/atum-proton-rewards'
import { DESKTOP_VERSION_HEADER, desktopVersionHeaderValue } from '../desktop-version-header'

import type { CreateDirectConversationRequest, DirectMessagingTransport } from './direct-transport'
import { parseGroupDetail } from './group-wire'
import type {
  ClaimedPrivateAdvisoryJob,
  PrivateAdvisoryContext,
  PrivateAdvisoryJobRequest
} from './private-advisory-runner'
import {
  ATUM_SOCIAL_VERSION,
  parseSocialLookupResponse,
  parseSocialMutationResponse,
  parseSocialSyncResponse,
  type SocialMutationAction
} from './social'
import { MessagingTransportError } from './transport-error'
import type {
  AssistantRegistration,
  AssistantRegistrationResult,
  AvatarUploadReservation,
  IdentityHandleAvailability,
  IdentityProfileUpdate,
  LinkedIdentityApp,
  MentionTargetsResponse,
  MessagingAccountSession,
  MessagingUser,
  PendingMutation,
  ProtonWallet,
  RegisteredAssistant,
  StoreCatalog,
  StoreCatalogItem,
  StoreCatalogItemHash,
  StoreCatalogOffer,
  StoreCatalogOwnedEntry,
  StoreEntitlement,
  StoreEntitlementEnvelope,
  StoreEntitlementProof,
  StoreItemDetail,
  StoreItemKind,
  StoreItemSource,
  StorePurchase,
  StorePurchaseResult,
  StorePurchaseStatus,
  StoreTrainingTask
} from './types'
import { ADDRESSED_MENTIONS_CONTRACT } from './types'
import {
  type DesktopSessionBody,
  parseArtifactResponse,
  parseAssistantList,
  parseAssistantRegistrationResult,
  parseAssistantRetirement,
  parseAtumAssistantDefinitionSnapshot,
  parseCanonicalMessage,
  parseConversationPage,
  parseCreateConversation,
  parseDesktopError,
  parseDesktopSession,
  parseIdentityUserResponse,
  parseMessagePage,
  parseOptionalAssistantAvatarUrl,
  parseRegisteredAssistant,
  parseSendResponse,
  parseSyncPage,
  type SyncPage
} from './wire'

export interface MessagingTokenSource {
  current(): MessagingAccountSession | null
  refresh(rejected: MessagingAccountSession): Promise<MessagingAccountSession | null>
}

export interface MessagingFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface MessagingHttpClientOptions {
  requestTimeoutMs?: number
  maxResponseBytes?: number
  /** Main-owned Google protection state; never supplied by the renderer. */
  workspaceProtected?: () => boolean
  /** This app's version (`app.getVersion()`), sent so the Shell can gate Store sales by it. */
  desktopVersion?: string
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
// The mention drain is the one request that waits on a hosted model turn. Its
// route caps itself at 180s, so a client abort below that would cancel a reply
// that has already been billed.
const MENTION_DRAIN_TIMEOUT_MS = 200_000
// Covers the bounded 4.3 MB personal-pet envelope, below the hosting limit.
const DEFAULT_MAX_RESPONSE_BYTES = 4_300_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_RETRY_AFTER_MS = 5 * 60_000

class ResponseTooLargeError extends Error {
  constructor() {
    super('response_too_large')
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(minimum, Math.min(Math.trunc(value), maximum))
}

export { MessagingTransportError as MessagingHttpError } from './transport-error'

function assertMessageConversationScope(expectedConversationId: string, actualConversationId: string): void {
  if (actualConversationId !== expectedConversationId) {
    throw new Error('invalid_response:message.conversation_id_scope')
  }
}

function endpoint(baseUrl: string, route: string): string {
  return route.startsWith('/api/') ? `${baseUrl}${route}` : `${baseUrl}/api/desktop/v1${route}`
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_response:identity')
  }

  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid_response:${label}`)
  }

  return Number(value)
}

/** Ledger amounts can be decimal SQL numerics. They are only projected for display. */
function nonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function uuid(value: unknown, label: string): string {
  const result = stringValue(value, label)

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) {
    throw new Error(`invalid_response:${label}`)
  }

  return result
}

/**
 * RETIRED legacy wallet (pre-Matrix app): the read-only wallet projection. The
 * retired platform route may still send its checkout fields (checkout_enabled,
 * packages, orders); they are ignored, never projected.
 */
function parseProtonWallet(value: unknown): ProtonWallet {
  const row = object(value)

  if (typeof row.funded !== 'boolean') {
    throw new Error('invalid_response:protons.wallet.funded')
  }

  if (typeof row.spending_enabled !== 'boolean') {
    throw new Error('invalid_response:protons.wallet.spending_enabled')
  }

  return {
    balanceProtons: nonNegativeInteger(row.balance_protons, 'protons.wallet.balance_protons'),
    funded: row.funded,
    spendingEnabled: row.spending_enabled,
    availableProtons: nonNegativeFiniteNumber(row.available_protons, 'protons.wallet.available_protons'),
    heldProtons: nonNegativeFiniteNumber(row.held_protons, 'protons.wallet.held_protons'),
    trialProtons: nonNegativeFiniteNumber(row.trial_protons, 'protons.wallet.trial_protons'),
    aiProtonsPerUsd: nonNegativeFiniteNumber(row.ai_protons_per_usd, 'protons.wallet.ai_protons_per_usd')
  }
}

/* Atum Store wire parsing. Every field the desktop projects is validated and
 * labelled; a malformed field fails the whole read as invalid_response:<field>
 * and nothing is cached (plan 2026-09-10-atum-store.md, decisions 2, 7, 8). */

const STORE_ITEM_KINDS: readonly StoreItemKind[] = ['skill', 'pet', 'agent']
const STORE_SHA256 = /^[a-f0-9]{64}$/u
const STORE_OPTIONAL_IDENTIFIER = /^[a-z0-9][a-z0-9/_-]{0,127}$/u
const STORE_KEY_ID = /^[A-Za-z0-9_-]{1,32}$/u
const STORE_SIGNATURE = /^[A-Za-z0-9_-]+$/u
const STORE_LOCALE = /^[a-z]{2}$/u

function storeObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value as Record<string, unknown>
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return Number(value)
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label)

  if (parsed < 1) {
    throw new Error(`invalid_response:${label}`)
  }

  return parsed
}

function storeSha256(value: unknown, label: string): string {
  const parsed = stringValue(value, label)

  if (!STORE_SHA256.test(parsed)) {
    throw new Error(`invalid_response:${label}`)
  }

  return parsed
}

function storeItemKind(value: unknown, label: string): StoreItemKind {
  if (typeof value !== 'string' || !STORE_ITEM_KINDS.includes(value as StoreItemKind)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value as StoreItemKind
}

function storeEntitlementState(value: unknown, label: string): 'active' | 'revoked' {
  if (value !== 'active' && value !== 'revoked') {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function storeCopy(value: unknown, label: string): Record<string, string> {
  const row = storeObject(value, label)
  const result: Record<string, string> = {}

  for (const [locale, text] of Object.entries(row)) {
    if (!STORE_LOCALE.test(locale) || typeof text !== 'string' || text.length > 2000) {
      throw new Error(`invalid_response:${label}`)
    }

    result[locale] = text
  }

  return result
}

function storeItemDetail(value: unknown, label: string): StoreItemDetail {
  const row = storeObject(value, label)
  const needs = arrayValue(row.needs, `${label}.needs`)

  return {
    description: storeCopy(row.description, `${label}.description`),
    tryPrompt: storeCopy(row.try_prompt, `${label}.try_prompt`),
    needs: needs.map((need, index) => boundedString(need, `${label}.needs.${index}`, 64))
  }
}

const STORE_SOURCE_PARSERS: Record<string, (row: Record<string, unknown>, label: string) => StoreItemSource> = {
  'agent:cloud_agent': () => ({ type: 'cloud_agent' }),
  'skill:cloud_skill': () => ({ type: 'cloud_skill' }),
  'skill:hermes_optional': (row, label) => {
    const identifier = boundedString(row.identifier, `${label}.identifier`, 128)

    if (!STORE_OPTIONAL_IDENTIFIER.test(identifier)) {
      throw new Error(`invalid_response:${label}.identifier`)
    }

    return { type: 'hermes_optional', identifier }
  },
  'skill:catalog_bundle': (row, label) => ({ type: 'catalog_bundle', sha256: storeSha256(row.sha256, `${label}.sha256`) }),
  'pet:bundled': (row, label) => ({ type: 'bundled', slug: boundedString(row.slug, `${label}.slug`, 128) }),
  'pet:catalog_asset': (row, label) => ({ type: 'catalog_asset', sha256: storeSha256(row.sha256, `${label}.sha256`) })
}

function storeItemSource(kind: StoreItemKind, value: unknown, label: string): StoreItemSource | null {
  if (value === null) {
    if (kind === 'agent') {
      return null
    }

    throw new Error(`invalid_response:${label}`)
  }

  const row = storeObject(value, label)
  const type = stringValue(row.type, `${label}.type`)
  const parse = STORE_SOURCE_PARSERS[`${kind}:${type}`]

  if (!parse) {
    throw new Error(`invalid_response:${label}.type`)
  }

  return parse(row, label)
}

function storeCatalogOffer(value: unknown, label: string): StoreCatalogOffer {
  const row = storeObject(value, label)

  if (row.billing_interval !== undefined && !['one_time', 'month'].includes(String(row.billing_interval))) {
    throw new Error(`invalid_response:${label}.billing_interval`)
  }

  return {
    id: uuid(row.id, `${label}.id`),
    version: positiveInteger(row.version, `${label}.version`),
    priceProtons: nonNegativeInteger(row.price_protons, `${label}.price_protons`),
    ...(row.billing_interval === undefined ? {} : { billingInterval: row.billing_interval as 'one_time' | 'month' })
  }
}

function storeCatalogItemHash(value: unknown, label: string): StoreCatalogItemHash {
  const row = storeObject(value, label)

  return {
    sha256: storeSha256(row.sha256, `${label}.sha256`),
    hermesRelease: row.hermes_release === null ? null : boundedString(row.hermes_release, `${label}.hermes_release`, 128)
  }
}

function storeCatalogItem(value: unknown, label: string): StoreCatalogItem {
  const row = storeObject(value, label)
  const kind = storeItemKind(row.kind, `${label}.kind`)

  if (typeof row.featured !== 'boolean') {
    throw new Error(`invalid_response:${label}.featured`)
  }

  return {
    kind,
    id: boundedString(row.id, `${label}.id`, 128),
    title: storeCopy(row.title, `${label}.title`),
    summary: storeCopy(row.summary, `${label}.summary`),
    detail: storeItemDetail(row.detail, `${label}.detail`),
    glyph: boundedString(row.glyph, `${label}.glyph`, 16),
    accent: boundedString(row.accent, `${label}.accent`, 128),
    source: storeItemSource(kind, row.source, `${label}.source`),
    featured: row.featured,
    sortOrder: safeInteger(row.sort_order, `${label}.sort_order`),
    offer: row.offer === null ? null : storeCatalogOffer(row.offer, `${label}.offer`),
    hashes: arrayValue(row.hashes, `${label}.hashes`).map((entry, index) =>
      storeCatalogItemHash(entry, `${label}.hashes.${index}`)
    )
  }
}

/** Skill licenses name one registered employee; other store kinds stay account-scoped. */
function storeAssistantId(kind: unknown, value: unknown, label: string): string | null {
  if (kind === 'skill') { return uuid(value, label) }

  if (value !== null) { throw new Error(`invalid_response:${label}`) }

  return null
}

function storeEntitlement(value: unknown, label: string): StoreEntitlement {
  const row = storeObject(value, label)

  return {
    kind: storeItemKind(row.kind, `${label}.kind`),
    id: boundedString(row.id, `${label}.id`, 128),
    state: storeEntitlementState(row.state, `${label}.state`),
    assistantId: storeAssistantId(row.kind, row.assistant_id, `${label}.assistant_id`),
    assistantIdentityId: storeAssistantId(row.kind, row.assistant_identity_id, `${label}.assistant_identity_id`),
    grantedAt: stringValue(row.granted_at, `${label}.granted_at`)
  }
}

/**
 * Plan decision 11 (review: one unknown item must not fail the whole catalog):
 * an item whose `kind` or `source.type` this build cannot fulfil is HIDDEN,
 * not fatal — the refresh and the proof refresh riding with it must survive.
 * Malformed fields on a known kind/source still fail the read as before.
 */
function isUnknownCatalogItem(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const row = value as Record<string, unknown>
  const kind = row.kind

  // A missing or non-string kind is malformed, not unknown: the strict parser
  // below reports it with its labelled error.
  if (typeof kind !== 'string') {
    return false
  }

  if (!STORE_ITEM_KINDS.includes(kind as StoreItemKind)) {
    return true
  }

  const source = row.source

  if (source === null || source === undefined || typeof source !== 'object' || Array.isArray(source)) {
    return false
  }

  const type = (source as Record<string, unknown>).type

  return typeof type === 'string' && STORE_SOURCE_PARSERS[`${kind}:${type}`] === undefined
}

/** An entitlement naming an item kind this build does not know. Malformed
 *  fields on a KNOWN kind still fail the read, as they always did. */
function isUnknownEntitlementKind(value: unknown): boolean {
  const kind = (value as { kind?: unknown } | null)?.kind

  return typeof kind === 'string' && !STORE_ITEM_KINDS.includes(kind as StoreItemKind)
}

/** Exported so the store cache revalidates its own snapshot with the same rules. */
export function parseStoreCatalog(value: unknown): StoreCatalog {
  const row = storeObject(value, 'store.catalog')
  const items: StoreCatalogItem[] = []
  let skippedUnknownItems = 0

  arrayValue(row.items, 'store.catalog.items').forEach((item, index) => {
    if (isUnknownCatalogItem(item)) {
      skippedUnknownItems += 1

      return
    }

    items.push(storeCatalogItem(item, `store.catalog.items.${index}`))
  })

  const entitlements: StoreEntitlement[] = []

  arrayValue(row.entitlements, 'store.catalog.entitlements').forEach((entry, index) => {
    // Decision 11 again: an entitlement for a kind this build cannot fulfil is
    // HIDDEN, not fatal. Skipping it is fail-closed — the matching
    // `catalog_owned` entry carries the same unknown kind, so the gate never
    // matches it either — and it is what keeps an older client degrading
    // Preserve the recovery and user-visible behavior covered by this path.
    if (isUnknownEntitlementKind(entry)) {
      skippedUnknownItems += 1

      return
    }

    entitlements.push(storeEntitlement(entry, `store.catalog.entitlements.${index}`))
  })

  return {
    items,
    entitlements,
    availableProtons: nonNegativeFiniteNumber(row.available_protons, 'store.catalog.available_protons'),
    skippedUnknownItems
  }
}

function storePurchase(value: unknown, label: string): StorePurchase {
  const row = storeObject(value, label)
  const status = row.status

  if (status !== 'completed' && status !== 'refunded') {
    throw new Error(`invalid_response:${label}.status`)
  }

  return {
    id: uuid(row.id, `${label}.id`),
    offerId: uuid(row.offer_id, `${label}.offer_id`),
    offerVersion: positiveInteger(row.offer_version, `${label}.offer_version`),
    kind: storeItemKind(row.kind, `${label}.kind`),
    assistantId: storeAssistantId(row.kind, row.assistant_id, `${label}.assistant_id`),
    itemId: boundedString(row.item_id, `${label}.item_id`, 128),
    amountProtons: nonNegativeInteger(row.amount_protons, `${label}.amount_protons`),
    status,
    createdAt: stringValue(row.created_at, `${label}.created_at`),
    refundedAt: row.refunded_at === null ? null : stringValue(row.refunded_at, `${label}.refunded_at`)
  }
}

function parseStorePurchaseResult(value: unknown): StorePurchaseResult {
  const row = storeObject(value, 'store.purchase')

  switch (row.outcome) {
    case 'completed': {
      const wallet =
        row.wallet === null || row.wallet === undefined ? null : storeObject(row.wallet, 'store.purchase.wallet')

      return {
        outcome: 'completed',
        purchase: storePurchase(row.purchase, 'store.purchase.purchase'),
        entitlement: storeEntitlement(row.entitlement, 'store.purchase.entitlement'),
        wallet: wallet
          ? { availableProtons: nonNegativeFiniteNumber(wallet.available_protons, 'store.purchase.wallet.available_protons') }
          : null
      }
    }

    case 'already_owned':
      return {
        outcome: 'already_owned',
        purchase: null,
        entitlement: storeEntitlement(row.entitlement, 'store.purchase.entitlement')
      }

    case 'offer_changed':
      return { outcome: 'offer_changed', offer: storeCatalogOffer(row.offer, 'store.purchase.offer') }

    case 'refunded':
      return {
        outcome: 'refunded',
        purchase: storePurchase(row.purchase, 'store.purchase.purchase'),
        entitlement:
          row.entitlement === null ? null : storeEntitlement(row.entitlement, 'store.purchase.entitlement')
      }

    default:
      throw new Error('invalid_response:store.purchase.outcome')
  }
}

function parseStorePurchaseStatus(value: unknown): StorePurchaseStatus {
  const row = storeObject(value, 'store.purchase_status')

  return {
    purchase: storePurchase(row.purchase, 'store.purchase_status.purchase'),
    entitlement:
      row.entitlement === null ? null : storeEntitlement(row.entitlement, 'store.purchase_status.entitlement')
  }
}

/**
 * A signed `catalog_owned` entry. The kind is validated as a bounded string
 * but never narrowed to the known kinds: an entry this build does not
 * recognise still names paid content, and the gateway needs it (decision 11).
 * The bounds mirror the Hermes verifier's `_validate_catalog_owned`.
 */
function storeCatalogOwnedEntry(value: unknown, label: string): StoreCatalogOwnedEntry {
  const row = storeObject(value, label)

  if (row.delivery !== 'cloud' && row.delivery !== 'local') { throw new Error(`invalid_response:${label}.delivery`) }

  return {
    delivery: row.delivery,
    kind: boundedString(row.kind, `${label}.kind`, 32),
    id: boundedString(row.id, `${label}.id`, 256),
    identifier: boundedString(row.identifier, `${label}.identifier`, 256),
    hashes: arrayValue(row.hashes, `${label}.hashes`).map((entry, index) =>
      storeSha256(entry, `${label}.hashes.${index}`)
    )
  }
}

/**
 * The signed envelope of per-agent training (version 3: `catalog_owned` travels
 * inside the signed payload, so "is this item paid?" never comes from an
 * unsigned file — review B5). The parsed fields are validated, but the
 * persisted proof is the raw response text (`StoreEntitlementProof.raw`),
 * never a re-serialisation of this object.
 */
export function parseStoreEntitlementEnvelope(value: unknown): StoreEntitlementEnvelope {
  const row = storeObject(value, 'store.entitlements')
  const keyId = stringValue(row.key_id, 'store.entitlements.key_id')
  const signature = stringValue(row.signature, 'store.entitlements.signature')

  if (row.v !== 3) {
    throw new Error('invalid_response:store.entitlements.v')
  }

  if (!STORE_KEY_ID.test(keyId)) {
    throw new Error('invalid_response:store.entitlements.key_id')
  }

  if (!STORE_SIGNATURE.test(signature)) {
    throw new Error('invalid_response:store.entitlements.signature')
  }

  return {
    v: 3,
    accountId: uuid(row.account_id, 'store.entitlements.account_id'),
    issuedAt: positiveInteger(row.issued_at, 'store.entitlements.issued_at'),
    expiresAt: positiveInteger(row.expires_at, 'store.entitlements.expires_at'),
    keyId,
    // Same rule inside the signed envelope: one entitlement of a kind this
    // build cannot fulfil must not take the whole proof — and with it every
    // enforcement decision — down with it.
    entitlements: arrayValue(row.entitlements, 'store.entitlements.entitlements')
      .filter(entry => !isUnknownEntitlementKind(entry))
      .map((entry, index) => {
        const label = `store.entitlements.entitlements.${index}`
        const item = storeObject(entry, label)

        return {
          assistantId: storeAssistantId(item.kind, item.assistant_id, `${label}.assistant_id`),
          assistantIdentityId: storeAssistantId(item.kind, item.assistant_identity_id, `${label}.assistant_identity_id`),
          kind: storeItemKind(item.kind, `${label}.kind`),
          id: boundedString(item.id, `${label}.id`, 128),
          state: storeEntitlementState(item.state, `${label}.state`)
        }
      }),
    catalogOwned: arrayValue(row.catalog_owned, 'store.entitlements.catalog_owned').map((entry, index) =>
      storeCatalogOwnedEntry(entry, `store.entitlements.catalog_owned.${index}`)
    ),
    signature
  }
}

function parsePrivateAdvisoryRequest(value: unknown): PrivateAdvisoryJobRequest {
  const request = object(value)
  const target = object(request.target)

  if (target.type !== 'assistant' || request.subject !== null) {
    throw new Error('invalid_response:advisory.target')
  }

  const targetId = stringValue(target.id, 'advisory.target.id')

  return {
    job_id: stringValue(request.job_id, 'advisory.request.job_id'),
    turn_id: stringValue(request.turn_id, 'advisory.turn_id'),
    conversation_id: stringValue(request.conversation_id, 'advisory.conversation_id'),
    source_message_id: stringValue(request.source_message_id, 'advisory.source_message_id'),
    round: object(request.round) as { id: string; slot: number },
    audience_revision: Number(request.audience_revision),
    target: { type: 'assistant', id: targetId },
    subject: null,
    context: parsePrivateAdvisoryContext(request.context, targetId)
  }
}

function parsePrivateAdvisoryContext(value: unknown, expectedAssistantId?: string): PrivateAdvisoryContext {
  const row = object(value)
  const advisor = object(row.advisor)
  const watermark = object(row.watermark)

  const messages = Array.isArray(row.messages)
    ? row.messages.map(message => {
        const entry = object(message)
        const speaker = object(entry.speaker)

        if (
          (speaker.kind !== 'owner' && speaker.kind !== 'specialist' && speaker.kind !== 'assistant') ||
          typeof entry.version !== 'number' ||
          typeof entry.sequence !== 'number'
        ) {
          throw new Error('invalid_response:advisory.context.message')
        }

        return {
          id: stringValue(entry.id, 'advisory.message.id'),
          version: entry.version,
          sequence: entry.sequence,
          speaker: {
            kind: speaker.kind as 'owner' | 'specialist' | 'assistant',
            id: stringValue(speaker.id, 'advisory.message.speaker')
          },
          text: stringValue(entry.text, 'advisory.message.text')
        }
      })
    : (() => {
        throw new Error('invalid_response:advisory.context.messages')
      })()

  if (
    row.mode !== 'private_advisory' ||
    (advisor.kind !== 'specialist' && advisor.kind !== 'assistant') ||
    (expectedAssistantId !== undefined && (advisor.kind !== 'assistant' || advisor.id !== expectedAssistantId)) ||
    typeof row.audience_revision !== 'number' ||
    typeof row.context_revision !== 'number' ||
    !Array.isArray(row.invalidations)
  ) {
    throw new Error('invalid_response:advisory.context')
  }

  return {
    mode: 'private_advisory',
    conversation_id: stringValue(row.conversation_id, 'advisory.conversation_id'),
    audience_revision: row.audience_revision,
    advisor: { kind: advisor.kind, id: stringValue(advisor.id, 'advisory.advisor.id') },
    context_revision: row.context_revision,
    invalidations: row.invalidations.map(invalidation => {
      const item = object(invalidation)

      if ((item.kind !== 'recalled' && item.kind !== 'superseded') || typeof item.version !== 'number') {
        throw new Error('invalid_response:advisory.invalidation')
      }

      return {
        message_id: stringValue(item.message_id, 'advisory.invalidation.id'),
        version: item.version,
        kind: item.kind
      }
    }),
    messages,
    watermark: {
      sequence: Number(watermark.sequence),
      message_id: stringValue(watermark.message_id, 'advisory.watermark.id')
    }
  }
}

export class AtumMessagingHttpClient implements DirectMessagingTransport {
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly desktopVersion: string | undefined
  private readonly activeRequests = new Set<AbortController>()
  private generation = 0

  constructor(
    private readonly tokens: MessagingTokenSource,
    private readonly fetchImpl: MessagingFetch = fetch,
    private readonly options: MessagingHttpClientOptions = {}
  ) {
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      10,
      MAX_REQUEST_TIMEOUT_MS
    )
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES
    )
    this.desktopVersion = desktopVersionHeaderValue(options.desktopVersion)
  }

  abortAll(): void {
    this.generation += 1

    for (const controller of this.activeRequests) {
      controller.abort()
    }

    this.activeRequests.clear()
  }

  session(): Promise<DesktopSessionBody> {
    return this.request('/session', {}, parseDesktopSession)
  }

  socialLookup(query: string) {
    return this.request(
      `/social/lookup?q=${encodeURIComponent(query)}`,
      { headers: { 'x-atum-social-version': String(ATUM_SOCIAL_VERSION) } },
      parseSocialLookupResponse
    )
  }

  socialMutate(input: {
    accountEpoch: string
    action: SocialMutationAction
    clientOperationId: string
    targetProfileId: string
  }) {
    return this.request(
      '/social/mutations',
      {
        method: 'POST',
        headers: {
          'idempotency-key': input.clientOperationId,
          'x-atum-social-version': String(ATUM_SOCIAL_VERSION)
        },
        body: JSON.stringify({
          account_epoch: input.accountEpoch,
          action: input.action,
          client_operation_id: input.clientOperationId,
          target_profile_id: input.targetProfileId
        })
      },
      parseSocialMutationResponse
    )
  }

  socialSync(accountEpoch: string, cursor: string | null, limit = 100) {
    const query = new URLSearchParams({
      account_epoch: accountEpoch,
      limit: String(boundedInteger(limit, 100, 1, 500))
    })

    if (cursor) {
      query.set('cursor', cursor)
    }

    return this.request(
      `/social/sync?${query}`,
      { headers: { 'x-atum-social-version': String(ATUM_SOCIAL_VERSION) } },
      parseSocialSyncResponse
    )
  }

  groupDetail(conversationId: string, cursor?: string | null) {
    const query = new URLSearchParams({ limit: '100' })

    if (cursor) {
      query.set('cursor', cursor)
    }

    return this.request(`/groups/${encodeURIComponent(conversationId)}?${query}`, {}, value =>
      parseGroupDetail(value, conversationId)
    )
  }

  advisoryClaim(clientOperationId: string): Promise<{ job: ClaimedPrivateAdvisoryJob | null; replayed: boolean }> {
    return this.request(
      '/advisory-conversations/claim',
      {
        method: 'POST',
        headers: { 'idempotency-key': clientOperationId },
        body: JSON.stringify({ client_operation_id: clientOperationId })
      },
      value => {
        const row = object(value)

        if (typeof row.replayed !== 'boolean') {
          throw new Error('invalid_response:advisory.replayed')
        }

        if (row.job === null) {
          return { job: null, replayed: row.replayed }
        }

        const job = object(row.job)
        const request = object(job.request)
        const target = object(request.target)

        if (target.type !== 'assistant') {
          throw new Error('invalid_response:advisory.target')
        }

        return {
          replayed: row.replayed,
          job: {
            job_id: stringValue(job.job_id, 'advisory.job_id'),
            lease_token: stringValue(job.lease_token, 'advisory.lease_token'),
            request: parsePrivateAdvisoryRequest(request)
          }
        }
      }
    )
  }

  advisoryPreflight(conversationId: string, jobId: string, leaseToken: string): Promise<PrivateAdvisoryJobRequest> {
    return this.request(
      `/advisory-conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/preflight`,
      { method: 'POST', body: JSON.stringify({ lease_token: leaseToken }) },
      value => parsePrivateAdvisoryRequest(object(value).request)
    )
  }

  advisoryHeartbeat(
    conversationId: string,
    jobId: string,
    leaseToken: string
  ): Promise<{ request: PrivateAdvisoryJobRequest; nextHeartbeatSeconds: number }> {
    return this.request(
      `/advisory-conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      { method: 'POST', body: JSON.stringify({ lease_token: leaseToken }) },
      value => {
        const row = object(value)

        if (row.state !== 'running' || typeof row.next_heartbeat_seconds !== 'number') {
          throw new Error('invalid_response:advisory.heartbeat')
        }

        return {
          request: parsePrivateAdvisoryRequest(row.request),
          nextHeartbeatSeconds: Math.max(5, Math.min(120, Math.trunc(row.next_heartbeat_seconds)))
        }
      }
    )
  }

  advisoryComplete(conversationId: string, jobId: string, leaseToken: string, replyText: string): Promise<void> {
    return this.request(
      `/advisory-conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/complete`,
      { method: 'POST', body: JSON.stringify({ lease_token: leaseToken, reply_text: replyText }) },
      value => {
        const row = object(value)

        if (
          row.state !== 'completed' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.reply_id)) ||
          typeof row.deduplicated !== 'boolean'
        ) {
          throw new Error('invalid_response:advisory.complete')
        }
      }
    )
  }

  advisoryFail(
    conversationId: string,
    jobId: string,
    leaseToken: string,
    errorCode: string,
    retryable: boolean
  ): Promise<void> {
    return this.request(
      `/advisory-conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/fail`,
      { method: 'POST', body: JSON.stringify({ lease_token: leaseToken, error_code: errorCode, retryable }) },
      () => undefined
    )
  }

  advisorySearch(input: AdvisorySearchRequest): Promise<AdvisorySearchResult> {
    return this.request(
      '/advisory-conversations/search',
      {
        method: 'POST',
        body: JSON.stringify({
          target_assistant_id: input.target_assistant_id,
          conversation_id: input.conversation_id,
          query: input.query,
          reference: input.reference,
          limit: input.limit
        })
      },
      parseAdvisorySearchResult
    )
  }

  advisoryRefresh(input: {
    conversationId: string
    subjectId: string
    installationId: string
    linkEpoch: number
  }): Promise<{ context: PrivateAdvisoryContext }> {
    return this.request(
      '/api/apps/atum/advisory-context',
      {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: input.conversationId,
          subject_id: input.subjectId,
          installation_id: input.installationId,
          link_epoch: input.linkEpoch
        })
      },
      value => ({ context: parsePrivateAdvisoryContext(object(value).context) })
    )
  }

  groupOperate(input: GroupOperationInput): Promise<{ conversationId: string; replayed: boolean }> {
    let route: string
    let body: Record<string, unknown>

    if (input.action === 'create') {
      route = input.contextMode === 'private_advisory' ? '/advisory-conversations' : '/groups'
      body =
        input.contextMode === 'private_advisory'
          ? { title: input.title, advisors: input.advisors }
          : input.contextMode === 'shared_group'
            ? {
                context_mode: 'shared_group',
                title: input.title,
                member_user_ids: input.memberUserIds,
                ...('specialistIds' in input && input.specialistIds !== undefined
                  ? { specialist_ids: input.specialistIds }
                  : {}),
                ...('assistantIds' in input && input.assistantIds !== undefined
                  ? { assistant_ids: input.assistantIds }
                  : {})
              }
            : {
                title: input.title,
                member_user_ids: input.memberUserIds,
                ...('specialistIds' in input && input.specialistIds !== undefined
                  ? { specialist_ids: input.specialistIds }
                  : {})
              }
    } else if (input.action === 'stop_advisory' || input.action === 'continue_advisory') {
      route = `/advisory-conversations/${encodeURIComponent(input.conversationId)}/${input.action === 'stop_advisory' ? 'stop' : 'continue'}`
      body = { round_id: input.roundId, audience_revision: input.audienceRevision }
    } else if (input.action === 'add_advisor' || input.action === 'remove_advisor') {
      route = `/advisory-conversations/${encodeURIComponent(input.conversationId)}/advisors`
      body = {
        action: input.action === 'add_advisor' ? 'add' : 'remove',
        target: input.target,
        audience_revision: input.audienceRevision
      }
    } else {
      route = `/groups/${encodeURIComponent(input.conversationId)}/${input.action === 'report' ? 'reports' : 'operations'}`

      if (input.action === 'report') {
        body = {
          reason: input.reason,
          note: input.note ?? null,
          ...('memberUserId' in input
            ? { member_user_id: input.memberUserId }
            : 'memberSpecialist' in input
              ? { reported_specialist: input.memberSpecialist }
              : 'memberAssistant' in input
                ? { reported_assistant_id: input.memberAssistant }
                : { message_id: input.messageId })
        }
      } else {
        body = {
          action: input.action,
          ...('targetUserId' in input ? { target_user_id: input.targetUserId } : {}),
          ...('specialist' in input ? { specialist: input.specialist } : {}),
          ...('assistantId' in input ? { assistant_id: input.assistantId } : {}),
          ...('title' in input ? { title: input.title } : {})
        }
      }
    }

    return this.request(
      route,
      {
        method: 'POST',
        headers: {
          'idempotency-key': input.clientOperationId,
          ...(input.action === 'create' && input.reuseExisting ? { 'x-atum-group-create': '1' } : {})
        },
        body: JSON.stringify({ ...body, client_operation_id: input.clientOperationId })
      },
      value => {
        const row = object(value)
        const conversationId = stringValue(row.conversation_id, 'group.conversation_id')

        if (input.action !== 'create' && conversationId !== input.conversationId) {
          throw new Error('invalid_response:group.conversation_scope')
        }

        if (typeof row.replayed !== 'boolean') {
          throw new Error('invalid_response:group.replayed')
        }

        return { conversationId, replayed: row.replayed }
      }
    )
  }

  async conversations() {
    const conversations: ReturnType<typeof parseConversationPage>['conversations'] = []
    let cursor: string | null = null
    const seen = new Set<string>()

    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100' })

      if (cursor) {
        query.set('cursor', cursor)
      }

      const result = await this.request(`/conversations?${query}`, {}, parseConversationPage)
      conversations.push(...result.conversations)

      if (!result.hasMore) {
        return { conversations }
      }

      if (!result.nextCursor || seen.has(result.nextCursor)) {
        throw new Error('invalid_response:conversations.cursor_cycle')
      }

      cursor = result.nextCursor
      seen.add(cursor)
    }

    throw new Error('invalid_response:conversations.page_limit')
  }

  ensureSpecialistConversation(specialist: string, clientOperationId: string) {
    return this.request(
      '/conversations',
      {
        method: 'POST',
        headers: { 'idempotency-key': clientOperationId },
        body: JSON.stringify({ specialist, client_operation_id: clientOperationId })
      },
      value => {
        const result = parseCreateConversation(value)

        if (result.specialist !== specialist) {
          throw new Error('invalid_response:create_conversation.conversation.specialist_scope')
        }

        return result
      }
    )
  }

  ensureContactConversation(input: CreateDirectConversationRequest): Promise<{ conversationId: string }> {
    if ('specialist' in input || 'specialist_scope' in input) {
      throw new Error('invalid_request:create_direct.specialist_scope')
    }

    return this.request(
      '/conversations',
      {
        method: 'POST',
        headers: { 'idempotency-key': input.clientOperationId },
        body: JSON.stringify({
          contact_user_id: input.contactUserId,
          client_operation_id: input.clientOperationId
        })
      },
      value => {
        const conversation = object(object(value).conversation)

        return { conversationId: stringValue(conversation.id, 'create_conversation.conversation.id') }
      }
    )
  }

  // Identity routes live under the desktop bearer plane (`atum.desktop-identity/1`).
  // The cookie-session `/api/identity/handle/**` routes cannot authenticate a
  // bearer client, so they are not called from here.
  handleAvailability(handle: string): Promise<IdentityHandleAvailability> {
    return this.request(`/identity/handle/availability?handle=${encodeURIComponent(handle)}`, {}, value => {
      const body = object(value)

      return {
        available: body.available === true,
        reason: typeof body.reason === 'string' ? body.reason : null,
        retryAfterSeconds: typeof body.retry_after_seconds === 'number' ? body.retry_after_seconds : null
      }
    })
  }

  renameHandle(handle: string): Promise<MessagingUser> {
    return this.request(
      '/identity/handle',
      { method: 'POST', body: JSON.stringify({ handle }) },
      parseIdentityUserResponse
    )
  }

  updateProfile(input: IdentityProfileUpdate): Promise<MessagingUser> {
    return this.request(
      '/identity/profile',
      { method: 'PATCH', body: JSON.stringify({ display_name: input.displayName }) },
      parseIdentityUserResponse
    )
  }

  /**
   * Tell the plane what this device holds, keyed by identity. The plane
   * answers with the row that now stands and an outcome the caller must
   * honour: `adopt` means the default assistant already has an identity here
   * and this device must take it; `stale` means a newer revision is stored.
   */
  registerAssistant(input: AssistantRegistration): Promise<AssistantRegistrationResult> {
    return this.request(
      '/assistants',
      {
        method: 'POST',
        body: JSON.stringify({
          identity_id: input.identityId,
          display_name: input.displayName,
          avatar: input.avatar,
          is_default: input.isDefault,
          lifecycle_revision: input.lifecycleRevision
        })
      },
      parseAssistantRegistrationResult
    )
  }

  retireAssistant(input: {
    identityId: string
    lifecycleRevision: number
    expectedIdentityRevision?: number
  }): Promise<{ outcome: string; lifecycleRevision: number }> {
    return this.request(
      '/assistants/retire',
      {
        method: 'POST',
        body: JSON.stringify({
          identity_id: input.identityId,
          lifecycle_revision: input.lifecycleRevision,
          ...(input.expectedIdentityRevision === undefined
            ? {}
            : { expected_identity_revision: input.expectedIdentityRevision })
        })
      },
      parseAssistantRetirement
    )
  }

  listAssistants(): Promise<RegisteredAssistant[]> {
    return this.request('/assistants', {}, parseAssistantList)
  }

  getAssistantDefinition(assistantId: string): Promise<AtumAssistantDefinitionSnapshot> {
    return this.request(
      `/assistants/${encodeURIComponent(assistantId)}/definition`,
      {},
      parseAtumAssistantDefinitionSnapshot
    )
  }

  putAssistantDefinition(
    assistantId: string,
    input: AtumAssistantDefinitionWrite
  ): Promise<AtumAssistantDefinitionSnapshot> {
    return this.request(
      `/assistants/${encodeURIComponent(assistantId)}/definition`,
      { method: 'PUT', body: JSON.stringify(assistantDefinitionWriteWire(input)), localAssistantContent: true },
      parseAtumAssistantDefinitionSnapshot
    )
  }

  protonRewards(): Promise<ProtonRewards> {
    return this.request('/protons/rewards', {}, parseProtonRewards)
  }

  getAssistantSkill(assistantId: string, sha256: string) {
    return this.request(`/assistants/${encodeURIComponent(assistantId)}/skills/${encodeURIComponent(sha256)}`, {}, value => {
      const bundle = parseSkillBundle(value)

      if (bundle.sha256 !== sha256) {throw new Error('invalid_skill_bundle')}

      return bundle
    })
  }

  putAssistantSkill(assistantId: string, bundle: AtumSkillBundle) {
    return this.request(`/assistants/${encodeURIComponent(assistantId)}/skills/${encodeURIComponent(bundle.sha256)}`,
      { method: 'PUT', body: JSON.stringify(bundle), localAssistantContent: true }, value => {
        const row = object(value)

        if (row.sha256 !== bundle.sha256 || row.status !== 'available') {throw new Error('invalid_skill_bundle')}
      })
  }

  getAssistantMemory(assistantId: string) {
    return this.request(`/assistants/${encodeURIComponent(assistantId)}/memory`, {}, value => {
      const memory = parseCloudMemory(value)

      if (memory.assistantId !== assistantId) {throw new Error('invalid_cloud_memory')}

      return memory
    })
  }
  getAccountPreferences() {
    return this.request('/account/preferences', {}, parseCloudPreferences)
  }
  listAccountPets() { return this.request('/account/pets', {}, parsePetList) }
  putAccountPet(id: string, input: AtumPetWrite) {
    return this.request(`/account/pets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input), localAssistantContent: true }, parsePersonalPet)
  }
  getAccountPetContent(sha256: string) {
    return this.request(`/account/pets/content/${encodeURIComponent(sha256)}`, {}, value => {
      const bundle = parsePetBundle(value)

      if (bundle.sha256 !== sha256) { throw new Error('invalid_pet_content') }

      return bundle
    })
  }
  putAccountPetContent(bundle: AtumSkillBundle) {
    return this.request(`/account/pets/content/${encodeURIComponent(bundle.sha256)}`, { method: 'PUT', body: JSON.stringify(bundle), localAssistantContent: true }, value => {
      const row = object(value)

      if (row.sha256 !== bundle.sha256 || row.status !== 'available') { throw new Error('invalid_pet_content') }
    })
  }
  putAccountPreferences(input: { expected_revision: number; snapshot: AtumAccountPreferences }) {
    return this.request('/account/preferences', { method: 'PUT', body: JSON.stringify(input) }, parseCloudPreferences)
  }

  putAssistantMemory(assistantId: string, input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot }) {
    return this.request(`/assistants/${encodeURIComponent(assistantId)}/memory`, { method: 'PUT', body: JSON.stringify(input), localAssistantContent: true }, value => {
      const memory = parseCloudMemory(value)

      if (memory.assistantId !== assistantId) {throw new Error('invalid_cloud_memory')}

      return memory
    })
  }

  claimProtonConnectionReward(kind: ProtonRewardKind, accessToken: string): Promise<ProtonRewardClaim> {
    return this.request('/protons/rewards/connection', {
      method: 'POST', body: JSON.stringify({ service: kind, access_token: accessToken })
    }, parseProtonRewardClaim)
  }

  protonWallet(): Promise<ProtonWallet> {
    return this.request('/protons', {}, parseProtonWallet)
  }

  catalog(): Promise<StoreCatalog> {
    return this.request('/store/catalog', {}, parseStoreCatalog)
  }

  purchase(offerId: string, offerVersion: number, idempotencyKey: string, assistantId: string | null = null): Promise<StorePurchaseResult> {
    // The Idempotency-Key header is per-request (never global) and must equal
    // the body key; the platform rejects a mismatch as invalid_request.
    return this.request(
      '/protons/purchases',
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ offer_id: offerId, offer_version: offerVersion, idempotency_key: idempotencyKey, assistant_id: assistantId })
      },
      parseStorePurchaseResult
    )
  }

  agentHires(): Promise<AtumAgentHire[]> {
    return this.request('/agents/hiring', {}, parseAgentHires)
  }

  hireAgent(assistantId: string, offerId: string, offerVersion: number, idempotencyKey: string, consent: true): Promise<AtumHireResult> {
    return this.request('/agents/hiring', { method: 'POST', headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ assistant_id: assistantId, offer_id: offerId, offer_version: offerVersion,
        idempotency_key: idempotencyKey, accept_automatic_renewal: consent }) }, value => {
      const result = parseHireResult(value)
      if (result.subscription ? result.subscription.assistant_id !== assistantId || result.subscription.offer_id !== offerId
        : result.offer?.id !== offerId) { throw new Error('invalid_response:hiring_binding') }
      return result
    })
  }

  cancelAgentHire(hireId: string): Promise<AtumAgentHire> {
    return this.request('/agents/hiring', { method: 'DELETE', body: JSON.stringify({ hire_id: hireId }) },
      value => {
        const hire = parseAgentHire(object(value).subscription)
        if (hire.id !== hireId) { throw new Error('invalid_response:hiring_binding') }
        return hire
      })
  }

  startAgentTask(assistantId: string, conversationId: string, skillId: string | null): Promise<AtumExecutionTask | null> {
    return this.request('/agents/tasks', { method: 'POST',
      body: JSON.stringify({ assistant_id: assistantId, conversation_id: conversationId, skill_id: skillId }) }, value => {
      const row = object(value)
      if (row.task === null) { return null }
      const task = parseExecutionTask(row.task)
      if (task.assistant_id !== assistantId || task.conversation_id !== conversationId || task.skill_id !== skillId) {
        throw new Error('invalid_response:execution_task_binding')
      }
      return task
    })
  }

  startTrainingTask(assistantId: string, conversationId: string, skillId: string): Promise<StoreTrainingTask> {
    return this.request('/skills/tasks', {
      method: 'POST',
      body: JSON.stringify({ assistant_id: assistantId, conversation_id: conversationId, skill_id: skillId })
    }, value => {
      const row = object(value)

      const task = {
        task_id: uuid(row.task_id, 'training.task_id'),
        assistant_id: uuid(row.assistant_id, 'training.assistant_id'),
        assistant_identity_id: uuid(row.assistant_identity_id, 'training.assistant_identity_id'),
        conversation_id: boundedString(row.conversation_id, 'training.conversation_id', 256),
        skill_id: boundedString(row.skill_id, 'training.skill_id', 128)
      }

      if (task.assistant_id !== assistantId || task.conversation_id !== conversationId || task.skill_id !== skillId) {
        throw new Error('invalid_response:training.task_binding')
      }

      return task
    })
  }

  purchaseStatus(purchaseId: string): Promise<StorePurchaseStatus> {
    return this.request(`/protons/purchases/${encodeURIComponent(purchaseId)}`, {}, parseStorePurchaseStatus)
  }

  async entitlements(): Promise<StoreEntitlementProof> {
    // The raw response text rides beside the parsed envelope: main persists
    // those exact bytes as the gateway's offline proof (decision 8).
    const { value, raw } = await this.requestRaw('/protons/entitlements', {}, parseStoreEntitlementEnvelope)

    return { envelope: value, raw }
  }

  createAvatarUpload(input: { contentType: string }): Promise<AvatarUploadReservation> {
    return this.request(
      '/identity/avatar/uploads',
      { method: 'POST', body: JSON.stringify({ content_type: input.contentType }) },
      value => {
        const body = object(value)
        const headers = body.upload_headers

        return {
          uploadId: stringValue(body.upload_id, 'avatar.upload_id'),
          uploadUrl: stringValue(body.upload_url, 'avatar.upload_url'),
          uploadHeaders:
            headers && typeof headers === 'object' && !Array.isArray(headers)
              ? Object.fromEntries(
                  Object.entries(headers as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string'
                  )
                )
              : {},
          expiresAt: stringValue(body.expires_at, 'avatar.expires_at')
        }
      }
    )
  }

  completeAvatarUpload(uploadId: string): Promise<MessagingUser> {
    return this.request(
      `/identity/avatar/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST' },
      parseIdentityUserResponse
    )
  }

  clearAvatar(): Promise<MessagingUser> {
    return this.request('/identity/avatar', { method: 'DELETE' }, parseIdentityUserResponse)
  }

  createAssistantAvatarUpload(assistantId: string, input: { contentType: string }): Promise<AvatarUploadReservation> {
    return this.request(
      `/assistants/${encodeURIComponent(assistantId)}/avatar/uploads`,
      { method: 'POST', body: JSON.stringify({ content_type: input.contentType }) },
      value => {
        const body = object(value)
        const headers = body.upload_headers

        return {
          uploadId: stringValue(body.upload_id, 'assistant_avatar.upload_id'),
          uploadUrl: stringValue(body.upload_url, 'assistant_avatar.upload_url'),
          uploadHeaders:
            headers && typeof headers === 'object' && !Array.isArray(headers)
              ? Object.fromEntries(
                  Object.entries(headers as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string'
                  )
                )
              : {},
          expiresAt: stringValue(body.expires_at, 'assistant_avatar.expires_at')
        }
      }
    )
  }

  completeAssistantAvatarUpload(assistantId: string, uploadId: string): Promise<RegisteredAssistant> {
    return this.request(
      `/assistants/${encodeURIComponent(assistantId)}/avatar/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', body: '{}' },
      value => parseRegisteredAssistant(object(value).assistant, 'assistant_avatar.assistant')
    )
  }

  clearAssistantAvatar(assistantId: string): Promise<RegisteredAssistant> {
    return this.request(`/assistants/${encodeURIComponent(assistantId)}/avatar`, { method: 'DELETE' }, value =>
      parseRegisteredAssistant(object(value).assistant, 'assistant_avatar.assistant')
    )
  }

  linkedApps(): Promise<LinkedIdentityApp[]> {
    return this.request('/api/identity/apps', {}, value => {
      const rows = Array.isArray(value) ? value : object(value).apps

      if (!Array.isArray(rows)) {
        throw new Error('invalid_response:identity.apps')
      }

      return rows.map(raw => {
        const app = object(raw)
        const canonical = Object.prototype.hasOwnProperty.call(app, 'app_id')
        const appId = stringValue(canonical ? app.app_id : (app.app ?? app.id), 'identity.apps.app')
        const state = app.state

        if (state !== 'never_linked' && state !== 'linked' && state !== 'unlinked') {
          throw new Error('invalid_response:identity.apps.state')
        }

        return {
          app: appId,
          displayName: stringValue(
            canonical ? app.display_name : (app.display_name ?? app.name ?? appId),
            'identity.apps.display_name'
          ),
          state,
          connectedAt: typeof app.connected_at === 'string' ? app.connected_at : null,
          lastActiveAt: typeof app.last_active_at === 'string' ? app.last_active_at : null
        }
      })
    })
  }

  disconnectApp(app: string): Promise<void> {
    return this.request(`/api/identity/apps/${encodeURIComponent(app)}/disconnect`, { method: 'POST' }, () => undefined)
  }

  messages(conversationId: string, cursor: string | null = null, limit = 100) {
    const query = new URLSearchParams({ limit: String(boundedInteger(limit, 100, 1, 500)) })

    if (cursor) {
      query.set('cursor', cursor)
    }

    return this.request(`/conversations/${encodeURIComponent(conversationId)}/messages?${query}`, {}, value => {
      const page = parseMessagePage(value)

      for (const message of page.messages) {
        assertMessageConversationScope(conversationId, message.conversationId)
      }

      return page
    })
  }

  mentionTargets(conversationId: string): Promise<MentionTargetsResponse> {
    return this.request(`/conversations/${encodeURIComponent(conversationId)}/mention-targets`, {}, value => {
      const body = object(value)

      if (body.contract !== ADDRESSED_MENTIONS_CONTRACT || !Number.isInteger(body.mention_cardinality)) {
        throw new Error('invalid_response:mention_targets')
      }

      const rows = Array.isArray(body.targets) ? body.targets : null

      if (!rows || Number(body.mention_cardinality) < 1 || Number(body.mention_cardinality) > 8) {
        throw new Error('invalid_response:mention_targets')
      }

      return {
        contract: ADDRESSED_MENTIONS_CONTRACT,
        mentionCardinality: Number(body.mention_cardinality),
        targets: rows.map((value, index) => {
          const row = object(value)
          const target = object(row.target)
          const type = target.type

          if (
            (type !== 'assistant' && type !== 'specialist') ||
            !Number.isSafeInteger(row.revision) ||
            Number(row.revision) < 1
          ) {
            throw new Error(`invalid_response:mention_targets.targets.${index}`)
          }

          return {
            target: { type, id: stringValue(target.id, `mention_targets.targets.${index}.target.id`) },
            revision: Number(row.revision),
            displayName: stringValue(row.display_name, `mention_targets.targets.${index}.display_name`),
            ...(row.avatar_url === undefined
              ? {}
              : {
                  avatarUrl: parseOptionalAssistantAvatarUrl(
                    row.avatar_url,
                    `mention_targets.targets.${index}.avatar_url`
                  )
                }),
            avatar: typeof row.avatar === 'string' ? row.avatar : '',
            ...(row.availability === undefined
              ? {}
              : row.availability === 'available' ||
                  row.availability === 'specialist_not_linked' ||
                  row.availability === 'specialist_room_unsupported' ||
                  row.availability === 'assistant_not_owned' ||
                  row.availability === 'assistant_offline' ||
                  row.availability === 'assistant_not_approved' ||
                  row.availability === 'assistant_requires_update' ||
                  row.availability === 'not_linked' ||
                  row.availability === 'unsupported' ||
                  row.availability === 'not_registered' ||
                  row.availability === 'unavailable'
                ? { availability: row.availability }
                : (() => {
                    throw new Error(`invalid_response:mention_targets.targets.${index}.availability`)
                  })())
          }
        })
      }
    })
  }

  artifact(conversationId: string, resourceId: string) {
    return this.request(
      `/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(resourceId)}`,
      {},
      value => {
        const artifact = parseArtifactResponse(value)

        if (artifact.artifactId !== resourceId) {
          throw new Error('invalid_response:artifact.artifact_id_scope')
        }

        return artifact
      }
    )
  }

  send(mutation: PendingMutation) {
    return this.request(
      `/conversations/${encodeURIComponent(mutation.conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'idempotency-key': mutation.clientMessageId },
        body: JSON.stringify(mutation.request)
      },
      value => {
        const result = parseSendResponse(value)
        assertMessageConversationScope(mutation.conversationId, result.message.conversationId)

        return result
      }
    )
  }

  markRead(conversationId: string, throughMessageId: string, clientOperationId: string): Promise<void> {
    return this.request(
      `/conversations/${encodeURIComponent(conversationId)}/read`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': clientOperationId },
        body: JSON.stringify({ through_message_id: throughMessageId, client_operation_id: clientOperationId })
      },
      () => undefined
    )
  }

  toggleReaction(messageId: string, emoji: string): Promise<void> {
    return this.request(
      `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
      () => undefined
    )
  }

  editMessage(messageId: string, content: string): Promise<void> {
    return this.request(
      `/messages/${encodeURIComponent(messageId)}`,
      { method: 'PATCH', body: JSON.stringify({ content }) },
      () => undefined
    )
  }

  recallMessage(messageId: string): Promise<void> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/recall`, { method: 'POST' }, () => undefined)
  }

  searchMessages(query: string, conversationId?: string) {
    return this.request(
      '/api/search/messages',
      {
        method: 'POST',
        body: JSON.stringify({ query, ...(conversationId ? { conversation_id: conversationId } : {}) })
      },
      value => {
        const body = object(value)
        const rows = Array.isArray(value) ? value : body.results

        if (!Array.isArray(rows)) {
          throw new Error('invalid_response:search.messages')
        }

        return rows.map(raw => {
          const row = object(raw)

          return {
            message: parseCanonicalMessage(row.message ?? raw),
            conversationTitle: typeof row.conversation_title === 'string' ? row.conversation_title : null
          }
        })
      }
    )
  }

  createMediaUpload(input: { fileName: string; mimeType: string; sizeBytes: number }) {
    return this.request(
      '/media/uploads',
      {
        method: 'POST',
        body: JSON.stringify({ file_name: input.fileName, mime_type: input.mimeType, size_bytes: input.sizeBytes })
      },
      value => {
        const body = object(value)

        return {
          attachmentId: stringValue(body.attachment_id ?? body.id, 'media.attachment_id'),
          uploadUrl: stringValue(body.upload_url, 'media.upload_url')
        }
      }
    )
  }

  completeMediaUpload(attachmentId: string): Promise<void> {
    return this.request(
      '/media/uploads/complete',
      { method: 'POST', body: JSON.stringify({ attachment_id: attachmentId }) },
      () => undefined
    )
  }

  downloadMedia(attachmentId: string) {
    return this.request(`/media/download?attachment_id=${encodeURIComponent(attachmentId)}`, {}, value => ({
      url: stringValue(object(value).url, 'media.download.url')
    }))
  }

  /**
   * Run the caller's own pending assistant-mention jobs. The hosted worker is
   * driven by the mentioning account's bearer token because the model call is
   * metered against that account's managed allowance; there is no unattended
   * service-role path that could spend it.
   */
  drainMentionJobs(): Promise<{ claimed: number; completed: number }> {
    // This request runs a model turn on the far side, so the 15s default abort
    // would cancel a reply that was already being billed. The hosted route caps
    // itself at 180s and claims one job at a time.
    return this.request('/mention-jobs', { method: 'POST', timeoutMs: MENTION_DRAIN_TIMEOUT_MS }, value => {
      const body = object(value)

      return {
        claimed: Number(body.claimed) || 0,
        completed: Number(body.completed) || 0
      }
    })
  }

  sync(cursor: string | null): Promise<SyncPage> {
    const query = new URLSearchParams({ limit: '500' })

    if (cursor) {
      query.set('cursor', cursor)
    }

    return this.request(`/sync?${query}`, {}, parseSyncPage)
  }

  private async request<T>(
    route: string,
    init: RequestInit & { timeoutMs?: number; localAssistantContent?: boolean },
    parse: (value: unknown) => T
  ): Promise<T> {
    return (await this.requestRaw(route, init, parse)).value
  }

  private async requestRaw<T>(
    route: string,
    init: RequestInit & { timeoutMs?: number; localAssistantContent?: boolean },
    parse: (value: unknown) => T
  ): Promise<{ value: T; raw: string }> {
    const generation = this.generation
    const original = this.tokens.current()

    if (!original) {
      throw new MessagingTransportError('auth_unavailable', 401, false, null, null, null)
    }

    try {
      return await this.requestWithSession(original, route, init, parse, generation)
    } catch (error) {
      if (!(error instanceof MessagingTransportError) || error.status !== 401) {
        throw error
      }

      const refreshed = await this.tokens.refresh(original)

      if (!refreshed || generation !== this.generation) {
        throw error
      }

      return this.requestWithSession(refreshed, route, init, parse, generation)
    }
  }

  private async requestWithSession<T>(
    session: MessagingAccountSession,
    route: string,
    init: RequestInit & { timeoutMs?: number; localAssistantContent?: boolean },
    parse: (value: unknown) => T,
    generation: number
  ): Promise<{ value: T; raw: string }> {
    if (generation !== this.generation) {
      throw new MessagingTransportError('temporarily_unavailable', 0, true, null, null, null)
    }

    // Recheck on every attempt, including after an awaited token refresh. The
    // body is already an immutable snapshot; no asynchronous gap between this
    // check and fetch can add Google content to an earlier, unprotected write.
    if (init.localAssistantContent && this.options.workspaceProtected?.()) {
      throw new Error('google_workspace_local_only')
    }

    const headers = new Headers(init.headers)
    headers.set(PRIVATE_ADVISORY_HEADER, '1')
    headers.set(GROUP_ADDRESSING_HEADER, '1')
    headers.set(GROUP_CONVERSATIONS_HEADER, '1')
    headers.set(GROUP_SHARED_AGENTS_HEADER, '1')
    headers.set('x-atum-groups', '1')
    headers.set(PARTICIPANT_REFS_HEADER, '1')
    headers.set('accept', 'application/json')
    headers.set('authorization', `Bearer ${session.tokens.accessToken}`)
    headers.set('x-request-id', `desktop_${randomUUID()}`)

    if (this.desktopVersion) {
      headers.set(DESKTOP_VERSION_HEADER, this.desktopVersion)
    }

    if (init.body !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8')
    }

    const controller = new AbortController()

    const timeout = setTimeout(
      () => controller.abort(),
      boundedInteger(init.timeoutMs, this.requestTimeoutMs, 10, MENTION_DRAIN_TIMEOUT_MS)
    )

    this.activeRequests.add(controller)
    let response: Response
    let bytes: string

    try {
      response = await this.fetchImpl(endpoint(session.baseUrl, route), {
        ...init,
        headers,
        cache: 'no-store',
        signal: controller.signal
      })
      bytes = await this.readBoundedResponse(response, controller)
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new MessagingTransportError('invalid_response', response?.status ?? 200, false, null, null, null)
      }

      throw new MessagingTransportError(
        'temporarily_unavailable',
        0,
        true,
        null,
        null,
        error instanceof Error ? { message: error.message } : null
      )
    } finally {
      clearTimeout(timeout)
      this.activeRequests.delete(controller)
    }

    let body: unknown

    try {
      body = bytes ? JSON.parse(bytes) : null
    } catch {
      throw new MessagingTransportError('invalid_response', response.status, false, null, null, null)
    }

    if (!response.ok) {
      const envelope = parseDesktopError(body)

      if (!envelope) {
        throw new MessagingTransportError('invalid_response', response.status, false, null, null, null)
      }

      throw new MessagingTransportError(
        envelope.error.code,
        response.status,
        envelope.error.retryable,
        envelope.error.request_id,
        typeof envelope.error.retry_after_ms === 'number'
          ? Math.max(0, Math.min(envelope.error.retry_after_ms, MAX_RETRY_AFTER_MS))
          : null,
        envelope.error.details ?? null
      )
    }

    try {
      return { value: parse(body), raw: bytes }
    } catch (error) {
      throw new MessagingTransportError(
        error instanceof Error ? error.message : 'invalid_response',
        response.status,
        false,
        response.headers.get('x-request-id'),
        null,
        null
      )
    }
  }

  private async readBoundedResponse(response: Response, controller: AbortController): Promise<string> {
    const contentLength = Number(response.headers.get('content-length'))

    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      controller.abort()
      throw new ResponseTooLargeError()
    }

    if (!response.body) {
      return ''
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    let result = ''

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        return result + decoder.decode()
      }

      size += value.byteLength

      if (size > this.maxResponseBytes) {
        controller.abort()
        await reader.cancel().catch(() => undefined)
        throw new ResponseTooLargeError()
      }

      result += decoder.decode(value, { stream: true })
    }
  }
}
