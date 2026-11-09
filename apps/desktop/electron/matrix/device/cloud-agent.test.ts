import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixTurnContent } from '../../../shared/matrix-turn'

import {
  acceptCloudTrial,
  CloudAccessLog,
  CloudAgentEnrollment,
  type CloudEnrollmentRecord,
  cloudRequestId,
  deviceOwnerScope,
  macComputerName,
  MacDeviceIdentity,
  type MacDeviceIdentityOptions,
  OWNER_READER_DISCLOSURE_VERSION,
  ownerReaderState,
  parseAgentServiceStatus,
  parseAnswering,
  parseCloudAccess,
  parseCloudEnrollment,
  parseCloudTrial,
  parseControllerKeys,
  parseDeviceService,
  parseDeviceServices,
  requestS1,
  resolveDeviceOwner,
  type S1Resource,
  s1Route,
  sameCloudTrial,
  setAgentAnswering,
  shownCloudTrial,
  workspaceLabelFor
} from './cloud-agent'
import type { DeviceSocket } from './connection'
import {
  b64u,
  deviceMessageHash,
  deviceSignedBytes,
  keyId,
  originSignedBytes,
  requestDigestV2,
  sha256,
  verifyDeviceSignature
} from './device-key'
import { SoftwareDeviceSigner } from './device-signer.fixture'
import { DeviceRegistryError, type DeviceServiceRecord, type EnrollDeviceRequest } from './enrollment'

const packs = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures')
const fixture = (pack: string, name: string) => JSON.parse(readFileSync(join(packs, pack, 'fixtures', name), 'utf8'))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }

  vi.useRealTimers()
})

const signal = () => new AbortController().signal
const AGENT = '00000000-0000-4000-8000-159badba71cd'

describe('S1 owner routes', () => {
  it('names each resource at its contract path, method and body', () => {
    const request = fixture('device-service', 'enroll.request.json') as EnrollDeviceRequest

    const routes: [S1Resource, ReturnType<typeof s1Route>][] = [
      [{ kind: 'controller-keys' }, { method: 'GET', path: '/cloud/controller-keys', bearer: false }],
      [{ kind: 'device-services' }, { method: 'GET', path: '/device-services', bearer: true }],
      [
        { kind: 'device-enroll', request },
        { method: 'POST', path: '/device-services', body: request, bearer: true }
      ],
      [
        { kind: 'device-revoke', deviceServiceId: '00000000-0000-4000-8000-b86a6ca39e23' },
        { method: 'DELETE', path: '/device-services/00000000-0000-4000-8000-b86a6ca39e23', bearer: true }
      ],
      [
        { kind: 'answering', agentPrincipal: AGENT, mode: 'cloud', expectedMode: 'local' },
        {
          method: 'POST',
          path: `/agents/${AGENT}/answering`,
          body: fixture('cloud-answering', 'answering-to-cloud.request.json'),
          bearer: true
        }
      ],
      [
        { kind: 'agent-service-status', agentPrincipal: AGENT },
        { method: 'GET', path: `/agents/${AGENT}/service-status`, bearer: true }
      ],
      [{ kind: 'cloud-enrollments' }, { method: 'GET', path: '/cloud/enrollments', bearer: true }],
      [
        { kind: 'cloud-enrollment-revoke', enrollmentId: '00000000-0000-4000-8000-576f18824476' },
        {
          method: 'DELETE',
          path: '/cloud/enrollments/00000000-0000-4000-8000-576f18824476',
          bearer: true
        }
      ],
      [
        { kind: 'cloud-handoff', enrollmentId: '00000000-0000-4000-8000-576f18824476', ownerDevice: 'MACBOOKQ7ZK' },
        {
          method: 'POST',
          path: '/cloud/enrollments/00000000-0000-4000-8000-576f18824476/handoff',
          body: { ownerDevice: 'MACBOOKQ7ZK' },
          bearer: true
        }
      ]
    ]

    for (const [resource, route] of routes) {
      expect(s1Route(resource), resource.kind).toEqual(route)
    }

    // A path is never built from a value that is not an ID.
    expect(() => s1Route({ kind: 'device-revoke', deviceServiceId: '../agents' })).toThrow(DeviceRegistryError)
    expect(() => s1Route({ kind: 'cloud-enrollment-revoke', enrollmentId: '../enrollments' })).toThrow(
      DeviceRegistryError
    )
    expect(() =>
      s1Route({ kind: 'answering', agentPrincipal: 'x/../y', mode: 'cloud', expectedMode: 'local' })
    ).toThrow()
    expect(() => s1Route({ kind: 'agent-service-status', agentPrincipal: 'x/../y' })).toThrow()
  })

  it('sends the owner bearer only where the route needs it, and maps refusals to the contract reason', async () => {
    const calls: { url: string; init: RequestInit }[] = []

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })

      if (url.endsWith('/answering')) {
        return new Response(JSON.stringify(fixture('cloud-answering', 'answering-conflict.error.json')), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      }

      if (url.endsWith('/device-services')) {
        return new Response('', { status: 401 })
      }

      return new Response(JSON.stringify(fixture('device-service', 'controller-keys.response.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const keys = await requestS1(
      'https://api.test/api/matrix/v1',
      { kind: 'controller-keys' },
      null,
      signal(),
      fetchImpl
    )

    expect(parseControllerKeys(keys)).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://api.test/api/matrix/v1/cloud/controller-keys')
    expect(calls[0]!.init.headers).toEqual({})

    await expect(
      requestS1(
        'https://api.test/api/matrix/v1',
        { kind: 'answering', agentPrincipal: AGENT, mode: 'cloud', expectedMode: 'local' },
        'token',
        signal(),
        fetchImpl
      )
    ).rejects.toMatchObject({ status: 409, reason: 'answering_conflict' })
    expect(calls[1]!.init.headers).toEqual({ Authorization: 'Bearer token', 'Content-Type': 'application/json' })
    expect(calls[1]!.init.body).toBe(JSON.stringify({ mode: 'cloud', expectedMode: 'local' }))

    await expect(
      requestS1('https://api.test/api/matrix/v1', { kind: 'device-services' }, 'expired', signal(), fetchImpl)
    ).rejects.toThrow('matrix_s1_authentication')

    // Never over plain HTTP, and never a route that needs the owner without a bearer.
    await expect(requestS1('http://api.test', { kind: 'controller-keys' }, null, signal(), fetchImpl)).rejects.toThrow()
    await expect(requestS1('https://api.test', { kind: 'device-services' }, null, signal(), fetchImpl)).rejects.toThrow(
      'matrix_s1_authentication'
    )
  })

  it('reads the contract responses exactly', () => {
    expect(parseDeviceService(fixture('device-service', 'device-service.response.json'))).toMatchObject({
      deviceServiceId: '00000000-0000-4000-8000-b86a6ca39e23',
      enrollmentEpoch: 3,
      revokeSeq: 4
    })
    expect(parseDeviceServices(fixture('device-service', 'device-services.list.response.json')).length).toBeGreaterThan(
      0
    )
    expect(parseAnswering(fixture('cloud-answering', 'answering.response.json'), AGENT, 'cloud')).toEqual(
      fixture('cloud-answering', 'answering.response.json')
    )
    expect(
      parseAgentServiceStatus(
        {
          profile: 'atum.agent-service-status/1',
          agentPrincipal: AGENT,
          state: 'server_down',
          asOf: 1_790_672_600_000,
          serverDownSince: 1_790_672_400_000,
          presentSince: 1_790_672_000_000
        },
        AGENT
      )
    ).toMatchObject({ state: 'server_down', serverDownSince: 1_790_672_400_000 })

    // An answer for another agent or mode is not this switch's.
    expect(() => parseAnswering(fixture('cloud-answering', 'answering.response.json'), AGENT, 'local')).toThrow()
    expect(() =>
      parseAgentServiceStatus(
        {
          profile: 'atum.agent-service-status/1',
          agentPrincipal: AGENT,
          state: 'server_down',
          asOf: 1,
          serverDownSince: 2
        },
        AGENT
      )
    ).toThrow()
    expect(() =>
      parseAgentServiceStatus(
        { profile: 'atum.agent-service-status/1', agentPrincipal: AGENT, state: 'working', asOf: 1, extra: true },
        AGENT
      )
    ).toThrow()
    expect(() =>
      parseDeviceService({ ...fixture('device-service', 'device-service.response.json'), platform: 'ios' })
    ).toThrow()
  })

  it('switches an agent to the cloud, and reports a platform that needs a trusted cloud enrollment first', async () => {
    const call = vi.fn(async (resource: S1Resource) => {
      if (resource.kind === 'answering' && resource.mode === 'cloud') {
        return fixture('cloud-answering', 'answering.response.json')
      }

      throw new DeviceRegistryError(403, 'cloud_enrollment_required')
    })

    await expect(
      setAgentAnswering(call, { agentPrincipal: AGENT, mode: 'cloud', expectedMode: 'local' }, signal())
    ).resolves.toMatchObject({
      mode: 'cloud'
    })
    await expect(
      setAgentAnswering(call, { agentPrincipal: AGENT, mode: 'local', expectedMode: 'cloud' }, signal())
    ).rejects.toMatchObject({
      status: 403,
      reason: 'cloud_enrollment_required'
    })
  })
})

class FakeSocket implements DeviceSocket {
  readyState = 0
  sent: string[] = []
  binary: Uint8Array[] = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(data: string | Uint8Array) {
    if (typeof data === 'string') {
      this.sent.push(data)
    } else {
      this.binary.push(data)
    }
  }

  close() {
    this.closed = true
    this.readyState = 3
  }
}

/** A registry that verifies EnrollDevice exactly as DA's route code does (ES256 by both keys). */
function registry() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const controller = { kid: keyId(spki), alg: 'Ed25519', publicKey: b64u(spki), state: 'active', createdAt: 1 }
  const rows: DeviceServiceRecord[] = []

  const call = vi.fn(async (resource: S1Resource) => {
    switch (resource.kind) {
      case 'controller-keys':
        return { keys: [controller] }

      case 'device-services':
        return { deviceServices: rows }
      case 'device-enroll': {
        const { body, sigs } = resource.request
        const bytes = deviceSignedBytes('EnrollDevice', body)

        if (
          !verifyDeviceSignature(body.identityKey, bytes, sigs.identity) ||
          !verifyDeviceSignature(body.approvalKey, bytes, sigs.approval)
        ) {
          throw new DeviceRegistryError(400, 'bad_signature')
        }

        const row: DeviceServiceRecord = {
          deviceServiceId: body.deviceServiceId,
          displayName: body.displayName,
          platform: 'macos',
          identityKeyId: keyId(Buffer.from(body.identityKey, 'base64url')),
          approvalKeyId: keyId(Buffer.from(body.approvalKey, 'base64url')),
          matrix: { deviceId: body.matrix.deviceId, fingerprint: body.matrix.fingerprint },
          enrollmentEpoch: body.enrollmentEpoch,
          scopes: body.scopes,
          pinnedControllerKeys: body.controllerKeys,
          state: 'active',
          revokeSeq: 0,
          createdAt: 1,
          rotatedAt: null,
          revokedAt: null
        }

        rows.push(row)

        return row
      }

      default:
        throw new DeviceRegistryError(404)
    }
  })

  /** A frame the controller signs, as the hub sends it. */
  const frame = (type: string, body: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      type,
      body,
      kid: controller.kid,
      sig: b64u(sign(null, deviceSignedBytes(type, body), privateKey))
    })

  return { call, rows, frame }
}

const settle = async () => {
  for (let index = 0; index < 20; index++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** The hub's side of the handshake on `socket`, through the status exchange. */
async function hubHandshake(socket: FakeSocket, da: ReturnType<typeof registry>) {
  socket.readyState = 1
  socket.onopen?.({})
  await settle()
  const hello = JSON.parse(socket.sent.find(data => JSON.parse(data).type === 'Hello')!)
  const connectionId = randomUUID()
  socket.onmessage?.({
    data: da.frame('Challenge', {
      connectionId,
      challenge: b64u(randomBytes(32)),
      helloHash: deviceMessageHash('Hello', hello.body),
      issuedAt: 1
    })
  })
  await settle()
  socket.onmessage?.({
    data: da.frame('Ready', { connectionId, connectionEpoch: 3, heartbeatMs: 5000, serverTime: 2 })
  })
  await settle()
  socket.onmessage?.({ data: da.frame('StatusQuery', { commandIds: [] }) })
  await settle()
}

function identity(
  options: {
    signer?: SoftwareDeviceSigner
    signerFor?: NonNullable<MacDeviceIdentityOptions['signerFor']>
    owner?: MacDeviceIdentityOptions['owner']
    helper?: string | null
    directory?: string
    onEnrolled?: NonNullable<MacDeviceIdentityOptions['onEnrolled']>
  } = {}
) {
  const directory = options.directory ?? mkdtempSync(path.join(tmpdir(), 'atum-device-identity-'))
  if (!options.directory) { directories.push(directory) }
  const da = registry()
  const signer = options.signer ?? new SoftwareDeviceSigner()
  const sockets: FakeSocket[] = []
  const logs: string[] = []
  let signedIn = true

  const subject = new MacDeviceIdentity({
    userData: directory,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    },
    helper:
      options.helper === undefined
        ? '/Applications/Atum.app/Contents/Resources/app.asar.unpacked/atum-device-key'
        : options.helper,
    hubUrl: 'wss://devices.atumplatform.com/v1',
    call: da.call,
    owner:
      options.owner ??
      (async () =>
        signedIn
          ? {
              userId: '@owner-3f9a1c7e5b2d:atumplatform.com',
              deviceId: 'MACBOOKQ7ZK',
              fingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'
            }
          : null),
    hello: () => ({
      policyVersion: 1,
      appVersion: '0.18.0',
      capabilities: { terminal: false, files: false, computer: { available: false } }
    }),
    locale: () => 'vi',
    displayName: () => 'MacBook Pro',
    osVersion: () => '26.6.2',
    socket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)

      return socket
    },
    signerFor: options.signerFor ?? (() => signer),
    ...(options.onEnrolled ? { onEnrolled: options.onEnrolled } : {}),
    log: line => void logs.push(line)
  })

  // The protocol peer uses a scripted Mac boot on every CI host. epochs.test.ts proves sysctl
  // separately; Linux has no kern.bootsessionuuid and must not mint a production boot fallback.
  vi.spyOn(subject.epochs, 'bootId').mockReturnValue('00000000-0000-4000-8000-354570CD5E97')

  return { subject, da, signer, sockets, directory, logs, signOut: () => (signedIn = false) }
}

it('exposes only the enrolled owner approval handles and withdraws them synchronously at sign-out', async () => {
  const { subject, signer } = identity()
  expect(subject.approvalKey()).toBeNull()
  expect(subject.approvalSigner()).toBeNull()
  await subject.enroll(signal())
  expect(subject.approvalKey()).toEqual(signer.approval.public)
  expect(subject.approvalSigner()).toBe(signer)
  subject.signOut()
  expect(subject.approvalKey()).toBeNull()
  expect(subject.approvalSigner()).toBeNull()
})

it('hands the browser import only the enrolled device, its keys and the controller keys this Mac pinned', async () => {
  const { subject, signer } = identity()
  expect(subject.browserImportDevice()).toBeNull()
  await subject.enroll(signal())

  const kit = subject.browserImportDevice()!
  const enrolled = subject.enrollment()!

  expect(kit).toMatchObject({
    userId: '@owner-3f9a1c7e5b2d:atumplatform.com',
    deviceServiceId: enrolled.deviceServiceId,
    approvalKey: signer.approval.public,
    identityKid: signer.identity.public.kid
  })
  expect(kit.signer).toBe(signer)
  // The controller keys are the ones enrollment pinned, nothing else the registry listed.
  expect(kit.controllerKeys.length).toBeGreaterThan(0)
  expect(kit.controllerKeys.map(({ kid }) => kid).sort()).toEqual([...enrolled.pinnedControllerKeys].sort())
  expect(kit.controllerKeys.every(({ publicKey }) => /^[A-Za-z0-9_-]{59}$/u.test(publicKey))).toBe(true)

  subject.signOut()
  expect(subject.browserImportDevice()).toBeNull()
})

it('cannot revive the old connection when sign-out races a pending public-key read', async () => {
  const { subject, signer, sockets } = identity()
  await subject.enroll(signal())
  const before = sockets.length
  let resolve!: (keys: Awaited<ReturnType<typeof signer.publicKeys>>) => void
  vi.spyOn(signer, 'publicKeys').mockImplementationOnce(
    () =>
      new Promise(yes => {
        resolve = yes
      })
  )
  const activation = subject.activate()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  subject.signOut()
  resolve({ identity: signer.identity.public, approval: signer.approval.public })
  await activation
  expect(sockets).toHaveLength(before)
  expect(subject.connection()).toBeNull()
  expect(subject.approvalKey()).toBeNull()
})

const question = (body = 'Make ~/Desktop/s1-demo/hello.txt') => ({
  transactionId: 'atum-q-00000000-0000-4000-8000-31f949766961',
  roomId: '!t4Hq9xZ2pL7mK1vN:atumplatform.com',
  agentUserId: '@synthetic-user-0011:atumplatform.com',
  content: matrixTurnContent({ body, turnId: '00000000-0000-4000-8000-31f949766961', handoff: true })
})

describe("this Mac's device service", () => {
  it('silently enrolls a fresh owner during sign-in activation', async () => {
    const onEnrolled = vi.fn(async () => {})
    const { subject, da, signer, sockets } = identity({ onEnrolled })

    expect(await subject.activate()).toMatchObject({ state: 'enrolled', enrollmentEpoch: 1 })
    expect(signer.prompts).toHaveLength(0)
    expect(da.rows).toHaveLength(1)
    expect(subject.enrollment()).toMatchObject({ enrollmentEpoch: 1, state: 'active' })
    expect(onEnrolled).toHaveBeenCalledOnce()
    expect(sockets).toHaveLength(1)

    // Browser import and move-to-cloud share this same entry point even when enrollment is already active.
    await subject.enroll(signal())
    expect(signer.prompts).toHaveLength(0)
    expect(onEnrolled).toHaveBeenCalledTimes(2)
  })

  it('does not offer enrollment when this build has no Secure Enclave helper', async () => {
    const owner = vi.fn(async () => ({
      userId: '@owner:atum.test',
      deviceId: 'MACBOOK',
      fingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'
    }))
    const { subject } = identity({ helper: null, owner })

    expect(await subject.activate()).toEqual({ state: 'unavailable' })
    expect(owner).not.toHaveBeenCalled()
  })

  it('gives a different owner a separate epoch-1 service and key directory, leaving the first owner untouched', async () => {
    const first = {
      userId: '@first-owner:test',
      deviceId: 'FIRSTMAC',
      fingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'
    }
    const second = {
      userId: '@second-owner:test',
      deviceId: 'SECONDMAC',
      fingerprint: 'bI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'
    }
    let owner = first
    const keyDirs: string[] = []
    const signers = new Map<string, SoftwareDeviceSigner>()
    const { subject, da, directory } = identity({
      owner: async () => owner,
      signerFor: keyDir => {
        keyDirs.push(keyDir)
        const signer = signers.get(keyDir) ?? new SoftwareDeviceSigner()
        signers.set(keyDir, signer)
        return signer
      }
    })

    await subject.activate()
    const firstRecord = subject.enrollment()!
    const firstRegistryRow = structuredClone(da.rows[0]!)

    subject.signOut('account_switch')
    owner = second
    await subject.activate()
    const secondRecord = subject.enrollment()!

    expect(secondRecord).toMatchObject({ enrollmentEpoch: 1, state: 'active' })
    expect(secondRecord.deviceServiceId).not.toBe(firstRecord.deviceServiceId)
    expect(keyDirs).toEqual([
      path.join(directory, 'device', 'keys', deviceOwnerScope(first.userId)),
      path.join(directory, 'device', 'keys', deviceOwnerScope(second.userId))
    ])
    expect(da.rows).toHaveLength(2)
    expect(da.rows[0]).toEqual(firstRegistryRow)

    subject.signOut('account_switch')
    owner = first
    await subject.activate()
    expect(subject.enrollment()).toEqual(firstRecord)
    expect([...signers.values()].every(each => each.prompts.length === 0)).toBe(true)
  })

  it('silently rebinds after the signed-in Matrix device changes', async () => {
    let owner = { userId: '@owner:test', deviceId: 'OLD', fingerprint: 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho' }
    const { subject, da, signer } = identity({ owner: async () => owner })
    await subject.enroll(signal())
    const before = subject.enrollment()!
    const connection = subject.connection()
    const epoch = subject.epochs.accountEpoch()
    owner = { ...owner, deviceId: 'NEW', fingerprint: 'bI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho' }
    da.call.mockClear()
    await subject.activate()
    expect(subject.connection()).toBe(connection)
    expect(subject.enrollment()).toMatchObject({ deviceServiceId: before.deviceServiceId,
      identityKid: before.identityKid, approvalKid: before.approvalKid,
      matrixDeviceId: 'NEW', matrixFingerprint: 'bI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho', enrollmentEpoch: before.enrollmentEpoch + 1 })
    expect(subject.epochs.accountEpoch()).toBe(epoch)
    expect(signer.prompts).toHaveLength(0)
    expect(da.call.mock.calls.map(([request]) => request.kind)).toEqual(['controller-keys', 'device-services', 'device-enroll'])
    subject.signOut()
  })

  it('re-enrolls in the background when the server says the remembered service is missing', async () => {
    const { subject, da, signer } = identity()
    await subject.activate()
    const first = subject.enrollment()!
    da.rows.splice(0)

    await subject.activate()

    expect(subject.enrollment()).toMatchObject({ enrollmentEpoch: 1, state: 'active' })
    expect(subject.enrollment()!.deviceServiceId).not.toBe(first.deviceServiceId)
    expect(da.rows).toHaveLength(1)
    expect(signer.prompts).toEqual([])
  })

  it('has an origin ready after silent sign-in enrollment, without a Touch ID prompt', async () => {
    const { subject, da, signer, sockets } = identity()

    expect(await subject.activate()).toMatchObject({ state: 'enrolled' })
    expect(signer.prompts).toHaveLength(0)
    expect(sockets).toHaveLength(1)

    const input = question()
    const origin = (await subject.originFor(input, { enroll: true }))!

    expect(signer.prompts).toHaveLength(0)
    expect(da.rows).toHaveLength(1)
    expect(sockets).toHaveLength(1)

    expect(origin).toMatchObject({
      dsid: da.rows[0]!.deviceServiceId,
      kid: signer.identity.public.kid,
      ee: 1,
      ae: 1,
      owner: '@owner-3f9a1c7e5b2d:atumplatform.com',
      agent: input.agentUserId,
      room: input.roomId,
      dev: 'MACBOOKQ7ZK',
      dg: requestDigestV2(input.content)
    })

    const { sig, ...unsigned } = origin
    expect(verifyDeviceSignature(signer.identity.public.spki, originSignedBytes(unsigned), sig)).toBe(true)
    expect(subject.presence()).toMatchObject({ state: 'enrolled', enrollmentEpoch: 1 })

    // The next question also needs no prompt.
    await subject.originFor(question('And open it in TextEdit'), { enroll: true })
    expect(signer.prompts).toHaveLength(0)
  })

  it('logs the origin against the event the server returned (admission step 9)', async () => {
    const { subject } = identity()
    const input = question()
    const origin = (await subject.originFor(input, { enroll: true }))!
    const { sig: _sig, ...unsigned } = origin
    const { originAssertionHash } = await import('./device-key')
    const receipt = { assertionHash: originAssertionHash(unsigned), roomId: input.roomId, eventId: '$question' }

    expect(subject.originMatches(receipt)).toBe(false)
    subject.questionSent(input.transactionId, input.roomId, '$question')
    expect(subject.originMatches(receipt)).toBe(true)
    expect(subject.originMatches({ ...receipt, eventId: '$another' })).toBe(false)
  })

  it('sends without an origin when enrollment is unavailable, then retries without prompting', async () => {
    const result = identity()
    result.da.call.mockRejectedValueOnce(new DeviceRegistryError(0, 'offline'))
    const { subject, signer, sockets } = result

    expect(await subject.originFor(question(), { enroll: false })).toBeNull()
    expect(signer.prompts).toHaveLength(0)

    expect(await subject.originFor(question(), { enroll: true })).toBeNull()
    expect(signer.prompts).toHaveLength(0)
    expect(sockets).toHaveLength(0)

    expect(await subject.originFor(question('Again'), { enroll: true })).not.toBeNull()
    expect(signer.prompts).toHaveLength(0)
  })

  it('keeps a missing enrollment retryable after offline failure or platform refusal, without inventing a row', async () => {
    const offline = identity()
    offline.da.call.mockRejectedValueOnce(new DeviceRegistryError(0, 'offline'))
    await expect(offline.subject.enroll(signal())).rejects.toThrow('device_enrollment_unavailable')
    expect(offline.logs).toEqual(['[Device] this Mac was not enrolled: device_enrollment_unavailable'])
    expect(offline.da.rows).toHaveLength(0)
    await offline.subject.enroll(signal())
    expect(offline.da.rows).toHaveLength(1)
    expect(offline.signer.prompts).toEqual([])

    const refused = identity()
    const registryCall = refused.da.call.getMockImplementation()!
    let refuse = true
    refused.da.call.mockImplementation(async request => {
      if (request.kind === 'device-enroll' && refuse) {
        refuse = false
        throw new DeviceRegistryError(403, 'policy')
      }
      return registryCall(request)
    })
    await expect(refused.subject.enroll(signal())).rejects.toThrow('device_enrollment_refused:policy')
    expect(refused.logs).toEqual(['[Device] this Mac was not enrolled: device_enrollment_refused:policy'])
    expect(refused.da.rows).toHaveLength(0)
    await refused.subject.enroll(signal())
    expect(refused.da.rows).toHaveLength(1)
    expect(refused.signer.prompts).toEqual([])
  })

  it('sends a question on an unenrolled Mac without an origin, and logs nothing for it', async () => {
    const { subject, signer, sockets, logs } = identity()
    const input = question()

    expect(await subject.originFor(input, { enroll: false })).toBeNull()
    expect(signer.prompts).toHaveLength(0)
    expect(sockets).toHaveLength(0)
    expect(logs).toEqual([])

    // The question still reaches the server; there is simply no origin to log against it.
    expect(() => subject.questionSent(input.transactionId, input.roomId, '$question')).not.toThrow()
    expect(subject.originLog()).toEqual([])
    expect(subject.originMatches({ assertionHash: 'unsigned', roomId: input.roomId, eventId: '$question' })).toBe(false)
  })

  it('names this Mac as its owner named it, or by host name', () => {
    expect(macComputerName(() => "Owner's MacBook Air\n")).toBe("Owner's MacBook Air")
    expect(macComputerName(() => 'x'.repeat(100))).toHaveLength(64)
    expect(
      macComputerName(() => {
        throw new Error('no scutil')
      }).length
    ).toBeGreaterThan(0)
  })

  it('fences on sign-out: the account epoch moves on and the connection closes, synchronously', async () => {
    const { subject, sockets, signOut } = identity()
    await subject.originFor(question(), { enroll: true })
    const before = subject.epochs.accountEpoch()

    subject.signOut()
    signOut()

    expect(subject.epochs.accountEpoch()).toBe(before + 1)
    expect(sockets[0]!.closed).toBe(true)
    expect(subject.presence()).toEqual({ state: 'signed_out' })
    expect(await subject.originFor(question(), { enroll: true })).toBeNull()
  })

  it('sends a file the device host wrote as chunks, only while it is what the receipt will sign', async () => {
    const { subject, da, sockets, directory } = identity()
    await subject.originFor(question(), { enroll: true })
    await hubHandshake(sockets[0]!, da)
    expect(subject.presence()).toMatchObject({ state: 'enrolled', connection: 'status_exchanged' })

    const bytes = randomBytes(1_500_000)
    const file = path.join(directory, 'hello.txt')
    writeFileSync(file, bytes)
    const artifact = { name: 'hello.txt', size: bytes.length, sha256: b64u(sha256(bytes)), path: file }
    const commandId = randomUUID()

    expect(await subject.sendArtifact(commandId, artifact)).toBe(true)

    const sent = Buffer.concat(
      sockets[0]!.binary.map(frame => Buffer.from(frame).subarray(2 + Buffer.from(frame).readUInt16BE(0)))
    )

    expect(sent.equals(bytes)).toBe(true)

    // Changed after the command read it, a link in its place, or past the chat limit: never sent.
    const count = sockets[0]!.binary.length
    writeFileSync(file, randomBytes(bytes.length))
    expect(await subject.sendArtifact(commandId, artifact)).toBe(false)
    const link = path.join(directory, 'link.txt')
    symlinkSync(file, link)
    expect(await subject.sendArtifact(commandId, { ...artifact, path: link })).toBe(false)
    expect(await subject.sendArtifact(commandId, { ...artifact, size: 8 * 1024 * 1024 + 1 })).toBe(false)
    expect(sockets[0]!.binary).toHaveLength(count)
  })

  it("lists its origin log for the device service's admission (step 9)", async () => {
    const { subject } = identity()
    expect(subject.originLog()).toEqual([])

    const input = question()
    const origin = (await subject.originFor(input, { enroll: true }))!
    const { sig: _sig, ...unsigned } = origin
    const { originAssertionHash } = await import('./device-key')
    subject.questionSent(input.transactionId, input.roomId, '$question')

    expect(subject.originLog()).toEqual([
      { assertionHash: originAssertionHash(unsigned), roomId: input.roomId, eventId: '$question' }
    ])
  })

  it('keeps each owner apart: separate key directories and stores', () => {
    expect(deviceOwnerScope('@a:atumplatform.com')).not.toBe(deviceOwnerScope('@b:atumplatform.com'))
    expect(deviceOwnerScope('@a:atumplatform.com')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("the owner side of an agent's cloud enrollment", () => {
  const ownerDevice = 'MACBOOKQ7ZK'
  const enrollmentId = '00000000-0000-4000-8000-576f18824476'

  it('treats only an explicit server boolean as conversation readiness', () => {
    const base = {
      enrollmentId,
      kind: 'cloud',
      executorId: '00000000-0000-4000-8000-951c747b3afc',
      deviceId: 'CLOUDDEVICE1',
      state: 'active',
      trust: 'trusted',
      disclosureVersion: 7,
      agentPrincipal: AGENT,
      ownerDevice,
      createdAt: 1,
      updatedAt: 2
    }

    expect(parseCloudEnrollment({ ...base, conversationReady: true }).conversationReady).toBe(true)
    expect(parseCloudEnrollment(base).conversationReady).toBe(false)
    expect(parseCloudEnrollment({ ...base, conversationReady: 'true' }).conversationReady).toBe(false)
    expect(parseCloudEnrollment({ ...base, conversationReady: false }).conversationReady).toBe(false)
  })

  function platform(states: string[]) {
    let index = 0
    const calls: S1Resource[] = []

    const enrollment = (state: string, handoffUntil?: number) => ({
      enrollmentId,
      kind: 'cloud',
      executorId: '00000000-0000-4000-8000-951c747b3afc',
      deviceId: 'CLOUDDEVICE1',
      state,
      trust: state === 'active' ? 'trusted' : 'pending',
      disclosureVersion: 7,
      agentPrincipal: AGENT,
      ownerDevice,
      ...(handoffUntil ? { handoffUntil } : {}),
      createdAt: 1,
      updatedAt: 2
    })

    const call = vi.fn(async (resource: S1Resource) => {
      calls.push(resource)

      switch (resource.kind) {
        case 'cloud-enrollments':
          return {
            enrollments:
              index === 0 && calls.filter(each => each.kind === 'cloud-enroll').length === 0
                ? []
                : [enrollment(states[Math.min(index++, states.length - 1)]!, Date.now() + 600_000)]
          }

        case 'cloud-disclosure':
          return { kind: 'cloud', version: 7 }

        case 'cloud-enroll':
          return { enrollment: enrollment('provisioning') }

        case 'cloud-handoff':
          return { enrollment: enrollment('awaiting_trust', Date.now() + 600_000) }

        default:
          throw new DeviceRegistryError(404)
      }
    })

    return { call, calls }
  }

  it('creates it for this Mac with a stable request ID, then waits until the cloud device is trusted', async () => {
    const { call, calls } = platform(['provisioning', 'awaiting_trust', 'active'])

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [{ principal: AGENT, matrixUser: '@agent:atumplatform.com' }],
      receive: async () => [],
      send: async () => {},
      recoveryKey: async () => 'key',
      log: () => {},
      pumpMs: 1
    })

    const created = await enrollments.beginAttempt(AGENT, signal())
    expect(created).toMatchObject({ created: true, enrollment: { state: 'provisioning' } })

    const enroll = calls.find(each => each.kind === 'cloud-enroll')!
    expect(enroll).toEqual({
      kind: 'cloud-enroll',
      requestId: cloudRequestId(`atum.cloud-enroll:${AGENT}:${ownerDevice}:7`),
      agentPrincipal: AGENT,
      ownerDevice,
      disclosureVersion: 7
    })
    expect(cloudRequestId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(cloudRequestId('x')).toBe(cloudRequestId('x'))

    const trusted = await enrollments.waitTrusted(AGENT, signal())
    expect(trusted).toMatchObject({ state: 'active', trust: 'trusted' })
    enrollments.stop()
  })

  it('marks a live enrollment as reused so a cancelled move cannot revoke another attempt', async () => {
    const call = vi.fn(async (resource: S1Resource) => {
      if (resource.kind !== 'cloud-enrollments') {
        throw new DeviceRegistryError(404)
      }

      return {
        enrollments: [
          {
            enrollmentId,
            kind: 'cloud',
            executorId: '00000000-0000-4000-8000-951c747b3afc',
            deviceId: 'CLOUDDEVICE1',
            state: 'active',
            trust: 'trusted',
            disclosureVersion: 7,
            agentPrincipal: AGENT,
            ownerDevice,
            createdAt: 1,
            updatedAt: 2
          }
        ]
      }
    })

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [],
      receive: async () => [],
      send: async () => {},
      recoveryKey: async () => null,
      log: () => {}
    })

    await expect(enrollments.beginAttempt(AGENT, signal())).resolves.toMatchObject({
      created: false,
      enrollment: { state: 'active' }
    })
    enrollments.stop()
  })

  it('refuses a create response for another agent before its ID can become rollback authority', async () => {
    const other = '00000000-0000-4000-8000-e0c547f20e1d'
    const call = vi.fn(async (resource: S1Resource) => {
      if (resource.kind === 'cloud-enrollments') {
        return { enrollments: [] }
      }

      if (resource.kind === 'cloud-disclosure') {
        return { kind: 'cloud', version: 7 }
      }

      if (resource.kind === 'cloud-enroll') {
        return {
          enrollment: {
            enrollmentId,
            kind: 'cloud',
            executorId: '00000000-0000-4000-8000-951c747b3afc',
            deviceId: 'CLOUDDEVICE1',
            state: 'provisioning',
            trust: 'pending',
            disclosureVersion: 7,
            agentPrincipal: other,
            ownerDevice,
            createdAt: 1,
            updatedAt: 2
          }
        }
      }

      throw new DeviceRegistryError(404)
    })

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [],
      receive: async () => [],
      send: async () => {},
      recoveryKey: async () => null,
      log: () => {}
    })

    await expect(enrollments.beginAttempt(AGENT, signal())).rejects.toThrow('device_registry_0_invalid')
    enrollments.stop()
  })

  it('retries a durable revoking enrollment after its MAS session appears', async () => {
    let state: CloudEnrollmentRecord['state'] = 'active'
    let revokeCalls = 0
    const logs: string[] = []

    const row = (): CloudEnrollmentRecord => ({
      enrollmentId,
      kind: 'cloud',
      executorId: '00000000-0000-4000-8000-951c747b3afc',
      deviceId: 'CLOUDDEVICE1',
      state,
      trust: 'trusted',
      conversationReady: true,
      disclosureVersion: 7,
      agentPrincipal: AGENT,
      ownerDevice,
      createdAt: 1,
      updatedAt: 2
    })

    const call = vi.fn(async (resource: S1Resource) => {
      if (resource.kind === 'cloud-enrollments') {
        return { enrollments: [row()] }
      }

      if (resource.kind === 'cloud-enrollment-revoke') {
        revokeCalls += 1

        if (revokeCalls === 1) {
          state = 'revoking'
          throw new DeviceRegistryError(503, 'unavailable')
        }

        state = 'revoked'

        return { enrollment: row() }
      }

      throw new DeviceRegistryError(404)
    })

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [],
      receive: async () => [],
      send: async () => {},
      recoveryKey: async () => null,
      log: line => void logs.push(line),
      revokeSweepMs: 60_000
    })

    await expect(enrollments.revoke(enrollmentId, signal())).rejects.toMatchObject({ status: 503 })
    await enrollments.sweepRevocations(signal())

    expect(state).toBe('revoked')
    expect(revokeCalls).toBe(2)
    expect(logs).toEqual([])
    enrollments.stop()
  })

  it("answers the cloud device's identity request with the agent's recovery key, to that device only", async () => {
    const now = Date.now()
    const agentUserId = '@agent:atumplatform.com'
    const sent: { recipient: unknown; event: { type: string; content: Record<string, unknown> } }[] = []

    const call = vi.fn(async (resource: S1Resource) => {
      if (resource.kind === 'cloud-enrollments') {
        return {
          enrollments: [
            {
              enrollmentId,
              kind: 'cloud',
              executorId: '00000000-0000-4000-8000-951c747b3afc',
              deviceId: 'CLOUDDEVICE1',
              state: 'awaiting_trust',
              trust: 'pending',
              disclosureVersion: 7,
              agentPrincipal: AGENT,
              ownerDevice,
              handoffUntil: now + 600_000,
              createdAt: 1,
              updatedAt: 2
            }
          ]
        }
      }

      if (resource.kind === 'cloud-handoff') {
        return {
          enrollment: {
            enrollmentId,
            kind: 'cloud',
            executorId: '00000000-0000-4000-8000-951c747b3afc',
            deviceId: 'CLOUDDEVICE1',
            state: 'awaiting_trust',
            trust: 'pending',
            disclosureVersion: 7,
            agentPrincipal: AGENT,
            ownerDevice,
            handoffUntil: now + 600_000,
            createdAt: 1,
            updatedAt: 2
          }
        }
      }

      throw new DeviceRegistryError(404)
    })

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [{ principal: AGENT, matrixUser: agentUserId }],
      receive: async () => [
        {
          type: 'io.atum.agent_identity.request',
          senderUserId: agentUserId,
          senderDeviceId: 'CLOUDDEVICE1',
          content: {
            v: 1,
            enrollmentId,
            executorId: '00000000-0000-4000-8000-951c747b3afc',
            agentUserId,
            deviceId: 'CLOUDDEVICE1',
            purpose: 'restore',
            nonce: 'a'.repeat(43),
            expiresAt: now + 60_000
          }
        }
      ],
      send: async (recipient, event) => void sent.push({ recipient, event: event as never }),
      recoveryKey: async () => 'agent recovery key',
      log: () => {},
      pumpMs: 1_000_000
    })

    await enrollments.begin(AGENT, signal())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    enrollments.stop()

    expect(sent[0]!.recipient).toEqual({ userId: agentUserId, deviceId: 'CLOUDDEVICE1' })
    expect(sent[0]!.event.type).toBe('io.atum.agent_identity.grant')
    expect(sent[0]!.event.content).toMatchObject({ enrollmentId, recoveryKey: 'agent recovery key' })
  })
})

it('requests a native workspace for only the named agent and validates the authority answer', () => {
  const agentPrincipal = randomUUID()
  expect(s1Route({ kind: 'workspace', agentPrincipal })).toEqual({ method: 'POST', path: '/cloud/workspaces', body: { agentPrincipal }, bearer: true })
  const answer = { agentPrincipal, grantId: randomUUID(), label: '/Agents/T', createdAt: 1 }
  expect(workspaceLabelFor(answer, agentPrincipal)).toBe('/Agents/T')
  expect(workspaceLabelFor(answer, randomUUID())).toBeNull()
  expect(workspaceLabelFor({ ...answer, token: 'unexpected' }, agentPrincipal)).toBeNull()
  expect(workspaceLabelFor({ ...answer, label: 'relative' }, agentPrincipal)).toBeNull()
})

describe("this Mac's owner, for its device service", () => {
  const human = { userId: '@owner:atumplatform.com', deviceId: 'MACBOOKQ7ZK' }
  const fingerprint = 'aI0n6ZGXFokRaoRUNI2blPYRIkCBcXfENFad4dxrhho'

  const facts = (overrides: Partial<Parameters<typeof resolveDeviceOwner>[0]> = {}) => ({
    human,
    sdkState: 'ready',
    // The human host as main keeps it: `ready` is never set on it (only agent and app hosts).
    host: { identity: human },
    devices: vi.fn(async () => [{ deviceId: 'OTHER', fingerprint: 'x' }, { deviceId: human.deviceId, fingerprint }]),
    fingerprints: new Map<string, string>(),
    ...overrides
  })

  it('is the signed-in device once the human SDK snapshot is ready, without any host ready flag', async () => {
    const input = facts()
    expect(await resolveDeviceOwner(input)).toEqual({ ...human, fingerprint })

    // A device's fingerprint never changes: read once.
    expect(await resolveDeviceOwner(input)).toEqual({ ...human, fingerprint })
    expect(input.devices).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ human: null }, 'matrix_signed_out'],
    [{ sdkState: 'connecting' }, 'device_owner_not_ready'],
    [{ host: undefined }, 'device_owner_not_ready'],
    [{ host: { identity: { ...human, deviceId: 'OLDDEVICE' } } }, 'device_owner_not_ready'],
    [{ devices: async () => Promise.reject(new Error('matrix_sdk_unavailable')) }, 'device_owner_fingerprint_unavailable'],
    [{ devices: async () => [{ deviceId: human.deviceId, fingerprint: '' }] }, 'device_owner_fingerprint_unavailable']
  ])('names why there is no owner yet (%j)', async (overrides, code) => {
    expect(await resolveDeviceOwner(facts(overrides as never))).toBe(code)
  })

  it('refuses to enroll with the reason, logging one line, and never prompts', async () => {
    const { subject, signer, logs } = identity({ owner: async () => 'device_owner_not_ready' })

    await expect(subject.enroll(signal())).rejects.toThrow('device_owner_not_ready')
    expect(logs).toEqual(['[Device] this Mac was not enrolled: device_owner_not_ready'])
    expect(signer.prompts).toHaveLength(0)
  })

  it('logs one line with the code for a question that goes without an origin', async () => {
    const notReady = identity({ owner: async () => 'device_owner_fingerprint_unavailable' })
    expect(await notReady.subject.originFor(question(), { enroll: true })).toBeNull()
    expect(notReady.logs).toEqual(['[Device] question sent without an origin: device_owner_fingerprint_unavailable'])

    // Not asked to enroll: nothing failed, so nothing to say.
    expect(await notReady.subject.originFor(question(), { enroll: false })).toBeNull()
    expect(notReady.logs).toHaveLength(1)

    const owner = identity()
    owner.da.call.mockRejectedValue(new DeviceRegistryError(403, 'policy'))
    expect(await owner.subject.originFor(question(), { enroll: true })).toBeNull()
    expect(await owner.subject.originFor(question('Again'), { enroll: true })).toBeNull()
    expect(owner.logs).toEqual([
      '[Device] question sent without an origin: device_enrollment_refused:policy',
      '[Device] question sent without an origin: device_enrollment_refused:policy'
    ])
    expect(owner.signer.prompts).toEqual([])
  })

  it('says a build without the Secure Enclave helper cannot enroll', async () => {
    const { subject, logs } = identity({ helper: null })

    await expect(subject.enroll(signal())).rejects.toThrow('device_unavailable')
    expect(await subject.originFor(question(), { enroll: true })).toBeNull()
    expect(logs).toEqual([
      '[Device] this Mac was not enrolled: device_unavailable',
      '[Device] question sent without an origin: device_unavailable'
    ])
  })
})

describe('the owner reader', () => {
  const ownerDevice = 'MACBOOKQ7ZK'

  const reader = (state: CloudEnrollmentRecord['state'], trust: CloudEnrollmentRecord['trust'] = 'pending', id = 1) => ({
    enrollmentId: `30000000-0000-4000-8000-00000000000${id}`,
    kind: 'owner_reader' as const,
    executorId: `40000000-0000-4000-8000-00000000000${id}`,
    deviceId: `ATUM_COMPANION_40000000-0000-4000-8000-00000000000${id}`,
    state,
    trust,
    disclosureVersion: OWNER_READER_DISCLOSURE_VERSION,
    ownerDevice,
    createdAt: id,
    updatedAt: id
  })

  it('creates it with no agent, at the disclosure this build shows', () => {
    const requestId = cloudRequestId('reader')

    expect(s1Route({ kind: 'reader-enroll', requestId, ownerDevice, disclosureVersion: 1 })).toEqual({
      method: 'POST',
      path: '/cloud/enrollments',
      body: { requestId, kind: 'owner_reader', ownerDevice, disclosureVersion: 1 },
      bearer: true
    })
    expect(() => s1Route({ kind: 'reader-enroll', requestId: 'x', ownerDevice, disclosureVersion: 1 })).toThrow()
    expect(() => s1Route({ kind: 'reader-enroll', requestId, ownerDevice, disclosureVersion: 0 })).toThrow()
  })

  it.each([
    [[], 'none'],
    [[reader('revoked', 'pending', 2), reader('revoking', 'pending', 1)], 'none'],
    [[reader('provisioning')], 'provisioning'],
    [[reader('awaiting_trust')], 'awaiting_trust'],
    [[reader('active', 'trusted'), reader('revoked', 'pending', 2)], 'ready'],
    // 0.20: an active reader reads plain rooms without the trust hand-off.
    [[reader('active', 'pending')], 'ready'],
    [[reader('failed')], 'needs_attention'],
    [[reader('active', 'recovery_needed')], 'needs_attention']
  ] as const)('reads %j as %s', (rows, state) => {
    expect(ownerReaderState(rows as unknown as CloudEnrollmentRecord[])).toBe(state)
  })

  function platform(rows: unknown[]) {
    const calls: S1Resource[] = []

    const call = vi.fn(async (resource: S1Resource) => {
      calls.push(resource)

      if (resource.kind === 'cloud-enrollments') {
        return { enrollments: rows }
      }

      if (resource.kind === 'reader-enroll') {
        return { enrollment: reader('provisioning', 'pending', 3) }
      }

      throw new DeviceRegistryError(404)
    })

    const enrollments = new CloudAgentEnrollment({
      call,
      ownerDevice: () => ownerDevice,
      roster: async () => [],
      receive: async () => [],
      send: async () => {},
      recoveryKey: async () => null,
      log: () => {}
    })

    return { calls, enrollments }
  }

  it('enrolls this Mac’s device once, and a revoked reader again under a new request', async () => {
    const fresh = platform([])
    expect(await fresh.enrollments.enrollReader(signal())).toBe('provisioning')
    const first = fresh.calls.find(each => each.kind === 'reader-enroll')

    expect(first).toEqual({
      kind: 'reader-enroll',
      requestId: cloudRequestId(`atum.reader-enroll:${ownerDevice}:${OWNER_READER_DISCLOSURE_VERSION}:first`),
      ownerDevice,
      disclosureVersion: OWNER_READER_DISCLOSURE_VERSION
    })

    const again = platform([reader('revoked', 'pending', 2)])
    await again.enrollments.enrollReader(signal())
    expect(again.calls.find(each => each.kind === 'reader-enroll')).not.toMatchObject({
      requestId: (first as { requestId: string }).requestId
    })
  })

  it('returns the reader there is instead of asking for another', async () => {
    const existing = platform([reader('awaiting_trust')])

    expect(await existing.enrollments.enrollReader(signal())).toBe('awaiting_trust')
    expect(existing.calls.map(each => each.kind)).toEqual(['cloud-enrollments'])
  })
})

describe('the account access read', () => {
  it('reads trial, paid and none from the status, and never invents one', () => {
    expect(parseCloudAccess({ access: { effective: 'trial' } })).toEqual({ effective: 'trial' })
    expect(parseCloudAccess({ access: { effective: 'paid' } })).toEqual({ effective: 'paid' })
    expect(parseCloudAccess({ access: { effective: 'none', reason: 'trial_expired' } })).toEqual({
      effective: 'none',
      reason: 'trial_expired'
    })
    // A refusal that names only `none` still means the assistant cannot answer.
    expect(parseCloudAccess({ access: { effective: 'none' } })).toEqual({ effective: 'none' })
    expect(() => parseCloudAccess({})).toThrow()
    expect(() => parseCloudAccess({ access: {} })).toThrow()
    expect(() => parseCloudAccess({ access: { effective: 'paused' } })).toThrow()
    expect(() => parseCloudAccess({ access: { effective: 'none', reason: 'somewhere_else' } })).toThrow()
  })

  it.each(['trial_expired', 'trial_not_accepted', 'paid_lapsed', 'no_offer', 'entitlement_required'] as const)(
    'carries the %s reason the controller uses',
    reason => {
      expect(parseCloudAccess({ access: { effective: 'none', reason } })).toEqual({ effective: 'none', reason })
    }
  )
})

describe('the access change log', () => {
  it('logs a change once, and logs the current account’s first fact again after a switch', () => {
    const log = new CloudAccessLog()

    expect(log.changed('@a:test', { effective: 'trial' })).toBe(true)
    expect(log.changed('@a:test', { effective: 'trial' })).toBe(false)
    expect(log.changed('@a:test', { effective: 'none', reason: 'trial_expired' })).toBe(true)
    expect(log.changed('@a:test', { effective: 'none', reason: 'trial_expired' })).toBe(false)

    // Account B reads the same fact A last had: it is still B's first line.
    expect(log.changed('@b:test', { effective: 'none', reason: 'trial_expired' })).toBe(true)
    expect(log.changed('@b:test', { effective: 'none', reason: 'trial_expired' })).toBe(false)

    // Back to A: the fact changed while B was signed in, so it logs again.
    expect(log.changed('@a:test', { effective: 'trial' })).toBe(true)
  })
})

describe('the cloud trial', () => {
  const terms = {
    durationMs: 604_800_000,
    cardRequired: false,
    autoRenew: false,
    disclosureVersion: 3,
    modelAliases: ['default'],
    includedMicroProtons: 1_000_000,
    includedComputeSeconds: 36_000,
    includedStorageBytes: 1_073_741_824,
    concurrentTasks: 2
  }

  it('reads the offer from the status, and no offer as none', () => {
    expect(
      parseCloudTrial({ access: { effective: 'none' }, trial: { offerVersion: 4, status: 'eligible', startableNow: true, terms } })
    ).toEqual({
      offerVersion: 4,
      status: 'eligible',
      startableNow: true,
      disclosureVersion: 3,
      durationMs: 604_800_000,
      computeSeconds: 36_000,
      concurrentTasks: 2,
      includedMicroProtons: 1_000_000,
      includedStorageBytes: 1_073_741_824
    })
    expect(parseCloudTrial({ access: { effective: 'none' }, trial: null })).toBeNull()
    expect(() => parseCloudTrial({ trial: { offerVersion: 4, status: 'eligible', startableNow: true } })).toThrow()
    expect(() => parseCloudTrial({})).toThrow()
  })

  it.each([
    ['a card', { cardRequired: true }],
    ['a renewal', { autoRenew: true }],
    ['another model', { modelAliases: ['default', 'pro'] }],
    ['another length', { durationMs: 1_209_600_000 }],
    ['no included model credit', { includedMicroProtons: undefined }],
    ['an unbounded storage grant', { includedStorageBytes: 2 ** 52 }],
    ['too many tasks', { concurrentTasks: 6 }]
  ])('refuses an offer with %s, which the copy would misstate', (_label, change) => {
    const offer = { offerVersion: 4, status: 'eligible', startableNow: true, terms: { ...terms, ...change } }

    expect(() => parseCloudTrial({ access: { effective: 'none' }, trial: offer })).toThrow()
  })

  it('refuses a term or trial field the contract does not name, which no confirmation would show', () => {
    const offer = (extra: Record<string, unknown>, termExtra: Record<string, unknown> = {}) => ({
      access: { effective: 'none' },
      trial: { offerVersion: 4, status: 'eligible', startableNow: true, terms: { ...terms, ...termExtra }, ...extra }
    })

    expect(() => parseCloudTrial(offer({}, { requiresPaymentAfterTrial: true }))).toThrow()
    expect(() => parseCloudTrial(offer({ billing: 'monthly' }))).toThrow()
    expect(parseCloudTrial(offer({ acceptedAt: 1_790_672_400_000 }))).not.toBeNull()
  })

  it('matches an acceptance to the whole offer shown, and shows only the named terms', () => {
    const shown = parseCloudTrial({ trial: { offerVersion: 4, status: 'eligible', startableNow: true, terms } })!

    const more = parseCloudTrial({
      trial: { offerVersion: 4, status: 'eligible', startableNow: true, terms: { ...terms, includedComputeSeconds: 3_600 } }
    })!

    expect(sameCloudTrial(shown, { ...shown })).toBe(true)
    expect(sameCloudTrial(shown, more)).toBe(false)
    expect(Object.keys(shownCloudTrial(shown)).sort()).toEqual(
      ['computeSeconds', 'concurrentTasks', 'disclosureVersion', 'durationMs', 'offerVersion', 'startableNow', 'status'].sort()
    )
  })

  it('accepts exactly the offer and disclosure shown, under one request per owner and offer', async () => {
    const call = vi.fn(async (_resource: S1Resource) => ({ trial: { status: 'preparing' } }))
    const input = { ownerUserId: '@owner:atumplatform.com', offerVersion: 4, disclosureVersion: 3 }

    expect(await acceptCloudTrial(call, input, signal())).toBe('preparing')
    expect(call.mock.calls[0]![0]).toEqual({
      kind: 'trial-accept',
      requestId: cloudRequestId('atum.cloud-trial:@owner:atumplatform.com:4:3'),
      offerVersion: 4,
      disclosureVersion: 3
    })
    expect(s1Route(call.mock.calls[0]![0])).toEqual({
      method: 'POST',
      path: '/cloud/trial',
      body: {
        requestId: cloudRequestId('atum.cloud-trial:@owner:atumplatform.com:4:3'),
        operation: 'accept',
        offerVersion: 4,
        disclosureVersion: 3
      },
      bearer: true
    })
    expect(s1Route({ kind: 'cloud-status' })).toEqual({ method: 'GET', path: '/cloud/status', bearer: true })

    call.mockResolvedValueOnce({ trial: { status: 'declined' } })
    await expect(acceptCloudTrial(call, input, signal())).rejects.toThrow()
  })
})
