import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixDriveBridge, MatrixDriveRow, MatrixDriveView } from '../../shared/matrix-drive'

import { MatrixDrive } from './drive'
import {
  $matrixDrivePdfLease,
  learnMatrixDrivePlaces,
  setMatrixDriveGroupBy,
  setMatrixDriveLayout
} from './drive-finder'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

afterEach(() => {
  cleanup()
  setMatrixDriveLayout('icon')
  setMatrixDriveGroupBy('none')
  $matrixDrivePdfLease.set(false)
  learnMatrixDrivePlaces(null, 'en')
  localStorage.clear()
})

type Entry = { name: string; kind: 'file' | 'folder'; size?: number; modifiedAt?: number }

/**
 * A bridge that behaves as main does: one open folder, and item ids that only last for the listing
 * that issued them, so a stale id from a remembered column fails.
 */
function treeBridge(tree: Record<string, Entry[]>) {
  let at: string[] = []
  let listing = 0
  let current = new Map<string, Entry>()

  const list = (): MatrixDriveView => {
    listing += 1
    current = new Map()

    const rows: MatrixDriveRow[] = (tree[at.join('/')] ?? []).map(entry => {
      const id = `${at.join('/')}/${entry.name}#${listing}`
      current.set(id, entry)

      return { id, name: entry.name, kind: entry.kind, size: entry.size ?? 10, modifiedAt: entry.modifiedAt ?? 1 }
    })

    return {
      state: 'ready',
      revision: 1,
      rows,
      truncated: false,
      canGoBack: at.length > 0,
      folderLabel: at.at(-1),
      listingStatus: 'current',
      listedAt: 1
    }
  }

  const bridge = {
    read: vi.fn(async () => list()),
    enter: vi.fn(async (id: string) => {
      const entry = current.get(id)

      if (!entry || entry.kind !== 'folder') {
        throw new Error('matrix_drive_file_unavailable')
      }

      at = [...at, entry.name]

      return list()
    }),
    back: vi.fn(async () => {
      at = at.slice(0, -1)

      return list()
    }),
    open: vi.fn(async () => {}),
    reveal: vi.fn(async () => {}),
    subscribe: () => () => {}
  }

  return { bridge, where: () => at.join('/') }
}

const TREE: Record<string, Entry[]> = {
  '': [
    { name: 'Docs', kind: 'folder' },
    { name: 'Photos', kind: 'folder' },
    { name: 'a.txt', kind: 'file' }
  ],
  Docs: [
    { name: 'Work', kind: 'folder' },
    { name: 'notes.md', kind: 'file' }
  ],
  'Docs/Work': [{ name: 'plan.docx', kind: 'file' }],
  Photos: [{ name: 'b.jpg', kind: 'file' }]
}

const renderDrive = (bridge: unknown, onPreview?: (row: MatrixDriveRow) => void) =>
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive bridge={bridge as MatrixDriveBridge} onPreview={onPreview} />
    </I18nProvider>
  )

const column = (path: string) => window.document.querySelector<HTMLElement>(`[data-matrix-drive-column="${path}"]`)

const columnNames = (path: string) =>
  within(column(path)!)
    .queryAllByRole('option')
    .map(option => option.getAttribute('aria-label'))

it('shows the folders on the open path side by side and moves through them with the arrow keys', async () => {
  setMatrixDriveLayout('column')
  const { bridge, where } = treeBridge(TREE)
  renderDrive(bridge)

  await screen.findByRole('option', { name: 'Docs' })
  // A click on a folder opens it in the next column.
  fireEvent.click(screen.getByRole('option', { name: 'Docs' }))
  await waitFor(() => expect(columnNames('Docs')).toEqual(['notes.md', 'Work']))
  expect(columnNames('')).toEqual(['a.txt', 'Docs', 'Photos'])
  expect(within(column('')!).getByRole('option', { name: 'Docs' }).getAttribute('aria-selected')).toBe('true')

  // Down in the Drive's column: the next folder opens in place of Docs.
  fireEvent.keyDown(within(column('')!).getByRole('option', { name: 'Docs' }), { key: 'ArrowDown' })
  await waitFor(() => expect(where()).toBe('Photos'))
  await waitFor(() => expect(columnNames('Photos')).toEqual(['b.jpg']))
  expect(column('Docs')).toBeNull()

  // Right goes into the open folder and selects its first item; its preview follows.
  fireEvent.keyDown(within(column('')!).getByRole('option', { name: 'Photos' }), { key: 'ArrowRight' })
  await waitFor(() =>
    expect(within(column('Photos')!).getByRole('option', { name: 'b.jpg' }).getAttribute('aria-selected')).toBe('true')
  )
  expect(window.document.querySelector('[data-matrix-drive-column-preview]')?.textContent).toContain('b.jpg')

  // Left goes back out; Up moves to Docs, opening it again from a fresh listing.
  fireEvent.keyDown(within(column('Photos')!).getByRole('option', { name: 'b.jpg' }), { key: 'ArrowLeft' })
  await waitFor(() => expect(window.document.querySelector('[data-matrix-drive-column-preview]')).toBeNull())
  fireEvent.keyDown(within(column('')!).getByRole('option', { name: 'Photos' }), { key: 'ArrowUp' })
  await waitFor(() => expect(where()).toBe('Docs'))
  await waitFor(() => expect(columnNames('Docs')).toEqual(['notes.md', 'Work']))
})

it('reaches an item in a column further back by walking there, never with a stale id', async () => {
  setMatrixDriveLayout('column')
  const { bridge, where } = treeBridge(TREE)
  const onPreview = vi.fn()
  renderDrive(bridge, onPreview)

  fireEvent.click(await screen.findByRole('option', { name: 'Docs' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Work' }))
  await waitFor(() => expect(columnNames('Docs/Work')).toEqual(['plan.docx']))

  // a.txt sits two columns back: Drive walks up and selects it from the fresh listing.
  fireEvent.click(within(column('')!).getByRole('option', { name: 'a.txt' }))
  await waitFor(() => expect(where()).toBe(''))
  await waitFor(() => expect(screen.getByRole('option', { name: 'a.txt' }).getAttribute('aria-selected')).toBe('true'))
  expect(column('Docs')).toBeNull()

  // A double-click on a file further back opens it once it is reached.
  fireEvent.click(screen.getByRole('option', { name: 'Docs' }))
  await waitFor(() => expect(columnNames('Docs')).toEqual(['notes.md', 'Work']))
  fireEvent.click(within(column('Docs')!).getByRole('option', { name: 'Work' }))
  await waitFor(() => expect(where()).toBe('Docs/Work'))
  fireEvent.doubleClick(within(column('Docs')!).getByRole('option', { name: 'notes.md' }))
  await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1))
  expect(onPreview.mock.calls[0]![0]).toMatchObject({ name: 'notes.md' })
  expect(where()).toBe('Docs')
  expect(bridge.enter.mock.results.every(result => result.type === 'return')).toBe(true)
})

it('draws an empty folder as an empty column, not the empty-folder page', async () => {
  setMatrixDriveLayout('column')
  const { bridge } = treeBridge({ ...TREE, Photos: [] })
  renderDrive(bridge)

  fireEvent.click(await screen.findByRole('option', { name: 'Photos' }))
  await waitFor(() => expect(column('Photos')).not.toBeNull())
  expect(columnNames('Photos')).toEqual([])
  expect(screen.queryByText('This folder is empty')).toBeNull()
})

it('groups icons and lists by kind under Finder’s titles and turns grouping off for columns', async () => {
  setMatrixDriveLayout('list')
  setMatrixDriveGroupBy('kind')

  const { bridge } = treeBridge({
    '': [
      { name: 'Docs', kind: 'folder' },
      { name: 'b.png', kind: 'file' },
      { name: 'a.jpg', kind: 'file' },
      { name: 'Lease.pdf', kind: 'file' }
    ]
  })

  renderDrive(bridge)

  await screen.findByRole('option', { name: 'Docs' })
  const groups = within(screen.getByRole('listbox')).getAllByRole('group')
  expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Folders', 'Images', 'PDF Documents'])
  expect(
    within(groups[1]!)
      .getAllByRole('option')
      .map(option => option.getAttribute('aria-label'))
  ).toEqual(['a.jpg', 'b.png'])

  // The list moves straight through the groups.
  fireEvent.click(screen.getByRole('option', { name: 'Docs' }))
  fireEvent.keyDown(screen.getByRole('option', { name: 'Docs' }), { key: 'ArrowDown' })
  expect(screen.getByRole('option', { name: 'a.jpg' }).getAttribute('aria-selected')).toBe('true')

  act(() => setMatrixDriveLayout('column'))
  expect(window.document.querySelectorAll('[data-matrix-drive-group-id]')).toHaveLength(0)
  expect((screen.getByRole('button', { name: 'Group' }) as HTMLButtonElement).disabled).toBe(true)
})

it('shows the selected picture large in the gallery and gives its preview lease straight back', async () => {
  setMatrixDriveLayout('gallery')

  const { bridge } = treeBridge({
    '': [
      { name: 'a.png', kind: 'file' },
      { name: 'Lease.pdf', kind: 'file' }
    ]
  })

  const preview = vi.fn(async (id: string) => ({
    token: `token:${id}`,
    name: 'a.png',
    size: 10,
    modifiedAt: 1,
    kind: 'image' as const,
    dataUrl: 'data:image/png;base64,AAAA'
  }))

  const closePreview = vi.fn(async () => {})
  renderDrive({ ...bridge, preview, closePreview })

  // The first item is chosen for the stage, as Finder's gallery opens.
  await waitFor(() => expect(screen.getByRole('option', { name: 'a.png' }).getAttribute('aria-selected')).toBe('true'))
  const image = await screen.findByRole('img', { name: 'a.png' })
  expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  expect(closePreview).toHaveBeenCalledWith(`token:${preview.mock.calls[0]![0]}`)

  // A PDF is drawn as its glyph: no lease is spent on it.
  fireEvent.keyDown(screen.getByRole('option', { name: 'a.png' }), { key: 'ArrowRight' })
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'Lease.pdf' }).getAttribute('aria-selected')).toBe('true')
  )
  expect(
    window.document.querySelector('[data-matrix-drive-gallery-stage]')?.getAttribute('data-matrix-drive-gallery-stage')
  ).toBe('glyph')
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(preview).toHaveBeenCalledTimes(1)
})

it('leaves the side panel’s PDF lease alone while it is open', async () => {
  setMatrixDriveLayout('gallery')
  $matrixDrivePdfLease.set(true)
  const { bridge } = treeBridge({ '': [{ name: 'a.png', kind: 'file' }] })
  const preview = vi.fn()
  renderDrive({ ...bridge, preview, closePreview: vi.fn() })

  await waitFor(() => expect(screen.getByRole('option', { name: 'a.png' }).getAttribute('aria-selected')).toBe('true'))
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(preview).not.toHaveBeenCalled()
  expect(
    window.document.querySelector('[data-matrix-drive-gallery-stage]')?.getAttribute('data-matrix-drive-gallery-stage')
  ).toBe('glyph')
})
