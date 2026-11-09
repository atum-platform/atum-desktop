import { expect, it, vi } from 'vitest'

import { type FirstRunGoogleAuthority, MatrixFirstRunGoogleValue } from './first-run-google'

function fixture() {
  let generation = 1
  const owner = {}
  const request = vi.fn<FirstRunGoogleAuthority['request']>(async action =>
    action === 'admit' ? { state: 'created', routineId: 'one' } : { state: 'cancelled' }
  )
  const authority = { request }
  const value = new MatrixFirstRunGoogleValue({ log: vi.fn() })
  const input = {
    locale: 'en' as const,
    scope: () => ({ accountKey: 'a'.repeat(64), generation }),
    authority: () => authority,
    owner: () => owner,
    eligible: () => true,
    local: () => true
  }

  return { value, input, authority, request, switchAccount: () => generation++ }
}

it('claims the durable one-shot, cancels its fallback, and hands a local home a hidden turn', async () => {
  const f = fixture()

  expect(await f.value.claim(f.input)).toBe('run_here')
  expect(f.request.mock.calls).toEqual([
    ['admit', 'en'],
    ['cancel', 'en']
  ])
})

it('keeps a newly created occurrence for a cloud or remote home without creating an owner turn', async () => {
  const f = fixture()

  expect(await f.value.claim({ ...f.input, local: () => false })).toBe('remote')
  expect(f.request).toHaveBeenCalledExactlyOnceWith('admit', 'en')
})

it.each([
  ['existing', 'remote'],
  ['in_flight', 'remote'],
  ['cancelled', 'done']
] as const)('maps platform replay %s to %s without a second owner turn', async (state, expected) => {
  const f = fixture()
  f.request.mockResolvedValue({ state })

  expect(await f.value.claim(f.input)).toBe(expected)
  expect(f.request).toHaveBeenCalledExactlyOnceWith('admit', 'en')
})

it('keeps the durable fallback when cancellation loses the dispatch race', async () => {
  const f = fixture()
  f.request
    .mockResolvedValueOnce({ state: 'created', routineId: 'one' })
    .mockResolvedValueOnce({ state: 'in_flight', routineId: 'one' })

  expect(await f.value.claim(f.input)).toBe('remote')
})

it('account switch while admission is pending cancels the captured old authority', async () => {
  const f = fixture()
  let finish!: () => void
  f.request.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => resolve({ state: 'created' })
      })
  )
  const work = f.value.claim(f.input)
  await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
  f.switchAccount()
  finish()

  expect(await work).toBe('unavailable')
  expect(f.request).toHaveBeenLastCalledWith('cancel', 'en')
})

it('server tombstones remain authoritative after restart', async () => {
  const f = fixture()
  f.request.mockResolvedValue({ state: 'cancelled' })

  expect(await f.value.claim(f.input)).toBe('done')
  const restarted = new MatrixFirstRunGoogleValue({ log: vi.fn() })
  expect(await restarted.claim(f.input)).toBe('done')
})

it('refuses stale or incomplete local authority without touching the platform', async () => {
  const f = fixture()
  expect(await f.value.claim({ ...f.input, eligible: () => false })).toBe('unavailable')
  expect(await f.value.claim({ ...f.input, authority: () => undefined })).toBe('unavailable')
  expect(f.request).not.toHaveBeenCalled()
})
