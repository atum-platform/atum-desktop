import type { FormEvent } from 'react'
import { useId, useState } from 'react'

import type { ConsumerBrowserBridge } from '@/app/atum/consumer-browser'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { File, FileText, Folder, type IconComponent, SearchIcon, Spinner, World } from '@/lib/icons'
import { relativeTime } from '@/lib/time'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixSnapshot } from '../../shared/matrix'

import { useAppCopy } from './app-copy'
import { type LauncherAtumApps, MatrixLauncherApps } from './native-apps'
import { runMatrixCommand } from './text-document-actions'
import { useMatrixWorkbenchCopy } from './workbench-copy'
import type { MatrixWorkbenchRecent } from './workbench-recents'

/** A new tab starts with one kit search field; website tabs own browser navigation chrome. */
function NewTabToolbar({ onOpen }: { onOpen(url: string): void }) {
  const copy = useMatrixWorkbenchCopy()
  const [address, setAddress] = useState('')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = address.trim()

    if (url) {
      onOpen(url)
    }
  }

  return (
    <div className="shrink-0 px-(--ak-s6) pt-(--ak-s4)" data-matrix-new-tab-search>
      <form className="ak-field ak-field--search" data-matrix-workbench-navigation onSubmit={submit}>
        <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
        <input
          aria-label={copy.searchWeb}
          onChange={event => setAddress(event.target.value)}
          placeholder={copy.searchWeb}
          value={address}
        />
      </form>
    </div>
  )
}

/** One quiet row of the Tools grid: a glyph and a word, as Codex draws its tools. */
function LauncherTool({
  disabled = false,
  icon: Icon,
  label,
  onClick
}: {
  disabled?: boolean
  icon: IconComponent
  label: string
  onClick(): void
}) {
  return (
    <button className="atum-launcher-tool" disabled={disabled} onClick={onClick} type="button">
      <Icon aria-hidden className="ak-icon size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixWorkbenchLauncher({
  active = true,
  browser,
  recents,
  snapshot,
  onDocumentChosen,
  onOpenBrowser,
  onOpenDrive,
  onReopenDocument
}: {
  active?: boolean
  browser?: ConsumerBrowserBridge
  recents: readonly MatrixWorkbenchRecent[]
  snapshot: MatrixSnapshot
  onDocumentChosen(): void
  onOpenBrowser(url: string): void
  /** Absent when this build or account has no Drive. */
  onOpenDrive?: () => void
  onReopenDocument(): void
}) {
  const { locale, t } = useI18n()
  const appCopy = useAppCopy()
  const workbenchCopy = useMatrixWorkbenchCopy()
  const toolsHeading = useId()
  const recentHeading = useId()
  const [actionFailed, setActionFailed] = useState(false)
  const canChooseDocument = snapshot.state === 'ready' && Boolean(snapshot.roomId)
  const appsReady = snapshot.state === 'ready' && snapshot.apps?.state === 'ready'
  const available = (snapshot.apps?.apps ?? []).filter(app => app.availability === 'available')

  const chooseDocument = () => {
    if (!snapshot.roomId) {
      return
    }

    setActionFailed(false)
    void window.atumMatrix
      .document(snapshot.roomId, 'choose')
      .then(onDocumentChosen)
      .catch(() => setActionFailed(true))
  }

  const openApp = (app: AppDescriptor) => {
    setActionFailed(false)
    void runMatrixCommand({ kind: 'selectApp', appId: app.app_id }).catch(() => setActionFailed(true))
  }

  const discover = () => {
    setActionFailed(false)
    void runMatrixCommand({ kind: 'discoverApps' }).catch(() => setActionFailed(true))
  }

  const atumApps: LauncherAtumApps = {
    apps: appsReady ? available : [],
    status: appsReady ? (
      available.length === 0 ? <EmptyState className="p-0" title={t.atum.discover.appsEmpty} /> : null
    ) : snapshot.apps?.state === 'loading' ? (
      <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={appCopy.loading} />
    ) : (
      <NoticeBand role="status" tone="notice">
        {appCopy.catalogUnavailable}
      </NoticeBand>
    ),
    onOpen: openApp,
    onStore: appsReady ? discover : undefined
  }

  const documentIsCurrent = (recent: Extract<MatrixWorkbenchRecent, { kind: 'document' }>) =>
    snapshot.linkedDocument?.name === recent.title &&
    (!recent.revision || snapshot.linkedDocument.revision === recent.revision)

  const openRecent = (recent: MatrixWorkbenchRecent) => {
    if (recent.kind === 'browser') {
      onOpenBrowser(recent.url)
    } else if (documentIsCurrent(recent)) {
      onReopenDocument()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-matrix-workbench-launcher>
      {browser && <NewTabToolbar onOpen={onOpenBrowser} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[44rem] flex-col gap-8 px-6 pt-8 pb-8">
          <section aria-labelledby={toolsHeading}>
            <h2 className="atum-launcher-heading" id={toolsHeading}>
              {workbenchCopy.tools}
            </h2>
            <div className="atum-launcher-tools">
              {onOpenDrive && <LauncherTool icon={Folder} label={workbenchCopy.files} onClick={onOpenDrive} />}
              <LauncherTool
                disabled={!canChooseDocument}
                icon={File}
                label={workbenchCopy.openFile}
                onClick={chooseDocument}
              />
              {snapshot.linkedDocument && (
                <LauncherTool icon={FileText} label={t.atum.workspace.documentReopen} onClick={onReopenDocument} />
              )}
            </div>
          </section>

          <MatrixLauncherApps active={active} atumApps={atumApps} snapshot={snapshot} />

          {recents.length > 0 && (
            <section aria-labelledby={recentHeading}>
              <h2 className="atum-launcher-heading px-0.5" id={recentHeading}>
                {workbenchCopy.recent}
              </h2>
              <div className="ak-group mt-2">
                {recents.map(recent => {
                  const documentEnabled = recent.kind !== 'document' || documentIsCurrent(recent)

                  const source = recent.kind === 'browser'
                    ? new URL(recent.url).hostname.replace(/^www\./u, '')
                    : workbenchCopy.document

                  const Icon = recent.kind === 'browser' ? World : FileText

                  return (
                    <button
                      className="ak-row w-full text-left disabled:pointer-events-none disabled:opacity-60"
                      disabled={!documentEnabled}
                      key={recent.kind === 'browser' ? `browser:${recent.url}` : `document:${recent.revision ?? ''}:${recent.title}`}
                      onClick={() => openRecent(recent)}
                      type="button"
                    >
                      <Icon aria-hidden className="ak-icon" />
                      <span className="ak-row-main">
                        <span className="truncate">{recent.title}</span>
                        <span className="ak-row-meta">
                          {source} · {relativeTime(recent.openedAt, Date.now(), locale)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {actionFailed && (
            <NoticeBand className="-mt-4" role="status" tone="failure">
              {t.atum.workspace.launcherActionFailed}
            </NoticeBand>
          )}
        </div>
      </div>
    </div>
  )
}
