import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ChevronRight, DeviceDesktop } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixAgentSourcesBridge, MatrixReachMac } from '../../shared/matrix-agent-sources'
import { matrixKnowledgeSourcesCopy, type MatrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'
import type { MatrixPermission, MatrixPermissionsBridge } from '../../shared/matrix-permissions'

import { matrixDeviceLastSeen } from './device-last-seen'
import { SettingsRow, SettingsSection, SettingsStatus } from './settings-row'

type MacState = MatrixReachMac['state']
type MacSourceKind = keyof NonNullable<MatrixReachMac['sources']>

/** Green only when ready; the warning colour where something needs doing; quiet when out of reach. */
const MAC_DOT: Record<MacState, string> = {
  ready: 'bg-(--ak-ok)',
  needs_permission: 'bg-(--ak-warn)',
  older: 'bg-(--ak-warn)',
  offline: 'bg-(--ak-ink-3)',
  not_connected: 'bg-(--ak-ink-3)'
}

const MAC_WORD: Record<MacState, keyof MatrixKnowledgeSourcesCopy['macs']> = {
  ready: 'ready',
  needs_permission: 'needsPermission',
  older: 'older',
  offline: 'offline',
  not_connected: 'notConnectedWord'
}

/** The sources that wait on Full Disk Access; Location and folders have panes of their own. */
const FULL_DISK_KINDS: readonly MacSourceKind[] = ['messages', 'browser']
const KIND_ORDER: readonly MacSourceKind[] = ['messages', 'browser', 'location', 'folders']

function localeTag(locale: string): string {
  return locale === 'zh-hant' ? 'zh-Hant' : locale
}

/** "Messages, Browser and Location" in the window's language. */
export function matrixSourceList(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(localeTag(locale), { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

export function matrixMacStateWord(copy: MatrixKnowledgeSourcesCopy, state: MacState): string {
  return copy.macs[MAC_WORD[state]] as string
}

/** The status word always sits beside its dot, so colour is never the only signal. */
export function MatrixMacState({ copy, state }: { copy: MatrixKnowledgeSourcesCopy; state: MacState }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-matrix-mac-state={state}>
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', MAC_DOT[state])} />
      {matrixMacStateWord(copy, state)}
    </span>
  )
}

export interface MatrixMacRowLine {
  help?: string
  /** The one fixing action, only where this Mac can take it. */
  action?: { kind: 'settings'; pane: MatrixPermission } | { kind: 'retry' }
}

/** U1 §4.1: what a Mac row says under its name, and the one thing this Mac can do about it. */
export function matrixMacRowLine(
  mac: MatrixReachMac,
  copy: MatrixKnowledgeSourcesCopy,
  locale: string,
  now = Date.now()
): MatrixMacRowLine {
  switch (mac.state) {
    case 'ready':
      return {}
    case 'needs_permission': {
      const waiting = KIND_ORDER.filter(kind => mac.sources?.[kind] === 'needs_permission')
      const fullDisk = waiting.filter(kind => FULL_DISK_KINDS.includes(kind))

      if (!mac.thisMac) {
        return { help: fullDisk.length ? copy.macs.allowThere : copy.status.needsPermission }
      }

      const pane: MatrixPermission | undefined = fullDisk.length
        ? 'fullDisk'
        : waiting.includes('location')
          ? 'location'
          : waiting.includes('folders')
            ? 'files'
            : undefined

      return {
        help: fullDisk.length
          ? copy.macs.needsFullDisk(matrixSourceList(fullDisk.map(kind => copy.names[kind]), locale))
          : copy.status.needsPermission,
        ...(pane ? { action: { kind: 'settings' as const, pane } } : {})
      }
    }

    case 'offline':
      return mac.lastSeenAt ? { help: copy.macs.lastSeen(matrixDeviceLastSeen(mac.lastSeenAt, locale, now)) } : {}

    case 'older':
      return { help: copy.macs.updateThere }

    case 'not_connected':
      return { help: copy.macs.notConnected, ...(mac.thisMac ? { action: { kind: 'retry' as const } } : {}) }
  }
}

/** This Mac first, then the others by name. */
export function matrixOrderedMacs(macs: readonly MatrixReachMac[]): MatrixReachMac[] {
  return [...macs].sort((a, b) => Number(b.thisMac) - Number(a.thisMac) || a.name.localeCompare(b.name))
}

function MacGlyph() {
  return (
    <span aria-hidden className="shrink-0 text-(--ak-ink-3)">
      <DeviceDesktop className="size-4" />
    </span>
  )
}

function ThisMacTag({ copy }: { copy: MatrixKnowledgeSourcesCopy }) {
  return (
    <span className="ak-badge ak-badge--quiet ms-1.5 shrink-0" data-matrix-mac-this>
      {copy.macs.thisMac}
    </span>
  )
}

/**
 * Settings › Connections › Your Macs (U1 §4.1): one row per Mac on the account, each with its
 * state and at most one action, the one this Mac can take. On another Mac the same row shows
 * that Mac's own button; that is where the fix happens.
 */
export function MatrixYourMacsSection({
  macs,
  now,
  onRetry = () => void window.atumMatrix?.retry?.().catch(() => undefined),
  permissions
}: {
  macs: readonly MatrixReachMac[]
  now?: number
  onRetry?: () => void
  permissions?: MatrixPermissionsBridge
}) {
  const { locale } = useI18n()
  const copy = matrixKnowledgeSourcesCopy[locale]

  if (macs.length === 0) {
    return null
  }

  return (
    <SettingsSection data-matrix-your-macs tip={copy.macs.tip} title={copy.macs.title}>
      {matrixOrderedMacs(macs).map(mac => {
        const line = matrixMacRowLine(mac, copy, locale, now)
        const action = line.action
        const pane = action?.kind === 'settings' && permissions ? action.pane : undefined

        return (
          <SettingsRow
            control={
              pane && permissions ? (
                <Button
                  data-matrix-mac-action="settings"
                  onClick={() => void permissions.openSettings(pane).catch(() => undefined)}
                  size="sm"
                  variant="secondary"
                >
                  {copy.folderAccess.openSettings}
                </Button>
              ) : action?.kind === 'retry' ? (
                <Button data-matrix-mac-action="retry" onClick={onRetry} size="sm" variant="secondary">
                  {copy.macs.tryAgain}
                </Button>
              ) : (
                <SettingsStatus role="status">
                  <MatrixMacState copy={copy} state={mac.state} />
                </SettingsStatus>
              )
            }
            data-matrix-mac={mac.thisMac ? 'this' : 'other'}
            data-matrix-mac-row={mac.state}
            help={line.help}
            key={mac.id}
            lead={<MacGlyph />}
            title={
              <span className="inline-flex min-w-0 items-center">
                <span className="truncate [font:var(--ak-t-body-strong)]">{mac.name}</span>
                {mac.thisMac && <ThisMacTag copy={copy} />}
              </span>
            }
          />
        )
      })}
    </SettingsSection>
  )
}

/**
 * The assistant home popover's read-only "Can use" list (U1 §2): the same Macs, words and dots as
 * Connections. A row with something to fix opens Connections; a ready row is plain text.
 */
export function MatrixCanUseList({
  emptyLabel,
  label,
  macs,
  onFix
}: {
  emptyLabel: string
  label: string
  macs: readonly MatrixReachMac[]
  onFix?: () => void
}) {
  const { locale } = useI18n()
  const copy = matrixKnowledgeSourcesCopy[locale]

  return (
    <div data-agent-home-can-use>
      <div className="ak-menu-sep" />
      <div className="ak-menu-label">{label}</div>
      {macs.length === 0 ? (
        <p className="px-2.5 py-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-no-mac>
          {emptyLabel}
        </p>
      ) : (
        matrixOrderedMacs(macs).map(mac => {
          const body = (
            <>
              <MacGlyph />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{mac.name}</span>
                {mac.thisMac && (
                  <span className="block truncate [font:var(--ak-t-caption)] text-(--ak-ink-3)">{copy.macs.thisMac}</span>
                )}
              </span>
              <span className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">
                <MatrixMacState copy={copy} state={mac.state} />
              </span>
            </>
          )

          return mac.state !== 'ready' && onFix ? (
            <button
              className="ak-menu-item w-full text-left"
              data-agent-home-can-use-mac={mac.state}
              key={mac.id}
              onClick={onFix}
              type="button"
            >
              {body}
              <ChevronRight aria-hidden className="size-4 shrink-0 text-(--ak-ink-3)" />
            </button>
          ) : (
            <div
              className="flex items-center gap-2.5 px-2.5 py-1.5 [font:var(--ak-t-body)] text-(--ak-ink)"
              data-agent-home-can-use-mac={mac.state}
              key={mac.id}
            >
              {body}
            </div>
          )
        })
      )}
    </div>
  )
}

/**
 * The owner's Macs, read from the account sources view while `active` (the popover is open) and
 * re-read when they change. Undefined until known, or when this window has no sources bridge.
 */
export function useMatrixReachMacs(
  active: boolean,
  bridge: MatrixAgentSourcesBridge | undefined = window.atumMatrix?.agentSources
): readonly MatrixReachMac[] | undefined {
  const [macs, setMacs] = useState<readonly MatrixReachMac[]>()

  useEffect(() => {
    if (!active || !bridge) {
      return
    }

    let live = true

    const read = () =>
      void bridge.read().then(
        view => {
          if (live) {
            setMacs(view.macs ?? [])
          }
        },
        () => undefined
      )

    read()
    const unsubscribe = bridge.subscribe?.(read)

    return () => {
      live = false
      unsubscribe?.()
    }
  }, [active, bridge])

  return macs
}
