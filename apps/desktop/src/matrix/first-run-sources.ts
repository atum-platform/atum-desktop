import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAgentSourceGate, MatrixAgentSourcesView } from '../../shared/matrix-agent-sources'
import type { MatrixBrowserImportBridge } from '../../shared/matrix-browser-import'
import {
  matrixFolderAccessChoices,
  matrixFolderAccessSelection,
  type MatrixFolderAccessView
} from '../../shared/matrix-folder-access'
import { type MatrixGoogleAssistantAccess, matrixGoogleConnectOffered } from '../../shared/matrix-google-tools'
import type { MatrixPermissionsSnapshot } from '../../shared/matrix-permissions'

import { type MatrixKnowledgeSourceKind, projectMatrixKnowledgeSourceRows } from './knowledge-source-projection'

export type FirstRunSourcesBridge = Pick<
  MatrixUiBridge,
  'agentSources' | 'firstRun' | 'folderAccess' | 'googleConnections' | 'ownerLocation' | 'permissions'
>

/** A row of the one Connections list: Connect, a spinner, Connected (Ready when it was already on), or Skipped. */
export type FirstRunRowState = 'connect' | 'connecting' | 'connected' | 'ready' | 'skipped' | 'settings' | 'restart'

/** Why an unconnected row is back on Connect. */
export type FirstRunRowNote = 'notAllowed' | 'unavailable' | 'fullDisk'

export interface FirstRunSourceRow {
  key: string
  gate: MatrixAgentSourceGate
  kind: MatrixKnowledgeSourceKind
  label?: string
  description?: string
  iconDataUrl?: string
  /** The folders a Connect opens (standard kinds or an added folder's own name). */
  folders?: { kind: string; name?: string }[]
  state: FirstRunRowState
  note?: FirstRunRowNote
}

type Step = 'working' | 'done' | 'denied' | 'unavailable' | 'settings' | 'restart'

const ACCOUNT_KINDS: ReadonlySet<MatrixKnowledgeSourceKind> = new Set(['google'])

export function isFirstRunAccountRow(row: Pick<FirstRunSourceRow, 'kind'>): boolean {
  return ACCOUNT_KINDS.has(row.kind)
}

function fullDiskGranted(snapshot: MatrixPermissionsSnapshot | null | undefined): boolean {
  return snapshot?.platform === 'macos' && snapshot.permissions.fullDisk === 'granted'
}

function fullDiskAskable(snapshot: MatrixPermissionsSnapshot | null | undefined): boolean {
  return (
    snapshot?.platform === 'macos' &&
    snapshot.permissions.fullDisk !== 'restricted' &&
    snapshot.permissions.fullDisk !== 'unknown'
  )
}

/**
 * The source rows of the one first-run Connections list (Google, then This Mac), from the same descriptor projection Settings
 * uses. Each row has its own Connect; macOS asks only from the row that needs it, one prompt at a time:
 * - folders: one prompt per default-ticked folder, in turn (which folders, and Add folder, live in Settings › Connections);
 * - Google: the account's own sign-in in the browser, once;
 * - Messages: Full Disk Access in System Settings, then the row finishes on its own (or asks for a restart);
 * - Browser: the import; Location: the city switch (on by default).
 *
 * The first source that connects admits first learning (`firstRun.start`), once, while the first run is offered. "Skip the rest"
 * marks every open row skipped and, if nothing was connected, declines first learning as "Not now" did.
 */
export function useFirstRunSources({
  bridge,
  browserImport,
  googleAssistant,
  learningOffered,
  locale,
  roomId
}: {
  bridge?: FirstRunSourcesBridge
  browserImport?: MatrixBrowserImportBridge
  googleAssistant?: MatrixGoogleAssistantAccess
  /** The first run still waits on the person's yes (snapshot.firstRun === 'offer'). */
  learningOffered: boolean
  locale: string
  roomId?: string
}) {
  const live = useRef(true)
  const learningStarted = useRef(false)
  const settingsOpened = useRef(false)
  const leftForSettings = useRef(false)
  const initiallyOn = useRef<Set<string> | null>(null)
  const [view, setView] = useState<MatrixAgentSourcesView | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [folderView, setFolderView] = useState<MatrixFolderAccessView | null>(null)
  const [steps, setSteps] = useState<Partial<Record<string, Step>>>({})
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [waitingFullDisk, setWaitingFullDisk] = useState<MatrixAgentSourceGate | null>(null)

  const step = useCallback((gate: string, next: Step | undefined) => {
    if (live.current) {
      setSteps(current => ({ ...current, [gate]: next }))
    }
  }, [])

  const read = useCallback(async () => {
    setReadFailed(false)

    try {
      const next = await bridge!.agentSources!.read()

      if (!live.current) {
        return
      }

      initiallyOn.current ??= new Set(Object.entries(next.gates).filter(([, on]) => on).map(([gate]) => gate))
      setView(next)
    } catch {
      if (live.current) {
        setReadFailed(true)
      }
    }
  }, [bridge])

  useEffect(() => {
    live.current = true

    if (bridge?.agentSources) {
      void read()
    }

    void bridge?.folderAccess?.read().then(
      next => {
        if (live.current && next.platform === 'macos') {
          setFolderView(next)
        }
      },
      () => undefined
    )

    return () => {
      live.current = false
    }
  }, [bridge?.agentSources, bridge?.folderAccess, read])

  const projected = useMemo(() => (view ? projectMatrixKnowledgeSourceRows(view) : []), [view])

  const startLearning = useCallback(async () => {
    if (learningStarted.current || !learningOffered || !bridge?.firstRun) {
      return
    }

    learningStarted.current = true

    try {
      // Location starts on for a new account (no macOS prompt); admitting learning also turns on its city.
      if (bridge.ownerLocation && projected.some(row => row.kind === 'location' && row.checked)) {
        await bridge.ownerLocation.setEnabled(true).catch(() => undefined)
      }

      if (bridge.firstRun.start) {
        await bridge.firstRun.start({ locale, ending: 'done', ...(roomId ? { roomId } : {}) })
      } else {
        await bridge.firstRun.allow({ locale, ...(roomId ? { roomId } : {}) })
      }
    } catch {
      learningStarted.current = false

      if (live.current) {
        setFailed(true)
      }
    }
  }, [bridge?.firstRun, bridge?.ownerLocation, learningOffered, locale, projected, roomId])

  const setGate = useCallback(async (gate: MatrixAgentSourceGate) => {
    if (!bridge?.agentSources) {
      return false
    }

    try {
      const next = await bridge.agentSources.set(gate, true)

      if (live.current) {
        setView(next)
      }

      step(gate, 'done')
      await startLearning()

      return true
    } catch {
      step(gate, 'unavailable')

      return false
    }
  }, [bridge?.agentSources, startLearning, step])

  const connect = useCallback(async (gate: MatrixAgentSourceGate) => {
    const row = projected.find(item => item.gate === gate)

    if (!row || !bridge?.agentSources || steps[gate] === 'working') {
      return
    }

    setFailed(false)
    setSkipped(current => {
      const next = new Set(current)
      next.delete(gate)

      return next
    })
    step(gate, 'working')

    try {
      if (row.kind === 'folders' && folderView && bridge.folderAccess) {
        // Every folder choice is saved; macOS asks once for each default-ticked folder, one prompt after another.
        const next = await bridge.folderAccess.apply(matrixFolderAccessChoices(folderView, matrixFolderAccessSelection(folderView)))

        if (live.current) {
          setFolderView(next)
        }

        if (!next.folders.some(folder => folder.shared && folder.mac !== 'denied')) {
          step(gate, 'denied')

          return
        }
      }

      if (row.kind === 'google' && matrixGoogleConnectOffered(googleAssistant)) {
        const result = await bridge.googleConnections?.connect('google')
        const connected = result?.status?.sources.some(item => item.state === 'connected' && item.enabled)

        if (!connected) {
          step(gate, result?.error === 'cancelled' || result?.error === 'denied' ? 'denied' : 'unavailable')

          return
        }
      }

      if (row.kind === 'browser') {
        await browserImport?.run().catch(() => undefined)
      }

      if (row.kind === 'location' && bridge.ownerLocation) {
        await bridge.ownerLocation.setEnabled(true).catch(() => undefined)
      }

      if (row.kind === 'messages') {
        const permission = (await bridge.permissions?.status().catch(() => null)) ?? null

        if (!fullDiskGranted(permission)) {
          if (fullDiskAskable(permission) && bridge.permissions) {
            setWaitingFullDisk(gate)
            await bridge.permissions.openSettings('fullDisk')
            settingsOpened.current = true
            step(gate, 'settings')
          } else {
            step(gate, 'unavailable')
          }

          return
        }
      }

      await setGate(gate)
    } catch {
      step(gate, undefined)

      if (live.current) {
        setFailed(true)
      }
    }
  }, [bridge, browserImport, folderView, googleAssistant, projected, setGate, step, steps])

  // Full Disk Access is granted in System Settings: the waiting row finishes by itself, or asks for a restart.
  const takePermission = useCallback((next: MatrixPermissionsSnapshot) => {
    if (!live.current || !waitingFullDisk) {
      return
    }

    if (fullDiskGranted(next)) {
      const gate = waitingFullDisk
      setWaitingFullDisk(null)
      step(gate, 'working')
      void setGate(gate)
    } else if (!fullDiskAskable(next)) {
      step(waitingFullDisk, 'unavailable')
      setWaitingFullDisk(null)
    }
  }, [setGate, step, waitingFullDisk])

  useEffect(() => {
    if (!bridge?.permissions || !waitingFullDisk) {
      return
    }

    const stop = bridge.permissions.watch?.(takePermission)

    const blur = () => {
      if (settingsOpened.current) {
        leftForSettings.current = true
      }
    }

    const focus = () => {
      if (!settingsOpened.current || !leftForSettings.current) {
        return
      }

      void bridge.permissions!.status().then(next => {
        takePermission(next)

        if (next.platform === 'macos' && next.permissions.fullDisk === 'not-granted') {
          step(waitingFullDisk, 'restart')
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
  }, [bridge?.permissions, step, takePermission, waitingFullDisk])

  const openFullDiskSettings = useCallback(async () => {
    if (!bridge?.permissions) {
      return
    }

    try {
      await bridge.permissions.openSettings('fullDisk')
      settingsOpened.current = true
    } catch {
      setFailed(true)
    }
  }, [bridge?.permissions])

  const relaunch = useCallback(async () => {
    try {
      await bridge?.permissions?.relaunch?.()
    } catch {
      setFailed(true)
    }
  }, [bridge?.permissions])

  const rows = useMemo<FirstRunSourceRow[]>(() => {
    const folders = folderView?.folders
      .filter(folder => matrixFolderAccessSelection(folderView).has(folder.id))
      .map(folder => ({ kind: folder.kind, ...(folder.name ? { name: folder.name } : {}) }))

    return projected
      // Rows with nothing to offer on this account are hidden, not shown as dead switches.
      .filter(row => !row.disabled)
      .map(row => {
        const gate = row.gate as MatrixAgentSourceGate
        const current = steps[gate]

        const state: FirstRunRowState = row.checked
          ? initiallyOn.current?.has(gate) && current !== 'done'
            ? 'ready'
            : 'connected'
          : current === 'working'
            ? 'connecting'
            : current === 'settings'
              ? 'settings'
              : current === 'restart'
                ? 'restart'
                : skipped.has(gate)
                  ? 'skipped'
                  : 'connect'

        const note: FirstRunRowNote | undefined =
          state !== 'connect'
            ? undefined
            : current === 'denied'
              ? 'notAllowed'
              : current === 'unavailable'
                ? 'unavailable'
                : undefined

        return {
          key: row.key,
          gate,
          kind: row.kind,
          ...(row.presentation?.label ? { label: row.presentation.label } : {}),
          ...(row.presentation?.description ? { description: row.presentation.description } : {}),
          ...(row.presentation?.iconDataUrl ? { iconDataUrl: row.presentation.iconDataUrl } : {}),
          ...(row.kind === 'folders' && folders?.length ? { folders } : {}),
          ...(row.kind === 'messages' && (state === 'settings' || state === 'restart') ? { note: 'fullDisk' as const } : {}),
          ...(note ? { note } : {}),
          state
        }
      })
  }, [folderView, projected, skipped, steps])

  /** Marks every open row skipped; with nothing connected, first learning is declined ("Not now"). */
  const skipRest = useCallback(async () => {
    setSkipped(new Set(rows.filter(row => row.state === 'connect').map(row => row.gate)))
    setWaitingFullDisk(null)

    if (!learningStarted.current && learningOffered && bridge?.firstRun) {
      learningStarted.current = true

      try {
        await bridge.firstRun.decline()
      } catch {
        learningStarted.current = false

        if (live.current) {
          setFailed(true)
        }
      }
    }
  }, [bridge?.firstRun, learningOffered, rows])

  return {
    rows,
    loading: Boolean(bridge?.agentSources) && !view && !readFailed,
    readFailed,
    failed,
    connect,
    openFullDiskSettings,
    relaunch,
    skipRest,
    retryRead: read
  }
}
