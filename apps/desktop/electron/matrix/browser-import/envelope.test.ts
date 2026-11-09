import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { verifyDeviceSignature } from '../device/device-key'

import {
  type AdmissionContext,
  BROWSER_IMPORT_DECISIONS,
  decideBrowserImportAdmission
} from './__fixtures__/contract-admission'
import { SoftwareDeviceKeys, softwareRecipient } from './__fixtures__/software-keys'
import {
  BROWSER_IMPORT_MAX_COOKIES,
  BROWSER_IMPORT_MAX_TTL_MS,
  type BrowserCookie,
  browserImportAadBytes,
  browserImportBundleBytes,
  browserImportSignatureBytes,
  type BrowserStorageStateBundle,
  parseAdmission,
  parseEnvelope
} from './contract'
import { assembleBrowserImportEnvelope, sealBrowserImport, type SealRequest } from './envelope'

const pack = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'contract-v2.1')
const load = (file: string) => JSON.parse(readFileSync(path.join(pack, file), 'utf8')) as any

const OWNER = '@owner:atum.example'
const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const COMPUTER = '00000000-0000-4000-8000-b454f82c5857'
const DEVICE = '00000000-0000-4000-8000-f80f3c5d3a2c'
const IMPORT_ID = '00000000-0000-4000-8000-cd2a20671fb6'
const CREATED = 1_800_000_000_000

const cookie = (domain: string, name: string, value = `${name}-value`): BrowserCookie => ({
  name,
  value,
  domain,
  path: '/',
  expires: 1_900_000_000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax'
})

function sampleBundle(extra: BrowserCookie[] = []): BrowserStorageStateBundle {
  return {
    siteSelections: [
      { domain: 'chase.com', category: 'banking', disposition: 'skipped_default', ownerOverride: false },
      { domain: 'github.com', category: 'standard', disposition: 'included', ownerOverride: false },
      { domain: 'google.com', category: 'standard', disposition: 'included', ownerOverride: false }
    ],
    cookies: [
      cookie('.github.com', 'session_id'),
      cookie('.github.com', 'theme'),
      cookie('.google.com', 'SID'),
      ...extra
    ],
    origins: []
  }
}

async function request(change: Partial<SealRequest> = {}) {
  const recipient = await softwareRecipient()

  const base: SealRequest = {
    bundle: sampleBundle(),
    source: { browser: 'chrome', profileOrdinal: 1 },
    ownerUserId: OWNER,
    agentPrincipal: AGENT,
    recipient: {
      computerId: COMPUTER,
      attachmentEpoch: 7,
      hpkePublicKey: recipient.hpkePublicKey,
      hpkeKeyId: recipient.hpkeKeyId
    },
    importId: IMPORT_ID,
    approvedAt: CREATED - 5_000,
    createdAt: CREATED,
    ...change
  }

  return { base, recipient }
}

describe('sealing a bundle to the primary agent', () => {
  it('seals so only the computer opens it, with the authenticated data as AAD', async () => {
    const { base, recipient } = await request()
    const sealed = await sealBrowserImport(base)

    const plaintext = await recipient.open({
      encapsulatedKey: sealed.encapsulatedKey,
      ciphertext: sealed.ciphertext,
      aad: browserImportAadBytes(sealed.authenticatedData)
    })

    // The plaintext is the contract's RFC 8785 JCS bundle, byte for byte.
    expect(Buffer.from(plaintext).equals(Buffer.from(browserImportBundleBytes(base.bundle)))).toBe(true)
    expect(JSON.parse(Buffer.from(plaintext).toString('utf8'))).toEqual(base.bundle)
  })

  it('does not leak a cookie value, a site or a domain into anything but the ciphertext', async () => {
    const { base } = await request({
      bundle: sampleBundle([cookie('.github.com', 'token', 'super-secret-token-value')])
    })

    const sealed = await sealBrowserImport(base)
    const visible = JSON.stringify({ ...sealed, signatureBytes: undefined, ciphertext: undefined })

    for (const secret of ['super-secret-token-value', 'session_id', 'github.com', 'google.com', 'chase.com']) {
      expect(visible).not.toContain(secret)
    }

    expect(Buffer.from(sealed.ciphertext, 'base64url').includes(Buffer.from('super-secret-token-value'))).toBe(false)
  })

  it('refuses to open under other AAD, other info, or another key: every bound field is authenticated', async () => {
    const { base, recipient } = await request()
    const sealed = await sealBrowserImport(base)

    const open = (aad: Uint8Array, info?: string) =>
      recipient.open({ encapsulatedKey: sealed.encapsulatedKey, ciphertext: sealed.ciphertext, aad, info })

    await expect(open(browserImportAadBytes({ ...sealed.authenticatedData, createdAt: CREATED + 1 }))).rejects.toThrow()
    await expect(open(browserImportAadBytes({ ...sealed.authenticatedData, attachmentEpoch: 8 }))).rejects.toThrow()
    await expect(
      open(browserImportAadBytes({ ...sealed.authenticatedData, importId: '00000000-0000-4000-8000-e8d95748107a' }))
    ).rejects.toThrow()
    await expect(open(browserImportAadBytes(sealed.authenticatedData), 'atum.browser-import/v2')).rejects.toThrow()
    await expect(open(browserImportAadBytes(sealed.authenticatedData))).resolves.toBeDefined()

    const other = await softwareRecipient()

    await expect(
      other.open({
        encapsulatedKey: sealed.encapsulatedKey,
        ciphertext: sealed.ciphertext,
        aad: browserImportAadBytes(sealed.authenticatedData)
      })
    ).rejects.toThrow()
  })

  it('makes a new ciphertext every time (an ephemeral key) with the same bound facts', async () => {
    const { base } = await request()
    const first = await sealBrowserImport(base)
    const second = await sealBrowserImport(base)

    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.encapsulatedKey).not.toBe(second.encapsulatedKey)
    expect(first.admissionDigest).toBe(second.admissionDigest)
    expect(first.authenticatedData).toEqual(second.authenticatedData)
  })

  it('counts sites and cookies without ever exposing a name', async () => {
    const { base } = await request()
    const sealed = await sealBrowserImport(base)

    expect(sealed.counts).toEqual({ siteCount: 3, skippedSiteCount: 1, cookieCount: 3 })
  })

  it('gives the consent record the facts the authenticated data binds, and a window the contract allows', async () => {
    const { base } = await request()
    const { admission, authenticatedData } = await sealBrowserImport(base)

    expect(admission).toMatchObject({
      importId: authenticatedData.importId,
      ownerUserId: OWNER,
      approvedBy: OWNER,
      recipientBasis: 'primary_default',
      recipient: { computerId: COMPUTER, attachmentEpoch: 7 },
      siteCount: 3,
      skippedSiteCount: 1,
      source: { browser: 'chrome', profileOrdinal: 1 },
      consent: 'explicit_owner_approval',
      selectedAgents: [{ agentPrincipal: AGENT, profileIsolation: 'separate' }]
    })
    expect(admission.sitesDigest).toBe(authenticatedData.sitesDigest)
    expect(admission.expiresAt).toBe(authenticatedData.expiresAt)
    expect(authenticatedData.expiresAt - authenticatedData.createdAt).toBe(BROWSER_IMPORT_MAX_TTL_MS)
    expect(admission.approvedAt).toBeLessThanOrEqual(authenticatedData.createdAt)
    expect(() => parseAdmission(admission)).not.toThrow()
  })

  it('refuses what it must not seal', async () => {
    const { base } = await request()

    await expect(
      sealBrowserImport({ ...base, recipient: { ...base.recipient, hpkeKeyId: 'E'.repeat(43) } })
    ).rejects.toThrow(/key id/u)
    await expect(sealBrowserImport({ ...base, approvedAt: CREATED + 1 })).rejects.toThrow(/consent/u)
    await expect(sealBrowserImport({ ...base, bundle: { ...base.bundle, origins: [{}] as never } })).rejects.toThrow()
    await expect(
      sealBrowserImport({ ...base, bundle: { ...base.bundle, cookies: [{ ...cookie('localhost', 'x') }] } })
    ).rejects.toThrow()
    await expect(sealBrowserImport({ ...base, source: { browser: 'chrome', profileOrdinal: 0 } })).rejects.toThrow()
  })

  it('seals a profile at the cookie ceiling', async () => {
    const many = Array.from({ length: BROWSER_IMPORT_MAX_COOKIES }, (_, index) =>
      cookie('.github.com', `c${index}`, 'v'.repeat(64))
    )

    const { base } = await request({ bundle: { ...sampleBundle(), cookies: many } })
    const sealed = await sealBrowserImport(base)

    expect(sealed.counts.cookieCount).toBe(BROWSER_IMPORT_MAX_COOKIES)
    expect(() =>
      parseEnvelope(
        assembleBrowserImportEnvelope(sealed, {
          deviceServiceId: DEVICE,
          approvalKeyId: 'A'.repeat(43),
          signature: 'B'.repeat(86)
        })
      )
    ).not.toThrow()
  })
})

describe('signing and assembling', () => {
  async function signed() {
    const keys = new SoftwareDeviceKeys()
    const { base, recipient } = await request()
    const sealed = await sealBrowserImport(base)
    const { kid, sig } = await keys.approve(sealed.signatureBytes, 'reason')

    const envelope = assembleBrowserImportEnvelope(sealed, {
      deviceServiceId: DEVICE,
      approvalKeyId: kid,
      signature: sig
    })

    return { keys, base, recipient, sealed, envelope }
  }

  it('signs the contract signature input: domain, AAD, admission digest, ciphertext digest', async () => {
    const { sealed, envelope } = await signed()

    expect(Buffer.from(sealed.signatureBytes).equals(Buffer.from(browserImportSignatureBytes(envelope)))).toBe(true)
  })

  it('verifies as ES256 P1363 under the approval key and under no other', async () => {
    const { keys, sealed, envelope } = await signed()

    expect(envelope.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u)
    expect(verifyDeviceSignature(keys.approval.spki, sealed.signatureBytes, envelope.signature)).toBe(true)
    expect(verifyDeviceSignature(keys.identity.spki, sealed.signatureBytes, envelope.signature)).toBe(false)
    expect(verifyDeviceSignature(keys.approval.spki, Buffer.from('other bytes'), envelope.signature)).toBe(false)
  })

  it('assembles an envelope the contract accepts, bound to the owner device and the computer epoch', async () => {
    const { envelope, keys } = await signed()

    expect(envelope).toMatchObject({
      signer: { deviceServiceId: DEVICE, approvalKeyId: keys.approval.kid },
      recipient: { computerId: COMPUTER, attachmentEpoch: 7 },
      signatureAlgorithm: 'ECDSA_P256_SHA256_P1363',
      relayAccess: 'ciphertext_only',
      hpke: { mode: 'base', info: 'atum.browser-import/v1', aadEncoding: 'RFC8785_JCS_UTF8' }
    })
  })

  it('is admitted by the contract decider under a trusted context, and refused when the context says otherwise', async () => {
    const { envelope, sealed, keys } = await signed()

    const trusted: AdmissionContext = {
      ownerUserId: OWNER,
      allowedAgents: [AGENT],
      primaryAgentPrincipal: AGENT,
      computerId: COMPUTER,
      authenticatedAttachmentEpoch: 7,
      currentAttachmentEpoch: 7,
      now: CREATED + 10_000,
      admittedAt: CREATED + 10_000,
      importIdSeen: false,
      eraseState: 'none',
      removedAfter: null,
      consentRevoked: false,
      verifiedSignature: {
        valid: verifyDeviceSignature(keys.approval.spki, sealed.signatureBytes, envelope.signature),
        signerState: 'active',
        ownerUserId: OWNER,
        deviceServiceId: DEVICE,
        approvalKeyId: keys.approval.kid
      }
    }

    expect(decideBrowserImportAdmission(envelope, sealed.admission, trusted)).toEqual({
      outcome: 'accepted',
      reason: 'current_recipient'
    })
    expect(decideBrowserImportAdmission(envelope, sealed.admission, { ...trusted, importIdSeen: true })).toMatchObject({
      reason: 'replayed_import_id'
    })
    expect(
      decideBrowserImportAdmission(envelope, sealed.admission, { ...trusted, currentAttachmentEpoch: 8 })
    ).toMatchObject({ reason: 'stale_attachment_epoch' })
    expect(
      decideBrowserImportAdmission(envelope, sealed.admission, { ...trusted, now: CREATED + BROWSER_IMPORT_MAX_TTL_MS })
    ).toMatchObject({ reason: 'expired' })
    expect(
      decideBrowserImportAdmission(envelope, sealed.admission, {
        ...trusted,
        primaryAgentPrincipal: '00000000-0000-4000-8000-f6222a1106ee'
      })
    ).toMatchObject({ reason: 'wrong_agent' })

    const tampered = { ...sealed.admission, siteCount: 2, skippedSiteCount: 0 }

    expect(decideBrowserImportAdmission(envelope, tampered, trusted)).toMatchObject({ reason: 'admission_mismatch' })
  })
})

describe('the decider port is the contract decider', () => {
  const contractCases = [
    'browser.import-admission.accepted.json',
    'browser.import-admission.admission-mismatch-refused.json',
    'browser.import-admission.consent-revoked-refused.json',
    'browser.import-admission.created-in-future-refused.json',
    'browser.import-admission.expired-refused.json',
    'browser.import-admission.foreign-owner-signer-refused.json',
    'browser.import-admission.forged-sender-refused.json',
    'browser.import-admission.fresh-consent-after-removal.json',
    'browser.import-admission.mac-clock-fast-refused.json',
    'browser.import-admission.pending-offline-refused.json',
    'browser.import-admission.removed-after-seal-refused.json',
    'browser.import-admission.replay-refused.json',
    'browser.import-admission.revoked-signer-refused.json',
    'browser.import-admission.stale-attachment-epoch-refused.json',
    'browser.import-admission.tombstoned-refused.json',
    'browser.import-admission.unknown-signer-refused.json',
    'browser.import-admission.wrong-agent-refused.json',
    'browser.import-admission.wrong-owner-refused.json',
    'browser.import-admission.wrong-recipient-epoch-refused.json',
    'browser.import-admission.wrong-recipient-refused.json'
  ]

  it('covers all twenty admission cases of the pack', () => {
    expect(contractCases).toHaveLength(20)
    expect(BROWSER_IMPORT_DECISIONS).toContain('wrong_recipient_epoch')
  })

  it.each(contractCases)('%s', file => {
    const vector = load(file)
    const envelope = parseEnvelope(vector.envelope)
    const admission = parseAdmission(vector.admission)

    expect(decideBrowserImportAdmission(envelope, admission, vector.trusted)).toEqual(vector.expect)
  })
})
