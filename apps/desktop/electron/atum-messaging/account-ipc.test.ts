import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import type { AtumAccountAuthController } from './account-auth'
import { assertTrustedAtumAccountSender, ATUM_ACCOUNT_IPC_CHANNELS, registerAtumAccountIpc } from './account-ipc'

test('account IPC sender authority rejects remote origins and non-owner frames', () => {
  const trusted = {
    hasOwner: true,
    ownsWebContents: true,
    isMainFrame: true,
    url: 'file:///Applications/Atum/resources/app/index.html'
  }

  assert.doesNotThrow(() => assertTrustedAtumAccountSender(trusted))
  assert.doesNotThrow(() =>
    assertTrustedAtumAccountSender({
      ...trusted,
      url: 'http://127.0.0.1:5173/chat',
      devServerUrl: 'http://127.0.0.1:5173'
    })
  )

  for (const spoofed of [
    { ...trusted, url: 'https://attacker.example/' },
    { ...trusted, url: 'http://127.0.0.1:5174/', devServerUrl: 'http://127.0.0.1:5173' },
    { ...trusted, hasOwner: false },
    { ...trusted, ownsWebContents: false },
    { ...trusted, isMainFrame: false },
    { ...trusted, url: 'not a URL' }
  ]) {
    assert.throws(() => assertTrustedAtumAccountSender(spoofed), /atum_account_sender_not_allowed/)
  }
})

test('account IPC exposes only sanitized commands and status', async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()

  const ipc = {
    handle(channel: string, listener: (...args: any[]) => unknown) {
      handlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    }
  }

  const sanitized = {
    state: 'signed_in' as const,
    configured: true,
    account: { id: 'account-a', displayName: 'Minh', handle: null },
    current: { authority: 'supabase' as const, accountId: 'account-a', sessionGeneration: 2, expiresAt: 4_102_444_800 },
    errorCode: null,
    providers: { google: false, password: true }
  }

  const controller = {
    status: vi.fn(() => sanitized),
    retryRestore: vi.fn(async () => sanitized),
    signIn: vi.fn(async () => sanitized),
    signInWithPassword: vi.fn(async () => sanitized),
    cancel: vi.fn(() => sanitized),
    signOut: vi.fn(async () => ({ ...sanitized, state: 'signed_out', account: null }))
  } as unknown as AtumAccountAuthController

  const unregister = registerAtumAccountIpc(ipc, controller, {
    assertTrustedSender(event) {
      if ((event as { spoofed?: boolean }).spoofed) {
        throw new Error('atum_account_sender_not_allowed')
      }
    }
  })

  assert.deepEqual([...handlers.keys()].sort(), [...ATUM_ACCOUNT_IPC_CHANNELS].sort())
  assert.equal(
    [...handlers.keys()].some(channel => /token|refresh|verifier|secret|fetch|supabase/i.test(channel)),
    false
  )
  const rendered = JSON.stringify(await handlers.get('atum:account:status')!({}))
  assert.equal(/access|refresh|verifier|anon.?key/i.test(rendered), false)
  assert.throws(() => handlers.get('atum:account:status')!({ spoofed: true }), /atum_account_sender_not_allowed/)
  assert.throws(() => handlers.get('atum:account:retry-restore')!({ spoofed: true }), /atum_account_sender_not_allowed/)
  assert.deepEqual(await handlers.get('atum:account:retry-restore')!({}), sanitized)
  assert.equal(vi.mocked(controller.retryRestore).mock.calls.length, 1)

  const passwordInput = { identifier: ' OWNER@Example.Test ', password: 'dogfood-password-123', token: 'forged' }
  const passwordStatus = await handlers.get('atum:account:sign-in-password')!({}, passwordInput)
  assert.deepEqual(passwordStatus, sanitized)
  assert.deepEqual(vi.mocked(controller.signInWithPassword).mock.calls[0]?.[0], {
    identifier: 'owner@example.test',
    password: 'dogfood-password-123'
  })
  assert.doesNotMatch(JSON.stringify(passwordStatus), /owner@example|dogfood-password/i)

  await handlers.get('atum:account:sign-in-password')!(
    {},
    {
      identifier: '@Minh-Owner',
      password: 'dogfood-password-123'
    }
  )
  await handlers.get('atum:account:sign-in-password')!(
    {},
    {
      identifier: '0912 345 678',
      password: 'dogfood-password-123'
    }
  )
  await handlers.get('atum:account:sign-in-password')!(
    {},
    {
      identifier: '84912345678',
      password: 'dogfood-password-123'
    }
  )
  await handlers.get('atum:account:sign-in-password')!(
    {},
    {
      identifier: 'owner@example.test',
      password: 'x'
    }
  )
  assert.deepEqual(
    vi
      .mocked(controller.signInWithPassword)
      .mock.calls.slice(1)
      .map(call => call[0]?.identifier),
    ['minh-owner', '+84912345678', '+84912345678', 'owner@example.test']
  )

  for (const invalid of [
    null,
    { identifier: `${'a'.repeat(250)}@example.test`, password: 'dogfood-password-123' },
    { identifier: 'owner@example.test', password: '' },
    { identifier: 'owner@example.test', password: 'x'.repeat(4097) },
    { identifier: 'owner@example.test', password: 'password\0secret' },
    { identifier: '+841234', password: 'dogfood-password-123' },
    { identifier: 'ab', password: 'dogfood-password-123' },
    { identifier: 'invalid_handle', password: 'dogfood-password-123' }
  ]) {
    vi.mocked(controller.status).mockReturnValueOnce({
      ...sanitized,
      state: 'signed_out',
      account: null,
      current: null
    })
    assert.deepEqual(await handlers.get('atum:account:sign-in-password')!({}, invalid), {
      ...sanitized,
      state: 'error',
      account: null,
      current: null,
      errorCode: 'account_credentials_invalid'
    })
  }

  assert.equal(vi.mocked(controller.signInWithPassword).mock.calls.length, 5)

  unregister()
  assert.equal(handlers.size, 0)
})
