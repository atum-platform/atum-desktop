import './settings-revamp.css'

import { useEffect, useId, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixPageId } from '../../shared/matrix-pages'

import {
  type MatrixSettingsPane,
  type MatrixSettingsProtons,
  normalizeMatrixSettingsPane,
  SettingsRevampBack,
  SettingsRevampNavigation,
  SettingsRevampPane,
  SettingsRevampTitle
} from './settings-revamp'

export type { MatrixSettingsPane, MatrixSettingsProtons } from './settings-revamp'

/**
 * Settings keeps the existing overlay, focus return and always-mounted provider setup
 * lifecycle. The revamp changes only the information architecture inside that boundary.
 */
export function MatrixSettingsSheet({
  cloudOnly,
  fail,
  onClose,
  onEditProfile,
  onOpenAdvancedPage,
  onPaneChange,
  open,
  pane,
  protons,
  snapshot
}: {
  cloudOnly?: boolean
  fail: () => void
  onClose(): void
  onEditProfile?(): void
  /** Settings › Advanced: open one of an assistant's own pages in the window (a side trip). */
  onOpenAdvancedPage?(page: MatrixPageId, agentPrincipal: string): void
  onPaneChange(pane: MatrixSettingsPane): void
  open: boolean
  pane: MatrixSettingsPane
  /** The wallet: content for the always-present Protons destination, once its provider exists. */
  protons?: MatrixSettingsProtons
  snapshot: MatrixSnapshot
}) {
  const { t } = useI18n()
  const current = normalizeMatrixSettingsPane(pane)
  const titleId = useId()
  const sheet = useRef<HTMLElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const identity = `${snapshot.identity?.userId ?? ''}:${snapshot.identity?.deviceId ?? ''}`
  const previousIdentity = useRef(identity)
  const [narrowDetail, setNarrowDetail] = useState(false)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) {
      return
    }

    // A direct destination (recovery, Protons, Help, Advanced) opens its detail on a narrow
    // window. The ordinary Settings entry starts on the destination list with Account
    // selected, then uses Back rather than compressing two columns.
    setNarrowDetail(current !== 'account')
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.current?.focus({ preventScroll: true })

    // A popup inside the sheet takes Escape first and marks it handled. One Escape closes
    // only this layer; it never also activates the control underneath.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onCloseRef.current()
      }
    }

    document.addEventListener('keydown', escape)

    return () => {
      document.removeEventListener('keydown', escape)

      const back =
        returnFocus.current?.isConnected && returnFocus.current.tabIndex >= 0
          ? returnFocus.current
          : document.querySelector<HTMLElement>('[data-matrix-rail-account]')

      back?.focus({ preventScroll: true })
      returnFocus.current = null
    }
    // Opening owns capture/restore. A pane or account update must not replace the opener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const previous = previousIdentity.current
    previousIdentity.current = identity

    if (open && previous !== identity) {
      // A sheet that survives an account hand-off cannot keep another account's pane or
      // draft in front. Keyed recovery/provider children clear their own sensitive state.
      onPaneChange('account')
      setNarrowDetail(false)
    }
  }, [identity, onPaneChange, open])

  const select = (destination: Parameters<typeof onPaneChange>[0]) => {
    onPaneChange(destination)
    setNarrowDetail(true)
  }

  const back = () => {
    setNarrowDetail(false)
    requestAnimationFrame(() => {
      sheet.current
        ?.querySelector<HTMLElement>(`[data-matrix-settings-pane="${current}"]`)
        ?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="atum-settings-layer fixed inset-0" data-matrix-settings hidden={!open} inert={!open || undefined}>
      {open && <AppViewOverlayHold />}
      <div aria-hidden className="atum-settings-scrim" onClick={onClose} />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="atum-sheet atum-settings atum-settings-revamp"
        data-narrow-detail={narrowDetail || undefined}
        data-slot="dialog-content"
        ref={sheet}
        role="dialog"
        tabIndex={-1}
      >
        <SettingsRevampNavigation current={current} onSelect={select} snapshot={snapshot} />
        <div className="atum-settings-detail flex min-w-0 flex-1 flex-col">
          <header className="atum-settings-header flex h-12 shrink-0 items-center gap-3 ps-6 pe-3">
            <SettingsRevampBack onClick={back} />
            <h2 className="min-w-0 flex-1 truncate [font:var(--ak-t-title)] text-(--ak-ink)" id={titleId}>
              <SettingsRevampTitle destination={current} />
            </h2>
            <Tip label={t.common.close}>
              <button aria-label={t.common.close} className="atum-icon-btn size-7" onClick={onClose} type="button">
                <X aria-hidden className="size-4" />
              </button>
            </Tip>
          </header>
          <div className="atum-settings-panes min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <SettingsRevampPane
              cloudOnly={cloudOnly}
              current={current}
              fail={fail}
              onClose={onClose}
              onEditProfile={onEditProfile}
              onOpenAdvancedPage={onOpenAdvancedPage}
              open={open}
              protons={protons}
              snapshot={snapshot}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
