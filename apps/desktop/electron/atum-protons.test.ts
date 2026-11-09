import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { ProtonRewardClaim, ProtonRewards } from '../shared/atum-proton-rewards'

import { AccountRootAuthority } from './atum-messaging/account-roots'
import type { ProtonWallet } from './atum-messaging/types'
import * as protons from './atum-protons'
import { ATUM_PROTONS_IPC_CHANNELS, registerAtumProtonsIpc } from './atum-protons-ipc'

const { AtumProtonsService } = protons
const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function roots(): AccountRootAuthority {
  const root = mkdtempSync(join(tmpdir(), 'atum-protons-'))
  directories.push(root)
  const authority = new AccountRootAuthority(root)
  authority.commit(ACCOUNT_A, 1)

  return authority
}

const wallet: ProtonWallet = {
  balanceProtons: 10,
  spendingEnabled: false,
  availableProtons: 8.25, heldProtons: 1.75, trialProtons: 0, aiProtonsPerUsd: 40_500,
  funded: true
}

test('returns only the frozen snake_case read-only wallet projection', async () => {
  const service = new AtumProtonsService({
    accountRoots: roots(),
    session: () => ({ user: { id: ACCOUNT_A } }),
    client: { protonWallet: async () => ({ ...wallet, availableProtons: 12_345.6789 }) }
  })

  assert.deepEqual(await service.wallet(), {
    balance_protons: 10,
    spending_enabled: false,
    available_protons: 12_345.6789, held_protons: 1.75, trial_protons: 0, ai_protons_per_usd: 40_500,
    funded: true
  })
})

test('a wallet read that resolves after an account change is refused', async () => {
  const authority = roots()
  let finish!: (value: ProtonWallet) => void

  const service = new AtumProtonsService({
    accountRoots: authority,
    session: () => ({ user: { id: ACCOUNT_A } }),
    client: { protonWallet: () => new Promise(resolve => { finish = resolve }) }
  })

  const pending = service.wallet()
  authority.commit(ACCOUNT_B, 2)
  authority.commit(ACCOUNT_A, 3)
  finish(wallet)
  await assert.rejects(pending, /account_context_changed/)
})

test('the retired desktop checkout has no service method or IPC channel left', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const unregister = registerAtumProtonsIpc(
    { handle: (channel, listener) => handlers.set(channel, listener), removeHandler: channel => handlers.delete(channel) },
    { wallet: async () => ({}), rewards: async () => ({}), claimConnectionReward: async () => ({}) } as never,
    { assertTrustedSender: event => { if (event !== 'trusted') {throw new Error('not_trusted')} } }
  )

  assert.deepEqual([...handlers.keys()].sort(), ['atum:protons:rewards', 'atum:protons:rewards:claim', 'atum:protons:wallet'])
  assert.deepEqual([...ATUM_PROTONS_IPC_CHANNELS].sort(), [...handlers.keys()].sort())
  assert.throws(() => handlers.get('atum:protons:wallet')!('forged'), /not_trusted/)
  unregister()
  assert.equal(handlers.size, 0)

  const service = new AtumProtonsService({ accountRoots: roots(), session: () => ({ user: { id: ACCOUNT_A } }), client: { protonWallet: async () => wallet } })

  for (const method of ['createOrder', 'order', 'openCheckout']) {
    assert.equal(method in service, false)
  }

  assert.equal('checkoutUrlForPendingOrder' in protons, false)
})

test('reward IPC only consumes connector proof in main and fences account changes before cloud dispatch', async () => {
  const authority = roots()
  let session = ACCOUNT_A
  let proof!: (token: string) => Promise<ProtonRewardClaim>
  const sent: unknown[] = []

  const service = new AtumProtonsService({
    accountRoots: authority, session: () => ({ user: { id: session } }),
    client: {
      protonWallet: async () => wallet,
      claimProtonConnectionReward: async (kind, token) => { sent.push({ kind, token });

 return { state: 'earned', amount_protons: 3000 } }
    },
    withGoogleConnectionProof: async (_kind, consume) => { proof = consume;

 return consume('ephemeral-only') }
  })

  const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
  registerAtumProtonsIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, service,
    { assertTrustedSender: event => { assert.equal(event, 'trusted') } })
  assert.throws(() => handlers.get('atum:protons:rewards:claim')!('untrusted', 'email'))
  assert.throws(() => handlers.get('atum:protons:rewards:claim')!('trusted', { kind: 'email', token: 'forged' }))
  const result = await handlers.get('atum:protons:rewards:claim')!('trusted', 'email')
  assert.deepEqual(result, { state: 'earned', amount_protons: 3000 })
  assert.deepEqual(sent, [{ kind: 'email', token: 'ephemeral-only' }])
  session = ACCOUNT_B
  authority.commit(ACCOUNT_B, 2)
  await assert.rejects(proof('late-token'), /account_context_changed/)
  assert.equal(sent.length, 1)
})

test('late reward projection is rejected after A to B to A transition', async () => {
  const authority = roots()
  let finish!: (value: ProtonRewards) => void

  const service = new AtumProtonsService({
    accountRoots: authority, session: () => ({ user: { id: ACCOUNT_A } }),
    client: {
      protonWallet: async () => wallet,
      protonRewards: () => new Promise(resolve => { finish = resolve })
    }
  })

  const pending = service.rewards()
  authority.commit(ACCOUNT_B, 2)
  authority.commit(ACCOUNT_A, 3)
  finish({ version: 1, state: 'available', total_earned_protons: 0, tasks: [] })
  await assert.rejects(pending, /account_context_changed/)
})
