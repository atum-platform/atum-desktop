import { useEffect, useRef, useState } from 'react'

import { AppCatalogIdentity } from '@/app/atum/app-catalog-presentation'
import { AtumAppView } from '@/app/atum/app-view'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { appSurfaceIcon } from '@/lib/atum-app-surface-icons'
import { MoreHorizontal, Spinner } from '@/lib/icons'

import { type AppDescriptor, appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixAppMenu, MatrixSnapshot } from '../../shared/matrix'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import type { MatrixStoreSnapshot } from '../../shared/matrix-store'

import { openAppBotChat } from './app-bots/open'
import { AppChat, AppGroupDialog, useAppChatActions } from './app-chat'
import { useAppCopy } from './app-copy'
import { appRoster } from './app-roster'
import { MatrixDiscoverView } from './store/discover-view'
import { type MatrixStoreNavigation, MatrixStoreSidebar } from './store/store-sidebar'
import { matrixStoreHatchAction, matrixStoreTryAction } from './store/store-try'
import type { DiscoverShelf } from './store/top-up'
import { runMatrixCommand } from './text-document-actions'

/** An assistant's skill list for the Store: the names its definition carries (assistant card). */
function readAssistantSkills(principal: string): Promise<readonly string[] | null> {
  return (
    window.atumMatrix.assistants?.read(principal).then(result => (result.ok ? result.card.skills : null)) ??
    Promise.resolve(null)
  )
}
const pageCopy: Record<Locale, { more: (app: string) => string; noScreens: string; back: string }> = {
  en: { more: app => `More for ${app}`, noScreens: 'This app has no screens yet.', back: 'Back to the Store' },
  vi: { more: app => `Thêm cho ${app}`, noScreens: 'Ứng dụng này chưa có màn hình nào.', back: 'Quay lại Cửa hàng' },
  ja: { more: app => `${app} のその他`, noScreens: 'このアプリにはまだ画面がありません。', back: 'ストアに戻る' },
  zh: { more: app => `${app} 的更多操作`, noScreens: '此应用还没有任何界面。', back: '返回商店' },
  'zh-hant': { more: app => `${app} 的更多操作`, noScreens: '此應用程式還沒有任何畫面。', back: '返回商店' }
}

/**
 * Whether an app's sidebar shortcut is shown, and the toggle. No saved preference yet is
 * simply "not added" — the add action works — never a disabled button with no reason.
 */
function useAppShortcut(app: AppDescriptor, snapshot: MatrixSnapshot) {
  const [failed, setFailed] = useState(false)
  const preference = snapshot.appShortcuts?.[app.app_id]
  const shown = appRoster(snapshot.apps?.apps ?? [], snapshot.appShortcuts).some(value => value.app_id === app.app_id)
  const status = preference?.status ?? 'ready'
  const disabled = snapshot.state !== 'ready' || ['loading', 'readonly', 'saving'].includes(status)

  const toggle = () => {
    setFailed(false)
    void window.atumMatrix
      .command({ kind: 'appShortcut', appId: app.app_id, visibility: shown ? 'hidden' : 'shown' })
      .catch(() => setFailed(true))
  }

  return { disabled, failed, shown, status, toggle }
}

function AppShortcutStatus({ shortcut }: { shortcut: ReturnType<typeof useAppShortcut> }) {
  const copy = useAppCopy()

  return (
    <>
      {shortcut.status === 'saving' && (
        <span className="text-xs" role="status">
          {copy.savePending}
        </span>
      )}
      {(shortcut.failed || shortcut.status === 'failed' || shortcut.status === 'unconfirmed') && (
        <span className="text-xs" role="status">
          {copy.saveUnconfirmed}
        </span>
      )}
      {shortcut.status === 'readonly' && (
        <span className="text-xs" role="status">
          {copy.readonly}
        </span>
      )}
    </>
  )
}

export function AppShortcut({ app, snapshot }: { app: AppDescriptor; snapshot: MatrixSnapshot }) {
  const copy = useAppCopy()
  const shortcut = useAppShortcut(app, snapshot)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={shortcut.disabled} onClick={shortcut.toggle} size="sm" variant="text">
        {shortcut.shown ? copy.hideShortcut : copy.addShortcut}
      </Button>
      <AppShortcutStatus shortcut={shortcut} />
    </div>
  )
}

/** A Discover card's actions: one Open, and everything else in a "…" menu. */
function AppCardActions({
  app,
  fail,
  onFailed,
  snapshot
}: {
  app: AppDescriptor
  /** The window's failure band (app.tsx `fail`): why an official bot's chat did not open, by its
   * name, with the Retry that opens it again. */
  fail(cause?: unknown): void
  /** An app page that could not be shown: the catalog notice. */
  onFailed(): void
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  // A bot's chat can take a few seconds to open (its room has to sync): the card says so, as the
  // sidebar row does, rather than inviting a second ask, which main would refuse as busy.
  const [opening, setOpening] = useState(false)
  const copy = useAppCopy()
  const chatCopy = appChatCopy(locale)
  const more = pageCopy[locale].more(appLocalizedCopy(app.name, locale, app.app))
  const shortcut = useAppShortcut(app, snapshot)
  const chat = useAppChatActions(app, snapshot)
  // The menu's close must not pull focus back to "…" over the dialog it just opened.
  const openingDialog = useRef(false)

  const openDisabled =
    opening ||
    app.availability !== 'available' ||
    (!app.has_surface && app.matrix_room_context !== 'addressed_only' && app.link.state === 'never_linked')

  return (
    <>
      <Button
        disabled={openDisabled}
        onClick={() => {
          // An official bot (Moon, Andy) is a chat first: Open lands in its conversation, where its
          // setup, "+" menu and panel live, as its sidebar row does. The app page below has no
          // chat, and for a linked bot only offered a Connect that had nothing left to do. A chat
          // that does not open says why in the window's failure band, as from the sidebar row.
          if (app.bot) {
            setOpening(true)
            void openAppBotChat(snapshot, app.app_id, locale, fail).finally(() => setOpening(false))

            return
          }

          void runMatrixCommand({ kind: 'selectApp', appId: app.app_id }).catch(onFailed)
        }}
        size="sm"
        variant="secondary"
      >
        {opening ? copy.openingChat : app.has_surface ? copy.menu : copy.show}
      </Button>
      <DropdownMenu>
        <Tip label={more}>
          <DropdownMenuTrigger asChild>
            <button aria-label={more} className="atum-icon-btn size-7" data-icon-only type="button">
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={event => {
            if (openingDialog.current) {
              event.preventDefault()
              openingDialog.current = false
            }
          }}
        >
          <DropdownMenuItem disabled={shortcut.disabled} onSelect={shortcut.toggle}>
            {shortcut.shown ? copy.hideShortcut : copy.addShortcut}
          </DropdownMenuItem>
          {chat.bridge && chat.chatCapable && (
            <>
              <DropdownMenuItem disabled={!chat.available || chat.pending} onSelect={() => void chat.run()}>
                {chatCopy.newChat}
              </DropdownMenuItem>
              {chat.groupCapable && (
                <DropdownMenuItem
                  disabled={!chat.available || chat.pending}
                  onSelect={() => {
                    openingDialog.current = true
                    chat.setGroupOpen(true)
                  }}
                >
                  {chatCopy.newGroup}
                </DropdownMenuItem>
              )}
            </>
          )}
          {chat.bridge && chat.withdrawable && (
            <DropdownMenuItem disabled={chat.pending} onSelect={() => void chat.run('withdraw')}>
              {chatCopy.withdraw}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {chat.bridge && chat.chatCapable && <AppGroupDialog actions={chat} />}
      <AppShortcutStatus shortcut={shortcut} />
      {chat.failed && !chat.groupOpen && (
        <span className="text-xs" role="status">
          {chat.failureText}
        </span>
      )}
    </>
  )
}

/** App workspace has no room context. Hidden guests stay mounted/detached until
 * close/revocation/account disposal; restoring navigation never opens a route. */
export function MatrixApps({
  snapshot,
  obstructed,
  fail,
  storeNavigation
}: {
  snapshot: MatrixSnapshot
  obstructed: boolean
  /** Where a failed action goes: the window's failure band, which names the bot and offers Retry. */
  fail(cause?: unknown): void
  storeNavigation?: MatrixStoreNavigation
}) {
  const { locale } = useI18n()
  const copy = useAppCopy()
  const apps = snapshot.apps
  const bridge = window.atumMatrix.apps
  const selectedId = snapshot.destination?.kind === 'app' ? snapshot.destination.appId : null
  const selected = apps?.apps.find(value => value.app_id === selectedId)
  const discover = snapshot.destination?.kind === 'discover'
  const visible = Boolean(selectedId || discover)
  const [menu, setMenu] = useState<MatrixAppMenu | null>(null)
  const [menuFailed, setMenuFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [opened, setOpened] = useState<Record<string, { app: string; route: string; version: string }>>({})
  const returnControl = useRef<HTMLDivElement>(null)
  const version = selected?.app_version_id
  const hasSurface = selected?.has_surface
  const available = apps?.state === 'ready' && snapshot.state === 'ready'
  const storeBridge = window.atumMatrix.store

  const [fallbackShelf, setFallbackShelf] = useState<DiscoverShelf>(() =>
    (!snapshot.store || snapshot.store.state === 'unavailable') &&
    snapshot.apps?.state === 'ready' &&
    snapshot.apps.apps.length > 0
      ? 'apps'
      : 'featured'
  )

  const [fallbackQuery, setFallbackQuery] = useState('')

  const storeSnapshot: MatrixStoreSnapshot = snapshot.store ?? {
    state: 'unavailable',
    items: [],
    entitlements: [],
    purchases: [],
    pending: []
  }

  const navigation: MatrixStoreNavigation = storeNavigation ?? {
    onQueryChange: setFallbackQuery,
    onShelfChange: setFallbackShelf,
    query: fallbackQuery,
    shelf: fallbackShelf
  }

  useEffect(() => bridge?.onReturn(() => returnControl.current?.focus()), [bridge])
  useEffect(() => {
    let live = true
    setMenu(null)
    setMenuFailed(false)

    if (selectedId && available && bridge) {
      if (hasSurface) {
        void bridge
          .menu(selectedId)
          .then(value => {
            if (live) {
              setMenu(value)
            }
          })
          .catch(() => {
            if (live) {
              setMenuFailed(true)
            }
          })
      }

      void bridge.connection(selectedId, 'read').catch(() => {})
    }

    return () => {
      live = false
    }
  }, [selectedId, version, hasSurface, available, bridge, attempt])

  // The catalog array is rebuilt on every snapshot, so this effect keys off a primitive
  // signature instead of an identity that changes without changing what is openable.
  const availableKey = apps?.state === 'ready'
    ? apps.apps
        .filter(app => app.availability === 'available')
        .map(app => `${app.app_id}\u0000${app.app}\u0000${app.app_version_id}`)
        .join('\u0001')
    : ''

  useEffect(() => {
    if (!availableKey) {
      return
    }

    const available = new Set(availableKey.split('\u0001'))

    setOpened(current => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id, entry]) => available.has(`${id}\u0000${entry.app}\u0000${entry.version}`))
      )

      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [availableKey])

  const connection = selected ? apps?.connections[selected.app] : undefined
  // Main's own read of the link beats the catalog's older copy.
  const linkState = connection?.connection?.state ?? selected?.link.state
  // A linked account has nothing to connect; only a link the app cannot serve any more
  // (`unavailable`) is offered a new Connect. A `pending` link stays settled: offering Connect
  // again for an account the person already linked is the repeated prompt this page must not show.
  const linkSettled = linkState === 'linked' && connection?.connection?.readiness !== 'unavailable'

  const noScreens = Boolean(
    selected &&
    available &&
    !menuFailed &&
    !opened[selected.app_id] &&
    (!selected.has_surface || (menu?.app.app_id === selectedId && menu.routes.length === 0))
  )

  const action = (value: 'read' | 'begin' | 'confirm' | 'cancel' | 'disconnect') => {
    if (!selected || !bridge) {
      return
    }

    if (value === 'disconnect') {
      setOpened(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected.app_id)))
    }

    setMenuFailed(false)
    void bridge
      .connection(selected.app_id, value)
      .then(() => {
        if (value === 'confirm' || value === 'disconnect') {
          setAttempt(value => value + 1)
        }
      })
      .catch(() => setMenuFailed(true))
  }

  return (
    <div className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} data-matrix-apps>
      {visible &&
        (!discover || menuFailed) &&
        (!available || menuFailed) &&
        (apps?.state === 'loading' ? (
          <Spinner className="m-auto size-5 animate-spin text-(--atum-ink-muted)" label={copy.loading} />
        ) : (
          <NoticeBand role="status" tone="notice">
            {copy.catalogUnavailable}
            <Button
              onClick={() =>
                void bridge
                  ?.refresh()
                  .then(() => setAttempt(value => value + 1))
                  .catch(() => setMenuFailed(true))
              }
              size="sm"
              variant="text"
            >
              {copy.refresh}
            </Button>
          </NoticeBand>
        ))}
      {discover && (
        <>
          {!storeNavigation && <MatrixStoreSidebar {...navigation} />}
          <MatrixDiscoverView
            agents={snapshot.agents ?? []}
            apps={{
              state: available ? 'ready' : apps?.state === 'loading' ? 'loading' : 'unavailable',
              items: apps?.apps ?? [],
              onRetry: () =>
                void bridge
                  ?.refresh()
                  .then(() => setAttempt(value => value + 1))
                  .catch(() => setMenuFailed(true))
            }}
            checkout={
              snapshot.checkout && window.atumMatrix.checkout
                ? {
                    snapshot: snapshot.checkout,
                    onRefresh: () => {
                      void window.atumMatrix.checkout!.refresh()
                    },
                    onStart: (packId: string) => window.atumMatrix.checkout!.start(packId),
                    onStatus: () => window.atumMatrix.checkout!.status(),
                    onResume: () => window.atumMatrix.checkout!.resume(),
                    onOpenCheckout: () => window.atumMatrix.checkout!.openCheckout(),
                    onDismissTerminal: () => window.atumMatrix.checkout!.dismissTerminal()
                  }
                : undefined
            }
            hatchPet={mode => matrixStoreHatchAction(snapshot, mode)}
            onTopUpPage={() => void window.atumMatrix.openTopUp().catch(() => {})}
            preferredAssistantId={snapshot.agents?.find(agent => agent.isDefault)?.assistantId}
            readSkills={readAssistantSkills}
            renderAppActions={app => (
              <AppCardActions
                app={app}
                fail={fail}
                key={app.app_id + app.app_version_id}
                onFailed={() => setMenuFailed(true)}
                snapshot={snapshot}
              />
            )}
            {...navigation}
            store={{
              snapshot: storeSnapshot,
              onAcquire: async (item, assistantId, consentRenewal) => {
                if (!storeBridge || !item.offer) {
                  return { outcome: 'uncertain' }
                }

                const result = await storeBridge.purchase({
                  offerId: item.offer.id,
                  offerVersion: item.offer.version,
                  ...(assistantId ? { assistantId } : {}),
                  ...(consentRenewal ? { consentRenewal } : {})
                })

                void storeBridge.refresh().catch(() => {})

                return result
              },
              onCancel: async entitlementId => {
                if (!storeBridge) {
                  throw new Error('matrix_store_unavailable')
                }

                await storeBridge.cancel(entitlementId)
                await storeBridge.refresh()
              },
              onResume: async idempotencyKey => {
                if (!storeBridge) {
                  return { outcome: 'uncertain' }
                }

                const result = await storeBridge.resume(idempotencyKey)
                void storeBridge.refresh().catch(() => {})

                return result
              },
              onRetry: () => void storeBridge?.refresh().catch(() => {})
            }}
            tryItem={(item, assistantId) => matrixStoreTryAction(snapshot, item, assistantId, locale)}
            wallet={snapshot.wallet}
          />
        </>
      )}
      {selected && (
        <div className="shrink-0 px-5 py-3">
          <div data-matrix-app-header ref={returnControl} tabIndex={-1}>
            <AppCatalogIdentity app={selected} context="detail" locale={locale} />
          </div>
          <AppShortcut app={selected} snapshot={snapshot} />
          <AppChat app={selected} key={selected.app_id + selected.app_version_id} snapshot={snapshot} />
          <div className="flex flex-wrap gap-2">
            {selected.link.mode === 'external_account' && (
              <>
                {(!connection || ['idle', 'failed'].includes(connection.phase)) && !linkSettled && (
                  <Button disabled={!available} onClick={() => action('begin')} size="sm" variant="secondary">
                    {copy.connect}
                  </Button>
                )}
                {['opening', 'waiting'].includes(connection?.phase ?? '') && (
                  <span role="status">{copy.browserWaiting}</span>
                )}
                {connection?.phase === 'confirm' && (
                  <>
                    <span>{copy.confirmConnection}</span>
                    <Button onClick={() => action('confirm')} size="sm">
                      {copy.confirm}
                    </Button>
                  </>
                )}
                {connection && ['opening', 'waiting', 'confirm', 'confirming'].includes(connection.phase) && (
                  <Button onClick={() => action('cancel')} size="sm" variant="text">
                    {copy.cancel}
                  </Button>
                )}
                <Button onClick={() => action('disconnect')} size="sm" variant="text">
                  {copy.disconnect}
                </Button>
                <Button onClick={() => action('read')} size="sm" variant="text">
                  {copy.refresh}
                </Button>
                {connection?.connection?.readiness === 'pending' && <span role="status">{copy.connectionPending}</span>}
                {connection?.connection?.readiness === 'ready' && <span role="status">{copy.connectionReady}</span>}
                {connection?.connection?.state === 'unlinked' && <span role="status">{copy.disconnected}</span>}
                {connection?.connection?.cleanup === 'pending' && (
                  <span role="status">{copy.disconnectCleanupPending}</span>
                )}
                {connection?.connection?.cleanup === 'unconfirmed' && (
                  <span role="status">{copy.disconnectCleanupUnconfirmed}</span>
                )}
                {connection?.phase === 'failed' && <span role="status">{copy.unavailable}</span>}
              </>
            )}
          </div>
          <div aria-label={copy.menu} className="mt-3 flex flex-wrap gap-2">
            {menu?.app.app_id === selectedId &&
              menu.routes.map(route => {
                const Icon = appSurfaceIcon(route.icon)

                return (
                  <Button
                    disabled={!available}
                    key={route.id}
                    onClick={() =>
                      setOpened(current => ({
                        ...current,
                        [selected.app_id]: { app: selected.app, route: route.id, version: selected.app_version_id }
                      }))
                    }
                    variant="secondary"
                  >
                    <Icon className="size-4" />
                    {appLocalizedCopy(route.label, locale, route.id)}
                  </Button>
                )
              })}
          </div>
          {opened[selected.app_id] && (
            // With a screen open: how to come back, and how to close it. Nothing to close otherwise.
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <p className="text-xs text-(--atum-ink-muted)">{copy.returnToHost}: ⌘⇧H</p>
              <Button
                onClick={() => {
                  setOpened(current =>
                    Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected.app_id))
                  )
                }}
                size="sm"
                variant="secondary"
              >
                {copy.close}
              </Button>
            </div>
          )}
          {noScreens && (
            // An app with nothing to show says so, with a real way out — not two faint words.
            <div className="mt-10 grid justify-items-center gap-3" data-matrix-app-empty>
              <EmptyState className="min-h-0" title={pageCopy[locale].noScreens} />
              <Button
                onClick={() => void runMatrixCommand({ kind: 'discoverApps' }).catch(() => setMenuFailed(true))}
                size="sm"
                variant="secondary"
              >
                {copy.close}
              </Button>
            </div>
          )}
        </div>
      )}
      {bridge &&
        Object.entries(opened).map(([id, entry]) => (
          <AtumAppView
            app={entry.app}
            bridge={bridge.view}
            hidden={!available || id !== selectedId || obstructed}
            key={`${id}:${entry.route}:${entry.version}`}
            onConnect={apps?.apps.find(app => app.app === entry.app)?.link.mode === 'external_account' ? () => action('begin') : undefined}
            routeId={entry.route}
          />
        ))}
    </div>
  )
}
