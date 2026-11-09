// @vitest-environment node
import 'fake-indexeddb/auto'

import { createClient, type MatrixClient } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger'
import { afterEach, describe, expect, it } from 'vitest'

import { type MatrixAgentTrustPort, prepareMatrixAgentTrust } from '../../electron/matrix/agent-trust'
import type { MatrixSdkCommand } from '../../shared/matrix'
import type { MatrixAgentTrustStatus } from '../../shared/matrix-security'

import { matrixSecurity, recoveryKeyCache } from './security'
import { TestHomeserver } from './test-homeserver'

const OWNER = '@owner:atum.test'
const OWNER_DEVICE = 'OWNER'
const AGENT = '@agent:atum.test'
const AGENT_DEVICE = 'AGENT'
const NO_MASTER = '@no-master:atum.test'
const NO_MASTER_DEVICE = 'NO_MASTER'

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

interface CryptoStore {
  cryptoDatabasePrefix: string
  storageKey: Uint8Array<ArrayBuffer>
}

interface TestDevice {
  client: MatrixClient
  security?: ReturnType<typeof matrixSecurity>
}

const devices = new Set<TestDevice>()

afterEach(() => {
  for (const device of devices) {
    device.security?.stop()
    device.client.stopClient()
  }

  devices.clear()
})

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000

  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`agent_identity_import_timeout: ${label}`)
    }

    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function newStore(label: string): CryptoStore {
  return {
    cryptoDatabasePrefix: `agent-identity-${label}-${globalThis.crypto.randomUUID()}`,
    storageKey: globalThis.crypto.getRandomValues(new Uint8Array(32))
  }
}

async function createDevice(input: {
  server: TestHomeserver
  userId: string
  deviceId: string
  accessToken: string
  store: CryptoStore
  start?: boolean
  observeFetch?: (input: string | URL | Request, init: RequestInit | undefined) => void
}): Promise<TestDevice> {
  const client = createClient({
    baseUrl: input.server.baseUrl,
    userId: input.userId,
    deviceId: input.deviceId,
    accessToken: input.accessToken,
    fetchFn: async (request, init) => {
      input.observeFetch?.(request, init)

      return input.server.fetch(request, init)
    },
    verificationMethods: ['m.sas.v1'],
    logger: quiet
  })

  await client.initRustCrypto(input.store)
  const device = { client }
  devices.add(device)

  if (input.start !== false) {
    await client.startClient({ initialSyncLimit: 1, pollTimeout: 100 })
    await until(() => client.isInitialSyncComplete(), `${input.userId} initial sync`)
  }

  return device
}

function stopDevice(device: TestDevice): void {
  device.security?.stop()
  device.client.stopClient()
  devices.delete(device)
}

async function publishIdentity(device: TestDevice): Promise<void> {
  const crypto = device.client.getCrypto()!
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: request => request({})
  })
  await until(
    async () =>
      (await crypto.getUserVerificationStatus(device.client.getUserId()!)).known === true &&
      (await crypto.getDeviceVerificationStatus(device.client.getUserId()!, device.client.getDeviceId()!))
        ?.signedByOwner === true,
    `${device.client.getUserId()} identity publication`
  )
}

function queryIncludes(request: string | URL | Request, init: RequestInit | undefined, userId: string): boolean {
  const url = new URL(
    typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
  )

  if (!url.pathname.endsWith('/keys/query') || typeof init?.body !== 'string') {
    return false
  }

  const body = JSON.parse(init.body) as { device_keys?: Record<string, unknown> }

  return Object.hasOwn(body.device_keys ?? {}, userId)
}

function attachSecurity(device: TestDevice): ReturnType<typeof matrixSecurity> {
  const security = matrixSecurity(device.client, recoveryKeyCache(), () => {})
  device.security = security

  return security
}

describe('agent trust identity import (real Rust crypto)', () => {
  it('imports an untracked agent identity through the app boundary and persists it without granting trust', async () => {
    const server = new TestHomeserver(OWNER)
    const agentToken = server.signInAs(AGENT, AGENT_DEVICE)

    const agent = await createDevice({
      server,
      userId: AGENT,
      deviceId: AGENT_DEVICE,
      accessToken: agentToken,
      store: newStore('agent')
    })

    await publishIdentity(agent)
    const agentKey = (await agent.client.getCrypto()!.getOwnDeviceKeys()).ed25519

    const ownerToken = server.signInAs(OWNER, OWNER_DEVICE)
    const ownerStore = newStore('owner')

    const owner = await createDevice({
      server,
      userId: OWNER,
      deviceId: OWNER_DEVICE,
      accessToken: ownerToken,
      store: ownerStore
    })

    const ownerCrypto = owner.client.getCrypto()!

    // This is the production failure: the SDK's uncached fallback returns a JS device map but
    // never imports the same response into the Rust identity store.
    const downloaded = await ownerCrypto.getUserDeviceInfo([AGENT], true)
    expect(downloaded.get(AGENT)?.get(AGENT_DEVICE)?.getFingerprint()).toBe(agentKey)
    expect((await ownerCrypto.getUserVerificationStatus(AGENT)).known).toBe(false)

    const result = (await attachSecurity(owner).nativeCommand({
      kind: 'agentTrustStatus',
      peer: { userId: AGENT, deviceId: AGENT_DEVICE }
    })) as MatrixAgentTrustStatus

    expect(result).toMatchObject({
      peerKey: agentKey,
      peerIdentityKnown: true,
      peerIdentityVerified: false
    })

    stopDevice(owner)
    let restartedAgentQueries = 0

    const restarted = await createDevice({
      server,
      userId: OWNER,
      deviceId: OWNER_DEVICE,
      accessToken: ownerToken,
      store: ownerStore,
      start: false,
      observeFetch: (request, init) => {
        if (queryIncludes(request, init, AGENT)) {
          restartedAgentQueries += 1
        }
      }
    })

    const restartedCrypto = restarted.client.getCrypto()!

    expect((await restartedCrypto.getUserVerificationStatus(AGENT)).known).toBe(true)
    expect((await restartedCrypto.getUserDeviceInfo([AGENT], false)).get(AGENT)?.get(AGENT_DEVICE)?.getFingerprint())
      .toBe(agentKey)
    expect(restartedAgentQueries).toBe(0)
  }, 90_000)

  it('keeps a peer without a master key unknown and never falls back to device-only SAS', async () => {
    const server = new TestHomeserver(OWNER)
    const peerToken = server.signInAs(NO_MASTER, NO_MASTER_DEVICE)

    const peer = await createDevice({
      server,
      userId: NO_MASTER,
      deviceId: NO_MASTER_DEVICE,
      accessToken: peerToken,
      store: newStore('no-master')
    })

    const peerKey = (await peer.client.getCrypto()!.getOwnDeviceKeys()).ed25519
    let noMasterQueries = 0

    const owner = await createDevice({
      server,
      userId: OWNER,
      deviceId: OWNER_DEVICE,
      accessToken: server.signInAs(OWNER, OWNER_DEVICE),
      store: newStore('negative-owner'),
      observeFetch: (request, init) => {
        if (queryIncludes(request, init, NO_MASTER)) {
          noMasterQueries += 1
        }
      }
    })

    const security = attachSecurity(owner)

    const status = (await security.nativeCommand({
      kind: 'agentTrustStatus',
      peer: { userId: NO_MASTER, deviceId: NO_MASTER_DEVICE }
    })) as MatrixAgentTrustStatus

    expect(status).toMatchObject({
      peerKey,
      peerIdentityKnown: false,
      peerIdentityVerified: false,
      peerDeviceCrossSigned: false
    })
    expect((await owner.client.getCrypto()!.getUserVerificationStatus(NO_MASTER)).known).toBe(false)

    const ownerPort: MatrixAgentTrustPort = {
      identity: { userId: OWNER, deviceId: OWNER_DEVICE },
      command: async (command: MatrixSdkCommand) => {
        if (command.kind === 'agentRecoveryKey') {
          return 'synthetic-existing-recovery'
        }

        if (command.kind === 'agentTrustStatus') {
          return security.nativeCommand(command)
        }

        throw new Error(`unexpected_owner_command:${command.kind}`)
      }
    }

    const agentPort: MatrixAgentTrustPort = {
      identity: { userId: NO_MASTER, deviceId: NO_MASTER_DEVICE },
      command: async command => {
        if (command.kind === 'agentIdentityStatus') {
          return { ready: true, recovery: true }
        }

        if (command.kind === 'agentTrustStatus') {
          return {
            ownKey: peerKey,
            peerKey: status.ownKey,
            peerIdentityKnown: true,
            peerIdentityVerified: false,
            peerDeviceCrossSigned: false,
            ownDeviceCrossSigned: false
          } satisfies MatrixAgentTrustStatus
        }

        throw new Error(`device_only_sas_started:${command.kind}`)
      }
    }

    let now = 0

    // The trust loop asks both ports every 500 ms for 5 s (~10 iterations). The renderer must
    // not spend one /keys/query per poll on a peer that has no identity to find; at most one
    // unavoidable SDK-tracked-user follow-up may still land.
    noMasterQueries = 0

    await expect(
      prepareMatrixAgentTrust({
        owner: ownerPort,
        agent: agentPort,
        ownerKey: 'synthetic-owner-recovery',
        claim: async () => {
          throw new Error('unexpected_initializer_claim')
        },
        assertCurrent: () => {},
        now: () => now,
        wait: async milliseconds => {
          now += milliseconds
        }
      })
    ).rejects.toThrow('matrix_agent_initialization_pending')
    expect(noMasterQueries).toBeLessThanOrEqual(2)
  }, 90_000)
})
