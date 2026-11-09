import { type MatrixClient, MatrixError, Method } from 'matrix-js-sdk'
import { type SecretStorageKey, ServerSideSecretStorageImpl } from 'matrix-js-sdk/lib/secret-storage'

import type { recoveryKeyCache } from './security'

/** SDK encryption with authoritative reads for native identity setup. The SDK's
 * getAccountDataFromServer normally uses the sync cache after initial sync; that
 * cache cannot decide whether another Mac has already escrowed an identity. */
export function currentSecretStorage(client: MatrixClient, cache: ReturnType<typeof recoveryKeyCache>) {
  const adapter = Object.create(client) as MatrixClient
  adapter.setAccountData = client.setAccountData.bind(client)
  adapter.on = client.on.bind(client)
  adapter.off = client.off.bind(client)

  adapter.getAccountDataFromServer = async type => {
    try {
      return await client.http.authedRequest(
        Method.Get,
        `/user/${encodeURIComponent(client.getUserId()!)}/account_data/${encodeURIComponent(type)}`,
        undefined,
        undefined,
        { prefix: '/_matrix/client/v3' }
      )
    } catch (error) {
      if (error instanceof MatrixError && error.httpStatus === 404 && error.errcode === 'M_NOT_FOUND') {
        return null
      }

      throw error
    }
  }

  return new ServerSideSecretStorageImpl(adapter, cache.callbacks)
}

export function agentRecoverySlot(userId: string) {
  if (!/^@[^:]+:.+$/.test(userId) || userId.length > 1024) {
    throw new Error('matrix_agent_identity_invalid')
  }

  // Namespacing only, not encryption. The SDK encrypts the entire value.
  return `io.atum.agent-recovery.${btoa(String.fromCharCode(...new TextEncoder().encode(userId)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')}` as SecretStorageKey
}
