import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumConsumerFileEntry, AtumConsumerFileOpenResult, AtumConsumerFileRoots, HermesReadDirResult } from '@/global'

const readDesktopDir = vi.fn<(path: string) => Promise<HermesReadDirResult>>()
const normalizeOrLocalPreviewTarget = vi.fn()
const setCurrentSessionPreviewTarget = vi.fn()
const setAtumDmConversationPreviewTarget = vi.fn()
const tryOpenNativeOfficeDocument = vi.fn(async () => 'unavailable')
const accountScope = atom<string | null>(null)

vi.mock('@/lib/desktop-fs', () => ({ readDesktopDir }))
vi.mock('@/lib/local-preview', () => ({
  localPreviewTarget: (path: string) => ({ kind: 'file', label: path.split('/').pop(), path, source: path, url: `file://${path}` }),
  normalizeOrLocalPreviewTarget
}))
vi.mock('@/store/atum-dm-workspace', () => ({ setAtumDmConversationPreviewTarget }))
vi.mock('@/store/preview', () => ({ setCurrentSessionPreviewTarget }))
vi.mock('@/lib/native-office-routing', () => ({ tryOpenNativeOfficeDocument }))
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId: accountScope }))

const { I18nProvider } = await import('@/i18n')
const { $currentCwd } = await import('@/store/session')
const { resetAtumShellState } = await import('@/store/atum-shell')
const { $visibleWorkbenchTabs, $workbenchScope, $workbenchTabs, closeWorkbenchTab, openWorkbenchSingleton, resetWorkbenchTabs, setWorkbenchScope } = await import('@/store/workbench-tabs')
const { $workspaceTextFileTabs } = await import('@/store/workspace-text-files')

const {
  AtumConsumerFiles,
  breadcrumbSegments,
  consumerVisibleEntries,
  folderName,
  formatFileSize,
  parentDirectory,
  sortConsumerEntries
} = await import('./consumer-files')

const { ConsumerFileGlyph } = await import('./consumer-file-icon')

const HOME = '/home/example'
const DOCS = `${HOME}/Documents`

function entry(name: string, path: string, extra: Partial<AtumConsumerFileEntry> = {}): AtumConsumerFileEntry {
  const isDirectory = extra.isDirectory ?? false
  const dot = name.lastIndexOf('.')

  return {
    extension: isDirectory || dot <= 0 ? '' : name.slice(dot).toLowerCase(),
    isDirectory,
    modifiedMs: 1_756_800_000_000,
    name,
    path,
    size: isDirectory ? null : 1234,
    ...extra
  }
}

const FOLDERS: Record<string, AtumConsumerFileEntry[]> = {
  [DOCS]: [
    entry('notes.md', `${DOCS}/notes.md`, { size: 7 }),
    entry('.env.local', `${DOCS}/.env.local`),
    entry('Reports', `${DOCS}/Reports`, { isDirectory: true }),
    entry('budget.xlsx', `${DOCS}/budget.xlsx`, { size: 250_000 }),
    entry('photo.png', `${DOCS}/photo.png`, { size: 40_000 })
  ],
  [`${DOCS}/Reports`]: [entry('q3 report.pdf', `${DOCS}/Reports/q3 report.pdf`)],
  [HOME]: [entry('Documents', DOCS, { isDirectory: true }), entry('Desktop', `${HOME}/Desktop`, { isDirectory: true })],
  [`${HOME}/Desktop`]: []
}

const bridge = {
  list: vi.fn(async (path: string) => ({ entries: FOLDERS[path] ?? [], error: FOLDERS[path] ? undefined : 'ENOENT' })),
  mkdir: vi.fn(async (path: string, name: string) => {
    FOLDERS[path]?.push(entry(name, `${path}/${name}`, { isDirectory: true }))

    return { path: `${path}/${name}` }
  }),
  open: vi.fn<(path: string) => Promise<AtumConsumerFileOpenResult>>(),
  releaseView: vi.fn(async () => true),
  thumbnail: vi.fn(async (path: string) => (path.endsWith('.png') ? 'data:image/png;base64,THUMB' : null)),
  openNative: vi.fn(async () => ({ ok: true })),
  rename: vi.fn(async (path: string, name: string) => ({ path: `${path.slice(0, path.lastIndexOf('/'))}/${name}` })),
  reveal: vi.fn(async () => true),
  roots: vi.fn<() => Promise<AtumConsumerFileRoots>>(async () => ({ desktop: `${HOME}/Desktop`, documents: DOCS, downloads: `${HOME}/Downloads`, home: HOME })),
  search: vi.fn(async () => ({ entries: [] as AtumConsumerFileEntry[], truncated: false })),
  trash: vi.fn(async () => true)
}

function installBridge(installed = true) {
  Object.assign(window, { hermesDesktop: installed ? { consumerFiles: bridge } : undefined })
}

function renderVi(conversationId: null | string = null) {
  return render(<I18nProvider configClient={null} initialLocale="vi"><AtumConsumerFiles conversationId={conversationId} /></I18nProvider>)
}

async function renderFiles(conversationId: null | string = null) {
  const view = renderVi(conversationId)
  await screen.findByRole('option', { name: 'notes.md' })

  return view
}

describe('AtumConsumerFiles', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAtumShellState()
    resetWorkbenchTabs()
    $workspaceTextFileTabs.set([])
    setWorkbenchScope('moon')
    vi.clearAllMocks()
    accountScope.set(null)
    bridge.roots.mockResolvedValue({ desktop: `${HOME}/Desktop`, documents: DOCS, downloads: `${HOME}/Downloads`, home: HOME })
    tryOpenNativeOfficeDocument.mockResolvedValue('unavailable')
    bridge.open.mockResolvedValue({ kind: 'native' })
    bridge.search.mockResolvedValue({ entries: [], truncated: false })
    $currentCwd.set('/work/project')
    installBridge()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens in Documents as a Finder-like icon grid: folders first, dot entries hidden, places and breadcrumb visible', async () => {
    await renderFiles()

    const options = screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))
    expect(options).toEqual(['Reports', 'budget.xlsx', 'notes.md', 'photo.png'])
    expect(screen.getByRole('button', { name: 'Biểu tượng' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('option', { name: 'Reports' }).querySelector('[data-file-kind]')!.getAttribute('data-file-kind')).toBe('folder')
    expect(screen.getByRole('option', { name: 'budget.xlsx' }).querySelector('[data-file-kind]')!.getAttribute('data-file-kind')).toBe('spreadsheet')

    const crumbs = within(screen.getByRole('navigation', { name: 'Tệp của tôi' })).getAllByRole('button').map(button => button.textContent)
    expect(crumbs).toEqual(['Thư mục cá nhân', 'Documents'])

    const places = within(screen.getByRole('group', { name: 'Vị trí' })).getAllByRole('button').map(button => button.textContent)
    expect(places).toEqual(['Thư mục cá nhân', 'Màn hình nền', 'Tài liệu', 'Tải về', 'Thư mục làm việc'])
    expect(screen.getByRole('status').textContent).toContain('4 mục')
  })

  it('opens the account home base before Documents or an explicitly chosen chat cwd and keeps it in Places', async () => {
    const workspace = `${HOME}/Atum`
    FOLDERS[workspace] = [entry('my work.md', `${workspace}/my work.md`)]
    bridge.roots.mockResolvedValue({ desktop: `${HOME}/Desktop`, documents: DOCS, downloads: `${HOME}/Downloads`, home: HOME, workspace })
    renderVi()
    await screen.findByRole('option', { name: 'my work.md' })
    expect(bridge.list).toHaveBeenCalledWith(workspace)
    expect(bridge.list).not.toHaveBeenCalledWith(DOCS)
    const places = within(screen.getByRole('group', { name: 'Vị trí' }))
    expect(places.getByRole('button', { name: /^Atum$/ })).toBeTruthy()
    fireEvent.click(places.getByRole('button', { name: 'Tài liệu' }))
    await screen.findByRole('option', { name: 'notes.md' })
    act(() => $currentCwd.set('/another/chat'))
    await waitFor(() => expect(bridge.roots).toHaveBeenCalledTimes(2))
    expect(bridge.list).toHaveBeenLastCalledWith(DOCS)
    fireEvent.click(places.getByRole('button', { name: /^Atum$/ }))
    await screen.findByRole('option', { name: 'my work.md' })
  })

  it('an account change resets navigation to the incoming home base', async () => {
    const workspace = `${HOME}/Atum (2)`
    FOLDERS[workspace] = [entry('new account.md', `${workspace}/new account.md`)]
    await renderFiles()
    fireEvent.doubleClick(screen.getByRole('option', { name: 'Reports' }))
    await screen.findByRole('option', { name: 'q3 report.pdf' })
    bridge.roots.mockResolvedValue({ desktop: `${HOME}/Desktop`, documents: DOCS, downloads: `${HOME}/Downloads`, home: HOME, workspace })
    act(() => accountScope.set('next-account'))
    await screen.findByRole('option', { name: 'new account.md' })
    expect(bridge.list).toHaveBeenLastCalledWith(workspace)
    expect(screen.queryByRole('option', { name: 'q3 report.pdf' })).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Vị trí' })).getByRole('button', { name: /^Atum \(2\)$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Quay lại' }).hasAttribute('disabled')).toBe(true)
  })

  it('ignores a late home-base response from the outgoing account', async () => {
    let finishOldRoots!: (roots: AtumConsumerFileRoots) => void
    bridge.roots.mockReturnValueOnce(new Promise(resolve => { finishOldRoots = resolve }))
    renderVi()
    const workspace = `${HOME}/Atum (3)`
    FOLDERS[workspace] = [entry('incoming.txt', `${workspace}/incoming.txt`)]
    const nextRoots = { desktop: `${HOME}/Desktop`, documents: DOCS, downloads: `${HOME}/Downloads`, home: HOME, workspace }
    bridge.roots.mockResolvedValue(nextRoots)
    act(() => accountScope.set('incoming-account'))
    await screen.findByRole('option', { name: 'incoming.txt' })
    await act(async () => finishOldRoots({ ...nextRoots, workspace: DOCS }))
    expect(bridge.list).toHaveBeenLastCalledWith(workspace)
    expect(screen.queryByRole('option', { name: 'notes.md' })).toBeNull()
  })

  it('navigates with double-click, back, forward, up, breadcrumbs and places', async () => {
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'Reports' }))
    await screen.findByRole('option', { name: 'q3 report.pdf' })
    expect(bridge.list).toHaveBeenLastCalledWith(`${DOCS}/Reports`)

    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }))
    await screen.findByRole('option', { name: 'notes.md' })

    fireEvent.click(screen.getByRole('button', { name: 'Tiến' }))
    await screen.findByRole('option', { name: 'q3 report.pdf' })

    fireEvent.click(screen.getByRole('button', { name: 'Lên một thư mục' }))
    await screen.findByRole('option', { name: 'notes.md' })

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Tệp của tôi' })).getByRole('button', { name: 'Thư mục cá nhân' }))
    await screen.findByRole('option', { name: 'Desktop' })

    fireEvent.click(within(screen.getByRole('group', { name: 'Vị trí' })).getByRole('button', { name: 'Tài liệu' }))
    await screen.findByRole('option', { name: 'notes.md' })
  })

  it('selects on click and opens text through the main-owned lease into a scoped workbench tab', async () => {
    bridge.open.mockResolvedValueOnce({ descriptor: { displayName: 'notes.md', fileRef: 'lease-1' }, kind: 'text' })
    openWorkbenchSingleton('files')
    await renderFiles('moon')

    const option = screen.getByRole('option', { name: 'notes.md' })
    fireEvent.click(option)
    expect(option.getAttribute('aria-selected')).toBe('true')
    expect(bridge.open).not.toHaveBeenCalled()

    fireEvent.keyDown(option, { key: 'Enter' })

    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith(`${DOCS}/notes.md`)
      const tab = $visibleWorkbenchTabs.get().find(candidate => candidate.surface.kind === 'preview')
      expect(tab).toMatchObject({ scopeKey: $workbenchScope.get(), surface: { kind: 'preview', target: { workspaceTextFile: { fileRef: 'lease-1' } } } })
    })
    expect($workspaceTextFileTabs.get().map(tab => tab.target.workspaceTextFile.fileRef)).toEqual(['lease-1'])
    expect(setAtumDmConversationPreviewTarget).not.toHaveBeenCalled()
  })

  it('opens images from the bytes main returned and reports native opens without a preview', async () => {
    bridge.open.mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,AAAA', kind: 'image', mimeType: 'image/png', size: 4 })
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'photo.png' }))

    await waitFor(() => {
      const tab = $visibleWorkbenchTabs.get().find(candidate => candidate.surface.kind === 'preview')
      expect(tab).toMatchObject({ surface: { target: { dataUrl: 'data:image/png;base64,AAAA', previewKind: 'image' } } })
    })

    fireEvent.doubleClick(screen.getByRole('option', { name: 'budget.xlsx' }))
    await screen.findByText('Đã mở bằng ứng dụng mặc định.')
    expect($visibleWorkbenchTabs.get().filter(tab => tab.surface.kind === 'preview')).toHaveLength(1)
  })

  it('routes an explicitly selected installed Office file before the default native-open fallback', async () => {
    tryOpenNativeOfficeDocument.mockResolvedValueOnce('opened')
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'budget.xlsx' }))

    await waitFor(() => expect(tryOpenNativeOfficeDocument).toHaveBeenCalledWith(`${DOCS}/budget.xlsx`, true, $workbenchScope.get()))
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('does not relaunch a failed Office route through the default handler', async () => {
    tryOpenNativeOfficeDocument.mockResolvedValueOnce('failed')
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'budget.xlsx' }))

    await screen.findByText('Không mở được tệp này.')
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('opens a PDF as an in-panel viewer tab and hands the token back when the tab closes', async () => {
    bridge.open.mockResolvedValueOnce({ kind: 'pdf', token: 'tok-1' })
    FOLDERS[DOCS].push(entry('q3.pdf', `${DOCS}/q3.pdf`))
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'q3.pdf' }))

    await waitFor(() => {
      const tab = $visibleWorkbenchTabs.get().find(candidate => candidate.surface.kind === 'preview')
      expect(tab).toMatchObject({ scopeKey: 'moon', surface: { target: { label: 'q3.pdf', previewKind: 'pdf', url: 'atum-file:tok-1' } } })
    })

    closeWorkbenchTab($visibleWorkbenchTabs.get().find(candidate => candidate.surface.kind === 'preview')!.id)
    await waitFor(() => expect(bridge.releaseView).toHaveBeenCalledWith('tok-1'))
    FOLDERS[DOCS].pop()
  })

  it('lands opened resources in the scope the panel owns, not the global one', async () => {
    bridge.open.mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,AAAA', kind: 'image', mimeType: 'image/png', size: 4 })
    render(<I18nProvider configClient={null} initialLocale="vi"><AtumConsumerFiles conversationId="moon" scopeKey="atum-dm:acct:moon" /></I18nProvider>)
    await screen.findByRole('option', { name: 'notes.md' })
    setWorkbenchScope('somewhere-else')

    fireEvent.doubleClick(screen.getByRole('option', { name: 'photo.png' }))

    await waitFor(() => expect($workbenchTabs.get().find(tab => tab.surface.kind === 'preview')?.scopeKey).toBe('atum-dm:acct:moon'))
  })

  it('follows a scope change on the same mounted panel', async () => {
    bridge.open.mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA', kind: 'image', mimeType: 'image/png', size: 4 })
    const view = render(<I18nProvider configClient={null} initialLocale="vi"><AtumConsumerFiles conversationId="moon" scopeKey="scope-one" /></I18nProvider>)
    await screen.findByRole('option', { name: 'notes.md' })

    view.rerender(<I18nProvider configClient={null} initialLocale="vi"><AtumConsumerFiles conversationId="moon" scopeKey="scope-two" /></I18nProvider>)
    fireEvent.doubleClick(screen.getByRole('option', { name: 'photo.png' }))

    await waitFor(() => expect($workbenchTabs.get().find(tab => tab.surface.kind === 'preview')?.scopeKey).toBe('scope-two'))
  })

  it('shows OS thumbnails for image tiles in the grid and never for the list', async () => {
    await renderFiles()

    await waitFor(() => expect(screen.getByRole('option', { name: 'photo.png' }).querySelector('[data-file-thumbnail]')).toBeTruthy())
    expect(bridge.thumbnail).toHaveBeenCalledWith(`${DOCS}/photo.png`, 96)
    expect(bridge.thumbnail).not.toHaveBeenCalledWith(`${DOCS}/Reports`, 96)
    expect(screen.getByRole('option', { name: 'notes.md' }).querySelector('[data-file-thumbnail]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Danh sách' }))
    expect(screen.getByRole('option', { name: 'photo.png' }).querySelector('[data-file-thumbnail]')).toBeNull()
  })

  it('creates a new folder and drops straight into renaming it', async () => {
    await renderFiles()

    fireEvent.click(screen.getByRole('button', { name: 'Thư mục mới' }))

    await waitFor(() => expect(bridge.mkdir).toHaveBeenCalledWith(DOCS, 'Thư mục chưa đặt tên'))
    const input = await screen.findByRole('textbox', { name: 'Đổi tên' })
    expect((input as HTMLInputElement).value).toBe('Thư mục chưa đặt tên')
    fireEvent.change(input, { target: { value: 'Hóa đơn' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(bridge.rename).toHaveBeenCalledWith(`${DOCS}/Thư mục chưa đặt tên`, 'Hóa đơn'))
    FOLDERS[DOCS].pop()
  })

  it('keeps the listing when one file cannot open', async () => {
    bridge.open.mockResolvedValueOnce({ code: 'CONSUMER_FILES_READ_FAILED', kind: 'error' })
    await renderFiles()

    fireEvent.doubleClick(screen.getByRole('option', { name: 'notes.md' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Không mở được tệp này.')
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('switches to a persistent list with sortable columns and readable sizes', async () => {
    await renderFiles()

    fireEvent.click(screen.getByRole('button', { name: 'Danh sách' }))
    expect(localStorage.getItem('hermes.desktop.atum.fileView')).toBe('list')
    expect(screen.getByRole('columnheader', { name: /Tên/ }).getAttribute('aria-sort')).toBe('ascending')
    expect(within(screen.getByRole('option', { name: 'budget.xlsx' })).getByText('250 kB')).toBeTruthy()
    expect(within(screen.getByRole('option', { name: 'Reports' })).getByText('Thư mục')).toBeTruthy()

    fireEvent.click(screen.getByRole('columnheader', { name: /Kích thước/ }))
    expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['Reports', 'budget.xlsx', 'photo.png', 'notes.md'])
    expect(JSON.parse(localStorage.getItem('hermes.desktop.atum.fileSort')!)).toEqual({ direction: 'desc', key: 'size' })

    cleanup()
    await renderFiles()
    expect(screen.getByRole('button', { name: 'Danh sách' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('filters the open folder instantly, then searches below it once the query settles', async () => {
    bridge.search.mockResolvedValueOnce({
      entries: [entry('q3 report.pdf', `${DOCS}/Reports/q3 report.pdf`), entry('Reports', `${DOCS}/Reports`, { isDirectory: true })],
      truncated: true
    })
    await renderFiles()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Tìm trong thư mục này' }), { target: { value: 'rep' } })
    expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual(['Reports'])

    await waitFor(() => expect(bridge.search).toHaveBeenCalledWith(DOCS, 'rep'))
    await screen.findByRole('option', { name: 'q3 report.pdf' })
    expect(within(screen.getByRole('option', { name: 'q3 report.pdf' })).getByText('Reports')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Chỉ hiển thị những kết quả đầu tiên')

    fireEvent.click(screen.getByRole('button', { name: 'Xóa' }))
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('renames inline from the context menu and moves to Trash without a hard delete', async () => {
    await renderFiles()

    fireEvent.contextMenu(screen.getByRole('option', { name: 'notes.md' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Đổi tên' }))

    const input = await screen.findByRole('textbox', { name: 'Đổi tên' })
    fireEvent.change(input, { target: { value: 'todo.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(bridge.rename).toHaveBeenCalledWith(`${DOCS}/notes.md`, 'todo.md'))
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))

    fireEvent.contextMenu(screen.getByRole('option', { name: 'photo.png' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hiện trong thư mục' }))
    await waitFor(() => expect(bridge.reveal).toHaveBeenCalledWith(`${DOCS}/photo.png`))

    fireEvent.contextMenu(screen.getByRole('option', { name: 'budget.xlsx' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Chuyển vào Thùng rác' }))
    await waitFor(() => expect(bridge.trash).toHaveBeenCalledWith(`${DOCS}/budget.xlsx`))
  })

  it('surfaces rename failures without dropping the listing', async () => {
    bridge.rename.mockRejectedValueOnce(new Error('CONSUMER_FILES_EXISTS'))
    await renderFiles()

    const option = screen.getByRole('option', { name: 'notes.md' })
    fireEvent.click(option)
    fireEvent.keyDown(option, { key: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'Đổi tên' })
    fireEvent.change(input, { target: { value: 'budget.xlsx' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect((await screen.findByRole('alert')).textContent).toBe('Không đổi tên được. Có thể tên này đã tồn tại.')
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('renders honest loading, error, retry, and empty states without exposing error codes', async () => {
    bridge.list.mockImplementationOnce(async () => ({ entries: [], error: 'EACCES' }))
    renderVi()

    expect((await screen.findByText('Không mở được thư mục này.')).textContent).not.toContain('EACCES')
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    await screen.findByRole('option', { name: 'notes.md' })

    fireEvent.click(within(screen.getByRole('group', { name: 'Vị trí' })).getByRole('button', { name: 'Màn hình nền' }))
    await screen.findByText('Thư mục này đang trống')
  })

  it('falls back to the session folder and the legacy preview path when the consumer bridge is absent', async () => {
    installBridge(false)
    const target = { kind: 'file', label: 'a.txt', path: '/work/project/a.txt', previewKind: 'text', source: '/work/project/a.txt', url: 'file:///work/project/a.txt' }
    readDesktopDir.mockResolvedValue({ entries: [{ isDirectory: false, name: 'a.txt', path: '/work/project/a.txt' }] })
    normalizeOrLocalPreviewTarget.mockResolvedValue(target)

    renderVi('moon')
    fireEvent.doubleClick(await screen.findByRole('option', { name: 'a.txt' }))

    await waitFor(() => {
      expect(readDesktopDir).toHaveBeenCalledWith('/work/project')
      expect(setAtumDmConversationPreviewTarget).toHaveBeenCalledWith('moon', target)
      expect(setCurrentSessionPreviewTarget).not.toHaveBeenCalled()
    })
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('explains the no-folder state without calling the bridge', () => {
    installBridge(false)
    $currentCwd.set('')
    renderVi()

    expect(screen.getByText('Chưa truy cập được tệp trên máy này.')).toBeTruthy()
    expect(readDesktopDir).not.toHaveBeenCalled()
  })
})

describe('Atum consumer file helpers', () => {
  it('paints the folder body as a background image, so the gradient is visible', () => {
    render(<ConsumerFileGlyph isDirectory name="Documents" />)

    expect(globalThis.document.querySelector('[data-atum-folder-glyph] > span:last-child')?.className).toContain(
      'bg-[image:var(--atum-folder-body)]'
    )
  })

  it('handles POSIX and Windows parents, labels and breadcrumbs', () => {
    expect(parentDirectory('/home/example/Documents')).toBe('/home/example')
    expect(parentDirectory('/Users')).toBe('/')
    expect(parentDirectory('/')).toBeNull()
    expect(parentDirectory('C:\\Users\\fixture-user-10')).toBe('C:\\Users')
    expect(parentDirectory('C:\\Users')).toBe('C:\\')
    expect(folderName('/home/example/Documents/')).toBe('Documents')
    expect(breadcrumbSegments('/home/example/Documents').map(segment => segment.path)).toEqual(['/home', '/home/example', '/home/example/Documents'])
    expect(breadcrumbSegments('C:\\Users\\fixture-user-10').map(segment => segment.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\fixture-user-10'])
  })

  it('filters dot entries, keeps folders first, and sorts by the chosen column', () => {
    const entries = [
      entry('b.txt', '/b.txt', { modifiedMs: 2, size: 20 }),
      entry('.git', '/.git', { isDirectory: true }),
      entry('a.txt', '/a.txt', { modifiedMs: 3, size: 5 }),
      entry('Zeta', '/Zeta', { isDirectory: true })
    ]

    expect(consumerVisibleEntries(entries).map(item => item.name)).toEqual(['Zeta', 'a.txt', 'b.txt'])
    expect(sortConsumerEntries(consumerVisibleEntries(entries), { direction: 'desc', key: 'size' }).map(item => item.name)).toEqual(['Zeta', 'b.txt', 'a.txt'])
    expect(sortConsumerEntries(consumerVisibleEntries(entries), { direction: 'desc', key: 'modified' }).map(item => item.name)).toEqual(['Zeta', 'a.txt', 'b.txt'])
    expect(sortConsumerEntries(consumerVisibleEntries(entries), { direction: 'desc', key: 'name' }).map(item => item.name)).toEqual(['Zeta', 'b.txt', 'a.txt'])
  })

  it('formats sizes in familiar units', () => {
    expect(formatFileSize(null, 'en')).toBe('—')
    expect(formatFileSize(7, 'en')).toBe('7 byte')
    expect(formatFileSize(250_000, 'en')).toBe('250 kB')
    expect(formatFileSize(1_500_000_000, 'en')).toBe('1.5 GB')
  })
})

describe('AtumConsumerFiles keyboard', () => {
  beforeEach(() => {
    localStorage.clear()
    resetWorkbenchTabs()
    vi.clearAllMocks()
    bridge.open.mockResolvedValue({ kind: 'native' })
    $currentCwd.set('')
    installBridge()
  })

  afterEach(cleanup)

  it('keeps back/forward history exact under StrictMode double-invocation', async () => {
    render(<StrictMode><I18nProvider configClient={null} initialLocale="vi"><AtumConsumerFiles /></I18nProvider></StrictMode>)
    await screen.findByRole('option', { name: 'notes.md' })

    fireEvent.doubleClick(screen.getByRole('option', { name: 'Reports' }))
    await screen.findByRole('option', { name: 'q3 report.pdf' })

    fireEvent.click(screen.getByRole('button', { name: 'Quay lại' }))
    await screen.findByRole('option', { name: 'notes.md' })
    expect(screen.getByRole('button', { name: 'Quay lại' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Tiến' }).hasAttribute('disabled')).toBe(false)
  })

  it('makes the first row tabbable when nothing is selected', async () => {
    await renderFiles()
    expect(screen.getByRole('option', { name: 'Reports' }).getAttribute('tabindex')).toBe('0')
    fireEvent.click(screen.getByRole('option', { name: 'notes.md' }))
    expect(screen.getByRole('option', { name: 'Reports' }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('option', { name: 'notes.md' }).getAttribute('tabindex')).toBe('0')
  })

  it('moves the selection with arrows and goes up with Backspace', async () => {
    await renderFiles()

    const first = screen.getByRole('option', { name: 'Reports' })
    fireEvent.click(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'budget.xlsx' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(screen.getByRole('option', { name: 'budget.xlsx' }), { key: 'End' })
    expect(screen.getByRole('option', { name: 'photo.png' }).getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'photo.png' }), { key: 'Backspace' })
    })
    await screen.findByRole('option', { name: 'Desktop' })
    expect(bridge.list).toHaveBeenLastCalledWith(HOME)
  })
})
