import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tip } from '@/components/ui/tooltip'
import type { AtumConsumerFileEntry, AtumConsumerFileRoots, HermesReadDirEntry } from '@/global'
import { useI18n } from '@/i18n'
import { readDesktopDir } from '@/lib/desktop-fs'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  DeviceDesktop,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Home,
  LayoutDashboard,
  List,
  Search,
  X
} from '@/lib/icons'
import { localPreviewTarget, normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { tryOpenNativeOfficeDocument } from '@/lib/native-office-routing'
import { cn } from '@/lib/utils'
import { routesToWordCompanion } from '@/lib/word-companion-routing'
import { setAtumDmConversationPreviewTarget } from '@/store/atum-dm-workspace'
import { atumFileViewTargetUrl } from '@/store/atum-file-views'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { requestFileAccessPrePrompt } from '@/store/permission-preprompts'
import { type PreviewTarget, setCurrentSessionPreviewTarget } from '@/store/preview'
import { $currentCwd } from '@/store/session'
import { openWordCompanion } from '@/store/word-companion'
import { $workbenchScope, openPreviewWorkbenchTab, revealWorkbenchTab } from '@/store/workbench-tabs'
import { trackWorkspaceTextFileTarget, workspaceTextFileTarget } from '@/store/workspace-text-files'

import { consumerFileExtension, ConsumerFileGlyph, ConsumerFileIcon } from './consumer-file-icon'

export type AtumFileView = 'grid' | 'list'
export type AtumFileSortKey = 'modified' | 'name' | 'size'

interface SortState {
  direction: 'asc' | 'desc'
  key: AtumFileSortKey
}

const VIEW_STORAGE_KEY = 'hermes.desktop.atum.fileView'
const SORT_STORAGE_KEY = 'hermes.desktop.atum.fileSort'
const SEARCH_DEBOUNCE_MS = 250
const THUMBNAIL_CACHE_MAX = 400
const PROTECTED_FOLDER = /^(Desktop|Documents|Downloads)$/u

/**
 * Parent calculation deliberately supports the path shapes the desktop bridge
 * can return on macOS, Linux, Windows drives, and UNC shares. The returned
 * separator follows the input so it can be sent straight back to the bridge.
 */
export function parentDirectory(filePath: string): null | string {
  const separator = filePath.includes('\\') && !filePath.includes('/') ? '\\' : '/'
  const normalized = filePath.replace(/[\\/]+$/u, '')

  if (!normalized || normalized === '/' || /^[A-Za-z]:$/u.test(normalized)) {
    return null
  }

  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))

  if (lastSeparator < 0) {
    return null
  }

  // POSIX root and Windows drive root retain their trailing separator.
  if (lastSeparator === 0) {
    return '/'
  }

  const parent = normalized.slice(0, lastSeparator)

  return /^[A-Za-z]:$/u.test(parent) ? `${parent}${separator}` : parent
}

export function folderName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/u, '')

  return normalized.split(/[\\/]/u).filter(Boolean).pop() || filePath || ''
}

export function consumerVisibleEntries<T extends { isDirectory: boolean; name: string }>(entries: readonly T[]): T[] {
  return entries
    .filter(entry => !entry.name.startsWith('.'))
    .toSorted(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true })
    )
}

export function sortConsumerEntries(entries: readonly AtumConsumerFileEntry[], sort: SortState): AtumConsumerFileEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1

  return entries.toSorted((a, b) => {
    // Folders stay on top in every ordering, as Finder's default does.
    const folderOrder = Number(b.isDirectory) - Number(a.isDirectory)

    if (folderOrder !== 0) {
      return folderOrder
    }

    if (sort.key === 'modified') {
      const delta = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0)

      if (delta !== 0) {
        return sign * delta
      }
    } else if (sort.key === 'size') {
      const delta = (a.size ?? -1) - (b.size ?? -1)

      if (delta !== 0) {
        return sign * delta
      }
    }

    return sign * a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** Path segments from the filesystem root, keeping Windows drive roots whole. */
export function breadcrumbSegments(directory: string): Array<{ label: string; path: string }> {
  const normalized = directory.replace(/[\\/]+$/u, '')
  const separator = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/'
  const parts = normalized.split(/[\\/]/u)
  const segments: Array<{ label: string; path: string }> = []
  let current = ''

  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (part === '') {
        continue
      }

      current = /^[A-Za-z]:$/u.test(part) ? `${part}${separator}` : part
      segments.push({ label: part, path: current })

      continue
    }

    if (!part) {
      continue
    }

    current = current.endsWith(separator) ? `${current}${part}` : `${current}${separator}${part}`
    segments.push({ label: part, path: current })
  }

  return segments
}

export function formatFileSize(bytes: null | number, locale: string): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return '—'
  }

  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let value = bytes
  let unitIndex = 0

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }

  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: unitIndex === 0 ? 0 : 1,
      style: 'unit',
      unit: units[unitIndex],
      unitDisplay: 'short'
    }).format(value)
  } catch {
    return `${Math.round(value)} ${units[unitIndex]}`
  }
}

function initialView(): AtumFileView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function initialSort(): SortState {
  try {
    const parsed = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || 'null') as Partial<SortState> | null

    if (parsed && ['modified', 'name', 'size'].includes(parsed.key ?? '') && ['asc', 'desc'].includes(parsed.direction ?? '')) {
      return { direction: parsed.direction!, key: parsed.key! }
    }
  } catch {
    // Fall through to the default ordering.
  }

  return { direction: 'asc', key: 'name' }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A disabled storage backend must not make the file browser unusable.
  }
}

function legacyEntries(entries: readonly HermesReadDirEntry[]): AtumConsumerFileEntry[] {
  return entries.map(entry => ({
    extension: entry.isDirectory ? '' : consumerFileExtension(entry.name),
    isDirectory: entry.isDirectory,
    modifiedMs: null,
    name: entry.name,
    path: entry.path,
    size: null
  }))
}

interface Notice {
  kind: 'error' | 'info'
  text: string
}

export function AtumConsumerFiles({ conversationId = null, scopeKey }: { conversationId?: null | string; scopeKey?: string }) {
  const { locale, t } = useI18n()
  const cwd = useStore($currentCwd)
  const accountId = useStore($atumAccountScopeId)
  const filesAccount = useRef(accountId)
  const bridge = window.hermesDesktop?.consumerFiles ?? null
  const [roots, setRoots] = useState<AtumConsumerFileRoots | null>(null)
  const [directory, setDirectory] = useState(() => (bridge ? '' : cwd))
  const [entries, setEntries] = useState<AtumConsumerFileEntry[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [back, setBack] = useState<string[]>([])
  const [forward, setForward] = useState<string[]>([])
  const [view, setView] = useState<AtumFileView>(initialView)
  const [sort, setSort] = useState<SortState>(initialSort)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ entries: AtumConsumerFileEntry[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedPath, setSelectedPath] = useState<null | string>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const [openingPath, setOpeningPath] = useState<null | string>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const requestId = useRef(0)
  const searchRequestId = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const thumbnails = useRef(new Map<string, null | string>())
  const thumbnailMisses = useRef(new Set<string>())
  const [thumbnailNonce, setThumbnailNonce] = useState(0)
  // Resources opened here belong to the surface that owns this panel, even
  // if the global workbench scope has already moved on mid-switch.
  const targetScope = useCallback(() => scopeKey ?? $workbenchScope.get(), [scopeKey])

  // The account's home base is independent of a chat's explicitly chosen cwd.
  // Plain Hermes embeddings keep their existing Documents fallback.
  useEffect(() => {
    let active = true
    const changedAccount = filesAccount.current !== accountId
    filesAccount.current = accountId

    if (changedAccount) {
      requestId.current += 1; searchRequestId.current += 1
      setDirectory(''); setEntries([]); setRoots(null); setBack([]); setForward([])
      setSelectedPath(null); setQuery(''); setSearchResults(null); setLoading(true)
      setRenaming(null); setOpeningPath(null); setNotice(null)
      thumbnails.current.clear(); thumbnailMisses.current.clear()
    }

    if (!bridge) {
      setDirectory(cwd)
      setLoading(Boolean(cwd))

      return
    }

    void bridge
      .roots()
      .then(next => {
        if (!active) {return}
        setRoots(next)
        setDirectory(current => changedAccount ? next.workspace || next.documents || next.home : current || next.workspace || next.documents || next.home)
      })
      .catch(() => {
        if (active) {setLoading(false)}
      })

    return () => {
      active = false
    }
  }, [accountId, bridge, cwd])

  useEffect(() => {
    if (!directory) {
      requestId.current += 1
      setEntries([])
      setError(false)
      setLoading(false)

      return
    }

    const currentRequest = requestId.current + 1
    requestId.current = currentRequest
    setLoading(true)
    setError(false)

    const listing = bridge
      ? bridge.list(directory).then(result => ({ entries: result.entries, error: result.error }))
      : readDesktopDir(directory).then(result => ({ entries: legacyEntries(result.entries ?? []), error: result.error }))

    void listing
      .then(result => {
        if (requestId.current !== currentRequest) {return}

        if (result.error) {
          setEntries([])
          setError(true)
        } else {
          thumbnailMisses.current.clear()
          setEntries(consumerVisibleEntries(result.entries))
        }
      })
      .catch(() => {
        if (requestId.current === currentRequest) {
          setEntries([])
          setError(true)
        }
      })
      .finally(() => {
        if (requestId.current === currentRequest) {setLoading(false)}
      })
  }, [bridge, directory, reloadNonce])

  // Search: instant name filter of the open folder, then a bounded recursive
  // search below it once the query settles.
  useEffect(() => {
    const trimmed = query.trim()
    searchRequestId.current += 1
    const currentRequest = searchRequestId.current

    if (!trimmed || !bridge || !directory) {
      setSearchResults(null)
      setSearching(false)

      return
    }

    setSearching(true)

    const timer = window.setTimeout(() => {
      void bridge
        .search(directory, trimmed)
        .then(result => {
          if (searchRequestId.current === currentRequest) {
            setSearchResults({ entries: consumerVisibleEntries(result.entries), truncated: result.truncated })
          }
        })
        .catch(() => {
          if (searchRequestId.current === currentRequest) {setSearchResults(null)}
        })
        .finally(() => {
          if (searchRequestId.current === currentRequest) {setSearching(false)}
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [bridge, directory, query])

  const parent = useMemo(() => parentDirectory(directory), [directory])
  const trimmedQuery = query.trim().toLocaleLowerCase()

  const displayed = useMemo(() => {
    if (!trimmedQuery) {
      return sortConsumerEntries(entries, sort)
    }

    const source = searchResults?.entries ?? entries.filter(entry => entry.name.toLocaleLowerCase().includes(trimmedQuery))

    return sortConsumerEntries(source, sort)
  }, [entries, searchResults, sort, trimmedQuery])

  const places = useMemo(() => {
    const items: Array<{ icon: typeof Home; label: string; path: string }> = []

    if (roots) {
      if (roots.workspace) {items.push({ icon: FolderOpen, label: folderName(roots.workspace), path: roots.workspace })}
      items.push({ icon: Home, label: t.atum.workspace.filesHome, path: roots.home })

      if (roots.desktop) {items.push({ icon: DeviceDesktop, label: t.atum.workspace.filesDesktop, path: roots.desktop })}

      if (roots.documents) {items.push({ icon: FileText, label: t.atum.workspace.filesDocuments, path: roots.documents })}

      if (roots.downloads) {items.push({ icon: Download, label: t.atum.workspace.filesDownloads, path: roots.downloads })}
    }

    if (cwd && !items.some(item => item.path === cwd)) {
      items.push({ icon: FolderOpen, label: t.atum.workspace.filesWorkFolder, path: cwd })
    }

    return items
  }, [cwd, roots, t])

  const chooseView = (next: AtumFileView) => {
    setView(next)
    remember(VIEW_STORAGE_KEY, next)
  }

  const chooseSort = (key: AtumFileSortKey) => {
    setSort(current => {
      const next: SortState =
        current.key === key
          ? { direction: current.direction === 'asc' ? 'desc' : 'asc', key }
          : { direction: key === 'name' ? 'asc' : 'desc', key }

      remember(SORT_STORAGE_KEY, JSON.stringify(next))

      return next
    })
  }

  const enterDirectory = useCallback(
    (next: string, history: 'back' | 'forward' | 'push') => {
      // Plain setters only: an updater with side effects would double-push
      // history under StrictMode's deliberate re-invocation.
      if (history === 'push') {
        setBack(stack => [...stack, directory].filter(Boolean))
        setForward([])
      } else if (history === 'back') {
        setForward(stack => [directory, ...stack].filter(Boolean))
      } else {
        setBack(stack => [...stack, directory].filter(Boolean))
      }

      setDirectory(next)
      setQuery('')
      setSelectedPath(null)
      setRenaming(null)
      setNotice(null)
    },
    [directory]
  )

  const visitDirectory = useCallback(
    (next: string, history: 'back' | 'forward' | 'push' = 'push') => {
      if (!next || next === directory) {
        return
      }

      const enter = () => enterDirectory(next, history)

      if (PROTECTED_FOLDER.test(folderName(next)) && requestFileAccessPrePrompt(folderName(next), enter)) {
        return
      }

      enter()
    },
    [directory, enterDirectory]
  )

  const goBack = () => {
    const previous = back.at(-1)

    if (previous) {
      setBack(stack => stack.slice(0, -1))
      visitDirectory(previous, 'back')
    }
  }

  const goForward = () => {
    const next = forward[0]

    if (next) {
      setForward(stack => stack.slice(1))
      visitDirectory(next, 'forward')
    }
  }

  const goUp = () => {
    if (parent) {visitDirectory(parent)}
  }

  const reload = () => setReloadNonce(value => value + 1)

  const present = useCallback(
    (target: PreviewTarget, sourcePath: string) => {
      if (conversationId) {
        setAtumDmConversationPreviewTarget(conversationId, target)
      } else {
        setCurrentSessionPreviewTarget(target, 'file-browser', sourcePath)
      }
    },
    [conversationId]
  )

  const openEntry = useCallback(
    async (entry: AtumConsumerFileEntry) => {
      if (entry.isDirectory) {
        visitDirectory(entry.path)

        return
      }

      setOpeningPath(entry.path)
      setNotice(null)

      try {
        const scopeKey = targetScope()

        if (routesToWordCompanion(entry.path, Boolean(bridge), scopeKey)) {
          await openWordCompanion(entry.path, scopeKey)

          return
        }

        const nativeOffice = await tryOpenNativeOfficeDocument(entry.path, Boolean(bridge), scopeKey)

        if (nativeOffice === 'opened' || nativeOffice === 'stale') {return}

        if (nativeOffice === 'failed') {
          setNotice({ kind: 'error', text: t.atum.workspace.filesOpenError })

          return
        }

        if (bridge) {
          const result = await bridge.open(entry.path)

          if (result.kind === 'text') {
            // The lease is main-owned; the workbench renders the pane from the
            // opaque descriptor and releases it on close.
            const target = workspaceTextFileTarget(result.descriptor)
            trackWorkspaceTextFileTarget(target)
            revealWorkbenchTab(openPreviewWorkbenchTab(target, { restore: 'session', scopeKey: targetScope() }))

            if (result.imported) {
              setNotice({ kind: 'info', text: t.atum.workspace.importWordSuccess })
            }

            return
          }

          if (result.kind === 'image') {
            const base = localPreviewTarget(entry.path) ?? { kind: 'file' as const, label: entry.name, source: entry.path, url: entry.path }
            const target: PreviewTarget = { ...base, dataUrl: result.dataUrl, mimeType: result.mimeType, previewKind: 'image' }
            revealWorkbenchTab(openPreviewWorkbenchTab(target, { restore: 'session', scopeKey: targetScope() }))

            return
          }

          if (result.kind === 'card') {
            const target: PreviewTarget = { kind: 'file', label: entry.name, previewKind: 'card',
              source: entry.path, path: entry.path, url: `atum-card:${result.token}`, byteSize: result.size,
              contextFile: { token: result.token, size: result.size } }

            revealWorkbenchTab(openPreviewWorkbenchTab(target, { restore: 'session', scopeKey: targetScope() }))

            return
          }

          if (result.kind === 'pdf') {
            const target: PreviewTarget = {
              kind: 'file',
              label: entry.name,
              previewKind: 'pdf',
              contextFile: { token: result.token },
              source: entry.path,
              url: atumFileViewTargetUrl(result.token)
            }

            revealWorkbenchTab(openPreviewWorkbenchTab(target, { restore: 'session', scopeKey: targetScope() }))

            return
          }

          if (result.kind === 'native') {
            setNotice({ kind: 'info', text: t.atum.workspace.filesOpenedNative })

            return
          }

          if (result.kind === 'error') {
            setNotice({ kind: 'error', text: t.atum.workspace.filesOpenError })

            return
          }
        }

        const target = await normalizeOrLocalPreviewTarget(entry.path, directory)

        if (!target) {
          setNotice({ kind: 'error', text: t.atum.workspace.filesOpenError })

          return
        }

        present(target, entry.path)
      } catch {
        setNotice({ kind: 'error', text: t.atum.workspace.filesOpenError })
      } finally {
        setOpeningPath(null)
      }
    },
    [bridge, directory, present, t, targetScope, visitDirectory]
  )

  const openNative = async (entry: AtumConsumerFileEntry) => {
    const result = await bridge?.openNative(entry.path).catch(() => ({ ok: false }))
    setNotice(result?.ok ? { kind: 'info', text: t.atum.workspace.filesOpenedNative } : { kind: 'error', text: t.atum.workspace.filesOpenError })
  }

  const reveal = (entry: AtumConsumerFileEntry) => void bridge?.reveal(entry.path).catch(() => false)

  const startRename = (entry: AtumConsumerFileEntry) => {
    setSelectedPath(entry.path)
    setRenaming({ path: entry.path, value: entry.name })
  }

  const commitRename = async () => {
    if (!renaming || !bridge) {
      setRenaming(null)

      return
    }

    const name = renaming.value.trim()
    const current = renaming.path
    setRenaming(null)

    if (!name || name === folderName(current)) {
      return
    }

    try {
      const result = await bridge.rename(current, name)
      setSelectedPath(result.path)
      reload()
    } catch {
      setNotice({ kind: 'error', text: t.atum.workspace.filesRenameError })
    }
  }

  const trash = async (entry: AtumConsumerFileEntry) => {
    try {
      await bridge?.trash(entry.path)
      setSelectedPath(null)
      reload()
    } catch {
      setNotice({ kind: 'error', text: t.atum.workspace.filesTrashError })
    }
  }

  const createFolder = async () => {
    if (!bridge || !directory) {
      return
    }

    try {
      const created = await bridge.mkdir(directory, t.atum.workspace.filesNewFolderName)
      // Finder's move: the folder appears already in rename mode.
      setReloadNonce(value => value + 1)
      setSelectedPath(created.path)
      setRenaming({ path: created.path, value: folderName(created.path) })
    } catch {
      setNotice({ kind: 'error', text: t.atum.workspace.filesNewFolderError })
    }
  }

  const rememberMiss = (key: string) => {
    if (thumbnailMisses.current.size >= THUMBNAIL_CACHE_MAX) {
      thumbnailMisses.current.clear()
    }

    thumbnailMisses.current.add(key)
  }

  const requestThumbnail = useCallback(
    (entry: AtumConsumerFileEntry) => {
      const key = `${entry.path}@${entry.modifiedMs ?? 0}`

      if (!bridge || thumbnails.current.has(key) || thumbnailMisses.current.has(key)) {
        return
      }

      // Bounded cache: the oldest entries go first, and a miss is remembered
      // only until the folder is listed again.
      while (thumbnails.current.size >= THUMBNAIL_CACHE_MAX) {
        const oldest = thumbnails.current.keys().next().value

        if (oldest === undefined) {break}
        thumbnails.current.delete(oldest)
      }

      thumbnails.current.set(key, null)
      void bridge
        .thumbnail(entry.path, 96)
        .then(dataUrl => {
          // A request evicted while in flight stays evicted.
          if (!thumbnails.current.has(key)) {
            return
          }

          if (dataUrl) {
            thumbnails.current.set(key, dataUrl)
            setThumbnailNonce(value => value + 1)
          } else {
            thumbnails.current.delete(key)
            rememberMiss(key)
          }
        })
        .catch(() => {
          thumbnails.current.delete(key)
          rememberMiss(key)
        })
    },
    [bridge]
  )

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming || displayed.length === 0) {
      return
    }

    const index = displayed.findIndex(entry => entry.path === selectedPath)

    const select = (next: number) => {
      const entry = displayed[Math.max(0, Math.min(displayed.length - 1, next))]

      if (entry) {
        setSelectedPath(entry.path)
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(entry.path) : entry.path.replaceAll('"', '\\"')
        listRef.current?.querySelector<HTMLElement>(`[data-path="${escaped}"]`)?.focus()
      }
    }

    switch (event.key) {
      case 'ArrowDown':

      case 'ArrowRight':
        event.preventDefault()
        select(index + 1)

        break

      case 'ArrowUp':

      case 'ArrowLeft':
        event.preventDefault()
        select(index - 1)

        break

      case 'Home':
        event.preventDefault()
        select(0)

        break

      case 'End':
        event.preventDefault()
        select(displayed.length - 1)

        break
      case 'Enter': {
        const entry = displayed[index]

        if (entry) {
          event.preventDefault()
          void openEntry(entry)
        }

        break
      }

      case 'F2': {
        const entry = displayed[index]

        if (entry && bridge) {
          event.preventDefault()
          startRename(entry)
        }

        break
      }

      case 'Backspace':
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          goUp()
        }

        break

      case 'Escape':
        event.preventDefault()
        setSelectedPath(null)

        break

      default:
        break
    }
  }

  if (!directory) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <FolderOpen aria-hidden className="mx-auto size-7 text-(--atum-ink-faint)" />
          <p className="mt-3 text-[length:var(--atum-t-ui)] font-medium text-(--atum-ink)">
            {t.atum.workspace.filesNoBridge}
          </p>
        </div>
      </div>
    )
  }

  void thumbnailNonce
  const crumbs = breadcrumbSegments(directory)
  const totalBytes = displayed.reduce((total, entry) => total + (entry.isDirectory ? 0 : (entry.size ?? 0)), 0)
  const homeIndex = roots ? crumbs.findIndex(crumb => crumb.path === roots.home) : -1
  const visibleCrumbs = homeIndex >= 0 ? crumbs.slice(homeIndex) : crumbs
  const searchMode = Boolean(trimmedQuery)
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <section aria-busy={loading} aria-label={t.atum.workspace.tabFiles} className="flex h-full min-h-0 flex-col">
      {/* Mock 1a nav row: 40px, padding 0 20; ‹ › 24px; breadcrumb 13 with a
          ghost ›; grid/list segmented 26px on the right. */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-5 text-[0.8125rem] text-(--atum-ink-muted)" data-atum-files-nav>
        <Tip label={t.atum.workspace.filesBack}>
          <button aria-label={t.atum.workspace.filesBack} className="atum-icon-btn size-6 rounded-[0.375rem]" data-icon-only disabled={back.length === 0} onClick={goBack} type="button">
            <ArrowLeft className="size-4" />
          </button>
        </Tip>
        <Tip label={t.atum.workspace.filesForward}>
          <button aria-label={t.atum.workspace.filesForward} className="atum-icon-btn size-6 rounded-[0.375rem]" data-icon-only disabled={forward.length === 0} onClick={goForward} type="button">
            <ArrowRight className="size-4" />
          </button>
        </Tip>
        <Tip label={t.atum.workspace.filesUp}>
          <button aria-label={t.atum.workspace.filesUp} className="atum-icon-btn size-6 rounded-[0.375rem]" data-icon-only disabled={!parent} onClick={goUp} type="button">
            <ArrowUp className="size-4" />
          </button>
        </Tip>

        <nav aria-label={t.atum.workspace.filesRoot} className="ms-1.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {visibleCrumbs.map((crumb, index) => {
            const last = index === visibleCrumbs.length - 1
            const label = index === 0 && homeIndex >= 0 ? t.atum.workspace.filesHome : crumb.label

            return (
              <span className="flex shrink-0 items-center gap-1.5" key={crumb.path}>
                {index > 0 && <span aria-hidden className="text-(--atum-ink-ghost)">›</span>}
                <button
                  aria-current={last ? 'location' : undefined}
                  className={cn('max-w-40 truncate rounded-[0.375rem] px-1 py-0.5 hover:bg-(--atum-hover)', last ? 'font-medium text-(--atum-ink)' : 'text-(--atum-ink-muted)')}
                  onClick={() => visitDirectory(crumb.path)}
                  type="button"
                >
                  {label}
                </button>
              </span>
            )
          })}
        </nav>

        {bridge && !searchMode && (
          <Tip label={t.atum.workspace.filesNewFolder}>
            <button aria-label={t.atum.workspace.filesNewFolder} className="atum-icon-btn size-6 rounded-[0.375rem]" data-icon-only onClick={() => void createFolder()} type="button">
              <FolderPlus className="size-4" />
            </button>
          </Tip>
        )}
        <div aria-label={t.atum.workspace.filesView} className="flex h-[1.625rem] rounded-[0.4375rem] bg-(--atum-sunk) p-0.5" role="group">
          <Tip label={t.atum.workspace.filesGrid}>
            <button
              aria-label={t.atum.workspace.filesGrid}
              aria-pressed={view === 'grid'}
              className={cn('grid w-7 place-items-center rounded-[0.3125rem]', view === 'grid' ? 'bg-(--atum-bg-high) text-(--atum-ink) shadow-[0_1px_2px_rgba(23,25,31,0.1)]' : 'text-(--atum-ink-faint)')}
              data-icon-only
              onClick={() => chooseView('grid')}
              type="button"
            >
              <LayoutDashboard className="size-3.5" />
            </button>
          </Tip>
          <Tip label={t.atum.workspace.filesList}>
            <button
              aria-label={t.atum.workspace.filesList}
              aria-pressed={view === 'list'}
              className={cn('grid w-7 place-items-center rounded-[0.3125rem]', view === 'list' ? 'bg-(--atum-bg-high) text-(--atum-ink) shadow-[0_1px_2px_rgba(23,25,31,0.1)]' : 'text-(--atum-ink-faint)')}
              data-icon-only
              onClick={() => chooseView('list')}
              type="button"
            >
              <List className="size-3.5" />
            </button>
          </Tip>
        </div>
      </div>

      {/* Places and search are the app's own; the design draws one nav row, so
          this second row stays quiet: no hairlines, 36px, tokens only. */}
      <div className="flex h-9 shrink-0 items-center gap-2 px-5">
        <div aria-label={t.atum.workspace.filesPlaces} className="flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="group">
          {places.map(({ icon: Icon, label, path }) => (
            <button
              aria-pressed={directory === path}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-(length:--atum-t-caption) leading-(--atum-lh-body)',
                directory === path ? 'border-(--atum-line-strong) bg-(--atum-card) text-(--atum-ink)' : 'border-transparent bg-(--atum-sunk) text-(--atum-ink-muted) hover:bg-(--atum-hover)'
              )}
              key={path}
              onClick={() => visitDirectory(path)}
              type="button"
            >
              <Icon aria-hidden className="size-3.5" />
              <span className="max-w-28 truncate">{label}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto flex min-w-32 flex-1 items-center">
          <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-(--atum-ink-faint)" />
          <input
            aria-label={t.atum.workspace.filesSearch}
            className="h-7 w-full rounded-[var(--atum-r-sm)] border border-(--atum-line) bg-(--atum-card) pr-7 pl-7 text-(length:--atum-t-body) text-(--atum-ink) placeholder:text-(--atum-ink-faint) focus:border-(--atum-line-strong) focus:outline-none"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {setQuery('')}
            }}
            placeholder={t.atum.workspace.filesSearch}
            type="search"
            value={query}
          />
          {query && (
            <button
              aria-label={t.common.clear}
              className="absolute right-1.5 grid size-4 place-items-center rounded-full text-(--atum-ink-muted) hover:bg-(--atum-hover)"
              onClick={() => setQuery('')}
              type="button"
            >
              <X className="size-3" />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3" onKeyDown={onListKeyDown} ref={listRef}>
        {notice ? (
          <div
            className={cn(
              'mb-3 rounded-[var(--atum-r-row)] border bg-(--atum-card) px-3 py-2 text-(length:--atum-t-body) leading-(--atum-lh-body)',
              notice.kind === 'error' ? 'border-(--atum-line-strong) text-(--atum-ink-muted)' : 'border-(--atum-line) text-(--atum-ink-muted)'
            )}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </div>
        ) : null}
        {loading ? (
          <AtumFilesState>{t.atum.workspace.filesLoading}</AtumFilesState>
        ) : error ? (
          <AtumFilesState>
            <span>{t.atum.workspace.filesError}</span>
            <Button className="mt-3" onClick={reload} size="xs" variant="secondary">
              {t.atum.workspace.filesRetry}
            </Button>
          </AtumFilesState>
        ) : displayed.length === 0 ? (
          <AtumFilesState>{searchMode ? (searching ? t.atum.workspace.filesSearching : t.atum.workspace.filesNoResults) : t.atum.workspace.filesEmpty}</AtumFilesState>
        ) : (
          <>
            {view === 'list' && (
              <div className="mb-1 grid grid-cols-[minmax(0,1fr)_7.5rem_4.5rem] items-center gap-2 border-b border-(--atum-line) px-2 pb-1 text-[0.8125rem] text-(--atum-ink-muted)" role="row">
                <SortHeader active={sort} label={t.atum.workspace.filesColumnName} onSort={chooseSort} sortKey="name" />
                <SortHeader active={sort} label={t.atum.workspace.filesColumnModified} onSort={chooseSort} sortKey="modified" />
                <SortHeader active={sort} className="text-right" label={t.atum.workspace.filesColumnSize} onSort={chooseSort} sortKey="size" />
              </div>
            )}
            <div
              aria-label={t.atum.workspace.tabFiles}
              className={cn(view === 'grid' ? 'grid grid-cols-4 content-start gap-x-3 gap-y-[1.375rem] pb-3' : 'flex flex-col gap-px')}
              role="listbox"
            >
              {displayed.map((entry, index) => (
                <FileEntry
                  canManage={Boolean(bridge)}
                  dateFormat={dateFormat}
                  directory={directory}
                  entry={entry}
                  focusable={selectedPath ? selectedPath === entry.path : index === 0}
                  key={entry.path}
                  locale={locale}
                  onOpen={openEntry}
                  onOpenNative={openNative}
                  onRename={startRename}
                  onRenameCancel={() => setRenaming(null)}
                  onRenameChange={value => setRenaming(current => (current ? { ...current, value } : current))}
                  onRenameCommit={commitRename}
                  onReveal={reveal}
                  onSelect={setSelectedPath}
                  onTrash={trash}
                  onVisible={view === 'grid' ? requestThumbnail : undefined}
                  opening={openingPath === entry.path}
                  renaming={renaming?.path === entry.path ? renaming.value : null}
                  searchMode={searchMode}
                  selected={selectedPath === entry.path}
                  thumbnail={view === 'grid' ? (thumbnails.current.get(`${entry.path}@${entry.modifiedMs ?? 0}`) ?? null) : null}
                  view={view}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 px-5 text-(length:--atum-t-body) text-(--atum-ink-faint)" role="status">
        <span className="min-w-0 flex-1 truncate">
          {searchMode && searching
            ? t.atum.workspace.filesSearching
            : `${t.atum.workspace.filesItemCount(displayed.length)}${totalBytes > 0 ? ` · ${formatFileSize(totalBytes, locale)}` : ''}`}
        </span>
        {searchMode && searchResults?.truncated && <span className="min-w-0 truncate">{t.atum.workspace.filesSearchTruncated}</span>}
      </div>
    </section>
  )
}

function SortHeader({
  active,
  className,
  label,
  onSort,
  sortKey
}: {
  active: SortState
  className?: string
  label: string
  onSort: (key: AtumFileSortKey) => void
  sortKey: AtumFileSortKey
}) {
  const current = active.key === sortKey

  return (
    <button
      aria-sort={current ? (active.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('truncate text-left hover:text-(--atum-ink)', current && 'font-medium text-(--atum-ink)', className)}
      onClick={() => onSort(sortKey)}
      role="columnheader"
      type="button"
    >
      {label}
      {current ? (active.direction === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  )
}

function AtumFilesState({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full min-h-40 place-items-center px-4 text-center text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)">
      <div>{children}</div>
    </div>
  )
}

function relativeFolder(entryPath: string, directory: string): string {
  const parent = parentDirectory(entryPath) ?? ''
  const base = directory.replace(/[\\/]+$/u, '')

  if (parent === base) {
    return ''
  }

  return parent.startsWith(base) ? parent.slice(base.length).replace(/^[\\/]+/u, '') : parent
}

function FileEntry({
  canManage,
  dateFormat,
  directory,
  entry,
  focusable,
  locale,
  onOpen,
  onOpenNative,
  onRename,
  onRenameCancel,
  onRenameChange,
  onRenameCommit,
  onReveal,
  onSelect,
  onTrash,
  onVisible,
  opening,
  renaming,
  searchMode,
  selected,
  thumbnail,
  view
}: {
  canManage: boolean
  dateFormat: Intl.DateTimeFormat
  directory: string
  entry: AtumConsumerFileEntry
  focusable: boolean
  locale: string
  onOpen: (entry: AtumConsumerFileEntry) => void
  onOpenNative: (entry: AtumConsumerFileEntry) => void
  onRename: (entry: AtumConsumerFileEntry) => void
  onRenameCancel: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: () => void
  onReveal: (entry: AtumConsumerFileEntry) => void
  onSelect: (path: string) => void
  onTrash: (entry: AtumConsumerFileEntry) => void
  onVisible?: (entry: AtumConsumerFileEntry) => void
  opening: boolean
  renaming: null | string
  searchMode: boolean
  selected: boolean
  thumbnail: null | string
  view: AtumFileView
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  // Radix hands focus back to the row when the menu closes; a rename that the
  // menu just started must keep its input focused instead.
  const keepRenameFocus = useRef(false)
  const renameOpenedAt = useRef(0)
  const modified = entry.modifiedMs ? dateFormat.format(entry.modifiedMs) : '—'
  const folder = searchMode ? relativeFolder(entry.path, directory) : ''
  const tileRef = useRef<HTMLDivElement>(null)

  // Thumbnails load only for tiles that scroll into view; without an
  // observer (older engines, tests) the request is made straight away.
  useEffect(() => {
    if (!onVisible || entry.isDirectory) {
      return
    }

    const tile = tileRef.current

    if (!tile || typeof IntersectionObserver === 'undefined') {
      onVisible(entry)

      return
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(item => item.isIntersecting)) {
        onVisible(entry)
        observer.disconnect()
      }
    })

    observer.observe(tile)

    return () => observer.disconnect()
  }, [entry, onVisible])

  useEffect(() => {
    if (renaming !== null) {
      const input = inputRef.current
      renameOpenedAt.current = Date.now()
      input?.focus()
      // Select the stem only, the way Finder does.
      input?.setSelectionRange(0, entry.isDirectory ? entry.name.length : Math.max(0, entry.name.length - consumerFileExtension(entry.name).length))
    }
  }, [entry.isDirectory, entry.name, renaming])

  const nameNode =
    renaming !== null ? (
      <input
        aria-label={t.atum.workspace.filesRename}
        className="w-full rounded-[var(--atum-r-sm)] border border-(--atum-line-strong) bg-(--atum-card) px-1 py-0.5 text-(length:--atum-t-body) text-(--atum-ink) focus:outline-none"
        onBlur={() => {
          // The menu that started this rename restores focus as it closes;
          // that is not the person leaving the field.
          if (Date.now() - renameOpenedAt.current < 300) {
            requestAnimationFrame(() => inputRef.current?.focus())

            return
          }

          onRenameCommit()
        }}
        onChange={event => onRenameChange(event.target.value)}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()

          if (event.key === 'Enter') {
            event.preventDefault()
            onRenameCommit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onRenameCancel()
          }
        }}
        ref={inputRef}
        value={renaming}
      />
    ) : (
      <span className={cn('block break-words', view === 'grid' ? 'line-clamp-2 text-center' : 'truncate')}>{entry.name}</span>
    )

  const button = (
    <div
      aria-busy={opening}
      aria-label={entry.name}
      aria-selected={selected}
      className={cn(
        'group relative min-w-0 cursor-default rounded-[var(--atum-r-row)] outline-none select-none',
        view === 'grid' ? 'flex flex-col items-center gap-2 px-1 py-2' : 'grid h-8 grid-cols-[minmax(0,1fr)_7.5rem_4.5rem] items-center gap-2 px-2',
        selected ? 'bg-(--atum-hover)' : 'hover:bg-(--atum-sunk) focus-visible:bg-(--atum-sunk)',
        opening && 'opacity-60'
      )}
      data-path={entry.path}
      onClick={() => onSelect(entry.path)}
      onContextMenu={() => onSelect(entry.path)}
      onDoubleClick={() => onOpen(entry)}
      ref={tileRef}
      role="option"
      tabIndex={focusable ? 0 : -1}
    >
      {view === 'grid' ? (
        <>
          {thumbnail ? (
            <img alt="" className="h-16 w-[3.25rem] rounded-[0.4375rem] object-cover shadow-(--atum-shadow-tile)" data-file-thumbnail src={thumbnail} />
          ) : (
            <ConsumerFileGlyph isDirectory={entry.isDirectory} name={entry.name} />
          )}
          <div className="w-full min-w-0 text-center text-(length:--atum-t-body) leading-[1.3] text-(--atum-ink-soft)">{nameNode}</div>
          {folder && <span className="w-full truncate text-center text-(length:--atum-t-caption) text-(--atum-ink-faint)">{folder}</span>}
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[0.8125rem] leading-(--atum-lh-body) text-(--atum-ink)">
            <ConsumerFileIcon className="size-4 shrink-0" isDirectory={entry.isDirectory} name={entry.name} />
            <div className="min-w-0 flex-1">
              {nameNode}
              {folder && <span className="block truncate text-(length:--atum-t-caption) text-(--atum-ink-faint)">{folder}</span>}
            </div>
          </div>
          <span className="truncate text-[0.8125rem] text-(--atum-ink-muted)">{modified}</span>
          <span className="truncate text-right text-[0.8125rem] text-(--atum-ink-muted)">
            {entry.isDirectory ? t.atum.workspace.filesFolderKind : formatFileSize(entry.size, locale)}
          </span>
        </>
      )}
    </div>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-44"
        onCloseAutoFocus={event => {
          if (keepRenameFocus.current) {
            keepRenameFocus.current = false
            event.preventDefault()
          }
        }}
      >
        <ContextMenuItem onSelect={() => onOpen(entry)}>{t.atum.workspace.filesOpen}</ContextMenuItem>
        {canManage && !entry.isDirectory && (
          <ContextMenuItem onSelect={() => onOpenNative(entry)}>{t.atum.workspace.filesOpenNative}</ContextMenuItem>
        )}
        {canManage && <ContextMenuItem onSelect={() => onReveal(entry)}>{t.atum.workspace.filesReveal}</ContextMenuItem>}
        {canManage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => {
                keepRenameFocus.current = true
                onRename(entry)
              }}
            >
              {t.atum.workspace.filesRename}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onTrash(entry)}>{t.atum.workspace.filesTrash}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
