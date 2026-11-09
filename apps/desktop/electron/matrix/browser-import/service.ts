/**
 * Import browser logins, end to end, in main: one button in Settings, one Touch ID, no choices.
 *
 * The flow, and why it is in this order:
 * 1. Read Chrome's host list. No Keychain, nothing decrypted; if there is nothing to import the person is never asked.
 * 2. Ask the platform where the primary agent's computer is. If it has none, stop before any prompt.
 * 3. Read Chrome's cookies for the chosen sites. This is where macOS may show its Keychain dialog, once.
 * 4. Read the computer's HPKE key fresh, through the owner-authenticated read, and check it against the controller
 *    keys this Mac pinned. Doing it here, not earlier, keeps the attachment epoch the sealed bundle is bound to current.
 * 5. Seal the bundle to that key. The signature must cover the ciphertext, so sealing comes before approval.
 * 6. One Touch ID: the Secure Enclave approval key signs the exact bytes that will leave this Mac.
 * 7. Hand the envelope to the platform, which holds ciphertext only.
 *
 * Nothing leaves the Mac before step 7, and step 7 needs the signature of step 6, so declining the Touch ID (or
 * walking away from it) discards everything. The renderer supplies no input: the browser, profile, sites and agent
 * are all decided here, so the page cannot widen or redirect an import.
 *
 * No cookie value, key or site name is logged or returned; results and log lines carry counts and closed words.
 */
import { randomBytes, randomUUID } from 'node:crypto'

import {
  DEFAULT_DESKTOP_LOCALE,
  type DesktopLocale,
  desktopLocaleFor,
  isDesktopLocale
} from '../../../shared/desktop-locale'
import type {
  MatrixBrowserImportLast,
  MatrixBrowserImportOutcome,
  MatrixBrowserImportReason,
  MatrixBrowserImportStatus
} from '../../../shared/matrix-browser-import'
import { matrixBrowserImportCopy } from '../../../shared/matrix-browser-import-copy'
import { approvalFailure, type ApprovalSigner } from '../device/approvals'
import { type DeviceSignature, verifyDeviceSignature } from '../device/device-key'
import { DeviceEnrollmentError } from '../device/enrollment'
import type { ApprovalKeyRef } from '../device/grants-store'

import {
  chooseChromeProfile,
  type ChromeEnv,
  ChromeImportError,
  discoverChromeProfiles,
  listCookieHosts,
  readChromeCookies
} from './chrome-cookies'
import { BrowserImportHttpError, type BrowserImportTransport } from './client'
import { type BrowserStorageStateBundle, isBrowserCookieDomainAllowed } from './contract'
import { assembleBrowserImportEnvelope, sealBrowserImport } from './envelope'
import type { LastImportStore } from './last-import'
import { type PinnedControllerKey, readTrustedRecipientKey, RecipientKeyError } from './recipient-key'
import { pruneSelections, selectSites } from './sites'

/** This Mac's enrolled device as an import uses it: its keys and the controller keys it pinned. */
export interface BrowserImportDevice {
  /** The owner this device service is bound to. */
  userId: string
  deviceServiceId: string
  /** The Secure Enclave keys: the identity key signs silently, the approval key asks for a Touch ID. */
  signer: ApprovalSigner & { signIdentity(bytes: Uint8Array): Promise<DeviceSignature> }
  approvalKey: ApprovalKeyRef
  /** The identity key's id, which the owner-client read is signed under. */
  identityKid: string
  controllerKeys: readonly PinnedControllerKey[]
}

export interface BrowserImportDeps {
  chrome: ChromeEnv
  transport: BrowserImportTransport
  /** The signed-in owner's Matrix user id, or null. */
  owner(): string | null
  /** The owner's primary agent (the platform's default role), or null until the roster has said. */
  primaryAgent(): { principal: string; name?: string } | null
  /** This Mac's enrolled device, or null while automatic enrollment is reconnecting. */
  device(): BrowserImportDevice | null
  /** Finish automatic enrollment first: the cloud verifies the import with the enrolled approval key. */
  ensureEnrolled(signal: AbortSignal): Promise<void>
  locale(): string | undefined
  /** Pause the device runtime's GUI broker while the approval is up, as every other Touch ID does. */
  setPaused?(paused: boolean): void
  store: LastImportStore
  now?(): number
  randomId?(): string
  /** Closed words and counts only. */
  log(line: string): void
}

/** The name on the sheet and nowhere longer than a person can read there. */
const MAX_AGENT_NAME = 40

const copyLocale = (locale: string | undefined): DesktopLocale =>
  isDesktopLocale(locale) ? locale : (desktopLocaleFor([locale ?? '']) ?? DEFAULT_DESKTOP_LOCALE)

class Declined extends Error {}

class Unavailable extends Error {
  constructor(readonly reason: MatrixBrowserImportReason) {
    super(`browser_import_${reason}`)
  }
}

export class BrowserImportService {
  private running = false

  constructor(private readonly deps: BrowserImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async status(): Promise<MatrixBrowserImportStatus> {
    const owner = this.deps.owner()

    if (!owner || this.deps.chrome.platform !== 'darwin') {
      return { state: 'unavailable' }
    }

    const last = this.deps.store.read(owner)

    // A Mac that is not yet enrolled asks for one extra confirmation on its first import: the panel says so first.
    return {
      state: this.running ? 'running' : 'ready',
      ...(this.deps.device() ? {} : { firstImport: true }),
      ...(last ? { last } : {})
    }
  }

  async run(): Promise<MatrixBrowserImportOutcome> {
    if (this.running) {
      return { outcome: 'unavailable', reason: 'busy' }
    }

    this.running = true

    try {
      const last = await this.import(new AbortController().signal)
      this.deps.log(`[BrowserImport] imported sites=${last.siteCount} skipped=${last.skippedSiteCount}`)

      return { outcome: 'imported', ...last }
    } catch (error) {
      return this.outcome(error)
    } finally {
      this.running = false
    }
  }

  /** The closed result of a failure: never the error's own words, which could carry a path or a platform message. */
  private outcome(error: unknown): MatrixBrowserImportOutcome {
    if (error instanceof Declined) {
      this.deps.log('[BrowserImport] declined')

      return { outcome: 'declined' }
    }

    const reason = reasonOf(error)
    this.deps.log(
      `[BrowserImport] ${reason}${error instanceof Error && 'code' in error ? ` (${String((error as { code: unknown }).code)})` : ''}`
    )

    return { outcome: 'unavailable', reason }
  }

  private async import(signal: AbortSignal): Promise<MatrixBrowserImportLast> {
    const startedAt = this.now()
    const { chrome, transport } = this.deps
    const owner = this.deps.owner()

    if (!owner) {
      throw new Unavailable('signed_out')
    }

    if (chrome.platform !== 'darwin') {
      throw new Unavailable('unsupported')
    }

    const agent = this.deps.primaryAgent()

    if (!agent) {
      throw new Unavailable('failed')
    }

    // 1. What Chrome has: host names only.
    const profile = chooseChromeProfile(discoverChromeProfiles(chrome))

    if (!profile) {
      throw new Unavailable('chrome_not_found')
    }

    const selection = selectSites(listCookieHosts(profile, chrome))

    if (selection.verified.includedSites.length === 0) {
      throw new Unavailable('nothing_to_import')
    }

    // 2. Somewhere to send it, before anything is asked of the person.
    if (!(await transport.primaryComputer(agent.principal, signal))) {
      throw new Unavailable('no_computer')
    }

    // The cloud verifies the approval signature with this Mac's enrolled key, so the Mac must be enrolled.
    if (!this.deps.device()) {
      await this.deps.ensureEnrolled(signal).catch(error => {
        throw enrollmentFailure(error)
      })
    }

    const device = this.deps.device()

    if (!device) {
      throw new Unavailable('unsupported')
    }

    // 3. Chrome's cookies for the chosen sites (the macOS Keychain dialog may appear here).
    const read = await readChromeCookies(profile, chrome, host =>
      isBrowserCookieDomainAllowed(host, selection.verified)
    )

    if (read.cookies.length === 0) {
      throw new Unavailable(
        (read.dropped.decrypt ?? 0) + (read.dropped.domain_mismatch ?? 0) > 0 ? 'failed' : 'nothing_to_import'
      )
    }

    const bundle: BrowserStorageStateBundle = {
      siteSelections: pruneSelections(
        selection.selections,
        read.cookies.map(({ domain }) => domain)
      ),
      cookies: read.cookies,
      origins: []
    }

    const siteCount = bundle.siteSelections.filter(({ disposition }) => disposition !== 'skipped_default').length

    // Steps 4 and 5 are the only ones that need the cookies; whatever happens in them, the arrays are emptied after.
    let sealed: Awaited<ReturnType<typeof sealBrowserImport>>

    try {
      // 4. The computer's key, fresh, and trusted only if the controller this Mac pinned signed it.
      this.live(owner, device)
      const computer = await transport.primaryComputer(agent.principal, signal)

      if (!computer) {
        throw new Unavailable('no_computer')
      }

      const recipient = await readTrustedRecipientKey(
        {
          read: (request, readSignal) => transport.readRecipientKey(agent.principal, request, readSignal),
          ownerUserId: owner,
          agentPrincipal: agent.principal,
          computer,
          identity: {
            kid: device.identityKid,
            sign: bytes => device.signer.signIdentity(bytes)
          },
          pinned: device.controllerKeys,
          now: () => this.now(),
          randomId: () => this.deps.randomId?.() ?? randomUUID(),
          randomNonce: () => randomBytes(32).toString('base64url')
        },
        signal
      )

      // 5. Seal, so that one signature can cover the exact ciphertext.
      sealed = await sealBrowserImport({
        bundle,
        source: { browser: 'chrome', profileOrdinal: profile.ordinal },
        ownerUserId: owner,
        agentPrincipal: agent.principal,
        recipient,
        importId: this.deps.randomId?.() ?? randomUUID(),
        approvedAt: startedAt,
        createdAt: this.now()
      })
    } finally {
      // Best effort (the values were strings): drop every reference to the cookies this scope holds.
      read.cookies.length = 0
      bundle.cookies.length = 0
    }

    // 6. One Touch ID over the bytes that will leave this Mac.
    this.live(owner, device)
    const signature = await this.approve(device, sealed.signatureBytes, agent.name, siteCount)
    this.live(owner, device)

    const envelope = assembleBrowserImportEnvelope(sealed, {
      deviceServiceId: device.deviceServiceId,
      approvalKeyId: device.approvalKey.kid,
      signature
    })

    // 7. The platform holds ciphertext for the computer.
    await transport.admit(agent.principal, { envelope, admission: sealed.admission }, signal)

    const last: MatrixBrowserImportLast = {
      siteCount,
      skippedSiteCount: sealed.counts.skippedSiteCount,
      agentPrincipal: agent.principal,
      at: this.now()
    }

    // The import is done and the cloud has it; remembering it for Settings is best effort.
    try {
      this.deps.store.write(owner, last)
    } catch {
      this.deps.log('[BrowserImport] last_not_saved')
    }

    return last
  }

  /** Every asynchronous continuation re-checks that the account and the device are still the ones this began with. */
  private live(owner: string, device: BrowserImportDevice): void {
    const current = this.deps.device()

    if (
      this.deps.owner() !== owner ||
      !current ||
      current.userId !== owner ||
      current.deviceServiceId !== device.deviceServiceId
    ) {
      throw new Unavailable('signed_out')
    }
  }

  private async approve(
    device: BrowserImportDevice,
    bytes: Uint8Array,
    agentName: string | undefined,
    sites: number
  ): Promise<string> {
    const words = matrixBrowserImportCopy[copyLocale(this.deps.locale())]

    const reason = words.approvalReason(
      Array.from(agentName?.trim() || 'Atum')
        .slice(0, MAX_AGENT_NAME)
        .join(''),
      sites
    )

    let signed: DeviceSignature

    this.deps.setPaused?.(true)

    try {
      signed = await device.signer.approve(bytes, reason)
    } catch (error) {
      // The closed answers of the device key: a refusal or silence is "declined"; anything else is a failure.
      const failure = approvalFailure(error)

      if (failure === 'unavailable') {
        throw new Unavailable('approval_unavailable')
      }

      throw new Declined()
    } finally {
      this.deps.setPaused?.(false)
    }

    // Self-check, as every approval does: the signature must verify under the enrolled approval key, over these bytes.
    if (signed.kid !== device.approvalKey.kid || !verifyDeviceSignature(device.approvalKey.spki, bytes, signed.sig)) {
      throw new Unavailable('failed')
    }

    return signed.sig
  }
}

/** Enrolling this Mac asks for its own Touch ID: saying no to it is saying no to the import. */
function enrollmentFailure(error: unknown): unknown {
  const code = error instanceof DeviceEnrollmentError ? error.code : error instanceof Error ? error.message : ''

  if (code === 'approval_denied' || code === 'approval_timeout') {
    return new Declined()
  }

  if (code === 'approval_unavailable' || code === 'keys_unavailable') {
    return new Unavailable('approval_unavailable')
  }

  return code === 'device_unavailable' ? new Unavailable('unsupported') : error
}

/** Map any failure to one closed reason. */
export function reasonOf(error: unknown): MatrixBrowserImportReason {
  if (error instanceof Unavailable) {
    return error.reason
  }

  if (error instanceof ChromeImportError) {
    switch (error.code) {
      case 'unsupported_platform':
        return 'unsupported'

      case 'chrome_not_found':
        return 'chrome_not_found'

      case 'keychain_denied':

      case 'keychain_timeout':

      case 'keychain_not_found':

      case 'keychain_error':
        return 'keychain_denied'

      default:
        return 'failed'
    }
  }

  if (error instanceof RecipientKeyError) {
    return 'key_untrusted'
  }

  if (error instanceof BrowserImportHttpError) {
    if (error.status === 0) {
      return 'offline'
    }

    if (error.status === 404) {
      return 'no_computer'
    }

    return error.status >= 400 && error.status < 500 ? 'refused' : 'failed'
  }

  const message = error instanceof Error ? error.message : ''

  return /^matrix_(domain_connection_required|s1_authentication|s1_cancelled)$/u.test(message) ? 'signed_out' : 'failed'
}
