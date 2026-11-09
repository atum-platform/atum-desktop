import { UserId } from '@matrix-org/matrix-sdk-crypto-wasm'
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api'

interface RustKeyQueryMachine {
  queryKeysForUsers(users: UserId[]): unknown
  updateTrackedUsers?(users: UserId[]): Promise<void>
}

interface RustKeyQuery {
  getOlmMachineOrThrow(): RustKeyQueryMachine
  outgoingRequestProcessor: { makeOutgoingRequest(request: unknown): Promise<void> }
}

function keyQuery(crypto: CryptoApi): {
  machine: RustKeyQueryMachine
  makeOutgoingRequest(request: unknown): Promise<void>
} {
  const rust = crypto as unknown as Partial<RustKeyQuery>

  if (
    typeof rust.getOlmMachineOrThrow !== 'function' ||
    typeof rust.outgoingRequestProcessor?.makeOutgoingRequest !== 'function'
  ) {
    throw new Error('matrix_device_query_unavailable')
  }

  const machine = rust.getOlmMachineOrThrow()

  if (!machine || typeof machine.queryKeysForUsers !== 'function') {
    throw new Error('matrix_device_query_unavailable')
  }

  return {
    machine,
    makeOutgoingRequest: request => rust.outgoingRequestProcessor!.makeOutgoingRequest(request)
  }
}

/** A fetched untracked device is not yet in Rust's verification store. The
 * pinned SDK uses this same out-of-band query when sharing a key bundle with
 * someone before joining their room. No room or permanent tracking is created.
 * Fingerprint comparison and the trust grant remain the caller's next steps. */
export async function loadDeviceForVerification(crypto: CryptoApi, userId: string, deviceId: string): Promise<void> {
  if (await crypto.getDeviceVerificationStatus(userId, deviceId)) {return}
  const { machine, makeOutgoingRequest } = keyQuery(crypto)
  // queryKeysForUsers consumes its UserIds; they must not be freed or reused.
  await makeOutgoingRequest(machine.queryKeysForUsers([new UserId(userId)]))
}

/** Import a first-contact peer's identity into Rust before making a trust decision. Tracking and
 * the explicit owned query are both required: tracking persists future device-list updates, while
 * makeOutgoingRequest feeds this response through markRequestAsSent so Rust imports it now. */
export async function loadIdentityForVerification(crypto: CryptoApi, userId: string): Promise<void> {
  const { machine, makeOutgoingRequest } = keyQuery(crypto)

  if (typeof machine.updateTrackedUsers !== 'function') {
    throw new Error('matrix_device_query_unavailable')
  }

  // Both Rust calls consume their UserIds. Never reuse an instance between them.
  await machine.updateTrackedUsers([new UserId(userId)])
  await makeOutgoingRequest(machine.queryKeysForUsers([new UserId(userId)]))
}
