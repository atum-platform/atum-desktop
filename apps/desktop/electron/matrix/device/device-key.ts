/**
 * The Mac device service's signing primitives (S1 WS-3b; contracts `atum.device-service/1` §3.3 and
 * `atum.cloud-answering/1` §3.2): canonical JSON, the domain-framed signed bytes, the digests, key
 * IDs, signature checks, and the Secure Enclave signer (`native/atum-device-key`).
 *
 * Canonicalization comes from the shared protocol package via canonical.ts.
 *
 * The helper signs a SHA-256 digest; this module frames and hashes every message, so the one
 * canonical implementation decides what a signature covers.
 */
import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'

import { canonicalJson } from "./canonical"
export { canonicalJson }

// ------------------------------------------------------------------ framing, digests, key IDs

export const DEVICE_SERVICE_SIGNING_DOMAIN = 'atum.device-service.v1\0'
export const ORIGIN_SIGNING_DOMAIN = 'atum.origin.v1\0'
/** The key in the owner's message content an origin assertion travels under. */
export const ORIGIN_CONTENT_KEY = 'io.atum.origin'

/** How long a Touch ID sheet waits for the owner (owner decision 2026-10-20, was 60 s): an agent that asks
 * while the owner is away from the Mac finds the sheet still up when they are back, and the call says
 * plainly that nobody was there if they never come. Device-local: an approval record never travels. */
export const DEVICE_APPROVAL_WAIT_MS = 10 * 60_000

export const sha256 = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest()
export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/** A device-service message's signed bytes: `utf8(domain + type + "\0") || utf8(canonicalJson(body))`. */
export function deviceSignedBytes(type: string, body: unknown): Buffer {
  return Buffer.from(`${DEVICE_SERVICE_SIGNING_DOMAIN}${type}\0${canonicalJson(body)}`, 'utf8')
}

/** `helloHash`, `commandHash`, `approvalHash`: unpadded base64url SHA-256 of the signed bytes. */
export function deviceMessageHash(type: string, body: unknown): string {
  return b64u(sha256(deviceSignedBytes(type, body)))
}

/** An origin assertion's signed bytes: the domain, then the canonical assertion without `sig`. */
export function originSignedBytes(assertionWithoutSig: Record<string, unknown>): Buffer {
  return Buffer.from(`${ORIGIN_SIGNING_DOMAIN}${canonicalJson(assertionWithoutSig)}`, 'utf8')
}

/** `assertionHash`: unpadded base64url SHA-256 of the origin signed bytes. */
export function originAssertionHash(assertionWithoutSig: Record<string, unknown>): string {
  return b64u(sha256(originSignedBytes(assertionWithoutSig)))
}

/** Request digest v2 (`dg`, `contentDigest`): the whole content without its top-level
 * `io.atum.origin` key, canonicalized, as unpadded base64url SHA-256. */
export function requestDigestV2(content: Record<string, unknown>): string {
  const { [ORIGIN_CONTENT_KEY]: _origin, ...rest } = content

  return b64u(sha256(canonicalJson(rest)))
}

/** `argsHash`: unpadded base64url SHA-256 of the canonical arguments. */
export function argsHash(args: Record<string, unknown>): string {
  return b64u(sha256(canonicalJson(args)))
}

/** A key ID: unpadded base64url SHA-256 of the SPKI DER. */
export function keyId(spkiDer: Uint8Array): string {
  return b64u(sha256(spkiDer))
}

const B64U = /^[A-Za-z0-9_-]+$/

function publicKeyFrom(spki: string, curve: 'ed25519' | 'p256') {
  if (!B64U.test(spki)) {
    return null
  }

  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' })

    if (curve === 'ed25519') {
      return key.asymmetricKeyType === 'ed25519' ? key : null
    }

    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null
  } catch {
    return null
  }
}

/** A controller signature: Ed25519 (pure), 64 bytes, unpadded base64url. */
export function verifyControllerSignature(spki: string, bytes: Uint8Array, signature: string): boolean {
  const key = publicKeyFrom(spki, 'ed25519')

  if (!key || typeof signature !== 'string' || !B64U.test(signature)) {
    return false
  }

  const raw = Buffer.from(signature, 'base64url')

  try {
    return raw.length === 64 && verify(null, bytes, key, raw)
  } catch {
    return false
  }
}

/** A device signature: ES256 (P-256, SHA-256), IEEE P1363 `r||s`, 64 bytes, unpadded base64url. */
export function verifyDeviceSignature(spki: string, bytes: Uint8Array, signature: string): boolean {
  const key = publicKeyFrom(spki, 'p256')

  if (!key || typeof signature !== 'string' || !B64U.test(signature)) {
    return false
  }

  const raw = Buffer.from(signature, 'base64url')

  try {
    return raw.length === 64 && verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, raw)
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ the Secure Enclave signer

export interface DeviceKeyPublic {
  /** `b64url(sha256(SPKI DER))`, 43 characters. */
  kid: string
  /** The SPKI DER, unpadded base64url (122 characters for P-256). */
  spki: string
}

export interface DevicePublicKeys {
  identity: DeviceKeyPublic
  approval: DeviceKeyPublic
}

export interface DeviceSignature {
  kid: string
  sig: string
}

/** What the rest of the device service signs with. Tests inject a software signer. */
export interface DeviceSigner {
  /** Both keys already kept for this owner, without creating or migrating them. A legacy
   * Secure Enclave pair is still this Mac's identity: callers must reuse it before asking the
   * helper to create the newer silent-enrollment shape. */
  existingKeys?(): Promise<DevicePublicKeys | null>
  /** Both keys, created on first use without prompting. */
  publicKeys(): Promise<DevicePublicKeys>
  /** ES256 over `bytes` with the identity key. Never prompts. */
  signIdentity(bytes: Uint8Array): Promise<DeviceSignature>
  /** ES256 over an `EnrollDevice` frame with the approval key. Never prompts; the native helper
   * accepts this exact protocol frame only, so it cannot be used to approve a protected action. */
  signEnrollment(bytes: Uint8Array): Promise<DeviceSignature>
  /** ES256 over `bytes` with the approval key, after a fresh Touch ID (or macOS password) whose
   * prompt is `reason`: the exact operation, in the owner's language. */
  approve(bytes: Uint8Array, reason: string): Promise<DeviceSignature>
}

export type DeviceKeyFailure =
  | 'unavailable'
  | 'keys_missing'
  | 'approval_denied'
  | 'approval_timeout'
  | 'approval_unavailable'
  | 'failed'

export class DeviceKeyError extends Error {
  /** The helper's own words for why (`sign_identity_failed: …`), closed to a log-safe alphabet and
   * never a key, signature or digest. `message` stays the closed `device_key_<code>`; this is the cause
   * that used to be swallowed (10-12→10-20: 8,197 `device_key_failed` lines named nothing). */
  readonly detail?: string

  constructor(
    readonly code: DeviceKeyFailure,
    detail?: string
  ) {
    super(`device_key_${code}`)
    this.name = 'DeviceKeyError'
    this.detail = detail ? logSafe(detail) : undefined
  }
}

/** Text safe to put in a log line: printable ASCII only, cut at 200 characters. */
function logSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export interface DeviceKeyRunResult {
  status: number | null
  stdout: string
  /** Why the process produced no exit status (`ENOENT`, `killed SIGTERM`, `timed_out`), when it did not. */
  failure?: string
}

export type DeviceKeyRun = (
  binary: string,
  args: string[],
  options: { timeoutMs: number; env: Record<string, string> }
) => Promise<DeviceKeyRunResult>

/** Runs the helper with no inherited environment: it needs none, and nothing leaks into it. */
export const runDeviceKeyHelper: DeviceKeyRun = (binary, args, options) =>
  new Promise(resolve => {
    execFile(
      binary,
      args,
      { env: options.env, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        const status = error ? (typeof error.code === 'number' ? error.code : null) : 0

        const failure =
          error && status === null
            ? error.killed
              ? `killed ${error.signal ?? 'by timeout'}`
              : String(error.code ?? error.name)
            : undefined

        resolve({ status, stdout: typeof stdout === 'string' ? stdout : '', ...(failure ? { failure } : {}) })
      }
    )
  })

const KID = /^[A-Za-z0-9_-]{43}$/
const SPKI_P256 = /^[A-Za-z0-9_-]{122}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

/** The helper's answer: its last stdout line, which is one JSON object. */
function helperOutput(result: DeviceKeyRunResult): Record<string, unknown> | null {
  const line = result.stdout.trim().split('\n').pop()

  try {
    const value = line ? (JSON.parse(line) as unknown) : null

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function publicKey(value: unknown): DeviceKeyPublic | null {
  const row = value as Partial<DeviceKeyPublic> | null

  if (
    !row ||
    typeof row.kid !== 'string' ||
    typeof row.spki !== 'string' ||
    !KID.test(row.kid) ||
    !SPKI_P256.test(row.spki)
  ) {
    return null
  }

  // The kid must be the hash of the key it names: never trust the helper's word for it.
  return keyId(Buffer.from(row.spki, 'base64url')) === row.kid ? { kid: row.kid, spki: row.spki } : null
}

/**
 * The Secure Enclave signer: one helper process per operation (about 20 ms on an M2). Keys live in
 * `keyDir` as device-bound wrapped blobs (mode 0600, directory 0700); agent commands can neither
 * read them nor run the helper (WS-4's Seatbelt profile denies both). Approvals are serialized, so
 * the owner never sees two prompts at once.
 */
export class SecureEnclaveDeviceKeys implements DeviceSigner {
  private cached?: DevicePublicKeys
  private approvals: Promise<unknown> = Promise.resolve()
  private readonly run: DeviceKeyRun
  private readonly approvalMs: number

  constructor(
    private readonly options: {
      /** The helper, or null when this build has none (not macOS, not staged). */
      binary: string | null
      keyDir: string
      run?: DeviceKeyRun
      /** How long the sheet waits for the owner (default {@link DEVICE_APPROVAL_WAIT_MS}); one use. */
      approvalMs?: number
    }
  ) {
    this.run = options.run ?? runDeviceKeyHelper
    this.approvalMs = options.approvalMs ?? DEVICE_APPROVAL_WAIT_MS
  }

  private async call(args: string[], timeoutMs: number, env: Record<string, string> = {}) {
    if (!this.options.binary) {
      throw new DeviceKeyError('unavailable')
    }

    const result = await this.run(this.options.binary, [...args, '--keydir', this.options.keyDir], { timeoutMs, env })

    return { status: result.status, output: helperOutput(result), failure: result.failure }
  }

  /** Why a helper call did not give an answer: its own `error`, else how the process ended. */
  private why(
    call: { status: number | null; output: Record<string, unknown> | null; failure?: string },
    operation: string
  ): string {
    const said = typeof call.output?.error === 'string' ? call.output.error : ''

    return `${operation}: ${said || call.failure || (call.output ? 'bad_answer' : 'no_answer')} (status ${call.status ?? 'none'})`
  }

  async publicKeys(): Promise<DevicePublicKeys> {
    if (this.cached) {
      return this.cached
    }

    const made = await this.call(['create'], 15_000)
    const { status, output } = made
    const identity = publicKey(output?.identity)
    const approval = publicKey(output?.approval)

    if (status !== 0 || output?.ok !== true || !identity || !approval || identity.kid === approval.kid) {
      throw new DeviceKeyError(
        typeof output?.error === 'string' && output.error === 'secure_enclave_unavailable' ? 'unavailable' : 'failed',
        this.why(made, 'create')
      )
    }

    this.cached = { identity, approval }

    return this.cached
  }

  /** The keys already in the key directory, without making any. */
  async existingKeys(): Promise<DevicePublicKeys | null> {
    if (this.cached) {
      return this.cached
    }

    const read = await this.call(['public'], 15_000)
    const { status, output } = read

    if (status !== 0 && output?.error === 'keys_missing') {
      return null
    }

    const identity = publicKey(output?.identity)
    const approval = publicKey(output?.approval)

    if (status !== 0 || output?.ok !== true || !identity || !approval) {
      throw new DeviceKeyError('failed', this.why(read, 'public'))
    }

    this.cached = { identity, approval }

    return this.cached
  }

  async signIdentity(bytes: Uint8Array): Promise<DeviceSignature> {
    const keys = await this.publicKeys()
    const signed = await this.call(['sign-identity', b64u(sha256(bytes))], 15_000)

    return this.checked(signed.status, signed.output, keys.identity, bytes, this.why(signed, 'sign-identity'))
  }

  async signEnrollment(bytes: Uint8Array): Promise<DeviceSignature> {
    const keys = await this.publicKeys()
    const signed = await this.call(['sign-enrollment', b64u(bytes)], 15_000)

    return this.checked(signed.status, signed.output, keys.approval, bytes, this.why(signed, 'sign-enrollment'))
  }

  approve(bytes: Uint8Array, reason: string): Promise<DeviceSignature> {
    const next = this.approvals.then(() => this.approveNow(bytes, reason))
    this.approvals = next.catch(() => undefined)

    return next
  }

  private async approveNow(bytes: Uint8Array, reason: string): Promise<DeviceSignature> {
    const text = reason.trim()

    if (!text || Array.from(text).length > 600) {
      throw new DeviceKeyError('failed')
    }

    const keys = await this.publicKeys()
    const seconds = Math.max(1, Math.round(this.approvalMs / 1000))

    const asked = await this.call(['approve', b64u(sha256(bytes)), text], this.approvalMs + 10_000, {
      ATUM_APPROVE_TIMEOUT: String(seconds)
    })

    const { status, output } = asked

    // Killed by our own deadline: the prompt outlived its window, which is a timeout, not consent.
    if (status === null) {
      throw new DeviceKeyError('approval_timeout')
    }

    if (status === 2 || (status !== 0 && typeof output?.error === 'string' && output.error.startsWith('approval_'))) {
      throw new DeviceKeyError(
        output?.error === 'approval_timeout'
          ? 'approval_timeout'
          : output?.error === 'approval_denied'
            ? 'approval_denied'
            : 'approval_unavailable'
      )
    }

    if (typeof output?.error === 'string' && output.error.startsWith('presence_unavailable')) {
      throw new DeviceKeyError('approval_unavailable')
    }

    return this.checked(status, output, keys.approval, bytes, this.why(asked, 'approve'))
  }

  /** A signature is returned only after it verifies against the key it claims, over these bytes. */
  private checked(
    status: number | null,
    output: Record<string, unknown> | null,
    key: DeviceKeyPublic,
    bytes: Uint8Array,
    cause: string
  ): DeviceSignature {
    if (output?.error === 'keys_missing') {
      this.cached = undefined
      throw new DeviceKeyError('keys_missing')
    }

    if (
      status !== 0 ||
      output?.ok !== true ||
      output.kid !== key.kid ||
      typeof output.sig !== 'string' ||
      !SIG.test(output.sig) ||
      !verifyDeviceSignature(key.spki, bytes, output.sig)
    ) {
      throw new DeviceKeyError('failed', status === 0 && output?.ok === true ? `${cause}; signature did not verify` : cause)
    }

    return { kid: key.kid, sig: output.sig }
  }

  /** Removes both keys: after a revocation they are dead (DA keeps their IDs unique forever). */
  async discard(): Promise<void> {
    const removed = await this.call(['delete'], 15_000)
    this.cached = undefined

    if (removed.status !== 0) {
      throw new DeviceKeyError('failed', this.why(removed, 'delete'))
    }
  }
}
