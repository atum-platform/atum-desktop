import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { type DesktopWebview, mountDesktopWebview } from '@/lib/desktop-webview-host'
import { openExternalLink } from '@/lib/external-link'
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Lock, RefreshCw, X } from '@/lib/icons'

import type {
  ConsumerBrowserNotice,
  ConsumerBrowserPopup,
  ConsumerBrowserPrepareInput,
  ConsumerBrowserPrepareResult
} from '../../../shared/browser/ipc'
import type { ConsumerBrowserTab } from '../../../shared/browser/tab'

export type { ConsumerBrowserStatus, ConsumerBrowserTab } from '../../../shared/browser/tab'

/** The narrow browser capability shared by Hermes and Matrix preloads. */
export interface ConsumerBrowserBridge {
  onPopup: (callback: (payload: ConsumerBrowserPopup) => void) => () => void
  onNotice: (callback: (payload: ConsumerBrowserNotice) => void) => () => void
  prepare: (input: ConsumerBrowserPrepareInput) => Promise<ConsumerBrowserPrepareResult>
  release: (partition: string) => Promise<{ ok: boolean }>
}

function defaultBrowserBridge(): ConsumerBrowserBridge | undefined {
  return window.hermesDesktop?.consumerBrowser
}

function defaultExternalOpener(url: string): void {
  openExternalLink(url)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * What a tab is called before its page names itself: the site ("vnexpress.net"),
 * never a raw address, a search phrase or a developer's localhost.
 */
export function consumerBrowserTabTitle(raw: string, fallback: string): string {
  const text = raw.trim()

  for (const candidate of [text, `https://${text}`]) {
    try {
      const url = new URL(candidate)
      const host = url.hostname.replace(/^www\./, '')
      const guessed = candidate !== text

      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        host &&
        !LOCAL_HOSTS.has(url.hostname) &&
        // A typed word without a dot is a search, not a site.
        (!guessed || (host.includes('.') && !/\s/.test(text)))
      ) {
        return host
      }
    } catch {
      // Not an address; try the next reading, then fall back.
    }
  }

  return fallback
}

export function createConsumerBrowserTab(url = 'https://www.google.com/', fallbackTitle = 'Browser'): ConsumerBrowserTab {
  const id = crypto.randomUUID()

  return {
    id,
    partition: `atum-consumer-browser-${id}`,
    status: 'loading',
    title: consumerBrowserTabTitle(url, fallbackTitle),
    url
  }
}

function visibleAddress(url: string, focused: boolean): string {
  if (focused || url === 'about:blank') {
    return url === 'about:blank' ? '' : url
  }

  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function AtumConsumerBrowser({
  browser = defaultBrowserBridge(),
  hidden = false,
  onOpenExternal = defaultExternalOpener,
  onOpenTab,
  onUpdate,
  tab
}: {
  browser?: ConsumerBrowserBridge
  hidden?: boolean
  onOpenExternal?: (url: string) => Promise<void> | void
  onOpenTab: (url: string) => void
  onUpdate: (next: ConsumerBrowserTab) => void
  tab: ConsumerBrowserTab
}) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<DesktopWebview | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const tabRef = useRef(tab)
  const openExternalRef = useRef(onOpenExternal)
  const openTabRef = useRef(onOpenTab)
  const updateRef = useRef(onUpdate)
  tabRef.current = tab
  openExternalRef.current = onOpenExternal
  openTabRef.current = onOpenTab
  updateRef.current = onUpdate
  const [addressFocused, setAddressFocused] = useState(false)
  const [address, setAddress] = useState(tab.url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(tab.status === 'loading')
  const [notice, setNotice] = useState<string | null>(null)

  useLayoutEffect(() => {
    // Focusing expands the abbreviated host into the full URL. Select only
    // after that value commits, otherwise typed/pasted addresses can append to
    // the old URL because the selection still covers the shorter host label.
    if (addressFocused) {
      addressRef.current?.select()
    }
  }, [addressFocused])

  const project = (patch: Partial<ConsumerBrowserTab>) => updateRef.current({ ...tabRef.current, ...patch })

  const navigate = async (raw: string) => {
    try {
      const prepared = await browser?.prepare({ partition: tab.partition, url: raw })

      if (!prepared) {
        throw new Error('browser_unavailable')
      }

      setAddress(prepared.url)
      setLoading(true)
      project({ status: 'loading', url: prepared.url })
      await webviewRef.current?.loadURL?.(prepared.url)
    } catch {
      setLoading(false)
      project({ status: 'blocked' })
    }
  }

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    let active = true
    let navigationFailed = false
    let webview: DesktopWebview | null = null

    const prepare = browser?.prepare({ partition: tab.partition, url: tab.url })

    void (prepare ?? Promise.reject(new Error('browser_unavailable')))
      .then(({ url }) => {
        if (!active) {
          return
        }

        webview = mountDesktopWebview({
          // Main denies native popup windows and turns validated public URLs
          // into normal tabs; without this flag Electron suppresses the event.
          allowPopups: true,
          className: 'h-full w-full flex-1 bg-(--atum-card)',
          host,
          partition: tab.partition,
          src: url
        })

        const syncHistory = () => {
          setCanGoBack(Boolean(webview?.canGoBack?.()))
          setCanGoForward(Boolean(webview?.canGoForward?.()))
        }

        const onStart = () => {
          if (!active) {
            return
          }

          navigationFailed = false
          setLoading(true)
          project({ status: 'loading' })
        }

        const onStop = () => {
          if (!active) {
            return
          }

          if (navigationFailed) {
            syncHistory()

            return
          }

          const currentUrl = webview?.getURL?.() || url
          let title = webview?.getTitle?.() || t.atum.browser.title

          try {
            title = webview?.getTitle?.() || new URL(currentUrl).hostname || t.atum.browser.title
          } catch {
            // Some failed navigation URLs are not parseable; retain the title.
          }

          setLoading(false)
          setAddress(currentUrl)
          syncHistory()
          project({ status: 'ready', title, url: currentUrl })
        }

        const onFail = (event: Event) => {
          if (!active || (event as Event & { errorCode?: number }).errorCode === -3) {
            return
          }

          navigationFailed = true
          setLoading(false)
          project({ status: 'error' })
        }

        webview.addEventListener('did-start-loading', onStart)
        webview.addEventListener('did-stop-loading', onStop)
        webview.addEventListener('did-navigate', syncHistory)
        webview.addEventListener('did-navigate-in-page', syncHistory)
        webview.addEventListener('did-fail-load', onFail)
        webviewRef.current = webview
      })
      .catch(() => {
        if (active) {
          project({ status: 'blocked' })
        }
      })

    const stopPopup = browser?.onPopup(payload => {
      if (payload.url && payload.sourceWebContentsId === webview?.getWebContentsId?.()) {
        openTabRef.current(payload.url)
      }
    })

    const stopNotice = browser?.onNotice(payload => {
      if (payload.sourceWebContentsId !== webview?.getWebContentsId?.()) {
        return
      }

      const notices: Record<string, string> = {
        download_refused: t.atum.browser.downloadRefused,
        download_busy: t.atum.browser.downloadBusy,
        download_failed: t.atum.browser.downloadFailed
      }

      setNotice(notices[payload.type] ?? t.atum.browser.blockedTitle)
    })

    return () => {
      active = false
      stopPopup?.()
      stopNotice?.()
      webview?.remove()
      webviewRef.current = null

      // Native release revokes network access before clearing ephemeral data.
      // Teardown must not create an unhandled rejection during app shutdown.
      void browser?.release(tab.partition).catch(() => {})
    }
    // A browser tab owns one webview for its entire mounted lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser, tab.id, tab.partition, t.atum.browser.title])

  const secure = tab.url.startsWith('https:')

  return (
    <section aria-label={t.atum.browser.title} className={hidden ? 'hidden' : 'flex h-full min-h-0 flex-col'}>
      {/* Mock 2e nav row: 40px, ‹ › ↻ 24px, address as a 30px sunk field r9 with a 12px lock. */}
      <div className="relative flex h-10 shrink-0 items-center gap-1 px-3" data-atum-browser-nav>
        <Tip label={t.atum.browser.back}>
          <span
            aria-label={!canGoBack ? t.atum.browser.back : undefined}
            className="inline-flex"
            tabIndex={!canGoBack ? 0 : undefined}
          >
            <button
              aria-label={t.atum.browser.back}
              className="atum-icon-btn size-6 rounded-[0.375rem]"
              data-icon-only
              disabled={!canGoBack}
              onClick={() => webviewRef.current?.goBack?.()}
              type="button"
            >
              <ChevronLeft className="size-4" />
            </button>
          </span>
        </Tip>
        <Tip label={t.atum.browser.forward}>
          <span
            aria-label={!canGoForward ? t.atum.browser.forward : undefined}
            className="inline-flex"
            tabIndex={!canGoForward ? 0 : undefined}
          >
            <button
              aria-label={t.atum.browser.forward}
              className="atum-icon-btn size-6 rounded-[0.375rem]"
              data-icon-only
              disabled={!canGoForward}
              onClick={() => webviewRef.current?.goForward?.()}
              type="button"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        </Tip>
        <Tip label={loading ? t.atum.browser.stop : t.atum.browser.reload}>
          <button
            aria-label={loading ? t.atum.browser.stop : t.atum.browser.reload}
            className="atum-icon-btn size-6 rounded-[0.375rem]"
            data-icon-only
            onClick={() => (loading ? webviewRef.current?.stop?.() : webviewRef.current?.reload?.())}
            type="button"
          >
            {loading ? (
              <X className="size-4" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </button>
        </Tip>
        <div className="ms-1 flex h-[1.875rem] min-w-0 flex-1 items-center gap-1.5 rounded-[var(--atum-r-tab)] bg-(--atum-sunk) px-2.5">
          {secure ? (
            <Lock aria-hidden className="size-3 shrink-0 text-(--atum-ink-faint)" />
          ) : (
            <Tip label={t.atum.browser.insecure}>
              <span className="inline-flex" tabIndex={0}>
                <AlertTriangle aria-hidden className="size-3 shrink-0 text-(--atum-warn)" />
              </span>
            </Tip>
          )}
          <input
            aria-label={t.atum.browser.address}
            className="min-w-0 flex-1 bg-transparent text-(length:--atum-t-control) text-(--atum-ink) outline-none placeholder:text-(--atum-ink-faint)"
            onBlur={() => setAddressFocused(false)}
            onChange={event => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void navigate(event.currentTarget.value)
                event.currentTarget.blur()
              }
            }}
            ref={addressRef}
            value={visibleAddress(address, addressFocused)}
          />
        </div>
        <Tip label={t.atum.browser.openInBrowser}>
          <button
            aria-label={t.atum.browser.openInBrowser}
            className="atum-icon-btn size-6 rounded-[0.375rem]"
            data-icon-only
            onClick={() => {
              const url = webviewRef.current?.getURL?.() || tabRef.current.url

              void openExternalRef.current(url)
            }}
            type="button"
          >
            <ExternalLink aria-hidden className="size-4" />
          </button>
        </Tip>
        {loading && (
          <div
            aria-label={t.atum.browser.loading}
            className="absolute inset-x-0 bottom-0 h-0.5 bg-(--atum-accent) motion-reduce:w-1/2"
            role="progressbar"
          />
        )}
      </div>
      {/* Mock 2e: the webview area is r12 on top, white (dark: bg-high), margin 4 14 0. */}
      <div
        className="relative mx-3.5 mt-1 min-h-0 flex-1 overflow-hidden rounded-t-[0.75rem] bg-(--atum-browser-page) shadow-[var(--atum-glass-edge)]"
        data-atum-browser-page
        data-pet-walk-surface="browser"
      >
        {notice && (
          <div
            className="absolute inset-x-3 top-3 z-10 rounded-[var(--atum-r-control)] bg-(--atum-sunk) px-3 py-2 text-xs text-(--atum-ink)"
            role="status"
          >
            {notice}
          </div>
        )}
        <div className="h-full" ref={hostRef} />
        {(tab.status === 'blocked' || tab.status === 'error') && (
          <div className="absolute inset-0 grid place-items-center bg-(--atum-browser-page) px-5 text-center">
            <div className="max-w-xs">
              <h3 className="text-[0.875rem] font-semibold text-(--atum-ink)">
                {tab.status === 'blocked' ? t.atum.browser.blockedTitle : t.atum.browser.errorTitle}
              </h3>
              <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">
                {tab.status === 'blocked' ? t.atum.browser.blockedBody : t.atum.browser.errorBody}
              </p>
              <button
                className="mt-2 text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
                onClick={() => void navigate(tab.url)}
                type="button"
              >
                {t.atum.browser.retry}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
