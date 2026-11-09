import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronRight, PinFilled, X } from '@/lib/icons'

import type { MatrixPinnedMessages } from '../../../shared/matrix'

import { usePinnedMessagesCopy } from './pinned-copy'

/** The channel-header control stays visible at zero so the shared return path is discoverable. */
export function PinnedMessagesButton({ count, onClick, open }: { count: number; onClick(): void; open: boolean }) {
  const copy = usePinnedMessagesCopy()
  const label = count ? copy.pinnedMessageCount(count) : copy.pinnedMessages

  return (
    <Tip label={label}>
      <button
        aria-expanded={open}
        aria-label={label}
        className="ak-btn ak-btn--plain ak-btn--sm gap-1 px-2"
        data-matrix-pinned-button
        onClick={onClick}
        type="button"
      >
        <PinFilled aria-hidden className="size-4" />
        <span className="text-xs font-medium tabular-nums">{count}</span>
      </button>
    </Tip>
  )
}

/** The quiet shared marker shown on every currently pinned message. */
export function PinnedMessageMarker() {
  const copy = usePinnedMessagesCopy()

  return (
    <Tip label={copy.pinnedMessage}>
      <span
        aria-label={copy.pinnedMessage}
        className="inline-flex items-center text-(--atum-ink-faint)"
        data-matrix-pinned-marker
        role="img"
      >
        <PinFilled aria-hidden className="size-3.5" />
      </span>
    </Tip>
  )
}

/** Mattermost-style pinned-message side panel. State is Matrix's; this component only presents
 * the bounded selected-room projection and asks the transcript owner to reveal a row. */
export function PinnedMessagesPanel({
  compact,
  nameOf,
  onClose,
  onJump,
  pinned
}: {
  compact: boolean
  nameOf(userId: string): string
  onClose(): void
  onJump(eventId: string, threadRootId?: string): void
  pinned: MatrixPinnedMessages
}) {
  const copy = usePinnedMessagesCopy()
  const { locale } = useI18n()
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale])

  return (
    <aside
      aria-label={copy.pinnedMessages}
      className={`${compact ? 'absolute inset-0 z-20 bg-(--atum-main-bg)' : 'absolute inset-y-0 end-0 z-10 w-[26rem] border-s border-(--atum-line) bg-(--atum-main-bg)'} flex min-h-0 flex-col`}
      data-matrix-pinned-panel
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--atum-line) px-3">
        <PinFilled aria-hidden className="size-4 text-(--atum-ink-muted)" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-(--atum-ink)">{copy.pinnedMessages}</h2>
        <Tip label={copy.closePinnedMessages}>
          <Button aria-label={copy.closePinnedMessages} onClick={onClose} size="icon-sm" variant="ghost">
            <X aria-hidden />
          </Button>
        </Tip>
      </header>
      {pinned.entries.length === 0 ? (
        <p className="m-auto px-6 text-center text-sm text-(--atum-ink-muted)" data-matrix-pinned-empty>
          {copy.noPinnedMessages}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {pinned.entries.map(entry => {
            const message = entry.message
            const available = Boolean(message && !message.decryptionFailed)

            return (
              <li key={entry.eventId}>
                <button
                  className="group flex w-full items-start gap-2 rounded-(--atum-r-control) px-2.5 py-2 text-start hover:bg-(--atum-row-hover)"
                  data-matrix-pinned-row={entry.eventId}
                  onClick={() => onJump(entry.eventId, message?.threadRootId)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    {available ? (
                      <>
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate text-sm font-semibold text-(--atum-ink)">
                            {nameOf(message!.sender)}
                          </span>
                          <time className="shrink-0 text-xs text-(--atum-ink-faint)">
                            {date.format(message!.timestamp)}
                          </time>
                        </span>
                        <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap break-words text-sm text-(--atum-ink-soft)">
                          {message!.body}
                        </span>
                      </>
                    ) : (
                      <span className="block py-1 text-sm text-(--atum-ink-muted)">
                        {copy.pinnedMessageUnavailable}
                      </span>
                    )}
                    <span className="mt-1 block text-xs font-medium text-(--atum-accent)">
                      {copy.showPinnedMessage}
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-(--atum-ink-faint)" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
