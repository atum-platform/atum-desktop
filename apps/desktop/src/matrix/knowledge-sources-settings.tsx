import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'

import { GoogleMark } from '@/components/brand/google-mark'
import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Briefcase, Compass, Database, Folder, Globe, Messages } from '@/lib/icons'

import type {
  MatrixAgentSourceGate,
  MatrixAgentSourcesBridge,
  MatrixAgentSourcesView,
  MatrixReachMac
} from '../../shared/matrix-agent-sources'
import { MATRIX_SOURCE_SERVICE_UPDATE_REQUIRED, safeMatrixAgentSourceIconDataUrl } from '../../shared/matrix-agent-sources'
import type { MatrixFolderAccessBridge, MatrixFolderAccessView } from '../../shared/matrix-folder-access'
import { matrixKnowledgeSourcesCopy, type MatrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'
import type { MatrixPermission, MatrixPermissionsBridge } from '../../shared/matrix-permissions'

import { MatrixSettingsFolderRows } from './folder-access-rows'
import {
  type MatrixKnowledgeSourceKind,
  type MatrixKnowledgeSourceRow,
  projectMatrixKnowledgeSourceRows
} from './knowledge-source-projection'
import { MatrixYourMacsSection } from './mac-reach-rows'
import { useNoticePresented } from './notice-presented'
import { SettingsRow, SettingsSection } from './settings-row'

export interface MatrixSourceLine {
  /** Replaces the ordinary description; absent keeps it. */
  text?: string
  /** Warning ink: only for a switch an older Mac turned back off. */
  warn?: boolean
  /** Replaces the row's (?) when the line needs its own explanation. */
  tip?: string
  /** The one fix this Mac can make. */
  action?: { kind: 'settings'; pane: MatrixPermission } | { kind: 'retry' }
}

/**
 * U1 §4.2: the one quiet line under a source. The switch is the account's choice; the line says
 * where it works today, and speaks only when it can't work anywhere, or when an older Mac switched
 * it back off (server evidence only). Main's `macSourceStatus()` owns precedence; this only words it.
 */
export function matrixSourceLine(
  row: Pick<MatrixKnowledgeSourceRow, 'checked' | 'heldOffBy' | 'permission' | 'status' | 'statusMac'>,
  macs: readonly MatrixReachMac[],
  copy: MatrixKnowledgeSourcesCopy
): MatrixSourceLine {
  if (!row.checked) {
    const heldOffBy = row.heldOffBy?.filter(Boolean) ?? []

    return row.status === 'held_off_by_older_mac' && row.heldOffBy?.length
      ? { text: copy.status.heldOff, warn: true, ...(heldOffBy.length ? { tip: copy.status.heldOffTip(heldOffBy.join(', ')) } : {}) }
      : {}
  }

  const thisMac = macs.find(mac => mac.thisMac)
  const here = !row.statusMac || (thisMac !== undefined && row.statusMac === thisMac.name)

  switch (row.status) {
    case 'ready':

    case 'held_off_by_older_mac':
      return {}

    case 'needs_permission':
      if (row.permission !== 'fullDisk') {
        return { text: copy.status.needsPermission }
      }

      return here
        ? { text: copy.status.needsFullDiskHere, action: { kind: 'settings', pane: 'fullDisk' } }
        : { text: copy.status.needsFullDiskOn(row.statusMac!) }

    case 'update_mac':
      return row.statusMac ? { text: copy.status.updateMac(row.statusMac) } : { text: copy.status.unavailable }

    case 'mac_offline':
      return { text: row.statusMac ? copy.status.macOffline(row.statusMac) : copy.status.macsOffline }

    case 'this_mac_disconnected':
      return { text: copy.status.thisMacDisconnected, action: { kind: 'retry' } }

    case 'not_connected':
      return { text: copy.status.notConnected }

    case 'needs_mac':
      return { text: copy.status.needsMac }

    case 'unavailable':
      return { text: copy.status.unavailable }
  }
}

const ICONS: Record<Exclude<MatrixKnowledgeSourceKind, 'google'>, ReactNode> = {
  folders: <Folder aria-hidden className="size-4" />,
  messages: <Messages aria-hidden className="size-4" />,
  browser: <Globe aria-hidden className="size-4" />,
  location: <Compass aria-hidden className="size-4" />,
  teamSpaces: <Briefcase aria-hidden className="size-4" />,
  unknown: <Database aria-hidden className="size-4" />
}

export function MatrixKnowledgeSourceIcon({ kind, iconDataUrl }: { kind: MatrixKnowledgeSourceKind; iconDataUrl?: string }) {
  const safeIconDataUrl = safeMatrixAgentSourceIconDataUrl(iconDataUrl)

  if (safeIconDataUrl) {
    return (
      <ConsentBoundary><span aria-hidden className="ak-appicon ak-appicon--sm">
        <img alt="" className="size-full object-cover" src={safeIconDataUrl} />
      </span></ConsentBoundary>
    )
  }

  return kind === 'google' ? (
    <GoogleMark className="size-4 shrink-0" />
  ) : (
    <span aria-hidden className="shrink-0 text-(--ak-ink-3)">
      {ICONS[kind]}
    </span>
  )
}

export function MatrixKnowledgeSourcesSettings({
  bridge = window.atumMatrix?.agentSources,
  folderAccess = window.atumMatrix?.folderAccess,
  permissions = window.atumMatrix?.permissions,
  onRetry = () => void window.atumMatrix?.retry?.().catch(() => undefined)
}: {
  bridge?: MatrixAgentSourcesBridge
  folderAccess?: MatrixFolderAccessBridge
  permissions?: MatrixPermissionsBridge
  /** Reconnects this Mac (the "Try again" beside a source or this Mac's row). */
  onRetry?: () => void
}) {
  const { locale } = useI18n()
  const copy = matrixKnowledgeSourcesCopy[locale]
  const mounted = useRef(true)
  const request = useRef(0)
  const [view, setView] = useState<MatrixAgentSourcesView | null>(null)
  const [busy, setBusy] = useState<MatrixAgentSourceGate | null>(null)
  const busyRef = useRef<MatrixAgentSourceGate | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [serviceUpdate, setServiceUpdate] = useState(false)
  const [folders, setFolders] = useState<MatrixFolderAccessView | null>(null)
  const [foldersBusy, setFoldersBusy] = useState(false)
  const section = useRef<HTMLElement | null>(null)

  // The section's help line is one of the three places the disclosure lives: seen here, it counts.
  useNoticePresented(Boolean(view?.notice && bridge?.presented), () => void bridge?.presented?.().catch(() => undefined), section)

  useEffect(() => {
    let current = true

    void folderAccess?.read().then(
      next => {
        if (current && next.platform === 'macos') {
          setFolders(next)
        }
      },
      () => undefined
    )

    return () => {
      current = false
    }
  }, [folderAccess])

  /** One folder change at a time; turning a folder on may show its macOS prompt. */
  const changeFolders = async (work: (access: MatrixFolderAccessBridge) => Promise<MatrixFolderAccessView>) => {
    if (!folderAccess || foldersBusy) {
      return
    }

    setFoldersBusy(true)
    setFailed(false)

    try {
      const next = await work(folderAccess)

      if (mounted.current) {
        setFolders(next)
      }
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      if (mounted.current) {
        setFoldersBusy(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    const token = ++request.current
    setView(null)
    setBusy(null)
    setFailed(false)

    if (bridge) {
      void bridge.read().then(
        next => {
          if (mounted.current && request.current === token) {
            setView(next)
          }
        },
        () => {
          if (mounted.current && request.current === token) {
            setFailed(true)
          }
        }
      )
    }

    return () => {
      mounted.current = false
      request.current += 1
    }
  }, [bridge, readAttempt])

  /**
   * The saved account switches can change elsewhere (the first-run ask, another Settings window,
   * a macOS permission granted in System Settings). Re-read on those signals; a quiet refresh never
   * blanks the list, never shows an error, and yields to a save in flight.
   */
  useEffect(() => {
    if (!bridge) {
      return
    }

    const refresh = () => {
      if (busyRef.current !== null) {
        return
      }

      const token = ++request.current

      void bridge.read().then(
        next => {
          if (mounted.current && request.current === token) {
            setView(next)
            setFailed(false)
          }
        },
        () => undefined
      )
    }

    const visible = () => {
      if (window.document.visibilityState === 'visible') {
        refresh()
      }
    }

    const unsubscribe = bridge.subscribe?.(refresh)
    window.addEventListener('focus', refresh)
    window.document.addEventListener('visibilitychange', visible)

    return () => {
      unsubscribe?.()
      window.removeEventListener('focus', refresh)
      window.document.removeEventListener('visibilitychange', visible)
    }
  }, [bridge])

  const change = async (gate: MatrixAgentSourceGate, enabled: boolean) => {
    if (!bridge || !view || busy) {
      return
    }

    const token = ++request.current
    const previous = view
    busyRef.current = gate
    setBusy(gate)
    setFailed(false)
    setServiceUpdate(false)
    setView({ ...view, gates: { ...view.gates, [gate]: enabled } })

    try {
      // The answer is the record main just saved, so the switch settles on the truth.
      const saved = await bridge.set(gate, enabled)

      if (mounted.current && request.current === token) {
        setView(saved)
      }
    } catch (error) {
      setServiceUpdate(error instanceof Error && error.message.includes(MATRIX_SOURCE_SERVICE_UPDATE_REQUIRED))
      // Show what is actually saved, not a guess: re-read the account record.
      const truth = await bridge.read().catch(() => previous)

      if (mounted.current && request.current === token) {
        setView(truth)
        setFailed(true)
      }
    } finally {
      busyRef.current = null

      if (mounted.current && request.current === token) {
        setBusy(null)
      }
    }
  }

  /** After System Settings, the folder is checked again on return; a denied folder never re-prompts. */
  const openFolderSettings = async (systemPermissions: MatrixPermissionsBridge, id: string) => {
    window.addEventListener('focus', () => void changeFolders(access => access.apply({ [id]: true })), { once: true })

    try {
      await systemPermissions.openSettings('files')
    } catch {
      setFailed(true)
    }
  }

  const rows = view ? projectMatrixKnowledgeSourceRows(view) : []
  const macs = view?.macs ?? []

  return (
    <ConsentBoundary><>
    <SettingsSection
      data-matrix-knowledge-sources
      foot={failed && view ? serviceUpdate ? copy.serviceUpdateRequired : copy.failed : undefined}
      help={copy.sectionHelp}
      ref={section}
      tip={copy.sectionTip}
      title={copy.title}
    >
      {!bridge ? (
        <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.unavailable} />
      ) : failed && !view ? (
        <SettingsRow
          className="atum-settings-row-quiet"
          control={
            <Button onClick={() => setReadAttempt(attempt => attempt + 1)} size="sm" variant="secondary">
              {copy.retry}
            </Button>
          }
          role="status"
          title={copy.readFailed}
        />
      ) : view && rows.length === 0 ? (
        <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.status.unavailable} />
      ) : (
        rows.map(row => {
          const name = row.presentation?.label ?? copy.names[row.kind]
          const ordinaryHelp = row.presentation?.description ?? copy.descriptions[row.kind]
          // The switch is the saved choice; this one quiet line says where it works today.
          const line = matrixSourceLine(row, macs, copy)

          const help = line.text ? (
            <span className={line.warn ? 'text-(--ak-warn)' : undefined} data-matrix-knowledge-source-line={line.warn ? 'warn' : 'status'}>
              {line.text}
            </span>
          ) : (
            ordinaryHelp
          )

          const details =
            row.kind === 'messages' ? `${copy.details.messages} ${copy.folderAccess.fullDisk}` : copy.details[row.kind]

          const tip = line.tip ?? details
          const pane = line.action?.kind === 'settings' && permissions ? line.action.pane : undefined

          return (
            <Fragment key={row.key}>
              <SettingsRow
                control={
                  <span className="flex items-center gap-(--ak-s2)">
                    {pane && permissions && (
                      <Button
                        data-matrix-knowledge-source-permission={pane}
                        onClick={() => void permissions.openSettings(pane).catch(() => setFailed(true))}
                        size="sm"
                        variant="secondary"
                      >
                        {copy.folderAccess.openSettings}
                      </Button>
                    )}
                    {line.action?.kind === 'retry' && (
                      <Button data-matrix-knowledge-source-retry onClick={onRetry} size="sm" variant="secondary">
                        {copy.macs.tryAgain}
                      </Button>
                    )}
                    <Switch
                      aria-label={name}
                      checked={row.checked}
                      disabled={!view || busy !== null || !row.switchable}
                      onCheckedChange={enabled => {
                        if (row.switchable) {
                          void change(row.gate as MatrixAgentSourceGate, enabled)
                        }
                      }}
                    />
                  </span>
                }
                data-matrix-knowledge-source={row.gate}
                data-matrix-knowledge-source-kinds={row.kinds.join(' ')}
                data-matrix-knowledge-source-status={row.status}
                help={help}
                lead={<MatrixKnowledgeSourceIcon iconDataUrl={row.presentation?.iconDataUrl} kind={row.kind} />}
                tip={tip}
                title={<span className="[font:var(--ak-t-body-strong)]">{name}</span>}
              />
              {row.kind === 'folders' && row.checked && folders && (
                <MatrixSettingsFolderRows
                  busy={foldersBusy || busy !== null}
                  copy={copy.folderAccess}
                  folders={folders.folders}
                  onAdd={() => void changeFolders(access => access.add())}
                  onOpenSettings={permissions ? id => void openFolderSettings(permissions, id) : undefined}
                  onRemove={id => void changeFolders(access => access.remove(id))}
                  onToggle={(id, enabled) => void changeFolders(access => access.apply({ [id]: enabled }))}
                />
              )}
            </Fragment>
          )
        })
      )}
    </SettingsSection>
    {view && <MatrixYourMacsSection macs={macs} onRetry={onRetry} permissions={permissions} />}
    </></ConsentBoundary>
  )
}
