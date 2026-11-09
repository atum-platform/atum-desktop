import { act, render, screen } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeAppLaunchResult } from '../../../shared/skills-launcher'

vi.mock('@/store/document-context', async () => ({ $documentContext: (await import('nanostores')).atom(null) }))
vi.mock('@/store/native-apps', async () => {
  const { atom } = await import('nanostores')

  return { $nativeApps: atom({ apps: [], error: null, loading: false, result: null as NativeAppLaunchResult | null, scopeKey: '' }), endNativeApp: vi.fn() }
})
vi.mock('@/store/workbench-tabs', async () => {
  const { atom } = await import('nanostores')

  return { $workbenchScope: atom('scope-a'), resolveCaptureScope: (scope: string) => scope }
})

import { I18nProvider } from '@/i18n'
import { documentIdentity } from '@/lib/document-path'
import { $documentContext, type DocumentContextItem } from '@/store/document-context'
import { $nativeApps } from '@/store/native-apps'
import { $workbenchScope } from '@/store/workbench-tabs'

import { NativeAppBar } from './native-app-bar'

const app = { bundleId: 'com.apple.Preview', id: 'preview', name: 'Preview' }

function renderBar() {
  return render(<I18nProvider configClient={null} initialLocale="en"><NativeAppBar /></I18nProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  $workbenchScope.set('scope-a')
  $nativeApps.set({ apps: [], error: null, loading: false, result: null, scopeKey: 'scope-a' })
  ;($documentContext as WritableAtom<DocumentContextItem | null>).set(null)
})

describe('NativeAppBar', () => {
  it('only represents a real beside-chat companion', () => {
    $nativeApps.set({ apps: [], error: null, loading: false, result: { app, id: 'open', status: 'opened' }, scopeKey: 'scope-a' })
    const view = renderBar()

    expect(screen.queryByRole('status')).toBeNull()

    act(() => $nativeApps.set({ apps: [], error: null, loading: false, result: { app, id: 'beside', status: 'beside' }, scopeKey: 'scope-a' }))
    expect(screen.getByRole('status').textContent).toContain('Preview')

    view.unmount()
  })
})


it('stops claiming the saved file is shared after its context chip is removed', () => {
  const context = $documentContext as WritableAtom<DocumentContextItem | null>
  $nativeApps.set({ apps: [], error: null, loading: false, scopeKey: 'scope-a', documentPath: '/work/Slides.pptx', result: { app, id: 'beside', status: 'beside' } })
  context.set({ identity: documentIdentity('/work/Slides.pptx', null), scopeKey: 'scope-a', selection: null, state: 'ready', workspaceDocument: false })
  const view = renderBar()
  expect(screen.getByRole('status').textContent).toContain('Saved file shared with chat')
  act(() => context.set(null))
  expect(screen.getByRole('status').textContent).toContain('Atum can’t read this app’s content yet.')
  view.unmount()
})

it('does not claim a different linked file is the displayed app document', () => {
  const context = $documentContext as WritableAtom<DocumentContextItem | null>
  $nativeApps.set({ apps: [], error: null, loading: false, scopeKey: 'scope-a', documentPath: '/work/Slides.pptx', result: { app, id: 'beside', status: 'beside' } })
  context.set({ identity: documentIdentity('/other/Slides.pptx', null), scopeKey: 'scope-a', selection: null, state: 'ready', workspaceDocument: false })
  const view = renderBar()
  expect(screen.getByRole('status').textContent).toContain('Atum can’t read this app’s content yet.')
  expect(screen.getByRole('status').textContent).not.toContain('Saved file shared with chat')
  view.unmount()
})
