import { EventEmitter } from 'node:events'

import { type MatrixClient, MatrixError, Method } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { agentRecoverySlot, currentSecretStorage } from './secret-storage'
import { recoveryKeyCache } from './security'

describe('authoritative SDK secret storage reads', () => {
  const fixture = () => {
    const request = vi.fn()
    const cached = vi.fn(async () => null)

    const client = Object.assign(new EventEmitter(), {
      getUserId: () => '@owner:test',
      getAccountDataFromServer: cached,
      setAccountData: vi.fn(),
      http: { authedRequest: request }
    }) as unknown as MatrixClient

    return { client, request, cached, storage: currentSecretStorage(client, recoveryKeyCache()) }
  }

  it('does not turn a sync-cache miss into permission to create another identity', async () => {
    const { storage, cached, request } = fixture()
    request.mockResolvedValue({ key: 'already-created-on-other-mac' })
    expect(await storage.getDefaultKeyId()).toBe('already-created-on-other-mac')
    expect(cached).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      Method.Get,
      '/user/%40owner%3Atest/account_data/m.secret_storage.default_key',
      undefined,
      undefined,
      { prefix: '/_matrix/client/v3' }
    )
  })

  it('only treats an explicit 404 M_NOT_FOUND as absence; network and server errors remain errors', async () => {
    const { storage, request } = fixture()
    request.mockRejectedValueOnce(new MatrixError({ errcode: 'M_NOT_FOUND', error: 'none' }, 404))
    expect(await storage.getDefaultKeyId()).toBeNull()

    for (const error of [
      new Error('offline'),
      new MatrixError({ errcode: 'M_NOT_FOUND', error: 'bad' }, 503),
      new MatrixError({ errcode: 'M_UNKNOWN', error: 'bad' }, 404)
    ]) {
      request.mockRejectedValueOnce(error)
      await expect(storage.getDefaultKeyId()).rejects.toBe(error)
    }
  })

  it('namespaces separate exact Matrix identities, including Unicode, without using room or display names', () => {
    expect(agentRecoverySlot('@a:test')).not.toBe(agentRecoverySlot('@a:other'))
    expect(agentRecoverySlot('@trợlý:test')).toMatch(/^io\.atum\.agent-recovery\.[A-Za-z0-9_-]+$/)
    expect(() => agentRecoverySlot('display name')).toThrow('invalid')
  })
})
