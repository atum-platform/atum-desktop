import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { $atumAgentSync } from './agent-sync'
import { AtumAgentSyncDialog } from './agent-sync-dialog'

vi.mock('./agent-sync', async () => {
  const { atom } = await import('nanostores')

  return { $atumAgentSync: atom([]), refreshAgentSync: vi.fn(async () => {}) }
})
afterEach(cleanup)

const agent = { id: 'writer', hostedId: 'hosted-writer', identityId: 'identity', title: 'Writer', avatar: '',
  description: '', isDefault: false, isManaged: true, pinned: false, lifecycleRevision: 1 }

test('Google protection explains local-only content without claiming the account setting is off', () => {
  const bridge = { setMemoryEnabled: vi.fn(), resolve: vi.fn() }
  window.hermesDesktop = { agentSync: bridge } as unknown as typeof window.hermesDesktop
  $atumAgentSync.set([{ assistantId: agent.hostedId, skills: 'local_only', memory: 'local_only', memoryEnabled: true, workspaceProtected: true, lastSyncedAt: null }])
  render(<I18nProvider configClient={null} initialLocale="en"><AtumAgentSyncDialog agent={agent} onClose={() => {}} /></I18nProvider>)
  expect(screen.getByText(/automatic sync and restore of memory/)).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(bridge.setMemoryEnabled).not.toHaveBeenCalled()
  expect(screen.queryByText(/Memory syncs automatically/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Use this computer' })).toBeNull()
})

test('memory can be paused and conflict controls send only agent id and selected side', async () => {
  const bridge = { setMemoryEnabled: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
  window.hermesDesktop = { agentSync: bridge } as unknown as typeof window.hermesDesktop
  $atumAgentSync.set([{ assistantId: agent.hostedId, skills: 'conflict', memory: 'synced', memoryEnabled: true, lastSyncedAt: null }])
  render(<I18nProvider configClient={null} initialLocale="en"><AtumAgentSyncDialog agent={agent} onClose={() => {}} /></I18nProvider>)
  const toggle = screen.getByRole('switch')
  expect(toggle.getAttribute('aria-label')).toBe('Sync desktop memory between Macs')
  expect(screen.getByText(/cloud agent keeps a separate private home and session history/i)).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(bridge.setMemoryEnabled).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  await waitFor(() => expect(bridge.setMemoryEnabled).toHaveBeenCalledWith(agent.hostedId, false))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Use account copy' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Use account copy' }))
  await waitFor(() => expect(bridge.resolve).toHaveBeenCalledWith(agent.hostedId, 'skills', 'cloud'))
})

test('Vietnamese copy also bounds desktop memory separately from the cloud home', () => {
  window.hermesDesktop = { agentSync: { setMemoryEnabled: vi.fn(), resolve: vi.fn() } } as unknown as typeof window.hermesDesktop
  $atumAgentSync.set([{ assistantId: agent.hostedId, skills: 'synced', memory: 'synced', memoryEnabled: true, lastSyncedAt: null }])
  render(<I18nProvider configClient={null} initialLocale="vi"><AtumAgentSyncDialog agent={agent} onClose={() => {}} /></I18nProvider>)
  expect(screen.getByRole('switch', { name: 'Đồng bộ trí nhớ trên các máy Mac' })).toBeTruthy()
  expect(screen.getByText(/Nhà riêng và lịch sử phiên của trợ lý chạy trên cloud được giữ riêng/)).toBeTruthy()
})
