import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner } from '@/store/action-panel-owner'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $connection } from '@/store/session'
import { assistantChatWorkbenchScopeKey, setWorkbenchScope } from '@/store/workbench-tabs'

import { nativeOfficeBundleForPath, routesToNativeOffice, tryOpenNativeOfficeDocument } from './native-office-routing'

const mocks = vi.hoisted(() => ({ openNativeAppDocument: vi.fn() }))

vi.mock('@/store/native-apps', () => ({ openNativeAppDocument: mocks.openNativeAppDocument }))

const excel = { id: 'native-app:excel', name: 'Excel', bundleId: 'com.microsoft.Excel' }
const powerpoint = { id: 'native-app:powerpoint', name: 'PowerPoint', bundleId: 'com.microsoft.Powerpoint' }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {resolve = resolvePromise})

  return { promise, resolve }
}

beforeEach(() => {
  mocks.openNativeAppDocument.mockReset()
  mocks.openNativeAppDocument.mockResolvedValue({ id: 'request', app: excel, status: 'opened' })
  $atumShellEnabled.set(true)
  $connection.set(null)
  $actionPanelEpoch.set(1)
  $actionPanelOwner.set({ accountId: 'account', connectionId: 'connection', backend_id: 'backend', agent_id: 'agent', profile: 'default', version: 1, submission_dedup: true })
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
  vi.stubGlobal('hermesDesktop', { nativeApps: { list: vi.fn(async () => [excel, powerpoint]) } })
})

afterEach(() => vi.unstubAllGlobals())

it('maps only Excel and PowerPoint extensions to their literal installed bundle identities', () => {
  expect(nativeOfficeBundleForPath('/Documents/Budget.XLSM')).toBe('com.microsoft.Excel')
  expect(nativeOfficeBundleForPath('/Documents/Deck.pptx')).toBe('com.microsoft.Powerpoint')
  expect(nativeOfficeBundleForPath('/Documents/Report.docx')).toBeNull()
})

it('launches a matching installed local app only from the current assistant scope', async () => {
  await expect(tryOpenNativeOfficeDocument('/Documents/Budget.xlsx', true)).resolves.toBe('opened')
  expect(mocks.openNativeAppDocument).toHaveBeenCalledWith(excel, '/Documents/Budget.xlsx', assistantChatWorkbenchScopeKey('chat-a'))

  await expect(tryOpenNativeOfficeDocument('/Documents/Deck.pptx', true)).resolves.toBe('opened')
  expect(mocks.openNativeAppDocument).toHaveBeenCalledWith(powerpoint, '/Documents/Deck.pptx', assistantChatWorkbenchScopeKey('chat-a'))
})

it('keeps the existing open path available when the matching app is missing', async () => {
  window.hermesDesktop!.nativeApps!.list = vi.fn(async () => [powerpoint])

  await expect(tryOpenNativeOfficeDocument('/Documents/Budget.xlsx', true)).resolves.toBe('unavailable')
  expect(mocks.openNativeAppDocument).not.toHaveBeenCalled()
})

it('reports a failed explicit native route without trying another native launch', async () => {
  mocks.openNativeAppDocument.mockRejectedValueOnce(new Error('NATIVE_APP_LAUNCH_FAILED'))

  await expect(tryOpenNativeOfficeDocument('/Documents/Budget.xlsx', true)).resolves.toBe('failed')
  expect(mocks.openNativeAppDocument).toHaveBeenCalledOnce()
})

it('does not launch after the scope epoch changes during inventory lookup', async () => {
  const listing = deferred<Array<typeof excel>>()
  window.hermesDesktop!.nativeApps!.list = vi.fn(() => listing.promise)
  const opening = tryOpenNativeOfficeDocument('/Documents/Budget.xlsx', true)
  $actionPanelEpoch.set(2)
  listing.resolve([excel])

  await expect(opening).resolves.toBe('stale')
  expect(mocks.openNativeAppDocument).not.toHaveBeenCalled()
})

it('does not report a native launch as current after the scope changes during launch', async () => {
  const launching = deferred<{ app: typeof excel; id: string; status: string }>()
  mocks.openNativeAppDocument.mockReturnValueOnce(launching.promise)
  const opening = tryOpenNativeOfficeDocument('/Documents/Budget.xlsx', true)
  await vi.waitFor(() => expect(mocks.openNativeAppDocument).toHaveBeenCalledOnce())
  $actionPanelEpoch.set(2)
  launching.resolve({ id: 'request', app: excel, status: 'opened' })

  await expect(opening).resolves.toBe('stale')
})

it('requires a known-local source in remote mode and a foreground assistant target', () => {
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  expect(routesToNativeOffice('/Documents/Budget.xlsx')).toBe(false)
  expect(routesToNativeOffice('/Documents/Budget.xlsx', true)).toBe(true)
  setWorkbenchScope('session')
  expect(routesToNativeOffice('/Documents/Budget.xlsx', true)).toBe(false)
})
