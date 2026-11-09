import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Sparkles } from '@/lib/icons'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type {
  MatrixAgentSourceGate,
  MatrixAgentSourcesBridge,
  MatrixAgentSourcesView
} from '../../shared/matrix-agent-sources'
import type { MatrixBrowserImportBridge } from '../../shared/matrix-browser-import'
import { matrixFirstRunCopy } from '../../shared/matrix-first-run-copy'
import {
  matrixFolderAccessChoices,
  type MatrixFolderAccessRow,
  matrixFolderAccessSelection,
  type MatrixFolderAccessView
} from '../../shared/matrix-folder-access'
import { matrixGoogleConnectOffered } from '../../shared/matrix-google-tools'
import { matrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'
import type { MatrixPermissionsSnapshot } from '../../shared/matrix-permissions'

import { MatrixFirstRunFolderRows } from './folder-access-rows'
import {
  type MatrixKnowledgeSourceRow,
  projectMatrixKnowledgeSourceRows
} from './knowledge-source-projection'
import { MatrixKnowledgeSourceIcon } from './knowledge-sources-settings'
import { SettingsTip } from './settings-row'

type FirstRunAskBridge = Pick<
  MatrixUiBridge,
  'agentSources' | 'firstRun' | 'folderAccess' | 'googleConnections' | 'ownerLocation' | 'permissions'
>
type AskState = 'working' | 'done' | 'denied' | 'unavailable' | 'settings' | 'restart'

interface PendingFullDisk {
  generation: number
  row: MatrixKnowledgeSourceRow
  consented: MatrixAgentSourceGate[]
}

function fullDiskGranted(snapshot: MatrixPermissionsSnapshot | null): boolean {
  return snapshot?.platform === 'macos' && snapshot.permissions.fullDisk === 'granted'
}

/** The F4 descriptor projection is the only source inventory used by first run and Settings. */
export function MatrixFirstRunConnectCard({
  bridge = window.atumMatrix,
  browserImport = window.atumBrowserImport,
  roomId,
  snapshot
}: {
  bridge?: FirstRunAskBridge
  browserImport?: MatrixBrowserImportBridge
  roomId?: string
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixFirstRunCopy(locale).connectCard
  const sourceCopy = matrixKnowledgeSourcesCopy[locale]
  const live = useRef(true)
  const generation = useRef(0)
  const learningStarted = useRef(false)
  const settingsOpened = useRef(false)
  const leftForSettings = useRef(false)
  const [view, setView] = useState<MatrixAgentSourcesView | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [selected, setSelected] = useState<Set<MatrixAgentSourceGate>>(new Set())
  const [pending, setPending] = useState<'continue' | 'not-now' | 'settings' | 'restart' | null>(null)
  const [pendingFullDisk, setPendingFullDisk] = useState<PendingFullDisk | null>(null)
  const [states, setStates] = useState<Partial<Record<MatrixAgentSourceGate, AskState>>>({})
  // The folders under Mac folders: all ticked, each one its own macOS prompt on Continue.
  const [folderView, setFolderView] = useState<MatrixFolderAccessView | null>(null)
  const [folderSelected, setFolderSelected] = useState<Set<string>>(new Set())
  const [foldersAsked, setFoldersAsked] = useState(false)

  const rows = useMemo(() => (view ? projectMatrixKnowledgeSourceRows(view) : []), [view])
  const selectableRows = useMemo(() => rows.filter(row => row.switchable && !row.disabled && !row.checked), [rows])
  const canContinue = rows.some(row => row.checked || (row.switchable && !row.disabled))

  const loadSources = useCallback(async (agentSources: MatrixAgentSourcesBridge) => {
    const token = ++generation.current
    setReadFailed(false)

    try {
      const next = await agentSources.read()

      if (!live.current || generation.current !== token) {return null}

      setView(next)

      const available = projectMatrixKnowledgeSourceRows(next)
        .filter(row => row.switchable && !row.disabled && !row.checked)
        .map(row => row.gate as MatrixAgentSourceGate)

      setSelected(new Set(available))

      return next
    } catch {
      if (live.current && generation.current === token) {setReadFailed(true)}

      return null
    }
  }, [])

  useEffect(() => {
    live.current = true

    if (bridge?.agentSources) {void loadSources(bridge.agentSources)}
    else {setReadFailed(true)}

    void bridge?.folderAccess?.read().then(next => {
      if (!live.current || next.platform !== 'macos') {return}

      setFolderView(next)
      setFolderSelected(matrixFolderAccessSelection(next))
    }, () => undefined)

    return () => {
      live.current = false
      generation.current += 1
    }
  }, [bridge?.agentSources, bridge?.folderAccess, loadSources])

  const startLearning = useCallback(async (consented: readonly MatrixAgentSourceGate[]) => {
    if (learningStarted.current) {return}

    if (consented.length === 0) {
      await bridge?.firstRun?.decline()
    } else if (bridge?.firstRun?.start) {
      learningStarted.current = true
      await bridge.firstRun.start({ locale, ending: 'done', ...(roomId ? { roomId } : {}) })
    } else if (bridge?.firstRun?.allow) {
      learningStarted.current = true
      await bridge.firstRun.allow({ locale, ...(roomId ? { roomId } : {}) })
    } else {
      throw new Error('matrix_first_learning_unavailable')
    }

    if (live.current) {setDismissed(true)}
  }, [bridge?.firstRun, locale, roomId])

  const setGate = useCallback(async (
    row: MatrixKnowledgeSourceRow,
    token: number,
    consented: MatrixAgentSourceGate[]
  ) => {
    const gate = row.gate as MatrixAgentSourceGate

    if (!bridge?.agentSources || generation.current !== token) {return false}

    setStates(current => ({ ...current, [gate]: 'working' }))

    try {
      const next = await bridge.agentSources.set(gate, true)

      if (!live.current || generation.current !== token) {return false}

      setView(next)
      setStates(current => ({ ...current, [gate]: 'done' }))

      if (!consented.includes(gate)) {consented.push(gate)}

      return true
    } catch {
      if (live.current && generation.current === token) {
        setStates(current => ({ ...current, [gate]: 'unavailable' }))
      }

      return false
    }
  }, [bridge?.agentSources])

  const finishFullDisk = useCallback(async (waiting: PendingFullDisk) => {
    if (generation.current !== waiting.generation) {return}

    setPending('settings')
    setPendingFullDisk(null)
    await setGate(waiting.row, waiting.generation, waiting.consented)

    try {
      await startLearning(waiting.consented)
    } catch {
      learningStarted.current = false

      if (live.current && generation.current === waiting.generation) {setFailed(true)}
    } finally {
      if (live.current && generation.current === waiting.generation) {setPending(null)}
    }
  }, [setGate, startLearning])

  const applyPermissionSnapshot = useCallback((next: MatrixPermissionsSnapshot) => {
    if (!live.current || !pendingFullDisk) {return}

    if (fullDiskGranted(next)) {
      void finishFullDisk(pendingFullDisk)
    } else if (
      next.platform !== 'macos' ||
      next.permissions.fullDisk === 'restricted' ||
      next.permissions.fullDisk === 'unknown'
    ) {
      setStates(current => ({ ...current, [pendingFullDisk.row.gate]: 'unavailable' }))
    }
  }, [finishFullDisk, pendingFullDisk])

  useEffect(() => {
    if (!bridge?.permissions) {return}

    const stop = bridge.permissions.watch?.(applyPermissionSnapshot)

    const blur = () => {
      if (settingsOpened.current) {leftForSettings.current = true}
    }

    const focus = () => {
      if (!settingsOpened.current || !leftForSettings.current || !pendingFullDisk) {return}

      void bridge.permissions!.status().then(next => {
        applyPermissionSnapshot(next)

        if (next.platform === 'macos' && next.permissions.fullDisk === 'not-granted' && live.current) {
          setStates(current => ({ ...current, [pendingFullDisk.row.gate]: 'restart' }))
        }
      }, () => setFailed(true))
    }

    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)

    return () => {
      stop?.()
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
    }
  }, [applyPermissionSnapshot, bridge?.permissions, pendingFullDisk])

  const runSelection = useCallback(async (selection: ReadonlySet<MatrixAgentSourceGate>) => {
    if (!bridge?.agentSources || !bridge.firstRun || pending !== null) {return}

    const token = ++generation.current
    const consented = rows.filter(row => row.checked).map(row => row.gate as MatrixAgentSourceGate)
    let fullDiskRow: MatrixKnowledgeSourceRow | undefined
    let foldersClosed = false
    setPending('continue')
    setFailed(false)

    try {
      const foldersRow = rows.find(row => row.kind === 'folders')

      // Save every folder choice, ticked or not (an unticked folder stays closed to the tools),
      // and let macOS ask once for each ticked folder, one prompt after another.
      if (foldersRow && folderView && bridge.folderAccess) {
        const foldersGate = foldersRow.gate as MatrixAgentSourceGate
        const sharing = foldersRow.checked || selection.has(foldersGate)

        if (sharing) {setStates(current => ({ ...current, [foldersGate]: 'working' }))}

        const next = await bridge.folderAccess.apply(
          matrixFolderAccessChoices(folderView, sharing ? folderSelected : new Set())
        )

        if (!live.current || generation.current !== token) {return}

        setFolderView(next)
        setFoldersAsked(true)
        foldersClosed = !next.folders.some(folder => folder.shared && folder.mac !== 'denied')

        if (sharing) {
          setStates(current => ({ ...current, [foldersGate]: foldersClosed ? 'denied' : undefined }))
        }
      }

      for (const row of selectableRows) {
        const gate = row.gate as MatrixAgentSourceGate

        if (!selection.has(gate) || generation.current !== token) {continue}

        if (row.kind === 'folders' && foldersClosed) {continue}

        if (row.kind === 'google' && matrixGoogleConnectOffered(snapshot.googleAssistant)) {
          setStates(current => ({ ...current, [gate]: 'working' }))
          const result = await bridge.googleConnections?.connect('google')
          const connected = result?.status?.sources.some(item => item.state === 'connected' && item.enabled)

          if (!connected) {
            setStates(current => ({
              ...current,
              [gate]: result?.error === 'cancelled' || result?.error === 'denied' ? 'denied' : 'unavailable'
            }))

            continue
          }
        }

        if (row.kind === 'browser') {await browserImport?.run().catch(() => undefined)}

        if (row.kind === 'location' && bridge.ownerLocation) {
          await bridge.ownerLocation.setEnabled(true).catch(() => undefined)
        }

        if (row.kind === 'messages') {
          const permission = (await bridge.permissions?.status().catch(() => null)) ?? null

          if (!fullDiskGranted(permission)) {
            if (
              permission?.platform === 'macos' &&
              permission.permissions.fullDisk !== 'restricted' &&
              permission.permissions.fullDisk !== 'unknown' &&
              bridge.permissions
            ) {
              setStates(current => ({ ...current, [gate]: 'working' }))
              fullDiskRow = row

              continue
            }

            setStates(current => ({ ...current, [gate]: 'unavailable' }))

            continue
          }
        }

        await setGate(row, token, consented)
      }

      // Location starts on for a new account (no macOS prompt); Continue still turns on its city.
      if (bridge.ownerLocation && rows.some(row => row.kind === 'location' && row.checked)) {
        await bridge.ownerLocation.setEnabled(true).catch(() => undefined)
      }

      if (generation.current !== token) {return}

      const settingsRow = fullDiskRow

      if (settingsRow && bridge.permissions) {
        setPendingFullDisk({ generation: token, row: settingsRow, consented })
        await bridge.permissions.openSettings('fullDisk')
        settingsOpened.current = true
        setStates(current => ({ ...current, [settingsRow.gate]: 'settings' }))
        setPending(null)

        return
      }

      await startLearning(consented)
    } catch {
      learningStarted.current = false

      if (live.current && generation.current === token) {setFailed(true)}
    } finally {
      if (live.current && generation.current === token) {setPending(null)}
    }
  }, [
    bridge,
    browserImport,
    folderSelected,
    folderView,
    pending,
    rows,
    selectableRows,
    setGate,
    snapshot.googleAssistant,
    startLearning
  ])

  const toggleFoldersRow = useCallback((enabled: boolean) => {
    // The Mac folders tick is the whole list's tick: off unticks every folder, on ticks them all.
    setFolderSelected(enabled && folderView ? new Set(folderView.folders.map(folder => folder.id)) : new Set())
  }, [folderView])

  const toggleFolder = useCallback((id: string, enabled: boolean, foldersGate: MatrixAgentSourceGate) => {
    const next = new Set(folderSelected)

    if (enabled) {next.add(id)}
    else {next.delete(id)}

    setFolderSelected(next)
    // At least one ticked folder keeps Mac folders ticked; none unticks it.
    setSelected(gates => {
      const nextGates = new Set(gates)

      if (next.size > 0) {nextGates.add(foldersGate)}
      else {nextGates.delete(foldersGate)}

      return nextGates
    })
  }, [folderSelected])

  const addFolder = useCallback(async (foldersGate: MatrixAgentSourceGate) => {
    if (!bridge?.folderAccess) {return}

    try {
      const before = new Set(folderView?.folders.map(folder => folder.id) ?? [])
      const next = await bridge.folderAccess.add()

      if (!live.current) {return}

      setFolderView(next)

      const added = next.folders.filter(folder => !before.has(folder.id)).map(folder => folder.id)

      if (added.length) {
        setFolderSelected(current => new Set([...current, ...added]))
        setSelected(gates => new Set([...gates, foldersGate]))
      }
    } catch {
      if (live.current) {setFailed(true)}
    }
  }, [bridge?.folderAccess, folderView])

  const notNow = useCallback(async () => {
    if (!bridge?.firstRun || pending === 'not-now') {return}

    generation.current += 1
    setPendingFullDisk(null)
    setPending('not-now')
    setFailed(false)

    try {
      await bridge.firstRun.decline()

      if (live.current) {setDismissed(true)}
    } catch {
      if (live.current) {setFailed(true)}
    } finally {
      if (live.current) {setPending(null)}
    }
  }, [bridge?.firstRun, pending])

  const openFullDiskSettings = useCallback(async () => {
    if (!bridge?.permissions || !pendingFullDisk || pending !== null) {return}

    setPending('settings')
    setFailed(false)

    try {
      await bridge.permissions.openSettings('fullDisk')
      settingsOpened.current = true

      if (live.current) {
        setStates(current => ({ ...current, [pendingFullDisk.row.gate]: 'settings' }))
      }
    } catch {
      if (live.current) {setFailed(true)}
    } finally {
      if (live.current) {setPending(null)}
    }
  }, [bridge?.permissions, pending, pendingFullDisk])

  const relaunch = useCallback(async () => {
    if (!bridge?.permissions?.relaunch || pending !== null) {return}

    setPending('restart')

    try {
      await bridge.permissions.relaunch()
    } catch {
      if (live.current) {
        setPending(null)
        setFailed(true)
      }
    }
  }, [bridge?.permissions, pending])

  if (dismissed) {return null}

  const folderStatus = (folder: MatrixFolderAccessRow) =>
    !foldersAsked || !folder.shared
      ? null
      : folder.mac === 'denied'
        ? copy.notAllowed
        : folder.mac === 'granted'
          ? copy.done
          : null

  const stateLabel = (row: MatrixKnowledgeSourceRow) => {
    const state = states[row.gate as MatrixAgentSourceGate]

    return row.disabled
      ? sourceCopy.status.unavailable
      : row.checked || state === 'done'
        ? copy.done
        : state === 'working'
          ? copy.working
          : state === 'denied'
            ? copy.notAllowed
            : state === 'unavailable'
              ? copy.unavailable
              : state === 'restart'
                ? copy.restart
                : null
  }

  return (
    <section
      className="ak-ask w-full text-start"
      data-matrix-first-run-connect-card
      style={{ background: 'var(--ak-ground)', boxShadow: 'none', marginTop: 'var(--ak-s4)' }}
    >
        <div className="ak-ask-head">
          <span className="ak-ask-mark"><Sparkles aria-hidden className="ak-icon" /></span>
          <div>
            <h2 className="ak-ask-title">{copy.title}</h2>
            <p className="ak-ask-body">{copy.line}</p>
          </div>
        </div>
        <div className="ak-ask-list" role="list">
          {!view ? (
            <p className="ak-ask-body" role="status">{readFailed ? sourceCopy.readFailed : copy.loading}</p>
          ) : rows.length === 0 ? (
            <p className="ak-ask-body" role="status">{sourceCopy.status.unavailable}</p>
          ) : rows.map(row => {
            const name = row.presentation?.label ?? sourceCopy.names[row.kind]
            const folderList = row.kind === 'folders' && folderView !== null && folderView.folders.length > 0
            // The folder rows say what Mac folders means; the reason for each prompt waits behind (?).
            const detail = folderList ? null : (row.presentation?.description ?? sourceCopy.descriptions[row.kind])
            const tip = folderList
              ? sourceCopy.folderAccess.why
              : row.kind === 'messages'
                ? sourceCopy.folderAccess.fullDisk
                : undefined
            const gate = row.gate as MatrixAgentSourceGate
            const state = states[row.gate as MatrixAgentSourceGate]
            const checked = selected.has(gate)
            const label = stateLabel(row)

            return (
              <div
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-(--ak-s3) border-t"
                data-atum-ask={row.gate}
                key={row.key}
                role="listitem"
                // The kit lays ask rows out as flex; the folders row needs its grid for the list below it.
                style={{
                  borderColor: 'var(--ak-line)',
                  padding: 'var(--ak-s2) 0',
                  ...(folderList ? { display: 'grid' } : {})
                }}
              >
                <MatrixKnowledgeSourceIcon iconDataUrl={row.presentation?.iconDataUrl} kind={row.kind} />
                <span className="ak-row-main min-w-0">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate" style={{ font: 'var(--ak-t-body-strong)' }}>{name}</span>
                    {tip && <SettingsTip label={tip} />}
                  </span>
                  {detail && <span className="ak-row-meta block max-w-full">{detail}</span>}
                </span>
                {state === 'settings' ? (
                  <Button
                    className="ak-btn ak-btn--sm shrink-0"
                    disabled={pending !== null}
                    onClick={() => void openFullDiskSettings()}
                    size="sm"
                    variant="secondary"
                  >
                    {copy.openSettings}
                  </Button>
                ) : state === 'restart' ? (
                  <Button
                    className="ak-btn ak-btn--sm shrink-0"
                    disabled={pending !== null}
                    onClick={() => void relaunch()}
                    size="sm"
                    variant="secondary"
                  >
                    {copy.restart}
                  </Button>
                ) : label ? (
                  <span className="ak-row-meta shrink-0" role="status">{label}</span>
                ) : (
                  <Checkbox
                    aria-label={name}
                    checked={checked}
                    className={`ak-check shrink-0 focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-(--ak-focus) ${checked ? 'is-on' : ''}`}
                    disabled={pending !== null}
                    onCheckedChange={enabled => {
                      setSelected(current => {
                        const next = new Set(current)

                        if (enabled === true) {next.add(gate)}
                        else {next.delete(gate)}

                        return next
                      })

                      if (folderList) {toggleFoldersRow(enabled === true)}
                    }}
                  />
                )}
                {folderList && (
                  <div style={{ gridColumn: '2 / 4', gridRow: 2, paddingTop: 'var(--ak-s1)' }}>
                    <MatrixFirstRunFolderRows
                      copy={sourceCopy.folderAccess}
                      disabled={pending !== null || pendingFullDisk !== null}
                      folders={folderView.folders}
                      onAdd={bridge?.folderAccess ? () => void addFolder(gate) : undefined}
                      onToggle={(id, enabled) => toggleFolder(id, enabled, gate)}
                      selected={folderSelected}
                      status={folderStatus}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="ak-ask-actions">
          <Button
            aria-busy={pending === 'continue' || undefined}
            className="ak-btn ak-btn--primary ak-btn--sm"
            disabled={!view || !canContinue || pending !== null || pendingFullDisk !== null || !bridge?.firstRun}
            onClick={() => void runSelection(selected)}
            size="sm"
          >
            {copy.continue}
          </Button>
          <Button
            className="ak-btn ak-btn--plain ak-btn--sm"
            disabled={pending === 'not-now' || !bridge?.firstRun}
            onClick={() => void notNow()}
            size="sm"
            variant="text"
          >
            {copy.notNow}
          </Button>
        </div>
        {failed && <NoticeBand className="mt-2" role="status" tone="failure">{copy.failed}</NoticeBand>}
      </section>
  )
}
