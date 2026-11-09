import './panel.css'

import { useEffect, useMemo, useRef, useState } from 'react'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { AtumAppView } from '@/app/atum/app-view'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { VerifiedMark } from '@/components/verified-mark'
import { useMediaQuery } from '@/hooks/use-media-query'
import { type Locale, useI18n } from '@/i18n'
import { appSurfaceIcon } from '@/lib/atum-app-surface-icons'
import { ChevronLeft, ExternalLink } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type AppDescriptor, appLocalizedCopy } from '../../../shared/app-catalog'
import type { AppViewState } from '../../../shared/app-view/ipc'
import { requiresPlatformConnection } from '../../../shared/app-view/protocol'
import type { MatrixAppMenu, MatrixSnapshot } from '../../../shared/matrix'
import { matrixDisplayMode } from '../../../shared/matrix-display-preferences'
import { appVerificationTier } from '../../../shared/verification'
import { useAppCopy } from '../app-copy'
import { focusMatrixComposer } from '../composer-focus'

import { resolveAppPanelLook } from './panel-look'
import type { AppBotRouteRequest } from './route-request'

interface PanelWords {
  openIn: (app: string) => string
  back: string
  openInBrowser: string
  noScreens: string
  /** A page that lost its account link: back to the chat's connect card. */
  linkLabel: string
  linkMessage: (app: string) => string
  failed: string
  offline: string
}

const panelCopy: Record<Locale, PanelWords> = {
  en: {
    openIn: app => `Open in ${app}`,
    back: 'Back',
    openInBrowser: 'Open in browser',
    noScreens: 'This app has no screens yet.',
    linkLabel: 'Back to chat',
    linkMessage: app => `Link ${app} in the chat to open this page.`,
    failed: 'Couldn’t open this page.',
    offline: 'You’re offline. This page will reopen when you’re online.'
  },
  vi: {
    openIn: app => `Mở trong ${app}`,
    back: 'Quay lại',
    openInBrowser: 'Mở trong trình duyệt',
    noScreens: 'Ứng dụng này chưa có màn hình nào.',
    linkLabel: 'Quay lại trò chuyện',
    linkMessage: app => `Liên kết ${app} trong trò chuyện để mở trang này.`,
    failed: 'Không mở được trang này.',
    offline: 'Bạn đang ngoại tuyến. Trang sẽ tự mở lại khi có mạng.'
  },
  ja: {
    openIn: app => `${app} で開く`,
    back: '戻る',
    openInBrowser: 'ブラウザで開く',
    noScreens: 'このアプリにはまだ画面がありません。',
    linkLabel: 'チャットに戻る',
    linkMessage: app => `チャットで ${app} を連携すると、このページを開けます。`,
    failed: 'このページを開けませんでした。',
    offline: 'オフラインです。接続が戻ると自動で開き直します。'
  },
  zh: {
    openIn: app => `在 ${app} 中打开`,
    back: '返回',
    openInBrowser: '在浏览器中打开',
    noScreens: '此应用还没有任何界面。',
    linkLabel: '返回聊天',
    linkMessage: app => `在聊天中关联 ${app} 即可打开此页面。`,
    failed: '无法打开此页面。',
    offline: '你已离线。联网后此页面会自动重新打开。'
  },
  'zh-hant': {
    openIn: app => `在 ${app} 中開啟`,
    back: '返回',
    openInBrowser: '在瀏覽器中開啟',
    noScreens: '此應用程式還沒有任何畫面。',
    linkLabel: '返回聊天',
    linkMessage: app => `在聊天中連結 ${app} 即可開啟此頁面。`,
    failed: '無法開啟此頁面。',
    offline: '你已離線。連線後此頁面會自動重新開啟。'
  }
}

type Route = MatrixAppMenu['routes'][number]

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function AppBotPanel({
  app,
  botApiRoom,
  hidden,
  onBackToChat,
  onRequestConsumed,
  request,
  snapshot
}: {
  app: AppDescriptor
  /** Bot API apps own their web login, so their room never needs an Atum account link. */
  botApiRoom: boolean
  hidden: boolean
  onBackToChat(): void
  onRequestConsumed?(serial: number): void
  request?: AppBotRouteRequest
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = useAppCopy()
  const words = panelCopy[locale] ?? panelCopy.en
  const bridge = window.atumMatrix.apps
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const look = resolveAppPanelLook(app, matrixDisplayMode(snapshot.displayPreferences?.appearance.value, systemDark))
  const [menu, setMenu] = useState<MatrixAppMenu | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  // Choosing a page again reopens it, even when it is the page already open.
  const [pageRevision, setPageRevision] = useState(0)
  const [navigation, setNavigation] = useState<AppViewState | null>(null)
  // Read inside the effect without making the menu itself a dependency (that would re-read).
  const holdsMenu = useRef(false)
  holdsMenu.current = menu !== null

  const ready =
    snapshot.state === 'ready' &&
    snapshot.apps?.state === 'ready' &&
    app.availability === 'available' &&
    app.bot?.state === 'active' &&
    Boolean(app.bot.device)

  const linked = !requiresPlatformConnection(app.link)
  const menuAllowed = linked || botApiRoom
  const name = app.bot?.display_name ?? appLocalizedCopy(app.name, locale, app.app)
  const subtitle = appLocalizedCopy(app.subtitle, locale)

  useEffect(() => {
    let live = true

    if (!menuAllowed) {
      setMenu(null)
      setSelected(null)

      return
    }

    if (hidden || !ready || !bridge) {
      return
    }

    // A failed refresh never drops a menu already on screen (a rate-limited read must not turn
    // the panel back into a loading state); only a panel with no menu asks again from the start.
    if (!holdsMenu.current) {
      setFailed(false)
    }

    // A menu that never answers becomes the same recoverable notice as one that fails.
    const timeout = window.setTimeout(() => {
      if (live && !holdsMenu.current) {
        live = false
        setFailed(true)
      }
    }, 15_000)

    void bridge.menu(app.app_id).then(
      value => {
        if (!live) {
          return
        }

        window.clearTimeout(timeout)

        if (value.app.app_id !== app.app_id || value.app.app_version_id !== app.app_version_id) {
          setFailed(true)

          return
        }

        setFailed(false)
        setMenu(value)
      },
      () => {
        if (live) {
          setFailed(true)
        }
      }
    )

    return () => {
      live = false
      window.clearTimeout(timeout)
    }
  }, [app.app_id, app.app_version_id, attempt, bridge, hidden, menuAllowed, ready])

  useEffect(
    () =>
      bridge?.onReturn(() => {
        if (!hidden) {
          onBackToChat()
        }
      }),
    [bridge, hidden, onBackToChat]
  )

  // The roster click already opened the app's canonical chat. Keep that route available to
  // main for an explicit request, but do not offer a second "Chat" destination beside the chat
  // the person is already using. The id comes from the catalog; the renderer never infers a URL.
  // Declared `atum.app-panel/1` pages give the order and glyphs; without them, the menu's routes.
  const routes = useMemo(() => {
    const declared: Route[] = menu?.pages
      ? menu.pages.flatMap(page => {
          const route = menu.routes.find(route => route.id === page.routeId)

          return route ? [{ ...route, icon: page.glyph }] : []
        })
      : (menu?.routes ?? [])

    return declared.filter(route => route.id !== app.bot?.open_route_id)
  }, [app.bot?.open_route_id, menu])

  const launchable = useMemo(
    () =>
      menu ? [...new Map([...menu.routes, ...(menu.actions ?? [])].map(route => [route.id, route])).values()] : [],
    [menu]
  )

  const currentRoute = launchable.find(route => route.id === selected)

  const choose = (id: string) => {
    setPageRevision(value => value + 1)
    setNavigation(null)
    setSelected(id)
  }

  const goHome = () => {
    setNavigation(null)
    setSelected(null)
  }

  // Back walks the page's own history first; at a page's root it returns to the app's pages.
  const goBack = () => {
    if (navigation?.canGoBack && !navigation.atRouteRoot) {
      void bridge?.view.back?.(navigation.viewId)
    } else {
      goHome()
    }
  }

  // A URL match retitles the bar only onto a page this panel shows (or the open one): an app
  // whose chat route sits at "/" must not retitle every undeclared sub-page with the chat's name.
  const matched = navigation?.matchedRouteId
  const activeId = matched && (matched === selected || routes.some(route => route.id === matched)) ? matched : selected
  const shownRoute = launchable.find(route => route.id === activeId) ?? currentRoute

  const onNavigation = (state: AppViewState) => {
    if (state.panelCommand === 'focus-chat') {
      focusMatrixComposer()

      return
    }

    if (typeof state.panelCommand === 'number') {
      const route = routes[state.panelCommand]

      if (route) {
        choose(route.id)
      }

      return
    }

    setNavigation(previous => (previous?.viewId === state.viewId ? { ...previous, ...state } : state))
  }

  useEffect(() => {
    if (
      !menu ||
      !request ||
      request.appId !== app.app_id ||
      !ready ||
      !menuAllowed ||
      !launchable.some(route => route.id === request.routeId)
    ) {
      return
    }

    setNavigation(null)
    setSelected(request.routeId)
    onRequestConsumed?.(request.serial)
  }, [app.app_id, launchable, menu, menuAllowed, onRequestConsumed, ready, request])

  const routeLabel = (route: Route) => appLocalizedCopy(route.label, locale, route.id)

  return (
    <section
      aria-label={name}
      className={cn('app-panel', look.ground && (look.tone === 'dark' ? 'ak-dark' : 'ak-light'))}
      data-app-bot-panel={app.app}
      data-app-panel-accent={look.accent ? true : undefined}
      data-atum-look={look.ground ? 'pack' : undefined}
      data-atum-look-tone={look.tone}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
          const route = routes[Number(event.key) - 1]

          if (route) {
            event.preventDefault()
            choose(route.id)
          }
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r' && navigation) {
          event.preventDefault()
          void bridge?.view.reload(navigation.viewId)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          focusMatrixComposer()
        }
      }}
      style={look.style}
    >
      {bridge && currentRoute ? (
        <>
          {/* Atum's standard bar over every app page: Back, the app, the page. */}
          <header className="app-panel-bar" data-app-panel-bar>
            <Tip label={words.back}>
              <button aria-label={words.back} className="ak-iconbtn ak-iconbtn--sm" onClick={goBack} type="button">
                <ChevronLeft aria-hidden className="ak-icon" />
              </button>
            </Tip>
            <AppCatalogAvatar app={app} className="size-5 text-[0.5625rem]" locale={locale} tile />
            <h2 className="min-w-0 flex-1 truncate [font:var(--ak-t-body-strong)]" data-app-panel-page>
              {shownRoute ? routeLabel(shownRoute) : name}
            </h2>
            <Tip label={words.openInBrowser}>
              <button
                aria-label={words.openInBrowser}
                className="ak-iconbtn ak-iconbtn--sm"
                disabled={!navigation || !bridge.view.external}
                onClick={() => {
                  if (navigation) {
                    void bridge.view.external?.(navigation.viewId)
                  }
                }}
                type="button"
              >
                <ExternalLink aria-hidden className="ak-icon" />
              </button>
            </Tip>
          </header>
          {!ready && (
            <NoticeBand className="m-(--ak-s3)" role="status" tone="notice">
              {copy.unavailable}
            </NoticeBand>
          )}
          <div className={cn('app-panel-view', look.pageTone && `ak-${look.pageTone}`)} data-app-panel-view>
            <AtumAppView
              app={app.app}
              bridge={bridge.view}
              hidden={hidden || !ready}
              key={`${app.app_version_id}:${currentRoute.id}:${pageRevision}`}
              linkRecovery={
                app.link.mode === 'none' ? { label: words.linkLabel, message: words.linkMessage(name) } : undefined
              }
              onConnect={onBackToChat}
              onNavigation={onNavigation}
              panelPresentation={{ failed: words.failed, offline: words.offline }}
              routeId={currentRoute.id}
            />
          </div>
        </>
      ) : (
        <div className="app-panel-home">
          <header className="app-panel-identity" data-app-panel-identity>
            <AppCatalogAvatar app={app} className="size-14 text-[1.375rem]" locale={locale} tile />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1">
                <h2 className="truncate [font:var(--ak-t-title)]" data-app-catalog-name>
                  {name}
                </h2>
                <VerifiedMark subject="app" tier={appVerificationTier(app)} />
              </div>
              {subtitle && <p className="truncate text-(--ak-ink-2) [font:var(--ak-t-callout)]">{subtitle}</p>}
            </div>
          </header>

          {/* The pages: one column of capsules, centred on the panel. */}
          <section aria-label={words.openIn(name)} className="app-panel-pages" data-app-panel-pages>
            <div className="app-panel-page-list">
              {!menuAllowed ? (
                // One action, nothing else: the connect card itself lives in the chat.
                <button
                  className="ak-btn ak-btn--lg ak-btn--primary app-panel-primary"
                  data-app-panel-connect
                  onClick={onBackToChat}
                  type="button"
                >
                  {copy.connect}
                </button>
              ) : !ready || (!menu && failed) ? (
                <NoticeBand role="status" tone="notice">
                  {copy.unavailable}
                  {ready && (
                    <Button onClick={() => setAttempt(value => value + 1)} size="sm" variant="text">
                      {copy.retry}
                    </Button>
                  )}
                </NoticeBand>
              ) : !menu ? (
                <div aria-busy className="contents" data-app-panel-loading>
                  <span className="sr-only" role="status">
                    {copy.loading}
                  </span>
                  {[0, 1, 2, 3].map(index => (
                    <span aria-hidden className="ak-skeleton app-panel-page-skeleton" key={index} />
                  ))}
                </div>
              ) : routes.length === 0 ? (
                <p className="text-center text-(--ak-ink-3) [font:var(--ak-t-callout)]">{words.noScreens}</p>
              ) : (
                <div className="contents" data-app-bot-functions>
                  {routes.map(route => {
                    const Icon = appSurfaceIcon(route.icon)

                    return (
                      <button
                        className="ak-btn ak-btn--lg app-panel-page"
                        disabled={route.session === 'required' && !linked && !botApiRoom}
                        key={route.id}
                        onClick={() => choose(route.id)}
                        type="button"
                      >
                        <Icon aria-hidden className="ak-icon" />
                        <span className="app-panel-page-label">{routeLabel(route)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
