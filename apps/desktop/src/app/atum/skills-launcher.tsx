import { useStore } from '@nanostores/react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { AddSkillDialog } from '@/app/atum/add-skill-dialog'
import { AppCapabilityDialog } from '@/app/atum/app-capability-dialog'
import { launcherCapabilityCopy } from '@/app/atum/launcher-capability-copy'
import { NativeAppIcon } from '@/app/atum/native-app-icon'
import { SkillDetailDialog } from '@/app/atum/skill-detail-dialog'
import { $atumSkillRows } from '@/app/atum/skills'
import { openLauncherOfficeFile } from '@/app/atum/skills-launcher-actions'
import { useOpenStorefront } from '@/app/atum/use-open-storefront'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { SearchField } from '@/components/ui/search-field'
import { useI18n } from '@/i18n'
import type { AtumStoreSkillEntry } from '@/lib/atum-store-items'
import { OFFICE_SKILLS, projectLauncherTiles } from '@/lib/launcher-capabilities'
import type { LauncherCapabilityTile } from '@/lib/launcher-capability-types'
import { cn } from '@/lib/utils'
import { $actionPanelEpoch, $actionPanelOwner } from '@/store/action-panel-owner'
import { $workspaceOpen } from '@/store/atum-shell'
import { refreshAtumStoreCatalog } from '@/store/atum-store-catalog'
import { cancelOtherAppsLink, linkSavedDocument, linkWordFile, openContextPicker } from '@/store/context-link-actions'
import { $otherAppsLinkIntent, otherAppsLinkIntentForScope } from '@/store/conversation-context-links'
import {
  $launcherCapabilities,
  addBundledLauncherSkill,
  enableLauncherSkill,
  launchLauncherApp,
  prepareLauncherSetup,
  refreshLauncherCapabilities
} from '@/store/launcher-capabilities'
import { $nativeAppRecency } from '@/store/native-app-recency'
import { $nativeApps, refreshNativeApps } from '@/store/native-apps'

import { type NativeAppEntry, type NativeAppLaunchResult, officeKindForBundle } from '../../../shared/skills-launcher'
import { requestComposerFocus } from '../chat/composer/focus'

function matches(tile: LauncherCapabilityTile, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()

  return (
    !needle || [tile.label, tile.skillName, tile.app?.name].some(value => value?.toLocaleLowerCase().includes(needle))
  )
}

function launchReason(
  result: NativeAppLaunchResult,
  copy: ReturnType<typeof useI18n>['t']['atum']['workspace']
): string | null {
  if (result.status === 'beside') {
    return copy.launcherBeside
  }

  if (!result.reason) {
    return result.status === 'opened' ? copy.launcherOpened : null
  }

  return {
    permission: copy.launcherReasonPermission,
    'no-window': copy.launcherReasonNoWindow,
    unsupported: copy.launcherReasonUnsupported,
    fullscreen: copy.launcherReasonFullscreen,
    'layout-failed': copy.launcherReasonLayoutFailed
  }[result.reason]
}

interface CapabilityTileProps {
  onFocus: () => void
  onLaunch: (tile: LauncherCapabilityTile, options?: { normal?: boolean }) => void
  onOpenCapability: (tile: LauncherCapabilityTile, origin: HTMLButtonElement) => void
  onOfficeFile: (app: NativeAppEntry) => void
  selected: boolean
  tile: LauncherCapabilityTile
}

function CapabilityTile({ onFocus, onLaunch, onOfficeFile, onOpenCapability, selected, tile }: CapabilityTileProps) {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const app = tile.app
  const ready = tile.status === 'ready'

  const open = (event: MouseEvent<HTMLButtonElement>) =>
    ready ? onLaunch(tile) : onOpenCapability(tile, event.currentTarget)

  const button = (
    <button
      className={cn(
        'flex min-w-0 flex-col items-center gap-1.5 rounded-[var(--atum-r-row)] px-1 pt-2.5 pb-2 outline-none select-none',
        selected ? 'bg-(--atum-hover)' : 'hover:bg-(--atum-sunk) focus-visible:bg-(--atum-hover)',
        ready ? '' : 'opacity-65'
      )}
      data-launcher-status={tile.status}
      data-launcher-tile={tile.id}
      onClick={open}
      onFocus={onFocus}
      ref={buttonRef}
      title={tile.label}
      type="button"
    >
      <NativeAppIcon app={app} />
      <span className="w-full truncate text-center text-(length:--atum-t-caption) leading-[1.3] text-(--atum-ink-soft)">
        {tile.label}
      </span>
    </button>
  )

  const officeApp = Boolean(officeKindForBundle(app.bundleId))

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={() => buttonRef.current && onOpenCapability(tile, buttonRef.current)}>
          {t.atum.workspace.capability.capabilityForApp}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onLaunch(tile, { normal: false })}>
          {t.atum.workspace.launcherOpenBeside}
        </ContextMenuItem>
        {officeApp && (
          <ContextMenuItem onSelect={() => onOfficeFile(app)}>{t.atum.workspace.launcherOpenFile}</ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onLaunch(tile, { normal: true })}>
          {t.atum.workspace.launcherOpenNormally}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function gridColumns(tiles: HTMLElement[]): number {
  const top = tiles[0]?.offsetTop

  return Math.max(1, tiles.filter(tile => tile.offsetTop === top).length)
}

interface PendingLaunch {
  appId: string
  skillName?: string
}

/** Kỹ năng — installed apps, ranked by assistant readiness and recent use. */
export function AtumSkillsLauncher({ scopeKey }: { scopeKey: string }) {
  const { t } = useI18n()
  const copy = launcherCapabilityCopy(t)
  const openStorefront = useOpenStorefront()
  const native = useStore($nativeApps)
  const capabilityState = useStore($launcherCapabilities)
  const skillRows = useStore($atumSkillRows)
  const panelOwner = useStore($actionPanelOwner)
  const workspaceOpen = useStore($workspaceOpen)
  // The composer can hand one explicit link operation into the launcher. It
  // is scoped/fenced in the store; this subscription is only the renderer cue
  // that the next compatible app tile should return to document choice rather
  // than prepare a skill command.
  useStore($otherAppsLinkIntent)

  // Keep the open grid stable under the pointer. Fresh history takes effect
  // when the launcher reopens or its owner/workspace changes.
  const recency = useMemo(() => ({
    scopeKey,
    accountId: panelOwner?.accountId,
    workspaceOpen,
    lastUsed: $nativeAppRecency.get()[panelOwner?.accountId ?? ''] ?? {}
  }), [scopeKey, panelOwner?.accountId, workspaceOpen])

  const panelEpoch = useStore($actionPanelEpoch)
  const launcherRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const latestScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  const capabilityOrigin = useRef<HTMLElement | null>(null)
  const sourceTilesRef = useRef<LauncherCapabilityTile[]>([])
  const acquisitionTileRef = useRef<LauncherCapabilityTile | null>(null)
  const [query, setQuery] = useState('')
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [actionFailed, setActionFailed] = useState(false)
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null)
  const [capabilityTile, setCapabilityTile] = useState<LauncherCapabilityTile | null>(null)
  const [detailEntry, setDetailEntry] = useState<AtumStoreSkillEntry | null>(null)
  const [addEntry, setAddEntry] = useState<AtumStoreSkillEntry | null>(null)

  latestScope.current = scopeKey

  useEffect(() => {
    mounted.current = true
    const opener = document.activeElement as HTMLElement | null

    return () => {
      mounted.current = false
      opener?.focus()
    }
  }, [])

  // Other apps is a one-shot continuation of the originating picker. Leaving
  // this launcher without selecting a document cancels it; scope/owner changes
  // are independently fenced by the context-link store.
  useEffect(() => () => {
    if (otherAppsLinkIntentForScope(scopeKey)) {cancelOtherAppsLink()}
  }, [scopeKey])

  useEffect(() => {
    scopeGeneration.current += 1
    setActionFailed(false)
    setPendingLaunch(null)
    inputRef.current?.focus()
    void refreshNativeApps(true, scopeKey)
    void refreshLauncherCapabilities(scopeKey)
    void refreshAtumStoreCatalog().catch(() => null)
    setCapabilityTile(null)
    setDetailEntry(null)
    setAddEntry(null)
    acquisitionTileRef.current = null
  }, [
    panelEpoch,
    panelOwner?.accountId,
    panelOwner?.agent_id,
    panelOwner?.backend_id,
    panelOwner?.connectionId,
    scopeKey
  ])

  useEffect(() => {
    if ($launcherCapabilities.get().scopeKey !== scopeKey) {void refreshLauncherCapabilities(scopeKey)}
  }, [capabilityState.scopeKey, scopeKey])

  const inScope = native.scopeKey === scopeKey
  const launch = inScope ? native.result : null

  const sourceTiles = useMemo(
    () =>
      inScope
        ? projectLauncherTiles(
            native.apps,
            capabilityState,
            skillRows.map(row => row.entry),
            recency.lastUsed
          )
        : [],
    [capabilityState, inScope, native.apps, skillRows, recency]
  )

  const tilesForQuery = useMemo(() => sourceTiles.filter(tile => matches(tile, query)), [query, sourceTiles])
  const selected = Math.max(0, tilesForQuery.findIndex(tile => tile.id === selectedTileId))

  const currentCapabilityTile = capabilityTile
    ? (sourceTiles.find(tile => tile.id === capabilityTile.id) ?? capabilityTile)
    : null

  sourceTilesRef.current = sourceTiles

  const runAction = (run: () => Promise<void> | void) => {
    const generation = scopeGeneration.current

    void Promise.resolve(run())
      .then(() => {
        if (generation === scopeGeneration.current) {
          setActionFailed(false)
        }
      })
      .catch(() => {
        if (generation === scopeGeneration.current) {
          setActionFailed(true)
        }
      })
  }

  const launchTile = (tile: LauncherCapabilityTile, options?: { normal?: boolean; windowId?: number }) => {
    if (tile.status !== 'ready' && options === undefined) {
      setCapabilityTile(tile)

      return
    }

    // Other apps is a document-link handoff, not a normal capability launch.
    // We only intercept a primary click on a ready Office app. Unsupported or
    // unskilled apps still use their existing honest cards and launch paths.
    const otherAppsIntent = otherAppsLinkIntentForScope(scopeKey)

    if (options === undefined && tile.status === 'ready' && officeKindForBundle(tile.app.bundleId) && otherAppsIntent) {
      runAction(async () => {
        const handoffGeneration = scopeGeneration.current

        const currentHandoff = () => mounted.current && handoffGeneration === scopeGeneration.current &&
          latestScope.current === scopeKey && otherAppsLinkIntentForScope(scopeKey) === otherAppsIntent

        const kind = officeKindForBundle(tile.app.bundleId)!
        const bridge = window.hermesDesktop?.nativeApps

        const hasOpenDocument = kind === 'word'
          ? Boolean((await window.hermesDesktop?.wordCompanion?.listDocuments?.())?.documents.length)
          : (await bridge?.listOpenDocumentWindows?.())?.windows.some(window => window.app.id === tile.app.id || window.app.bundleId === tile.app.bundleId)

        if (!currentHandoff()) {return}

        if (hasOpenDocument) {
          openContextPicker()

          return
        }

        // An absent/ambiguous document is never inferred from an app title.
        // Choosing a file is explicit; the action launches exactly that file,
        // binds it, and only then makes the one-shot intent a linked chip.
        const path = await bridge?.chooseFile(kind)

        if (!currentHandoff()) {return}

        if (!path) {
          cancelOtherAppsLink()

          return
        }

        const linked = kind === 'word'
          ? await linkWordFile(path, { show: otherAppsIntent.show })
          : await linkSavedDocument({ appId: tile.app.id, office: kind, path }, { show: otherAppsIntent.show })

        if (linked) {
          cancelOtherAppsLink()
          requestComposerFocus('main')
        }
      })

      return
    }

    const normal = options?.normal
    // A primary click (and its chooser continuation) is the explicit
    // capability path. Context-menu opens remain ordinary app opens.
    const capabilityLaunch = options === undefined || options.windowId !== undefined
    const skillName = capabilityLaunch && !normal && tile.status === 'ready' ? (tile.skillName ?? undefined) : undefined

    const launchOptions = {
      ...(normal ? { normal: true } : {}),
      ...(options?.windowId === undefined ? {} : { windowId: options.windowId }),
      ...(skillName ? { skillName } : {})
    }

    setPendingLaunch({ appId: tile.app.id, skillName })
    runAction(async () => {await launchLauncherApp(tile.app!, scopeKey, launchOptions)})
  }

  const chooseWindow = (windowId: number) => {
    if (launch?.status !== 'choose-window') {return}

    // File-menu launches are owned by the native store, not a tile click.
    const skillName = native.documentPath
      ? (launch.app.bundleId ? OFFICE_SKILLS[launch.app.bundleId] : undefined)
      : pendingLaunch?.appId === launch.app.id ? pendingLaunch.skillName : undefined

    runAction(async () => {await launchLauncherApp(launch.app, scopeKey, { windowId, ...(skillName ? { skillName } : {}) })})
  }

  const tiles = () => Array.from(launcherRef.current?.querySelectorAll<HTMLElement>('[data-launcher-tile]') ?? [])

  const focusTile = (index: number) => {
    const scope = scopeKey
    const next = Math.max(0, Math.min(index, tilesForQuery.length - 1))

    const tileId = tilesForQuery[next]?.id ?? null
    setSelectedTileId(tileId)
    window.requestAnimationFrame(() => {
      if (mounted.current && latestScope.current === scope) {
        tiles().find(tile => tile.dataset.launcherTile === tileId)?.focus()
      }
    })
  }

  const onLauncherKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    if (!tilesForQuery.length) {
      return
    }

    if (target === inputRef.current) {
      if (event.key === 'Enter' && query.trim() && !event.nativeEvent.isComposing && tilesForQuery[selected]) {
        event.preventDefault()
        launchTile(tilesForQuery[selected]!, event.altKey ? { normal: true } : undefined)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusTile(selected)
      }

      return
    }

    if (!target.matches('[data-launcher-tile]')) {
      return
    }

    const all = tiles()
    const index = all.indexOf(target)
    const columns = gridColumns(all)

    if (event.key === 'Enter' && event.altKey && tilesForQuery[index]) {
      event.preventDefault()
      launchTile(tilesForQuery[index]!, { normal: true })

      return
    }

    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const box = target.getBoundingClientRect()
      target.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
      }))

      return
    }

    const delta = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Partial<Record<string, number>>
    )[event.key]

    if (delta === undefined) {
      return
    }

    event.preventDefault()

    if (event.key === 'ArrowUp' && index - columns < 0) {
      setSelectedTileId(null)
      inputRef.current?.focus()

      return
    }

    focusTile(index + delta)
  }

  const closeCapability = (open: boolean) => {
    if (open) {
      return
    }

    setCapabilityTile(null)
    window.requestAnimationFrame(() => (capabilityOrigin.current ?? inputRef.current)?.focus())
  }

  const recheck = () => runAction(() => refreshLauncherCapabilities(scopeKey, true))

  const actIncluded = () =>
    currentCapabilityTile?.skillName &&
    runAction(() => addBundledLauncherSkill(currentCapabilityTile.skillName!, scopeKey))

  const actDisabled = () =>
    currentCapabilityTile?.skillName && runAction(() => enableLauncherSkill(currentCapabilityTile.skillName!, scopeKey))

  const openCapability = (tile: LauncherCapabilityTile, origin: HTMLButtonElement) => {
    capabilityOrigin.current = origin

    if (tile.status === 'acquire' && tile.storeEntry) {
      acquisitionTileRef.current = tile
      setCapabilityTile(tile)
      setDetailEntry(tile.storeEntry)
    } else {
      setCapabilityTile(tile)
    }
  }

  return (
    <div
      className="h-full overflow-y-auto px-5 pt-6 pb-8"
      data-atum-skills-launcher
      onKeyDown={onLauncherKeyDown}
      ref={launcherRef}
    >
      <div className="mx-auto max-w-[40rem]">
        <div className="flex justify-center">
          <SearchField
            aria-label={t.atum.workspace.launcherSearch}
            containerClassName="w-full max-w-[18rem]"
            inputRef={inputRef}
            onChange={value => {
              setQuery(value)
              setSelectedTileId(null)
            }}
            placeholder={t.atum.workspace.launcherSearch}
            value={query}
          />
        </div>
        {(native.error || capabilityState.error || actionFailed) && (
          <NoticeBand className="mt-4" role="alert">
            {copy.actionFailed}
          </NoticeBand>
        )}
        {launch && launchReason(launch, t.atum.workspace) && (
          <NoticeBand className="mt-4" role="status">
            {launchReason(launch, t.atum.workspace)}
          </NoticeBand>
        )}
        {launch?.reason === 'permission' && window.hermesDesktop?.nativeApps && (
          <Button
            onClick={() =>
              runAction(() => window.hermesDesktop.nativeApps?.openArrangementSettings() ?? Promise.resolve())
            }
            size="xs"
            type="button"
            variant="ghost"
          >
            {t.atum.workspace.launcherOpenAccessibilitySettings}
          </Button>
        )}
        {launch?.status === 'choose-window' && (
          <div aria-label={t.atum.workspace.launcherChooseWindow} className="mt-3" role="group">
            <p className="mb-1.5 text-[length:var(--atum-t-caption)] text-(--atum-ink-muted)">
              {t.atum.workspace.launcherChooseWindow}
            </p>
            <div className="atum-glass-card overflow-hidden rounded-[var(--atum-r-group)]">
              {launch.windows?.map(window => (
                <button
                  className="atum-row flex min-h-10 w-full items-center px-3 text-left text-[length:var(--atum-t-control)] hover:bg-(--atum-hover)"
                  key={window.id}
                  onClick={() => chooseWindow(window.id)}
                  type="button"
                >
                  {window.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {tilesForQuery.length > 0 && (
          <div
            aria-label={t.atum.workspace.launcherTools}
            className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-1 gap-y-3"
            role="group"
          >
            {tilesForQuery.map((tile, index) => (
              <CapabilityTile
                key={tile.id}
                onFocus={() => setSelectedTileId(tile.id)}
                onLaunch={launchTile}
                onOfficeFile={app => runAction(() => openLauncherOfficeFile(app, scopeKey))}
                onOpenCapability={openCapability}
                selected={index === selected && query.trim().length > 0}
                tile={tile}
              />
            ))}
          </div>
        )}
        {(native.loading || capabilityState.loading) && tilesForQuery.length === 0 && !query && (
          <Loader className="mt-10" />
        )}
        {!native.loading && !capabilityState.loading && tilesForQuery.length === 0 && (
          <p className="mt-10 text-center text-[length:--atum-t-body] text-(--atum-ink-muted)">
            {t.atum.workspace.launcherNoResults}
          </p>
        )}
      </div>
      <AppCapabilityDialog
        copy={copy}
        onAdd={actIncluded}
        onBrowse={() => {
          closeCapability(false)
          openStorefront('skills')
        }}
        onEnable={actDisabled}
        onOpenApp={normal => {
          if (currentCapabilityTile?.app) {
            setCapabilityTile(null)
            launchTile(currentCapabilityTile, { normal })
          }
        }}
        onOpenChange={closeCapability}
        onRecheck={recheck}
        onSetup={() => {
          if (currentCapabilityTile?.skillName && prepareLauncherSetup(currentCapabilityTile.skillName, scopeKey,
            copy.setupRequest.replace('{name}', currentCapabilityTile.skillName))) {setCapabilityTile(null)}
        }}
        onUse={() => {
          if (currentCapabilityTile) {
            setCapabilityTile(null)
            launchTile(currentCapabilityTile)
          }
        }}
        open={currentCapabilityTile !== null && detailEntry === null && addEntry === null}
        tile={currentCapabilityTile}
      />
      <SkillDetailDialog
        entry={detailEntry}
        onAdd={entry => {
          setDetailEntry(null)
          setAddEntry(entry)
        }}
        onOpenChange={open => {
          if (!open) {
            setDetailEntry(null)
            setCapabilityTile(null)
            window.requestAnimationFrame(() => capabilityOrigin.current?.focus())
          }
        }}
        open={detailEntry !== null}
      />
      <AddSkillDialog
        entry={addEntry}
        onOpenChange={open => {
          if (!open) {
            const added = acquisitionTileRef.current
            const latest = added && sourceTilesRef.current.find(tile => tile.id === added.id)
            setAddEntry(null)
            setCapabilityTile(latest?.status === 'ready' ? latest : null)
            window.requestAnimationFrame(() => capabilityOrigin.current?.focus())
          }
        }}
        open={addEntry !== null}
        preselect={capabilityState.profile ?? 'default'}
      />
    </div>
  )
}
