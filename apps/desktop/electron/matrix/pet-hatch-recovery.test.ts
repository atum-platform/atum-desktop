import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PET_DEFAULT_SCALE } from '../../shared/matrix-pet'
import type { MatrixStoreResult } from '../../shared/matrix-store'

import {
  matrixPetHatchScale,
  matrixPetPublicationNeedsAttention,
  MatrixPetRecoveryFlights,
  quarantineMatrixPetRecord,
  recoverMatrixPetCredit
} from './pet-hatch-recovery'

const intent = { accountKey: 'account', operationId: 'operation', offerId: 'offer', offerVersion: 1 }
const credit = {
  id: 'paid-credit',
  itemId: 'pet/hatch-first',
  kind: 'pet' as const,
  state: 'active' as const,
  assistantId: null,
  delivery: 'bundled' as const,
  grantedAt: '2026-10-03T00:00:00Z',
  subscription: null
}
const owned: MatrixStoreResult = { outcome: 'already_owned', purchase: null, entitlement: credit }

describe('hatch intent size', () => {
  it('keeps the size already chosen, and otherwise saves the same default as a first pick', () => {
    expect(matrixPetHatchScale({ scale: 0.5 })).toBe(0.5)
    expect(matrixPetHatchScale({ scale: 2.4 })).toBe(2.4)
    expect(matrixPetHatchScale(null)).toBe(MATRIX_PET_DEFAULT_SCALE)
    expect(matrixPetHatchScale(undefined)).toBe(MATRIX_PET_DEFAULT_SCALE)
  })
})

describe('publication recovery classification', () => {
  it.each(['invalid', 'conflict', 'missing', 'denied'])('parks a terminal %s response, including a withdrawn credit', code => {
    expect(matrixPetPublicationNeedsAttention(new Error(`matrix_agent_definition_${code}`))).toBe(true)
  })
  it('retries an outage, while quota and reserved-credit responses need attention', () => {
    expect(matrixPetPublicationNeedsAttention(new Error('matrix_agent_definition_unavailable'))).toBe(false)
    expect(matrixPetPublicationNeedsAttention(new Error('payload_too_large'))).toBe(true)
    expect(matrixPetPublicationNeedsAttention(new Error('pet_credit_reserved'))).toBe(true)
  })
})

describe('paid hatch recovery boundaries', () => {
  it('persists its known financial key before the Store journal or any dispatch', async () => {
    const saved: (typeof intent)[] = []
    const port = {
      save: vi.fn(value => saved.push(value)),
      clear: vi.fn(),
      resume: vi.fn(async (key, terms) => {
        expect(saved.at(-1)).toEqual({ ...intent, purchaseKey: intent.operationId })
        expect(key).toBe(intent.operationId)
        expect(terms).toEqual({ offerId: intent.offerId, offerVersion: 1 })
        return owned
      })
    }
    expect(await recoverMatrixPetCredit(intent, port, true)).toEqual({
      ...intent,
      purchaseKey: intent.operationId,
      creditEntitlementId: credit.id
    })
    expect(port.save).toHaveBeenLastCalledWith(expect.objectContaining({ creditEntitlementId: credit.id }))
  })

  it('does not dispatch if persisting the financial key fails', async () => {
    const port = {
      save: vi.fn(() => {
        throw new Error('disk full')
      }),
      clear: vi.fn(),
      resume: vi.fn()
    }
    await expect(recoverMatrixPetCredit(intent, port, true)).rejects.toThrow('disk full')
    expect(port.resume).not.toHaveBeenCalled()
  })

  it('background work cannot prepare a new charge and restart replays the same key', async () => {
    const port = { save: vi.fn(), clear: vi.fn(), resume: vi.fn(async () => owned) }
    await expect(recoverMatrixPetCredit(intent, port)).rejects.toThrow('needs_confirmation')
    expect(port.resume).not.toHaveBeenCalled()
    await recoverMatrixPetCredit({ ...intent, purchaseKey: 'original-key' }, port)
    expect(port.resume).toHaveBeenCalledWith('original-key', { offerId: 'offer', offerVersion: 1 })
  })

  it.each([
    {
      outcome: 'offer_changed',
      offer: {
        id: 'offer',
        version: 2,
        priceMicroProtons: 1,
        scope: 'account',
        billingInterval: 'one_time',
        delivery: 'bundled'
      }
    },
    { outcome: 'refused', code: 'pet_credit_reserved' },
    { outcome: 'refused', code: 'insufficient_protons' },
    { outcome: 'purchased', purchase: { state: 'reversed' }, entitlement: credit }
  ])('clears a terminal outcome and never substitutes another credit: %j', async result => {
    const port = { save: vi.fn(), clear: vi.fn(), resume: vi.fn(async () => result as MatrixStoreResult) }
    await expect(recoverMatrixPetCredit({ ...intent, purchaseKey: 'original-key' }, port)).rejects.toThrow(
      'matrix_pet_'
    )
    expect(port.clear).toHaveBeenCalledExactlyOnceWith('account')
    expect(port.save).not.toHaveBeenCalled()
  })

  it('uses its reserved credit without a catalog lookup or second purchase', async () => {
    const port = { save: vi.fn(), clear: vi.fn(), resume: vi.fn() }
    const original = { ...intent, purchaseKey: 'original-key', creditEntitlementId: 'reserved-credit' }
    expect(await recoverMatrixPetCredit(original, port)).toBe(original)
    expect(port.resume).not.toHaveBeenCalled()
  })

  it('waits for delivery and never publishes a still-pending entitlement', async () => {
    const port = {
      save: vi.fn(),
      clear: vi.fn(),
      resume: vi.fn(
        async () =>
          ({
            outcome: 'purchased',
            purchase: { state: 'granted' },
            entitlement: credit
          }) as MatrixStoreResult
      )
    }
    await expect(recoverMatrixPetCredit({ ...intent, purchaseKey: 'key' }, port)).rejects.toThrow('recovering')
    expect(port.save).not.toHaveBeenCalled()
  })
})

describe('IPC and lifecycle flight', () => {
  it('runs one bind even when work synchronously publishes lifecycle updates', async () => {
    const flights = new MatrixPetRecoveryFlights<number>()
    let finish!: (value: number) => void
    const bind = vi.fn()
    const work = vi.fn(async () => {
      void flights.background('account', work)
      await new Promise<number>(resolve => {
        finish = resolve
      })
      bind()
      return 7
    })
    const ipc = flights.run('account', work)
    const lifecycle = flights.background('account', work)
    const adopt = flights.run('account', work)
    expect(adopt).toBe(ipc)
    await Promise.resolve()
    finish(7)
    expect(await ipc).toBe(7)
    await lifecycle
    expect(work).toHaveBeenCalledTimes(1)
    expect(bind).toHaveBeenCalledTimes(1)
    expect(flights.busy('account')).toBe(false)
  })

  it('backs off state-update retries to five minutes and explicit retry can proceed', async () => {
    let clock = 0
    const flights = new MatrixPetRecoveryFlights<number>(() => clock)
    const fail = vi.fn(async () => {
      throw new Error('provider offline')
    })
    await flights.background('account', fail)
    for (let i = 0; i < 30; i++) {await flights.background('account', fail)}
    expect(fail).toHaveBeenCalledTimes(1)
    clock = 2_000
    await flights.background('account', fail)
    expect(fail).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 7; i++) {await expect(flights.run('account', fail)).rejects.toThrow('offline')}
    clock += 299_999
    await flights.background('account', fail)
    expect(fail).toHaveBeenCalledTimes(9)
    clock++
    await flights.background('account', fail)
    expect(fail).toHaveBeenCalledTimes(10)
    const succeed = vi.fn(async () => 1)
    await flights.run('account', succeed)
    await flights.background('account', succeed)
    expect(succeed).toHaveBeenCalledTimes(2)
  })
})

describe('corrupt-record isolation', () => {
  it('quarantines only the hatch while preserving unrelated encrypted outcomes', () => {
    const records = new Map([
      ['active', '{old-format'],
      ['another-account', 'unchanged']
    ])
    const store = {
      getItem: key => records.get(key) ?? null,
      setItem: (key, value) => {
        records.set(key, value)
      },
      removeItem: key => {
        records.delete(key)
      }
    }
    expect(quarantineMatrixPetRecord(store, 'active', 'quarantine')).toBe(true)
    expect(records.get('quarantine')).toBe('{old-format')
    expect(records.get('another-account')).toBe('unchanged')
    expect(records.has('active')).toBe(false)
  })

  it('never throws or removes evidence when quarantine persistence fails', () => {
    const removeItem = vi.fn()
    expect(() =>
      quarantineMatrixPetRecord(
        {
          getItem: key => (key === 'active' ? 'bad' : null),
          setItem: () => {
            throw new Error('disk full')
          },
          removeItem
        },
        'active',
        'quarantine'
      )
    ).not.toThrow()
    expect(removeItem).not.toHaveBeenCalled()
  })
})
