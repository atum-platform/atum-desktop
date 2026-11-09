import { expect, it } from 'vitest'

import type { MatrixWalletState } from '../../shared/matrix-wallet'

import { parseMatrixCommand } from './ipc-policy'
import { matrixStarterNotice, requireMatrixStarterAcknowledgement } from './starter-notice'

const ready: MatrixWalletState = { state: 'ready', wallet: { unit: 'micro_proton',
  balances: { available: 1, paid: 0, earned: 0, promo: 1, held: 0 }, checkoutOpen: false,
  allowance: { kind: 'founding', state: 'granted', amount: 50_000_000_000, grantedAt: '2026-10-02T00:00:00Z' } } }

it('projects the provider historical allowance only for a ready synced unseen owner', () => {
  expect(matrixStarterNotice(ready, 'unseen', true)).toEqual({ kind: 'founding', amount: 50_000_000_000 })

  for (const marker of ['seen', 'unknown', undefined] as const) { expect(matrixStarterNotice(ready, marker, true)).toBeUndefined() }
  expect(matrixStarterNotice(ready, 'unseen', false)).toBeUndefined()
  expect(matrixStarterNotice({ state: 'unavailable', wallet: null }, 'unseen', true)).toBeUndefined()
  expect(matrixStarterNotice({ ...ready, wallet: { ...ready.wallet, allowance: { ...ready.wallet.allowance!, state: 'deferred', grantedAt: null } } }, 'unseen', true)).toBeUndefined()
})

it('accepts only the named bounded identity/scope command and rejects predecessor accounts/generations', () => {
  const identity = { userId: '@alice:test', deviceId: 'ONE' }
  const command = parseMatrixCommand({ kind: 'starterSeen', identity, scope: 'generation-1', accountData: 'arbitrary' })
  expect(command).toEqual({ kind: 'starterSeen', identity, scope: 'generation-1' })

  if (command.kind !== 'starterSeen') { throw new Error('wrong command') }
  const offered = { kind: 'founding' as const, amount: 50_000_000_000 }
  expect(() => requireMatrixStarterAcknowledgement(command, identity, 'generation-1', offered)).not.toThrow()
  expect(() => requireMatrixStarterAcknowledgement(command, identity, 'generation-2', offered)).toThrow('stale')
  expect(() => requireMatrixStarterAcknowledgement(command, { ...identity, userId: '@bob:test' }, 'generation-1', offered)).toThrow('stale')
  expect(() => requireMatrixStarterAcknowledgement(command, identity, 'generation-1', undefined)).toThrow('stale')

  for (const input of [{ kind: 'starterSeen' }, { kind: 'starterSeen', identity, scope: '' }, { kind: 'starterSeen', identity: { ...identity, deviceId: '' }, scope: 'ok' }]) {
    expect(() => parseMatrixCommand(input)).toThrow('invalid')
  }
})
