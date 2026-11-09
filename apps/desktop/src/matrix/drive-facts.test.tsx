import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixDriveBridge, MatrixDriveIssue, MatrixDriveView } from '../../shared/matrix-drive'

import { formatDriveSize, MatrixDrive } from './drive'
import { matrixDriveCopy } from './drive-copy'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function driveRoot() {
  return window.document.querySelector<HTMLElement>('[data-matrix-drive]')!
}

function ready(overrides: Partial<MatrixDriveView> = {}): MatrixDriveView {
  return {
    state: 'ready',
    revision: 1,
    canGoBack: false,
    rows: [],
    truncated: false,
    ...overrides
  }
}

function driveBridge(initial: MatrixDriveView) {
  let receive: ((view: MatrixDriveView) => void) | undefined
  let current = initial
  const read = vi.fn(async () => current)
  const connect = vi.fn(async () => current)
  const reveal = vi.fn(async () => {})

  return {
    bridge: {
      read,
      connect,
      chooseFolder: async () => ({ cancelled: true as const }),
      cancelSignIn: async () => current,
      disconnect: async () => current,
      enter: async () => current,
      back: async () => current,
      open: async () => {},
      reveal,
      taskStatus: async () => ({ state: 'ready' as const }),
      sendTask: async () => ({ state: 'not_sent' as const }),
      subscribe(listener) {
        receive = listener

        return () => {
          receive = undefined
        }
      }
    } as MatrixDriveBridge,
    connect,
    read,
    reveal,
    publish(view: MatrixDriveView) {
      current = view
      receive?.(view)
    }
  }
}

function show(bridge: MatrixDriveBridge, locale: Locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )
}

it('leaves a 1.0 view alone when native facts are absent', async () => {
  const drive = driveBridge(ready({ lastSyncAt: Date.now() }))
  show(drive.bridge)

  await screen.findByText(/Up to date/)
  expect(driveRoot().querySelector('[data-matrix-drive-facts]')).toBeNull()
  expect(driveRoot().querySelector('[data-matrix-drive-quota]')).toBeNull()
  expect(driveRoot().querySelector('[data-matrix-drive-progress]')).toBeNull()
  expect(driveRoot().querySelector('[data-matrix-drive-issue]')).toBeNull()
})

it.each([
  ['normal', 990, 'normal'],
  ['nearing', 700, 'nearing'],
  ['critical', 850, 'critical'],
  ['exceeded', 1_000, 'exceeded']
] as const)(
  'uses the engine quota state (%s), rather than inferring it from percent',
  async (state, used, expected) => {
    const drive = driveBridge(ready({ quota: { total: 1_000, used, remaining: 1_000 - used, state } }))
    show(drive.bridge)

    const meter = await screen.findByRole('meter', { name: 'Drive storage' })
    expect(meter.closest('[data-matrix-drive-quota]')?.getAttribute('data-matrix-drive-quota')).toBe(expected)
    expect(meter.getAttribute('aria-valuemax')).toBe('1000')
    expect(meter.getAttribute('aria-valuenow')).toBe(String(Math.min(used, 1_000)))
    expect(meter.getAttribute('aria-valuetext')).toBe(
      `${formatDriveSize(used, 'en', 1_000)} of ${formatDriveSize(1_000, 'en', 1_000)}`
    )
    const fill = meter.firstElementChild as HTMLElement
    expect(fill.className).toContain(
      state === 'normal' ? 'bg-primary' : state === 'nearing' ? 'bg-(--atum-warn)' : 'bg-(--atum-danger)'
    )

    if (state === 'normal') {
      expect(fill.className).not.toContain('bg-(--atum-warn)')
      expect(fill.className).not.toContain('bg-(--atum-danger)')
    }
  }
)

it('makes the compact low-space warning from remaining bytes without upgrading quota authority', async () => {
  const drive = driveBridge(
    ready({ quota: { total: 1_000_000_000, used: 999_999_999, remaining: 1, state: 'normal' } })
  )

  show(drive.bridge)

  const meter = await screen.findByRole('meter', { name: 'Drive storage' })
  expect(meter.closest('[data-matrix-drive-quota]')?.getAttribute('data-matrix-drive-quota')).toBe('normal')
  expect(screen.getByText(matrixDriveCopy.en.facts.lowSpace)).toBeTruthy()
  expect(screen.queryByText('Drive is full')).toBeNull()
})

it.each([64 * 1024 * 1024 - 1, 64 * 1024 * 1024])(
  'warns only below the task-space reserve (%s bytes)',
  async remaining => {
    const total = 1_000_000_000
    show(driveBridge(ready({ quota: { total, used: total - remaining, remaining, state: 'normal' } })).bridge)
    await screen.findByRole('meter', { name: 'Drive storage' })
    expect(Boolean(screen.queryByText(matrixDriveCopy.en.facts.lowSpace))).toBe(remaining < 64 * 1024 * 1024)
  }
)

it('offers a full-storage action from an exceeded quota even without an aggregate issue', async () => {
  show(
    driveBridge(ready({ quota: { total: 1_000_000_000, used: 1_100_000_000, remaining: 0, state: 'exceeded' } })).bridge
  )
  await screen.findByText('Drive is full')
  const meter = screen.getByRole('meter', { name: 'Drive storage' })
  expect(meter.getAttribute('aria-valuenow')).toBe('1000000000')
  expect(meter.getAttribute('aria-valuetext')).toBe('1.1 GB of 1 GB')
  expect((meter.firstElementChild as HTMLElement).style.width).toBe('100%')
})

it('uses a common capacity unit while keeping Finder file-size defaults', () => {
  expect(formatDriveSize(300_000_000, 'en', 1_000_000_000)).toBe('0.3 GB')
  expect(formatDriveSize(300_000_000, 'en')).toBe('300 MB')
  expect(formatDriveSize(900, 'en', 1_000)).toBe('0.9 kB')
})

it('uses singular file copy for a one-file transfer and issue', async () => {
  show(
    driveBridge(
      ready({
        state: 'syncing',
        issues: [{ id: 'issue', code: 'errors', count: 1 }],
        progress: {
          active: true,
          files: { done: 0, total: 1 },
          bytes: { done: 0, total: 2 },
          etaSeconds: null,
          direction: 'up'
        }
      })
    ).bridge
  )
  await screen.findByText('0 of 1 file')
  expect(screen.getByText('1 file')).toBeTruthy()
})

it.each(['offline', 'paused'] as const)('preserves native %s status even with last-known facts', async state => {
  show(driveBridge(ready({ state, factsStale: true })).bridge)
  await screen.findByText(matrixDriveCopy.en.status[state])
  expect(screen.getByText(matrixDriveCopy.en.facts.stale)).toBeTruthy()
  expect(screen.queryByText(matrixDriveCopy.en.facts.staleStatus)).toBeNull()
})

it.each([null, 0, 30, 60, 120, 3600, 7200])('uses only a reported ETA (%s seconds)', async etaSeconds => {
  show(
    driveBridge(
      ready({
        state: 'syncing',
        progress: {
          active: true,
          files: { done: 12, total: 40 },
          bytes: { done: 1, total: 2 },
          etaSeconds,
          direction: 'up'
        }
      })
    ).bridge
  )
  const line = await screen.findByText(/^12 of 40 files/)

  if (etaSeconds === null || etaSeconds === 0) {
    expect(line.textContent).toBe('12 of 40 files')
  } else {
    const unit =
      etaSeconds < 60
        ? 'less than a minute'
        : etaSeconds === 60
          ? 'about 1 minute'
          : etaSeconds === 120
            ? 'about 2 minutes'
            : etaSeconds === 3600
              ? 'about 1 hour'
              : 'about 2 hours'

    expect(line.textContent).toBe(`12 of 40 files, ${unit}`)
  }
})

it.each(['syncing', 'paused', 'offline'] as const)('keeps inactive progress hidden while %s', async state => {
  show(
    driveBridge(
      ready({
        state,
        progress: {
          active: false,
          files: { done: 40, total: 40 },
          bytes: { done: 2, total: 2 },
          etaSeconds: null,
          direction: 'up'
        }
      })
    ).bridge
  )
  await screen.findByText(matrixDriveCopy.en.status[state])
  expect(driveRoot().querySelector('[data-matrix-drive-progress]')).toBeNull()
})

it('presents the full condition once, never exposes opaque issue ids, and sends the real open-folder action', async () => {
  const issue: MatrixDriveIssue = { id: 'opaque-native-handle', code: 'drive_full', count: 3 }

  const drive = driveBridge(
    ready({
      quota: { total: 1_000, used: 1_000, remaining: 0, state: 'exceeded' },
      issues: [issue]
    })
  )

  show(drive.bridge)

  await screen.findByText('Drive is full')
  const facts = driveRoot().querySelector('[data-matrix-drive-facts]') as HTMLElement
  expect(within(facts).getAllByText('Drive is full')).toHaveLength(1)
  expect(within(facts).getByText('3 files')).toBeTruthy()
  expect(facts.textContent).not.toContain(issue.id)
  fireEvent.click(within(facts).getByRole('button', { name: 'Show in Finder' }))
  await waitFor(() => expect(drive.reveal).toHaveBeenCalledOnce())
})

it.each([
  ['conflicts', 'Some files have conflicts', 'Refresh', 'read'],
  ['errors', 'Some files couldn’t sync', 'Refresh', 'read'],
  ['signed_out', 'Drive needs to reconnect', 'Try again', 'connect']
] as const)('maps the %s issue to its plain action and no opaque operation', async (code, title, label, action) => {
  const drive = driveBridge(ready({ issues: [{ id: `opaque-${code}`, code }] }))
  show(drive.bridge)

  const issue = await screen.findByText(title)
  const card = issue.closest('[data-matrix-drive-issue]') as HTMLElement
  expect(card.getAttribute('data-matrix-drive-issue')).toBe(code)
  drive.read.mockClear()
  fireEvent.click(within(card).getByRole('button', { name: label }))
  await waitFor(() => expect(drive[action]).toHaveBeenCalledOnce())
})

it('shows skipped files as a quiet header note, never an issue card, and explains them on click', async () => {
  // jsdom has no ResizeObserver; Radix's popover measures with it.
  vi.stubGlobal('ResizeObserver', class {
    disconnect() {}
    observe() {}
    unobserve() {}
  })
  const drive = driveBridge(ready({ issues: [{ id: 'opaque-excluded', code: 'excluded', count: 7 }] }))
  show(drive.bridge)

  const note = await screen.findByRole('button', { name: '7 files only on this Mac' })
  expect(driveRoot().querySelector('[data-matrix-drive-issue]')).toBeNull()
  expect(driveRoot().querySelector('[data-matrix-drive-facts]')).toBeNull()
  expect(driveRoot().textContent).not.toContain('opaque-excluded')

  fireEvent.click(note)
  await screen.findByText(matrixDriveCopy.en.facts.issues.excluded.body)
  fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }))
  await waitFor(() => expect(drive.reveal).toHaveBeenCalledOnce())
})

it('keeps a real sync failure as its card while skipped files stay a note', async () => {
  const drive = driveBridge(
    ready({
      issues: [
        { id: 'opaque-errors', code: 'errors', count: 2 },
        { id: 'opaque-excluded', code: 'excluded', count: 1 }
      ]
    })
  )
  show(drive.bridge)

  await screen.findByText('Some files couldn’t sync')
  expect(screen.getByRole('button', { name: '1 file only on this Mac' })).toBeTruthy()
  const cards = driveRoot().querySelectorAll('[data-matrix-drive-issue]')
  expect([...cards].map(card => card.getAttribute('data-matrix-drive-issue'))).toEqual(['errors'])
})

it('shows only active, fresh progress, then drops it while stale and restores fresh facts from the subscribed bridge', async () => {
  const initial = ready({
    revision: 4,
    state: 'syncing',
    progress: {
      active: true,
      files: { done: 12, total: 40 },
      bytes: { done: 2, total: 10 },
      etaSeconds: 60,
      direction: 'up'
    }
  })

  const drive = driveBridge(initial)
  show(drive.bridge)

  await screen.findByText('12 of 40 files, about 1 minute')
  expect(driveRoot().querySelector('[data-matrix-drive-progress]')?.textContent).toContain(
    '12 of 40 files, about 1 minute'
  )
  await act(async () => drive.publish({ ...initial, revision: 5, state: 'ready', factsStale: true }))
  expect(driveRoot().querySelector('[data-matrix-drive-progress]')).toBeNull()
  expect(screen.getByText('Showing last known info. Refresh to update.')).toBeTruthy()
  expect(screen.queryByText(/Up to date/)).toBeNull()

  await act(async () => drive.publish({ ...initial, revision: 6, state: 'ready', lastSyncAt: undefined }))
  await screen.findByText('Up to date')
  expect(screen.queryByText('Showing last known info. Refresh to update.')).toBeNull()
})

it.each(Object.keys(matrixDriveCopy) as Locale[])('renders fact copy without placeholders for %s', async locale => {
  const drive = driveBridge(
    ready({
      state: 'syncing',
      quota: { total: 1_000, used: 700, remaining: 300, state: 'nearing' },
      progress: {
        active: true,
        files: { done: 1, total: 2 },
        bytes: { done: 1, total: 2 },
        etaSeconds: null,
        direction: 'mixed'
      },
      issues: [
        { id: 'opaque', code: 'errors', count: 1 },
        { id: 'opaque-skipped', code: 'excluded', count: 3 }
      ]
    })
  )

  const rendered = show(drive.bridge, locale)

  await waitFor(() => expect(driveRoot().querySelector('[data-matrix-drive-facts]')).not.toBeNull())
  const facts = driveRoot().querySelector('[data-matrix-drive-facts]') as HTMLElement
  expect(facts.textContent).not.toMatch(/\{(?:count|done|total|used|remaining)\}/)
  expect(facts.textContent).not.toMatch(/TODO|undefined|null/)
  const note = driveRoot().querySelector('[data-matrix-drive-skipped]') as HTMLElement
  expect(note.textContent).toContain('3')
  expect(note.textContent).not.toMatch(/\{count\}|undefined/)
  rendered.unmount()
})
