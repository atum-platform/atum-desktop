import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DEVICE_CONNECTION,
  DEVICE_FRAME_BODY_MAX_BYTES,
  DEVICE_HUB_URL,
  deviceArtifactFrames,
  DeviceConnection,
  type DeviceFrameSink,
  type DeviceHelloFacts,
  deviceHubUrl,
  type DeviceInboundFrame,
  type DeviceSession,
  type DeviceSocket,
  deviceStatusPlan
} from './connection'
import {
  b64u,
  canonicalJson,
  DeviceKeyError,
  deviceMessageHash,
  deviceSignedBytes,
  keyId,
  sha256,
  verifyDeviceSignature
} from './device-key'
import { SoftwareDeviceSigner } from './device-signer.fixture'
import { DeviceEnrollment, type DeviceEnrollmentRecord } from './enrollment'

const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures')
const fixture = (name: string) => JSON.parse(readFileSync(join(packs, 'device-service', 'fixtures', name), 'utf8'))

/** A controller signing key, as the hub holds it. */
function controller() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })

  return { kid: keyId(spki), publicKey: b64u(spki), privateKey }
}

function envelope(key: { kid: string; privateKey: KeyObject }, type: string, body: Record<string, unknown>) {
  return JSON.stringify({
    v: 1,
    type,
    body,
    kid: key.kid,
    sig: b64u(sign(null, deviceSignedBytes(type, body), key.privateKey))
  })
}

class FakeSocket implements DeviceSocket {
  readyState = 0
  sent: { type: string; body: Record<string, unknown>; kid: string; sig: string }[] = []
  /** Binary frames (artifact chunks), in order among the text frames' positions. */
  binary: { at: number; data: Uint8Array }[] = []
  closed?: string
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {}

  send(data: string | Uint8Array) {
    if (typeof data === 'string') {
      this.sent.push(JSON.parse(data))
    } else {
      this.binary.push({ at: this.sent.length, data })
    }
  }

  close(_code?: number, reason?: string) {
    this.closed = reason ?? 'closed'
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  /** What the hub sends; dropped like a real socket's events once the handlers are detached. */
  deliver(data: string) {
    this.onmessage?.({ data })
  }

  last(type: string) {
    return [...this.sent].reverse().find(frame => frame.type === type)
  }
}

/** Lets queued frame work and signing settle. */
const settle = async () => {
  for (let index = 0; index < 20; index++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function harness(
  options: {
    sink?: DeviceFrameSink
    extraPins?: { kid: string; publicKey: string }[]
    log?: string[]
    hello?: () => DeviceHelloFacts
  } = {}
) {
  const hub = controller()
  const signer = new SoftwareDeviceSigner()
  const sockets: FakeSocket[] = []
  /** `at`: when the timer is due on the harness clock (`advance`). */
  const timers: { ms: number; at: number; callback: () => void; cleared: boolean }[] = []
  let clock = 0
  let generation = 1
  let accountEpoch = 7

  const record: DeviceEnrollmentRecord = {
    v: 1,
    ownerUserId: '@owner-3f9a1c7e5b2d:atumplatform.com',
    deviceServiceId: '00000000-0000-4000-8000-b86a6ca39e23',
    enrollmentEpoch: 3,
    identityKid: signer.identity.public.kid,
    approvalKid: signer.approval.public.kid,
    matrixDeviceId: 'MACBOOKQ7ZK',
    matrixFingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho',
    scopes: ['terminal', 'files', 'computer', 'send_file'],
    pinnedControllerKeys: [hub.kid, ...(options.extraPins ?? []).map(pin => pin.kid)],
    controllerKeys: [{ kid: hub.kid, publicKey: hub.publicKey }, ...(options.extraPins ?? [])],
    revokeSeq: 4,
    state: 'active',
    updatedAt: 0
  }

  const stored = new Map<string, string>([['device-enrollment-v1', JSON.stringify(record)]])

  const enrollment = new DeviceEnrollment({
    store: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: key => void stored.delete(key),
      failureCode: () => null
    },
    signer,
    transport: {} as never,
    displayName: () => 'MacBook Pro',
    osVersion: () => '26.6.2'
  })

  const frames: { frame: DeviceInboundFrame; session: DeviceSession }[] = []
  const closes: string[] = []

  const sink: DeviceFrameSink = options.sink ?? {
    frame: (frame, session) => void frames.push({ frame, session }),
    status: query => ({ receipts: query.commandIds.length ? [] : [] }),
    closed: (_session, reason) => void closes.push(reason),
    liveGrantIds: () => ['00000000-0000-4000-8000-fce915c29383']
  }

  const connection = new DeviceConnection({
    url: DEVICE_HUB_URL,
    socket: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)

      return socket
    },
    enrollment,
    signer,
    epochs: {
      accountEpoch: () => accountEpoch,
      bootId: () => '00000000-0000-4000-8000-354570CD5E97',
      localGeneration: () => generation,
      bumpLocalGeneration: () => ++generation
    },
    hello:
      options.hello ??
      (() => ({
        policyVersion: 1,
        appVersion: '0.18.0',
        capabilities: { terminal: true, files: true, computer: { available: true } }
      })),
    sink,
    random: () => 0.5,
    setTimer: (callback, ms) => {
      const timer = { ms, at: clock + ms, callback, cleared: false }
      timers.push(timer)

      return timer
    },
    clearTimer: timer => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    log: line => void options.log?.push(line)
  })

  /** Hub side of the handshake on `socket`, up to (and optionally through) the status exchange. */
  async function handshake(socket: FakeSocket, through: 'ready' | 'status' = 'status') {
    socket.open()
    await settle()
    const hello = socket.last('Hello')!
    const connectionId = randomUUID()
    const challenge = b64u(randomBytes(32))
    socket.deliver(
      envelope(hub, 'Challenge', {
        connectionId,
        challenge,
        helloHash: deviceMessageHash('Hello', hello.body),
        issuedAt: 1
      })
    )
    await settle()
    socket.deliver(envelope(hub, 'Ready', { connectionId, connectionEpoch: 12, heartbeatMs: 5000, serverTime: 2 }))
    await settle()

    if (through === 'status') {
      socket.deliver(envelope(hub, 'StatusQuery', { commandIds: [] }))
      await settle()
    }

    return { connectionId, challenge, hello }
  }

  function execute(connectionId: string, seq = 1) {
    return {
      commandId: randomUUID(),
      grantId: '00000000-0000-4000-8000-fce915c29383',
      seq,
      connectionId,
      connectionEpoch: 12,
      deviceServiceId: record.deviceServiceId,
      enrollmentEpoch: 3,
      accountEpoch: 7,
      tool: 'terminal',
      toolVersion: 1,
      args: { command: 'date' },
      argsHash: 'x'.repeat(43),
      inputManifestHash: null,
      needs: [],
      proposedEffect: 'ordinary',
      admitBy: 99,
      timeoutMs: 1000,
      issuedAt: 1
    }
  }

  const due = () => timers.filter(timer => !timer.cleared)

  /** Moves the clock on by `ms`, firing each timer when it falls due (re-armed ones included). */
  function advance(ms: number) {
    const until = clock + ms

    for (;;) {
      const next = due()
        .filter(timer => timer.at <= until)
        .sort((a, b) => a.at - b.at)[0]

      if (!next) {
        break
      }

      clock = next.at
      next.cleared = true
      next.callback()
    }

    clock = until
  }

  return {
    hub,
    signer,
    sockets,
    timers,
    due,
    advance,
    connection,
    enrollment,
    frames,
    closes,
    record,
    handshake,
    execute,
    generation: () => generation,
    setAccountEpoch: (value: number) => (accountEpoch = value)
  }
}

const GRANT = '00000000-0000-4000-8000-fce915c29383'

/** A device service that accepts every grant and ends it on Cancel, on expiry, or when its link closes. */
function grantSink() {
  const live = new Set<string>()
  const closes: string[] = []

  const sink: DeviceFrameSink = {
    frame(frame) {
      const grantId = typeof frame.body.grantId === 'string' ? frame.body.grantId : ''

      if (frame.type === 'TurnGrant') {
        live.add(grantId)

        return [{ type: 'GrantAck', body: { grantId, accepted: true, effectiveScopes: ['terminal'] } }]
      }

      if (frame.type === 'Cancel') {
        live.delete(grantId)
      }
    },
    status: () => ({ receipts: [] }),
    closed: (_session, reason) => {
      live.clear()
      closes.push(reason)
    },
    liveGrants: () => live.size > 0,
    liveGrantIds: () => [...live]
  }

  return { sink, closes, live: () => live.size > 0, expire: () => live.clear() }
}

/** Lets `ms` pass on the harness clock: timers fire when due, counted from when each was armed. */
function elapse(h: { advance(ms: number): void }, ms: number) {
  h.advance(ms)
}

describe('the device hub connection', () => {
  it('runs Hello, Challenge, Proof, Ready, then the status exchange, all signed', async () => {
    const h = harness()
    h.connection.start()
    const socket = h.sockets[0]!
    expect(socket.url).toBe('wss://devices.atumplatform.com/v1')

    const { connectionId, challenge, hello } = await h.handshake(socket, 'ready')

    // Hello: identity-signed, naming this service, its epochs, this boot and a fresh nonce.
    expect(
      verifyDeviceSignature(h.signer.identity.public.spki, deviceSignedBytes('Hello', hello.body), hello.sig)
    ).toBe(true)
    expect(Object.keys(hello.body).sort()).toEqual(Object.keys(fixture('hello.frame.json').body).sort())
    expect(hello.body).toMatchObject({
      deviceServiceId: h.record.deviceServiceId,
      enrollmentEpoch: 3,
      accountEpoch: 7,
      bootId: '00000000-0000-4000-8000-354570CD5E97',
      matrixDeviceId: 'MACBOOKQ7ZK'
    })
    expect(hello.body.connectionNonce).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // Proof answers this Challenge for this Hello.
    const proof = socket.last('Proof')!
    expect(proof.body).toEqual({ connectionId, challenge, helloHash: deviceMessageHash('Hello', hello.body) })
    expect(
      verifyDeviceSignature(h.signer.identity.public.spki, deviceSignedBytes('Proof', proof.body), proof.sig)
    ).toBe(true)
    expect(h.connection.state()).toBe('ready')
    expect(h.connection.session()).toBeNull()

    socket.deliver(envelope(h.hub, 'StatusQuery', { commandIds: [] }))
    await settle()
    expect(h.connection.state()).toBe('status_exchanged')
    expect(socket.last('Status')!.body).toEqual({ receipts: [] })
    expect(h.connection.session()).toMatchObject({
      connectionId,
      connectionEpoch: 12,
      accountEpoch: 7,
      enrollmentEpoch: 3
    })

    // Only now do commands reach the device service, with their verdict and session.
    const body = h.execute(connectionId)
    socket.deliver(envelope(h.hub, 'Execute', body))
    await settle()
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]!.frame).toMatchObject({ type: 'Execute', verdict: 'ok', body })
    expect(h.frames[0]!.session.connectionId).toBe(connectionId)
  })

  it('never drains a command the hub sends before the status exchange', async () => {
    const h = harness()
    h.connection.start()
    const socket = h.sockets[0]!
    const { connectionId } = await h.handshake(socket, 'ready')

    socket.deliver(envelope(h.hub, 'Execute', h.execute(connectionId)))
    await settle()

    expect(h.frames).toHaveLength(0)
    expect(h.connection.state()).toBe('closed')
    expect(h.connection.closeReason()).toBe('protocol')
    expect(socket.closed).toBeDefined()
  })

  it('after sleep, drains nothing: the old connection is dead and the new one exchanges statuses first', async () => {
    const h = harness()
    h.connection.start()
    const first = h.sockets[0]!
    const { connectionId } = await h.handshake(first)
    const before = h.generation()

    h.connection.suspend()

    // The fence came first: a new local generation, the grants on that connection told it is dead.
    expect(h.generation()).toBe(before + 1)
    expect(h.closes).toEqual(['sleep'])
    expect(h.connection.state()).toBe('closed')

    // A command that was already in flight on the old socket is never handed on.
    first.deliver(envelope(h.hub, 'Execute', h.execute(connectionId)))
    await settle()
    expect(h.frames).toHaveLength(0)

    // The controller is told, signed, before the socket closes.
    const stop = first.last('Stop')!
    expect(stop.body).toEqual({ reason: 'sleep', accountEpoch: 7, grantIds: ['00000000-0000-4000-8000-fce915c29383'] })
    expect(verifyDeviceSignature(h.signer.identity.public.spki, deviceSignedBytes('Stop', stop.body), stop.sig)).toBe(
      true
    )
    expect(first.closed).toBe('sleep')

    // Asleep: no redial.
    expect(h.sockets).toHaveLength(1)
    expect(
      h.due().filter(timer => timer.ms >= DEVICE_CONNECTION.backoffMinMs && timer.ms <= DEVICE_CONNECTION.backoffMaxMs)
    ).toHaveLength(0)

    h.connection.resume()
    const second = h.sockets[1]!
    expect(second).toBeDefined()

    const { connectionId: next } = await h.handshake(second, 'ready')
    expect(second.last('Hello')!.body.connectionNonce).not.toBe(first.last('Hello')!.body.connectionNonce)

    // A replayed command before the status exchange is still refused delivery.
    second.deliver(envelope(h.hub, 'Execute', h.execute(next)))
    await settle()
    expect(h.frames).toHaveLength(0)
  })

  it('refuses a Challenge from a controller key it never pinned, and stops dialling', async () => {
    const h = harness()
    const stranger = controller()
    h.connection.start()
    const socket = h.sockets[0]!
    socket.open()
    await settle()
    const hello = socket.last('Hello')!

    socket.deliver(
      envelope(stranger, 'Challenge', {
        connectionId: randomUUID(),
        challenge: b64u(randomBytes(32)),
        helloHash: deviceMessageHash('Hello', hello.body),
        issuedAt: 1
      })
    )
    await settle()

    expect(socket.last('Proof')).toBeUndefined()
    expect(h.connection.closeReason()).toBe('unpinned')
    expect(
      h.due().some(timer => timer.ms >= DEVICE_CONNECTION.backoffMinMs && timer.ms <= DEVICE_CONNECTION.backoffMaxMs)
    ).toBe(false)
  })

  it('refuses a Challenge that answers another Hello, or carries a bad signature', async () => {
    for (const damage of ['hello', 'signature'] as const) {
      const h = harness()
      h.connection.start()
      const socket = h.sockets[0]!
      socket.open()
      await settle()

      const body = {
        connectionId: randomUUID(),
        challenge: b64u(randomBytes(32)),
        helloHash: damage === 'hello' ? 'A'.repeat(43) : deviceMessageHash('Hello', socket.last('Hello')!.body),
        issuedAt: 1
      }

      const frame = JSON.parse(envelope(h.hub, 'Challenge', body))

      // A changed character in the middle: every bit there is significant (the last character of an
      // 86-character signature carries only two, so changing the tail can leave it valid).
      if (damage === 'signature') {
        frame.sig = `${frame.sig.slice(0, 10)}${frame.sig[10] === 'A' ? 'B' : 'A'}${frame.sig.slice(11)}`
      }

      socket.deliver(JSON.stringify(frame))
      await settle()

      expect(socket.last('Proof'), damage).toBeUndefined()
      expect(h.connection.closeReason(), damage).toBe('protocol')
    }
  })

  it('hands a badly signed command to admission with its verdict, so it is refused with a receipt', async () => {
    const h = harness({})
    h.connection.start()
    const socket = h.sockets[0]!
    const { connectionId } = await h.handshake(socket)

    const frame = JSON.parse(envelope(h.hub, 'Execute', h.execute(connectionId)))
    frame.body.args = { command: 'rm -rf ~' }
    socket.deliver(JSON.stringify(frame))
    await settle()

    expect(h.frames[0]!.frame.verdict).toBe('bad_signature')
  })

  it('refuses every command definitively while no device runtime is attached', async () => {
    const h = harness({ sink: undefined })

    // The harness wires its own sink; this one uses the refusing default.
    const fresh = new DeviceConnection({
      url: DEVICE_HUB_URL,
      socket: url => {
        const socket = new FakeSocket(url)
        h.sockets.push(socket)

        return socket
      },
      enrollment: h.enrollment,
      signer: h.signer,
      epochs: {
        accountEpoch: () => 7,
        bootId: () => '00000000-0000-4000-8000-354570CD5E97',
        localGeneration: () => 1,
        bumpLocalGeneration: () => 2
      },
      hello: () => ({
        policyVersion: 1,
        appVersion: '0.18.0',
        capabilities: {
          terminal: false,
          files: false,
          computer: { available: false, reason: 'device runtime not installed' }
        }
      })
    })

    fresh.start()
    const socket = h.sockets.at(-1)!
    const { connectionId } = await h.handshake(socket)
    const body = h.execute(connectionId)
    socket.deliver(envelope(h.hub, 'Execute', body))
    socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: '00000000-0000-4000-8000-3e33997397c1' }))
    await settle()

    const receipt = socket.last('Receipt')!
    expect(receipt.body).toEqual({
      commandId: body.commandId,
      commandHash: deviceMessageHash('Execute', body),
      seq: 1,
      state: 'refused',
      refusal: 'scope',
      artifacts: []
    })
    expect(
      verifyDeviceSignature(h.signer.identity.public.spki, deviceSignedBytes('Receipt', receipt.body), receipt.sig)
    ).toBe(true)
    expect(socket.last('GrantAck')!.body).toEqual({
      grantId: '00000000-0000-4000-8000-3e33997397c1',
      accepted: false,
      refusal: 'scope',
      effectiveScopes: []
    })
  })

  it('backs off from 1 s to 30 s between failed dials, and resets once connected', async () => {
    const h = harness()
    h.connection.start()
    const delays: number[] = []

    for (let attempt = 0; attempt < 7; attempt++) {
      const socket = h.sockets.at(-1)!
      socket.onclose?.({})
      const retry = h.due().find(timer => timer.ms >= 1000 && timer.ms <= 30_000)!
      delays.push(retry.ms)
      retry.cleared = true
      retry.callback()
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])

    await h.handshake(h.sockets.at(-1)!)
    h.sockets.at(-1)!.onclose?.({})
    expect(h.due().find(timer => timer.ms >= 1000 && timer.ms <= 30_000)!.ms).toBe(1000)
  })

  it('keeps an idle link with no grants up long past two minutes: the hub pings it, it sends nothing', async () => {
    const log: string[] = []
    const grants = grantSink()
    const h = harness({ sink: grants.sink, log })
    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket)

    elapse(h, 60 * 60_000)

    expect(h.connection.state()).toBe('status_exchanged')
    expect(h.sockets).toHaveLength(1)
    expect(socket.closed).toBeUndefined()
    expect(grants.closes).toEqual([])
    expect(log.filter(line => line.includes('connection closed'))).toEqual([])
  })

  it('drops a link that goes silent while a grant is live, then dials again', async () => {
    const log: string[] = []
    const grants = grantSink()
    const h = harness({ sink: grants.sink, log })
    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket)

    socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: GRANT }))
    await settle()
    expect(socket.last('GrantAck')!.body).toMatchObject({ grantId: GRANT, accepted: true })

    // Renewals keep it up, for twice as long as the TurnGrant alone would have allowed.
    const renewals = Math.ceil((2 * DEVICE_CONNECTION.grantSilenceMs) / DEVICE_CONNECTION.heartbeatMs)

    for (let renewal = 0; renewal < renewals; renewal++) {
      elapse(h, DEVICE_CONNECTION.heartbeatMs)
      socket.deliver(envelope(h.hub, 'Renew', { grantId: GRANT, until: 1 }))
      await settle()
    }

    expect(h.connection.state()).toBe('status_exchanged')
    expect(h.sockets).toHaveLength(1)

    // Then nothing for 30 s.
    elapse(h, DEVICE_CONNECTION.grantSilenceMs)

    expect(h.connection.closeReason()).toBe('silence')
    expect(grants.closes).toEqual(['silence'])
    expect(socket.closed).toBe('silence')
    expect(log).toContain('[Device] connection closed (silence): grant_silence')

    elapse(h, DEVICE_CONNECTION.backoffMinMs)
    expect(h.sockets).toHaveLength(2)
    await h.handshake(h.sockets[1]!)
    expect(h.connection.state()).toBe('status_exchanged')
  })

  it('goes back to idle when the last grant ends, by Cancel or on its own, and stays up', async () => {
    const grants = grantSink()
    const h = harness({ sink: grants.sink })
    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket)

    socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: GRANT }))
    await settle()
    socket.deliver(envelope(h.hub, 'Cancel', { grantId: GRANT, reason: 'turn_stopped' }))
    await settle()
    expect(grants.live()).toBe(false)

    elapse(h, 60 * 60_000)
    expect(h.connection.state()).toBe('status_exchanged')
    expect(h.sockets).toHaveLength(1)

    // A grant that expires on the Mac without a frame: the silence watch finds nothing live.
    socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: GRANT }))
    await settle()
    expect(grants.live()).toBe(true)
    grants.expire()

    elapse(h, 60 * 60_000)
    expect(h.connection.state()).toBe('status_exchanged')
    expect(h.sockets).toHaveLength(1)
    expect(grants.closes).toEqual([])
  })

  it('dials again when the socket closes or errors, logging only a closed code', async () => {
    const log: string[] = []
    const grants = grantSink()
    const h = harness({ sink: grants.sink, log })
    h.connection.start()
    await h.handshake(h.sockets[0]!)

    h.sockets[0]!.onclose?.({ code: 1006, reason: 'peer text that is never logged' })

    expect(h.connection.state()).toBe('closed')
    expect(h.connection.closeReason()).toBe('drop')
    expect(grants.closes).toEqual(['drop'])
    expect(log).toContain('[Device] connection closed (drop): close_1006')
    expect(log.join('\n')).not.toContain('peer text')

    elapse(h, DEVICE_CONNECTION.backoffMinMs)
    expect(h.sockets).toHaveLength(2)
    await h.handshake(h.sockets[1]!)
    expect(h.connection.state()).toBe('status_exchanged')

    h.sockets[1]!.onerror?.({})

    expect(h.connection.closeReason()).toBe('drop')
    expect(log).toContain('[Device] connection closed (drop): socket_error')
    elapse(h, DEVICE_CONNECTION.backoffMinMs)
    expect(h.sockets).toHaveLength(3)
  })

  describe('when what this Mac can do changes', () => {
    /** Starts as the Hello before the device runtime is ready; `ready()` flips it to the full answer. */
    function changingFacts() {
      let ready = false

      const hello = (): DeviceHelloFacts =>
        ready
          ? {
              workspaceProtocol: 1,
              policyVersion: 1,
              appVersion: '0.20.0',
              capabilities: { terminal: true, files: true, computer: { available: true } }
            }
          : {
              workspaceProtocol: undefined,
              policyVersion: 1,
              appVersion: '0.20.0',
              capabilities: { terminal: false, files: false, computer: { available: false, reason: 'not_running' } }
            }

      return { hello, ready: () => void (ready = true) }
    }

    it('re-announces an idle link once with the new facts the next time it is started', async () => {
      const log: string[] = []
      const facts = changingFacts()
      const grants = grantSink()
      const h = harness({ sink: grants.sink, log, hello: facts.hello })
      h.connection.start()
      const first = h.sockets[0]!
      const { hello } = await h.handshake(first)
      expect(hello.body.capabilities).toMatchObject({ terminal: false, files: false })

      facts.ready()
      h.connection.start()
      await settle()

      expect(first.closed).toBe('drop')
      expect(grants.closes).toEqual(['drop'])
      expect(log).toContain('[Device] connection closed (drop): hello_changed')
      expect(h.sockets).toHaveLength(2)

      const second = await h.handshake(h.sockets[1]!)
      expect(second.hello.body.capabilities).toMatchObject({ terminal: true, files: true, computer: { available: true } })
      expect(h.connection.state()).toBe('status_exchanged')

      // Once announced, the same facts never redial again.
      h.connection.start()
      h.connection.start()
      await settle()
      expect(h.sockets).toHaveLength(2)
      expect(h.sockets[1]!.closed).toBeUndefined()
    })

    it('leaves an idle link alone when nothing changed, however often it is started', async () => {
      const log: string[] = []
      const h = harness({ log })
      h.connection.start()
      await h.handshake(h.sockets[0]!)

      for (let minute = 0; minute < 10; minute++) {
        elapse(h, 60_000)
        h.connection.start()
        await settle()
      }

      expect(h.connection.state()).toBe('status_exchanged')
      expect(h.sockets).toHaveLength(1)
      expect(h.sockets[0]!.closed).toBeUndefined()
      expect(log.filter(line => line.includes('connection closed'))).toEqual([])
    })

    it('never redials under a live grant; the first start after the grant ends does', async () => {
      const facts = changingFacts()
      const grants = grantSink()
      const h = harness({ sink: grants.sink, hello: facts.hello })
      h.connection.start()
      const socket = h.sockets[0]!
      await h.handshake(socket)

      socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: GRANT }))
      await settle()
      facts.ready()

      h.connection.start()
      await settle()
      expect(socket.closed).toBeUndefined()
      expect(h.sockets).toHaveLength(1)

      socket.deliver(envelope(h.hub, 'Cancel', { grantId: GRANT, reason: 'turn_stopped' }))
      await settle()
      expect(socket.closed).toBeUndefined()

      h.connection.start()
      await settle()
      expect(socket.closed).toBe('drop')
      expect(h.sockets).toHaveLength(2)
      const { hello } = await h.handshake(h.sockets[1]!)
      expect(hello.body.capabilities).toMatchObject({ terminal: true, files: true })
    })

    it('admits a TurnGrant that arrived just before the start, and keeps its link', async () => {
      const facts = changingFacts()
      const grants = grantSink()
      const h = harness({ sink: grants.sink, hello: facts.hello })
      h.connection.start()
      const socket = h.sockets[0]!
      await h.handshake(socket)

      facts.ready()
      socket.deliver(envelope(h.hub, 'TurnGrant', { grantId: GRANT }))
      h.connection.start()
      await settle()

      expect(socket.last('GrantAck')!.body).toMatchObject({ grantId: GRANT, accepted: true })
      expect(socket.closed).toBeUndefined()
      expect(h.sockets).toHaveLength(1)
    })
  })

  it('sends a signed local Stop on sign-out, then neither receives nor redials', async () => {
    const h = harness()
    h.connection.start()
    const socket = h.sockets[0]!
    const { connectionId } = await h.handshake(socket)

    h.setAccountEpoch(8)
    h.connection.stop('sign_out')
    socket.deliver(envelope(h.hub, 'Execute', h.execute(connectionId)))
    await settle()

    expect(h.frames).toHaveLength(0)
    expect(socket.last('Stop')!.body).toEqual({
      reason: 'sign_out',
      accountEpoch: 8,
      grantIds: ['00000000-0000-4000-8000-fce915c29383']
    })
    expect(h.due().some(timer => timer.ms >= 1000 && timer.ms <= 30_000)).toBe(false)
    expect(await h.connection.send('Receipt', {})).toBe(false)
  })

  it('applies a pinned controller Revoke and stops, ignores an unpinned one (contract cases)', async () => {
    const fixtureController = fixture('public-keys.json').keys.find(
      (key: { name: string }) => key.name === 'controller.revoke-public-trusted'
    )

    const h = harness({ extraPins: [{ kid: fixtureController.kid, publicKey: fixtureController.publicKey }] })
    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket)

    socket.deliver(JSON.stringify(fixture('revoke-unpinned-ignored.case.json').revoke))
    await settle()
    expect(h.connection.state()).toBe('status_exchanged')
    expect(h.enrollment.current()?.state).toBe('active')

    socket.deliver(JSON.stringify(fixture('revoke-older-ignored.case.json').revoke))
    await settle()
    expect(h.enrollment.current()?.state).toBe('active')

    socket.deliver(JSON.stringify(fixture('revoke-applied.case.json').revoke))
    await settle()
    expect(h.enrollment.current()?.state).toBe('revoked')
    expect(h.connection.closeReason()).toBe('revoked')
    expect(h.due().some(timer => timer.ms >= 1000 && timer.ms <= 30_000)).toBe(false)
  })

  it('offers origin receipts once connected, and marks only those that went out', async () => {
    const receipts = [
      {
        assertionHash: 'o4n7hY3cB0kT2xW9vR5mL8qJ1fD6sA3zE0pU7iK4gN2',
        roomId: '!t4Hq9xZ2pL7mK1vN:atumplatform.com',
        eventId: '$a'
      }
    ]

    const marked: unknown[] = []
    const h = harness()

    const connection = new DeviceConnection({
      url: DEVICE_HUB_URL,
      socket: url => {
        const socket = new FakeSocket(url)
        h.sockets.push(socket)

        return socket
      },
      enrollment: h.enrollment,
      signer: h.signer,
      epochs: {
        accountEpoch: () => 7,
        bootId: () => '00000000-0000-4000-8000-354570CD5E97',
        localGeneration: () => 1,
        bumpLocalGeneration: () => 2
      },
      hello: () => ({
        policyVersion: 1,
        appVersion: '0.18.0',
        capabilities: { terminal: true, files: true, computer: { available: true } }
      }),
      origin: { unreceipted: () => receipts, receipted: value => void marked.push(...value) }
    })

    connection.start()
    const socket = h.sockets.at(-1)!
    await h.handshake(socket)
    await settle()

    const frame = socket.last('OriginReceipt')!
    expect(frame.body).toEqual(receipts[0])
    expect(
      verifyDeviceSignature(h.signer.identity.public.spki, deviceSignedBytes('OriginReceipt', frame.body), frame.sig)
    ).toBe(true)
    expect(marked).toEqual(receipts)
  })

  it('does not dial without an active enrollment', () => {
    const h = harness()
    h.enrollment.applyRevoke({ deviceServiceId: h.record.deviceServiceId, enrollmentEpoch: 3, revokeSeq: 9 })

    h.connection.start()

    expect(h.sockets).toHaveLength(0)
    expect(h.connection.closeReason()).toBe('unenrolled')
  })
})

/** One receipt as the ledger keeps it, with `output` of the given size. */
function receipt(commandId: string, outputBytes: number, seq = 1) {
  return {
    commandId,
    commandHash: 'h'.repeat(43),
    seq,
    state: 'completed',
    result: { exitCode: 0, output: 'o'.repeat(outputBytes) },
    artifacts: [],
    startedAt: 1,
    endedAt: 2
  }
}

/** Decodes one artifact chunk frame: `u16 headerLength || canonical header || bytes`. */
function chunk(frame: Uint8Array) {
  const buffer = Buffer.from(frame)
  const length = buffer.readUInt16BE(0)
  const text = buffer.subarray(2, 2 + length).toString('utf8')
  const header = JSON.parse(text) as { commandId: string; name: string; offset: number; size: number }

  return { header, text, bytes: buffer.subarray(2 + length) }
}

describe('what the Mac sends back on the connection', () => {
  it("answers a reconnect's StatusQuery with every receipt in one frame, and the trimmed ones whole after", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const ledger = [receipt(ids[0]!, 600_000), receipt(ids[1]!, 10), receipt(ids[2]!, 700_000)]

    const h = harness({
      sink: {
        frame: () => {},
        status: query => ({ receipts: ledger.filter(each => query.commandIds.includes(each.commandId)) }),
        closed: () => {}
      }
    })

    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket, 'ready')
    socket.deliver(envelope(h.hub, 'StatusQuery', { commandIds: ids }))
    await settle()

    expect(h.connection.state()).toBe('status_exchanged')
    const status = socket.last('Status')!
    const raw = JSON.stringify(status)

    // Never a receipt fewer (an omitted command counts as never received), and within the hub's 1 MiB.
    expect((status.body.receipts as { commandId: string }[]).map(each => each.commandId)).toEqual(ids)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(DEVICE_CONNECTION.maxFrameBytes)
    // The largest lost its output to fit; the others travel whole.
    const sent = status.body.receipts as ReturnType<typeof receipt>[]
    expect(sent[2]!.result).toEqual({ exitCode: 0 })
    expect(sent[1]).toEqual(ledger[1])
    expect(sent[0]).toEqual(ledger[0])

    // The trimmed receipt follows whole, signed, after the Status.
    const followUps = socket.sent.slice(socket.sent.indexOf(status) + 1).filter(frame => frame.type === 'Receipt')
    expect(followUps.map(frame => frame.body)).toEqual([ledger[2]])
    expect(
      verifyDeviceSignature(
        h.signer.identity.public.spki,
        deviceSignedBytes('Receipt', followUps[0]!.body),
        followUps[0]!.sig
      )
    ).toBe(true)
  })

  it('keeps a receipt too large for any frame in the Status without its output', () => {
    const huge = receipt(randomUUID(), DEVICE_FRAME_BODY_MAX_BYTES + 1)
    const plan = deviceStatusPlan([huge])

    expect(plan.status.receipts).toEqual([{ ...huge, result: { exitCode: 0 } }])
    expect(plan.followUps).toEqual([])
  })

  it('sends a file as binary chunks that reassemble to exactly its bytes, each within 1 MiB', async () => {
    const h = harness()
    h.connection.start()
    const socket = h.sockets[0]!
    const commandId = randomUUID()
    const bytes = randomBytes(2_500_000)

    // Not before the status exchange: nothing goes out.
    await h.handshake(socket, 'ready')
    expect(h.connection.sendArtifact(commandId, 'hello.txt', bytes)).toBe(false)
    expect(socket.binary).toHaveLength(0)

    socket.deliver(envelope(h.hub, 'StatusQuery', { commandIds: [] }))
    await settle()
    expect(h.connection.sendArtifact(commandId, 'hello.txt', bytes)).toBe(true)

    const decoded = socket.binary.map(frame => chunk(frame.data))
    expect(decoded.length).toBeGreaterThan(2)

    let offset = 0

    for (const [index, each] of decoded.entries()) {
      expect(socket.binary[index]!.data.byteLength).toBeLessThanOrEqual(DEVICE_CONNECTION.maxFrameBytes)
      // The header is the contract's (`artifact_chunk.header`), canonical, and names its own bytes.
      expect(Object.keys(each.header).sort()).toEqual(Object.keys(fixture('artifact-chunk.header.json')).sort())
      expect(each.text).toBe(canonicalJson(each.header))
      expect(each.header).toMatchObject({ commandId, name: 'hello.txt', offset, size: each.bytes.length })
      offset += each.bytes.length
    }

    const whole = Buffer.concat(decoded.map(each => each.bytes))
    expect(whole.equals(bytes)).toBe(true)
    // The Receipt's artifact names these bytes by size and SHA-256 (the controller's only check).
    expect(b64u(sha256(whole))).toBe(b64u(sha256(bytes)))
  })

  it('refuses an artifact the contract refuses, and sends nothing for an empty file', () => {
    const id = randomUUID()

    expect(deviceArtifactFrames(id, 'empty.txt', new Uint8Array(0))).toEqual([])
    expect(() => deviceArtifactFrames(id, 'big.bin', new Uint8Array(DEVICE_CONNECTION.artifactMaxBytes + 1))).toThrow(
      'device_artifact_invalid'
    )
    expect(() => deviceArtifactFrames(id, '', new Uint8Array(1))).toThrow('device_artifact_invalid')
    expect(() => deviceArtifactFrames('not-a-command', 'a.txt', new Uint8Array(1))).toThrow('device_artifact_invalid')
    // At the limit, every frame still fits.
    const frames = deviceArtifactFrames(id, 'n'.repeat(255), new Uint8Array(DEVICE_CONNECTION.artifactMaxBytes))
    expect(frames.every(frame => frame.byteLength <= DEVICE_CONNECTION.maxFrameBytes)).toBe(true)
  })

  it("re-sends a reported file's chunks after the Status, on the same connection", async () => {
    const commandId = randomUUID()
    const bytes = randomBytes(1000)

    const h = harness({
      sink: {
        frame: () => {},
        status: () => ({
          receipts: [{ ...receipt(commandId, 0), result: { exitCode: 0 } }],
          artifacts: [{ commandId, name: 'hello.txt', bytes }]
        }),
        closed: () => {}
      }
    })

    h.connection.start()
    const socket = h.sockets[0]!
    await h.handshake(socket)

    const statusAt = socket.sent.indexOf(socket.last('Status')!)
    expect(socket.binary).toHaveLength(1)
    expect(socket.binary[0]!.at).toBe(statusAt + 1)
    expect(chunk(socket.binary[0]!.data).bytes.equals(bytes)).toBe(true)
  })

  it('never sends a frame over 1 MiB: a huge receipt goes without its output, anything else not at all', async () => {
    const log: string[] = []
    const grantId = randomUUID()

    const h = harness({
      log,
      sink: {
        frame: frame =>
          frame.type === 'Execute'
            ? [{ type: 'Receipt', body: receipt(frame.body.commandId as string, DEVICE_CONNECTION.maxFrameBytes) }]
            : frame.type === 'TurnGrant'
              ? [
                  {
                    type: 'GrantAck',
                    body: { grantId, accepted: false, refusal: 'n'.repeat(DEVICE_CONNECTION.maxFrameBytes) }
                  }
                ]
              : undefined,
        status: () => ({ receipts: [] }),
        closed: () => {}
      }
    })

    h.connection.start()
    const socket = h.sockets[0]!
    const { connectionId } = await h.handshake(socket)
    const execute = h.execute(connectionId)
    socket.deliver(envelope(h.hub, 'Execute', execute))
    await settle()

    // The hub learns the command's state (the hash and seq it journaled); only the words are gone.
    const sent = socket.last('Receipt')!
    expect(sent.body).toMatchObject({ commandId: execute.commandId, state: 'completed', result: { exitCode: 0 } })
    expect((sent.body.result as Record<string, unknown>).output).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(sent), 'utf8')).toBeLessThanOrEqual(DEVICE_CONNECTION.maxFrameBytes)
    expect(log.some(line => line.includes('a receipt went without its output'))).toBe(true)

    socket.deliver(envelope(h.hub, 'TurnGrant', { grantId }))
    await settle()
    expect(socket.last('GrantAck')).toBeUndefined()
    expect(log.some(line => line.includes('refused to send GrantAck: over 1 MiB'))).toBe(true)
    expect(h.connection.state()).toBe('status_exchanged')
  })
})

describe('which hub a build dials', () => {
  it('dials only the production hub, unless built with a loopback hub for the SSM fallback', () => {
    expect(deviceHubUrl()).toBe(DEVICE_HUB_URL)
    expect(deviceHubUrl('ws://127.0.0.1:8790/v1')).toBe('ws://127.0.0.1:8790/v1')
    expect(deviceHubUrl('ws://localhost:8790/v1')).toBe('ws://localhost:8790/v1')

    for (const other of [
      'ws://devices.example.com:80/v1',
      'wss://evil.example/v1',
      'ws://127.0.0.1:8790/other',
      'ws://127.0.0.1/v1',
      'nonsense'
    ]) {
      expect(deviceHubUrl(other), other).toBe(DEVICE_HUB_URL)
    }
  })
})


describe('a Secure Enclave failure keeps its cause (device_key_failed, 10-12→10-20)', () => {
  it('logs the helper\'s own words on the first failure, then every 20th, and says when the key is usable again', async () => {
    const log: string[] = []
    const h = harness({ log })
    let locked = true
    const signIdentity = h.signer.signIdentity.bind(h.signer)

    h.signer.signIdentity = async bytes => {
      if (locked) {
        throw new DeviceKeyError('failed', 'sign-identity: sign_identity_failed: authentication failed (status 1)')
      }

      return signIdentity(bytes)
    }

    h.connection.start()

    // A locked Mac: every dial's Hello cannot be signed, again and again.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      h.sockets[attempt]!.open()
      await settle()

      // Only the retry timer is due now (the pre-auth deadline of the next dial is not yet armed).
      const retry = h.due().find(timer => timer.ms >= DEVICE_CONNECTION.backoffMinMs && timer.ms <= DEVICE_CONNECTION.backoffMaxMs)
      h.advance(retry!.ms)
    }

    const failures = log.filter(line => line.includes('device_key_failed'))
    const cause = 'device_key_failed [sign-identity: sign_identity_failed: authentication failed (status 1)]'

    // The first, then the 20th, with its count: not 25 identical lines.
    expect(failures).toEqual([
      `[Device] connection closed (protocol): ${cause}`,
      `[Device] connection closed (protocol): ${cause} (x20)`
    ])

    // Unlocked: the next dial connects and the log says the key is back.
    locked = false
    const socket = h.sockets.at(-1)!
    socket.open()
    await settle()
    await h.handshake(socket)

    expect(log).toContain('[Device] device key usable again after 25 failed attempts')
  })

  it('resume() dials at once, so an unlock does not wait out the backoff', async () => {
    const h = harness()
    let locked = true
    const signIdentity = h.signer.signIdentity.bind(h.signer)

    h.signer.signIdentity = async bytes => {
      if (locked) {
        throw new DeviceKeyError('failed', 'sign-identity: locked')
      }

      return signIdentity(bytes)
    }

    h.connection.start()
    h.sockets[0]!.open()
    await settle()
    expect(h.sockets).toHaveLength(1)

    locked = false
    h.connection.resume()
    expect(h.sockets).toHaveLength(2)
    await h.handshake(h.sockets[1]!)
    expect(h.connection.state()).toBe('status_exchanged')
  })
})

it('refreshes source status after permission/gate changes, without a capability change', async () => {
  const sources: NonNullable<DeviceHelloFacts['sources']> = { messages: 'off', browser: 'off', location: 'off', folders: 'off' }

  const h = harness({ hello: () => ({ sourceProtocol: 1, sources: { ...sources }, policyVersion: 1,
    appVersion: '0.20.44', capabilities: { terminal: true, files: true, computer: { available: true } } }) })

  h.connection.start()
  await h.handshake(h.sockets[0]!)

  for (const state of ['needs_permission', 'ready', 'off'] as const) {
    sources.messages = state
    h.connection.start()
    await settle()
    const socket = h.sockets.at(-1)!
    const { hello } = await h.handshake(socket)
    expect(hello.body.sources).toMatchObject({ messages: state })
  }

  const count = h.sockets.length
  h.connection.start()
  await settle()
  expect(h.sockets).toHaveLength(count)
  h.connection.stop('stop')
})

it.each([1006, 1011, 4401, 4403, undefined])('keeps Hello extensions after a non-schema close %s', async code => {
  const sources = { messages: 'off', browser: 'off', location: 'off', folders: 'off' } as const

  const h = harness({ hello: () => ({ sourceProtocol: 1, sources, workspaceProtocol: 1, policyVersion: 1,
    appVersion: '0.20.44', capabilities: { terminal: true, files: true, computer: { available: true } } }) })

  h.connection.start(); h.sockets[0]!.open(); await settle()
  h.sockets[0]!.onclose?.({ code }); h.advance(1000); await settle()
  const socket = h.sockets.at(-1)!; socket.open(); await settle()
  expect(socket.last('Hello')!.body).toMatchObject({ sourceProtocol: 1, workspaceProtocol: 1, sources })
  h.connection.stop()
})

it('drops sources first on 4400, then workspace, and reprobes when facts change or the fallback expires', async () => {
  let appVersion = '0.20.44'
  const sources = { messages: 'off', browser: 'off', location: 'off', folders: 'off' } as const

  const h = harness({ hello: () => ({ sourceProtocol: 1, sources, workspaceProtocol: 1, policyVersion: 1,
    appVersion, capabilities: { terminal: true, files: true, computer: { available: true } } }) })

  h.connection.start(); h.sockets[0]!.open(); await settle()

  async function reject() {
    h.sockets.at(-1)!.onclose?.({ code: 4400 })
    const retry = h.due().find(t => t.ms >= 1000 && t.ms <= 30_000)!
    h.advance(retry.ms); await settle()
    const socket = h.sockets.at(-1)!; socket.open(); await settle()

    return socket.last('Hello')!.body
  }

  const first = await reject()
  expect(first.sourceProtocol).toBeUndefined(); expect(first.sources).toBeUndefined()
  expect(first.workspaceProtocol).toBe(1)
  const second = await reject()
  expect(second.sourceProtocol).toBeUndefined(); expect(second.workspaceProtocol).toBeUndefined()
  appVersion = '0.20.45'
  h.connection.suspend(); h.connection.resume(); await settle()
  h.sockets.at(-1)!.open(); await settle()
  expect(h.sockets.at(-1)!.last('Hello')!.body).toMatchObject({ sourceProtocol: 1, workspaceProtocol: 1 })
  await reject()
  h.connection.suspend(); h.advance(300_001); h.connection.resume(); await settle()
  h.sockets.at(-1)!.open(); await settle()
  expect(h.sockets.at(-1)!.last('Hello')!.body).toMatchObject({ sourceProtocol: 1, workspaceProtocol: 1 })
  h.connection.stop()
})
