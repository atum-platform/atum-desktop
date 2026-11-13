/**
 * Test support only: a simulated Mac for the agent-home tests. A software P-256 identity key stands in
 * for the Secure Enclave (`SoftwareDeviceSigner`), a memory map for the device store, and the real
 * `MacExecutorAuth` and `HistoricalFixturePlatform` talk to the in-memory platform through its `fetch`.
 */
import { randomUUID } from 'node:crypto'

import { SoftwareDeviceSigner } from '../device/device-signer.fixture'

import { type ExecutorKey, MacExecutorAuth } from './executor-auth'
import { HistoricalFixturePlatform } from './historical-platform.fixture'
import type { StubHomePlatform } from './stub-platform.fixture'

/** One clock for the platform and every Mac in a test, so signed windows and lease terms agree. */
export class FakeClock {
  constructor(public time = 1_800_000_000_000) {}

  now = (): number => this.time

  advance(ms: number): void {
    this.time += ms
  }
}

export class MemoryStore {
  private readonly values = new Map<string, string>()
  failing: string | null = null

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  keys(prefix = ''): string[] {
    return [...this.values.keys()].filter(key => key.startsWith(prefix))
  }

  failureCode(): string | null {
    return this.failing
  }
}

export interface TestMac {
  name: string
  deviceServiceId: string
  signer: SoftwareDeviceSigner
  store: MemoryStore
  /** The enrollment record the executor key reads; a test moves it to model a re-enrollment. */
  enrollment: { state: 'active' | 'revoked'; enrollmentEpoch: number; identityKid: string }
  key(): ExecutorKey | null
  auth: MacExecutorAuth
  platform: HistoricalFixturePlatform
}

export async function createTestMac(stub: StubHomePlatform, clock: FakeClock, name: string): Promise<TestMac> {
  const signer = new SoftwareDeviceSigner()
  const keys = await signer.publicKeys()
  const deviceServiceId = randomUUID()
  const enrollment: TestMac['enrollment'] = { state: 'active', enrollmentEpoch: 1, identityKid: keys.identity.kid }
  const store = new MemoryStore()

  stub.addDevice({ deviceServiceId, keyId: keys.identity.kid, publicKey: keys.identity.spki })

  const key = (): ExecutorKey | null =>
    enrollment.state === 'active'
      ? {
          deviceServiceId,
          enrollmentEpoch: enrollment.enrollmentEpoch,
          identityKid: enrollment.identityKid,
          signIdentity: bytes => signer.signIdentity(bytes)
        }
      : null

  return {
    name,
    deviceServiceId,
    signer,
    store,
    enrollment,
    key,
    auth: new MacExecutorAuth({ key, store, now: clock.now }),
    platform: new HistoricalFixturePlatform({
      request: send => send(stub.token, 'https://shell.test/api/matrix/v1'),
      fetch: stub.fetch
    })
  }
}
