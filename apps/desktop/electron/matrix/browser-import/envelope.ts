/**
 * Seal a cookies-only bundle to the primary agent's computer and prepare what the owner's approval key signs.
 *
 * The order is fixed by the contract: the HPKE ciphertext comes first because the approval signature covers its
 * digest, so one Touch ID signs the exact bytes that leave the Mac (`atum.cloud-execution/2.1`, "browserImport").
 *
 * 1. `sealBrowserImport` builds the consent record and the authenticated data, then HPKE-seals the RFC 8785 JCS
 *    bundle in base mode (DHKEM X25519 / HKDF-SHA256 / AES-256-GCM, info `atum.browser-import/v1`) with the JCS
 *    authenticated data as AAD, so a relay or the database sees ciphertext only.
 * 2. The caller has the approval key sign `signatureBytes` (a Touch ID).
 * 3. `assembleBrowserImportEnvelope` joins the signature to the sealed parts and validates the whole envelope.
 *
 * The plaintext bytes handed to HPKE are zeroed the moment `seal` returns (or throws), and the cookie arrays this
 * module parsed are emptied then too. Best effort: the cookie values were JavaScript strings on the way in and
 * cannot be wiped (README, "What zeroization does and does not cover").
 */
import { createHash } from 'node:crypto'

import { AeadId, CipherSuite, KdfId, KemId } from 'hpke-js'

import {
  BROWSER_IMPORT_HPKE_INFO,
  BROWSER_IMPORT_MAX_TTL_MS,
  browserImportAadBytes,
  type BrowserImportAdmission,
  browserImportAdmissionDigest,
  type BrowserImportAuthenticatedData,
  browserImportBundleBytes,
  type BrowserImportEnvelope,
  browserImportHpkeKeyId,
  browserImportSignatureBytes,
  browserImportSitesDigest,
  type BrowserStorageStateBundle,
  parseAdmission,
  parseBundle,
  parseEnvelope
} from './contract'

export interface SealRequest {
  bundle: BrowserStorageStateBundle
  source: BrowserImportAdmission['source']
  /** The signed-in owner's Matrix user id. */
  ownerUserId: string
  /** The primary agent, the one recipient of the no-choice default. */
  agentPrincipal: string
  recipient: {
    computerId: string
    attachmentEpoch: number
    /** The raw X25519 public key, unpadded base64url, as the controller-signed record published it. */
    hpkePublicKey: string
    hpkeKeyId: string
  }
  importId: string
  /** When the owner started the import: the consent record's `approvedAt`, never after `createdAt`. */
  approvedAt: number
  /** When the bundle is sealed; the 15-minute lifetime runs from here. */
  createdAt: number
}

export interface SealedBrowserImport {
  authenticatedData: BrowserImportAuthenticatedData
  admission: BrowserImportAdmission
  admissionDigest: string
  ciphertextDigest: string
  /** The HPKE encapsulated key, unpadded base64url. */
  encapsulatedKey: string
  /** The ciphertext, unpadded base64url. */
  ciphertext: string
  /** What the owner's approval key signs: domain, AAD, admission digest and ciphertext digest. */
  signatureBytes: Uint8Array
  counts: { siteCount: number; skippedSiteCount: number; cookieCount: number }
}

const utf8 = (value: string) => new TextEncoder().encode(value)

/** One suite for the contract: base mode, X25519, HKDF-SHA256, AES-256-GCM. */
const suite = () => new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm })

export async function sealBrowserImport(request: SealRequest): Promise<SealedBrowserImport> {
  const bundle = parseBundle(request.bundle)

  if (browserImportHpkeKeyId(request.recipient.hpkePublicKey) !== request.recipient.hpkeKeyId) {
    throw new TypeError('recipient key id does not hash the recipient key')
  }

  if (request.approvedAt > request.createdAt) {
    throw new TypeError('consent cannot follow sealing')
  }

  const skippedSiteCount = bundle.siteSelections.filter(({ disposition }) => disposition === 'skipped_default').length
  const sitesDigest = browserImportSitesDigest(bundle.siteSelections)
  const selectedAgents = [{ agentPrincipal: request.agentPrincipal, profileIsolation: 'separate' as const }]
  const expiresAt = request.createdAt + BROWSER_IMPORT_MAX_TTL_MS

  const authenticatedData: BrowserImportAuthenticatedData = {
    ownerUserId: request.ownerUserId,
    selectedAgents,
    recipientBasis: 'primary_default',
    computerId: request.recipient.computerId,
    attachmentEpoch: request.recipient.attachmentEpoch,
    sitesDigest,
    siteCount: bundle.siteSelections.length,
    importId: request.importId,
    expiresAt,
    createdAt: request.createdAt,
    hpkeKeyId: request.recipient.hpkeKeyId,
    contentType: 'playwright_storage_state_cookies_only',
    plaintextEncoding: 'RFC8785_JCS_UTF8'
  }

  const admission = parseAdmission({
    importId: request.importId,
    ownerUserId: request.ownerUserId,
    approvedBy: request.ownerUserId,
    approvedAt: request.approvedAt,
    source: request.source,
    sitesDigest,
    siteCount: bundle.siteSelections.length,
    skippedSiteCount,
    selectedAgents,
    recipientBasis: 'primary_default',
    recipient: { computerId: request.recipient.computerId, attachmentEpoch: request.recipient.attachmentEpoch },
    expiresAt,
    consent: 'explicit_owner_approval'
  })

  const aad = browserImportAadBytes(authenticatedData)
  const hpke = suite()
  const cookieCount = bundle.cookies.length
  const siteCount = bundle.siteSelections.length

  const recipientPublicKey = await hpke.kem.deserializePublicKey(
    Buffer.from(request.recipient.hpkePublicKey, 'base64url')
  )

  const plaintext = browserImportBundleBytes(bundle)
  let sealedParts: { ct: ArrayBuffer; enc: ArrayBuffer }

  try {
    sealedParts = await hpke.seal({ recipientPublicKey, info: utf8(BROWSER_IMPORT_HPKE_INFO) }, plaintext, aad)
  } finally {
    plaintext.fill(0)
    // The cookies are sealed; this copy of them has no more work to do.
    bundle.cookies.length = 0
  }

  const { ct, enc } = sealedParts

  const ciphertext = Buffer.from(ct)
  const admissionDigest = browserImportAdmissionDigest(admission)
  const ciphertextDigest = createHash('sha256').update(ciphertext).digest('hex')

  return {
    authenticatedData,
    admission,
    admissionDigest,
    ciphertextDigest,
    encapsulatedKey: Buffer.from(enc).toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    signatureBytes: browserImportSignatureBytes({ authenticatedData, admissionDigest, ciphertextDigest }),
    counts: { siteCount, skippedSiteCount, cookieCount }
  }
}

/** Join the approval signature to the sealed parts; the result is validated against the contract's envelope. */
export function assembleBrowserImportEnvelope(
  sealed: SealedBrowserImport,
  signed: { deviceServiceId: string; approvalKeyId: string; signature: string }
): BrowserImportEnvelope {
  return parseEnvelope({
    authenticatedData: sealed.authenticatedData,
    admissionDigest: sealed.admissionDigest,
    ciphertextDigest: sealed.ciphertextDigest,
    recipient: {
      computerId: sealed.authenticatedData.computerId,
      attachmentEpoch: sealed.authenticatedData.attachmentEpoch
    },
    signer: { deviceServiceId: signed.deviceServiceId, approvalKeyId: signed.approvalKeyId },
    signatureAlgorithm: 'ECDSA_P256_SHA256_P1363',
    signature: signed.signature,
    hpke: {
      mode: 'base',
      info: BROWSER_IMPORT_HPKE_INFO,
      aadEncoding: 'RFC8785_JCS_UTF8',
      kem: 'DHKEM_X25519_HKDF_SHA256',
      kdf: 'HKDF_SHA256',
      aead: 'AES_256_GCM',
      encapsulatedKey: sealed.encapsulatedKey,
      ciphertext: sealed.ciphertext
    },
    relayAccess: 'ciphertext_only'
  })
}
