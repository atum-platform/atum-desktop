import { describe, expect, it, vi } from 'vitest'

import type { MatrixSdkCommand } from '../../shared/matrix'
import type {
  MatrixApprovalNumbers,
  MatrixOwnerRecoveryEvent,
  MatrixOwnerRecoveryMessage,
  MatrixSecurity,
  MatrixVerification
} from '../../shared/matrix-security'

import { MatrixDeviceApproval, type MatrixDeviceApprovalPort } from './device-approval'

const ME = '@fixture-owner:atumplatform.com'
const NEW_MAC = 'ATUM_newmac'
const MACBOOK = 'ATUM_macbook'
const KEY = 'EsTc 1234 abcd EFGH ijkl MNOP qrst UVWX yz12 3456 789A BCDE'
const SAS: MatrixApprovalNumbers = [1036, 4349, 6060]
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

type Side = 'new' | 'approver'

type Identity = 'verified' | 'new' | 'changed'

interface WorldOptions {
  approverKey?: boolean
  approverIsElementX?: boolean
  devices?: unknown[]
  /** What each device knows of the person's identity (security.ts `ownDevices`): by default a
   * brand-new Mac with nothing to check it against, and an approver that verified it. */
  identity?: Partial<Record<Side, Identity>>
  /** How many of each message the network loses on the way (Infinity: every one). */
  lose?: { requests?: number; grants?: number }
  /** What each side's carrier says it dropped, one batch per read (owner-recovery-carrier.ts). */
  drops?: Partial<Record<Side, unknown[][]>>
  /** SDK commands that fail, with the error the SDK throws. */
  fail?: Partial<Record<MatrixSdkCommand['kind'], Error>>
  /** Holds the opening of the encrypted channel (owner-recovery-carrier.ts) until it settles. */
  channelOpen?: () => Promise<void>
}

/**
 * Two of the person's devices and the standard verification between them, as each one's SDK
 * reports it (security.ts), with the to-device carrier between them (owner-recovery-carrier.ts).
 * Every comparison has its own IDs and its own transaction ID, the same on both sides, as in the
 * SDK. The approver's ledger (device-trust.json in main) is a variable that outlives a restart.
 */
function world(options: WorldOptions = {}) {
  let time = Date.UTC(2026, 9, 5, 8)
  const security: Record<Side, MatrixSecurity> = { new: { recovery: 'idle' }, approver: { recovery: 'idle' } }
  const inbox: Record<Side, MatrixOwnerRecoveryMessage[]> = { new: [], approver: [] }
  const confirmed = new Set<Side>()
  const log: string[] = []
  const calls: Array<{ side: Side; value: MatrixSdkCommand }> = []
  const sent: Array<{ side: Side; event: MatrixOwnerRecoveryEvent; lost: boolean }> = []
  const opened: Array<{ side: Side; to: string; at: number }> = []
  const notified: Array<string | undefined> = []
  let received: string | undefined
  const signed: string[] = []
  const markers: unknown[] = []
  const lose = { requests: options.lose?.requests ?? 0, grants: options.lose?.grants ?? 0 }
  const identity: Record<Side, Identity> = { new: 'new', approver: 'verified', ...options.identity }
  let approverKey = options.approverKey !== false
  /** The new Mac's key went stale (owner-unlock.ts): it takes only a typed key now. */
  let stale = false
  let saved: string | null = null
  let flows = 0
  const approvals = {} as Record<Side, MatrixDeviceApproval>

  const deviceOf = (side: Side) => (side === 'new' ? NEW_MAC : MACBOOK)
  const other = (side: Side): Side => (side === 'new' ? 'approver' : 'new')

  const set = (side: Side, verification: MatrixVerification | undefined) => {
    security[side] = { ...security[side], verification }
  }

  const both = (patch: Partial<MatrixVerification>) => {
    for (const side of ['new', 'approver'] as Side[]) {
      const current = security[side].verification

      if (current) {
        set(side, { ...current, ...patch })
      }
    }
  }

  const observe = () => {
    approvals.new.observe(security.new)
    approvals.approver.observe(security.approver)
  }

  /** A comparison between the two devices, asked by `from`. */
  const begin = (from: Side, prefix: string) => {
    flows += 1
    const flowId = `${prefix}-flow-${flows}`
    confirmed.clear()

    for (const side of [from, other(from)]) {
      set(side, {
        id: `${prefix}-${side}-${flows}`,
        userId: ME,
        deviceId: deviceOf(other(side)),
        flowId,
        incoming: side !== from,
        state: 'requested'
      })
    }
  }

  const command = (side: Side) =>
    vi.fn(async (value: MatrixSdkCommand): Promise<unknown> => {
      calls.push({ side, value })

      const failure = options.fail?.[value.kind]

      if (failure) {
        throw failure
      }

      switch (value.kind) {
        case 'ownDevices':
          return {
            devices: (
              options.devices ?? [
                {
                  deviceId: MACBOOK,
                  name: 'Atum · MacBook Pro mẫu',
                  lastSeenAt: time - 3_600_000,
                  signedByOwner: true
                },
                { deviceId: 'OLD_PHONE', name: 'Old phone', lastSeenAt: time - 90 * 86_400_000, signedByOwner: true },
                { deviceId: 'UNSIGNED', name: 'Unsigned', lastSeenAt: time, signedByOwner: false },
                { deviceId: NEW_MAC, name: 'Atum · Mac mini', lastSeenAt: time, signedByOwner: false }
              ]
            )
              .filter(device => (device as { deviceId: string }).deviceId !== deviceOf(side))
              // Verified only through an identity this side trusts.
              .map(device => ({
                crossSigningVerified:
                  identity[side] === 'verified' && (device as { signedByOwner?: boolean }).signedByOwner === true,
                ...(device as object)
              })),
            identity: identity[side]
          }

        case 'approvalMarker':
          markers.push(value.marker)
          security.new = value.marker
            ? {
                ...security.new,
                approvalMarker: {
                  deviceId: value.marker.deviceId,
                  requestedAt: value.marker.requestedAt,
                  expiresAt: value.marker.expiresAt
                }
              }
            : { ...security.new, approvalMarker: undefined }
          security.approver = { ...security.approver, approvalMarker: security.new.approvalMarker }

          return null

        case 'approvalRequest':
          begin('new', 'r')

          if (options.approverIsElementX) {
            // The other device never sees it (asleep, or not Atum).
            set('approver', undefined)
          }

          setTimeout(observe)

          return null

        case 'verificationStart':
          // The approver asking a waiting device (its marker), or the person in Settings.
          begin('approver', 's')
          setTimeout(observe)

          return null
        case 'verificationRespond': {
          if (value.action === 'accept') {
            set('new', { ...security.new.verification!, state: 'ready' })
            set('approver', { ...security.approver.verification!, state: 'ready' })
          } else if (value.action === 'start') {
            both({ state: 'compare', decimals: SAS })
          } else if (value.action === 'confirm') {
            confirmed.add(side)

            if (confirmed.size === 2) {
              both({ state: 'done', decimals: undefined })
            }
          } else if (value.action === 'mismatch') {
            both({ state: 'cancelled', cancelCode: 'm.mismatched_sas', decimals: undefined })
          } else if (value.action === 'cancel') {
            both({ state: 'cancelled', cancelCode: 'm.user', decimals: undefined })
          }

          setTimeout(observe)

          return null
        }

        case 'approveOwnDevice':
          signed.push(value.deviceId)

          return null
        case 'ownerRecoveryToDeviceSend': {
          const kind = value.event.type === 'io.atum.owner_recovery.request' ? 'requests' : 'grants'
          const lost = lose[kind] > 0
          lose[kind] -= lost ? 1 : 0
          sent.push({ side, event: structuredClone(value.event), lost })

          if (!lost) {
            inbox[other(side)].push({
              ...structuredClone(value.event),
              senderDeviceId: deviceOf(side),
              receivedAt: time
            } as MatrixOwnerRecoveryMessage)
          }

          return null
        }

        case 'ownerRecoveryChannelOpen':
          opened.push({ side, to: value.recipient.deviceId, at: calls.length })

          if (options.channelOpen) {
            await options.channelOpen()
          }

          return null
        case 'ownerRecoveryDrops':
          return options.drops?.[side]?.shift() ?? []
        case 'ownerRecoveryToDeviceRead': {
          const box = inbox[side]
          const mine = box.filter(message => message.senderDeviceId === value.senderDeviceId)
          inbox[side] = box.filter(message => message.senderDeviceId !== value.senderDeviceId)

          return mine
        }

        default:
          throw new Error(`unexpected ${value.kind}`)
      }
    })

  const commands = {} as Record<Side, ReturnType<typeof command>>

  const port = (side: Side): MatrixDeviceApprovalPort => {
    commands[side] = command(side)

    return {
      me: () => ({ userId: ME, deviceId: deviceOf(side) }),
      command: commands[side],
      grantable: () => (side === 'approver' && approverKey ? { key: KEY, keyId: 'qwen3.5-plus' } : undefined),
      needsKey: () => side === 'new' && received === undefined && !stale,
      received: async (key, keyId) => {
        received = `${key}|${keyId}`

        return key === KEY
      },
      notify: name => notified.push(name),
      changed: () => {},
      log: line => log.push(`${side}: ${line}`),
      ledger: side === 'approver' ? { read: () => saved, write: value => void (saved = value) } : undefined,
      now: () => time,
      wait: async ms => {
        time += ms
        await new Promise(resolve => setTimeout(resolve))
      },
      random: n => (n === 3 ? 1 : 0)
    }
  }

  approvals.new = new MatrixDeviceApproval(port('new'))
  approvals.approver = new MatrixDeviceApproval(port('approver'))

  return {
    approvals,
    security,
    calls,
    sent,
    opened,
    log,
    notified,
    signed,
    markers,
    inbox,
    lose,
    observe,
    received: () => received,
    settle: () => new Promise(resolve => setTimeout(resolve, 0)),
    advance: (ms: number) => (time += ms),
    /** The person's own action on a device, outside the approval (the generic prompt, Settings). */
    command: (side: Side, value: MatrixSdkCommand) => commands[side](value),
    /** Quit and start Atum again on one device: a new approval over the same SDK and ledger. */
    restart: (side: Side) => {
      approvals[side] = new MatrixDeviceApproval(port(side))
    },
    /** The new Mac's unlock turned `stale` (iCloud Keychain's copy no longer opens the recovery). */
    goStale: () => {
      stale = true
    },
    /** The approver unlocked (holds the key) or not yet. */
    holdKey: (held: boolean) => {
      approverKey = held
    },
    /** The person's identity as one side knows it from now on. */
    identity: (side: Side, value: Identity) => {
      identity[side] = value
    }
  }
}

type World = ReturnType<typeof world>

async function until(check: () => boolean, settle: () => Promise<unknown>, rounds = 400) {
  for (let i = 0; i < rounds && !check(); i++) {
    await settle()
  }

  expect(check()).toBe(true)
}

/** The new Mac asks, the person says it is them on the approver, and the comparison shows. */
async function askAndCompare(w: World) {
  w.approvals.new.dismiss()
  expect(await w.approvals.new.request()).toBe(true)
  await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)
  await w.approvals.approver.accept()
  await until(
    () => w.approvals.approver.view()?.state === 'compare' && w.approvals.new.view()?.state === 'compare',
    w.settle
  )
}

/** The person picks the right code on the approver, then confirms that choice on the new Mac. */
async function pickRight(w: World) {
  await w.approvals.approver.pick(1)
  await w.approvals.new.confirmPicked()
}

/** The new Mac asks again: whether the approver opened its sheet for it. */
async function askAgain(w: World): Promise<boolean> {
  w.approvals.new.dismiss()
  expect(await w.approvals.new.request()).toBe(true)
  await w.settle()
  await w.settle()

  return w.approvals.approver.view()?.state === 'asked'
}

const responses = (w: World, side: Side) =>
  w.calls.flatMap(call => (call.side === side && call.value.kind === 'verificationRespond' ? [call.value.action] : []))

const grants = (w: World) =>
  w.sent.filter(each => each.side === 'approver' && each.event.type === 'io.atum.owner_recovery.grant')

const requests = (w: World) =>
  w.sent.filter(each => each.side === 'new' && each.event.type === 'io.atum.owner_recovery.request')

describe('approving a new Mac from another of the person’s devices', () => {
  it.each(['reply', 'snapshot'] as const)(
    'keeps a fast refusal when the request reaches main through its %s',
    async delivery => {
      const requested: MatrixVerification = {
        id: 'current',
        userId: ME,
        deviceId: MACBOOK,
        incoming: false,
        state: 'requested'
      }

      const cancelled: MatrixVerification = { ...requested, state: 'cancelled', cancelCode: 'm.user' }

      const command = vi.fn(async (value: MatrixSdkCommand) => {
        if (value.kind === 'ownDevices') {
          return { identity: 'new', devices: [{ deviceId: MACBOOK, signedByOwner: true, lastSeenAt: Date.now() }] }
        }

        if (value.kind === 'approvalRequest') {
          if (delivery === 'snapshot') {
            approval.observe({ recovery: 'idle', verification: cancelled })
          }

          return delivery === 'reply' ? cancelled : requested
        }

        return null
      })

      const approval = new MatrixDeviceApproval({
        me: () => ({ userId: ME, deviceId: NEW_MAC }),
        command,
        grantable: () => undefined,
        needsKey: () => true,
        received: async () => false,
        notify() {},
        changed() {},
        log() {}
      })

      expect(await approval.request()).toBe(true)
      expect(approval.view()?.state).toBe('declined')
      expect(command.mock.calls.flatMap(([call]) => (call.kind === 'ownerRecoveryToDeviceSend' ? [call] : []))).toEqual(
        []
      )
    }
  )

  it('does not attach an old cancellation to the request it just sent', async () => {
    const current: MatrixVerification = {
      id: 'current',
      userId: ME,
      deviceId: MACBOOK,
      incoming: false,
      state: 'requested'
    }

    const command = vi.fn(async (value: MatrixSdkCommand) => {
      if (value.kind === 'ownDevices') {
        return { identity: 'new', devices: [{ deviceId: MACBOOK, signedByOwner: true, lastSeenAt: Date.now() }] }
      }

      if (value.kind === 'approvalRequest') {
        approval.observe({
          recovery: 'idle',
          verification: { ...current, id: 'old', state: 'cancelled', cancelCode: 'm.user' }
        })

        return current
      }

      return null
    })

    const approval = new MatrixDeviceApproval({
      me: () => ({ userId: ME, deviceId: NEW_MAC }),
      command,
      grantable: () => undefined,
      needsKey: () => true,
      received: async () => false,
      notify() {},
      changed() {},
      log() {}
    })

    expect(await approval.request()).toBe(true)
    expect(approval.view()?.state).toBe('waiting')
  })

  it('asks only devices that could answer: signed by the person and used in the last 30 days', async () => {
    const lonely = world({ devices: [{ deviceId: 'OLD', lastSeenAt: 0, signedByOwner: true }] })

    expect(await lonely.approvals.new.request()).toBe(false)
    expect(lonely.approvals.new.view()).toBeUndefined()
    expect(lonely.calls.map(call => call.value.kind)).toEqual(['ownDevices'])
  })

  it('looks once more half a minute later when no device could be asked at first, while still needed', async () => {
    for (const needed of [true, false]) {
      // The first sync had not brought the device list yet.
      const devices: unknown[] = []
      const w = world({ devices })
      const asking = w.approvals.new.requestSoon(() => needed)
      await w.settle()
      devices.push({
        deviceId: MACBOOK,
        name: 'Atum · MacBook Pro',
        lastSeenAt: Date.UTC(2026, 9, 5, 7),
        signedByOwner: true
      })

      expect(await asking).toBe(needed)
      expect(w.calls.filter(call => call.value.kind === 'ownDevices')).toHaveLength(needed ? 2 : 1)
      expect(w.approvals.new.view()?.state).toBe(needed ? 'waiting' : undefined)
    }
  })

  it('moves the key with one tap on the right number code, and the new Mac unlocks by itself', async () => {
    const w = world()

    expect(await w.approvals.new.request()).toBe(true)
    // The new Mac names the device to open, and leaves a marker (no secret) for one asleep.
    expect(w.approvals.new.view()).toMatchObject({
      role: 'request',
      state: 'waiting',
      deviceName: 'Atum · MacBook Pro mẫu'
    })
    expect(w.markers[0]).toMatchObject({ deviceId: NEW_MAC })
    expect(JSON.stringify(w.markers)).not.toContain(KEY)

    // The other Mac tells the person and waits for them: an unattended Mac never takes the
    // request from the person's other devices.
    await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)
    expect(w.notified).toHaveLength(1)
    expect(w.calls.some(call => call.side === 'approver' && call.value.kind === 'verificationRespond')).toBe(false)

    // "Yes, it's me": it takes the request and starts the comparison.
    await w.approvals.approver.accept()
    await until(() => w.approvals.approver.view()?.state === 'compare', w.settle)

    // The new Mac shows the complete decimal SAS and waits for the person's confirmation: it has
    // nothing to check the person's identity against, so it confirms
    // nothing by itself.
    await until(() => w.approvals.new.view()?.state === 'compare', w.settle)
    expect(w.approvals.new.view()).toMatchObject({ role: 'request', state: 'compare', numbers: SAS, confirm: true })
    expect(responses(w, 'new')).toEqual([])

    // The approver offers three complete codes: the true tuple and two distinct decoys that share
    // its first value, so comparing that value alone can never select a row.
    const choices = w.approvals.approver.view()!.choices!
    expect(choices).toHaveLength(3)
    expect(choices[1]).toEqual(SAS)
    const shown = new Set(SAS)
    const decoys = choices.filter((_, index) => index !== 1)

    for (const row of decoys) {
      expect(row).toHaveLength(3)
      expect(row[0]).toBe(SAS[0])
      expect(row.slice(1).every(value => !shown.has(value))).toBe(true)
      expect(row.every(value => Number.isSafeInteger(value) && value >= 1000 && value <= 9191)).toBe(true)
    }

    // No decoy value repeats after the first, and the true tuple appears exactly once.
    const rest = decoys.flatMap(row => row.slice(1))
    expect(new Set(rest).size).toBe(4)
    expect(choices.filter(row => JSON.stringify(row) === JSON.stringify(SAS))).toHaveLength(1)
    expect(JSON.stringify(w.approvals.approver.view())).not.toContain(NEW_MAC)

    expect(await w.approvals.approver.pick(1)).toBeUndefined()
    // Picked there; the person says so here, and only then does the new Mac confirm its side.
    expect(responses(w, 'new')).toEqual([])
    await w.approvals.new.confirmPicked()
    expect(responses(w, 'new')).toEqual(['confirm'])
    expect(w.approvals.new.view()?.confirm).toBeUndefined()
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    await until(() => w.approvals.approver.view()?.state === 'done', w.settle)

    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
    expect(w.signed).toEqual([NEW_MAC])
    // The request names the comparison it follows, and the key answers that request.
    const flowId = w.security.new.verification!.flowId
    expect(requests(w)[0]!.event.content.txn).toBe(flowId)
    expect(grants(w)[0]!.event.content).toMatchObject({ txn: flowId, nonce: requests(w)[0]!.event.content.nonce })
    // The marker is cleared once the key arrived.
    expect(w.markers.at(-1)).toBeNull()
    // The key travels only inside the encrypted grant, never in a log line.
    expect(w.log.join('\n')).not.toContain(KEY)
    expect(w.log).toContain('approver: [Matrix] approval role=approve key=sent')
    expect(w.log).toContain('new: [Matrix] approval role=request key=received')
  })

  it.each([
    { decimals: [1000, 1000] },
    { decimals: [1000, 1000, 9192] },
    { decimals: [1000, 1000, 1000.5] }
  ])('fails closed on an invalid decimal SAS and never falls back to emoji: $decimals', async ({ decimals }) => {
    const w = world()
    await askAndCompare(w)
    w.security.new = {
      ...w.security.new,
      verification: {
        ...w.security.new.verification!,
        state: 'compare',
        decimals,
        emoji: [
          ['🐶', 'Dog'],
          ['🐱', 'Cat'],
          ['🦁', 'Lion'],
          ['🐎', 'Horse'],
          ['🦄', 'Unicorn'],
          ['🐷', 'Pig'],
          ['🐘', 'Elephant']
        ]
      }
    }

    w.approvals.new.observe(w.security.new)
    expect(w.approvals.new.view()?.state).toBe('failed')
    expect(responses(w, 'new')).toEqual(['cancel'])
    expect(requests(w)).toEqual([])
  })

  it('refuses on a wrong number code, or on none: nothing is sent and nothing is signed', async () => {
    for (const pick of [0, null]) {
      const w = world()
      await askAndCompare(w)

      // The refused device comes back, for "Sign that device out".
      expect(await w.approvals.approver.pick(pick)).toBe(NEW_MAC)
      await until(() => w.approvals.new.view()?.state === 'mismatch', w.settle)

      expect(w.approvals.approver.view()?.state).toBe('mismatch')
      expect(w.signed).toEqual([])
      expect(w.sent).toEqual([])
      expect(w.received()).toBeUndefined()
      // One answer per comparison.
      await expect(w.approvals.approver.pick(1)).rejects.toThrow('matrix_approval_stale')
    }
  })

  it('a wrong row refuses that device for ten minutes, and a second within a day for a day, across a restart', async () => {
    const w = world()
    await askAndCompare(w)
    await w.approvals.approver.pick(0)
    await until(() => w.approvals.new.view()?.state === 'mismatch', w.settle)

    // It asks again at once: no sheet and no answer, and the request is ended, so the generic
    // verification prompt cannot offer it instead.
    expect(await askAgain(w)).toBe(false)
    await until(() => w.approvals.new.view()?.state === 'declined', w.settle)
    expect(w.notified).toHaveLength(1)
    expect(responses(w, 'approver')).toEqual(['accept', 'start', 'mismatch', 'cancel'])
    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=muted')

    // Ten minutes later it may try once more; a second wrong row refuses it for a day.
    w.advance(11 * MINUTE)
    await askAndCompare(w)
    await w.approvals.approver.pick(2)
    await until(() => w.approvals.new.view()?.state === 'mismatch', w.settle)

    // Two wrong rows, then more requests: no sheet and no answer, after a restart too, and still
    // a day later less a few minutes.
    for (const [restart, later] of [
      [false, 11 * MINUTE],
      [true, 0],
      [false, 24 * HOUR - 14 * MINUTE]
    ] as const) {
      if (restart) {
        w.restart('approver')
      }

      w.advance(later)
      const before = responses(w, 'approver').length
      expect(await askAgain(w)).toBe(false)
      await until(() => w.approvals.new.view()?.state === 'declined', w.settle)
      expect(responses(w, 'approver').slice(before)).toEqual(['cancel'])
    }

    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=refused')
    expect(w.notified).toHaveLength(2)
    expect(w.signed).toEqual([])
    expect(grants(w)).toEqual([])
    expect(w.received()).toBeUndefined()

    // A day after the second wrong row, it may ask again.
    w.advance(5 * MINUTE)
    expect(await askAgain(w)).toBe(true)
  })

  it('“This wasn’t me” refuses that device for a day, across a restart', async () => {
    const w = world()
    await askAndCompare(w)

    expect(await w.approvals.approver.decline()).toBe(NEW_MAC)
    await until(() => w.approvals.new.view()?.state === 'declined', w.settle)
    expect(w.approvals.approver.view()?.state).toBe('declined')
    w.approvals.approver.dismiss()

    // The same device asks again at once, and after a restart hours later: not shown.
    expect(await askAgain(w)).toBe(false)
    w.restart('approver')
    w.advance(23 * HOUR)
    expect(await askAgain(w)).toBe(false)
    expect(grants(w)).toEqual([])

    w.advance(2 * HOUR)
    expect(await askAgain(w)).toBe(true)
  })

  it('opens at most three approval sheets an hour, whichever devices ask', async () => {
    const w = world()

    const asks = (deviceId: string, index: number) => {
      w.security.approver = {
        ...w.security.approver,
        verification: {
          id: `burst-${index}`,
          userId: ME,
          deviceId,
          flowId: `burst-flow-${index}`,
          incoming: true,
          state: 'requested'
        }
      }
      w.approvals.approver.observe(w.security.approver)
      const shown = w.approvals.approver.view()?.state === 'asked'
      w.approvals.approver.dismiss()

      return shown
    }

    expect([0, 1, 2, 3].map(index => asks(`NEW_${index}`, index))).toEqual([true, true, true, false])
    await w.settle()
    expect(w.notified).toHaveLength(3)
    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=limit')
    // The one over the limit is ended, not left to the generic prompt.
    expect(
      w.calls.filter(
        call =>
          call.side === 'approver' &&
          call.value.kind === 'verificationRespond' &&
          call.value.id === 'burst-3' &&
          call.value.action === 'cancel'
      )
    ).toHaveLength(1)

    w.advance(HOUR + MINUTE)
    expect(asks('NEW_4', 4)).toBe(true)
  })

  it('asks again with the same request until the key arrives, and answers a repeated request with the same key', async () => {
    // The first request and the first answer are both lost on the way.
    const w = world({ lose: { requests: 1, grants: 1 } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)

    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
    // The lost request, the one whose answer was lost, and the one answered again: all the same.
    expect(requests(w).length).toBeGreaterThanOrEqual(3)
    expect(new Set(requests(w).map(each => JSON.stringify(each.event.content))).size).toBe(1)
    expect(grants(w).length).toBeGreaterThanOrEqual(2)
    expect(new Set(grants(w).map(each => JSON.stringify(each.event.content))).size).toBe(1)
    expect(w.log).toContain('approver: [Matrix] approval role=approve key=resent')
    // The approving device said done once the key first went out.
    expect(w.approvals.approver.view()?.state).toBe('done')
  })

  it('never answers a request with another nonce, or one from an earlier comparison', async () => {
    // The new Mac's own requests never arrive: only the ones written here do.
    const w = world({ lose: { requests: Infinity } })
    await askAndCompare(w)
    const flowId = w.security.approver.verification!.flowId!
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'unlocking', w.settle)

    const asks = (nonce: string, txn: string) =>
      w.inbox.approver.push({
        type: 'io.atum.owner_recovery.request',
        content: { v: 1, nonce, txn },
        senderDeviceId: NEW_MAC,
        receivedAt: Date.now()
      })

    // A request left from an earlier comparison: never answered.
    asks('A'.repeat(43), 'an-earlier-flow')
    await until(
      () => w.log.includes('approver: [Matrix] approval role=approve request=skipped reason=other_txn'),
      w.settle
    )
    expect(grants(w)).toEqual([])

    // The first request for this comparison binds the answer to its nonce; another nonce gets
    // nothing.
    asks('B'.repeat(43), flowId)
    await until(() => grants(w).length === 1, w.settle)
    asks('C'.repeat(43), flowId)
    await until(() => w.log.includes('approver: [Matrix] approval role=approve request=other_nonce'), w.settle)
    expect(grants(w).map(each => each.event.content.nonce)).toEqual(['B'.repeat(43)])
  })

  it('a key lost on the way is sent again after the next comparison', async () => {
    // Every answer of the first comparison is lost.
    const w = world({ lose: { grants: Infinity } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'failed', w.settle, 2000)
    expect(w.log).toContain('new: [Matrix] approval role=request key=none')
    expect(w.approvals.approver.view()?.state).toBe('done')
    const lost = grants(w).map(each => each.event.content.nonce)
    expect(lost.length).toBeGreaterThanOrEqual(1)

    // "Try again" on the new Mac, with the network back: the person's new comparison is a new
    // approval of the same device, and its key arrives.
    w.lose.grants = 0
    w.approvals.approver.dismiss()
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle, 2000)

    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
    const delivered = grants(w).filter(each => !each.lost)
    expect(delivered).toHaveLength(1)
    expect(lost).not.toContain(delivered[0]!.event.content.nonce)
    expect(w.signed).toEqual([NEW_MAC, NEW_MAC])
  })

  it('says the approval did not finish when the new device never asked for the key', async () => {
    const w = world({ lose: { requests: Infinity } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'failed', w.settle, 2000)

    // Approved and signed, but no key went out, and the log says that device never asked.
    expect(w.signed).toEqual([NEW_MAC])
    expect(grants(w)).toEqual([])
    expect(w.log).toContain('approver: [Matrix] approval role=approve sign=ok')
    expect(w.log).toContain('approver: [Matrix] approval role=approve answer=end result=no_request')
    // Approved here: the sheet says only that it did not finish there.
    expect(w.approvals.approver.view()?.failure).toBe('there')
  })

  it('the person’s own comparison from Settings, on a device that keeps the key, hands it over', async () => {
    for (const approverKey of [true, false]) {
      const w = world({ approverKey })

      // The sheet was closed without an answer: the new Mac's request ended.
      expect(await w.approvals.new.request()).toBe(true)

      if (approverKey) {
        await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)
        w.approvals.approver.dismiss()
      } else {
        // That Mac shows no sheet (it has no key); the person ends the request in its generic
        // prompt, after the new Mac saw it go out.
        await w.settle()
        await w.command('approver', {
          kind: 'verificationRespond',
          id: w.security.approver.verification!.id,
          action: 'cancel'
        })
      }

      await until(() => w.approvals.new.view()?.state === 'declined', w.settle)

      // Settings › Your devices › Verify on the other Mac: the generic prompt there, all seven
      // symbols compared by the person; the new Mac takes part by itself.
      await w.command('approver', { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC })
      await until(() => w.security.approver.verification?.state === 'ready', w.settle)
      const id = w.security.approver.verification!.id
      await w.command('approver', { kind: 'verificationRespond', id, action: 'start' })
      await until(() => w.approvals.new.view()?.state === 'compare', w.settle)
      await w.command('approver', { kind: 'verificationRespond', id, action: 'confirm' })
      await w.approvals.new.confirmPicked()

      if (approverKey) {
        await until(() => w.approvals.new.view()?.state === 'done', w.settle)
        expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
        expect(w.log).toContain('approver: [Matrix] approval role=approve from=settings')
        expect(w.signed).toEqual([NEW_MAC])
      } else {
        // A device without the key has nothing to hand over, and says why it did nothing.
        await until(() => w.approvals.new.view()?.state === 'failed', w.settle, 2000)
        expect(grants(w)).toEqual([])
        expect(w.log).toContain('approver: [Matrix] approval role=approve from=settings skipped reason=no_key')
      }
    }
  })

  it('a new Mac that compared in the generic prompt, with no approval running, asks for the key afterwards', async () => {
    const w = world()

    // Nothing asked from this Mac (no device could be asked at sign-in); the person verifies it
    // from Settings on the other Mac and compares on both screens.
    await w.command('approver', { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC })
    await w.settle()
    expect(w.approvals.new.view()).toBeUndefined()
    await w.command('new', { kind: 'verificationRespond', id: w.security.new.verification!.id, action: 'accept' })
    const id = w.security.approver.verification!.id
    await w.command('approver', { kind: 'verificationRespond', id, action: 'start' })
    await w.settle()
    await w.command('new', { kind: 'verificationRespond', id: w.security.new.verification!.id, action: 'confirm' })
    await w.command('approver', { kind: 'verificationRespond', id, action: 'confirm' })

    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
    expect(w.log).toContain('new: [Matrix] approval role=request after=verification')
    const asked = requests(w).length
    expect(asked).toBeGreaterThanOrEqual(1)

    // Closing the finished card never asks again for the same comparison.
    w.approvals.new.dismiss()
    w.observe()
    await w.settle()
    expect(requests(w)).toHaveLength(asked)
    expect(w.approvals.new.view()).toBeUndefined()
  })

  it('never offers to approve from a Mac that does not hold the key', async () => {
    const w = world({ approverKey: false })
    await w.approvals.new.request()
    await w.settle()
    await w.settle()

    expect(w.approvals.approver.view()).toBeUndefined()
    expect(w.calls.filter(call => call.side === 'approver')).toEqual([])
  })

  it('says so when the other side verified but sent no key (another app approved)', async () => {
    const w = world()
    await askAndCompare(w)

    // An approver that confirms but never answers the key request (Element X).
    w.approvals.approver.reset()
    w.approvals.new.observe(w.security.new)
    await w.command('approver', {
      kind: 'verificationRespond',
      id: w.security.approver.verification!.id,
      action: 'confirm'
    })
    await w.approvals.new.confirmPicked()
    await until(() => w.approvals.new.view()?.state === 'failed', w.settle, 2000)
    expect(w.received()).toBeUndefined()
    expect(w.log).toContain('new: [Matrix] approval role=request key=none')
  })

  it('a device that wakes later asks the waiting Mac itself, from its marker', async () => {
    const w = world({ approverIsElementX: true })
    await w.approvals.new.request()
    await w.settle()

    // A fresh marker is left alone: its request is still alive for whoever wakes in time.
    w.approvals.approver.observe(w.security.approver)
    expect(w.approvals.approver.view()).toBeUndefined()

    // Nobody answered: the request timed out on the new Mac.
    w.advance(11 * MINUTE)
    w.security.new = {
      ...w.security.new,
      verification: { ...w.security.new.verification!, state: 'cancelled', cancelCode: 'm.timeout' }
    }
    w.observe()
    expect(w.approvals.new.view()?.state).toBe('timeout')

    // The MacBook wakes, sees the marker (synced account data), asks the person, and starts from
    // its side once they say it is them.
    w.approvals.approver.observe(w.security.approver)
    expect(w.approvals.approver.view()?.state).toBe('asked')
    expect(w.calls.some(call => call.value.kind === 'verificationStart')).toBe(false)
    await w.approvals.approver.accept()
    await until(() => w.approvals.approver.view()?.state === 'compare', w.settle)
    expect(w.calls).toContainEqual({
      side: 'approver',
      value: { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC }
    })

    await until(() => w.approvals.new.view()?.state === 'compare', w.settle)
    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)

    // A marker is tried once.
    w.approvals.approver.dismiss()
    w.approvals.approver.observe(w.security.approver)
    expect(w.calls.filter(call => call.value.kind === 'verificationStart')).toHaveLength(1)
  })

  it('never verifies, or asks for the key, a device the person’s identity never signed', async () => {
    // Someone who took over the account signs in on their own computer: a real device of the
    // person's account, but one their identity never signed. It answers the new Mac first.
    const answered = world()
    await answered.approvals.new.request()
    answered.security.new = {
      ...answered.security.new,
      verification: {
        id: 'r-new',
        userId: ME,
        deviceId: 'UNSIGNED',
        flowId: 'r-flow',
        incoming: false,
        state: 'compare',
        decimals: SAS
      }
    }
    answered.approvals.new.observe(answered.security.new)
    await until(() => answered.approvals.new.view()?.state === 'failed', answered.settle)

    const from = (w: World, action: string) =>
      w.calls.filter(
        call => call.side === 'new' && call.value.kind === 'verificationRespond' && call.value.action === action
      )

    expect(from(answered, 'confirm')).toEqual([])
    expect(from(answered, 'cancel')).toHaveLength(1)
    expect(requests(answered)).toEqual([])
    expect(answered.log).toContain('new: [Matrix] approval role=request peer=unsigned')

    // It asks the new Mac itself (from the marker): refused, not accepted.
    const asking = world({ approverIsElementX: true })
    await asking.approvals.new.request()
    asking.security.new = {
      ...asking.security.new,
      verification: {
        id: 'x-new',
        userId: ME,
        deviceId: 'UNSIGNED',
        flowId: 'x-flow',
        incoming: true,
        state: 'requested'
      }
    }
    asking.approvals.new.observe(asking.security.new)
    await until(() => asking.approvals.new.view()?.state === 'failed', asking.settle)
    expect(from(asking, 'accept')).toEqual([])
    expect(from(asking, 'cancel')).toHaveLength(1)
  })

  it('leaves a request another of the person’s devices answered to that device', async () => {
    const w = world()
    await w.approvals.new.request()
    await until(() => w.approvals.approver.view() !== undefined, w.settle)

    w.security.approver = {
      ...w.security.approver,
      verification: { ...w.security.approver.verification!, state: 'cancelled', cancelCode: 'm.accepted' }
    }
    w.approvals.approver.observe(w.security.approver)
    expect(w.approvals.approver.view()).toBeUndefined()
  })

  it('a Mac that trusts the person’s identity confirms by itself, but only with a device that identity verified', async () => {
    // Already signed (approved from Element X, say), still without Atum's key.
    const w = world({ identity: { new: 'verified' } })
    await askAndCompare(w)
    expect(w.approvals.new.view()?.confirm).toBeUndefined()
    await until(() => responses(w, 'new').includes('confirm'), w.settle)
    await w.approvals.approver.pick(1)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)

    // Signed by the identity the server serves, but not one this Mac verified: never asked.
    const unverified = world({
      identity: { new: 'verified' },
      devices: [
        { deviceId: MACBOOK, lastSeenAt: Date.UTC(2026, 9, 5, 7), signedByOwner: true, crossSigningVerified: false }
      ]
    })

    expect(await unverified.approvals.new.request()).toBe(false)
  })

  it('a Mac whose identity was replaced from another device or sign-in neither asks nor confirms', async () => {
    const changed = world({ identity: { new: 'changed' } })
    expect(await changed.approvals.new.request()).toBe(false)
    expect(changed.calls.map(call => call.value.kind)).toEqual(['ownDevices'])
    expect(changed.log).toContain('new: [Matrix] approval: the account’s identity changed elsewhere; not asking')

    // Replaced while a request was already out: the comparison is cancelled, never confirmed.
    const w = world()
    expect(await w.approvals.new.request()).toBe(true)
    w.identity('new', 'changed')
    await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)
    await w.approvals.approver.accept()
    await until(() => w.approvals.new.view()?.state === 'failed', w.settle)
    expect(responses(w, 'new')).toEqual(['cancel'])
    expect(w.log).toContain('new: [Matrix] approval role=request peer=identity_changed')
    await expect(w.approvals.new.confirmPicked()).rejects.toThrow('matrix_approval_stale')
    expect(requests(w)).toEqual([])
  })

  it('never sends the key for a comparison finished without the right row on the sheet', async () => {
    const w = world()
    await askAndCompare(w)

    // A "match" sent some other way than the sheet's right row.
    await w.command('approver', {
      kind: 'verificationRespond',
      id: w.security.approver.verification!.id,
      action: 'confirm'
    })
    await w.approvals.new.confirmPicked()
    await until(() => w.approvals.approver.view()?.state === 'failed', w.settle)

    expect(w.log).toContain('approver: [Matrix] approval role=approve done=without_pick')
    expect(w.signed).toEqual([])
    expect(grants(w)).toEqual([])
  })

  it('before it unlocks, turns away a refused device, or one over the hour’s budget, so the generic prompt never offers it', async () => {
    const w = world()
    await askAndCompare(w)
    await w.approvals.approver.pick(0)
    await until(() => w.approvals.new.view()?.state === 'mismatch', w.settle)

    // Atum starts again on the approving Mac; before it unlocks it opens no sheet.
    w.restart('approver')
    w.holdKey(false)
    const before = responses(w, 'approver').length
    expect(await askAgain(w)).toBe(false)
    await until(() => w.approvals.new.view()?.state === 'declined', w.settle)
    expect(responses(w, 'approver').slice(before)).toEqual(['cancel'])

    // Three sheets this hour already: a fifth device is turned away too.
    w.holdKey(true)

    for (const index of [1, 2]) {
      w.security.approver = {
        ...w.security.approver,
        verification: { id: `b-${index}`, userId: ME, deviceId: `NEW_${index}`, incoming: true, state: 'requested' }
      }
      w.approvals.approver.observe(w.security.approver)
      expect(w.approvals.approver.view()?.state).toBe('asked')
      w.approvals.approver.dismiss()
    }

    w.holdKey(false)
    w.security.approver = {
      ...w.security.approver,
      verification: { id: 'b-3', userId: ME, deviceId: 'NEW_3', incoming: true, state: 'requested' }
    }
    w.approvals.approver.observe(w.security.approver)
    await w.settle()
    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=limit')
    expect(
      w.calls.filter(
        call => call.side === 'approver' && call.value.kind === 'verificationRespond' && call.value.id === 'b-3'
      )
    ).toHaveLength(1)
  })

  /** Settings › Your devices › Verify on the approver: the person compares all seven symbols, and
   * the new Mac says it picked them. Returns the comparison's transaction ID. */
  async function settingsComparison(w: World): Promise<string> {
    await w.command('approver', { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC })
    await until(() => w.security.approver.verification?.state === 'ready', w.settle)
    const id = w.security.approver.verification!.id
    const flowId = w.security.approver.verification!.flowId!
    await w.command('approver', { kind: 'verificationRespond', id, action: 'start' })
    await until(() => w.approvals.new.view()?.confirm === true, w.settle)
    await w.command('approver', { kind: 'verificationRespond', id, action: 'confirm' })
    await w.approvals.new.confirmPicked()
    await until(() => w.log.includes('approver: [Matrix] approval role=approve from=settings'), w.settle)

    return flowId
  }

  it('refusing a device stops an answer to it still running from a comparison in Settings', async () => {
    // The new Mac's own key requests never arrive, so the answer keeps waiting for one.
    const w = world({ lose: { requests: Infinity } })
    expect(await w.approvals.new.request()).toBe(true)
    await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)
    w.approvals.approver.dismiss()
    await until(() => w.approvals.new.view()?.state === 'declined', w.settle)
    const flowId = await settingsComparison(w)

    // That device asks again (a sheet this time), and the person says it wasn't them.
    w.security.approver = {
      ...w.security.approver,
      verification: {
        id: 'again',
        userId: ME,
        deviceId: NEW_MAC,
        flowId: 'again-flow',
        incoming: true,
        state: 'requested'
      }
    }
    w.approvals.approver.observe(w.security.approver)
    expect(w.approvals.approver.view()?.state).toBe('asked')
    await w.approvals.approver.decline()

    // A request for the Settings comparison arrives now: nothing goes out.
    w.inbox.approver.push({
      type: 'io.atum.owner_recovery.request',
      content: { v: 1, nonce: 'D'.repeat(43), txn: flowId },
      senderDeviceId: NEW_MAC,
      receivedAt: Date.now()
    })

    for (let round = 0; round < 6; round++) {
      await w.settle()
    }

    expect(grants(w)).toEqual([])
  })

  it('a device refused before a comparison from Settings gets no key from it', async () => {
    const w = world()
    await askAndCompare(w)
    await w.approvals.approver.pick(0)
    await until(() => w.approvals.new.view()?.state === 'mismatch', w.settle)
    w.approvals.approver.dismiss()

    // Its requests for the key arrive, and each is checked against the refusal before an answer.
    await settingsComparison(w)
    await until(() => w.log.includes('approver: [Matrix] approval role=approve key=withheld reason=refused'), w.settle)
    expect(grants(w)).toEqual([])
    expect(w.received()).toBeUndefined()
  })

  it('clears this Mac’s waiting marker once it unlocks, however the key came', async () => {
    const w = world()
    expect(await w.approvals.new.request()).toBe(true)
    expect(w.security.new.approvalMarker?.deviceId).toBe(NEW_MAC)

    // Unlocked with a typed key: the marker goes, so a device that wakes later asks nobody.
    w.approvals.new.unlocked(w.security.new)
    await w.settle()
    expect(w.markers.at(-1)).toBeNull()
    expect(w.security.approver.approvalMarker).toBeUndefined()

    // Another device's marker is left alone.
    const before = w.markers.length
    w.approvals.approver.unlocked({
      recovery: 'idle',
      approvalMarker: { deviceId: NEW_MAC, requestedAt: 1, expiresAt: 2 }
    })
    await w.settle()
    expect(w.markers).toHaveLength(before)
  })

  it('a new Mac whose key goes stale mid-approval cancels its request: “I picked this code” is refused and its marker goes', async () => {
    const w = world()
    await askAndCompare(w)
    expect(w.approvals.new.view()).toMatchObject({ role: 'request', state: 'compare', confirm: true })
    expect(w.security.new.approvalMarker?.deviceId).toBe(NEW_MAC)

    // The iCloud poll finds a key that no longer opens the account's recovery: only a typed key
    // unlocks this Mac now. The tap is refused even before main says so.
    w.goStale()
    await expect(w.approvals.new.confirmPicked()).rejects.toThrow('matrix_approval_stale')

    w.approvals.new.stale(w.security.new)
    await w.settle()
    expect(w.approvals.new.view()).toBeUndefined()
    expect(responses(w, 'new')).toContain('cancel')
    expect(w.markers.at(-1)).toBeNull()
    expect(w.security.approver.approvalMarker).toBeUndefined()
    await expect(w.approvals.new.confirmPicked()).rejects.toThrow('matrix_approval_stale')

    // The comparison ended on both sides: the right row sends nothing and nothing is signed.
    await until(() => w.approvals.approver.view()?.state !== 'compare', w.settle)
    await w.approvals.approver.pick(1).catch(() => undefined)
    await w.settle()
    expect(responses(w, 'new')).not.toContain('confirm')
    expect(grants(w)).toHaveLength(0)
    expect(w.signed).toEqual([])
    expect(w.received()).toBeUndefined()

    // An approver that asks again is never taken as this Mac's request.
    w.command('approver', { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC } as MatrixSdkCommand)
    await w.settle()
    await w.settle()
    expect(w.approvals.new.view()).toBeUndefined()
    expect(responses(w, 'new').filter(action => action === 'accept')).toHaveLength(0)
  })

  it('after the right row, the sheet hides the rows and waits for “I picked this code” on the new Mac', async () => {
    const w = world()
    await askAndCompare(w)

    expect(await w.approvals.approver.pick(1)).toBeUndefined()
    // No row to tap again: the sheet says where the person goes next.
    expect(w.approvals.approver.view()).toMatchObject({ role: 'approve', state: 'compare', picked: true })
    expect(w.approvals.approver.view()?.choices).toBeUndefined()
    await expect(w.approvals.approver.pick(1)).rejects.toThrow('matrix_approval_stale')

    await w.approvals.new.confirmPicked()
    await until(() => w.approvals.approver.view()?.state === 'done', w.settle)
    expect(w.approvals.approver.view()?.picked).toBeUndefined()
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
  })

  it('the new Mac opens its encrypted channel to the approver while the person compares, once, and the approver never does', async () => {
    const w = world()
    await askAndCompare(w)

    // Before any code is tapped: the session exists before the comparison finishes.
    expect(w.opened).toEqual([{ side: 'new', to: MACBOOK, at: expect.any(Number) }])
    expect(w.log).toContain('new: [Matrix] approval role=request channel=open')

    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.opened).toHaveLength(1)
    expect(w.opened.filter(entry => entry.side === 'approver')).toEqual([])
    // It was opened before the new Mac confirmed its side, which is what finishes the comparison.
    const confirm = w.calls.findIndex(
      call => call.side === 'new' && call.value.kind === 'verificationRespond' && call.value.action === 'confirm'
    )
    expect(w.opened[0]!.at).toBeLessThan(confirm)
  })

  it('the new Mac confirms only after its channel is open, and goes on without it when it cannot be opened', async () => {
    let open!: () => void
    const held = new Promise<void>(resolve => (open = resolve))
    const w = world({ channelOpen: () => held })
    await askAndCompare(w)
    await w.approvals.approver.pick(1)

    const confirms = () =>
      w.calls.filter(
        call => call.side === 'new' && call.value.kind === 'verificationRespond' && call.value.action === 'confirm'
      ).length

    const tap = w.approvals.new.confirmPicked()
    await w.settle()
    await w.settle()
    expect(confirms()).toBe(0)
    open()
    await tap
    expect(confirms()).toBe(1)

    // A channel that cannot be opened only logs: the comparison and the key go on as before.
    const failing = world({ fail: { ownerRecoveryChannelOpen: new Error('matrix_not_ready') } })
    await askAndCompare(failing)
    await pickRight(failing)
    await until(() => failing.approvals.new.view()?.state === 'done', failing.settle)
    expect(failing.log).toContain('new: [Matrix] approval role=request channel=failed code=matrix_not_ready')
    expect(failing.received()).toBe(`${KEY}|qwen3.5-plus`)
  })

  it('a comparison that took too long ends on both sides, and Try again on the approver compares again', async () => {
    const w = world()
    await askAndCompare(w)
    await w.approvals.approver.pick(1)

    // The person took more than a minute to tap "I picked this code": the SDK ends the comparison.
    for (const side of ['new', 'approver'] as const) {
      w.security[side] = {
        ...w.security[side],
        verification: {
          ...w.security[side].verification!,
          state: 'cancelled',
          cancelCode: 'm.timeout',
          decimals: undefined
        }
      }
    }

    w.observe()
    expect(w.approvals.new.view()?.state).toBe('timeout')
    expect(w.approvals.approver.view()?.state).toBe('timeout')
    // The late tap changes nothing.
    await expect(w.approvals.new.confirmPicked()).rejects.toThrow('matrix_approval_stale')

    // Try again, on the approver: it asks that device again, without opening another sheet.
    const prompts = w.notified.length
    await w.approvals.approver.again()
    expect(w.calls).toContainEqual({
      side: 'approver',
      value: { kind: 'verificationStart', userId: ME, deviceId: NEW_MAC }
    })
    await until(
      () => w.approvals.approver.view()?.state === 'compare' && w.approvals.new.view()?.state === 'compare',
      w.settle
    )
    expect(w.notified).toHaveLength(prompts)
    expect(w.approvals.new.view()?.confirm).toBe(true)

    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle)
    expect(w.received()).toBe(`${KEY}|qwen3.5-plus`)
    expect(w.log).toContain('approver: [Matrix] approval role=approve again')
  })

  it('Try again on the approver only after a comparison that timed out, and only while it keeps the key', async () => {
    const w = world()
    await expect(w.approvals.approver.again()).rejects.toThrow('matrix_approval_stale')

    await askAndCompare(w)
    await expect(w.approvals.approver.again()).rejects.toThrow('matrix_approval_stale')

    for (const side of ['new', 'approver'] as const) {
      w.security[side] = {
        ...w.security[side],
        verification: {
          ...w.security[side].verification!,
          state: 'cancelled',
          cancelCode: 'm.timeout',
          decimals: undefined
        }
      }
    }

    w.observe()
    w.holdKey(false)
    await expect(w.approvals.approver.again()).rejects.toThrow('matrix_approval_stale')
    expect(w.calls.filter(call => call.value.kind === 'verificationStart')).toHaveLength(0)

    w.holdKey(true)
    await w.approvals.approver.again()
    expect(w.calls.filter(call => call.value.kind === 'verificationStart')).toHaveLength(1)
  })
})

describe('the hourly budget and the person’s own retries', () => {
  /** The person's phone, already approved: their identity signed it (security.ts `ownDevices`). */
  const PHONE = 'OLD_PHONE'

  /** One of the person's devices asks the approver; whether a sheet opened for it. Each request
   * is its own, and the sheet is closed afterwards ("not now"). */
  async function asks(w: World, deviceId: string, id: string, close: 'dismiss' | 'decline' = 'dismiss') {
    w.security.approver = {
      ...w.security.approver,
      verification: { id, userId: ME, deviceId, flowId: `${id}-flow`, incoming: true, state: 'requested' }
    }
    w.approvals.approver.observe(w.security.approver)
    await w.settle()
    await w.settle()
    const shown = w.approvals.approver.view()?.state === 'asked'

    if (close === 'decline' && shown) {
      await w.approvals.approver.decline()
    }

    w.approvals.approver.dismiss()
    await w.settle()

    return shown
  }

  it('a retry from a phone or Mac the person already approved neither waits for the budget nor uses it up', async () => {
    // Four retries from the phone first, then fresh devices: the budget is still whole.
    const w = world()

    for (let index = 0; index < 4; index++) {
      expect(await asks(w, PHONE, `phone-${index}`)).toBe(true)
    }

    expect(w.log).toContain('approver: [Matrix] approval role=approve budget=exempt reason=own_device')

    for (let index = 0; index < 3; index++) {
      expect(await asks(w, `NEW_${index}`, `fresh-${index}`)).toBe(true)
    }

    expect(await asks(w, 'NEW_3', 'fresh-3')).toBe(false)
    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=limit')
    expect(w.log).not.toContain('approver: [Matrix] approval role=approve budget=unchecked')
  })

  it('once fresh devices spent the budget, the person’s retries still reach them, across a restart', async () => {
    const w = world()

    for (let index = 0; index < 3; index++) {
      expect(await asks(w, `NEW_${index}`, `fresh-${index}`)).toBe(true)
    }

    // The 03:53 retry that was turned away: now it opens the sheet.
    expect(await asks(w, PHONE, 'phone-1')).toBe(true)
    expect(w.log).toContain(
      'approver: [Matrix] approval role=approve budget=exempt reason=own_device over=limit'
    )
    w.restart('approver')
    expect(await asks(w, PHONE, 'phone-2')).toBe(true)

    // A fresh device is still turned away, and its request ended rather than left to the
    // generic prompt.
    expect(await asks(w, 'NEW_3', 'fresh-3')).toBe(false)
    expect(
      w.calls.filter(
        call =>
          call.side === 'approver' &&
          call.value.kind === 'verificationRespond' &&
          call.value.id === 'fresh-3' &&
          call.value.action === 'cancel'
      )
    ).toHaveLength(1)
    expect(w.notified).toHaveLength(5)
  })

  it('a device the person refused stays refused, budget or not', async () => {
    const w = world()

    expect(await asks(w, PHONE, 'phone-1', 'decline')).toBe(true)
    expect(await asks(w, PHONE, 'phone-2')).toBe(false)
    expect(w.log).toContain('approver: [Matrix] approval role=approve refused reason=refused')

    for (let index = 0; index < 3; index++) {
      await asks(w, `NEW_${index}`, `fresh-${index}`)
    }

    expect(await asks(w, PHONE, 'phone-3')).toBe(false)
  })

  it('turns away a fresh device over the budget when the device list cannot be read', async () => {
    const fail: WorldOptions['fail'] = {}
    const w = world({ fail })

    for (let index = 0; index < 3; index++) {
      await asks(w, `NEW_${index}`, `fresh-${index}`)
    }

    // Nothing proves it is the person's own device, so it counts as any other.
    fail.ownDevices = new Error('matrix_not_ready')
    expect(await asks(w, PHONE, 'phone-1')).toBe(false)
    expect(w.log).toContain('approver: [Matrix] approval role=approve budget=unchecked')
  })
})

describe('what each side logs after the comparison', () => {
  const never = (w: World, secrets: string[]) => {
    for (const line of w.log) {
      for (const secret of secrets) {
        expect(line).not.toContain(secret)
      }
    }
  }

  it('says each stage, in order, with no key, nonce, comparison or device in any line', async () => {
    const w = world()
    await askAndCompare(w)
    const flowId = w.security.approver.verification!.flowId!
    await pickRight(w)
    await until(() => w.approvals.new.view()?.state === 'done', w.settle, 2000)
    await until(() => w.log.some(line => line.includes('answer=end')), w.settle, 2000)

    const stages = (side: Side, wanted: string[]) =>
      w.log
        .filter(line => line.startsWith(`${side}: `))
        .map(line => line.slice(side.length + 2))
        .filter(line => wanted.includes(line))

    const approver = [
      '[Matrix] approval role=approve accepted',
      '[Matrix] approval role=approve pick=match',
      '[Matrix] approval role=approve done',
      '[Matrix] approval role=approve sign=ok',
      '[Matrix] approval role=approve key=sent',
      '[Matrix] approval role=approve answer=end result=sent'
    ]

    const requester = [
      '[Matrix] approval role=request done',
      '[Matrix] approval role=request key_request=sent',
      '[Matrix] approval role=request key=received'
    ]

    expect(stages('approver', approver)).toEqual(approver)
    expect(stages('new', requester)).toEqual(requester)
    never(w, [KEY, ME, NEW_MAC, MACBOOK, flowId, ...requests(w).map(each => each.event.content.nonce)])
  })

  it('says why the approver sent nothing: an earlier comparison, or this Mac no longer holding the key', async () => {
    const w = world({ lose: { requests: Infinity } })
    await askAndCompare(w)
    const flowId = w.security.approver.verification!.flowId!
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'unlocking', w.settle)

    const asks = (txn: string) =>
      w.inbox.approver.push({
        type: 'io.atum.owner_recovery.request',
        content: { v: 1, nonce: 'N'.repeat(43), txn },
        senderDeviceId: NEW_MAC,
        receivedAt: Date.now()
      })

    asks('an-earlier-flow')
    await until(
      () => w.log.includes('approver: [Matrix] approval role=approve request=skipped reason=other_txn'),
      w.settle
    )

    // Locked meanwhile: the request for this comparison gets nothing, and the answer ends.
    w.holdKey(false)
    asks(flowId)
    await until(
      () => w.log.includes('approver: [Matrix] approval role=approve answer=end result=no_key'),
      w.settle
    )
    expect(w.log).toContain('approver: [Matrix] approval role=approve key=withheld reason=no_key')
    expect(grants(w)).toEqual([])
    await until(() => w.approvals.approver.view()?.state === 'failed', w.settle)
    never(w, ['N'.repeat(43), flowId, NEW_MAC])
  })

  it('names each reason the carrier dropped a message, and only the reasons it knows', async () => {
    const w = world({
      lose: { requests: Infinity },
      drops: {
        approver: [
          [
            { reason: 'unverified_sender', count: 2 },
            { reason: `from ${NEW_MAC}`, count: 1 },
            { reason: 'not_encrypted', count: -1 },
            { reason: 'overflow', count: 1.5 }
          ]
        ]
      }
    })

    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.log.some(line => line.includes('carrier_drop')), w.settle)

    expect(w.log.filter(line => line.includes('carrier_drop'))).toEqual([
      'approver: [Matrix] approval role=approve carrier_drop reason=unverified_sender count=2'
    ])
    never(w, [NEW_MAC])
  })

  it('logs a signing failure by its code, never by its text', async () => {
    for (const [error, code] of [
      [new Error('matrix_not_ready'), 'matrix_not_ready'],
      [new Error(`could not sign ${NEW_MAC} for ${ME}`), 'error']
    ] as const) {
      const w = world({ fail: { approveOwnDevice: error } })
      await askAndCompare(w)
      await pickRight(w)
      await until(() => w.log.includes(`approver: [Matrix] approval role=approve sign=failed code=${code}`), w.settle)
      never(w, [NEW_MAC, ME])
    }
  })

  it('a device that was never signed here fails as this Mac’s own part, not as one approved', async () => {
    const w = world({ lose: { requests: Infinity }, fail: { approveOwnDevice: new Error('matrix_not_ready') } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'failed', w.settle, 2000)

    expect(w.signed).toEqual([])
    expect(w.log).toContain('approver: [Matrix] approval role=approve answer=end result=no_request')
    expect(w.approvals.approver.view()?.failure).toBe('here')
  })

  it('the approved device asking again while this Mac still waits for it opens the sheet again', async () => {
    const w = world({ lose: { requests: Infinity } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'unlocking', w.settle)
    await until(() => w.log.includes('approver: [Matrix] approval role=approve sign=ok'), w.settle)

    // The person tries again on that device within the two-minute wait.
    w.security.approver = {
      ...w.security.approver,
      verification: { id: 'retry-1', userId: ME, deviceId: NEW_MAC, flowId: 'retry-1-flow', incoming: true, state: 'requested' }
    }
    w.approvals.approver.observe(w.security.approver)
    await until(() => w.approvals.approver.view()?.state === 'asked', w.settle)

    expect(w.log).toContain('approver: [Matrix] approval role=approve request=takeover')
    await until(
      () => w.log.includes('approver: [Matrix] approval role=approve answer=end result=superseded'),
      w.settle
    )
    // The old wait ending never turns the new sheet into a failure.
    expect(w.approvals.approver.view()?.state).toBe('asked')
    expect(w.log).not.toContain('approver: [Matrix] approval role=approve request=ignored reason=busy')
  })

  it('another device asking while this Mac still waits says, once, that it was not opened', async () => {
    const w = world({ lose: { requests: Infinity } })
    await askAndCompare(w)
    await pickRight(w)
    await until(() => w.approvals.approver.view()?.state === 'unlocking', w.settle)

    w.security.approver = {
      ...w.security.approver,
      verification: { id: 'other-1', userId: ME, deviceId: 'OTHER', flowId: 'other-1-flow', incoming: true, state: 'requested' }
    }

    for (let round = 0; round < 3; round++) {
      w.approvals.approver.observe(w.security.approver)
      await w.settle()
    }

    expect(w.approvals.approver.view()?.state).toBe('unlocking')
    expect(w.log.filter(line => line.includes('request=ignored'))).toEqual([
      'approver: [Matrix] approval role=approve request=ignored reason=busy'
    ])
    never(w, ['OTHER', 'other-1'])
  })

  it('a comparison that finished without naming the other device says so instead of spinning', async () => {
    const lines: string[] = []
    const requested: MatrixVerification = { id: 'current', userId: ME, deviceId: '', incoming: false, state: 'requested' }

    const approval = new MatrixDeviceApproval({
      me: () => ({ userId: ME, deviceId: NEW_MAC }),
      command: async value =>
        value.kind === 'ownDevices'
          ? { identity: 'new', devices: [{ deviceId: MACBOOK, signedByOwner: true, lastSeenAt: Date.now() }] }
          : value.kind === 'approvalRequest'
            ? requested
            : null,
      grantable: () => undefined,
      needsKey: () => true,
      received: async () => false,
      notify() {},
      changed() {},
      log: line => lines.push(line)
    })

    expect(await approval.request()).toBe(true)
    approval.observe({ recovery: 'idle', verification: { ...requested, state: 'done' } })

    expect(approval.view()?.state).toBe('failed')
    expect(lines).toContain('[Matrix] approval role=request done=missing_flow')
  })
})
