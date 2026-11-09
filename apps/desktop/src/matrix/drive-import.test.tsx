import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { Locale } from '@/i18n'

import type { MatrixDriveBridge, MatrixDriveImportPlan, MatrixDriveImportResult } from '../../shared/matrix-drive'

import { formatDriveSize, MatrixDrive } from './drive'
import { MatrixDriveImportSheet } from './drive-import'
import { matrixDriveImportCopy } from './drive-import-copy'

const id = '00000000-0000-4000-8000-11e594f48195'

const summary = (
  state: 'ready' | 'warning' | 'blocked' = 'ready'
): Exclude<MatrixDriveImportPlan, { state: 'cancelled' | 'refused' }> => ({
  state,
  planId: id,
  expiresAt: Date.now() + 600_000,
  files: 3,
  folders: 1,
  bytes: 2_483_712,
  skipped: { private: 2, code: 1, excluded: 0, shortcuts: 1, special: 0, unreadable: 0 },
  space: {
    total: 100_000_000,
    used: 90_000_000,
    remainingAfter: state === 'blocked' ? -1_000 : 7_516_288,
    estimated: true
  }
})

afterEach(cleanup)

function fixture(plan: Exclude<MatrixDriveImportPlan, { state: 'cancelled' }> = summary(), locale: Locale = 'en') {
  const importRun = vi.fn(async (): Promise<MatrixDriveImportResult> => ({ state: 'completed', added: 1 }))
  const importCancel = vi.fn(async (): Promise<MatrixDriveImportResult> => ({ state: 'cancelled', added: 0 }))
  const bridge = { importRun, importCancel } as unknown as MatrixDriveBridge
  const onClose = vi.fn()
  const onChanged = vi.fn()

  const element = (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixDriveImportSheet
        bridge={bridge}
        formatSize={bytes => formatDriveSize(bytes, locale)}
        locale={locale}
        onChanged={onChanged}
        onClose={onClose}
        plan={plan}
      />
    </I18nProvider>
  )

  return { bridge, importRun, importCancel, onClose, onChanged, element }
}

it.each(['ready', 'warning', 'blocked'] as const)(
  'the real %s sheet shows counts, reasons and honest space, and blocks copies when full',
  async state => {
    const f = fixture(summary(state))
    render(f.element)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Your originals stay where they are. Drive receives finished copies.')).toBeTruthy()
    expect(screen.getByText('Not added: 4 items')).toBeTruthy()
    expect(screen.getByText('Passwords, keys and databases · 2')).toBeTruthy()
    expect(screen.getByText('2.5 MB')).toBeTruthy()
    expect(screen.getByText(state === 'blocked' ? 'About 0 byte' : 'About 7.5 MB')).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Add copies' }) as HTMLButtonElement
    expect(add.disabled).toBe(state === 'blocked')

    if (state === 'warning') {
      expect(screen.getByText(matrixDriveImportCopy.en.warning)).toBeTruthy()
    }

    if (state === 'blocked') {
      expect(screen.getByText('Needs 2.5 MB, 10 MB left.')).toBeTruthy()
    }

    fireEvent.click(add)

    if (state === 'blocked') {
      expect(f.importRun).not.toHaveBeenCalled()
    } else {
      await screen.findByText('Items added: 1.')
      expect(f.importRun).toHaveBeenCalledExactlyOnceWith(id)
      expect(f.onChanged).toHaveBeenCalledOnce()
    }
  }
)

it.each(['vi', 'en', 'ja', 'zh', 'zh-hant'] as const)(
  'all %s import copy is local and a refused choice cannot start copying',
  locale => {
    const f = fixture({ state: 'refused', reason: 'home' }, locale)
    render(f.element)
    const copy = matrixDriveImportCopy[locale]
    expect(screen.getByText(copy.title)).toBeTruthy()
    expect(screen.getByText(copy.refused.home)).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.add })).toBeNull()
    expect(f.importRun).not.toHaveBeenCalled()
    expect(Object.values(copy.refused).every(text => text.length > 0)).toBe(true)
    expect(Object.values(copy.skipped).every(text => text.length > 0)).toBe(true)
  }
)

it('cancel waits for the owned run to stop and never repeats its opaque intent', async () => {
  const f = fixture()
  let finish!: (result: MatrixDriveImportResult) => void
  f.importRun.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  f.importCancel.mockImplementation(async () => {
    const result: MatrixDriveImportResult = { state: 'cancelled', added: 0 }
    finish(result)

    return result
  })
  render(f.element)
  fireEvent.click(screen.getByRole('button', { name: 'Add copies' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce())
  expect(f.importRun).toHaveBeenCalledExactlyOnceWith(id)
  expect(f.importCancel).toHaveBeenCalledExactlyOnceWith(id)
})

it('StrictMode keeps a live intent, while actual departure cancels it', async () => {
  const f = fixture()
  const mounted = render(<StrictMode>{f.element}</StrictMode>)
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
  expect(f.importCancel).not.toHaveBeenCalled()
  mounted.unmount()
  await waitFor(() => expect(f.importCancel).toHaveBeenCalledWith(id))
})

it('the actual Drive header exposes main picking, then only the opaque plan goes to Run', async () => {
  const view = { state: 'ready', revision: 2, rows: [], canGoBack: false, truncated: false }
  const f = fixture()
  const importPlan = vi.fn(async () => summary())
  const read = vi.fn(async () => view)
  const bridge = { ...f.bridge, read, importPlan, subscribe: () => () => {} } as unknown as MatrixDriveBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )
  await screen.findByText('Up to date')
  fireEvent.keyDown(screen.getByRole('button', { name: 'More Drive actions' }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add to Drive' }))
  await screen.findByRole('dialog')
  expect(importPlan).toHaveBeenCalledExactlyOnceWith()
  expect(f.importRun).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Add copies' }))
  await screen.findByText('Items added: 1.')
  expect(f.importRun).toHaveBeenCalledExactlyOnceWith(id)
  expect(JSON.stringify(f.importRun.mock.calls)).not.toContain('/')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.keyDown(screen.getByRole('button', { name: 'More Drive actions' }), { key: 'Enter' })
  expect(screen.getByRole('menuitem', { name: 'Add to Drive' })).toBeTruthy()
})
