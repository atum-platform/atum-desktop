/**
 * A controller-signed `browser.import.recipient-key` record, built the way the platform's controller would sign it
 * (`device-service/3` signed bytes, Ed25519): for tests of the Mac's trust checks and of the whole import.
 */
import { cloudDeviceSignedBytes } from '../contract'

import type { SoftwareKey } from './software-keys'

export const OWNER = '@owner:atum.example'
export const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
export const COMPUTER = '00000000-0000-4000-8000-b454f82c5857'
export const DEVICE_SERVICE = '00000000-0000-4000-8000-f80f3c5d3a2c'

export interface RecordOptions {
  controller: SoftwareKey
  hpkePublicKey: string
  hpkeKeyId: string
  now: number
  /** The request being answered, so the record echoes its ids. */
  request?: { meta: { requestId: string; commandId: string } }
  binding?: Partial<{ ownerUserId: string; agentPrincipal: string; computerId: string }>
  attachmentEpoch?: number
  meta?: Partial<{ issuedAt: number; expiresAt: number; signerKeyId: string }>
  /** Change the record after it is signed: a tampering. */
  tamper?: (record: Record<string, any>) => void
  /** Add or alter a field before signing. */
  extra?: Record<string, unknown>
}

type SignedRecord = { meta: Record<string, any> & { signature: string } } & Record<string, any>

export function signedRecipientRecord(options: RecordOptions): SignedRecord {
  const issuedAt = options.meta?.issuedAt ?? options.now

  const record: SignedRecord = {
    meta: {
      requestId: options.request?.meta.requestId ?? '00000000-0000-4000-8000-f1d11edf5c5c',
      commandId: options.request?.meta.commandId ?? '00000000-0000-4000-8000-fbfe405ca65f',
      signer: 'platform_controller',
      signerKeyId: options.meta?.signerKeyId ?? options.controller.kid,
      sequence: 12,
      issuedAt,
      expiresAt: options.meta?.expiresAt ?? issuedAt + 15_000,
      nonce: 'C'.repeat(43),
      signature: 'A'.repeat(86)
    },
    binding: { ownerUserId: OWNER, agentPrincipal: AGENT, computerId: COMPUTER, ...options.binding },
    attachmentEpoch: options.attachmentEpoch ?? 7,
    hpkeKeyId: options.hpkeKeyId,
    hpkePublicKey: options.hpkePublicKey,
    kem: 'DHKEM_X25519_HKDF_SHA256',
    publishedAt: issuedAt,
    pinning: 'computer_attachment_epoch',
    ...options.extra
  }

  record.meta.signature = options.controller.sign(cloudDeviceSignedBytes('browser.import.recipient-key', record))
  options.tamper?.(record)

  return record
}
