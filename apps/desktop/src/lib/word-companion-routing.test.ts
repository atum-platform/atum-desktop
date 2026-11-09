import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $connection } from '@/store/session'
import { resetWordCompanionForTests } from '@/store/word-companion'
import { assistantChatWorkbenchScopeKey, setWorkbenchScope } from '@/store/workbench-tabs'

import { routesToWordCompanion, tryOpenWordCompanion } from './word-companion-routing'

const open = vi.fn(async (path: string, id: string) => ({ id, path, name: 'report.docx' }))

beforeEach(() => {
  resetWordCompanionForTests()
  open.mockClear()
  $atumShellEnabled.set(true)
  $connection.set(null)
  $actionPanelOwner.set({ accountId: 'a', connectionId: 'c', backend_id: 'b', agent_id: 'a', profile: 'default', version: 1, submission_dedup: true })
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
  vi.stubGlobal('hermesDesktop', { wordCompanion: { open, end: vi.fn(async () => undefined), onEnded: vi.fn(), capture: vi.fn() } })
})

afterEach(() => {resetWordCompanionForTests(); vi.unstubAllGlobals()})

it('routes an explicitly opened local Word file through the companion bridge', async () => {
  expect(tryOpenWordCompanion({ kind: 'file', path: '/home/report.docx', source: '/home/report.docx', url: 'file:///home/report.docx', label: 'report.docx' })).toBe(true)
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith('/home/report.docx', expect.any(String)))
})

it('distinguishes a proven local file-browser path from an ambiguous remote agent path', () => {
  $connection.set({ mode: 'remote' } as NonNullable<ReturnType<typeof $connection.get>>)
  expect(routesToWordCompanion('/home/report.docx')).toBe(false)
  expect(routesToWordCompanion('/home/report.docx', true)).toBe(true)
  expect(routesToWordCompanion('/home/report.doc', true)).toBe(true)
})

it('leaves normal preview routing intact without a foreground assistant owner', () => {
  setWorkbenchScope('session')
  expect(routesToWordCompanion('/home/report.docx', true)).toBe(false)
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
  expect(routesToWordCompanion('/home/report.docx', true, assistantChatWorkbenchScopeKey('chat-b'))).toBe(false)
  window.hermesDesktop!.actionPanelOwner = false
  expect(routesToWordCompanion('/home/report.docx', true)).toBe(false)
  window.hermesDesktop!.actionPanelOwner = true
  $actionPanelOwner.set(null)
  expect(routesToWordCompanion('/home/report.docx', true)).toBe(false)
  expect(open).not.toHaveBeenCalled()
})

it('keeps URLs, other file types, DM scopes and unavailable bridges out of native Word', () => {
  expect(routesToWordCompanion('https://example.com/report.docx')).toBe(false)
  expect(routesToWordCompanion('/home/report.pdf')).toBe(false)
  setWorkbenchScope('atum-dm:account:conversation')
  expect(routesToWordCompanion('/home/report.docx', true)).toBe(false)
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
  vi.stubGlobal('hermesDesktop', {})
  expect(routesToWordCompanion('/home/report.docx')).toBe(false)
  expect(open).not.toHaveBeenCalled()
})
