import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AtumConsumerFileOpenResult } from '@/global'

import { $actionPanelEpoch, $actionPanelOwner } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import {
  $nativeDocument,
  associateNativeDocument,
  captureNativeDocument,
  clearNativeDocument,
  currentNativeDocument,
  resetNativeDocumentForTests,
  startNativeDocumentLifecycle
} from './native-document'
import {
  $workbenchScope,
  adoptDraftWorkbenchScope,
  assistantChatWorkbenchScopeKey,
  markDraftWorkbenchBaseline,
  resetWorkbenchTabs,
  setWorkbenchScope
} from './workbench-tabs'

const owner = {
  version: 1 as const,
  backend_id: '00000000-0000-4000-8000-bd7662a5eeb4',
  agent_id: '22222222-2222-4222-822222222222',
  accountId: 'account-a',
  connectionId: 'connection-a',
  profile: 'default',
  submission_dedup: true
}

const cleanup: Array<() => void> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, reject, resolve }
}

function bridge(
  overrides: Partial<{
    capture: (token: string) => Promise<{ dataUrl: string; revision: string }>
    open: (path: string) => Promise<AtumConsumerFileOpenResult>
    releaseView: (token: string) => Promise<boolean>
  }> = {}
) {
  return {
    capture: vi.fn(async () => ({ dataUrl: 'data:application/octet-stream;base64,AAAA', revision: 'r1' })),
    open: vi.fn(async () => ({ kind: 'card' as const, size: 8, token: 'grant-a' })),
    releaseView: vi.fn(async () => true),
    ...overrides
  }
}

beforeEach(() => {
  resetNativeDocumentForTests()
  resetWorkbenchTabs()
  $atumShellEnabled.set(true)
  $actionPanelEpoch.set(0)
  $actionPanelOwner.set(owner)
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
})

afterEach(() => {
  cleanup.splice(0).forEach(stop => stop())
  vi.unstubAllGlobals()
  resetNativeDocumentForTests()
})

it('keeps only the latest of two competing file selections and releases the late grant', async () => {
  const first = deferred<AtumConsumerFileOpenResult>()

  const files = bridge({
    open: vi.fn(
      (path: string): Promise<AtumConsumerFileOpenResult> =>
        path.endsWith('a.xlsx') ? first.promise : Promise.resolve({ kind: 'card', size: 12, token: 'grant-b' })
    )
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })

  const selectingA = associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')
  await associateNativeDocument('pair-b', '/home/example/Documents/b.xlsx')
  first.resolve({ kind: 'card', size: 11, token: 'grant-a' })
  await selectingA

  expect($nativeDocument.get()).toMatchObject({
    pairingId: 'pair-b',
    canonicalPath: '/home/example/Documents/b.xlsx',
    displayName: 'b.xlsx',
    token: 'grant-b'
  })
  expect(files.releaseView).toHaveBeenCalledTimes(1)
  expect(files.releaseView).toHaveBeenCalledWith('grant-a')
})

it('revokes a late grant when its owner changes while authorization is in flight', async () => {
  const opening = deferred<AtumConsumerFileOpenResult>()
  const files = bridge({ open: vi.fn(() => opening.promise) })
  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  cleanup.push(startNativeDocumentLifecycle())

  const pending = associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')
  $actionPanelOwner.set({ ...owner, accountId: 'account-b' })
  opening.resolve({ kind: 'card', size: 12, token: 'late-grant' })
  await pending

  expect($nativeDocument.get()).toBeNull()
  expect(files.releaseView).toHaveBeenCalledWith('late-grant')
})

it('does not return captured bytes after the owner changes during capture', async () => {
  const captured = deferred<{ dataUrl: string; revision: string }>()
  const files = bridge({ capture: vi.fn(() => captured.promise) })
  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  cleanup.push(startNativeDocumentLifecycle())
  await associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')

  const pending = captureNativeDocument()
  $actionPanelOwner.set({ ...owner, profile: 'other' })
  captured.resolve({ dataUrl: 'data:application/octet-stream;base64,PRIVATE', revision: 'late' })

  await expect(pending).resolves.toBeNull()
  expect($nativeDocument.get()).toBeNull()
  expect(files.releaseView).toHaveBeenCalledTimes(1)
  expect(files.releaseView).toHaveBeenCalledWith('grant-a')
})

it('refreshes a replaced inode once through a new main-authorized card grant', async () => {
  const files = bridge({
    capture: vi
      .fn()
      .mockRejectedValueOnce(new Error('CONSUMER_FILES_MISSING'))
      .mockResolvedValueOnce({ dataUrl: 'data:application/octet-stream;base64,NEW', revision: 'new-inode' }),
    open: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'old-grant' })
      .mockResolvedValueOnce({ kind: 'card', size: 13, token: 'new-grant' })
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  await associateNativeDocument('pair-a', '/home/example/Documents/budget.xlsx')

  await expect(captureNativeDocument()).resolves.toEqual({
    dataUrl: 'data:application/octet-stream;base64,NEW',
    revision: 'new-inode'
  })
  expect(files.open).toHaveBeenLastCalledWith('/home/example/Documents/budget.xlsx')
  expect(files.capture).toHaveBeenCalledTimes(2)
  expect(files.releaseView).toHaveBeenCalledWith('old-grant')
  expect($nativeDocument.get()).toMatchObject({ token: 'new-grant', captureError: undefined })
})

it('does not retry an unstable document beyond one refreshed grant', async () => {
  const files = bridge({
    capture: vi
      .fn()
      .mockRejectedValueOnce(new Error('CONSUMER_FILES_CAPTURE_CHANGED'))
      .mockRejectedValueOnce(new Error('CONSUMER_FILES_CAPTURE_CHANGED')),
    open: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'old-grant' })
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'refresh-grant' })
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  await associateNativeDocument('pair-a', '/home/example/Documents/unstable.xlsx')

  await expect(captureNativeDocument()).rejects.toThrow('CONSUMER_FILES_CAPTURE_CHANGED')
  expect(files.open).toHaveBeenCalledTimes(2)
  expect(files.capture).toHaveBeenCalledTimes(2)
  expect($nativeDocument.get()).toMatchObject({
    token: 'refresh-grant',
    captureError: 'CONSUMER_FILES_CAPTURE_CHANGED'
  })
})

it('explicit clear releases its matching grant once and leaves another pairing alone', async () => {
  const files = bridge({
    open: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'grant-a' })
      .mockResolvedValueOnce({ kind: 'card', size: 13, token: 'grant-b' })
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  await associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')

  clearNativeDocument('other-pair')
  expect($nativeDocument.get()?.pairingId).toBe('pair-a')
  clearNativeDocument('pair-a')
  clearNativeDocument('pair-a')
  expect($nativeDocument.get()).toBeNull()
  expect(files.releaseView).toHaveBeenCalledTimes(1)
  expect(files.releaseView).toHaveBeenCalledWith('grant-a')

  await associateNativeDocument('pair-b', '/home/example/Documents/b.xlsx')
  expect($nativeDocument.get()?.pairingId).toBe('pair-b')
})

it('releases a completed refresh grant that became stale before it could replace the association', async () => {
  const refreshed = deferred<AtumConsumerFileOpenResult>()

  const files = bridge({
    capture: vi.fn().mockRejectedValueOnce(new Error('CONSUMER_FILES_MISSING')),
    open: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'grant-a' })
      .mockImplementationOnce(() => refreshed.promise)
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  await associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')

  const pending = captureNativeDocument()
  await Promise.resolve()
  clearNativeDocument('pair-a')
  refreshed.resolve({ kind: 'card', size: 13, token: 'late-refresh' })

  await expect(pending).resolves.toBeNull()
  expect(files.releaseView).toHaveBeenCalledTimes(2)
  expect(files.releaseView).toHaveBeenCalledWith('grant-a')
  expect(files.releaseView).toHaveBeenCalledWith('late-refresh')
})

it('carries an association only from a draft into the chat that adopted it', async () => {
  const files = bridge()
  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  cleanup.push(startNativeDocumentLifecycle())
  markDraftWorkbenchBaseline()
  const draftScope = $workbenchScope.get()
  await associateNativeDocument('pair-a', '/home/example/Documents/draft.xlsx', draftScope)

  adoptDraftWorkbenchScope('created-chat')
  const createdScope = assistantChatWorkbenchScopeKey('created-chat')
  setWorkbenchScope(createdScope)

  expect(currentNativeDocument(createdScope)).toMatchObject({ scopeKey: createdScope, pairingId: 'pair-a' })
  setWorkbenchScope(assistantChatWorkbenchScopeKey('other-chat'))
  expect(currentNativeDocument()).toBeNull()
  expect(files.releaseView).toHaveBeenCalledWith('grant-a')
})

it('rejects a non-card refresh result instead of treating metadata as file context', async () => {
  const files = bridge({
    capture: vi.fn().mockRejectedValueOnce(new Error('CONSUMER_FILES_MISSING')),
    open: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'card', size: 12, token: 'grant-a' })
      .mockResolvedValueOnce({ kind: 'error', code: 'CONSUMER_FILES_OUTSIDE_HOME' })
  })

  vi.stubGlobal('hermesDesktop', { consumerFiles: files })
  await associateNativeDocument('pair-a', '/home/example/Documents/a.xlsx')

  await expect(captureNativeDocument()).rejects.toThrow('CONSUMER_FILES_OUTSIDE_HOME')
  expect($nativeDocument.get()?.captureError).toBe('CONSUMER_FILES_OUTSIDE_HOME')
})

it('keeps an explicit unavailable association when Electron refuses the initial card grant', async () => {
  const files = bridge({ open: vi.fn(async () => ({ kind: 'error' as const, code: 'CONSUMER_FILES_OUTSIDE_HOME' })) })
  vi.stubGlobal('hermesDesktop', { consumerFiles: files })

  await expect(associateNativeDocument('pair-a', '/home/example/Documents/blocked.xlsx')).rejects.toThrow(
    'CONSUMER_FILES_OUTSIDE_HOME'
  )
  expect(currentNativeDocument()).toMatchObject({
    pairingId: 'pair-a',
    canonicalPath: '/home/example/Documents/blocked.xlsx',
    displayName: 'blocked.xlsx',
    captureError: 'CONSUMER_FILES_OUTSIDE_HOME',
    token: null
  })
})
