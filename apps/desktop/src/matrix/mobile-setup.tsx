import QRCode from 'qrcode'
import { type RefObject, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Spinner, X } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'

import { useMobileCopy } from './mobile-copy'
import { ownHandleLine, useOwnName } from './rail-account'

/** Public download only. Never add account, token or recovery material to this URL. */
export const ELEMENT_X_DOWNLOAD = 'https://element.io/en/download'

export function mobileServer(raw: string | undefined): { url: string; localOnly: boolean } | null {
  if (!raw) {
    return null
  }

  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')

    const localOnly =
      host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)

    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(localOnly && url.protocol === 'http:'))
    ) {
      return null
    }

    return { url: url.href.replace(/\/$/, ''), localOnly }
  } catch {
    return null
  }
}

/** The account menu opens the sheet; it is owned by the account root. */
export function MatrixMobileSetup({
  snapshot,
  open,
  onOpenChange,
  fallbackFocusRef
}: {
  snapshot: MatrixSnapshot
  open: boolean
  onOpenChange(open: boolean): void
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open && (
        <MobileContent
          fallbackFocusRef={fallbackFocusRef}
          key={JSON.stringify([snapshot.identity, snapshot.homeserver])}
          snapshot={snapshot}
        />
      )}
    </Dialog>
  )
}

/**
 * Two steps: get Element X (the QR is only its download page), then sign in with the
 * Atum account, entering the server once (one tappable line copies it). What only a few
 * people need waits under "More help". Nothing here signs in, shares a credential or
 * manages sessions.
 */
function MobileContent({
  snapshot,
  fallbackFocusRef
}: {
  snapshot: MatrixSnapshot
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useI18n()
  const copy = useMobileCopy()
  // The person's own @handle, never their Matrix ID; with no handle the line is left out.
  const handle = ownHandleLine({ handle: useOwnName(snapshot).handle, name: '' })
  const server = mobileServer(snapshot.homeserver)
  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let live = true
    void QRCode.toDataURL(ELEMENT_X_DOWNLOAD, { width: 176, margin: 4, errorCorrectionLevel: 'M' })
      .then(value => {
        if (live) {
          setQr(value)
        }
      })
      .catch(() => {
        if (live) {
          setQrFailed(true)
        }
      })

    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!copied) {
      return
    }

    const timeout = setTimeout(() => setCopied(false), 2000)

    return () => clearTimeout(timeout)
  }, [copied])

  const act = async (action: () => Promise<void>) => {
    if (pending) {
      return
    }

    setPending(true)
    setError(false)

    try {
      await action()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <DialogContent
      onCloseAutoFocus={event => {
        event.preventDefault()

        if (
          opener.current?.isConnected &&
          opener.current.tabIndex >= 0 &&
          !opener.current.closest('[inert], [hidden]')
        ) {
          opener.current.focus({ preventScroll: true })
        } else {
          // The account menu is gone by now: go back to the account itself.
          ;(
            fallbackFocusRef?.current ?? window.document.querySelector<HTMLElement>('[data-matrix-rail-account]')
          )?.focus({ preventScroll: true })
        }
      }}
      // The sheet itself takes focus, never the title: no ring after a click (it would sit on
      // Close, with its tooltip), and Tab reaches Close first.
      onOpenAutoFocus={event => {
        event.preventDefault()
        opener.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
        sheet.current?.focus({ preventScroll: true })
      }}
      ref={sheet}
      showCloseButton={false}
      tabIndex={-1}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="mt-2">{copy.description}</DialogDescription>
        </div>
        <Tip label={t.common.close}>
          <DialogClose asChild>
            <Button aria-label={t.common.close} size="icon-xs" variant="ghost">
              <X aria-hidden />
            </Button>
          </DialogClose>
        </Tip>
      </div>
      <section className="mb-5 space-y-3">
        <h3 className="text-sm font-semibold">{copy.download}</h3>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-40 shrink-0 items-center justify-center">
            {qr ? (
              <img alt={copy.qr} className="size-40 rounded-(--atum-r-control)" src={qr} />
            ) : qrFailed ? (
              <NoticeBand tone="notice">{copy.qrFailed}</NoticeBand>
            ) : (
              <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={t.common.loading} />
            )}
          </div>
          <div className="min-w-40 flex-1 space-y-3 text-sm text-(--ui-text-secondary)">
            <p>{copy.downloadHelp}</p>
            <Button
              disabled={pending}
              onClick={() => void act(() => window.atumMatrix.openLink(ELEMENT_X_DOWNLOAD))}
              variant="secondary"
            >
              {copy.openDownload}
            </Button>
          </div>
        </div>
      </section>
      <section className="mb-4 space-y-2 text-sm">
        <h3 className="font-semibold">{copy.connect}</h3>
        {!server || server.localOnly ? (
          <NoticeBand tone="notice">{server ? copy.localOnly : copy.serverMissing}</NoticeBand>
        ) : (
          <>
            <p className="text-(--ui-text-secondary)">{copy.connectHelp}</p>
            {/* The address is the one thing to type on the phone: one line, one tap copies it. */}
            <button
              aria-label={copied ? copy.copied : copy.copyServer}
              className="flex w-full items-center gap-3 rounded-(--atum-r-control) bg-(--atum-sunk) px-3 py-2 text-left hover:bg-(--atum-hover) disabled:opacity-60"
              data-matrix-mobile-server
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  await writeClipboardText(server.url)
                  setCopied(true)
                })
              }
              type="button"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-(--atum-ink) select-text">{server.url}</span>
              <span aria-hidden className="shrink-0 text-xs text-(--atum-ink-muted)">
                {copied ? copy.copied : copy.copyHint}
              </span>
            </button>
            <p className="text-(--ui-text-secondary)">{copy.signInHelp}</p>
          </>
        )}
      </section>
      <details className="atum-settings-more text-sm" data-matrix-mobile-more>
        <summary>{copy.moreHelp}</summary>
        <div className="mt-2 space-y-2 text-xs text-(--ui-text-secondary)">
          {handle && (
            <p>
              {copy.account}: {handle}
            </p>
          )}
          <p>{copy.qrHelp}</p>
          <p>{copy.secureHelp}</p>
        </div>
      </details>
      {error && (
        <NoticeBand role="alert" tone="failure">
          {copy.actionFailed}
        </NoticeBand>
      )}
    </DialogContent>
  )
}
