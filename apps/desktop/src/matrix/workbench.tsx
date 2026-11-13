import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { AtumConsumerBrowser, type ConsumerBrowserTab, createConsumerBrowserTab } from '@/app/atum/consumer-browser'
import { AtumPdfPane } from '@/app/atum/pdf-pane'
import type { AtumShellFrameMotion } from '@/app/atum/shell-frame'
import { AtumWorkspaceSurface } from '@/app/atum/workspace-surface'
import { ImagePreview, SourcePreview } from '@/components/chat/source-preview'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState, NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ATUM_DESTINATION_RAIL_WIDTH, ATUM_ROSTER_WIDTH } from '@/lib/atum-shell-geometry'
import { ChevronLeft, Code, FileText, RefreshCw, Spinner, World } from '@/lib/icons'
import { shikiLanguageForFilename } from '@/lib/markdown-code'

import { isBotApiRoomForApp } from '../../shared/bot-api-room'
import type { MatrixDocumentPreview, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixDrivePreview, MatrixDriveRow } from '../../shared/matrix-drive'

import { directAppBot } from './app-bots/direct-app'
import { AppBotPanel } from './app-bots/panel'
import type { AppBotRouteRequest } from './app-bots/route-request'
import { useMatrixCopy } from './copy'
import { MatrixDocumentStatus, useDocumentCopy } from './document-link'
import { formatDriveSize } from './drive'
import { matrixDriveCopy } from './drive-copy'
import { $matrixDrivePdfLease } from './drive-finder'
import { MatrixTerminalPane, useMatrixTerminalRead } from './terminal'
import { registerMatrixDocumentDetach, runMatrixDocumentAction } from './text-document-actions'
import { matrixTextDocumentLease } from './text-document-lease'
import { MatrixTextDocumentPane } from './text-document-pane'
import { MatrixWordPane } from './word-pane'
import { useMatrixWorkbenchCopy } from './workbench-copy'
import { MatrixWorkbenchLauncher } from './workbench-launcher'
import {
  activateMatrixWorkbenchRecentAccount,
  type MatrixWorkbenchRecent,
  matrixWorkbenchRecentFromBrowser,
  matrixWorkbenchRecentFromDocument,
  matrixWorkbenchRecentStorage,
  readMatrixWorkbenchRecents,
  recordMatrixWorkbenchRecent
} from './workbench-recents'

type MatrixWorkbenchSelection = 'document' | 'drive' | 'launcher' | `browser:${string}` | `terminal:${string}`

export interface MatrixDrivePreviewRequest extends MatrixDriveRow {
  scope: string
  serial: number
}

interface MatrixWorkbenchTabState {
  browsers: ConsumerBrowserTab[]
  scope: string
  documentOpen: boolean
  selected: MatrixWorkbenchSelection
}

/** Below this, the chat beside an open side panel is too narrow to read. */
const MIN_CHAT_WIDTH_BESIDE_PANEL = 440

interface DrivePreviewKinds {
  pdf: string
  image: string
  text: string
  word: string
  spreadsheet: string
  presentation: string
  file: string
}

function drivePreviewKind(
  name: string,
  previewKind: MatrixDrivePreview['kind'] | undefined,
  kinds: DrivePreviewKinds
): string {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase() ?? ''

  if (['doc', 'docx'].includes(extension)) {
    return kinds.word
  }

  if (['xls', 'xlsx', 'csv'].includes(extension)) {
    return kinds.spreadsheet
  }

  if (['ppt', 'pptx'].includes(extension)) {
    return kinds.presentation
  }

  if (previewKind === 'pdf') {
    return kinds.pdf
  }

  if (previewKind === 'image') {
    return kinds.image
  }

  if (previewKind === 'text') {
    return kinds.text
  }

  return kinds.file
}

function formatDrivePreviewDate(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

/**
 * Whether opening the side panel should fold the roster away: at a narrow (but not
 * compact) window, rail + roster + an even split leave the chat a column a few words
 * wide. The sidebar toggle brings the roster back.
 */
export function matrixWorkbenchCrowdsRoster(windowWidth: number, panelPercent: number): boolean {
  const split = windowWidth - ATUM_DESTINATION_RAIL_WIDTH - ATUM_ROSTER_WIDTH

  return split * (1 - panelPercent / 100) < MIN_CHAT_WIDTH_BESIDE_PANEL
}

export function matrixWorkbenchScope(snapshot: MatrixSnapshot): string {
  // A local document capability is scoped by the Matrix account/device and
  // selected room. Never let a previously selected room paint while this
  // component remains mounted across navigation.
  return `${snapshot.identity?.userId ?? ''}\u0000${snapshot.identity?.deviceId ?? ''}\u0000${snapshot.roomId ?? ''}`
}

/** Keyed by account/room/selection, never the legacy workbench store. */
export function MatrixWorkbench({
  snapshot,
  hidden,
  compact,
  expanded,
  percent,
  motion,
  windowControls,
  obstructed,
  onClose,
  onExpand,
  onPercentChange,
  onTabCountChange,
  appRouteRequest,
  onAppRouteRequestConsumed,
  documentRequest,
  browserRequest,
  terminalRequest,
  driveRequest,
  onDriveRequestClose,
  onAskDrivePreview,
  onOpenDrive
}: {
  snapshot: MatrixSnapshot
  hidden: boolean
  compact: boolean
  expanded: boolean
  percent: number
  motion: AtumShellFrameMotion
  windowControls: ReactNode
  obstructed: boolean
  onClose(): void
  onExpand(value: boolean): void
  onPercentChange(value: number): void
  /** The shell consumes this for its collapsed plus/count affordance. */
  onTabCountChange?(count: number): void
  appRouteRequest?: AppBotRouteRequest
  onAppRouteRequestConsumed?(serial: number): void
  /** Parent increments this from an explicit “show linked document” action. */
  documentRequest?: number
  browserRequest?: { id: string; url: string; scope: string }
  terminalRequest?: { id: string; scope: string; serial: number }
  driveRequest?: MatrixDrivePreviewRequest
  onDriveRequestClose?(): void
  onAskDrivePreview?(request: MatrixDrivePreviewRequest): void
  /** The new tab's Files tool: Atum Drive, the file browser. Absent without Drive. */
  onOpenDrive?(): void
}) {
  const { locale, t } = useI18n()
  const copy = useDocumentCopy()
  const workbenchCopy = useMatrixWorkbenchCopy()
  const matrixCopy = useMatrixCopy()
  const driveCopy = matrixDriveCopy[locale]
  const panelId = useId()
  const scope = matrixWorkbenchScope(snapshot)
  const recentAccountId = snapshot.identity?.userId
  const recentRoomId = snapshot.roomId

  const recentScope = useMemo(
    () => recentAccountId && recentRoomId ? { accountId: recentAccountId, roomId: recentRoomId } : null,
    [recentAccountId, recentRoomId]
  )

  const recentScopeKey = recentScope ? `${recentScope.accountId}\u0000${recentScope.roomId}` : ''
  const recentStorage = useMemo(matrixWorkbenchRecentStorage, [])
  const botApp = directAppBot(snapshot)
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)

  const botApiRoom = Boolean(
    botApp &&
      room &&
      isBotApiRoomForApp(snapshot.messages, botApp, room.encrypted, {
        room,
        ownUserId: snapshot.identity?.userId
      })
  )

  const link = snapshot.linkedDocument

  const hasLink = Boolean(link)
  const hasDrivePreview = driveRequest?.scope === scope

  const initialTabState = useCallback(
    (): MatrixWorkbenchTabState => ({
      scope,
      browsers: [],
      documentOpen: hasLink,
      selected: hasDrivePreview ? 'drive' : hasLink ? 'document' : 'launcher'
    }),
    [scope, hasLink, hasDrivePreview]
  )

  const [tabState, setTabState] = useState<MatrixWorkbenchTabState>(initialTabState)

  const [recentState, setRecentState] = useState<{ entries: MatrixWorkbenchRecent[]; scopeKey: string }>(() => ({
    entries: readMatrixWorkbenchRecents(recentStorage, recentScope),
    scopeKey: recentScopeKey
  }))

  const [reload, setReload] = useState(0)
  const [loadedPreview, setLoadedPreview] = useState<{ scope: string; value: MatrixDocumentPreview } | null>(null)

  const [loadedDrivePreview, setLoadedDrivePreview] = useState<{
    scope: string
    serial: number
    value: MatrixDrivePreview
  } | null>(null)

  const drivePreview =
    loadedDrivePreview?.scope === scope && loadedDrivePreview.serial === driveRequest?.serial
      ? loadedDrivePreview.value
      : null

  // Scope guards paint synchronously; effect cleanup retires the native grant.
  // A room/account/device change must never paint the outgoing saved bytes.
  const preview = loadedPreview?.scope === scope ? loadedPreview.value : null

  const textLease = useMemo(() => preview?.kind === 'editable'
    ? matrixTextDocumentLease(window.atumMatrix, preview.token, preview.name, preview.recovery) : null, [preview])

  const detachRegistration = useRef<(() => void) | null>(null)

  const onDetachReady = useCallback((prepare: (() => Promise<void>) | null) => {
    detachRegistration.current?.()
    detachRegistration.current = prepare ? registerMatrixDocumentDetach(prepare) : null
  }, [])

  useEffect(() => () => {detachRegistration.current?.()}, [])

  const closeWorkbench = useCallback(() => {
    void runMatrixDocumentAction(async () => onClose()).catch(() => {})
  }, [onClose])

  const refreshDocument = useCallback(() => {
    void runMatrixDocumentAction(async () => setReload(value => value + 1)).catch(() => {})
  }, [])

  const [error, setError] = useState(false)
  const [driveError, setDriveError] = useState(false)
  const available = snapshot.state === 'ready' && link?.state === 'linked'
  const availableRef = useRef(available)
  const wasAvailableRef = useRef(available)
  availableRef.current = available
  const roomId = snapshot.roomId!
  const requestRef = useRef(documentRequest)
  const browserRequestRef = useRef<string | undefined>(undefined)
  const terminalRequestRef = useRef<number | undefined>(undefined)
  const driveRequestRef = useRef<number | undefined>(undefined)
  const scopedTabState = tabState.scope === scope ? tabState : initialTabState()
  const tabOpen = scopedTabState.documentOpen && Boolean(link)
  const browserTabs = scopedTabState.browsers
  const recents = recentState.scopeKey === recentScopeKey ? recentState.entries : []

  // An editable preview has its own opaque, room-scoped lease. While Matrix
  // reconnects we retain that pane and its local buffer, but mark its I/O
  // unavailable. Other preview kinds keep the usual offline behaviour.
  const retainedEditablePreview = preview?.kind === 'editable' && textLease !== null

  const activeBrowserId = scopedTabState.selected.startsWith('browser:')
    ? scopedTabState.selected.slice('browser:'.length)
    : null

  const terminalTabs = useMemo(() => snapshot.terminals?.filter(tab => tab.open) ?? [], [snapshot.terminals])

  const activeTerminalId = scopedTabState.selected.startsWith('terminal:')
    ? scopedTabState.selected.slice('terminal:'.length) : null

  const selected =
    activeTerminalId && !terminalTabs.some(tab => tab.id === activeTerminalId) ? 'launcher' :
    scopedTabState.selected === 'drive' && !hasDrivePreview
      ? 'launcher'
      : scopedTabState.selected === 'document' && !tabOpen
      ? 'launcher'
      : activeBrowserId && !browserTabs.some(tab => tab.id === activeBrowserId)
        ? 'launcher'
        : scopedTabState.selected

  const tabCount = (tabOpen ? 1 : 0) + (hasDrivePreview ? 1 : 0) + browserTabs.length + terminalTabs.length
  useMatrixTerminalRead(snapshot, scope, selected.startsWith('terminal:') ? activeTerminalId : null, !hidden && !obstructed)
  const matrixBrowser = window.atumMatrix.consumerBrowser

  const updateScopedTabState = useCallback(
    (update: (current: MatrixWorkbenchTabState) => MatrixWorkbenchTabState) => {
      setTabState(current => (current.scope === scope ? update(current) : current))
    },
    [scope]
  )

  const recordRecent = useCallback(
    (recent: MatrixWorkbenchRecent | null) => {
      if (!recentScope || !recent) {
        return
      }

      setRecentState({
        entries: recordMatrixWorkbenchRecent(recentStorage, recentScope, recent),
        scopeKey: recentScopeKey
      })
    },
    [recentScope, recentScopeKey, recentStorage]
  )

  const openBrowser = (url: string) => {
    updateScopedTabState(current => {
      if (current.browsers.length + (current.documentOpen && link ? 1 : 0) + terminalTabs.length >= 32) {
        return current
      }

      const browser = createConsumerBrowserTab(url, t.atum.browser.newTab)

      return { ...current, browsers: [...current.browsers, browser], selected: `browser:${browser.id}` }
    })
  }

  const updateBrowser = (next: ConsumerBrowserTab) => {
    recordRecent(matrixWorkbenchRecentFromBrowser(next))
    updateScopedTabState(current => {
      if (!current.browsers.some(tab => tab.id === next.id)) {
        return current
      }

      return { ...current, browsers: current.browsers.map(tab => (tab.id === next.id ? next : tab)) }
    })
  }

  useEffect(() => {
    if (!recentScope) {
      setRecentState({ entries: [], scopeKey: '' })

      return
    }

    activateMatrixWorkbenchRecentAccount(recentStorage, recentScope.accountId)
    setRecentState({
      entries: readMatrixWorkbenchRecents(recentStorage, recentScope),
      scopeKey: recentScopeKey
    })
  }, [recentScope, recentScopeKey, recentStorage])

  useEffect(() => {
    if (!browserRequest || browserRequest.scope !== scope || browserRequestRef.current === browserRequest.id) {
      return
    }

    browserRequestRef.current = browserRequest.id
    updateScopedTabState(current => {
      if (current.browsers.length + (current.documentOpen && link ? 1 : 0) + terminalTabs.length >= 32) {
        return current
      }

      const browser = createConsumerBrowserTab(browserRequest.url, t.atum.browser.newTab)

      return { ...current, browsers: [...current.browsers, browser], selected: `browser:${browser.id}` }
    })
  }, [browserRequest, scope, updateScopedTabState, link, terminalTabs.length, t.atum.browser.newTab])

  useEffect(() => {
    if (terminalRequest?.scope === scope && terminalRequestRef.current !== terminalRequest.serial &&
      terminalTabs.some(tab => tab.id === terminalRequest.id)) {
      terminalRequestRef.current = terminalRequest.serial
      updateScopedTabState(current => ({ ...current, selected: `terminal:${terminalRequest.id}` }))
    }
  }, [terminalRequest, scope, updateScopedTabState, terminalTabs])

  useEffect(() => {
    if (
      !driveRequest ||
      driveRequest.scope !== scope ||
      driveRequest.kind !== 'file' ||
      driveRequestRef.current === driveRequest.serial
    ) {
      return
    }

    driveRequestRef.current = driveRequest.serial
    updateScopedTabState(current => ({ ...current, selected: 'drive' }))
  }, [driveRequest, scope, updateScopedTabState])

  useEffect(() => {
    let disposed = false
    let token: string | undefined
    setLoadedDrivePreview(null)
    setDriveError(false)

    if (!driveRequest || driveRequest.scope !== scope || driveRequest.kind !== 'file') {
      return
    }

    const bridge = window.atumMatrix.drive

    if (!bridge?.preview || !bridge.closePreview) {
      setDriveError(true)

      return
    }

    void bridge
      .preview(driveRequest.id)
      .then(value => {
        token = value.token

        if (disposed) {
          void bridge.closePreview!(token).catch(() => {})
        } else {
          setLoadedDrivePreview({ scope, serial: driveRequest.serial, value })
          // The PDF pane reopens its pages through this lease: Drive's gallery leaves it alone.
          $matrixDrivePdfLease.set(value.kind === 'pdf')
        }
      })
      .catch(() => {
        if (!disposed) {
          setDriveError(true)
        }
      })

    return () => {
      disposed = true
      $matrixDrivePdfLease.set(false)

      if (token) {
        void bridge.closePreview!(token).catch(() => {})
      }
    }
  }, [driveRequest, scope])

  useEffect(() => {
    if (tabState.scope !== scope) {
      setTabState(initialTabState())
    }
  }, [scope, tabState.scope, initialTabState])

  useEffect(() => {
    if (documentRequest === requestRef.current) {
      return
    }

    requestRef.current = documentRequest

    if (link) {
      updateScopedTabState(current => ({ ...current, documentOpen: true, selected: 'document' }))
    }
  }, [documentRequest, link, scope, updateScopedTabState])

  useEffect(() => onTabCountChange?.(tabCount), [onTabCountChange, tabCount])

  useEffect(() => {
    if (hidden || obstructed) {
      return
    }

    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (compact) {
          closeWorkbench()
        } else if (expanded) {
          onExpand(false)
        }
      }
    }

    window.addEventListener('keydown', escape)

    return () => window.removeEventListener('keydown', escape)
  }, [hidden, obstructed, compact, expanded, closeWorkbench, onExpand])

  useEffect(() => {
    let disposed = false
    let token: string | undefined
    setLoadedPreview(null)
    setError(false)

    if (!tabOpen || !availableRef.current) {
      return
    }

    void window.atumMatrix
      .previewDocument(roomId)
      .then(value => {
        token = value.token

        if (disposed) {
          void window.atumMatrix.closeDocumentPreview(token).catch(() => {})
        } else {
          recordRecent(matrixWorkbenchRecentFromDocument(value, link?.revision))
          setLoadedPreview({ scope, value })
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(true)
        }
      })

    return () => {
      disposed = true

      if (token) {
        void window.atumMatrix.closeDocumentPreview(token).catch(() => {})
      }
    }
  }, [link?.name, link?.revision, link?.state, recordRecent, reload, roomId, scope, tabOpen])

  useEffect(() => {
    const reconnected = available && !wasAvailableRef.current
    wasAvailableRef.current = available

    // A retained editable preview owns its existing token and lease. Do not
    // fetch another token merely because the transport reconnected. If there
    // was no preview to retain, retry the normal scoped request once.
    if (reconnected && !loadedPreview) { setReload(value => value + 1) }
  }, [available, loadedPreview])

  return (
    <AtumWorkspaceSurface
      activeId={
        selected === 'drive' && hasDrivePreview
          ? 'drive'
          : selected === 'document' && tabOpen
          ? 'document'
          : selected === 'launcher'
            ? 'launcher'
            : activeTerminalId && selected.startsWith('terminal:')
              ? `terminal:${activeTerminalId}`
              : activeBrowserId
              ? `browser:${activeBrowserId}`
              : undefined
      }
      drawer={compact}
      fullFrame={expanded}
      hidden={hidden}
      motionPhase={motion.phase}
      onActivate={id =>
        updateScopedTabState(current => ({
          ...current,
          selected: id === 'launcher' ? 'launcher' : (id as MatrixWorkbenchSelection)
        }))
      }
      onAdd={() => updateScopedTabState(current => ({ ...current, selected: 'launcher' }))}
      onClose={closeWorkbench}
      onCloseTab={id => {
        if (id.startsWith('terminal:')) {
          void window.atumMatrix.terminals?.close(roomId, id.slice('terminal:'.length)).catch(() => {})

          return
        }

        if (id === 'launcher') {
          if (tabCount === 0) {
            closeWorkbench()
          } else {
            updateScopedTabState(current => ({
              ...current,
              selected: current.documentOpen && link ? 'document' : current.browsers.length ? `browser:${current.browsers.at(-1)!.id}` : terminalTabs.at(-1) ? `terminal:${terminalTabs.at(-1)!.id}` : 'launcher'
            }))
          }

          return
        }

        if (id === 'document') {
          void runMatrixDocumentAction(async () => {
            updateScopedTabState(current => ({
              ...current, documentOpen: false,
              selected: current.selected === 'document' ? 'launcher' : current.selected
            }))
          }).catch(() => {})

          return
        }

        if (id === 'drive') {
          onDriveRequestClose?.()
          updateScopedTabState(current => ({
            ...current,
            selected: current.selected === 'drive' ? 'launcher' : current.selected
          }))

          return
        }

        updateScopedTabState(current => {
          const browsers = current.browsers.filter(tab => `browser:${tab.id}` !== id)

          return {
            ...current,
            browsers,
            selected:
              current.selected === id ? (current.documentOpen && link ? 'document' : 'launcher') : current.selected
          }
        })
      }}
      onExpand={onExpand}
      onMotionEnd={motion.finishExit}
      onPercentChange={onPercentChange}
      panelId={panelId}
      percent={percent}
      tabs={[
        ...(hasDrivePreview && driveRequest
          ? [{ id: 'drive', title: driveRequest.name, icon: <FileText aria-hidden className="size-3.5" /> }]
          : []),
        ...(tabOpen && link
          ? [{ id: 'document', title: link.name, icon: <FileText aria-hidden className="size-3.5" /> }]
          : []),
        ...terminalTabs.map(tab => ({ id: `terminal:${tab.id}`, title: `${t.rightSidebar.terminal} ${tab.ordinal}`, icon: <Code aria-hidden className="size-3.5" /> })),
        ...browserTabs.map(tab => ({
          id: `browser:${tab.id}`,
          title: tab.title,
          icon: <World aria-hidden className="size-3.5" />
        })),
        ...(selected === 'launcher'
          ? [
              {
                id: 'launcher',
                title: botApp?.bot?.display_name ?? t.atum.workspace.launcherTab,
                icon: <World aria-hidden className="size-3.5" />
              }
            ]
          : [])
      ]}
      windowControls={
        compact ? (
          <>
            {windowControls}
            {/* At compact width the panel covers the chat: a visible way back, not only the far-right icon. */}
            <button
              aria-label={workbenchCopy.backToChatLabel}
              className="flex h-7 shrink-0 items-center gap-0.5 rounded-(--atum-r-control) ps-1 pe-2 text-(length:--atum-t-control) text-(--atum-ink-muted) transition-colors hover:bg-(--atum-hover) hover:text-(--atum-ink) [-webkit-app-region:no-drag]"
              data-matrix-workbench-back
              onClick={closeWorkbench}
              type="button"
            >
              <ChevronLeft aria-hidden className="size-4" strokeWidth={1.8} />
              {workbenchCopy.backToChat}
            </button>
          </>
        ) : (
          windowControls
        )
      }
    >
      <div className="flex h-full min-h-0 flex-col" data-matrix-workbench>
        {terminalTabs.map(tab => <div className={selected === `terminal:${tab.id}` ? 'flex h-full min-h-0 flex-col' : 'hidden'} key={tab.id}>
          <MatrixTerminalPane active={!hidden && !obstructed && selected === `terminal:${tab.id}`} roomId={roomId} scope={scope} tab={tab} />
        </div>)}
        {tabOpen && link && (
          <div className={selected === 'document' ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            {/* One slim status row, not a paragraph over every document. Word has its own row. */}
            {preview && preview.kind !== 'word' && (
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--atum-line) ps-3 pe-2">
                <MatrixDocumentStatus
                  help={preview.kind === 'editable' ? copy.help : `${copy.previewHelp} ${copy.help}`}
                  label={preview.kind === 'editable' ? workbenchCopy.saves : workbenchCopy.viewOnly}
                />
                <span className="flex-1" />
                <Tip label={t.common.refresh}>
                  <button
                    aria-label={t.common.refresh}
                    className="atum-icon-btn size-7"
                    data-icon-only
                    disabled={!available}
                    onClick={refreshDocument}
                    type="button"
                  >
                    <RefreshCw aria-hidden className="size-3.5" />
                  </button>
                </Tip>
              </div>
            )}
            <div className="min-h-0 flex-1">
              {!available && !retainedEditablePreview ? (
                <NoticeBand className="m-4" role="status" tone="notice">
                  {snapshot.state !== 'ready'
                    ? matrixCopy.offline
                    : link.state === 'reconnect_required'
                      ? copy.reconnect
                      : copy.unavailable}
                </NoticeBand>
              ) : error ? (
                <div className="grid h-full place-items-center p-4" role="alert">
                  <ErrorState title={t.atum.workspace.filesOpenError}>
                    <Button onClick={refreshDocument} size="sm" variant="secondary">
                      {t.common.retry}
                    </Button>
                  </ErrorState>
                </div>
              ) : !preview ? (
                <div className="grid h-full place-items-center p-4">
                  <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={t.atum.workspace.documentLoading} />
                </div>
              ) : preview.kind === 'pdf' ? (
                <AtumPdfPane
                  bridge={window.atumMatrix.pdf}
                  hidden={hidden || obstructed || selected !== 'document' || (compact && motion.phase !== 'open')}
                  title={preview.name}
                  token={preview.token}
                />
              ) : preview.kind === 'image' ? (
                <ImagePreview dataUrl={preview.dataUrl} name={preview.name} />
              ) : preview.kind === 'word' ? (
                <MatrixWordPane preview={preview} roomId={roomId} />
              ) : preview.kind === 'editable' && textLease ? (
                <MatrixTextDocumentPane enabled={available} key={preview.token} lease={textLease} name={preview.name} onDetachReady={onDetachReady} />
              ) : preview.kind === 'text' ? (
                <SourcePreview language={shikiLanguageForFilename(preview.name)} text={preview.text} />
              ) : (
                <EmptyState className="h-full p-4" title={copy.unsupported} />
              )}
            </div>
          </div>
        )}
        {hasDrivePreview && driveRequest && (
          <div
            className={selected === 'drive' ? 'flex h-full min-h-0 flex-col' : 'hidden'}
            data-matrix-drive-preview
          >
            <div className="min-h-0 flex-1 p-(--ak-s4)">
              <div className="h-full min-h-48 overflow-hidden rounded-(--ak-r-lg) border border-(--ak-line) bg-(--ak-fill-quiet)">
                {driveError ? (
                  <div className="grid h-full place-items-center p-(--ak-s4)" role="alert">
                    <ErrorState title={driveCopy.preview.error} />
                  </div>
                ) : !drivePreview ? (
                  <div className="grid h-full place-items-center p-(--ak-s4)">
                    <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={driveCopy.preview.loading} />
                  </div>
                ) : drivePreview.kind === 'pdf' ? (
                  <AtumPdfPane
                    bridge={window.atumMatrix.pdf}
                    hidden={hidden || obstructed || selected !== 'drive' || (compact && motion.phase !== 'open')}
                    title={drivePreview.name}
                    token={drivePreview.token}
                  />
                ) : drivePreview.kind === 'image' ? (
                  <ImagePreview dataUrl={drivePreview.dataUrl} name={drivePreview.name} />
                ) : drivePreview.kind === 'text' ? (
                  <SourcePreview language={shikiLanguageForFilename(drivePreview.name)} text={drivePreview.text} />
                ) : (
                  <EmptyState className="h-full p-(--ak-s4)" title={driveCopy.preview.unavailable} />
                )}
              </div>
            </div>
            <div className="shrink-0 border-t border-(--ak-line) p-(--ak-s4)">
              <dl className="grid grid-cols-[auto_1fr] gap-x-(--ak-s4) gap-y-(--ak-s1) [font:var(--ak-t-body)]">
                <dt className="text-(--ak-ink-3)">{driveCopy.preview.kind}</dt>
                <dd className="text-(--ak-ink)">{drivePreviewKind(driveRequest.name, drivePreview?.kind, driveCopy.preview.kinds)}</dd>
                <dt className="text-(--ak-ink-3)">{driveCopy.preview.modified}</dt>
                <dd className="text-(--ak-ink)">{formatDrivePreviewDate(driveRequest.modifiedAt, locale)}</dd>
                <dt className="text-(--ak-ink-3)">{driveCopy.preview.size}</dt>
                <dd className="text-(--ak-ink)">{formatDriveSize(driveRequest.size, locale)}</dd>
              </dl>
              <div className="mt-(--ak-s4) flex items-center gap-(--ak-s2)">
                <Button
                  className="min-w-0 flex-1"
                  disabled={!onAskDrivePreview}
                  onClick={() => onAskDrivePreview?.(driveRequest)}
                >
                  {driveCopy.preview.ask}
                </Button>
                <Button
                  disabled={!window.atumMatrix.drive}
                  onClick={() => void window.atumMatrix.drive?.open(driveRequest.id).catch(() => setDriveError(true))}
                  variant="secondary"
                >
                  {driveCopy.preview.open}
                </Button>
              </div>
            </div>
          </div>
        )}
        {browserTabs.map(tab => (
          <AtumConsumerBrowser
            browser={matrixBrowser}
            hidden={hidden || obstructed || selected !== `browser:${tab.id}` || (compact && motion.phase !== 'open')}
            key={tab.id}
            onOpenExternal={url => window.atumMatrix.openLink(url)}
            onOpenTab={openBrowser}
            onUpdate={updateBrowser}
            tab={tab}
          />
        ))}
        <div className={selected === 'launcher' ? 'h-full min-h-0' : 'hidden'} hidden={selected !== 'launcher'}>
          {botApp ? <AppBotPanel
            app={botApp}
            botApiRoom={botApiRoom}
            hidden={hidden || obstructed || selected !== 'launcher' || (compact && motion.phase !== 'open')}
            key={`${snapshot.petScope ?? ''}:${scope}:${botApp.app_version_id}`}
            onBackToChat={closeWorkbench}
            onRequestConsumed={onAppRouteRequestConsumed}
            request={appRouteRequest?.scope === scope ? appRouteRequest : undefined}
            snapshot={snapshot}
          /> : <MatrixWorkbenchLauncher
            active={selected === 'launcher' && !hidden && !obstructed}
            browser={matrixBrowser}
            onDocumentChosen={() =>
              updateScopedTabState(current => ({ ...current, documentOpen: true, selected: 'document' }))
            }
            onOpenBrowser={openBrowser}
            onOpenDrive={
              onOpenDrive
                ? () => {
                    onOpenDrive()

                    // A compact panel covers the main area Drive opens in.
                    if (compact) {
                      closeWorkbench()
                    }
                  }
                : undefined
            }
            onReopenDocument={() =>
              updateScopedTabState(current => ({ ...current, documentOpen: true, selected: 'document' }))
            }
            recents={recents}
            snapshot={snapshot}
          />}
        </div>
      </div>
    </AtumWorkspaceSurface>
  )
}
