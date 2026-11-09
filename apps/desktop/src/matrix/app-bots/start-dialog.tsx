import { type ReactNode, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { useI18n } from '@/i18n'
import { useAppViewOverlayHoldWhenOverlapping } from '@/store/use-app-view-overlay'

import type { AppBotDescriptor, AppDescriptor } from '../../../shared/app-catalog'
import { resolveStartCardLook } from '../look/resolve-look'

/**
 * Draws its children in the middle of the chat panel (the conversation column that carries
 * `data-atum-chat`), above the transcript and clear of the composer, wherever in that column the
 * caller sits. The caller lives in the composer's dock, which only reaches the column's foot; a portal
 * keeps its state and context and moves only where it is drawn. Outside a chat column (a surface that
 * mounts it alone) the children simply stay where they are.
 */
function InChatPanel({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [panel, setPanel] = useState<Element | null>(null)
  // A native app view under the dialog would paint over it, so the view is held back while they overlap
  // (store/use-app-view-overlay.ts; the guard is components/overlay-inventory.test.ts). The box is measured
  // once the portal has it: the ref changes when the box does, which measures again.
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const measured = useMemo<RefObject<HTMLDivElement | null>>(() => ({ current: box }), [box])

  useAppViewOverlayHoldWhenOverlapping(measured)
  useLayoutEffect(() => setPanel(anchor.current?.closest('[data-atum-chat]') ?? null), [])

  return (
    <>
      <span hidden ref={anchor} />
      {panel
        ? createPortal(
            // The dock publishes its height on the column (composer-dock.tsx): the middle is the
            // middle of what is above the composer. Only the dialog takes the pointer.
            <div
              className="pointer-events-none absolute inset-x-0 top-0 bottom-[var(--atum-dock-height,0px)] z-40 grid place-items-center p-4"
              data-app-start-center
              ref={setBox}
            >
              {children}
            </div>,
            panel
          )
        : children}
    </>
  )
}

/**
 * The one small dialog an app's chat asks before it can start: the app's face, its name and, in the
 * start step, one short line, with whatever the step needs (a button, a status) beneath. It names no
 * app: the catalog's descriptor is all it reads. `children` is the step's lines and buttons.
 */
export function AppStartDialog({
  app,
  appearance = 'light',
  children,
  line,
  lineProps
}: {
  app: AppDescriptor & { bot: AppBotDescriptor }
  appearance?: 'light' | 'dark'
  children?: ReactNode
  /** The one short sentence under the name. */
  line?: string
  lineProps?: Record<`data-${string}`, string | true>
}) {
  const { locale } = useI18n()
  const id = useId()
  const band = resolveStartCardLook(app.look, appearance)

  return (
    <InChatPanel>
      <div
        aria-describedby={line ? `${id}-line` : undefined}
        aria-labelledby={`${id}-name`}
        aria-modal="false"
        className="atum-sheet pointer-events-auto w-[min(21rem,100%)] overflow-hidden text-center animate-in fade-in-0 duration-200"
        data-app-bot-setup={app.app}
        role="dialog"
      >
        <div
          className="atum-look-start-band flex h-[7.375rem] items-end gap-3 px-[1.125rem] pb-3.5 text-start"
          data-app-start-band
          data-atum-look-tone={band.tone}
          style={band.style}
        >
          <AppCatalogAvatar app={app} className="size-14" locale={locale} tile />
          <p
            className="pb-1 text-lg leading-tight font-semibold text-[var(--look-band-ink,var(--atum-root-ink))]"
            id={`${id}-name`}
          >
            {app.bot.display_name}
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 px-6 py-5">
          {line && (
            <p
              // Japanese breaks between phrases, not mid-word (Chromium: auto-phrase, for lang="ja" only).
              className="text-[0.9375rem] leading-relaxed text-balance text-(--atum-ink-soft) [word-break:auto-phrase]"
              id={`${id}-line`}
              {...lineProps}
            >
              {line}
            </p>
          )}
          {children}
        </div>
      </div>
    </InChatPanel>
  )
}
