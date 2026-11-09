/**
 * The browser-import wire contract, as the owner's Mac needs it.
 *
 * VENDORED from `@atum/protocol` 0.7.36 (`packages/protocol/src/browser-import.ts`, atum-platform PR #654
 * `feat/browser-import-contract` at commit b849d062; packs `atum.cloud-execution/2.1` sha256 ece15ff7…2211c and
 * `atum.device-service/3` sha256 3b91faa1…bd513). atum-app does not consume `@atum/protocol` as a package yet
 * (`packages/device-protocol` is the existing vendored mirror), so this is the one module that knows the wire.
 *
 * TODO(platform #654, merged): when atum-app can import `@atum/protocol`, replace the bodies
 * below with re-exports. `contract.test.ts` runs every helper against the pack's own fixtures (copied
 * byte-for-byte into `__fixtures__/contract-v2.1`), so the swap is covered by the same tests. Never change the
 * bytes a helper produces: they are the cross-repo contract (RFC 8785 JCS, digests, signature input).
 *
 * Deliberate differences from the platform mirror:
 * - no zod: shapes are checked by small hand validators with the same strictness (unknown keys are refused);
 * - only what the Mac does (build, seal and sign an import; read and trust a recipient key). The cloud's
 *   admission, restore, erase and removal deciders stay on the platform side.
 */
import { createHash } from 'node:crypto'

import { getDomain } from 'tldts'

import { canonicalJson } from '../device/canonical'

export const CLOUD_EXECUTION_V21_PROFILE = 'atum.cloud-execution/2.1' as const
export const BROWSER_IMPORT_HPKE_INFO = 'atum.browser-import/v1' as const
export const BROWSER_IMPORT_MAX_TTL_MS = 900_000
export const BROWSER_IMPORT_MAX_FUTURE_SKEW_MS = 30_000
export const BROWSER_IMPORT_MAX_COOKIES = 20_000
export const BROWSER_IMPORT_MAX_COOKIE_VALUE_BYTES = 4_096
export const BROWSER_IMPORT_MAX_CIPHERTEXT_BYTES = 134_217_728
export const BROWSER_IMPORT_MAX_SITES = 1_000
export const BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES = ['banking', 'wallet', 'password_manager'] as const
/** `atum.device-service/3` signing domain; a controller or owner-client signature covers it first. */
export const DEVICE_SERVICE_V3_SIGNING_DOMAIN = 'atum.device-service.v3\0'
/** `device-service/3` `signing.maxSignedLifetimeMs`. */
export const SIGNED_MESSAGE_MAX_MS = 7_200_000

export type BrowserImportSiteCategory = (typeof BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES)[number]

export type BrowserImportSiteSelection =
  | { domain: string; category: 'standard'; disposition: 'included'; ownerOverride: false }
  | { domain: string; category: BrowserImportSiteCategory; disposition: 'skipped_default'; ownerOverride: false }
  | {
      domain: string
      category: BrowserImportSiteCategory
      disposition: 'included_owner_override'
      ownerOverride: true
    }

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface BrowserStorageStateBundle {
  siteSelections: BrowserImportSiteSelection[]
  cookies: BrowserCookie[]
  origins: never[]
}

export interface BrowserImportAgent {
  agentPrincipal: string
  profileIsolation: 'separate'
}

export interface BrowserImportAuthenticatedData {
  ownerUserId: string
  selectedAgents: BrowserImportAgent[]
  recipientBasis: 'primary_default' | 'owner_shared'
  computerId: string
  attachmentEpoch: number
  sitesDigest: string
  siteCount: number
  importId: string
  expiresAt: number
  createdAt: number
  hpkeKeyId: string
  contentType: 'playwright_storage_state_cookies_only'
  plaintextEncoding: 'RFC8785_JCS_UTF8'
}

export interface BrowserImportAdmission {
  importId: string
  ownerUserId: string
  approvedBy: string
  approvedAt: number
  source: { browser: 'chrome' | 'arc' | 'brave' | 'edge' | 'safari'; profileOrdinal: number }
  sitesDigest: string
  siteCount: number
  skippedSiteCount: number
  selectedAgents: BrowserImportAgent[]
  recipientBasis: 'primary_default' | 'owner_shared'
  recipient: { computerId: string; attachmentEpoch: number }
  expiresAt: number
  consent: 'explicit_owner_approval'
}

export interface BrowserImportEnvelope {
  authenticatedData: BrowserImportAuthenticatedData
  admissionDigest: string
  ciphertextDigest: string
  recipient: { computerId: string; attachmentEpoch: number }
  signer: { deviceServiceId: string; approvalKeyId: string }
  signatureAlgorithm: 'ECDSA_P256_SHA256_P1363'
  signature: string
  hpke: {
    mode: 'base'
    info: typeof BROWSER_IMPORT_HPKE_INFO
    aadEncoding: 'RFC8785_JCS_UTF8'
    kem: 'DHKEM_X25519_HKDF_SHA256'
    kdf: 'HKDF_SHA256'
    aead: 'AES_256_GCM'
    encapsulatedKey: string
    ciphertext: string
  }
  relayAccess: 'ciphertext_only'
}

export interface SignedMeta<Signer extends string> {
  requestId: string
  commandId: string
  signer: Signer
  signerKeyId: string
  sequence: number
  issuedAt: number
  expiresAt: number
  nonce: string
  signature: string
}

export interface BrowserImportRecipientKeyRecord {
  meta: SignedMeta<'platform_controller'>
  binding: { ownerUserId: string; agentPrincipal: string; computerId: string }
  attachmentEpoch: number
  hpkeKeyId: string
  hpkePublicKey: string
  kem: 'DHKEM_X25519_HKDF_SHA256'
  publishedAt: number
  pinning: 'computer_attachment_epoch'
}

export interface BrowserImportRecipientKeyReadRequest {
  meta: SignedMeta<'owner_client'>
  ownerUserId: string
  computerId: string
  attachmentEpoch: number
}

// ------------------------------------------------------------------ validation

export class BrowserImportContractError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(`${path}: ${message}`)
    this.name = 'BrowserImportContractError'
  }
}

const fail = (path: string, message: string): never => {
  throw new BrowserImportContractError(path, message)
}

type Dict = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const USER_ID = /^@[!-9;-~]+:[!-~]+$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const KEY_ID = /^[A-Za-z0-9_-]{43}$/u
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u

const REGISTRABLE_DOMAIN =
  /^(?![0-9]+(?:[.][0-9]+){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

function strictObject(value: unknown, path: string, keys: readonly string[]): Dict {
  if (!isDict(value)) {
    return fail(path, 'expected an object')
  }

  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(`${path}.${key}`, 'unknown key')
    }
  }

  for (const key of keys) {
    if (!(key in value)) {
      fail(`${path}.${key}`, 'missing')
    }
  }

  return value
}

function text(value: unknown, path: string, pattern?: RegExp, min = 0, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    return fail(path, 'invalid string')
  }

  return value
}

function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail(path, 'invalid integer')
  }

  return value
}

function exactly<T extends string | boolean>(value: unknown, path: string, expected: T): T {
  return value === expected ? expected : fail(path, `expected ${String(expected)}`)
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fail(path, `expected one of ${options.join(', ')}`)
}

const uuid = (value: unknown, path: string) => text(value, path, UUID)
const userId = (value: unknown, path: string) => text(value, path, USER_ID, 4, 1_024)
const keyId = (value: unknown, path: string) => text(value, path, KEY_ID)
const epoch = (value: unknown, path: string) => integer(value, path, 1)
const timestamp = (value: unknown, path: string) => integer(value, path, 0)

function base64urlText(value: unknown, path: string, length?: number): string {
  const result = text(value, path, BASE64URL, 2)

  if (result.length % 4 === 1 || (length !== undefined && result.length !== length)) {
    return fail(path, 'invalid base64url')
  }

  return result
}

/** A Public Suffix List registrable domain (eTLD+1), lowercase DNS: never a public suffix, IP or localhost. */
export function siteDomain(value: unknown, path = 'site'): string {
  const result = text(value, path, REGISTRABLE_DOMAIN, 3, 253)

  if (getDomain(result, { allowPrivateDomains: true }) !== result) {
    return fail(path, 'site must be a Public Suffix List registrable domain, not a public suffix')
  }

  return result
}

/** Chrome's `host_key` shape: lowercase DNS under a registrable suffix, a leading dot for domain cookies. */
export function isCookieDomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 254 &&
    REGISTRABLE_DOMAIN.test(value.startsWith('.') ? value.slice(1) : value)
  )
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** Why the contract would refuse this cookie, or null. The importer drops such a cookie instead of failing. */
export function cookieViolation(cookie: BrowserCookie): string | null {
  if (cookie.name.length < 1 || cookie.name.length > 4_096) {
    return 'name'
  }

  if (utf8Bytes(cookie.value) > BROWSER_IMPORT_MAX_COOKIE_VALUE_BYTES) {
    return 'value_too_large'
  }

  if (!isCookieDomain(cookie.domain)) {
    return 'domain'
  }

  if (cookie.path.length < 1 || cookie.path.length > 4_096) {
    return 'path'
  }

  if (!Number.isInteger(cookie.expires) || cookie.expires < -1 || cookie.expires > 253_402_300_799) {
    return 'expires'
  }

  if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'))) {
    return 'host_prefix'
  }

  return null
}

function parseCookie(value: unknown, path: string): BrowserCookie {
  const o = strictObject(value, path, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'])

  const cookie: BrowserCookie = {
    name: text(o.name, `${path}.name`, undefined, 1, 4_096),
    value: text(o.value, `${path}.value`),
    domain: text(o.domain, `${path}.domain`, undefined, 3, 254),
    path: text(o.path, `${path}.path`, undefined, 1, 4_096),
    expires: integer(o.expires, `${path}.expires`, -1, 253_402_300_799),
    httpOnly: typeof o.httpOnly === 'boolean' ? o.httpOnly : fail(`${path}.httpOnly`, 'expected boolean'),
    secure: typeof o.secure === 'boolean' ? o.secure : fail(`${path}.secure`, 'expected boolean'),
    sameSite: oneOf(o.sameSite, `${path}.sameSite`, ['Strict', 'Lax', 'None'] as const)
  }

  const violation = cookieViolation(cookie)

  if (violation) {
    fail(`${path}.${violation}`, 'the contract refuses this cookie')
  }

  return cookie
}

export function parseSiteSelection(value: unknown, path = 'siteSelection'): BrowserImportSiteSelection {
  const o = strictObject(value, path, ['domain', 'category', 'disposition', 'ownerOverride'])
  const domain = siteDomain(o.domain, `${path}.domain`)

  const disposition = oneOf(o.disposition, `${path}.disposition`, [
    'included',
    'skipped_default',
    'included_owner_override'
  ] as const)

  if (disposition === 'included') {
    exactly(o.category, `${path}.category`, 'standard')
    exactly(o.ownerOverride, `${path}.ownerOverride`, false)

    return { domain, category: 'standard', disposition, ownerOverride: false }
  }

  const category = oneOf(o.category, `${path}.category`, BROWSER_IMPORT_DEFAULT_SKIP_CATEGORIES)

  if (disposition === 'skipped_default') {
    exactly(o.ownerOverride, `${path}.ownerOverride`, false)

    return { domain, category, disposition, ownerOverride: false }
  }

  exactly(o.ownerOverride, `${path}.ownerOverride`, true)

  return { domain, category, disposition, ownerOverride: true }
}

function parseSiteSelections(value: unknown, path: string): BrowserImportSiteSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > BROWSER_IMPORT_MAX_SITES) {
    return fail(path, `expected 1 to ${BROWSER_IMPORT_MAX_SITES} site selections`)
  }

  const selections = value.map((entry, index) => parseSiteSelection(entry, `${path}[${index}]`))

  if (new Set(selections.map(({ domain }) => domain)).size !== selections.length) {
    fail(path, 'sites must be unique by domain')
  }

  return selections
}

export function parseBundle(value: unknown): BrowserStorageStateBundle {
  const o = strictObject(value, 'bundle', ['siteSelections', 'cookies', 'origins'])

  if (!Array.isArray(o.cookies) || o.cookies.length > BROWSER_IMPORT_MAX_COOKIES) {
    fail('bundle.cookies', `expected at most ${BROWSER_IMPORT_MAX_COOKIES} cookies`)
  }

  if (!Array.isArray(o.origins) || o.origins.length !== 0) {
    fail('bundle.origins', 'origins and localStorage are not imported')
  }

  return {
    siteSelections: parseSiteSelections(o.siteSelections, 'bundle.siteSelections'),
    cookies: (o.cookies as unknown[]).map((cookie, index) => parseCookie(cookie, `bundle.cookies[${index}]`)),
    origins: []
  }
}

function parseAgents(value: unknown, path: string): BrowserImportAgent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    return fail(path, 'expected 1 to 32 agents')
  }

  const agents = value.map((entry, index) => {
    const o = strictObject(entry, `${path}[${index}]`, ['agentPrincipal', 'profileIsolation'])

    return {
      agentPrincipal: uuid(o.agentPrincipal, `${path}[${index}].agentPrincipal`),
      profileIsolation: exactly(o.profileIsolation, `${path}[${index}].profileIsolation`, 'separate')
    }
  })

  if (new Set(agents.map(({ agentPrincipal }) => agentPrincipal)).size !== agents.length) {
    fail(path, 'agents must be unique')
  }

  return agents
}

export function parseAuthenticatedData(value: unknown): BrowserImportAuthenticatedData {
  const path = 'authenticatedData'

  const o = strictObject(value, path, [
    'ownerUserId',
    'selectedAgents',
    'recipientBasis',
    'computerId',
    'attachmentEpoch',
    'sitesDigest',
    'siteCount',
    'importId',
    'expiresAt',
    'createdAt',
    'hpkeKeyId',
    'contentType',
    'plaintextEncoding'
  ])

  const data: BrowserImportAuthenticatedData = {
    ownerUserId: userId(o.ownerUserId, `${path}.ownerUserId`),
    selectedAgents: parseAgents(o.selectedAgents, `${path}.selectedAgents`),
    recipientBasis: oneOf(o.recipientBasis, `${path}.recipientBasis`, ['primary_default', 'owner_shared'] as const),
    computerId: uuid(o.computerId, `${path}.computerId`),
    attachmentEpoch: epoch(o.attachmentEpoch, `${path}.attachmentEpoch`),
    sitesDigest: keyId(o.sitesDigest, `${path}.sitesDigest`),
    siteCount: integer(o.siteCount, `${path}.siteCount`, 1, BROWSER_IMPORT_MAX_SITES),
    importId: uuid(o.importId, `${path}.importId`),
    expiresAt: timestamp(o.expiresAt, `${path}.expiresAt`),
    createdAt: timestamp(o.createdAt, `${path}.createdAt`),
    hpkeKeyId: keyId(o.hpkeKeyId, `${path}.hpkeKeyId`),
    contentType: exactly(o.contentType, `${path}.contentType`, 'playwright_storage_state_cookies_only'),
    plaintextEncoding: exactly(o.plaintextEncoding, `${path}.plaintextEncoding`, 'RFC8785_JCS_UTF8')
  }

  if (data.recipientBasis === 'primary_default' && data.selectedAgents.length !== 1) {
    fail(`${path}.selectedAgents`, 'primary_default addresses exactly the primary agent')
  }

  return data
}

export function parseAdmission(value: unknown): BrowserImportAdmission {
  const path = 'admission'

  const o = strictObject(value, path, [
    'importId',
    'ownerUserId',
    'approvedBy',
    'approvedAt',
    'source',
    'sitesDigest',
    'siteCount',
    'skippedSiteCount',
    'selectedAgents',
    'recipientBasis',
    'recipient',
    'expiresAt',
    'consent'
  ])

  const source = strictObject(o.source, `${path}.source`, ['browser', 'profileOrdinal'])
  const recipient = strictObject(o.recipient, `${path}.recipient`, ['computerId', 'attachmentEpoch'])

  const admission: BrowserImportAdmission = {
    importId: uuid(o.importId, `${path}.importId`),
    ownerUserId: userId(o.ownerUserId, `${path}.ownerUserId`),
    approvedBy: userId(o.approvedBy, `${path}.approvedBy`),
    approvedAt: timestamp(o.approvedAt, `${path}.approvedAt`),
    source: {
      browser: oneOf(source.browser, `${path}.source.browser`, ['chrome', 'arc', 'brave', 'edge', 'safari'] as const),
      profileOrdinal: integer(source.profileOrdinal, `${path}.source.profileOrdinal`, 1, 1_024)
    },
    sitesDigest: keyId(o.sitesDigest, `${path}.sitesDigest`),
    siteCount: integer(o.siteCount, `${path}.siteCount`, 1, BROWSER_IMPORT_MAX_SITES),
    skippedSiteCount: integer(o.skippedSiteCount, `${path}.skippedSiteCount`, 0, BROWSER_IMPORT_MAX_SITES),
    selectedAgents: parseAgents(o.selectedAgents, `${path}.selectedAgents`),
    recipientBasis: oneOf(o.recipientBasis, `${path}.recipientBasis`, ['primary_default', 'owner_shared'] as const),
    recipient: {
      computerId: uuid(recipient.computerId, `${path}.recipient.computerId`),
      attachmentEpoch: epoch(recipient.attachmentEpoch, `${path}.recipient.attachmentEpoch`)
    },
    expiresAt: timestamp(o.expiresAt, `${path}.expiresAt`),
    consent: exactly(o.consent, `${path}.consent`, 'explicit_owner_approval')
  }

  if (admission.approvedBy !== admission.ownerUserId) {
    fail(`${path}.approvedBy`, 'only the owner may approve import')
  }

  if (admission.expiresAt <= admission.approvedAt) {
    fail(`${path}.expiresAt`, 'consent expiry must follow approval')
  }

  if (admission.skippedSiteCount > admission.siteCount) {
    fail(`${path}.skippedSiteCount`, 'skipped count cannot exceed site count')
  }

  if (admission.recipientBasis === 'primary_default' && admission.selectedAgents.length !== 1) {
    fail(`${path}.selectedAgents`, 'primary_default addresses exactly the primary agent')
  }

  return admission
}

/** Lowercase hex SHA-256 of the bytes a base64url string decodes to. */
function ciphertextDigestOf(ciphertext: string): string {
  return createHash('sha256').update(Buffer.from(ciphertext, 'base64url')).digest('hex')
}

export function parseEnvelope(value: unknown): BrowserImportEnvelope {
  const path = 'envelope'

  const o = strictObject(value, path, [
    'authenticatedData',
    'admissionDigest',
    'ciphertextDigest',
    'recipient',
    'signer',
    'signatureAlgorithm',
    'signature',
    'hpke',
    'relayAccess'
  ])

  const recipient = strictObject(o.recipient, `${path}.recipient`, ['computerId', 'attachmentEpoch'])
  const signer = strictObject(o.signer, `${path}.signer`, ['deviceServiceId', 'approvalKeyId'])

  const h = strictObject(o.hpke, `${path}.hpke`, [
    'mode',
    'info',
    'aadEncoding',
    'kem',
    'kdf',
    'aead',
    'encapsulatedKey',
    'ciphertext'
  ])

  const ciphertext = base64urlText(h.ciphertext, `${path}.hpke.ciphertext`)

  if (Math.floor((ciphertext.length * 3) / 4) > BROWSER_IMPORT_MAX_CIPHERTEXT_BYTES) {
    fail(`${path}.hpke.ciphertext`, 'ciphertext exceeds 128 MiB')
  }

  const envelope: BrowserImportEnvelope = {
    authenticatedData: parseAuthenticatedData(o.authenticatedData),
    admissionDigest: text(o.admissionDigest, `${path}.admissionDigest`, SHA256_HEX),
    ciphertextDigest: text(o.ciphertextDigest, `${path}.ciphertextDigest`, SHA256_HEX),
    recipient: {
      computerId: uuid(recipient.computerId, `${path}.recipient.computerId`),
      attachmentEpoch: epoch(recipient.attachmentEpoch, `${path}.recipient.attachmentEpoch`)
    },
    signer: {
      deviceServiceId: uuid(signer.deviceServiceId, `${path}.signer.deviceServiceId`),
      approvalKeyId: keyId(signer.approvalKeyId, `${path}.signer.approvalKeyId`)
    },
    signatureAlgorithm: exactly(o.signatureAlgorithm, `${path}.signatureAlgorithm`, 'ECDSA_P256_SHA256_P1363'),
    signature: text(o.signature, `${path}.signature`, SIGNATURE),
    hpke: {
      mode: exactly(h.mode, `${path}.hpke.mode`, 'base'),
      info: exactly(h.info, `${path}.hpke.info`, BROWSER_IMPORT_HPKE_INFO),
      aadEncoding: exactly(h.aadEncoding, `${path}.hpke.aadEncoding`, 'RFC8785_JCS_UTF8'),
      kem: exactly(h.kem, `${path}.hpke.kem`, 'DHKEM_X25519_HKDF_SHA256'),
      kdf: exactly(h.kdf, `${path}.hpke.kdf`, 'HKDF_SHA256'),
      aead: exactly(h.aead, `${path}.hpke.aead`, 'AES_256_GCM'),
      encapsulatedKey: base64urlText(h.encapsulatedKey, `${path}.hpke.encapsulatedKey`, 43),
      ciphertext
    },
    relayAccess: exactly(o.relayAccess, `${path}.relayAccess`, 'ciphertext_only')
  }

  const aad = envelope.authenticatedData

  if (aad.expiresAt <= aad.createdAt) {
    fail(`${path}.authenticatedData.expiresAt`, 'import expiry must follow creation')
  }

  if (aad.expiresAt > aad.createdAt + BROWSER_IMPORT_MAX_TTL_MS) {
    fail(`${path}.authenticatedData.expiresAt`, 'import lifetime exceeds limit')
  }

  if (envelope.recipient.computerId !== aad.computerId) {
    fail(`${path}.recipient.computerId`, 'recipient computer must be bound in authenticated data')
  }

  if (envelope.recipient.attachmentEpoch !== aad.attachmentEpoch) {
    fail(`${path}.recipient.attachmentEpoch`, 'recipient epoch must be bound in authenticated data')
  }

  if (ciphertextDigestOf(ciphertext) !== envelope.ciphertextDigest) {
    fail(`${path}.ciphertextDigest`, 'ciphertext digest mismatch')
  }

  return envelope
}

function parseSignedMeta<Signer extends string>(value: unknown, path: string, signer: Signer): SignedMeta<Signer> {
  const o = strictObject(value, path, [
    'requestId',
    'commandId',
    'signer',
    'signerKeyId',
    'sequence',
    'issuedAt',
    'expiresAt',
    'nonce',
    'signature'
  ])

  return {
    requestId: uuid(o.requestId, `${path}.requestId`),
    commandId: uuid(o.commandId, `${path}.commandId`),
    signer: exactly(o.signer, `${path}.signer`, signer),
    signerKeyId: keyId(o.signerKeyId, `${path}.signerKeyId`),
    sequence: integer(o.sequence, `${path}.sequence`, 1),
    issuedAt: timestamp(o.issuedAt, `${path}.issuedAt`),
    expiresAt: timestamp(o.expiresAt, `${path}.expiresAt`),
    nonce: keyId(o.nonce, `${path}.nonce`),
    signature: text(o.signature, `${path}.signature`, SIGNATURE)
  }
}

/** Shape only: `decideBrowserImportRecipientKey` applies the key-id rule in the contract's own order. */
export function parseRecipientKeyRecordShape(value: unknown): BrowserImportRecipientKeyRecord {
  const path = 'recipientKey'

  const o = strictObject(value, path, [
    'meta',
    'binding',
    'attachmentEpoch',
    'hpkeKeyId',
    'hpkePublicKey',
    'kem',
    'publishedAt',
    'pinning'
  ])

  const binding = strictObject(o.binding, `${path}.binding`, ['ownerUserId', 'agentPrincipal', 'computerId'])

  return {
    meta: parseSignedMeta(o.meta, `${path}.meta`, 'platform_controller'),
    binding: {
      ownerUserId: userId(binding.ownerUserId, `${path}.binding.ownerUserId`),
      agentPrincipal: uuid(binding.agentPrincipal, `${path}.binding.agentPrincipal`),
      computerId: uuid(binding.computerId, `${path}.binding.computerId`)
    },
    attachmentEpoch: epoch(o.attachmentEpoch, `${path}.attachmentEpoch`),
    hpkeKeyId: keyId(o.hpkeKeyId, `${path}.hpkeKeyId`),
    hpkePublicKey: base64urlText(o.hpkePublicKey, `${path}.hpkePublicKey`, 43),
    kem: exactly(o.kem, `${path}.kem`, 'DHKEM_X25519_HKDF_SHA256'),
    publishedAt: timestamp(o.publishedAt, `${path}.publishedAt`),
    pinning: exactly(o.pinning, `${path}.pinning`, 'computer_attachment_epoch')
  }
}

/** Shape plus the rule that the key id hashes the raw public key. */
export function parseRecipientKeyRecord(value: unknown): BrowserImportRecipientKeyRecord {
  const record = parseRecipientKeyRecordShape(value)

  if (browserImportHpkeKeyId(record.hpkePublicKey) !== record.hpkeKeyId) {
    fail('recipientKey.hpkeKeyId', 'HPKE key id must hash the raw public key')
  }

  return record
}

export function parseRecipientKeyReadRequest(value: unknown): BrowserImportRecipientKeyReadRequest {
  const path = 'recipientKeyRead'
  const o = strictObject(value, path, ['meta', 'ownerUserId', 'computerId', 'attachmentEpoch'])

  return {
    meta: parseSignedMeta(o.meta, `${path}.meta`, 'owner_client'),
    ownerUserId: userId(o.ownerUserId, `${path}.ownerUserId`),
    computerId: uuid(o.computerId, `${path}.computerId`),
    attachmentEpoch: epoch(o.attachmentEpoch, `${path}.attachmentEpoch`)
  }
}

// ------------------------------------------------------------------ canonical bytes

function requireUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)

      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('JCS requires Unicode scalar strings')
      }

      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('JCS requires Unicode scalar strings')
    }
  }
}

/** RFC 8785 JSON Canonicalization: sorted keys, no whitespace, no Unicode normalization. */
export function jcsJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (typeof value === 'string') {
    requireUnicodeScalarString(value)

    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS forbids non-finite numbers')
    }

    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(jcsJson).join(',')}]`
  }

  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('value is not JSON')
  }

  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()

  for (const key of keys) {
    requireUnicodeScalarString(key)
  }

  return `{${keys.map(key => `${JSON.stringify(key)}:${jcsJson(object[key])}`).join(',')}}`
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest()
const utf8 = (value: string) => new TextEncoder().encode(value)

/** RFC 8785 JCS UTF-8 bytes used verbatim as the HPKE AAD. */
export function browserImportAadBytes(authenticatedData: BrowserImportAuthenticatedData): Uint8Array {
  return utf8(jcsJson(parseAuthenticatedData(authenticatedData)))
}

/** SHA-256 hex of RFC 8785 JCS UTF-8 for the complete consent/admission record. */
export function browserImportAdmissionDigest(admission: BrowserImportAdmission): string {
  return sha256(utf8(jcsJson(parseAdmission(admission)))).toString('hex')
}

/** SHA-256 over JCS [{site,decision}] sorted by site, as unpadded base64url. */
export function browserImportSitesDigest(siteSelections: readonly BrowserImportSiteSelection[]): string {
  const selections = parseSiteSelections(siteSelections, 'siteSelections')

  const rows = selections
    .map(({ domain, disposition }) => ({ site: domain, decision: disposition }))
    .sort((left, right) => (left.site < right.site ? -1 : left.site > right.site ? 1 : 0))

  return sha256(utf8(jcsJson(rows))).toString('base64url')
}

/** Canonical plaintext bytes sealed by the browser-import HPKE envelope. */
export function browserImportBundleBytes(bundle: BrowserStorageStateBundle): Uint8Array {
  return utf8(jcsJson(parseBundle(bundle)))
}

/** base64url(SHA-256(raw X25519 public key)). */
export function browserImportHpkeKeyId(hpkePublicKey: string): string {
  return sha256(Buffer.from(base64urlText(hpkePublicKey, 'hpkePublicKey', 43), 'base64url')).toString('base64url')
}

/**
 * The P-256 approval-key signature input: `utf8('atum.browser-import/v1\0') || aad || 0x00 || raw32(admissionDigest)
 * || raw32(ciphertextDigest)`. An envelope satisfies the parameter, as do its parts before it is signed.
 */
export function browserImportSignatureBytes(parts: {
  authenticatedData: BrowserImportAuthenticatedData
  admissionDigest: string
  ciphertextDigest: string
}): Uint8Array {
  return Buffer.concat([
    utf8(`${BROWSER_IMPORT_HPKE_INFO}\0`),
    browserImportAadBytes(parts.authenticatedData),
    Uint8Array.of(0),
    Buffer.from(text(parts.admissionDigest, 'admissionDigest', SHA256_HEX), 'hex'),
    Buffer.from(text(parts.ciphertextDigest, 'ciphertextDigest', SHA256_HEX), 'hex')
  ])
}

/**
 * `device-service/3` signed bytes for a message carrying a `meta`: the domain, the message name and a NUL, then
 * the canonical body with `meta.signature` removed (`cloudDeviceSignedBytes` in `@atum/protocol`).
 */
export function cloudDeviceSignedBytes(message: string, value: { meta: { signature: string } }): Uint8Array {
  const { signature: _signature, ...meta } = value.meta

  return utf8(`${DEVICE_SERVICE_V3_SIGNING_DOMAIN}${message}\0${canonicalJson({ ...value, meta })}`)
}

// ------------------------------------------------------------------ recipient key trust

export interface BrowserImportRecipientKeyContext {
  authenticatedOwnerUserId: string | null
  ownerUserId: string
  computerId: string
  attachmentEpoch: number
  pinnedControllerKeyIds: readonly string[]
  verifiedSignature: { valid: boolean; signerKeyId: string }
}

export type BrowserImportRecipientKeyRefusal =
  | 'owner_unauthenticated'
  | 'wrong_owner'
  | 'wrong_computer'
  | 'stale_attachment_epoch'
  | 'unpinned_controller_key'
  | 'forged_controller_signature'
  | 'hpke_key_id_mismatch'

export type BrowserImportRecipientKeyDecision =
  | { outcome: 'accepted'; reason: 'owner_authenticated_controller_key'; hpkeKeyId: string; hpkePublicKey: string }
  | { outcome: 'refused'; reason: BrowserImportRecipientKeyRefusal }

/** The Mac's admission of a recipient key, in the contract's order (`decideBrowserImportRecipientKey`). */
export function decideBrowserImportRecipientKey(
  requestValue: unknown,
  recordValue: unknown,
  context: BrowserImportRecipientKeyContext
): BrowserImportRecipientKeyDecision {
  const request = parseRecipientKeyReadRequest(requestValue)
  const record = parseRecipientKeyRecordShape(recordValue)

  const refuse = (reason: BrowserImportRecipientKeyRefusal): BrowserImportRecipientKeyDecision => ({
    outcome: 'refused',
    reason
  })

  if (context.authenticatedOwnerUserId === null) {
    return refuse('owner_unauthenticated')
  }

  if (context.authenticatedOwnerUserId !== context.ownerUserId || request.ownerUserId !== context.ownerUserId) {
    return refuse('wrong_owner')
  }

  if (request.computerId !== context.computerId) {
    return refuse('wrong_computer')
  }

  if (request.attachmentEpoch !== context.attachmentEpoch) {
    return refuse('stale_attachment_epoch')
  }

  if (!context.pinnedControllerKeyIds.includes(record.meta.signerKeyId)) {
    return refuse('unpinned_controller_key')
  }

  if (!context.verifiedSignature.valid || context.verifiedSignature.signerKeyId !== record.meta.signerKeyId) {
    return refuse('forged_controller_signature')
  }

  if (record.binding.ownerUserId !== context.ownerUserId) {
    return refuse('wrong_owner')
  }

  if (record.binding.computerId !== context.computerId) {
    return refuse('wrong_computer')
  }

  if (record.attachmentEpoch !== context.attachmentEpoch) {
    return refuse('stale_attachment_epoch')
  }

  if (browserImportHpkeKeyId(record.hpkePublicKey) !== record.hpkeKeyId) {
    return refuse('hpke_key_id_mismatch')
  }

  return {
    outcome: 'accepted',
    reason: 'owner_authenticated_controller_key',
    hpkeKeyId: record.hpkeKeyId,
    hpkePublicKey: record.hpkePublicKey
  }
}

// ------------------------------------------------------------------ site filter

export interface BrowserImportVerifiedSites {
  sitesDigest: string
  siteCount: number
  skippedSiteCount: number
  includedSites: string[]
  skippedSites: string[]
}

const normalizedCookieDomain = (domain: string) => (domain.startsWith('.') ? domain.slice(1) : domain)
const domainWithinSite = (domain: string, site: string) => domain === site || domain.endsWith(`.${site}`)

/**
 * The cloud's post-decryption cookie gate, mirrored so the Mac selects exactly what the cloud will keep: a cookie
 * is allowed when its domain equals or sits below an included site and below no skipped one.
 */
export function isBrowserCookieDomainAllowed(cookieDomain: string, sites: BrowserImportVerifiedSites): boolean {
  const domain = normalizedCookieDomain(cookieDomain)

  if (sites.skippedSites.some(site => domainWithinSite(domain, site))) {
    return false
  }

  return sites.includedSites.some(site => domainWithinSite(domain, site))
}

/** The verified include/skip set the Mac derives from its own selections (the cloud recomputes it after decrypt). */
export function verifiedSitesOf(siteSelections: readonly BrowserImportSiteSelection[]): BrowserImportVerifiedSites {
  const selections = parseSiteSelections(siteSelections, 'siteSelections')
  const skipped = selections.filter(({ disposition }) => disposition === 'skipped_default')

  return {
    sitesDigest: browserImportSitesDigest(selections),
    siteCount: selections.length,
    skippedSiteCount: skipped.length,
    includedSites: selections
      .filter(({ disposition }) => disposition !== 'skipped_default')
      .map(({ domain }) => domain),
    skippedSites: skipped.map(({ domain }) => domain)
  }
}
