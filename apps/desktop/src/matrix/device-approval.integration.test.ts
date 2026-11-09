// @vitest-environment node
import 'fake-indexeddb/auto'

import { ClientEvent, createClient, type MatrixClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type MatrixApprovalLedgerStore,
  MatrixDeviceApproval,
  type MatrixDeviceApprovalPort
} from '../../electron/matrix/device-approval'
import { matrixOwnerKeyRetention } from '../../electron/matrix/owner-keys'
import { matrixMayAskOtherDevices, unlockMatrixOwner } from '../../electron/matrix/owner-unlock'
import type { MatrixSdkCommand } from '../../shared/matrix'
import type {
  MatrixApprovalView,
  MatrixOwnDevices,
  MatrixOwnerStatus,
  MatrixRecoveryCheck,
  MatrixSecurityCommand,
  MatrixVerification
} from '../../shared/matrix-security'

import { ownerRecoveryCarrier } from './owner-recovery-carrier'
import { matrixSecurity, recoveryKeyCache } from './security'
import { TestHomeserver } from './test-homeserver'

/**
 * One-tap approval between two of the person's devices, end to end with the real thing: two
 * matrix-js-sdk clients of the same person, each with the real Rust crypto (WebAssembly, its store
 * in fake-indexeddb, as the SDK's own tests run it), talking over the SDK's own HTTP layer to an
 * in-process homeserver (test-homeserver.ts). Each device runs this app's SDK-side code
 * (security.ts, owner-recovery-carrier.ts) and its main-side approval (device-approval.ts), wired
 * the way sdk.ts and main.ts wire them.
 *
 * Not real: the IPC between the SDK window and main (a function call here), main's key vault and
 * device-trust.json (variables), the person (the test taps for them, after reading both screens),
 * and the approval's clock (each device's own, running ten times faster while the approval waits,
 * so two minutes take seconds; the SDK and crypto keep real time). The in-process homeserver is
 * polled every 100 ms, like the other real-crypto TestHomeserver integrations, so its simplified
 * long poll cannot hide an encrypted recovery message behind the accelerated approval deadline.
 * The comparison's own time limit (the SAS timeout, about a minute) is the crypto's clock, so its
 * two cases run in real time.
 *
 * The key handover rides on an Olm session between the two devices. The Rust crypto can wedge a
 * pair whose two devices start a session at the same instant (the new Mac's key request and the
 * approving Mac's answer to the secrets the SDK shares after any verification), and then never
 * unwedges it within the minutes an approval lasts: about 3 handovers in 100 lost the key, in CI
 * and here . The new Mac opens its
 * channel while the person compares; the last describe holds that to account.
 */

const ME = '@minh:atum.test'
const MACBOOK = 'ATUM_MACBOOK'
const MINI = 'ATUM_MINI'
const INTRUDER = 'ATUM_INTRUDER'

const quiet: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quiet
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** One device's clock for the approval: real time plus what it waited, ten times faster. */
function virtualClock() {
  let offset = 0

  return {
    now: () => Date.now() + offset,
    wait: async (ms: number) => {
      const real = Math.max(10, Math.round(ms / 10))
      offset += ms - real
      await sleep(real)
    }
  }
}

interface Vault {
  key?: string
  keyId?: string
  needsKey: boolean
}

interface TestDevice {
  id: string
  client: MatrixClient
  approval: MatrixDeviceApproval
  vault: Vault
  log: string[]
  calls: MatrixSdkCommand[]
  command(value: MatrixSdkCommand): Promise<unknown>
  view(): MatrixApprovalView | undefined
  verification(): MatrixVerification | undefined
  /** The comparison as the approval last saw it: the published snapshot, which trails the SDK's. */
  observed(): MatrixVerification | undefined
  /** How many times this device saw the identity it verified replaced (security.ts). */
  identityChanges(): number | undefined
  /** Quit and start again: a new approval over the same SDK and the same ledger. */
  restartApproval(): void
  stop(): void
}

const running: TestDevice[] = []

afterEach(async () => {
  for (const device of running.splice(0)) {
    device.stop()
  }

  await sleep(20)
})

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 90_000) {
  const started = Date.now()

  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      const diagnostics = running.map(device => ({
        id: device.id,
        view: device.view(),
        verification: device.verification(),
        log: device.log,
        calls: device.calls
          .slice(-30)
          .map(call => ({ kind: call.kind, ...('action' in call ? { action: call.action } : {}) }))
      }))

      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(diagnostics)}`)
    }

    await sleep(25)
  }
}

/**
 * One of the person's devices: a real client and crypto store, the SDK-side security adapter and
 * key carrier (as sdk.ts composes them), and main's approval over them (as main.ts wires it).
 */
async function startDevice(server: TestHomeserver, deviceId: string, vault: Vault, name: string): Promise<TestDevice> {
  const token = server.signIn(deviceId, name)
  const cache = recoveryKeyCache()

  const client = createClient({
    baseUrl: server.baseUrl,
    userId: ME,
    deviceId,
    accessToken: token,
    fetchFn: server.fetch,
    cryptoCallbacks: cache.callbacks,
    verificationMethods: ['m.sas.v1'],
    logger: quiet
  })

  await client.initRustCrypto({
    cryptoDatabasePrefix: `crypto-${deviceId}-${globalThis.crypto.randomUUID()}`,
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  })

  let observe = () => {}
  let observed: MatrixVerification | undefined
  const security = matrixSecurity(client, cache, () => observe())
  const carrier = ownerRecoveryCarrier(client)
  client.getCrypto()!.globalBlacklistUnverifiedDevices = true
  const calls: MatrixSdkCommand[] = []

  // sdk.ts's routing of main's and the window's commands.
  const command = async (value: MatrixSdkCommand): Promise<unknown> => {
    calls.push(value)

    switch (value.kind) {
      case 'ownerRecoveryToDeviceSend':

      case 'ownerRecoveryToDeviceRead':

      case 'ownerRecoveryChannelOpen':

      case 'ownerRecoveryDrops':
        return carrier.command(value)

      case 'verificationStart':

      case 'verificationRespond':

      case 'recoveryCreateKey':

      case 'recoverySetUp':

      case 'recoveryDiscard':

      case 'recoveryRestore':
        return security.command(value as MatrixSecurityCommand)

      default:
        return security.nativeCommand(value as Parameters<typeof security.nativeCommand>[0])
    }
  }

  const log: string[] = []
  const clock = virtualClock()
  let saved: string | null = null
  const ledger: MatrixApprovalLedgerStore = { read: () => saved, write: value => void (saved = value) }

  const port: MatrixDeviceApprovalPort = {
    me: () => ({ userId: ME, deviceId }),
    command: value => command(value),
    grantable: () => (vault.key && vault.keyId && !vault.needsKey ? { key: vault.key, keyId: vault.keyId } : undefined),
    needsKey: () => vault.needsKey,
    // main.ts: checked against the account's recovery, never over a key this Mac keeps (only a
    // typed key replaces a kept key: the same rule main keeps keys by), kept, then the silent
    // unlock.
    received: async (key, keyId) => {
      const check = (await command({ kind: 'recoveryCheck', key })) as MatrixRecoveryCheck
      const retention = matrixOwnerKeyRetention(vault.key ? { key: vault.key } : undefined, key, { source: 'approved' })

      if (!check.valid || check.keyId !== keyId || retention === 'refuse') {
        return false
      }

      await command({ kind: 'ownerRestore', key })
      Object.assign(vault, { key, keyId, needsKey: false })

      return true
    },
    notify: () => {},
    changed: () => {},
    log: line => log.push(line),
    ledger,
    now: clock.now,
    wait: clock.wait
  }

  let approval = new MatrixDeviceApproval(port)
  let scheduled: ReturnType<typeof setTimeout> | undefined

  // sdk.ts publishes a snapshot shortly after a change; main hands its security to the approval.
  observe = () => {
    scheduled ??= setTimeout(() => {
      scheduled = undefined
      const snapshot = security.snapshot()
      observed = snapshot.verification
      approval.observe(snapshot)
    }, 20)
  }

  client.on(ClientEvent.AccountData, () => observe())
  await client.startClient({ initialSyncLimit: 1, pollTimeout: 100 })
  await until(() => client.isInitialSyncComplete(), `${deviceId}'s first sync`)

  const device: TestDevice = {
    id: deviceId,
    client,
    get approval() {
      return approval
    },
    vault,
    log,
    calls,
    command,
    view: () => approval.view(),
    verification: () => security.snapshot().verification,
    observed: () => observed,
    identityChanges: () => security.snapshot().identityChanges,
    restartApproval: () => {
      approval.reset()
      approval = new MatrixDeviceApproval(port)
    },
    stop: () => {
      clearTimeout(scheduled)
      approval.reset()
      security.stop()
      carrier.stop()
      client.stopClient()
    }
  }

  running.push(device)

  return device
}

/** The person's first Mac makes its recovery (signing keys, secret storage, key backup) the way
 * the first run does, and keeps the key. */
async function firstMac(server: TestHomeserver) {
  const macbook = await startDevice(server, MACBOOK, { needsKey: false }, 'Atum · MacBook Pro')
  const created = (await macbook.command({ kind: 'recoveryCreateKey' })) as { id: string; key: string }
  await macbook.command({ kind: 'recoverySetUp', id: created.id })

  const ready = async () =>
    ((await macbook.command({ kind: 'securityStatus' })) as { recovery: string }).recovery !== 'working'

  await until(ready, 'the first Mac’s recovery')
  const check = (await macbook.command({ kind: 'recoveryCheck', key: created.key })) as MatrixRecoveryCheck
  expect(check.valid).toBe(true)
  Object.assign(macbook.vault, { key: created.key, keyId: check.keyId })

  return macbook
}

/** The first Mac, and a new Mac that signs in with nothing. */
async function twoMacs(server = new TestHomeserver(ME)) {
  const macbook = await firstMac(server)
  const mini = await startDevice(server, MINI, { needsKey: true }, 'Atum · Mac mini')

  return { server, macbook, mini, key: macbook.vault.key! }
}

/** The person at the approving Mac: the complete number code the new Mac shows. */
function rightRow(mini: TestDevice, macbook: TestDevice): number {
  const shown = JSON.stringify(mini.view()?.numbers)

  return (macbook.view()?.choices ?? []).findIndex(row => JSON.stringify(row) === shown)
}

/** The new Mac: the person picked its code on the MacBook, and says so here:
 * a new Mac has nothing to check the person's identity against). */
async function picked(mini: TestDevice) {
  await until(() => mini.view()?.confirm === true, 'the new Mac to wait for the person')
  await mini.approval.confirmPicked()
}

/** The new Mac can ask only a device it already sees, signed by the person's identity: its first
 * sync does not wait for the device list, so a request sent at once can find nobody to ask. */
async function canAsk(mini: TestDevice) {
  await until(async () => {
    const own = (await mini.command({ kind: 'ownDevices' })) as MatrixOwnDevices
    const device = own.devices.find(each => each.deviceId === MACBOOK)

    return (
      own.identity !== 'changed' &&
      typeof device?.lastSeenAt === 'number' &&
      (own.identity === 'verified' ? device.crossSigningVerified === true : device.signedByOwner === true)
    )
  }, 'the new Mac to see the MacBook as a device that can approve it')
}

/** The new Mac asks; the person says it is them on the MacBook and the two screens compare. */
async function askAndCompare(mini: TestDevice, macbook: TestDevice) {
  await canAsk(mini)
  expect(await mini.approval.request()).toBe(true)
  await until(() => macbook.view()?.state === 'asked', 'the MacBook to ask the person')
  await macbook.approval.accept()
  await until(() => macbook.view()?.state === 'compare' && mini.view()?.state === 'compare', 'the comparison')
}

const responses = (device: TestDevice) =>
  device.calls.flatMap(call => (call.kind === 'verificationRespond' ? [call.action] : []))

const grantsSent = (device: TestDevice) =>
  device.calls.filter(
    call => call.kind === 'ownerRecoveryToDeviceSend' && call.event.type === 'io.atum.owner_recovery.grant'
  ).length

describe('approving a new Mac with the real SDK and crypto, end to end', () => {
  it('verifies, signs and hands the key over, before any cross-signature reaches the MacBook', async () => {
    const { server, macbook, mini, key } = await twoMacs()
    // The worst case the review feared: the MacBook never sees the new Mac's cross-signature
    // before the key request arrives. The request still counts, on the comparison alone.
    server.holdSignatures = true

    await askAndCompare(mini, macbook)
    const row = rightRow(mini, macbook)
    expect(row).toBeGreaterThanOrEqual(0)
    expect(await macbook.approval.pick(row)).toBeUndefined()
    // The new Mac confirms nothing by itself: the person says they picked.
    expect(responses(mini)).toEqual([])
    await picked(mini)

    await until(() => mini.view()?.state === 'done', 'the key to arrive')
    expect(mini.vault.key).toBe(key)
    expect(mini.log).toContain('[Matrix] approval role=request key=received')
    await until(() => macbook.view()?.state === 'done', 'the MacBook to say it is done')

    // Once the signatures arrive, the new Mac is the person's own, with its history.
    server.releaseSignatures()
    await until(async () => {
      const status = (await mini.command({ kind: 'ownerStatus' })) as MatrixOwnerStatus

      return status.signing && status.deviceSigned && status.backup
    }, 'the new Mac to be signed and to read the backup')

    // The key went inside the encrypted grant only.
    expect([...mini.log, ...macbook.log].join('\n')).not.toContain(key)
    expect(server.unknown.filter(request => !request.includes('/rtc/transports'))).toEqual([])
  }, 240_000)

  it('a key request lost on the way is asked again, and the key still arrives', async () => {
    const { server, macbook, mini, key } = await twoMacs()
    let dropped = 0

    // The first encrypted message the new Mac sends the MacBook after its channel is open (its key
    // request) never arrives: the review's case of a request the MacBook could not take at once.
    server.toDevice = ({ sender, recipient, type }) => {
      if (
        sender === MINI &&
        recipient === MACBOOK &&
        type === 'm.room.encrypted' &&
        dropped === 0 &&
        mini.log.includes('[Matrix] approval role=request channel=open')
      ) {
        dropped += 1

        return 'drop'
      }

      return 'deliver'
    }

    await askAndCompare(mini, macbook)
    await macbook.approval.pick(rightRow(mini, macbook))
    await picked(mini)
    await until(() => mini.view()?.state === 'done', 'the key to arrive')

    expect(dropped).toBe(1)
    expect(mini.vault.key).toBe(key)

    const asked = mini.calls.filter(
      call => call.kind === 'ownerRecoveryToDeviceSend' && call.event.type === 'io.atum.owner_recovery.request'
    )

    expect(asked.length).toBeGreaterThanOrEqual(2)
    expect(new Set(asked.map(call => JSON.stringify((call as { event: unknown }).event))).size).toBe(1)
    expect(grantsSent(macbook)).toBeGreaterThanOrEqual(1)
  }, 240_000)

  it('a lost key is not the end: the next comparison sends it again', async () => {
    const { server, macbook, mini, key } = await twoMacs()
    let lose = true

    server.toDevice = ({ sender, recipient, type }) =>
      lose && sender === MACBOOK && recipient === MINI && type === 'm.room.encrypted' ? 'drop' : 'deliver'

    // First attempt: every encrypted message from the MacBook to the new Mac is lost, so the key
    // never arrives however often the new Mac asks and the MacBook answers.
    await askAndCompare(mini, macbook)
    await macbook.approval.pick(rightRow(mini, macbook))
    await picked(mini)
    await until(() => mini.view()?.state === 'failed', 'the new Mac to give up', 120_000)
    expect(mini.log).toContain('[Matrix] approval role=request key=none')
    expect(macbook.log).toContain('[Matrix] approval role=approve key=sent')
    expect(macbook.log).toContain('[Matrix] approval role=approve key=resent')
    expect(mini.vault.key).toBeUndefined()

    // "Try again": a new comparison is a new approval, and the key goes out again. The first
    // comparison verified the person's identity here, so the new Mac now confirms by itself:
    // one "I picked them" in all.
    lose = false
    mini.approval.dismiss()
    await askAndCompare(mini, macbook)
    expect(mini.view()?.confirm).toBeUndefined()
    await macbook.approval.pick(rightRow(mini, macbook))
    await until(() => mini.view()?.state === 'done', 'the key to arrive the second time')
    expect(mini.log.filter(line => line === '[Matrix] approval role=request picked')).toHaveLength(1)
    expect(mini.vault.key).toBe(key)
  }, 300_000)

  it('a wrong row refuses that device: its next request is turned away, even after a restart', async () => {
    const { macbook, mini } = await twoMacs()

    await askAndCompare(mini, macbook)
    const wrong = [0, 1, 2].find(index => index !== rightRow(mini, macbook))!
    expect(await macbook.approval.pick(wrong)).toBe(MINI)
    await until(() => mini.view()?.state === 'mismatch', 'the new Mac to hear it did not match')
    expect(macbook.view()?.state).toBe('mismatch')

    // The new Mac asks again at once, and again after the MacBook restarted: no sheet, and each
    // request is cancelled, so nothing else offers it either.
    for (const restart of [false, true]) {
      if (restart) {
        macbook.restartApproval()
      }

      mini.approval.dismiss()
      expect(await mini.approval.request()).toBe(true)
      await until(() => mini.view()?.state === 'declined', 'the request to be turned away')
      expect(macbook.view()?.state ?? 'none').not.toBe('asked')
    }

    expect(macbook.log.filter(line => line === '[Matrix] approval role=approve refused reason=muted')).toHaveLength(2)
    expect(responses(macbook)).toEqual(['accept', 'start', 'mismatch', 'cancel', 'cancel'])
    expect(grantsSent(macbook)).toBe(0)
    expect(mini.vault.key).toBeUndefined()
  }, 240_000)

  it('the person’s own comparison from Settings hands the key over too', async () => {
    const { macbook, mini, key } = await twoMacs()

    // The sheet is closed without an answer: its request ends, and the new Mac says so.
    expect(await mini.approval.request()).toBe(true)
    await until(() => macbook.view()?.state === 'asked', 'the MacBook to ask the person')
    macbook.approval.dismiss()
    await until(() => mini.view()?.state === 'declined', 'the new Mac to hear the request ended')

    // Settings › Your devices › Verify, on the MacBook: the generic prompt, the complete SAS compared.
    await macbook.command({ kind: 'verificationStart', userId: ME, deviceId: MINI })
    await until(() => macbook.verification()?.state === 'ready', 'the new Mac to accept')
    await macbook.command({ kind: 'verificationRespond', id: macbook.verification()!.id, action: 'start' })
    await until(() => macbook.verification()?.state === 'compare' && mini.view()?.state === 'compare', 'the code')
    // The person confirms what the MacBook shows, which is the published snapshot: the approval
    // answers a comparison only after it saw the codes (`checked`). The SDK reaches `compare`
    // before the 20 ms snapshot does, and confirming at once would let the comparison finish
    // unseen, so the key is never sent.
    await until(() => macbook.observed()?.state === 'compare', 'the MacBook to show the code')
    expect(macbook.verification()?.decimals).toEqual(mini.view()?.numbers)
    await macbook.command({ kind: 'verificationRespond', id: macbook.verification()!.id, action: 'confirm' })
    await picked(mini)

    await until(() => mini.view()?.state === 'done', 'the key to arrive')
    expect(mini.vault.key).toBe(key)
    expect(macbook.log).toContain('[Matrix] approval role=approve from=settings')
  }, 240_000)

  it('a Mac whose kept key went stale, because another sign-in replaced the identity and the recovery, neither asks nor confirms, and keeps its key', async () => {
    const server = new TestHomeserver(ME)
    const macbook = await firstMac(server)
    const kept = macbook.vault.key!
    const keptId = macbook.vault.keyId
    const own = async () => (await macbook.command({ kind: 'ownDevices' })) as MatrixOwnDevices
    expect((await own()).identity).toBe('verified')

    // Someone with the person's Google sign-in: a new session that makes a new recovery and key
    // backup, then a new identity (the account page's reset lets it replace the identity).
    const intruder = await startDevice(server, INTRUDER, { needsKey: true }, 'Atum · MacBook Air')
    const crypto = intruder.client.getCrypto()!
    const replaced = await crypto.createRecoveryKeyFromPassphrase()
    await crypto.bootstrapSecretStorage({
      setupNewSecretStorage: true,
      createSecretStorageKey: async () => replaced,
      setupNewKeyBackup: true
    })
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: true,
      authUploadDeviceSigningKeys: request => request({})
    })

    // The MacBook sees the new recovery, and that the identity it verified was replaced.
    await until(
      async () => ((await macbook.command({ kind: 'ownerStatus' })) as MatrixOwnerStatus).keyId !== keptId,
      'the new recovery to reach the MacBook'
    )
    await until(async () => (await own()).identity === 'changed', 'the MacBook to see its identity replaced')
    // Its SDK counts the replacement, so main checks the kept key again while it runs: the stale
    // notice shows without a relaunch.
    await until(() => (macbook.identityChanges() ?? 0) >= 1, 'the MacBook’s SDK to count the replacement')
    // The intruder's session is signed by the identity the server serves now, which the MacBook
    // never verified: exactly what the old check (`signedByOwner`) let through.
    expect((await own()).devices.find(device => device.deviceId === INTRUDER)).toMatchObject({
      signedByOwner: true,
      crossSigningVerified: false
    })

    // Its next launch, as main runs it: the kept key no longer opens the account's recovery, so
    // nobody is asked, and nothing is restored or kept in its place. Not even the intruder's key,
    // which opens the new recovery, arriving through iCloud Keychain (one of the person's Macs
    // mirrored it there after one mistaken tap): iCloud is never read over a kept key.
    let icloudReads = 0
    const intruderKey = replaced.encodedPrivateKey!
    // It does open the account's recovery now (checked on the intruder's session, so nothing of
    // it is cached on the MacBook).
    expect(((await intruder.command({ kind: 'recoveryCheck', key: intruderKey })) as MatrixRecoveryCheck).valid).toBe(
      true
    )

    const unlock = await unlockMatrixOwner({
      status: async () => (await macbook.command({ kind: 'ownerStatus' })) as MatrixOwnerStatus,
      kept: () => ({ key: kept, ...(keptId ? { keyId: keptId } : {}), source: 'created', savedAt: 0 }),
      icloud: async () => {
        icloudReads += 1

        return intruderKey
      },
      check: async key => (await macbook.command({ kind: 'recoveryCheck', key })) as MatrixRecoveryCheck,
      restore: async () => {
        throw new Error('restored with a stale key')
      },
      retain: () => {
        throw new Error('kept a key in place of the person’s')
      },
      assertCurrent: () => {},
      log: () => {}
    })

    expect(unlock).toMatchObject({ state: 'needs_key', reason: 'stale' })
    expect(matrixMayAskOtherDevices(unlock)).toBe(false)
    expect(icloudReads).toBe(0)
    // Not unlocked: nothing here can approve anyone either.
    macbook.vault.needsKey = true

    // "Try again" asks nobody either.
    expect(await macbook.approval.request()).toBe(false)
    expect(macbook.log).toContain('[Matrix] approval: the account’s identity changed elsewhere; not asking')

    // The intruder's session asks the person's devices to let it in: the MacBook shows no sheet,
    // and accepts and confirms nothing.
    await intruder.command({ kind: 'approvalRequest' })
    await until(() => macbook.verification()?.deviceId === INTRUDER, 'the request to reach the MacBook')
    await sleep(1_500)
    expect(macbook.view()).toBeUndefined()
    expect(responses(macbook)).toEqual([])
    expect(
      macbook.calls.some(call => call.kind === 'approvalRequest' || call.kind === 'ownerRecoveryToDeviceSend')
    ).toBe(false)

    // Its key stays: the person's, not the intruder's.
    expect(macbook.vault.key).toBe(kept)
    expect(replaced.encodedPrivateKey).not.toBe(kept)
  }, 240_000)
})

describe('the comparison’s time limit, in real time (the SAS timeout runs on the crypto’s own clock)', () => {
  it('a new Mac tapped about 45 s after its number code showed still finishes', async () => {
    const { macbook, mini, key } = await twoMacs()
    await askAndCompare(mini, macbook)
    const shown = Date.now()
    await until(() => mini.view()?.confirm === true, 'the new Mac to wait for the person')

    // The person reads the code, walks to the MacBook and picks it there.
    await sleep(10_000)
    await macbook.approval.pick(rightRow(mini, macbook))
    // The MacBook hides its rows and says where to tap next.
    expect(macbook.view()).toMatchObject({ role: 'approve', state: 'compare', picked: true })
    expect(macbook.view()?.choices).toBeUndefined()

    // Then walks back to the new Mac and confirms the selected code there.
    await sleep(Math.max(0, 45_000 - (Date.now() - shown)))
    expect(mini.view()).toMatchObject({ state: 'compare', confirm: true })
    await mini.approval.confirmPicked()

    await until(() => mini.view()?.state === 'done', 'the key to arrive')
    expect(mini.vault.key).toBe(key)
    await until(() => macbook.view()?.state === 'done', 'the MacBook to say it is done')
  }, 240_000)

  it('a tap after about 75 s is too late: both sides say it took too long, and Try again finishes', async () => {
    const { macbook, mini, key } = await twoMacs()
    await askAndCompare(mini, macbook)
    const shown = Date.now()
    await until(() => mini.view()?.confirm === true, 'the new Mac to wait for the person')
    await sleep(10_000)
    await macbook.approval.pick(rightRow(mini, macbook))

    // About a minute after the pick, the crypto ends the comparison on both sides.
    await until(
      () => mini.view()?.state === 'timeout' && macbook.view()?.state === 'timeout',
      'both sides to say it took too long',
      120_000
    )
    expect(mini.verification()?.cancelCode).toBe('m.timeout')

    // The tap, at 75 s, changes nothing: no key, nothing signed.
    await sleep(Math.max(0, 75_000 - (Date.now() - shown)))
    await expect(mini.approval.confirmPicked()).rejects.toThrow('matrix_approval_stale')
    expect(responses(mini)).toEqual([])
    expect(grantsSent(macbook)).toBe(0)
    expect(mini.vault.key).toBeUndefined()

    // Try again on the MacBook: it asks the new Mac again, and this time the person is quick.
    await macbook.approval.again()
    await until(() => macbook.view()?.state === 'compare' && mini.view()?.state === 'compare', 'the second comparison')
    expect(macbook.view()?.choices).toHaveLength(3)
    await macbook.approval.pick(rightRow(mini, macbook))
    await picked(mini)

    await until(() => mini.view()?.state === 'done', 'the key to arrive')
    expect(mini.vault.key).toBe(key)
    expect(macbook.log).toContain('[Matrix] approval role=approve again')
  }, 300_000)
})

describe('the encrypted channel between the two Macs, opened before the key is asked for', () => {
  it('the new Mac opens it while the person compares, so nothing starts a session at the moment of the key request', async () => {
    const { server, macbook, mini, key } = await twoMacs()
    const encrypted: string[] = []

    server.toDevice = ({ sender, recipient, type }) => {
      if (type === 'm.room.encrypted') {
        encrypted.push(`${sender}>${recipient}`)
      }

      return 'deliver'
    }

    await askAndCompare(mini, macbook)
    // Still comparing: no tap on either Mac yet, and the new Mac has already reached the MacBook.
    await until(() => encrypted.includes(`${MINI}>${MACBOOK}`), 'the new Mac to open its channel to the MacBook')
    expect(mini.log).toContain('[Matrix] approval role=request channel=open')
    expect(mini.view()).toMatchObject({ state: 'compare' })
    expect(macbook.view()).toMatchObject({ state: 'compare' })
    expect(responses(mini)).toEqual([])
    expect(
      mini.calls.some(call => call.kind === 'ownerRecoveryToDeviceSend' && call.event.type.endsWith('.request'))
    ).toBe(false)
    // The MacBook never opens one itself while the comparison runs.
    expect(encrypted.filter(pair => pair === `${MACBOOK}>${MINI}`)).toEqual([])

    await macbook.approval.pick(rightRow(mini, macbook))
    await picked(mini)
    await until(() => mini.view()?.state === 'done', 'the key to arrive')
    expect(mini.vault.key).toBe(key)
  }, 120_000)

  it('the key arrives on every one of many approvals in a row', async () => {
    // A pair that starts a session from both ends at the same moment loses the key about 3 times
    // in 100 handovers: one run of this much catches that most of the time, and many runs in CI
    // catch it all but surely. Each approval is a new pair of devices.
    const approvals = 40
    const failures: string[] = []

    for (let each = 0; each < approvals; each += 1) {
      const { macbook, mini, key } = await twoMacs()

      try {
        await askAndCompare(mini, macbook)
        await macbook.approval.pick(rightRow(mini, macbook))
        await picked(mini)
        // The handover takes well under a second: a pair that cannot read each other never will.
        await until(() => mini.view()?.state === 'done', 'the key to arrive', 20_000)
        expect(mini.vault.key).toBe(key)
      } catch (error) {
        failures.push(`approval ${each + 1}: ${String(error).slice(0, 600)}`)
      }

      for (const device of running.splice(0)) {
        device.stop()
      }

      await sleep(20)
    }

    expect(failures).toEqual([])
  }, 300_000)
})
