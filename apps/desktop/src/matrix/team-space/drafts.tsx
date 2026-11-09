import { useMemo, useState } from 'react'

import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Hash, Messages, PencilLine } from '@/lib/icons'

import {
  matrixDraftKey,
  type MatrixDraftRecord,
  type MatrixDraftsSnapshot
} from '../../../shared/matrix-drafts'

import type { CompanyActivityRoomLabel } from './activity'
import { useDraftsCopy } from './drafts-copy'

export interface CompanyDraftsViewProps {
  drafts: MatrixDraftsSnapshot
  onOpen(draft: MatrixDraftRecord): Promise<void>
  rooms: readonly CompanyActivityRoomLabel[]
}

/** Reapply the current platform directory before any draft text reaches the screen. */
export function authorizedCompanyDrafts(
  drafts: readonly MatrixDraftRecord[],
  rooms: readonly CompanyActivityRoomLabel[]
): MatrixDraftRecord[] {
  const allowed = new Set(rooms.map(room => room.roomId))

  return drafts.filter(draft => allowed.has(draft.room_id))
}

/** Company-local view over the account's private, bounded Matrix draft record. */
export function CompanyDraftsView({ drafts, onOpen, rooms }: CompanyDraftsViewProps) {
  const { locale } = useI18n()
  const copy = useDraftsCopy()
  const [opening, setOpening] = useState<string>()
  const [failed, setFailed] = useState(false)
  const roomsById = useMemo(() => new Map(rooms.map(room => [room.roomId, room])), [rooms])
  const rows = authorizedCompanyDrafts(drafts.records, rooms)
  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  return (
    <section aria-labelledby="company-drafts-title" className="flex min-h-0 flex-1 flex-col" data-matrix-company-drafts>
      <header className="flex h-12 shrink-0 items-center gap-(--ak-s2) border-b border-(--ak-line) px-(--ak-s5)">
        <PencilLine aria-hidden className="ak-icon ak-icon--sm text-(--ak-ink-3)" />
        <h2 className="[font:var(--ak-t-headline)] text-(--ak-ink)" id="company-drafts-title">
          {copy.title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && (
          <NoticeBand className="mx-(--ak-s5) mt-(--ak-s4)" role="alert">
            {copy.failed}
          </NoticeBand>
        )}
        {rows.length === 0 && <EmptyState className="m-auto p-8" description={copy.emptyBody} title={copy.emptyTitle} />}
        {rows.length > 0 && (
          <ul role="list">
            {rows.map(draft => {
              const room = roomsById.get(draft.room_id)!
              const key = matrixDraftKey({ roomId: draft.room_id, threadRootId: draft.thread_root_id })

              return (
                <li className="hover:bg-(--ak-fill-hover)" key={key}>
                  <button
                    aria-label={`${copy.open(room.name)}: ${draft.text}`}
                    className="grid w-full min-w-0 gap-(--ak-s1) px-(--ak-s5) py-(--ak-s4) text-start focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--ak-focus)"
                    disabled={Boolean(opening)}
                    onClick={() => {
                      setOpening(key)
                      setFailed(false)
                      void onOpen(draft).catch(() => setFailed(true)).finally(() => setOpening(undefined))
                    }}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 [font:var(--ak-t-caption)] text-(--ak-ink-3)">
                      {room.kind === 'channel' ? (
                        <Hash aria-hidden className="ak-icon ak-icon--sm shrink-0" />
                      ) : (
                        <Messages aria-hidden className="ak-icon ak-icon--sm shrink-0" />
                      )}
                      <span className="truncate">{room.name}</span>
                      <span aria-hidden>·</span>
                      <span>{draft.thread_root_id ? copy.threadDraft : copy.roomDraft}</span>
                    </span>
                    <span className="line-clamp-2 whitespace-pre-wrap break-words [font:var(--ak-t-chat)] text-(--ak-ink)">
                      {draft.text}
                    </span>
                    <span className="[font:var(--ak-t-caption)] text-(--ak-ink-3)">
                      {copy.updated(date.format(draft.updated_at))}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
