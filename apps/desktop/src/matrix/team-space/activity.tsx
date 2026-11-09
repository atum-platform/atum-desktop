import { useMemo, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Activity, AtSign, Hash, Messages } from '@/lib/icons'

import type { MatrixCompanyActivityItem } from '../../../shared/matrix-company-activity'
import { MatrixMemberAvatar } from '../member-avatar'

import { useActivityCopy } from './activity-copy'

export interface CompanyActivityRoomLabel {
  roomId: string
  kind: 'channel' | 'conversation'
  name: string
}

export interface CompanyActivityViewProps {
  companyId: string
  items: readonly MatrixCompanyActivityItem[]
  rooms: readonly CompanyActivityRoomLabel[]
  onOpen(item: MatrixCompanyActivityItem): Promise<void>
  pageSize?: number
}

export function authorizedCompanyActivity(
  items: readonly MatrixCompanyActivityItem[],
  companyId: string,
  rooms: readonly CompanyActivityRoomLabel[]
): MatrixCompanyActivityItem[] {
  const allowed = new Set(rooms.map(room => room.roomId))

  return items.filter(item => item.companyId === companyId && allowed.has(item.roomId))
}

const activityAriaBody = (body: string) => body.length > 140 ? `${body.slice(0, 139)}…` : body

/** A company-local inbox over the SDK's bounded joined-room activity projection. */
export function CompanyActivityView({ companyId, items, onOpen, pageSize = 25, rooms }: CompanyActivityViewProps) {
  const { locale } = useI18n()
  const copy = useActivityCopy()
  const [filter, setFilter] = useState<'all' | 'mentions'>('all')
  const [visible, setVisible] = useState(pageSize)
  const [opening, setOpening] = useState<string>()
  const [failed, setFailed] = useState(false)
  const roomsById = useMemo(() => new Map(rooms.map(room => [room.roomId, room])), [rooms])
  const authorized = authorizedCompanyActivity(items, companyId, rooms)
  const filtered = filter === 'mentions' ? authorized.filter(item => item.kind === 'mention') : authorized
  const shown = filtered.slice(0, visible)

  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const changeFilter = (next: 'all' | 'mentions') => {
    setFilter(next)
    setVisible(pageSize)
  }

  return (
    <section aria-labelledby="company-activity-title" className="flex min-h-0 flex-1 flex-col"
      data-matrix-company-activity>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-(--ak-s2) border-b border-(--ak-line) px-(--ak-s5) py-(--ak-s2)">
        <div className="flex min-w-0 items-center gap-(--ak-s2)">
          <Activity aria-hidden className="size-4 shrink-0 text-(--ak-ink-3)" />
          <h2 className="truncate [font:var(--ak-t-headline)] text-(--ak-ink)"
            id="company-activity-title">
            {copy.title}
          </h2>
        </div>
        <AtumSegmented
          label={copy.filterLabel}
          onChange={changeFilter}
          options={[
            { id: 'all', label: copy.all },
            { id: 'mentions', label: copy.mentions }
          ]}
          value={filter}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && <p className="px-(--ak-s5) pt-(--ak-s4) [font:var(--ak-t-body)] text-(--ak-danger)" role="alert">{copy.failed}</p>}
        {shown.length === 0 && (
          <EmptyState
            className="m-auto p-8"
            description={filter === 'mentions' ? copy.emptyMentionsBody : copy.emptyAllBody}
            title={filter === 'mentions' ? copy.emptyMentionsTitle : copy.emptyAllTitle}
          />
        )}
        {shown.length > 0 && (
          <ul className="divide-y divide-(--ak-line)" role="list">
            {shown.map(item => {
              const room = roomsById.get(item.roomId)!
              const key = `${item.roomId}\0${item.eventId}`

              return (
                <li className="group/activity hover:bg-(--ak-fill-hover)" key={key}>
                  <button
                    aria-label={`${copy.open(room.name)}: ${activityAriaBody(item.body)}`}
                    className="flex w-full min-w-0 gap-(--ak-s3) px-(--ak-s5) py-(--ak-s4) text-start focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--ak-focus)"
                    disabled={Boolean(opening)}
                    onClick={() => {
                      setOpening(key)
                      setFailed(false)
                      void onOpen(item).catch(() => setFailed(true)).finally(() => setOpening(undefined))
                    }}
                    type="button"
                  >
                    <MatrixMemberAvatar className="mt-(--ak-s1) size-8 text-xs"
                      id={item.senderId} name={item.senderName ?? copy.someone} presence={false} />
                    <span className="grid min-w-0 flex-1 gap-(--ak-s1)">
                      <span className="flex min-w-0 items-center gap-1.5 [font:var(--ak-t-caption)] text-(--ak-ink-3)">
                      {room.kind === 'channel'
                        ? <Hash aria-hidden className="size-4 shrink-0" />
                        : <Messages aria-hidden className="size-4 shrink-0" />}
                      <span className="truncate">{room.name}</span>
                      <span aria-hidden>·</span>
                      {item.kind === 'mention'
                        ? <AtSign aria-hidden className="size-4 shrink-0" />
                        : <Messages aria-hidden className="size-4 shrink-0" />}
                      <span>{item.kind === 'mention' ? copy.mention : copy.threadReply}</span>
                      {item.unread && (
                        <>
                          <span aria-hidden className="ms-auto size-2 shrink-0 rounded-full bg-(--ak-ink)" />
                          <span className="sr-only">{copy.unread}</span>
                        </>
                      )}
                      </span>
                      <span className="line-clamp-2 whitespace-pre-wrap break-words [font:var(--ak-t-chat)] text-(--ak-ink)">
                        {item.body}
                      </span>
                      <span className="[font:var(--ak-t-caption)] text-(--ak-ink-3)">
                        {item.senderName ?? copy.someone} · {date.format(item.sentAt)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {visible < filtered.length && (
          <div className="grid place-items-center p-(--ak-s4)">
            <Button onClick={() => setVisible(count => count + pageSize)} size="sm" variant="secondary">
              {copy.loadMore}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
