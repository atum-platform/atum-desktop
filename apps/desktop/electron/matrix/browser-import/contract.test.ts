import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { verifyControllerSignature, verifyDeviceSignature } from '../device/device-key'

import {
  BROWSER_IMPORT_HPKE_INFO,
  BROWSER_IMPORT_MAX_TTL_MS,
  type BrowserCookie,
  browserImportAadBytes,
  browserImportAdmissionDigest,
  browserImportBundleBytes,
  browserImportHpkeKeyId,
  browserImportSignatureBytes,
  browserImportSitesDigest,
  cloudDeviceSignedBytes,
  cookieViolation,
  decideBrowserImportRecipientKey,
  isBrowserCookieDomainAllowed,
  jcsJson,
  parseAdmission,
  parseBundle,
  parseEnvelope,
  parseRecipientKeyReadRequest,
  parseRecipientKeyRecord,
  siteDomain
} from './contract'

// The platform pack's own conformance data (atum.cloud-execution/2.1, atum.device-service/3), copied byte for byte.
const pack = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'contract-v2.1')
const load = (file: string) => JSON.parse(readFileSync(path.join(pack, file), 'utf8')) as any
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

describe('the fixtures are the platform pack’s, unchanged', () => {
  it('matches every file against its recorded SHA-256, with no file unlisted and none missing', () => {
    const listed = readFileSync(path.join(pack, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map(line => line.split(/\s+/u) as [string, string])

    const present = readdirSync(pack).filter(file => file.endsWith('.json'))

    expect(listed.map(([, file]) => file).sort()).toEqual([...present].sort())

    for (const [sum, file] of listed) {
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(pack, file)))
          .digest('hex'),
        file
      ).toBe(sum)
    }
  })
})

describe('known-answer bytes and digests (the contract is the bytes)', () => {
  const vector = load('browser.import.known-answer.json')

  it('reproduces the AAD, signature input, admission digest, sites digest and key id exactly', () => {
    const { inputs, outputs } = vector

    expect(b64u(browserImportAadBytes(inputs.authenticatedData))).toBe(outputs.aadJcsUtf8Base64url)
    expect(browserImportAdmissionDigest(inputs.admission)).toBe(outputs.admissionDigest)
    expect(browserImportSitesDigest(inputs.siteSelections)).toBe(outputs.sitesDigest)
    expect(browserImportHpkeKeyId(inputs.hpkePublicKey)).toBe(outputs.hpkeKeyId)
    expect(b64u(browserImportBundleBytes(inputs.bundle))).toBe(outputs.bundleJcsUtf8Base64url)
    expect(b64u(Buffer.from(jcsJson(inputs.encryptedSites)))).toBe(outputs.encryptedSitesJcsUtf8Base64url)

    const signatureInput = browserImportSignatureBytes({
      authenticatedData: inputs.authenticatedData,
      admissionDigest: outputs.admissionDigest,
      ciphertextDigest: inputs.ciphertextDigest
    })

    expect(b64u(signatureInput)).toBe(outputs.signatureInputBase64url)
  })

  it('frames the signature as domain, AAD, a NUL and the two raw digests', () => {
    const { inputs, outputs } = vector
    const bytes = Buffer.from(b64u(browserImportAadBytes(inputs.authenticatedData)), 'base64url')

    const input = Buffer.from(
      browserImportSignatureBytes({
        authenticatedData: inputs.authenticatedData,
        admissionDigest: outputs.admissionDigest,
        ciphertextDigest: inputs.ciphertextDigest
      })
    )

    const domain = Buffer.from(`${BROWSER_IMPORT_HPKE_INFO}\0`)
    expect(input.subarray(0, domain.length).equals(domain)).toBe(true)
    expect(input.subarray(domain.length, domain.length + bytes.length).equals(bytes)).toBe(true)
    expect(input[domain.length + bytes.length]).toBe(0)
    expect(input.subarray(-64).toString('hex')).toBe(`${outputs.admissionDigest}${inputs.ciphertextDigest}`)
  })

  it('does not depend on property order in the inputs', () => {
    const { inputs, outputs } = vector
    const reversed = Object.fromEntries(Object.entries(inputs.authenticatedData).reverse())

    expect(b64u(browserImportAadBytes(reversed as never))).toBe(outputs.aadJcsUtf8Base64url)
  })
})

describe('the cookies-only bundle', () => {
  it.each([
    'browser.import.bundle.json',
    'browser.import.bundle-leading-dot-github.json',
    'browser.import.bundle-leading-dot-google.json',
    'browser.import.bundle-host-only.json',
    'browser.import.bundle-host-prefix.json'
  ])('accepts %s', file => {
    expect(() => parseBundle(load(file))).not.toThrow()
  })

  it.each([
    'reject-browser.import.bundle-password.json',
    'reject-browser.import.bundle-history.json',
    'reject-browser.import.bundle-localhost.json',
    'reject-browser.import.bundle-ip.json',
    'reject-browser.import.bundle-origins.json',
    'reject-browser.import.bundle-cookie-value-too-large.json',
    'reject-browser.import.bundle-bank-declared-included.json'
  ])('refuses %s', file => {
    expect(() => parseBundle(load(file))).toThrow()
  })

  it('keeps session cookies as expires -1 and never carries origins', () => {
    const bundle = parseBundle(load('browser.import.bundle.json'))

    expect(bundle.cookies.map(({ expires }) => expires)).toContain(-1)
    expect(bundle.origins).toHaveLength(0)
  })
})

describe('which single cookies the contract refuses', () => {
  const cookie = (change: Partial<BrowserCookie> = {}): BrowserCookie => ({
    name: 'sid',
    value: 'v',
    domain: '.example.com',
    path: '/',
    expires: 1_800_000_000,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...change
  })

  it('accepts what Chrome writes: dotted and host-only domains, session cookies, multi-byte values', () => {
    expect(cookieViolation(cookie())).toBeNull()
    expect(cookieViolation(cookie({ domain: 'app.example.com' }))).toBeNull()
    expect(cookieViolation(cookie({ expires: -1 }))).toBeNull()
    expect(cookieViolation(cookie({ value: 'xin chào 🌏' }))).toBeNull()
    expect(cookieViolation(cookie({ name: '__Host-sid', domain: 'app.example.com' }))).toBeNull()
  })

  it.each([
    ['an empty name', { name: '' }, 'name'],
    ['a name over 4,096 characters', { name: 'n'.repeat(4_097) }, 'name'],
    ['a value over 4,096 UTF-8 bytes', { value: 'x'.repeat(4_097) }, 'value_too_large'],
    ['a value over the limit only in bytes', { value: 'é'.repeat(2_049) }, 'value_too_large'],
    ['localhost', { domain: 'localhost' }, 'domain'],
    ['an IPv4 literal', { domain: '127.0.0.1' }, 'domain'],
    ['an IPv6 literal', { domain: '[::1]' }, 'domain'],
    ['an uppercase domain', { domain: '.Example.com' }, 'domain'],
    ['an underscore in the host', { domain: 'a_b.example.com' }, 'domain'],
    ['an empty path', { path: '' }, 'path'],
    ['an expiry before -1', { expires: -2 }, 'expires'],
    ['an expiry past year 9999', { expires: 253_402_300_800 }, 'expires'],
    ['a fractional expiry', { expires: 1.5 }, 'expires'],
    [
      'a __Host- cookie that is not secure',
      { name: '__Host-a', domain: 'app.example.com', secure: false },
      'host_prefix'
    ],
    ['a __Host- cookie off the root path', { name: '__Host-a', domain: 'app.example.com', path: '/x' }, 'host_prefix'],
    ['a __Host- cookie for a whole domain', { name: '__Host-a', domain: '.example.com' }, 'host_prefix']
  ])('refuses %s', (_name, change, reason) => {
    expect(cookieViolation(cookie(change))).toBe(reason)
  })
})

describe('sites are registrable domains', () => {
  it('accepts a registrable domain and refuses a public suffix', () => {
    const valid = load('browser.import-site.google-valid.json')
    const refused = load('browser.import-site.co-uk-refused.json')

    expect(() => siteDomain(valid.site)).not.toThrow()
    expect(() => siteDomain(refused.site)).toThrow()
  })

  it.each(['localhost', '127.0.0.1', 'com', 'Example.com', 'a_b.example.com', '-a.example.com'])('refuses %s', site => {
    expect(() => siteDomain(site)).toThrow()
  })
})

describe('the post-decryption cookie gate', () => {
  it.each([
    'browser.cookie-site-filter.google-subdomain.json',
    'browser.cookie-site-filter.google.json',
    'browser.cookie-site-filter.skipped.json',
    'browser.cookie-site-filter.unselected.json'
  ])('%s', file => {
    const vector = load(file)

    expect(isBrowserCookieDomainAllowed(vector.cookieDomain, vector.verifiedSites)).toBe(vector.allowed)
  })

  it('does not let a look-alike domain through', () => {
    const { verifiedSites } = load('browser.cookie-site-filter.google.json')

    expect(isBrowserCookieDomainAllowed('.evilgoogle.com', verifiedSites)).toBe(false)
    expect(isBrowserCookieDomainAllowed('.google.com.evil.example', verifiedSites)).toBe(false)
  })
})

describe('the envelope and the admission', () => {
  it('binds the admission digest, recipient, epoch and a window the contract allows', () => {
    const envelope = parseEnvelope(load('browser.import.envelope.json'))
    const admission = parseAdmission(load('browser.import.admission.json'))

    expect(envelope.admissionDigest).toBe(browserImportAdmissionDigest(admission))
    expect(envelope.recipient.computerId).toBe(envelope.authenticatedData.computerId)
    expect(envelope.recipient.attachmentEpoch).toBe(envelope.authenticatedData.attachmentEpoch)
    expect(envelope.authenticatedData.expiresAt - envelope.authenticatedData.createdAt).toBe(BROWSER_IMPORT_MAX_TTL_MS)
    expect(envelope.hpke).toMatchObject({ mode: 'base', info: BROWSER_IMPORT_HPKE_INFO })
  })

  it.each([
    'reject-browser.import.envelope-plaintext.json',
    'reject-browser.import.envelope-zero-window.json',
    'reject-browser.import.envelope-long-window.json',
    'reject-browser.import.envelope-wrong-recipient.json',
    'reject-browser.import.envelope-wrong-recipient-epoch.json'
  ])('refuses %s', file => {
    expect(() => parseEnvelope(load(file))).toThrow()
  })

  it('refuses a key the schema does not know, so a field cannot ride along unsigned', () => {
    expect(() => parseEnvelope({ ...load('browser.import.envelope.json'), extra: true })).toThrow(/unknown key/u)
  })

  it('refuses a consent not approved by the owner', () => {
    const admission = load('browser.import.admission.json')

    expect(() => parseAdmission({ ...admission, approvedBy: '@someone:atum.example' })).toThrow()
  })
})

describe('the recipient key', () => {
  it('parses the read request and the controller-signed record', () => {
    expect(() => parseRecipientKeyReadRequest(load('browser.import.recipient-key.read.json'))).not.toThrow()
    expect(() => parseRecipientKeyRecord(load('browser.import.recipient-key.json'))).not.toThrow()
  })

  it.each(['browser.import-recipient-key.accepted.json', 'browser.import-recipient-key.unpinned-refused.json'])(
    'decides %s as the contract does',
    file => {
      const vector = load(file)

      expect(decideBrowserImportRecipientKey(vector.request, vector.record, vector.trusted)).toEqual(vector.expect)
    }
  )

  it('refuses a key id that does not hash the raw public key before anything else about the key', () => {
    const vector = load('browser.import-recipient-key.accepted.json')
    const record = { ...vector.record, hpkeKeyId: 'E'.repeat(43) }

    expect(decideBrowserImportRecipientKey(vector.request, record, vector.trusted)).toEqual({
      outcome: 'refused',
      reason: 'hpke_key_id_mismatch'
    })
  })

  it.each([
    ['an unauthenticated owner', { authenticatedOwnerUserId: null }, 'owner_unauthenticated'],
    ['another owner', { authenticatedOwnerUserId: '@other:atum.example' }, 'wrong_owner'],
    ['another computer', { computerId: '00000000-0000-4000-8000-e8d95748107a' }, 'wrong_computer'],
    ['a stale epoch', { attachmentEpoch: 8 }, 'stale_attachment_epoch'],
    [
      'a forged signature',
      { verifiedSignature: { valid: false, signerKeyId: 'A'.repeat(43) } },
      'forged_controller_signature'
    ]
  ])('refuses %s', (_name, change, reason) => {
    const vector = load('browser.import-recipient-key.accepted.json')

    expect(decideBrowserImportRecipientKey(vector.request, vector.record, { ...vector.trusted, ...change })).toEqual({
      outcome: 'refused',
      reason
    })
  })
})

describe('device-service/3 signed bytes', () => {
  const vectors = load('device-service-v3.signatures.vectors.json').vectors as {
    name: string
    algorithm: 'Ed25519' | 'ECDSA_P256'
    publicKey: string
    message: string
    signedBytesUtf8: string
    signature: string
    valid: boolean
  }[]

  /** The message value the vector's bytes were made from: the canonical body with a signature restored. */
  const valueOf = (vector: (typeof vectors)[number]) => {
    // `domain NUL message NUL body`: the body starts after the second NUL.
    const text = vector.signedBytesUtf8
    const body = JSON.parse(text.slice(text.indexOf('\0', text.indexOf('\0') + 1) + 1))

    return { ...body, meta: { ...body.meta, signature: vector.signature } }
  }

  it.each(vectors.map(vector => [vector.name, vector] as const))(
    'frames %s exactly as the platform does',
    (_name, vector) => {
      expect(Buffer.from(cloudDeviceSignedBytes(vector.message, valueOf(vector))).toString('utf8')).toBe(
        vector.signedBytesUtf8
      )
    }
  )

  it.each(vectors.map(vector => [vector.name, vector] as const))(
    'verifies %s with the Mac verifier',
    (_name, vector) => {
      const bytes = Buffer.from(vector.signedBytesUtf8, 'utf8')

      const valid =
        vector.algorithm === 'Ed25519'
          ? verifyControllerSignature(vector.publicKey, bytes, vector.signature)
          : verifyDeviceSignature(vector.publicKey, bytes, vector.signature)

      expect(valid).toBe(vector.valid)
    }
  )

  it('leaves the signature itself out of what is signed', () => {
    const vector = vectors[0]!

    expect(vector.signedBytesUtf8).not.toContain(vector.signature)
  })
})
