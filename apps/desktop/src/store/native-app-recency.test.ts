import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

it('retains launch order across reloads, independently for each account', async () => {
  const first = await import('./native-app-recency')
  first.recordNativeAppUse('word', 'account-a')
  first.recordNativeAppUse('powerpoint', 'account-a')
  first.recordNativeAppUse('word', 'account-b')
  first.recordNativeAppUse('ignored', undefined)
  const history = first.$nativeAppRecency.get()
  expect(history['account-a']!.powerpoint).toBeGreaterThan(history['account-a']!.word!)
  expect(Object.keys(history['account-b']!)).toEqual(['word'])

  vi.resetModules()
  const reloaded = await import('./native-app-recency')
  expect(reloaded.$nativeAppRecency.get()).toEqual(history)
})

it('discards invalid persisted timestamps without discarding valid account history', async () => {
  localStorage.setItem('hermes.desktop.atum.nativeApps.lastUsedByAccount.v1', JSON.stringify({
    a: { word: 42, bad: 'yesterday', negative: -1, empty: null }, b: [], c: false
  }))
  const { $nativeAppRecency } = await import('./native-app-recency')
  expect($nativeAppRecency.get()).toEqual({ a: { word: 42 } })
})
