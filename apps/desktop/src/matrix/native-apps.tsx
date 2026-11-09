import type { KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { AppCapabilityDialog } from '@/app/atum/app-capability-dialog'
import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { launcherCapabilityCopy } from '@/app/atum/launcher-capability-copy'
import { NativeAppIcon } from '@/app/atum/native-app-icon'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { Compass, MoreHorizontal, SearchIcon } from '@/lib/icons'
import { OFFICE_SKILLS, projectLauncherTiles } from '@/lib/launcher-capabilities'
import type { LauncherCapabilityState, LauncherCapabilityTile } from '@/lib/launcher-capability-types'
import { $nativeAppRecency, recordNativeAppUse } from '@/store/native-app-recency'

import { type AppDescriptor, appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixNativeAppsBridge } from '../../shared/matrix-native-apps'
import type { NativeAppEntry, NativeAppLaunchResult } from '../../shared/skills-launcher'

import { useMatrixWorkbenchCopy } from './workbench-copy'

/** Atum's own apps, as the new tab's "More" popover lists them under the Mac's. */
export interface LauncherAtumApps {
  /** Available apps; the popover's search filters them by their localized name. */
  apps: readonly AppDescriptor[]
  /** Loading, unavailable or empty, when the catalog has no list to show. */
  status: ReactNode | null
  onOpen(app: AppDescriptor): void
  /** Absent while the catalog is not ready. */
  onStore?: () => void
}

interface LauncherAppsProps {
  active: boolean
  atumApps: LauncherAtumApps
  snapshot: MatrixSnapshot
}

/** Mac apps Atum used beside the chat, shown when none of the Office apps is installed. */
const RECENT_FALLBACK = 3

/** Strip the bundle vendor only when it is the actual leading word (Microsoft Word → Word). */
export function nativeAppShortName(app: NativeAppEntry, label: string): string {
  const vendor = app.bundleId?.split('.')[1]
  const [first, ...rest] = label.trim().split(/\s+/u)

  return vendor && rest.length > 0 && first?.toLocaleLowerCase() === vendor.toLocaleLowerCase()
    ? rest.join(' ')
    : label
}

/**
 * The few big apps the new tab shows by name: the Office apps Atum has skills for, in the
 * suite's order (OFFICE_SKILLS), never re-sorted under the pointer. Without Office, the Mac
 * apps this person last opened from Atum stand in; everything else waits in "More".
 */
export function featuredLauncherTiles(
  tiles: readonly LauncherCapabilityTile[],
  lastUsed: Readonly<Record<string, number>>
): LauncherCapabilityTile[] {
  const office = Object.keys(OFFICE_SKILLS).flatMap(bundleId => tiles.filter(tile => tile.app.bundleId === bundleId))

  return office.length > 0
    ? office
    : tiles.filter(tile => lastUsed[tile.app.bundleId || tile.app.id]).slice(0, RECENT_FALLBACK)
}

/**
 * The new tab's "Apps": the big apps as tiles, then a "More" tile whose popover holds every
 * other Mac app, Atum's own apps and the Store. The human/room owns presentation; main alone
 * resolves the selected agent.
 */
export function MatrixLauncherApps({ active, atumApps, snapshot }: LauncherAppsProps) {
  const bridge = window.atumMatrix.nativeApps
  const identity = snapshot.identity

  if (snapshot.state !== 'ready' || !identity || !bridge) {
    return <AtumAppsOnly atumApps={atumApps} />
  }

  return (
    <NativeMacApps
      active={active}
      atumApps={atumApps}
      bridge={bridge}
      key={`${identity.userId}\0${identity.deviceId}\0${snapshot.roomId ?? ''}`}
      roomId={snapshot.roomId ?? undefined}
      userId={identity.userId}
    />
  )
}

function AppsSection({ children }: { children: ReactNode }) {
  const copy = useMatrixWorkbenchCopy()
  const id = useId()

  return (
    <section aria-labelledby={id} data-matrix-native-apps>
      <h2 className="atum-launcher-heading" id={id}>
        {copy.apps}
      </h2>
      {children}
    </section>
  )
}

/** Without Mac apps (another platform, or before Matrix is ready), "More" holds Atum's own. */
function AtumAppsOnly({ atumApps }: { atumApps: LauncherAtumApps }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  return (
    <AppsSection>
      <div className="atum-launcher-apps">
        <MoreApps
          atumApps={atumApps}
          macRows={[]}
          onOpenChange={setOpen}
          onQueryChange={setQuery}
          open={open}
          query={query}
          searchable={atumApps.apps.length > 0}
        />
      </div>
    </AppsSection>
  )
}

/** The "More" tile and its popover: the rest of the Mac's apps, Atum's apps, the Store. */
function MoreApps({
  atumApps,
  macRows,
  onKeyDown,
  onOpenChange,
  onQueryChange,
  open,
  query,
  searchable
}: {
  atumApps: LauncherAtumApps
  macRows: ReactNode[]
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onOpenChange(open: boolean): void
  onQueryChange(query: string): void
  open: boolean
  query: string
  searchable: boolean
}) {
  const { locale, t } = useI18n()
  const copy = useMatrixWorkbenchCopy()
  const needle = query.trim().toLocaleLowerCase()
  const content = useRef<HTMLDivElement>(null)

  const atumMatches = atumApps.apps.filter(
    app => !needle || appLocalizedCopy(app.name, locale, app.app).toLocaleLowerCase().includes(needle)
  )

  const choose = (run: () => void) => {
    onOpenChange(false)
    run()
  }

  return (
    <Popover
      onOpenChange={value => {
        onOpenChange(value)

        if (!value) {
          onQueryChange('')
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button aria-label={copy.moreAppsLabel} className="atum-launcher-app" data-matrix-apps-more type="button">
          <span aria-hidden className="atum-launcher-more-tile">
            <MoreHorizontal className="size-5" />
          </span>
          <span className="w-full truncate text-center">{copy.moreApps}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={copy.moreAppsLabel}
        className="ak-glass ak-menu w-72 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-1.5"
        data-matrix-apps-more-menu
        onKeyDown={onKeyDown}
        // A popover opened by a click focuses itself (Atum Kit §9), never the search field.
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus()
        }}
        ref={content}
        role="dialog"
        tabIndex={-1}
      >
        {searchable && (
          <label className="ak-field ak-field--search mx-0.5 mt-0.5 mb-1.5">
            <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
            <input
              aria-label={t.atum.workspace.launcherSearch}
              onChange={event => onQueryChange(event.target.value)}
              placeholder={t.atum.workspace.launcherSearch}
              value={query}
            />
          </label>
        )}
        <div className="max-h-[min(22rem,60vh)] overflow-y-auto">
          {macRows.length > 0 && (
            <>
              <div className="ak-menu-label">{copy.macApps}</div>
              {macRows}
            </>
          )}
          {(atumMatches.length > 0 || (!needle && atumApps.status)) && (
            <>
              {macRows.length > 0 && <div className="ak-menu-sep" />}
              <div className="ak-menu-label">{copy.atumApps}</div>
              {atumMatches.length > 0
                ? atumMatches.map(app => (
                    <button
                      className="ak-menu-item w-full text-left"
                      key={app.app_id}
                      onClick={() => choose(() => atumApps.onOpen(app))}
                      type="button"
                    >
                      <AppCatalogAvatar
                        app={app}
                        className="size-5 rounded-[22.5%] text-[0.625rem] [corner-shape:squircle]"
                        locale={locale}
                        tile
                      />
                      <span className="min-w-0 flex-1 truncate">{appLocalizedCopy(app.name, locale, app.app)}</span>
                    </button>
                  ))
                : <div className="px-2.5 pb-1.5">{atumApps.status}</div>}
            </>
          )}
          {needle && macRows.length === 0 && atumMatches.length === 0 && (
            <p className="px-2.5 py-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)" role="status">
              {t.atum.workspace.launcherNoResults}
            </p>
          )}
        </div>
        <div className="ak-menu-sep" />
        <button
          className="ak-menu-item w-full text-left"
          disabled={!atumApps.onStore}
          onClick={() => atumApps.onStore && choose(atumApps.onStore)}
          type="button"
        >
          <Compass aria-hidden className="ak-icon" />
          <span className="min-w-0 flex-1 truncate">{copy.seeAll}</span>
        </button>
      </PopoverContent>
    </Popover>
  )
}

function NativeMacApps({
  active,
  atumApps,
  bridge,
  roomId,
  userId
}: {
  active: boolean
  atumApps: LauncherAtumApps
  bridge: MatrixNativeAppsBridge
  roomId?: string
  userId: string
}) {
  const { t } = useI18n()
  const copy = launcherCapabilityCopy(t)
  const workbenchCopy = useMatrixWorkbenchCopy()
  const heading = useId()
  const [apps, setApps] = useState<NativeAppEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<LauncherCapabilityTile | null>(null)
  const [result, setResult] = useState<NativeAppLaunchResult>()
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const request = useRef<string | undefined>(undefined)
  const pending = useRef(false)
  const alive = useRef(true)

  const [capabilities, setCapabilities] = useState<LauncherCapabilityState>({
    scopeKey: null,
    profile: null,
    skills: [],
    support: null,
    loading: false,
    error: null,
    busySkill: null
  })

  // Snapshot on reopen, not on every accepted open: tiles do not jump under a pointer.
  const recency = useMemo(() => ({ active, lastUsed: $nativeAppRecency.get()[userId] ?? {} }), [active, userId])
  const tiles = projectLauncherTiles(apps, capabilities, [], recency.lastUsed)
  const featured = featuredLauncherTiles(tiles, recency.lastUsed)
  const needle = query.trim().toLocaleLowerCase()

  // Searching looks through every Mac app; otherwise "More" lists the ones not shown as tiles.
  const rest = needle
    ? tiles.filter(tile => tile.label.toLocaleLowerCase().includes(needle))
    : tiles.filter(tile => !featured.includes(tile))

  useEffect(() => {
    alive.current = true

    const stop = bridge.onEnded(id => {
      // The existing controller ends the chooser before its same-id continuation.
      if (request.current === id && !pending.current) {
        request.current = undefined
        setResult(undefined)
        setBusy(false)
      }
    })

    return () => {
      alive.current = false
      stop()

      if (request.current) {
        void bridge.end(request.current).catch(() => {})
      }
    }
  }, [bridge])

  useEffect(() => {
    if (!active) {
      return
    }

    let current = true
    setLoading(true)
    setFailed(false)
    setCapabilities(value => ({ ...value, loading: true, error: null }))
    void bridge
      .list(true)
      .then(
        value => {
          if (current) {
            setApps(value)
          }
        },
        () => {
          if (current) {
            setFailed(true)
          }
        }
      )
      .finally(() => {
        if (current) {
          setLoading(false)
        }
      })
    const readiness = roomId ? bridge.readiness(roomId, refresh > 0) : Promise.reject(new Error('no_agent'))
    void readiness.then(
      value => {
        if (current) {
          setCapabilities(previous => ({ ...previous, ...value, loading: false, error: null }))
        }
      },
      () => {
        if (current) {
          setCapabilities(previous => ({
            ...previous,
            skills: [],
            support: null,
            loading: false,
            error: 'unavailable'
          }))
        }
      }
    )

    return () => {
      current = false
    }
  }, [active, bridge, roomId, refresh])

  const end = () => {
    const id = request.current
    request.current = undefined
    pending.current = false
    setResult(undefined)
    setBusy(false)

    if (id) {
      void bridge.end(id).catch(() => {
        if (alive.current) {
          setFailed(true)
        }
      })
    }
  }

  const launch = (tile: LauncherCapabilityTile, normal = false, windowId?: number) => {
    if (pending.current || !alive.current) {
      return
    }

    const id = windowId === undefined ? crypto.randomUUID() : request.current

    if (!id) {
      return
    }

    request.current = id
    pending.current = true
    setBusy(true)
    // The note about what happened sits under the tiles, so the popover gets out of its way.
    setMoreOpen(false)

    if (windowId === undefined) {
      setResult(undefined)
    }

    setFailed(false)
    setDetail(null)
    void bridge
      .launch({
        appId: tile.app.id,
        requestId: id,
        mode: normal ? 'normal' : 'beside',
        ...(windowId === undefined ? {} : { windowId })
      })
      .then(
        value => {
          if (!alive.current || request.current !== id) {
            void bridge.end(id).catch(() => {})

            return
          }

          setResult(value)

          if (value.status !== 'choose-window') {
            recordNativeAppUse(tile.app.bundleId || tile.app.id, userId)
          }
        },
        () => {
          if (alive.current && request.current === id) {
            setFailed(true)
          }
        }
      )
      .finally(() => {
        if (alive.current && request.current === id) {
          pending.current = false
          setBusy(false)
        }
      })
  }

  // A click opens the app beside the chat, whatever its skill status; what Atum can do
  // with it (and "open normally") waits in the tile's "…" and its context menu.
  const open = (tile: LauncherCapabilityTile, normal = false) => launch(tile, normal)

  const showDetail = (tile: LauncherCapabilityTile) => {
    setMoreOpen(false)
    setDetail(tile)
  }

  const keyboard = (list: readonly LauncherCapabilityTile[]) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter') {
      return
    }

    const target = event.target as HTMLElement

    // Portaled dialogs/menus and ordinary buttons own their own Enter. Only
    // the search and native tiles participate in this grid shortcut.
    if (!event.currentTarget.contains(target)) {
      return
    }

    const input = event.target instanceof HTMLInputElement

    if (!input && !target.closest('button[data-launcher-status]')) {
      return
    }

    if (input && !query.trim()) {
      return
    }

    const tile = list.find(item => item.id === selected) ?? list[0]

    if (tile) {
      event.preventDefault()
      open(tile, event.altKey)
    }
  }

  const contextChoices = (tile: LauncherCapabilityTile) => (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => showDetail(tile)}>{copy.capabilityForApp}</ContextMenuItem>
      <ContextMenuItem onSelect={() => launch(tile)}>{copy.openBeside}</ContextMenuItem>
      <ContextMenuItem onSelect={() => launch(tile, true)}>{copy.openNormally}</ContextMenuItem>
    </ContextMenuContent>
  )

  const contextKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    }
  }

  const macRows = rest.map(tile => (
    <ContextMenu key={tile.id}>
      <ContextMenuTrigger asChild>
        <button
          aria-label={nativeAppShortName(tile.app, tile.label)}
          className="ak-menu-item w-full text-left"
          data-launcher-status={tile.status}
          disabled={busy}
          // Option-click opens normally, as Option-Enter does.
          onClick={event => open(tile, event.altKey)}
          onFocus={() => setSelected(tile.id)}
          onKeyDown={contextKey}
          type="button"
        >
          <NativeAppIcon app={tile.app} small />
          <span className="min-w-0 flex-1 truncate">{nativeAppShortName(tile.app, tile.label)}</span>
        </button>
      </ContextMenuTrigger>
      {contextChoices(tile)}
    </ContextMenu>
  ))

  const resultCopy =
    result?.status === 'beside'
      ? t.atum.workspace.launcherBeside
      : result?.reason
        ? {
            permission: t.atum.workspace.launcherReasonPermission,
            'no-window': t.atum.workspace.launcherReasonNoWindow,
            unsupported: t.atum.workspace.launcherReasonUnsupported,
            fullscreen: t.atum.workspace.launcherReasonFullscreen,
            'layout-failed': t.atum.workspace.launcherReasonLayoutFailed
          }[result.reason]
        : t.atum.workspace.launcherOpened

  return (
    <section aria-labelledby={heading} data-matrix-native-apps onKeyDown={keyboard(featured)}>
      <h2 className="atum-launcher-heading" id={heading}>
        {workbenchCopy.apps}
      </h2>
      <div className="atum-launcher-apps">
        {featured.map(tile => (
          <div className="group relative" key={tile.id}>
            {/* Every Mac app opens whatever Atum can do in it, so the tile stays solid as on the board;
                what Atum can do there is the tile's detail, not a faded icon. */}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  aria-label={nativeAppShortName(tile.app, tile.label)}
                  className="atum-launcher-app w-full"
                  data-launcher-status={tile.status}
                  disabled={busy}
                  onClick={() => open(tile)}
                  onFocus={() => setSelected(tile.id)}
                  onKeyDown={contextKey}
                  type="button"
                >
                  <NativeAppIcon app={tile.app} />
                  <span className="w-full truncate text-center">{nativeAppShortName(tile.app, tile.label)}</span>
                </button>
              </ContextMenuTrigger>
              {contextChoices(tile)}
            </ContextMenu>
            {/* The same choices for the pointer: a quiet "…" that appears over the tile on hover.
                Keyboard users have Shift-F10, so it stays out of the grid's tab order. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={workbenchCopy.appOptions(nativeAppShortName(tile.app, tile.label))}
                  className="atum-icon-btn absolute top-1 right-1 size-6 bg-(--atum-card) opacity-0 shadow-(--atum-glass-edge) transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                  data-icon-only
                  disabled={busy}
                  tabIndex={-1}
                  type="button"
                >
                  <MoreHorizontal aria-hidden className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => launch(tile)}>{copy.openBeside}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => launch(tile, true)}>{copy.openNormally}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDetail(tile)}>{copy.capabilityForApp}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <MoreApps
          atumApps={atumApps}
          macRows={macRows}
          onKeyDown={keyboard(rest)}
          onOpenChange={setMoreOpen}
          onQueryChange={value => {
            setQuery(value)
            setSelected(undefined)
          }}
          open={moreOpen}
          query={query}
          searchable={apps.length > 0 || atumApps.apps.length > 0}
        />
      </div>
      {loading && apps.length === 0 && <Loader />}
      {failed && (
        <NoticeBand role="status" tone="failure">
          {t.atum.workspace.launcherActionFailed}
          <Button onClick={() => setRefresh(value => value + 1)} size="sm" variant="ghost">
            {copy.recheck}
          </Button>
        </NoticeBand>
      )}
      {result && result.status !== 'choose-window' && (
        <div className="mt-3 text-(length:--atum-t-caption) text-(--atum-ink-muted)" role="status">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p>
                {result.app.name} · {resultCopy}
              </p>
              {result.status === 'beside' && <p>{t.atum.workspace.launcherNoLiveContext}</p>}
            </div>
            {result.status === 'beside' && (
              <Button onClick={end} size="sm" variant="secondary">
                {t.atum.workspace.wordExit}
              </Button>
            )}
          </div>
          {result.reason === 'permission' && (
            <Button
              onClick={() => {
                void bridge.openArrangementSettings().catch(() => {
                  if (alive.current) {
                    setFailed(true)
                  }
                })
              }}
              size="sm"
              variant="ghost"
            >
              {t.atum.workspace.launcherOpenAccessibilitySettings}
            </Button>
          )}
        </div>
      )}
      {result?.status === 'choose-window' && (
        <div className="mt-3">
          <p>{t.atum.workspace.launcherChooseWindow}</p>
          {result.windows?.map(choice => (
            <Button
              disabled={busy}
              key={choice.id}
              onClick={() => {
                const tile = tiles.find(item => item.app.id === result.app.id)

                if (tile) {
                  launch(tile, false, choice.id)
                }
              }}
              size="sm"
              variant="ghost"
            >
              {choice.title}
            </Button>
          ))}
          <Button onClick={end} size="sm" variant="ghost">
            {copy.close}
          </Button>
        </div>
      )}
      <AppCapabilityDialog
        copy={copy}
        onOpenApp={normal => {
          if (detail) {
            launch(detail, normal)
          }
        }}
        onOpenChange={isOpen => {
          if (!isOpen) {
            setDetail(null)
          }
        }}
        onRecheck={() => {
          setDetail(null)
          setRefresh(value => value + 1)
        }}
        open={Boolean(detail)}
        tile={detail}
      />
    </section>
  )
}
