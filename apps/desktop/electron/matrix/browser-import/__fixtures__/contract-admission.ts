/**
 * TEST SUPPORT, not shipped logic. The cloud's admission decider for a browser-import envelope, ported from
 * `@atum/protocol` 0.7.36 (`decideBrowserImportAdmission`, atum-platform PR #654 commit b849d062). The Mac never
 * runs it: it is here so the tests can hand the envelope the Mac builds to the contract's own decider, under a
 * trusted context, and see it accepted, and so the pack's 20 admission cases prove this port is faithful.
 *
 * TODO(platform #654): delete this file when `@atum/protocol` is consumable and import the decider from there.
 */
import {
  BROWSER_IMPORT_MAX_FUTURE_SKEW_MS,
  type BrowserImportAdmission,
  browserImportAdmissionDigest,
  type BrowserImportAuthenticatedData,
  type BrowserImportEnvelope,
  jcsJson
} from '../contract'

export const BROWSER_IMPORT_DECISIONS = [
  'accepted',
  'tombstoned',
  'erase_pending_offline',
  'replayed_import_id',
  'wrong_owner',
  'wrong_agent',
  'wrong_recipient',
  'wrong_recipient_epoch',
  'stale_attachment_epoch',
  'expired',
  'created_in_future',
  'forged_sender',
  'admission_mismatch',
  'revoked_signer',
  'unknown_signer',
  'consent_revoked',
  'removed_after_seal',
  'sites_digest_mismatch',
  'site_removed_during_load'
] as const

export interface AdmissionContext {
  ownerUserId: string
  allowedAgents: string[]
  primaryAgentPrincipal: string
  computerId: string
  authenticatedAttachmentEpoch: number
  currentAttachmentEpoch: number
  now: number
  admittedAt: number
  importIdSeen: boolean
  eraseState: 'none' | 'pending_offline' | 'complete'
  removedAfter: number | null
  consentRevoked: boolean
  verifiedSignature: {
    valid: boolean
    signerState: 'active' | 'revoked' | 'unknown'
    ownerUserId: string
    deviceServiceId: string
    approvalKeyId: string
  }
}

export type AdmissionDecision =
  | { outcome: 'accepted'; reason: 'current_recipient' }
  | { outcome: 'refused'; reason: Exclude<(typeof BROWSER_IMPORT_DECISIONS)[number], 'accepted'> }

function admissionMatchesAad(admission: BrowserImportAdmission, aad: BrowserImportAuthenticatedData): boolean {
  return (
    admission.importId === aad.importId &&
    admission.ownerUserId === aad.ownerUserId &&
    admission.approvedAt <= aad.createdAt &&
    admission.expiresAt === aad.expiresAt &&
    admission.sitesDigest === aad.sitesDigest &&
    admission.siteCount === aad.siteCount &&
    admission.recipientBasis === aad.recipientBasis &&
    admission.recipient.computerId === aad.computerId &&
    admission.recipient.attachmentEpoch === aad.attachmentEpoch &&
    jcsJson(admission.selectedAgents) === jcsJson(aad.selectedAgents)
  )
}

export function decideBrowserImportAdmission(
  envelope: BrowserImportEnvelope,
  admission: BrowserImportAdmission,
  context: AdmissionContext
): AdmissionDecision {
  const refuse = (reason: Exclude<(typeof BROWSER_IMPORT_DECISIONS)[number], 'accepted'>): AdmissionDecision => ({
    outcome: 'refused',
    reason
  })

  if (context.eraseState === 'complete') {
    return refuse('tombstoned')
  }

  if (context.eraseState === 'pending_offline') {
    return refuse('erase_pending_offline')
  }

  if (envelope.authenticatedData.ownerUserId !== context.ownerUserId) {
    return refuse('wrong_owner')
  }

  if (context.verifiedSignature.signerState === 'revoked') {
    return refuse('revoked_signer')
  }

  if (context.verifiedSignature.signerState === 'unknown') {
    return refuse('unknown_signer')
  }

  if (
    !context.verifiedSignature.valid ||
    context.verifiedSignature.ownerUserId !== context.ownerUserId ||
    context.verifiedSignature.deviceServiceId !== envelope.signer.deviceServiceId ||
    context.verifiedSignature.approvalKeyId !== envelope.signer.approvalKeyId
  ) {
    return refuse('forged_sender')
  }

  if (
    browserImportAdmissionDigest(admission) !== envelope.admissionDigest ||
    !admissionMatchesAad(admission, envelope.authenticatedData)
  ) {
    return refuse('admission_mismatch')
  }

  if (context.importIdSeen) {
    return refuse('replayed_import_id')
  }

  if (context.consentRevoked) {
    return refuse('consent_revoked')
  }

  if (context.removedAfter !== null && context.removedAfter >= context.admittedAt) {
    return refuse('removed_after_seal')
  }

  const agents = envelope.authenticatedData.selectedAgents.map(({ agentPrincipal }) => agentPrincipal)

  if (
    agents.some(agentPrincipal => !context.allowedAgents.includes(agentPrincipal)) ||
    (envelope.authenticatedData.recipientBasis === 'primary_default' &&
      (agents.length !== 1 || agents[0] !== context.primaryAgentPrincipal))
  ) {
    return refuse('wrong_agent')
  }

  if (envelope.recipient.computerId !== context.computerId) {
    return refuse('wrong_recipient')
  }

  if (envelope.recipient.attachmentEpoch !== context.authenticatedAttachmentEpoch) {
    return refuse('wrong_recipient_epoch')
  }

  if (envelope.authenticatedData.attachmentEpoch !== context.currentAttachmentEpoch) {
    return refuse('stale_attachment_epoch')
  }

  if (envelope.authenticatedData.createdAt > context.now + BROWSER_IMPORT_MAX_FUTURE_SKEW_MS) {
    return refuse('created_in_future')
  }

  if (context.now >= envelope.authenticatedData.expiresAt) {
    return refuse('expired')
  }

  return { outcome: 'accepted', reason: 'current_recipient' }
}
