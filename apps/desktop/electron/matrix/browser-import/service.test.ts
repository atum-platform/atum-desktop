import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixBrowserImportReason } from '../../../shared/matrix-browser-import'
import { DeviceKeyError, verifyDeviceSignature } from '../device/device-key'
import { DeviceEnrollmentError } from '../device/enrollment'

import {
  chromeEnv,
  chromeFixture,
  fakeSecurity,
  type FixtureCookie,
  NOW,
  standardCookies,
  TEST_PASSWORD
} from './__fixtures__/chrome-fixture'
import { decideBrowserImportAdmission } from './__fixtures__/contract-admission'
import { AGENT, COMPUTER, DEVICE_SERVICE, OWNER, signedRecipientRecord } from './__fixtures__/recipient-record'
import { SoftwareDeviceKeys, softwareEd25519, softwareRecipient } from './__fixtures__/software-keys'
import { ChromeImportError, type SecurityRunner } from './chrome-cookies'
import { BrowserImportHttpError, type BrowserImportTransport } from './client'
import {
  browserImportAadBytes,
  type BrowserImportAdmission,
  type BrowserImportEnvelope,
  type BrowserStorageStateBundle,
  parseEnvelope
} from './contract'
import type * as EnvelopeModule from './envelope'
import { sealBrowserImport } from './envelope'
import type { LastImportStore } from './last-import'
import { RecipientKeyError } from './recipient-key'
import { type BrowserImportDevice, BrowserImportService, reasonOf } from './service'

// The real sealer, watched: what the service hands it is what the zeroization tests inspect afterwards.
vi.mock('./envelope', async importOriginal => {
  const actual = await importOriginal<typeof EnvelopeModule>()

  return { ...actual, sealBrowserImport: vi.fn(actual.sealBrowserImport) }
})

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const SECRETS = [
  // cookie values from the fixture, including those of skipped sites
  'abc123',
  'token-xyz',
  'google-nid-value',
  'google-sid-value',
  'hello-world',
  'session-value',
  'mixed-good',
  'host-only-value',
  'host-prefix-value',
  'unspecified',
  'unpartitioned-twin',
  'bank-secret',
  'bank-secret-2',
  'wallet-secret',
  'vault-secret',
  TEST_PASSWORD,
  // the sites a person visits
  'github.com',
  'google.com',
  'chase.com',
  'vietcombank',
  'momo.vn',
  'bitwarden',
  'example.org'
]

interface Options {
  cookies?: FixtureCookie[]
  noChrome?: boolean
  computer?: { computerId: string; attachmentEpoch: number } | null
  record?: Partial<Parameters<typeof signedRecipientRecord>[0]>
  /** Called while the Touch ID is up, before it answers. */
  onApprove?: () => void | Promise<void>
  admit?: () => Promise<{ importId: string }> | never
  keychain?: SecurityRunner
  enrolled?: boolean
  enrollment?: 'works' | 'fails'
  /** Enrolling throws this (the person said no, or this build cannot). */
  enrollmentError?: Error
  platform?: NodeJS.Platform
  locale?: string
  agentName?: string | null
  primaryAgent?: boolean
  /** Remembering the result fails (a full disk). */
  storeFails?: boolean
}

async function harness(options: Options = {}) {
  const fixture = chromeFixture(
    options.noChrome ? [] : [{ dir: 'Default', cookies: options.cookies ?? standardCookies() }],
    {
      lastUsed: 'Default'
    }
  )

  cleanups.push(fixture.cleanup)

  const events: string[] = []
  const logs: string[] = []
  const paused: boolean[] = []
  const keys = new SoftwareDeviceKeys()
  const controller = softwareEd25519()
  const recipient = await softwareRecipient()
  const transfers: { agent: string; envelope: BrowserImportEnvelope; admission: BrowserImportAdmission }[] = []
  const stored = new Map<string, any>()
  const state = { owner: OWNER as string | null, device: null as BrowserImportDevice | null }
  let ids = 0

  const kit: BrowserImportDevice = {
    userId: OWNER,
    deviceServiceId: DEVICE_SERVICE,
    signer: {
      signIdentity: bytes => keys.signIdentity(bytes),
      approve: async (bytes, reason) => {
        events.push('approve')
        await options.onApprove?.()

        return keys.approve(bytes, reason)
      }
    },
    approvalKey: { kid: keys.approval.kid, spki: keys.approval.spki },
    identityKid: keys.identity.kid,
    controllerKeys: [{ kid: controller.kid, publicKey: controller.spki }]
  }

  state.device = options.enrolled === false ? null : kit

  const keychain = options.keychain ?? fakeSecurity()

  const transport: BrowserImportTransport = {
    primaryComputer: async () => {
      events.push('computer')

      return options.computer === undefined ? { computerId: COMPUTER, attachmentEpoch: 7 } : options.computer
    },
    readRecipientKey: async (_agent, request) => {
      events.push('recipientKey')

      return signedRecipientRecord({
        controller,
        hpkePublicKey: recipient.hpkePublicKey,
        hpkeKeyId: recipient.hpkeKeyId,
        now: NOW,
        request,
        ...options.record
      })
    },
    admit: async (agent, transfer) => {
      events.push('admit')

      if (options.admit) {
        return options.admit()
      }

      transfers.push({ agent, ...transfer })

      return { importId: transfer.envelope.authenticatedData.importId }
    }
  }

  const store: LastImportStore = {
    read: owner => stored.get(owner) ?? null,
    write: (owner, last) => {
      if (options.storeFails) {
        throw new Error('ENOSPC: no space left on device, write /home/example/browser-import.json')
      }

      stored.set(owner, last)
    }
  }

  const service = new BrowserImportService({
    chrome: chromeEnv(fixture, {
      platform: options.platform ?? 'darwin',
      runSecurity: async (args, timeoutMs) => {
        events.push('keychain')

        return keychain(args, timeoutMs)
      }
    }),
    transport,
    owner: () => state.owner,
    primaryAgent: () =>
      options.primaryAgent === false
        ? null
        : { principal: AGENT, ...(options.agentName === null ? {} : { name: options.agentName ?? 'Nova' }) },
    device: () => state.device,
    ensureEnrolled: async () => {
      events.push('enroll')

      if (options.enrollmentError) {
        throw options.enrollmentError
      }

      if (options.enrollment !== 'fails') {
        state.device = kit
      }
    },
    locale: () => options.locale ?? 'en',
    setPaused: value => paused.push(value),
    store,
    now: () => NOW,
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log: line => logs.push(line)
  })

  /** The bundle as the computer would decrypt it. */
  const open = async (transfer: (typeof transfers)[number]): Promise<BrowserStorageStateBundle> =>
    JSON.parse(
      Buffer.from(
        await recipient.open({
          encapsulatedKey: transfer.envelope.hpke.encapsulatedKey,
          ciphertext: transfer.envelope.hpke.ciphertext,
          aad: browserImportAadBytes(transfer.envelope.authenticatedData)
        })
      ).toString('utf8')
    )

  return { service, events, logs, paused, keys, controller, recipient, transfers, stored, state, open, keychain }
}

describe('a successful import', () => {
  it('goes through the steps in order and holds the platform back until the Touch ID has signed', async () => {
    const { service, events, transfers } = await harness()
    const outcome = await service.run()

    expect(outcome).toMatchObject({
      outcome: 'imported',
      siteCount: 7,
      skippedSiteCount: 4,
      agentPrincipal: AGENT,
      at: NOW
    })
    expect(events).toEqual(['computer', 'keychain', 'computer', 'recipientKey', 'approve', 'admit'])
    expect(transfers).toHaveLength(1)
  })

  it('asks the Keychain once and the person once, and signs the exact bytes that leave the Mac', async () => {
    const { service, keys, transfers, keychain } = await harness()
    await service.run()

    expect((keychain as ReturnType<typeof fakeSecurity>).calls).toHaveLength(1)
    expect(keys.approvals).toHaveLength(1)

    const { envelope } = transfers[0]!

    expect(verifyDeviceSignature(keys.approval.spki, keys.approvals[0]!.bytes, envelope.signature)).toBe(true)
    expect(envelope.signer).toEqual({ deviceServiceId: DEVICE_SERVICE, approvalKeyId: keys.approval.kid })
    expect(keys.identitySignatures).toHaveLength(1)
  })

  it('is admitted by the contract decider under a trusted context', async () => {
    const { service, keys, transfers } = await harness()
    await service.run()

    const { envelope, admission } = transfers[0]!

    const decision = decideBrowserImportAdmission(parseEnvelope(envelope), admission, {
      ownerUserId: OWNER,
      allowedAgents: [AGENT],
      primaryAgentPrincipal: AGENT,
      computerId: COMPUTER,
      authenticatedAttachmentEpoch: 7,
      currentAttachmentEpoch: 7,
      now: NOW + 60_000,
      admittedAt: NOW + 60_000,
      importIdSeen: false,
      eraseState: 'none',
      removedAfter: null,
      consentRevoked: false,
      verifiedSignature: {
        valid: verifyDeviceSignature(keys.approval.spki, keys.approvals[0]!.bytes, envelope.signature),
        signerState: 'active',
        ownerUserId: OWNER,
        deviceServiceId: DEVICE_SERVICE,
        approvalKeyId: keys.approval.kid
      }
    })

    expect(decision).toEqual({ outcome: 'accepted', reason: 'current_recipient' })
    expect(admission).toMatchObject({
      source: { browser: 'chrome', profileOrdinal: 1 },
      recipientBasis: 'primary_default',
      approvedAt: NOW,
      siteCount: 11,
      skippedSiteCount: 4
    })
  }, 30_000) // heavy (real crypto / browser-import harness); a busy shared CI host exceeds the 5 s default

  it('seals exactly what should go: the included sites’ cookies, with the left-behind sites named but empty', async () => {
    const { service, transfers, open } = await harness()
    await service.run()

    const bundle = await open(transfers[0]!)

    const included = bundle.siteSelections
      .filter(({ disposition }) => disposition === 'included')
      .map(({ domain }) => domain)

    const skipped = bundle.siteSelections
      .filter(({ disposition }) => disposition === 'skipped_default')
      .map(({ domain }) => domain)

    expect(included.sort()).toEqual([
      'example.com',
      'example.net',
      'example.org',
      'github.com',
      'google.com',
      'mixed.com',
      'session.com'
    ])
    expect(skipped.sort()).toEqual(['bitwarden.com', 'chase.com', 'momo.vn', 'vietcombank.com.vn'])
    expect(bundle.origins).toEqual([])
    expect(bundle.cookies).toHaveLength(14)

    // Not one cookie of a banking site, wallet or password manager, nor of localhost, an IP or an internal name.
    const text = JSON.stringify(bundle.cookies)

    for (const left of [
      'chase.com',
      'vietcombank',
      'momo.vn',
      'bitwarden',
      'localhost',
      '127.0.0.1',
      '::1',
      'nas.local',
      'bank-secret',
      'wallet-secret',
      'vault-secret',
      'expired-value'
    ]) {
      expect(text).not.toContain(left)
    }

    expect(bundle.cookies.find(cookie => cookie.name === 'session_id')).toMatchObject({
      domain: '.github.com',
      value: 'abc123',
      sameSite: 'Lax'
    })
    // The partitioned (CHIPS) twin stays behind; only the unpartitioned cookie of that name goes.
    expect(bundle.cookies.filter(cookie => cookie.name === 'twin').map(cookie => cookie.value)).toEqual([
      'unpartitioned-twin'
    ])
    // A site whose only cookie could not be read is not claimed.
    expect(included).not.toContain('corrupt.com')
  })

  it('remembers counts for Settings and shows them as the status', async () => {
    const { service, stored } = await harness()

    expect(await service.status()).toEqual({ state: 'ready' })
    await service.run()

    expect(stored.get(OWNER)).toEqual({ siteCount: 7, skippedSiteCount: 4, agentPrincipal: AGENT, at: NOW })
    expect(await service.status()).toEqual({ state: 'ready', last: stored.get(OWNER) })
  })

  it('tells the panel a Mac that is not enrolled yet will ask for a first confirmation, and stops once it is enrolled', async () => {
    const { service } = await harness({ enrolled: false })

    expect(await service.status()).toEqual({ state: 'ready', firstImport: true })
    await service.run()
    expect(await service.status()).toMatchObject({ state: 'ready' })
    expect(await service.status()).not.toHaveProperty('firstImport')
  })

  it('drops its references to the cookies as soon as they are sealed', async () => {
    const { service } = await harness()
    vi.mocked(sealBrowserImport).mockClear()

    expect(await service.run()).toMatchObject({ outcome: 'imported' })

    const [request] = vi.mocked(sealBrowserImport).mock.calls[0]!

    expect(request.bundle.cookies).toHaveLength(0)
  })

  it('drops them when the computer’s key is refused too, and on a refused sealing', async () => {
    const untrusted = await harness({ record: { attachmentEpoch: 6 } })
    vi.mocked(sealBrowserImport).mockClear()

    expect(await untrusted.service.run()).toEqual({ outcome: 'unavailable', reason: 'key_untrusted' })
    // Refused before sealing: the sealer was never given them, and the service held none after it returned.
    expect(vi.mocked(sealBrowserImport)).not.toHaveBeenCalled()

    const failing = await harness()
    vi.mocked(sealBrowserImport).mockClear()
    vi.mocked(sealBrowserImport).mockRejectedValueOnce(new Error('seal failed'))

    expect(await failing.service.run()).toEqual({ outcome: 'unavailable', reason: 'failed' })
    expect(vi.mocked(sealBrowserImport).mock.calls[0]![0].bundle.cookies).toHaveLength(0)
  })

  it('names the primary assistant role, the count and what stays out on the Touch ID sheet, in the owner’s language', async () => {
    const english = await harness({ agentName: 'Nova' })
    await english.service.run()
    const sheet = english.keys.approvals[0]!.reason

    expect(sheet).toContain('your primary assistant')
    expect(sheet).not.toContain('Nova')
    expect(sheet).toContain('7 Chrome sites')
    expect(sheet).toMatch(/no passwords or financial sites/u)
    expect(Array.from(sheet).length).toBeLessThan(600)

    const vietnamese = await harness({ locale: 'vi', agentName: null })
    await vietnamese.service.run()

    expect(vietnamese.keys.approvals[0]!.reason).toContain('trợ lý chính')
    expect(vietnamese.keys.approvals[0]!.reason).toMatch(/7 trang/u)
  })

  it('does not personalize the sheet with an absurdly long agent name', async () => {
    const { service, keys } = await harness({ agentName: 'N'.repeat(500) })
    await service.run()

    expect(keys.approvals[0]!.reason).toContain('your primary assistant')
    expect(keys.approvals[0]!.reason).not.toContain('N'.repeat(41))
  })

  it('holds the device still while the approval is up', async () => {
    const { service, paused } = await harness()
    await service.run()

    expect(paused).toEqual([true, false])
  })

  it('still reports the import when remembering it fails, and logs only a closed word', async () => {
    const { service, logs, transfers } = await harness({ storeFails: true })

    expect(await service.run()).toMatchObject({ outcome: 'imported', siteCount: 7 })
    expect(transfers).toHaveLength(1)
    expect(logs).toContain('[BrowserImport] last_not_saved')
    expect(logs.join('\n')).not.toContain('/home/example')
  })

  it('makes a new import id each time', async () => {
    const { service, transfers } = await harness()
    await service.run()
    await service.run()

    expect(transfers[0]!.envelope.authenticatedData.importId).not.toBe(
      transfers[1]!.envelope.authenticatedData.importId
    )
  })
})

describe('when the person says no', () => {
  it.each([
    ['declines', 'deny'],
    ['does not answer in time', 'timeout']
  ] as const)('sends nothing when the person %s the Touch ID', async (_name, behaviour) => {
    const { service, keys, events, stored, paused } = await harness()
    keys.behaviour = behaviour

    expect(await service.run()).toEqual({ outcome: 'declined' })
    expect(events).toEqual(['computer', 'keychain', 'computer', 'recipientKey', 'approve'])
    expect(stored.size).toBe(0)
    // The device is released even when the approval fails.
    expect(paused).toEqual([true, false])
  })

  it('says the approval is unavailable when this Mac cannot give one', async () => {
    const { service, keys, events } = await harness()
    keys.behaviour = 'unavailable'

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'approval_unavailable' })
    expect(events).not.toContain('admit')
  })

  it.each(['wrong_key', 'bad_signature'] as const)(
    'refuses a signature that is not the enrolled key’s over these bytes (%s)',
    async behaviour => {
      const { service, keys, events } = await harness()
      keys.behaviour = behaviour

      expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'failed' })
      expect(events).not.toContain('admit')
    }
  )

  it('stops at the Keychain when macOS refuses, before anything is asked of the cloud key or the person', async () => {
    const { service, events } = await harness({
      keychain: async () => ({
        status: 128,
        stdout: Buffer.alloc(0),
        stderr: 'User canceled the operation.',
        timedOut: false
      })
    })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'keychain_denied' })
    expect(events).toEqual(['computer', 'keychain'])
  })

  it('treats a Keychain dialog nobody answered as the same refusal', async () => {
    const { service } = await harness({
      keychain: async () => ({ status: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true })
    })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'keychain_denied' })
  })
})

describe('before anything is asked of the person', () => {
  it('has nothing to do when Chrome is not here', async () => {
    const { service, events } = await harness({ noChrome: true })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'chrome_not_found' })
    expect(events).toEqual([])
  })

  it('has nothing to import when every site is left behind or local, and never reaches the Keychain', async () => {
    const { service, events } = await harness({
      cookies: [
        { host: '.chase.com', name: 'a', value: 'x' },
        { host: '.momo.vn', name: 'b', value: 'y' },
        { host: 'localhost', name: 'c', value: 'z' }
      ]
    })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'nothing_to_import' })
    expect(events).toEqual([])
  })

  it('stops when the agent has no cloud computer, before the Keychain', async () => {
    const { service, events } = await harness({ computer: null })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'no_computer' })
    expect(events).toEqual(['computer'])
  })

  it('refuses when the roster has not named a primary agent', async () => {
    const { service, events } = await harness({ primaryAgent: false })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'failed' })
    expect(events).toEqual([])
  })

  it('is signed out without an owner and unsupported off macOS', async () => {
    const out = await harness()
    out.state.owner = null

    expect(await out.service.run()).toEqual({ outcome: 'unavailable', reason: 'signed_out' })
    expect(await out.service.status()).toEqual({ state: 'unavailable' })

    const linux = await harness({ platform: 'linux' })

    expect(await linux.service.run()).toEqual({ outcome: 'unavailable', reason: 'unsupported' })
    expect(await linux.service.status()).toEqual({ state: 'unavailable' })
  }, 30_000) // heavy (real SQLite / harness setup); a busy shared CI host exceeds the 5 s default

  it('enrolls this Mac first when it is not enrolled, because the cloud verifies the approval with that key', async () => {
    const { service, events } = await harness({ enrolled: false })

    expect(await service.run()).toMatchObject({ outcome: 'imported' })
    expect(events).toEqual(['computer', 'enroll', 'keychain', 'computer', 'recipientKey', 'approve', 'admit'])
  })

  it.each([
    ['declines the enrollment Touch ID', 'approval_denied', { outcome: 'declined' }],
    ['lets the enrollment Touch ID time out', 'approval_timeout', { outcome: 'declined' }],
    [
      'has no Touch ID for enrollment',
      'approval_unavailable',
      { outcome: 'unavailable', reason: 'approval_unavailable' }
    ],
    ['has no Secure Enclave keys', 'keys_unavailable', { outcome: 'unavailable', reason: 'approval_unavailable' }]
  ] as const)('stops cleanly when the person %s', async (_name, code, expected) => {
    const { service, events } = await harness({ enrolled: false, enrollmentError: new DeviceEnrollmentError(code) })

    expect(await service.run()).toEqual(expected)
    // Nothing of Chrome was read, asked for or sent.
    expect(events).toEqual(['computer', 'enroll'])
  })

  it('treats a build with no device-key helper as unsupported', async () => {
    const { service } = await harness({ enrolled: false, enrollmentError: new Error('device_unavailable') })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'unsupported' })
  })

  it('gives up when enrollment does not produce a device', async () => {
    const { service, events } = await harness({ enrolled: false, enrollment: 'fails' })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'unsupported' })
    expect(events).toEqual(['computer', 'enroll'])
  })
})

describe('the computer’s key is not taken on trust', () => {
  it.each([
    ['a controller this Mac never pinned', { meta: { signerKeyId: 'U'.repeat(43) } }],
    ['another agent’s computer', { binding: { agentPrincipal: '00000000-0000-4000-8000-e8d95748107a' } }],
    ['another owner', { binding: { ownerUserId: '@other:atum.example' } }],
    ['a stale epoch', { attachmentEpoch: 6 }],
    ['an epoch from the future', { attachmentEpoch: 8 }],
    ['a record with no lifetime', { meta: { issuedAt: NOW, expiresAt: NOW } }]
  ])('seals nothing for %s', async (_name, record) => {
    const { service, events, stored } = await harness({ record })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'key_untrusted' })
    expect(events).not.toContain('approve')
    expect(events).not.toContain('admit')
    expect(stored.size).toBe(0)
  })

  // The invariant the cloud keeps: the computer's HPKE key is never regenerated inside an attachment epoch; losing or
  // rotating it takes a new epoch. So the Mac fences by epoch alone: the epoch it reads fresh from the computer must
  // equal the record's. (The computer read carries no key id, so a same-epoch record naming a different key cannot be
  // refused here; that check belongs to the platform, noted in the session log as a follow-up.)
  it('refuses a signed record whose epoch is not the computer’s epoch read just now', async () => {
    const { service, events } = await harness({ computer: { computerId: COMPUTER, attachmentEpoch: 9 } })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'key_untrusted' })
    expect(events).not.toContain('approve')
  })

  // What the platform really serves: the record the controller signed at publication, whose 15 s window is long over.
  it('imports with a record the controller published long before the click', async () => {
    const { service, events } = await harness({
      record: { meta: { issuedAt: NOW - 3_600_000, expiresAt: NOW - 3_600_000 + 15_000 } }
    })

    expect(await service.run()).toMatchObject({ outcome: 'imported' })
    expect(events).toContain('admit')
  })
})

describe('when the platform does not take it', () => {
  it.each([
    ['is offline', new BrowserImportHttpError(0), 'offline'],
    ['refuses it as a replay', new BrowserImportHttpError(409, 'replayed_import_id'), 'refused'],
    ['refuses a stale epoch', new BrowserImportHttpError(422, 'stale_attachment_epoch'), 'refused'],
    ['has lost the computer', new BrowserImportHttpError(404), 'no_computer'],
    ['fails', new BrowserImportHttpError(503), 'failed'],
    ['wants the person signed in again', new Error('matrix_s1_authentication'), 'signed_out']
  ] as const)('reports a closed reason when it %s', async (_name, failure, reason) => {
    const { service, stored } = await harness({
      admit: () => {
        throw failure
      }
    })

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason })
    // Nothing is remembered as imported.
    expect(stored.size).toBe(0)
  })
})

describe('the account must not change underneath an import', () => {
  it('does not send when the owner changes during the Touch ID', async () => {
    const result = await harness()
    const { service, events, state } = result
    let switched = false

    // The approval resolves after the account has switched.
    const original = state.device!.signer.approve.bind(state.device!.signer)

    state.device!.signer.approve = async (bytes, reason) => {
      const signed = await original(bytes, reason)

      if (!switched) {
        switched = true
        state.owner = '@someone-else:atum.example'
      }

      return signed
    }

    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'signed_out' })
    expect(events).not.toContain('admit')
  })

  it('does not send when this Mac’s device service changes during the Touch ID', async () => {
    const result = await harness({
      onApprove: () => {
        result.state.device = { ...result.state.device!, deviceServiceId: '00000000-0000-4000-8000-f2da1f9533d4' }
      }
    })

    expect(await result.service.run()).toEqual({ outcome: 'unavailable', reason: 'signed_out' })
    expect(result.events).not.toContain('admit')
  })
})

describe('one import at a time', () => {
  it('answers busy to a second run and reports running while the person decides', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => (release = resolve))
    const { service, events } = await harness({ onApprove: () => waiting })

    const first = service.run()

    // Wait until the first import is at the Touch ID.
    while (!events.includes('approve')) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(await service.status()).toMatchObject({ state: 'running' })
    expect(await service.run()).toEqual({ outcome: 'unavailable', reason: 'busy' })

    release()
    expect(await first).toMatchObject({ outcome: 'imported' })
    expect(await service.status()).toMatchObject({ state: 'ready' })
  })
})

describe('what is said out loud', () => {
  it('logs only closed words and counts: never a value, a site, a key or a path', async () => {
    const happy = await harness()
    await happy.service.run()

    const denied = await harness()
    denied.keys.behaviour = 'deny'
    await denied.service.run()

    const keychain = await harness({
      keychain: async () => ({
        status: 128,
        stdout: Buffer.alloc(0),
        stderr: 'denied for /home/example/Library/Keychains',
        timedOut: false
      })
    })

    await keychain.service.run()

    const lines = [...happy.logs, ...denied.logs, ...keychain.logs]

    expect(lines.length).toBeGreaterThan(2)

    for (const line of lines) {
      expect(line).toMatch(/^\[BrowserImport\] (imported sites=\d+ skipped=\d+|declined|[a-z_]+)( \([a-z_]+\))?$/u)

      for (const secret of SECRETS) {
        expect(line).not.toContain(secret)
      }
    }
  })

  it('returns closed outcomes whose JSON carries no secret', async () => {
    const { service } = await harness()
    const outcome = JSON.stringify(await service.run())

    for (const secret of SECRETS.filter(secret => secret !== AGENT)) {
      expect(outcome).not.toContain(secret)
    }
  })
})

describe('reasonOf', () => {
  it.each([
    [new ChromeImportError('unsupported_platform'), 'unsupported'],
    [new ChromeImportError('chrome_not_found'), 'chrome_not_found'],
    [new ChromeImportError('keychain_denied'), 'keychain_denied'],
    [new ChromeImportError('keychain_timeout'), 'keychain_denied'],
    [new ChromeImportError('keychain_not_found'), 'keychain_denied'],
    [new ChromeImportError('cookie_db_corrupt'), 'failed'],
    [new ChromeImportError('decrypt_failed'), 'failed'],
    [new RecipientKeyError('forged_controller_signature'), 'key_untrusted'],
    [new BrowserImportHttpError(0), 'offline'],
    [new BrowserImportHttpError(404), 'no_computer'],
    [new BrowserImportHttpError(409), 'refused'],
    [new BrowserImportHttpError(500), 'failed'],
    [new Error('matrix_domain_connection_required'), 'signed_out'],
    [new Error('matrix_s1_cancelled'), 'signed_out'],
    [new Error('something with /home/example/path and a cookie value'), 'failed'],
    [new DeviceKeyError('failed'), 'failed'],
    ['a thrown string', 'failed']
  ] as [unknown, MatrixBrowserImportReason][])('maps %s to %s', (error, reason) => {
    expect(reasonOf(error)).toBe(reason)
  })
})
