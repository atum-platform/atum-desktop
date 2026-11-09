/**
 * The one key an import is sealed to: the primary agent's computer, for its current attachment epoch.
 *
 * Everything the import protects rests on this key being the computer's, so the Mac does not take the platform's
 * word for it. The record is fetched through the owner-authenticated read (`browser.import.recipient-key.read`,
 * signed by this Mac's identity key as `owner_client`), and admitted only when
 * - it is signed by a controller key this Mac pinned at enrollment (Ed25519, `device-service/3` signed bytes),
 * - it is for this owner, this computer, this epoch and this agent,
 * - its key id is the SHA-256 of the raw public key,
 * in the contract's own order (`decideBrowserImportRecipientKey`). A refusal is final: nothing is sealed.
 *
 * What fences a key is its attachment epoch, which the Mac reads fresh from the platform just before this read and
 * pins in the request, not the record's own clock. The platform returns the record the controller signed when it
 * published it (a 15 s window, long over by the time a person clicks Import), and the contract's decision has no
 * clock either, so the Mac checks that the lifetime fields are well formed and nothing more.
 */
import { verifyControllerSignature } from '../device/device-key'

import {
  type BrowserImportRecipientKeyReadRequest,
  type BrowserImportRecipientKeyRefusal,
  cloudDeviceSignedBytes,
  decideBrowserImportRecipientKey,
  parseRecipientKeyReadRequest,
  parseRecipientKeyRecordShape,
  SIGNED_MESSAGE_MAX_MS
} from './contract'

/** A controller key the Mac pinned: Ed25519 SPKI, unpadded base64url. */
export interface PinnedControllerKey {
  kid: string
  publicKey: string
}

export interface TrustedRecipient {
  computerId: string
  attachmentEpoch: number
  /** The raw X25519 public key, unpadded base64url. */
  hpkePublicKey: string
  hpkeKeyId: string
}

export type RecipientKeyFailure =
  | BrowserImportRecipientKeyRefusal
  | 'record_malformed'
  | 'wrong_agent'
  | 'identity_signature_failed'

export class RecipientKeyError extends Error {
  constructor(readonly reason: RecipientKeyFailure) {
    super(`browser_import_recipient_key_${reason}`)
    this.name = 'RecipientKeyError'
  }
}

export interface RecipientKeyDeps {
  /** The owner-authenticated read: the platform's answer to the request, untrusted until checked here. */
  read(request: BrowserImportRecipientKeyReadRequest, signal: AbortSignal): Promise<unknown>
  ownerUserId: string
  agentPrincipal: string
  computer: { computerId: string; attachmentEpoch: number }
  /** This Mac's identity key (ES256): signs without a prompt, so a read never costs a Touch ID. */
  identity: { kid: string; sign(bytes: Uint8Array): Promise<{ kid: string; sig: string }> }
  /** The controller keys this Mac pinned at enrollment, active ones only. */
  pinned: readonly PinnedControllerKey[]
  now(): number
  randomId(): string
  /** 32 random bytes, unpadded base64url. */
  randomNonce(): string
}

/** How long the platform has to answer a read. */
export const RECIPIENT_KEY_REQUEST_TTL_MS = 15_000

/** A signed request's `meta.signature` is not part of its signed bytes; this fills the field until it is signed. */
const UNSIGNED = 'A'.repeat(86)

async function readRequest(deps: RecipientKeyDeps): Promise<BrowserImportRecipientKeyReadRequest> {
  const issuedAt = deps.now()

  const unsigned = {
    meta: {
      requestId: deps.randomId(),
      commandId: deps.randomId(),
      signer: 'owner_client',
      signerKeyId: deps.identity.kid,
      // Strictly increasing on one Mac: the millisecond clock, as the replay key also holds the unique commandId and nonce.
      sequence: issuedAt,
      issuedAt,
      expiresAt: issuedAt + RECIPIENT_KEY_REQUEST_TTL_MS,
      nonce: deps.randomNonce(),
      signature: UNSIGNED
    },
    ownerUserId: deps.ownerUserId,
    computerId: deps.computer.computerId,
    attachmentEpoch: deps.computer.attachmentEpoch
  }

  let signed: { kid: string; sig: string }

  try {
    signed = await deps.identity.sign(cloudDeviceSignedBytes('browser.import.recipient-key.read', unsigned))
  } catch {
    throw new RecipientKeyError('identity_signature_failed')
  }

  if (signed.kid !== deps.identity.kid) {
    throw new RecipientKeyError('identity_signature_failed')
  }

  return parseRecipientKeyReadRequest({ ...unsigned, meta: { ...unsigned.meta, signature: signed.sig } })
}

/** Read, check and return the computer's HPKE key; throws {@link RecipientKeyError} for anything it cannot trust. */
export async function readTrustedRecipientKey(deps: RecipientKeyDeps, signal: AbortSignal): Promise<TrustedRecipient> {
  const request = await readRequest(deps)
  const answer = await deps.read(request, signal)

  let record: ReturnType<typeof parseRecipientKeyRecordShape>

  try {
    record = parseRecipientKeyRecordShape(answer)
  } catch {
    throw new RecipientKeyError('record_malformed')
  }

  const pinned = deps.pinned.find(key => key.kid === record.meta.signerKeyId)

  const signatureValid = pinned
    ? verifyControllerSignature(
        pinned.publicKey,
        cloudDeviceSignedBytes('browser.import.recipient-key', record),
        record.meta.signature
      )
    : false

  const decision = decideBrowserImportRecipientKey(request, answer, {
    authenticatedOwnerUserId: deps.ownerUserId,
    ownerUserId: deps.ownerUserId,
    computerId: deps.computer.computerId,
    attachmentEpoch: deps.computer.attachmentEpoch,
    pinnedControllerKeyIds: deps.pinned.map(({ kid }) => kid),
    verifiedSignature: { valid: signatureValid, signerKeyId: record.meta.signerKeyId }
  })

  if (decision.outcome === 'refused') {
    throw new RecipientKeyError(decision.reason)
  }

  // A real answer is for the agent the import is for.
  if (record.binding.agentPrincipal !== deps.agentPrincipal) {
    throw new RecipientKeyError('wrong_agent')
  }

  // The lifetime a controller signs is a window it opened, not one this Mac enforces on a stored record (header).
  const { issuedAt, expiresAt } = record.meta

  if (expiresAt <= issuedAt || expiresAt - issuedAt > SIGNED_MESSAGE_MAX_MS) {
    throw new RecipientKeyError('record_malformed')
  }

  return {
    computerId: record.binding.computerId,
    attachmentEpoch: record.attachmentEpoch,
    hpkePublicKey: decision.hpkePublicKey,
    hpkeKeyId: decision.hpkeKeyId
  }
}
