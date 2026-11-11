import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useStore } from '@nanostores/react'
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'

import { CodeEditor, type CodeEditorApi } from '@/components/chat/code-editor'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { documentCanvas } from '@/components/chat/document-canvas'
import {
  type ActiveFormats,
  activeFormats,
  insertLink,
  insertTable,
  markdownKeymap,
  setHeading,
  toggleBulletList,
  toggleCodeBlock,
  toggleEmphasis,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleStrong
} from '@/components/chat/markdown-commands'
import { markdownLive, markdownLiveTheme } from '@/components/chat/markdown-live'
import { MARKDOWN_TOOLBAR_KEYBINDS, MarkdownToolbar } from '@/components/chat/markdown-toolbar'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ArrowBackUp,
  Bold,
  Check,
  Code,
  Download,
  Italic,
  Link,
  List,
  ListNumbers,
  Palette,
  Pencil,
  Strikethrough,
  Table,
  X
} from '@/lib/icons'
import { comboFromEvent } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import {
  exportWorkspaceDocument,
  resolveWorkspaceDocumentTheme,
  revealWorkspaceDocumentExport,
  setWorkspaceDocumentTheme,
  shareWorkspaceDocumentExport,
  type WorkspaceDocumentExportFormat,
  type WorkspaceDocumentExportResult
} from '@/lib/workspace-document-export'
import { openWorkspaceTextFileLease, workspaceTextFileLeaseFromDescriptor } from '@/lib/workspace-text-file-lease'
import {
  $reviewsByScope,
  type AgentEditReview,
  deferReview,
  finishReview,
  markUndone,
  observeReviewRevision,
  openReviewFor,
  rememberReviewMode,
  setReviewError,
  setReviewPending
} from '@/store/agent-edits'
import {
  clearDocumentSelection,
  documentContextPathForTarget,
  setDocumentSelection,
  updateDocumentBuffer
} from '@/store/document-context'
import { $gateway } from '@/store/gateway'
import { $dirtyPreviewUrls, setPreviewDirty } from '@/store/preview-edit'
import { $currentCwd } from '@/store/session'
import { registerSurfaceReader } from '@/store/surface-capture'
import {
  $workspaceTextFileTabs,
  registerWorkspaceTextFileCloseGuard,
  removeWorkspaceTextFileTab,
  replaceWorkspaceTextFileTab,
  requestCloseWorkspaceTextFileTab,
  type WorkspaceTextFileTab
} from '@/store/workspace-text-files'

import type { AtumDocumentRecoveryDraft } from '../../../shared/atum-office/document-recovery'
import {
  DOCUMENT_THEME_IDS,
  documentThemeDefinition,
  type DocumentThemeId,
  type DocumentThemeSelection,
  type ResolvedDocumentTheme,
  resolveDocumentTheme
} from '../../../shared/atum-office/document-theme'

import { codeEditorDocumentController } from './document/code-editor-document-controller'
import { DocumentCommandBar } from './document/document-command-bar'
import type { RichDocumentCommand, RichDocumentEditorApi } from './document/document-editor-controller'
import { DocumentNavigation, documentWordCount } from './document/document-navigation'
import { documentNavigationController } from './document/document-navigation-controller'
import { persistDocumentSnapshot } from './document/document-persistence'
import { DocumentReadingView } from './document/document-reading-view'
import { DocumentStatusBar } from './document/document-status-bar'
import { paneMirror } from './pane-mirror'
import { MarkdownPreview } from './right-rail/preview-markdown'

type ViewMode = 'diff' | 'live' | 'rendered' | 'source'

const RichDocumentEditor = lazy(() =>
  import('./document/rich-document-editor').then(module => ({ default: module.RichDocumentEditor }))
)

type EditMode = 'live' | 'source'

// One pane-owned export operation state (Atum Office Phase 2). Save, undo,
// preserve, close and export are mutually exclusive through `exportBusy`.
type ExportState =
  | { kind: 'idle' }
  | { expectedRevision: string; format: WorkspaceDocumentExportFormat; kind: 'choosingDirtyAction' }
  | { format: WorkspaceDocumentExportFormat; kind: 'savingThenExporting' }
  | { format: WorkspaceDocumentExportFormat; kind: 'exporting' }
  | { kind: 'succeeded'; result: WorkspaceDocumentExportResult<WorkspaceDocumentExportFormat> }
  | { code: string; expectedRevision?: string; format: WorkspaceDocumentExportFormat; kind: 'failed' }

// Per document tab, session only: the edit surface the person last chose.
const editModeMemory = new Map<string, EditMode>()

export function resetDocumentEditModeMemory(): void {
  editModeMemory.clear()
}

const NO_FORMATS: ActiveFormats = {
  code: false,
  codeBlock: false,
  emphasis: false,
  heading: 0,
  link: false,
  list: false,
  orderedList: false,
  quote: false,
  strikethrough: false,
  strong: false
}

/** Keep the previous object when nothing changed so React can bail out of the update. */
function nextFormats(current: ActiveFormats, next: ActiveFormats): ActiveFormats {
  // Compared key by key so a new format cannot silently re-render forever.
  return (Object.keys(next) as Array<keyof ActiveFormats>).every(key => current[key] === next[key]) ? current : next
}

interface Snapshot {
  revision: string
  text: string
  truncated: boolean
}

function unifiedDraftDiff(disk: string, draft: string): string {
  const before = disk.split('\n')
  const after = draft.split('\n')

  return [
    '--- disk',
    '+++ draft',
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map(line => `-${line}`),
    ...after.map(line => `+${line}`)
  ].join('\n')
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  // Electron wraps invoke failures. Keep recovery branches on the same code
  // whether the boundary is native IPC or the unit-test bridge.
  return message.match(/\b(DOCUMENT_RECOVERY_[A-Z_]+)$/)?.[1] ?? message
}

function isStaleLease(error: unknown): boolean {
  const code = errorCode(error)

  return code.includes('CAPABILITY_REVOKED') || code.includes('CAPABILITY_STALE')
}

function ModeSwitcher({
  active,
  leading,
  modes,
  onSelect
}: {
  active: ViewMode
  leading?: React.ReactNode
  modes: ViewMode[]
  onSelect: (mode: ViewMode) => void
}) {
  const { t } = useI18n()

  const labels: Record<ViewMode, string> = {
    diff: t.preview.documentModeDiff,
    live: t.preview.documentModeLive,
    rendered: t.preview.documentModeRead,
    source: t.preview.documentModeSource
  }

  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-border/40 px-3">
      <div className="flex items-center gap-1">{leading}</div>
      <div className="flex items-center gap-3">
        {modes.map(mode => (
          <button
            className={cn(
              'text-[0.625rem] font-bold underline-offset-4 transition-colors',
              mode === active
                ? 'text-foreground underline decoration-current/30'
                : 'text-muted-foreground hover:text-foreground'
            )}
            key={mode}
            onClick={() => onSelect(mode)}
            type="button"
          >
            {labels[mode]}
          </button>
        ))}
      </div>
    </div>
  )
}

export function WorkspaceTextFileDirtyDot({ url }: { url: string }) {
  const dirty = useStore($dirtyPreviewUrls)
  const { t } = useI18n()

  return dirty[url] ? <span aria-label={t.preview.unsavedChanges} className="size-2 rounded-full bg-amber-500" /> : null
}

interface WorkspaceTextFilePaneProps {
  reopenDocument?: () => Promise<void>
  scopeKey?: string
  tab: WorkspaceTextFileTab
}

export function WorkspaceTextFilePane(props: WorkspaceTextFilePaneProps) {
  // Rebinding a lease starts a fresh controller. Late completions from the old
  // authority cannot acknowledge, restore or clear the new document's state.
  return <WorkspaceTextFilePaneContent key={props.tab.target.workspaceTextFile.fileRef} {...props} />
}

function WorkspaceTextFilePaneContent({ reopenDocument, scopeKey, tab }: WorkspaceTextFilePaneProps) {
  const { t } = useI18n()
  const descriptor = tab.target.workspaceTextFile
  // Subscribed for re-render; the lookup itself resolves the chat scope lazily.
  useStore($reviewsByScope)
  const effectiveScopeKey = scopeKey ?? 'session'
  const restorePath = descriptor.workspaceRelativePath ?? ''
  const review = restorePath ? openReviewFor(effectiveScopeKey, restorePath) : null

  const lease = useMemo(() => workspaceTextFileLeaseFromDescriptor(descriptor), [descriptor])
  // Composer auto-context (Atum Office Phase 0) keys selections by this path.
  const contextPath = documentContextPathForTarget(tab.target, useStore($currentCwd))
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [externalSnapshot, setExternalSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>(tab.target.language === 'markdown' ? 'rendered' : 'source')
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const [preservedName, setPreservedName] = useState<string | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [liveTooLarge, setLiveTooLarge] = useState(false)
  // The canvas renders the same resolved theme the export pins; default until resolved.
  const [theme, setTheme] = useState<ResolvedDocumentTheme>(() => resolveDocumentTheme(null))
  // A hovered or focused picker entry previews on the canvas; closing the
  // picker without choosing drops the preview and the committed theme returns.
  const [themePreview, setThemePreview] = useState<ResolvedDocumentTheme | null>(null)
  const [themeNotice, setThemeNotice] = useState<string | null>(null)
  // The canvas has its own compartment so a preview restyles the sheet without
  // rebuilding the live-Markdown decorations that share the presentation array.
  const canvasConf = useRef(new Compartment())
  // Seeds the compartment on mount; every later change, committed or previewed,
  // is a reconfigure of that compartment alone.
  const seedThemeRef = useRef(theme)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [navigationFocusRequest, setNavigationFocusRequest] = useState(0)
  const [navigation, setNavigation] = useState<'outline' | 'find' | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)

  const handleCompositionChange = (value: boolean) => {
    composingRef.current = value
    setComposing(value)
  }

  const [historyState, setHistoryState] = useState({ undo: false, redo: false })
  const [formats, setFormats] = useState<ActiveFormats>(NO_FORMATS)
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' })
  const mountedRef = useRef(true)
  const operationBusyRef = useRef(false)
  const editorApiRef = useRef<CodeEditorApi | null>(null)
  const richEditorApiRef = useRef<RichDocumentEditorApi | null>(null)
  const documentController = useMemo(() => codeEditorDocumentController(() => editorApiRef.current), [])
  const [richEligible, setRichEligible] = useState<boolean | null>(null)
  const [richNotice, setRichNotice] = useState(false)
  const [canPastePlain, setCanPastePlain] = useState(false)
  const [pasteNotice, setPasteNotice] = useState<'refused' | 'simplified' | null>(null)
  const [inTable, setInTable] = useState(false)
  const [linkEditing, setLinkEditing] = useState(false)
  const [linkHref, setLinkHref] = useState('https://')
  const richActiveRef = useRef(false)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  const activeModeRef = useRef<ViewMode>('source')

  const navigationApi = useMemo(() => documentNavigationController(
    () => editorApiRef.current, () => richEditorApiRef.current, () => richActiveRef.current,
    () => !operationBusyRef.current && !composingRef.current && (activeModeRef.current === 'live' || activeModeRef.current === 'source')
  ), [])

  const isMarkdownDocument = tab.target.language === 'markdown'

  const liveDescriptionId = useId()

  // One extension instance per pane so the compartment is not reconfigured on
  // every render. Everything that makes the live surface look like prose lives
  // here (wrapping, no gutter, padding, the assistive description) so the
  // editor's host DOM never changes between Soạn thảo and Nguồn.
  const isWorkspaceDocument = isMarkdownDocument && Boolean(descriptor.workspaceRelativePath)
  const journalRevisionRef = useRef<string | null>(null)
  const [recoveryDraft, setRecoveryDraft] = useState<AtumDocumentRecoveryDraft | null>(null)
  const [recoveryReady, setRecoveryReady] = useState(!isWorkspaceDocument || !lease.recovery)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const continuousSave = isWorkspaceDocument && Boolean(lease.recovery) && recoveryReady && !recoveryFailed

  const loadRecovery = async () => {
    if (!isWorkspaceDocument || !lease.recovery) {
      return
    }

    try {
      const result = await lease.recovery.read()

      if (!mountedRef.current) {
        return
      }

      journalRevisionRef.current = result.record?.draftRevision ?? null
      setRecoveryDraft(result.record)
      setRecoveryReady(true)
      setRecoveryFailed(false)
    } catch {
      if (mountedRef.current) {
        setRecoveryFailed(true)
        setRecoveryReady(true)
      }
    }
  }

  useEffect(() => {
    void loadRecovery()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each lease owns one recovery read
  }, [lease])

  const livePresentation = useMemo(
    () => [
      markdownLive({ onGuard: (guard: { tooLarge: boolean }) => setLiveTooLarge(guard.tooLarge) }),
      markdownLiveTheme,
      EditorView.lineWrapping,
      EditorView.theme({ '.cm-content': { padding: '0.5rem 0.75rem' }, '.cm-gutters': { display: 'none' } }),
      // Workspace documents get the paper canvas; other Markdown keeps the plain
      // live surface. Swapping this array through the presentation compartment
      // restyles a mounted editor without remounting it or touching the buffer.
      ...(isWorkspaceDocument ? [canvasConf.current.of(documentCanvas(seedThemeRef.current))] : []),
      EditorView.contentAttributes.of({ 'aria-describedby': liveDescriptionId })
    ],
    [liveDescriptionId, isWorkspaceDocument]
  )

  useEffect(() => {
    if (!isWorkspaceDocument) {
      return
    }

    let active = true
    // A new lease starts from the default so the previous document's theme
    // cannot linger while its own resolves.
    setTheme(resolveDocumentTheme(null))
    void resolveWorkspaceDocumentTheme(descriptor.fileRef).then(resolved => {
      if (active) {
        setTheme(resolved)
      }
    })

    return () => {
      active = false
    }
  }, [descriptor.fileRef, isWorkspaceDocument])

  const canvasTheme = themePreview ?? theme

  useEffect(() => {
    if (!isWorkspaceDocument) {
      return
    }

    seedThemeRef.current = canvasTheme
    editorApiRef.current?.dispatchCommand(view => {
      view.dispatch({ effects: canvasConf.current.reconfigure(documentCanvas(canvasTheme, zoom)) })

      return true
    })
    // editorGeneration, editing and mode are deliberate: a remounted editor
    // must receive the current canvas, not only the one it was seeded with.
  }, [canvasTheme, isWorkspaceDocument, editorGeneration, editing, mode, zoom])

  /** The stored override, or null for the theme's own size. Never coerced to a menu step. */
  const themeBodyOverride = (value: ResolvedDocumentTheme): number | null =>
    value.bodySizePt === documentThemeDefinition(value.id).bodySizePt ? null : value.bodySizePt

  const themeBodyChoice = (value: ResolvedDocumentTheme): 'default' | '13' | '16' | 'custom' => {
    const override = themeBodyOverride(value)

    return override === null ? 'default' : override === 13 ? '13' : override === 16 ? '16' : 'custom'
  }

  const themeSelection = (
    id: DocumentThemeId,
    pageSize: 'a4' | 'letter',
    bodySizePt: number | null
  ): DocumentThemeSelection => {
    const base = documentThemeDefinition(id)

    const overrides = {
      ...(pageSize !== base.pageSize ? { pageSize } : {}),
      ...(bodySizePt === null ? {} : { bodySizePt })
    }

    return Object.keys(overrides).length > 0 ? { overrides, themeId: id } : { themeId: id }
  }

  const previewTheme = (selection: DocumentThemeSelection) =>
    setThemePreview(resolveDocumentTheme(selection, theme.revision))

  const applyTheme = async (selection: DocumentThemeSelection | null) => {
    setThemePreview(null)

    try {
      const result = await setWorkspaceDocumentTheme(descriptor.fileRef, selection)
      setTheme(result.theme)
      setThemeNotice(result.persisted ? null : t.preview.themeSaveFailed)
    } catch {
      setThemeNotice(t.preview.themeSaveFailed)
    }
  }

  const themeName = (id: DocumentThemeId): string =>
    ({
      book: t.preview.themeNameBook,
      manuscript: t.preview.themeNameManuscript,
      modern: t.preview.themeNameModern,
      note: t.preview.themeNameNote,
      report: t.preview.themeNameReport
    })[id]

  // Refresh the toolbar's pressed state only when live mode is entered (the
  // selection callback keeps it current afterwards). Formats are compared by
  // value: a fresh object on every render would re-render forever.
  useEffect(() => {
    if (!editing || activeModeRef.current !== 'live') {
      return
    }

    const state = editorApiRef.current?.getState()
    setFormats(current => nextFormats(current, state ? activeFormats(state) : NO_FORMATS))
  }, [editing, mode])

  const draftRef = useRef('')
  const dirtyRef = useRef(false)
  const snapshotRef = useRef<Snapshot | null>(null)
  const readRequestRef = useRef(0)
  const deferredWatchRef = useRef(false)
  const refreshFromDiskRef = useRef<(() => void) | null>(null)
  const savingRef = useRef(false)
  const undoPendingRef = useRef(new Set<string>())
  const reviewWatchRef = useRef<{ key: string; captured: boolean } | null>(null)

  dirtyRef.current = dirty
  snapshotRef.current = snapshot

  useEffect(() => {
    if (!contextPath) {return}

    return registerSurfaceReader(effectiveScopeKey, contextPath, () => {
      const current = snapshotRef.current

      if (!current) {return null}

      // Rich/read views retain CodeMirror for canonical history, not its viewport.
      // Without a mapped selection, capture the bounded canonical buffer instead.
      const sourceVisible = editing && !richActiveRef.current && (activeModeRef.current === 'source' || activeModeRef.current === 'live')

      return { excerpt: sourceVisible ? editorApiRef.current?.getVisibleText?.() : undefined, text: editing ? draftRef.current : current.text, dirty: dirtyRef.current,
        revision: current.revision, truncated: current.truncated }
    })
  }, [contextPath, effectiveScopeKey, editing])

  useEffect(() => {
    let active = true

    const acceptSnapshot = (next: Snapshot, fromWatch: boolean, request: number) => {
      if (!active || request !== readRequestRef.current) {
        return
      }

      if (
        fromWatch &&
        (dirtyRef.current || composingRef.current) &&
        snapshotRef.current &&
        next.revision !== snapshotRef.current.revision
      ) {
        setExternalSnapshot(next)
        setConflict(true)
        setLoading(false)

        return
      }

      // A clean pane follows disk: documents now open straight into the
      // editor, so a watched revision has to refresh the buffer the same way
      // the read surface re-rendered before (a dirty draft is handled above).
      if (fromWatch && !dirtyRef.current && snapshotRef.current && snapshotRef.current.text !== next.text) {
        draftRef.current = next.text
        setEditorGeneration(value => value + 1)
      }

      setSnapshot(next)
      setExternalSnapshot(null)
      setConflict(false)
      setError(null)
      setLoading(false)

      if (fromWatch && restorePath) {
        const currentReview = openReviewFor(effectiveScopeKey, restorePath)
        const key = currentReview ? `${currentReview.turnId}:${currentReview.sequence}` : ''

        if (currentReview && reviewWatchRef.current?.key === key && !reviewWatchRef.current.captured) {
          reviewWatchRef.current.captured = true
          observeReviewRevision(currentReview, next.revision, true)
        }
      }
    }

    const read = async (fromWatch = false) => {
      if (savingRef.current) {
        deferredWatchRef.current = true

        return
      }

      const request = ++readRequestRef.current

      try {
        acceptSnapshot(await lease.read(), fromWatch, request)
      } catch (readError) {
        if (active && request === readRequestRef.current) {
          setError(errorCode(readError))
          setLoading(false)
        }
      }
    }

    refreshFromDiskRef.current = () => void read(true)
    void read()
    const unwatch = lease.watch(() => void read(true))

    return () => {
      active = false
      refreshFromDiskRef.current = null
      unwatch()
    }
  }, [effectiveScopeKey, lease, restorePath])

  useEffect(() => {
    if (!review || !snapshot) {
      return
    }

    const key = `${review.turnId}:${review.sequence}`

    if (reviewWatchRef.current?.key !== key) {
      reviewWatchRef.current = { key, captured: false }
    }

    observeReviewRevision(review, snapshot.revision)
  }, [review, snapshot])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setPreviewDirty(tab.target.url, dirty || composing)

    return () => setPreviewDirty(tab.target.url, false)
  }, [dirty, composing, tab.target.url])

  useEffect(
    () =>
      registerWorkspaceTextFileCloseGuard(descriptor.fileRef, () => {
        if (operationBusyRef.current || composingRef.current) {
          return false
        }

        if (!dirtyRef.current) {
          return true
        }

        setCloseRequested(true)

        return false
      }),
    [descriptor.fileRef]
  )

  const beginEdit = () => {
    draftRef.current = snapshot?.text ?? ''
    setDirty(false)
    setEditing(true)
    setRichEligible(null)
    // Markdown documents open in the live surface unless the person chose
    // Nguồn for this tab earlier in the session; plain text has nothing to decorate.
    setMode(isMarkdownDocument && !liveTooLarge ? (editModeMemory.get(descriptor.fileRef) ?? 'live') : 'source')
    setEditorGeneration(value => value + 1)
    setPreservedName(null)
  }

  // A workspace document starts in edit mode once the lease read has succeeded
  // (never on a phantom tab).
  const autoEditedRef = useRef(false)

  useEffect(() => {
    // Owner decision (2026-09-03): a workspace document opens ready to write,
    // not in read mode — Xem stays one click away in the mode switcher.
    if (!snapshot || editing || autoEditedRef.current || !descriptor.workspaceRelativePath) {
      return
    }

    autoEditedRef.current = true
    beginEdit()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beginEdit is a stable per-render closure over refs
  }, [snapshot, editing, descriptor.workspaceRelativePath])

  const save = async (options: { stayInEditor?: boolean } = {}): Promise<string | null> => {
    const base = snapshotRef.current

    if (
      !base ||
      base.truncated ||
      savingRef.current ||
      !dirtyRef.current ||
      recoveryDraft ||
      !recoveryReady ||
      composing
    ) {
      return null
    }

    // Snapshot all mutable values before either asynchronous boundary.
    const write = {
      text: draftRef.current,
      baseRevision: base.revision,
      editorRevision: String(draftVersion),
      expectedDraftRevision: journalRevisionRef.current
    }

    setSaving(true)
    savingRef.current = true
    readRequestRef.current += 1
    setError(null)

    try {
      const result =
        isWorkspaceDocument && !recoveryFailed
          ? await persistDocumentSnapshot(
              lease,
              write,
              revision => {
                journalRevisionRef.current = revision
              },
              () => {
                if (mountedRef.current) {
                  setRecoveryFailed(true)
                }
              }
            )
          : { ...(await lease.write({ expectedRevision: write.baseRevision, text: write.text })), draftRevision: null }

      if (!mountedRef.current) {
        return result.revision
      }

      const next = { revision: result.revision, text: write.text, truncated: false }
      snapshotRef.current = next
      setSnapshot(next)
      const stillDirty = draftRef.current !== write.text
      dirtyRef.current = stillDirty
      setDirty(stillDirty)
      setExternalSnapshot(null)
      setConflict(false)

      // Discard only the captured acknowledged journal. A later journal must
      // survive a delayed completion from this write.
      if (result.draftRevision && lease.recovery) {
        try {
          const discarded = await lease.recovery.discard(result.draftRevision)

          if (discarded.outcome === 'stale') {
            setRecoveryDraft(discarded.record)
            journalRevisionRef.current = discarded.record.draftRevision
          } else if (journalRevisionRef.current === result.draftRevision) {
            journalRevisionRef.current = null
          }
        } catch {
          // An unlink can succeed before its acknowledgement fails. Re-read
          // rather than retaining a revision which no longer exists.
          try {
            const recovery = await lease.recovery.read()
            journalRevisionRef.current = recovery.record?.draftRevision ?? null

            if (recovery.record && recovery.record.draftRevision !== result.draftRevision) {
              setRecoveryDraft(recovery.record)
            }
          } catch {
            if (mountedRef.current) {
              setRecoveryFailed(true)
            }
          }
        }
      }

      if (!options.stayInEditor && !continuousSave && !stillDirty) {
        setNavigation(null)
        setEditing(false)
      }

      return result.revision
    } catch (writeError) {
      if (!mountedRef.current) {
        return null
      }

      if (errorCode(writeError) === 'DOCUMENT_RECOVERY_CORRUPT') {
        // Do not write automatically through corrupt recovery. Let the user
        // explicitly save the still-dirty buffer via the normal file fence.
        setRecoveryFailed(true)
      }

      if (errorCode(writeError).includes('WORKSPACE_CONFLICT')) {
        setConflict(true)
      } else {
        setError(errorCode(writeError))
      }
    } finally {
      savingRef.current = false

      if (mountedRef.current) {
        setSaving(false)
      }

      if (deferredWatchRef.current) {
        deferredWatchRef.current = false
        refreshFromDiskRef.current?.()
      }
    }

    return null
  }

  const countedText = editing ? draftRef.current : (snapshot?.text ?? '')
  const wordCount = useMemo(() => documentWordCount(countedText), [countedText])

  const saveLatestRef = useRef(save)
  saveLatestRef.current = save
  useEffect(() => {
    if (
      !continuousSave ||
      !dirty ||
      saving ||
      composing ||
      conflict ||
      error ||
      recoveryDraft ||
      closeRequested ||
      review?.pending ||
      review?.settled === false ||
      exportState.kind === 'exporting' ||
      exportState.kind === 'savingThenExporting'
    ) {
      return
    }

    const timer = setTimeout(() => void saveLatestRef.current({ stayInEditor: true }), 750)

    return () => clearTimeout(timer)
  }, [
    continuousSave,
    dirty,
    draftVersion,
    saving,
    composing,
    conflict,
    error,
    recoveryDraft,
    closeRequested,
    review?.pending,
    review?.settled,
    exportState.kind
  ])

  const discardRecovery = async (): Promise<boolean> => {
    if (!lease.recovery || !journalRevisionRef.current) {
      setRecoveryDraft(null)

      return true
    }

    try {
      const result = await lease.recovery.discard(journalRevisionRef.current)

      if (result.outcome === 'stale') {
        journalRevisionRef.current = result.record.draftRevision
        setRecoveryDraft(result.record)
        setError('DOCUMENT_RECOVERY_CONFLICT')

        return false
      }

      journalRevisionRef.current = null
      setRecoveryDraft(null)

      return true
    } catch (failure) {
      setError(errorCode(failure))

      return false
    }
  }

  const restoreRecovery = () => {
    if (!recoveryDraft || !snapshot) {
      return
    }

    draftRef.current = recoveryDraft.text
    dirtyRef.current = recoveryDraft.text !== snapshot.text
    setDirty(dirtyRef.current)
    setEditing(true)
    setMode(liveTooLarge ? 'source' : 'live')
    setEditorGeneration(value => value + 1)
    setDraftVersion(value => value + 1)

    if (recoveryDraft.baseRevision !== snapshot.revision && dirtyRef.current) {
      setConflict(true)
    }

    setRecoveryDraft(null)

    if (contextPath) {
      updateDocumentBuffer(contextPath, draftRef.current)
    }
  }

  const preserveDraft = async () => {
    if (exportBusy) {
      return
    }

    if (!snapshot || saving) {
      return
    }

    setSaving(true)
    savingRef.current = true
    readRequestRef.current += 1
    setError(null)

    const preservedText = draftRef.current

    try {
      const result = await lease.preserveSibling({ expectedRevision: snapshot.revision, text: preservedText })

      if (draftRef.current !== preservedText) {
        setPreservedName(result.displayName)

        return
      }

      if (!(await discardRecovery())) {
        return
      }

      setPreservedName(result.displayName)
      setDirty(false)

      if (closeRequested) {
        await removeWorkspaceTextFileTab(descriptor.fileRef, true)
      } else {
        if (externalSnapshot) {
          setSnapshot(externalSnapshot)
        }

        setExternalSnapshot(null)
        setConflict(false)
        setNavigation(null)
        setEditing(false)
      }
    } catch (preserveError) {
      setError(errorCode(preserveError))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const discardAndReload = async (): Promise<boolean> => {
    if (!(await discardRecovery())) {
      return false
    }

    if (exportBusy) {
      return false
    }

    const next = externalSnapshot ?? snapshot

    if (next) {
      setSnapshot(next)
      draftRef.current = next.text
    }

    setExternalSnapshot(null)
    setConflict(false)
    setCloseRequested(false)
    setDirty(false)
    setNavigation(null)
    setEditing(false)

    return true
  }

  const discardAndClose = async () => {
    if (!(await discardRecovery())) {
      return
    }

    if (exportBusy) {
      return
    }

    setDirty(false)
    await removeWorkspaceTextFileTab(descriptor.fileRef, true)
  }

  const cancelEdit = async () => {
    if (!(await discardRecovery())) {
      return
    }

    if (exportBusy) {
      return
    }

    if (contextPath) {
      clearDocumentSelection(undefined, contextPath)
    }

    setDirty(false)
    setConflict(false)
    setCloseRequested(false)
    setExternalSnapshot(null)
    setNavigation(null)
    setEditing(false)
  }

  const reopen = async () => {
    if (reopenDocument) {
      await reopenDocument()

      return
    }

    const replacement = await openWorkspaceTextFileLease()

    if (replacement) {
      await replaceWorkspaceTextFileTab(descriptor.fileRef, replacement)
    }
  }

  const exportBusy = exportState.kind === 'exporting' || exportState.kind === 'savingThenExporting'

  // Save, undo, preserve, close and export are mutually exclusive.
  const operationBusy =
    composing || saving || exportBusy || !recoveryReady || Boolean(recoveryDraft) || Boolean(snapshot?.truncated)

  operationBusyRef.current = operationBusy

  const canExport =
    isMarkdownDocument &&
    Boolean(descriptor.workspaceRelativePath) &&
    Boolean(snapshot) &&
    !loading &&
    !saving &&
    !exportBusy &&
    !review?.pending

  const runExport = async (format: WorkspaceDocumentExportFormat, expectedRevision?: string) => {
    setExportState({ format, kind: 'exporting' })

    try {
      const result = await exportWorkspaceDocument(descriptor.fileRef, format, expectedRevision)

      if (mountedRef.current) {
        setExportState({ kind: 'succeeded', result })
      }
    } catch (exportError) {
      if (mountedRef.current) {
        setExportState({ code: errorCode(exportError), expectedRevision, format, kind: 'failed' })
      }
    }
  }

  const requestExport = (format: WorkspaceDocumentExportFormat) => {
    if (!canExport) {
      return
    }

    if (dirty) {
      // Pin the disk revision shown now; "export the saved version" must mean this one.
      setExportState({ expectedRevision: snapshot?.revision ?? '', format, kind: 'choosingDirtyAction' })

      return
    }

    void runExport(format)
  }

  const saveThenExport = async (format: WorkspaceDocumentExportFormat) => {
    setExportState({ format, kind: 'savingThenExporting' })
    const revision = await save({ stayInEditor: true })

    if (!mountedRef.current) {
      return
    }

    if (!revision) {
      // save() already surfaced its conflict or error strip.
      setExportState({ kind: 'idle' })

      return
    }

    await runExport(format)
  }

  const revealExport = async (result: WorkspaceDocumentExportResult<WorkspaceDocumentExportFormat>) => {
    try {
      await revealWorkspaceDocumentExport(result.exportRef)
    } catch (revealError) {
      if (mountedRef.current) {
        setExportState({ code: errorCode(revealError), format: result.format, kind: 'failed' })
      }
    }
  }

  const shareExport = async (result: WorkspaceDocumentExportResult<WorkspaceDocumentExportFormat>) => {
    try {
      await shareWorkspaceDocumentExport(result.exportRef)
    } catch (shareError) {
      if (mountedRef.current) {
        setExportState({ code: errorCode(shareError), format: result.format, kind: 'failed' })
      }
    }
  }

  const exportReason = (code: string) =>
    code.includes('EXPORT_TOO_LARGE')
      ? t.preview.exportReasonTooLarge
      : code.includes('EXPORT_SOURCE_CHANGED') || code.includes('EXPORT_THEME_CHANGED')
        ? t.preview.exportReasonChanged
        : code.includes('EXPORT_NOT_WORKSPACE_DOCUMENT')
          ? t.preview.exportReasonNotWorkspace
          : t.preview.exportReasonGeneric

  const previousMode = review?.previousMode ?? mode
  const revisionChanged = Boolean(review?.afterRevision && snapshot?.revision !== review.afterRevision)

  const undoReason = !review?.settled
    ? t.preview.agentReviewUndoUnsettled
    : review.pending || exportBusy
      ? t.preview.agentReviewPending
      : dirty
        ? t.preview.agentReviewUndoDirty
        : revisionChanged
          ? t.preview.agentReviewUndoChanged
          : ''

  const showAgentDiff = () => {
    if (!review) {
      return
    }

    rememberReviewMode(review, mode)
    setMode('diff')
  }

  const doneReview = () => {
    if (!review || review.pending) {
      return
    }

    finishReview(review)
    setMode(previousMode)
  }

  const undoReview = async (target: AgentEditReview, options?: { allowDirty?: boolean; revision?: string }) => {
    const pendingKey = `${target.scopeKey}:${target.restorePath}:${target.turnId}`

    if (
      undoPendingRef.current.has(pendingKey) ||
      target.pending ||
      !target.settled ||
      (!options?.allowDirty && dirtyRef.current)
    ) {
      return
    }

    const comparedRevision = options?.revision ?? snapshotRef.current?.revision

    if (target.afterRevision && comparedRevision !== target.afterRevision) {
      return
    }

    if (!target.checkpoint || !target.restoreAvailable) {
      return
    }

    undoPendingRef.current.add(pendingKey)
    setReviewPending(target, 'undo')
    setReviewError(target)

    try {
      const gateway = $gateway.get()

      if (!gateway) {
        throw new Error(t.preview.agentReviewDisconnected)
      }

      const result = await gateway.request<{ success: boolean; error?: string }>('rollback.restore', {
        session_id: target.sessionId,
        hash: target.checkpoint.hash,
        file_path: target.restorePath
      })

      if (!result.success) {
        throw new Error(result.error || t.preview.agentReviewRestoreFailed)
      }

      markUndone(target)
      setDirty(false)
      setNavigation(null)
      setEditing(false)
      setMode(target.previousMode ?? mode)
    } catch (restoreError) {
      setReviewPending(target, null)
      setReviewError(target, errorCode(restoreError))
    } finally {
      undoPendingRef.current.delete(pendingKey)
    }
  }

  const saveDraftForReview = async () => {
    if (!review || review.pending) {
      return
    }

    setReviewPending(review, 'save')
    const revision = await save()
    setReviewPending(review, null)

    if (revision) {
      observeReviewRevision(review, revision, true)
    }
  }

  const discardDraftAndUndo = async () => {
    if (!review) {
      return
    }

    const revision = externalSnapshot?.revision ?? snapshot?.revision

    if (!revision) {
      return
    }

    if (!(await discardAndReload())) {
      return
    }

    observeReviewRevision(review, revision, true)
    await undoReview({ ...review, afterRevision: revision }, { allowDirty: true, revision })
  }

  if (loading) {
    return <PageLoader label={t.preview.loading} />
  }

  if (error && isStaleLease(error) && !snapshot) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="grid max-w-sm gap-3">
          <div className="text-sm font-semibold">{t.preview.workspaceLeaseStaleTitle}</div>
          <div className="text-xs text-muted-foreground">{t.preview.workspaceLeaseStaleBody}</div>
          <button
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            onClick={() => void reopen()}
            type="button"
          >
            {t.preview.reopenTextFile}
          </button>
        </div>
      </div>
    )
  }

  if (!snapshot) {
    return <div className="p-4 text-xs text-destructive">{error || t.preview.unavailable}</div>
  }

  const isMarkdown = tab.target.language === 'markdown'
  const diskText = externalSnapshot?.text ?? snapshot.text
  const draftDiff = dirty ? unifiedDraftDiff(diskText, draftRef.current) : ''
  const diff = review ? (review.diff ?? '') : draftDiff

  const modes: ViewMode[] = [
    // Editing a Markdown document offers Soạn thảo (live), Xem (the draft rendered) and Nguồn.
    ...(editing && isMarkdown && !liveTooLarge ? (['live'] as const) : []),
    ...(isMarkdown ? (['rendered'] as const) : []),
    'source',
    ...(review || diff ? (['diff'] as const) : [])
  ]

  const activeMode = modes.includes(mode) ? mode : 'source'
  const richActive = isWorkspaceDocument && activeMode === 'live' && richEligible === true
  richActiveRef.current = richActive
  activeModeRef.current = activeMode
  const editorVisible = editing && (activeMode === 'source' || activeMode === 'live')

  const selectMode = (next: ViewMode) => {
    if (operationBusyRef.current || composingRef.current) {
      return
    }

    if (next === 'rendered' || next === 'diff') { setNavigation(null) }

    if (editing && (next === 'live' || next === 'source')) {
      editModeMemory.set(descriptor.fileRef, next)
    }

    setMode(next)

    if (next === 'live' && richEligible) {
      requestAnimationFrame(() => richEditorApiRef.current?.focus())
    }
  }

  const openNavigation = (kind: 'outline' | 'find', toggle = false) => {
    if (operationBusyRef.current || composingRef.current) { return }

    if (toggle && navigation === kind) {
      setNavigation(null)

      return
    }

    if (!editing) { beginEdit() }

    // Enter the editable projection before a user searches from Read/Changes.
    // Keep Source mode explicit; it searches literal source by design.
    if (activeMode === 'rendered' || activeMode === 'diff') {
      setMode(liveTooLarge ? 'source' : 'live')
    }

    setNavigation(kind)
    setNavigationFocusRequest(version => version + 1)
  }

  const runFormat = (command: Parameters<CodeEditorApi['dispatchCommand']>[0]) => {
    const api = editorApiRef.current

    if (!api || operationBusyRef.current || composingRef.current) {
      return
    }

    api.dispatchCommand(command)

    if (richActive) {
      richEditorApiRef.current?.focus()
    } else {
      api.focus()
    }
  }

  const runRich = (
    command: RichDocumentCommand,
    fallback: Parameters<CodeEditorApi['dispatchCommand']>[0],
    value?: number | string
  ) => {
    if (operationBusyRef.current || composingRef.current) { return }

    if (richActive && richEditorApiRef.current) {
      richEditorApiRef.current.command(command, value)
      richEditorApiRef.current.focus()
    } else {
      runFormat(fallback)
    }
  }

  const exportMenu = (
    <DropdownMenu>
      <Tip label={t.preview.exportMenu}>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t.preview.exportMenu} disabled={exportBusy} size="icon-xs" variant="ghost">
            <Download />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" aria-label={t.preview.exportMenu}>
        <DropdownMenuItem disabled={!canExport} onSelect={() => requestExport('docx')}>
          {t.preview.exportWord}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canExport} onSelect={() => requestExport('pdf')}>
          {t.preview.exportPdf}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => selectMode('source')}>{t.document.sourceAdvanced}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const pageControls = (
    <DropdownMenu onOpenChange={open => (open ? undefined : setThemePreview(null))}>
      <Tip label={t.preview.themeMenu}>
        <DropdownMenuTrigger asChild>
          <Button aria-label={t.preview.themeMenu} size="icon-xs" variant="ghost">
            <Palette />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" aria-label={t.preview.themeMenu}>
        <DropdownMenuRadioGroup
          onValueChange={value =>
            void applyTheme(themeSelection(value as DocumentThemeId, theme.pageSize, themeBodyOverride(theme)))
          }
          value={theme.id}
        >
          {DOCUMENT_THEME_IDS.map(id => (
            <DropdownMenuRadioItem
              key={id}
              onFocus={() => previewTheme(themeSelection(id, theme.pageSize, themeBodyOverride(theme)))}
              onPointerMove={() => previewTheme(themeSelection(id, theme.pageSize, themeBodyOverride(theme)))}
              value={id}
            >
              {themeName(id)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t.preview.themePageSize}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={value =>
            void applyTheme(themeSelection(theme.id, value as 'a4' | 'letter', themeBodyOverride(theme)))
          }
          value={theme.pageSize}
        >
          <DropdownMenuRadioItem
            onFocus={() => previewTheme(themeSelection(theme.id, 'a4', themeBodyOverride(theme)))}
            onPointerMove={() => previewTheme(themeSelection(theme.id, 'a4', themeBodyOverride(theme)))}
            value="a4"
          >
            {t.preview.themePageA4}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            onFocus={() => previewTheme(themeSelection(theme.id, 'letter', themeBodyOverride(theme)))}
            onPointerMove={() => previewTheme(themeSelection(theme.id, 'letter', themeBodyOverride(theme)))}
            value="letter"
          >
            {t.preview.themePageLetter}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t.preview.themeBodySize}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={value =>
            void applyTheme(themeSelection(theme.id, theme.pageSize, value === 'default' ? null : Number(value)))
          }
          value={themeBodyChoice(theme)}
        >
          <DropdownMenuRadioItem
            onFocus={() => previewTheme(themeSelection(theme.id, theme.pageSize, null))}
            onPointerMove={() => previewTheme(themeSelection(theme.id, theme.pageSize, null))}
            value="default"
          >
            {t.preview.themeBodyDefault}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            onFocus={() => previewTheme(themeSelection(theme.id, theme.pageSize, 13))}
            onPointerMove={() => previewTheme(themeSelection(theme.id, theme.pageSize, 13))}
            value="13"
          >
            {t.preview.themeBodyLarge}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            onFocus={() => previewTheme(themeSelection(theme.id, theme.pageSize, 16))}
            onPointerMove={() => previewTheme(themeSelection(theme.id, theme.pageSize, 16))}
            value="16"
          >
            {t.preview.themeBodyLarger}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={theme.isDefault} onSelect={() => void applyTheme(null)}>
          {t.preview.themeReset}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-transparent"
      data-local-keybinds={isWorkspaceDocument ? 'mod+f' : undefined}
      onKeyDownCapture={event => {
        if (isWorkspaceDocument && comboFromEvent(event.nativeEvent) === 'mod+f') {
          event.preventDefault()
          event.stopPropagation()

          if (!event.nativeEvent.isComposing) { openNavigation('find') }
        }
      }}
      ref={paneRootRef}
    >
      {isWorkspaceDocument ? (
        <DocumentCommandBar
          commands={{
            write: [
              {
                id: 'undo',
                label: t.document.undo,
                icon: <ArrowBackUp />,
                disabled: !historyState.undo,
                run: () => runFormat(undo)
              },
              {
                id: 'redo',
                label: t.document.redo,
                icon: <ArrowBackUp className="-scale-x-100" />,
                disabled: !historyState.redo,
                run: () => runFormat(redo)
              },
              {
                id: 'bold',
                label: t.preview.toolbarStrong,
                icon: <Bold />,
                pressed: formats.strong,
                run: () => runRich('bold', toggleStrong)
              },
              {
                id: 'italic',
                label: t.preview.toolbarEmphasis,
                icon: <Italic />,
                pressed: formats.emphasis,
                run: () => runRich('italic', toggleEmphasis)
              },
              {
                id: 'strike',
                label: t.preview.toolbarStrikethrough,
                icon: <Strikethrough />,
                pressed: formats.strikethrough,
                run: () => runRich('strike', toggleStrikethrough)
              },
              {
                id: 'bullet',
                label: t.preview.toolbarList,
                icon: <List />,
                pressed: formats.list,
                run: () => runRich('bullet', toggleBulletList)
              },
              {
                id: 'numbered',
                label: t.preview.toolbarOrderedList,
                icon: <ListNumbers />,
                pressed: formats.orderedList,
                run: () => runRich('numbered', toggleOrderedList)
              },
              {
                id: 'quote',
                label: t.preview.toolbarQuote,
                pressed: formats.quote,
                run: () => runRich('quote', toggleQuote)
              }
            ],
            insert: [
              {
                id: 'link',
                label: t.preview.toolbarLink,
                icon: <Link />,
                run: () => (richActive ? setLinkEditing(true) : runFormat(insertLink))
              },
              {
                id: 'table',
                label: t.preview.toolbarTable,
                icon: <Table />,
                run: () =>
                  runRich('table', insertTable({ column: t.preview.toolbarTableColumn }), t.preview.toolbarTableColumn)
              },
              {
                id: 'code',
                label: t.preview.toolbarCodeBlock,
                icon: <Code />,
                run: () => runRich('code', toggleCodeBlock)
              },
              ...(richActive && inTable
                ? [
                    {
                      id: 'rowAfter',
                      label: t.document.rowAfter,
                      run: () => richEditorApiRef.current?.command('rowAfter')
                    },
                    {
                      id: 'columnAfter',
                      label: t.document.columnAfter,
                      run: () => richEditorApiRef.current?.command('columnAfter')
                    },
                    {
                      id: 'deleteRow',
                      label: t.document.deleteRow,
                      run: () => richEditorApiRef.current?.command('deleteRow')
                    },
                    {
                      id: 'deleteColumn',
                      label: t.document.deleteColumn,
                      run: () => richEditorApiRef.current?.command('deleteColumn')
                    }
                  ]
                : [])
            ],
            page: [],
            view: [
              {
                id: 'write',
                label: t.preview.documentModeLive,
                pressed: activeMode === 'live',
                disabled: liveTooLarge || operationBusy,
                run: () => selectMode('live')
              },
              {
                id: 'read',
                label: t.preview.documentModeRead,
                pressed: activeMode === 'rendered',
                disabled: operationBusy,
                run: () => selectMode('rendered')
              },
              {
                id: 'outline',
                label: t.document.outline,
                pressed: navigation === 'outline',
                run: () => openNavigation('outline', true)
              },
              {
                id: 'find',
                label: t.document.findReplace,
                pressed: navigation === 'find',
                run: () => openNavigation('find', true)
              },
              ...(diff ? [{ id: 'changes', label: t.preview.documentModeDiff, run: () => selectMode('diff') }] : [])
            ]
          }}
          disabled={!editing || activeMode !== 'live' || operationBusy}
          documentMenu={exportMenu}
          heading={formats.heading}
          labels={t.document}
          onHeading={level => runRich('heading', setHeading(level), level)}
          pageControls={pageControls}
          status={
            <span>
              {saving
                ? t.common.saving
                : error || conflict || recoveryDraft
                  ? t.preview.unsavedChanges
                  : dirty
                    ? t.preview.unsavedChanges
                    : t.document.saved}
            </span>
          }
          styles={[
            { value: 0, label: t.document.normal },
            ...Array.from({ length: 6 }, (_, index) => ({
              value: index + 1,
              label: `${t.document.heading} ${index + 1}`
            }))
          ]}
        />
      ) : (
        <ModeSwitcher active={activeMode} modes={modes} onSelect={selectMode} />
      )}
      {isWorkspaceDocument && linkEditing && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-(--atum-line) px-3 py-2"
          onSubmit={event => {
            event.preventDefault()

            if (richEditorApiRef.current?.command('link', linkHref)) {
              setLinkEditing(false)
              richEditorApiRef.current.focus()
            } else {
              setRichNotice(true)
            }
          }}
        >
          <Input
            aria-label={t.document.linkAddress}
            autoFocus
            className="min-w-0 flex-1"
            onChange={event => setLinkHref(event.target.value)}
            size="xs"
            value={linkHref}
          />
          <Button size="xs" type="submit" variant="ghost">
            {t.document.applyLink}
          </Button>
          <Button
            onClick={() => {
              setLinkEditing(false)
              richEditorApiRef.current?.focus()
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            {t.common.cancel}
          </Button>
        </form>
      )}
      {isWorkspaceDocument && navigation && (
        <DocumentNavigation
          api={navigationApi}
          composing={composing}
          disabled={operationBusy}
          editorKey={`${activeMode}:${richEligible}:${editorGeneration}`}
          focusRequest={navigationFocusRequest}
          onClose={() => setNavigation(null)}
          onFocusEditor={() =>
            richActiveRef.current ? richEditorApiRef.current?.focus() : editorApiRef.current?.focus()
          }
          outline={navigation === 'outline'}
          text={draftRef.current}
        />
      )}
      {recoveryDraft && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--atum-line) px-3 py-2 text-xs"
          role="status"
        >
          <span>{t.document.recoveryAvailable}</span>
          <Button onClick={restoreRecovery} size="xs" variant="ghost">
            {t.document.recover}
          </Button>
          <Button onClick={() => void discardRecovery()} size="xs" variant="ghost">
            {t.document.discardRecovery}
          </Button>
        </div>
      )}
      {recoveryFailed && (
        <div className="px-3 py-2 text-xs" role="status">
          {t.document.recoveryUnavailable}{' '}
          <Button onClick={() => void loadRecovery()} size="xs" variant="ghost">
            {t.common.retry}
          </Button>
        </div>
      )}
      {themeNotice ? (
        <p className="px-3 py-1 text-xs text-amber-700" role="status">
          {themeNotice}
        </p>
      ) : null}
      {snapshot.truncated && (
        <p className="px-3 py-2 text-xs" role="status">
          {t.preview.truncated} {t.document.readOnlyLarge}
        </p>
      )}
      {review && dirty && !review.deferred ? (
        <div className="shrink-0 border-b border-(--atum-line) bg-(--atum-sunk) px-3 py-2 text-[0.7rem] text-(--atum-ink)">
          <div aria-live="polite" className="font-semibold" role="status">
            {t.preview.agentReviewEdited}
          </div>
          <div className="mt-0.5 leading-relaxed">{t.preview.agentReviewUndoDirty}</div>
          <div className="mt-1.5 flex flex-wrap gap-3">
            <Button
              disabled={Boolean(review.pending) || exportBusy}
              onClick={() => void saveDraftForReview()}
              size="inline"
              variant="textStrong"
            >
              {t.preview.agentReviewSaveDraft}
            </Button>
            <Button
              disabled={Boolean(review.pending) || !review.settled || exportBusy}
              onClick={() => void discardDraftAndUndo()}
              size="inline"
              variant="textStrong"
            >
              {t.preview.agentReviewDiscardUndo}
            </Button>
            <Button
              disabled={Boolean(review.pending) || exportBusy}
              onClick={() => deferReview(review)}
              size="inline"
              variant="text"
            >
              {t.preview.agentReviewLater}
            </Button>
          </div>
          {review.error && (
            <div className="mt-1.5 text-destructive">
              {t.preview.agentReviewFailed(review.error)}{' '}
              <Button
                onClick={() =>
                  void undoReview(review, {
                    allowDirty: true,
                    revision: externalSnapshot?.revision ?? snapshot.revision
                  })
                }
                size="inline"
                variant="textStrong"
              >
                {t.preview.agentReviewRetry}
              </Button>
            </div>
          )}
        </div>
      ) : review ? (
        <div className="shrink-0 border-b border-(--atum-line) bg-(--atum-sunk) px-3 py-2 text-[0.7rem] text-(--atum-ink)">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-live="polite" className="font-semibold" role="status">
              {t.preview.agentReviewEdited}
            </span>
            <Button
              disabled={Boolean(review.pending) || exportBusy}
              onClick={showAgentDiff}
              size="inline"
              variant="textStrong"
            >
              {t.preview.agentReviewView}
            </Button>
            <Button disabled={Boolean(review.pending) || exportBusy} onClick={doneReview} size="inline" variant="text">
              {t.preview.agentReviewDone}
            </Button>
            {review.restoreAvailable && review.checkpoint && (
              <Tip label={undoReason}>
                <span>
                  <Button
                    aria-description={undoReason || undefined}
                    disabled={Boolean(undoReason)}
                    onClick={() => void undoReview(review)}
                    size="inline"
                    variant="textStrong"
                  >
                    {t.preview.agentReviewUndo}
                  </Button>
                </span>
              </Tip>
            )}
          </div>
          {review.error && (
            <div className="mt-1.5 text-destructive">
              {t.preview.agentReviewFailed(review.error)}{' '}
              <Button onClick={() => void undoReview(review)} size="inline" variant="textStrong">
                {t.preview.agentReviewRetry}
              </Button>
            </div>
          )}
        </div>
      ) : (
        (conflict || closeRequested) && (
          <div className="shrink-0 border-b border-amber-400/40 bg-amber-50 px-3 py-2 text-[0.7rem] text-amber-900 dark:border-amber-300/30 dark:bg-amber-300/10 dark:text-amber-100">
            <div className="font-semibold">
              {closeRequested ? t.preview.closeDirtyTitle : t.preview.diskChangedTitle}
            </div>
            <div className="mt-0.5 leading-relaxed">
              {closeRequested ? t.preview.closeDirtyBody : t.preview.workspaceDiskChangedBody}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-3">
              <button
                className="font-bold underline underline-offset-4"
                onClick={() => void preserveDraft()}
                type="button"
              >
                {t.preview.preserveDraft}
              </button>
              {closeRequested ? (
                <button
                  className="font-bold underline underline-offset-4"
                  onClick={() => void discardAndClose()}
                  type="button"
                >
                  {t.preview.closeWithoutSaving}
                </button>
              ) : (
                <button
                  className="font-bold underline underline-offset-4"
                  onClick={() => void discardAndReload()}
                  type="button"
                >
                  {t.preview.discardReload}
                </button>
              )}
              <button
                className="font-bold underline underline-offset-4"
                onClick={() => setCloseRequested(false)}
                type="button"
              >
                {t.preview.keepEditing}
              </button>
            </div>
          </div>
        )
      )}
      {preservedName && (
        <div className="border-b border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-[0.7rem] text-emerald-800 dark:text-emerald-200">
          {t.preview.preservedDraft(preservedName)}
        </div>
      )}
      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[0.7rem] text-destructive">
          {error === 'DOCUMENT_RECOVERY_CONFLICT' ? t.document.recoveryConflict : t.preview.saveFailed(error)}
          <Button
            disabled={operationBusy}
            onClick={() => {
              if (error === 'DOCUMENT_RECOVERY_CONFLICT') {
                setError(null)
                void loadRecovery()
              } else {
                void save({ stayInEditor: true })
              }
            }}
            size="xs"
            variant="ghost"
          >
            {t.common.retry}
          </Button>
        </div>
      )}
      {exportState.kind !== 'idle' && (
        <div className="shrink-0 border-b border-(--atum-line) bg-(--atum-sunk) px-3 py-2 text-[0.7rem] text-(--atum-ink)">
          {exportState.kind === 'choosingDirtyAction' ? (
            <>
              <div aria-live="polite" className="font-semibold" role="status">
                {t.preview.exportChoiceBody}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3">
                <Button onClick={() => void saveThenExport(exportState.format)} size="inline" variant="textStrong">
                  {t.preview.exportSaveThen}
                </Button>
                <Button
                  onClick={() => void runExport(exportState.format, exportState.expectedRevision || undefined)}
                  size="inline"
                  variant="textStrong"
                >
                  {t.preview.exportSaved}
                </Button>
                <Button onClick={() => setExportState({ kind: 'idle' })} size="inline" variant="text">
                  {t.preview.exportLater}
                </Button>
              </div>
            </>
          ) : exportState.kind === 'succeeded' ? (
            <div className="flex flex-wrap items-center gap-3">
              <span aria-live="polite" className="font-semibold" role="status">
                {t.preview.exportDone(exportState.result.displayName)}
              </span>
              <Button onClick={() => void revealExport(exportState.result)} size="inline" variant="textStrong">
                {t.preview.exportReveal}
              </Button>
              <Button onClick={() => void shareExport(exportState.result)} size="inline" variant="textStrong">
                {t.preview.exportShare}
              </Button>
              <Button onClick={() => setExportState({ kind: 'idle' })} size="inline" variant="text">
                {t.preview.exportDismiss}
              </Button>
            </div>
          ) : exportState.kind === 'failed' ? (
            <div className="flex flex-wrap items-center gap-3">
              <span aria-live="polite" className="font-semibold text-destructive" role="status">
                {t.preview.exportFailed(exportReason(exportState.code))}
              </span>
              <Button
                onClick={() => void runExport(exportState.format, exportState.expectedRevision)}
                size="inline"
                variant="textStrong"
              >
                {t.preview.exportRetry}
              </Button>
              <Button onClick={() => setExportState({ kind: 'idle' })} size="inline" variant="text">
                {t.preview.exportDismiss}
              </Button>
            </div>
          ) : (
            <span aria-live="polite" role="status">
              {t.preview.exportInProgress}
            </span>
          )}
        </div>
      )}
      {editing && !isWorkspaceDocument && activeMode === 'live' && (
        <MarkdownToolbar active={formats} disabled={operationBusy} onCommand={runFormat} />
      )}
      {editing && isMarkdown && (
        <p className="sr-only" id={liveDescriptionId}>
          {t.preview.liveEditorDescription}
        </p>
      )}
      {editing && isMarkdown && liveTooLarge && (
        <div
          className="shrink-0 border-b border-(--atum-line) bg-(--atum-sunk) px-3 py-1.5 text-[0.7rem] text-(--atum-ink-muted)"
          role="status"
        >
          {t.preview.documentTooLargeForLive}
        </div>
      )}
      {isWorkspaceDocument && activeMode === 'live' && (richEligible === false || richNotice || pasteNotice) && (
        <div className="shrink-0 border-b border-(--atum-line) px-3 py-2 text-xs text-(--atum-ink-muted)" role="status">
          {richEligible === false
            ? t.document.richUnavailable
            : richNotice
              ? t.document.richEditRefused
              : pasteNotice === 'refused'
                ? t.document.richPasteRefused
                : t.document.richPasteSimplified}
          {pasteNotice === 'refused' && canPastePlain && !richNotice && richEligible !== false && (
            <Button className="ml-2" disabled={operationBusy} onClick={() => richEditorApiRef.current?.pasteWithoutFormatting()} size="inline" variant="textStrong">
              {t.document.richPastePlain}
            </Button>
          )}
        </div>
      )}
      {editing ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="h-full" hidden={!editorVisible || richActive}>
            <CodeEditor
              apiRef={editorApiRef}
              disabled={
                exportBusy ||
                (!continuousSave && saving) ||
                !recoveryReady ||
                Boolean(recoveryDraft) ||
                snapshot.truncated
              }
              extraKeymap={activeMode === 'live' ? markdownKeymap : undefined}
              filePath={descriptor.displayName}
              initialValue={draftRef.current}
              inputDisabled={richActive}
              key={editorGeneration}
              liveMarkdown={isMarkdown}
              localKeybinds={isWorkspaceDocument ? [...(activeMode === 'live' ? MARKDOWN_TOOLBAR_KEYBINDS : []), 'mod+f'] : activeMode === 'live' ? MARKDOWN_TOOLBAR_KEYBINDS : undefined}
              onCancel={continuousSave ? undefined : () => void cancelEdit()}
              onChange={value => {
                setRichNotice(false)
                setPasteNotice(null)
                draftRef.current = value
                dirtyRef.current = value !== snapshotRef.current?.text
                setDirty(dirtyRef.current)
                setDraftVersion(version => version + 1)

                setExportState(current => (current.kind === 'succeeded' ? { kind: 'idle' } : current))

                if (contextPath) {
                  updateDocumentBuffer(contextPath, value, effectiveScopeKey)
                }
              }}
              onCompositionChange={handleCompositionChange}
              onSave={() => void save({ stayInEditor: continuousSave })}
              onSelectionChange={selection => {
                richEditorApiRef.current?.syncSource(selection.documentText, selection)
                const state = editorApiRef.current?.getState()

                if (state?.field) {
                  setHistoryState({ undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 })
                }

                if (!richActiveRef.current) {
                  setFormats(current => nextFormats(current, state ? activeFormats(state) : NO_FORMATS))
                }

                if (!contextPath) {
                  return
                }

                setDocumentSelection({
                  end: selection.to,
                  path: contextPath,
                  start: selection.from,
                  text: selection.documentText
                }, effectiveScopeKey)
              }}
              presentation={activeMode === 'live' ? livePresentation : undefined}
              preserveLineEndings={isWorkspaceDocument}
            />
          </div>
          {isWorkspaceDocument && !snapshot.truncated && !liveTooLarge && (
            <div className="h-full" hidden={!richActive}>
              <Suspense fallback={null}>
                <RichDocumentEditor
                  apiRef={richEditorApiRef}
                  controller={documentController}
                  enabled={
                    activeMode === 'live' &&
                    !exportBusy &&
                    (continuousSave || !saving) &&
                    recoveryReady &&
                    !recoveryDraft
                  }
                  initialValue={draftRef.current}
                  key={editorGeneration}
                  labels={{ editor: t.document.richEditor, refused: t.document.richEditRefused }}
                  onCompositionChange={handleCompositionChange}
                  onEligibility={eligible => {
                    const transferFocus =
                      eligible &&
                      activeModeRef.current === 'live' &&
                      paneRootRef.current?.contains(document.activeElement) &&
                      document.activeElement?.closest('.cm-editor')

                    setRichEligible(eligible)

                    if (transferFocus) {
                      requestAnimationFrame(() => richEditorApiRef.current?.focus())
                    }
                  }}
                  onFormatsChange={next => setFormats(current => nextFormats(current, next))}
                  onLinkRequest={() => setLinkEditing(true)}
                  onPasteFeedback={(feedback, available) => {
                    setCanPastePlain(Boolean(available))
                    setRichNotice(false)
                    setPasteNotice(feedback)
                  }}
                  onRefused={() => {
                    setPasteNotice(null)
                    setRichNotice(true)
                  }}
                  onSave={() => void save({ stayInEditor: continuousSave })}
                  onTableSelection={setInTable}
                  onUnmappedSelection={() => {
                    if (contextPath) {
                      clearDocumentSelection(effectiveScopeKey, contextPath)
                    }
                  }}
                  theme={canvasTheme}
                  zoom={zoom}
                />
              </Suspense>
            </div>
          )}
          {activeMode === 'diff' ? (
            <FileDiffPanel
              className="m-0 h-full max-h-none"
              diff={diff}
              fullText={draftRef.current}
              path={descriptor.displayName}
              showLineNumbers
            />
          ) : activeMode === 'rendered' ? (
            isWorkspaceDocument ? (
              <DocumentReadingView text={draftRef.current} theme={canvasTheme} zoom={zoom} />
            ) : (
              <MarkdownPreview text={draftRef.current} />
            )
          ) : null}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-auto">
          <button
            className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-[0.625rem] font-bold text-muted-foreground shadow-sm hover:text-foreground"
            onClick={beginEdit}
            type="button"
          >
            <Pencil className="size-3" />
            {t.preview.edit}
          </button>
          {activeMode === 'rendered' ? (
            isWorkspaceDocument ? (
              <DocumentReadingView text={snapshot.text} theme={canvasTheme} zoom={zoom} />
            ) : (
              <MarkdownPreview text={snapshot.text} />
            )
          ) : activeMode === 'diff' ? (
            <FileDiffPanel
              className="m-0 h-full max-h-none"
              diff={diff}
              fullText={draftRef.current}
              path={descriptor.displayName}
              showLineNumbers
            />
          ) : (
            <pre className="min-h-full whitespace-pre p-3 font-mono text-[0.7rem] leading-5 text-foreground">
              {snapshot.text}
            </pre>
          )}
        </div>
      )}
      {isWorkspaceDocument && (
        <DocumentStatusBar
          fitWidthLabel={t.document.fitWidth}
          onZoom={setZoom}
          wordCountLabel={t.document.words(wordCount)}
          zoom={zoom}
          zoomLabel={t.document.zoom}
        />
      )}
      {editing && !continuousSave && (
        <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-t border-border/40 px-3">
          <button
            className="flex items-center gap-1 text-[0.625rem] font-bold text-muted-foreground"
            onClick={() => void cancelEdit()}
            type="button"
          >
            <X className="size-3" /> {t.common.cancel}
          </button>
          <button
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.625rem] font-bold text-primary-foreground disabled:opacity-50"
            disabled={!dirty || operationBusy}
            onClick={() => void save()}
            type="button"
          >
            <Check className="size-3" /> {saving ? t.common.saving : t.common.save}
          </button>
        </div>
      )}
    </div>
  )
}

export const watchWorkspaceTextFileTabs = paneMirror<WorkspaceTextFileTab>({
  source: $workspaceTextFileTabs,
  also: [$dirtyPreviewUrls],
  key: tab => tab.target.workspaceTextFile.fileRef,
  prefix: 'workspace-file',
  dir: () => 'center',
  anchor: () => 'workspace',
  minWidth: '22rem',
  title: fileRef =>
    $workspaceTextFileTabs.get().find(tab => tab.target.workspaceTextFile.fileRef === fileRef)?.target.label ?? 'file',
  tabLead: fileRef => {
    const tab = $workspaceTextFileTabs.get().find(item => item.target.workspaceTextFile.fileRef === fileRef)

    return tab ? <WorkspaceTextFileDirtyDot url={tab.target.url} /> : null
  },
  render: fileRef => {
    const tab = $workspaceTextFileTabs.get().find(item => item.target.workspaceTextFile.fileRef === fileRef)

    return tab ? <WorkspaceTextFilePane tab={tab} /> : null
  },
  close: fileRef => void requestCloseWorkspaceTextFileTab(fileRef)
})
