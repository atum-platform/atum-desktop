import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'

import { GoogleMark } from '@/components/brand/google-mark'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Briefcase, Compass, Database, Folder, Globe, Messages } from '@/lib/icons'

import type {
  MatrixAgentSourceGate,
  MatrixAgentSourcesBridge,
  MatrixAgentSourceStatus,
  MatrixAgentSourcesView
} from '../../shared/matrix-agent-sources'
import { safeMatrixAgentSourceIconDataUrl } from '../../shared/matrix-agent-sources'
import type { MatrixFolderAccessBridge, MatrixFolderAccessView } from '../../shared/matrix-folder-access'
import { matrixKnowledgeSourcesCopy, type MatrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'
import type { MatrixPermissionsBridge } from '../../shared/matrix-permissions'

import { MatrixSettingsFolderRows } from './folder-access-rows'
import { type MatrixKnowledgeSourceKind, projectMatrixKnowledgeSourceRows } from './knowledge-source-projection'
import { SettingsRow, SettingsSection } from './settings-row'

/** Which status gets a line of its own; `ready` keeps the ordinary description. */
const STATUS_COPY: Record<MatrixAgentSourceStatus, keyof MatrixKnowledgeSourcesCopy['status'] | null> = {
  ready: null,
  mac_only: 'macOnly',
  needs_permission: 'needsPermission',
  not_connected: 'notConnected',
  needs_mac: 'needsMac',
  unavailable: 'unavailable'
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
      <span aria-hidden className="ak-appicon ak-appicon--sm">
        <img alt="" className="size-full object-cover" src={safeIconDataUrl} />
      </span>
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
  permissions = window.atumMatrix?.permissions
}: {
  bridge?: MatrixAgentSourcesBridge
  folderAccess?: MatrixFolderAccessBridge
  permissions?: MatrixPermissionsBridge
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
  const [folders, setFolders] = useState<MatrixFolderAccessView | null>(null)
  const [foldersBusy, setFoldersBusy] = useState(false)

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
    setView({ ...view, gates: { ...view.gates, [gate]: enabled } })

    try {
      // The answer is the record main just saved, so the switch settles on the truth.
      const saved = await bridge.set(gate, enabled)

      if (mounted.current && request.current === token) {
        setView(saved)
      }
    } catch {
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

  return (
    <SettingsSection data-matrix-knowledge-sources foot={failed && view ? copy.failed : undefined} title={copy.title}>
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
          const status = row.checked ? STATUS_COPY[row.status] : null
          const help = status ? copy.status[status] : ordinaryHelp

          const details =
            row.kind === 'messages' ? `${copy.details.messages} ${copy.folderAccess.fullDisk}` : copy.details[row.kind]

          const tip = row.status === 'mac_only' ? `${details} ${copy.macOnlyDetail}` : details
          const pane = row.checked && permissions ? row.permission : undefined

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
  )
}
