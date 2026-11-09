import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Bell, BellOff, CheckCircle2, Hash, Messages } from '@/lib/icons'

import type { MatrixCompanyThread } from '../../../shared/matrix'
import { MatrixMemberAvatar } from '../member-avatar'
import { matrixAgo } from '../message-time'
import { $matrixPresence } from '../presence-store'

import type { CompanyActivityRoomLabel } from './activity'
import { useCompanyThreadsCopy } from './company-threads-copy'

type CompanyThreadFilter = 'recent' | 'following' | 'unread'

interface ThreadOverride {
  followed?: boolean
  readAt?: number
  unread?: boolean
}

export interface CompanyThreadsViewProps {
  companyId: string
  onFollow(thread: MatrixCompanyThread, followed: boolean): Promise<void>
  onOpen(thread: MatrixCompanyThread): Promise<void>
  onRead(thread: MatrixCompanyThread): Promise<void>
  pageSize?: number
  rooms: readonly CompanyActivityRoomLabel[]
  threads: readonly MatrixCompanyThread[]
}

export const companyThreadKey = (thread: Pick<MatrixCompanyThread, 'roomId' | 'root'>) =>
  `${thread.roomId}\0${thread.root.id}`

function withBusyKey(current: ReadonlySet<string>, key: string, busy: boolean): ReadonlySet<string> {
  if (current.has(key) === busy) {return current}
  const next = new Set(current)

  if (busy) {next.add(key)} else {next.delete(key)}

  return next
}

/** Recheck the selected company's current platform directory before any thread content is drawn. */
export function authorizedCompanyThreads(
  threads: readonly MatrixCompanyThread[],
  companyId: string,
  rooms: readonly CompanyActivityRoomLabel[]
): MatrixCompanyThread[] {
  const allowed = new Set(rooms.map(room => room.roomId))

  return threads.filter(thread => thread.companyId === companyId && allowed.has(thread.roomId))
}

/** A company-local, bounded view over the SDK's joined-room thread projection. */
export function CompanyThreadsView({
  companyId,
  onFollow,
  onOpen,
  onRead,
  pageSize = 25,
  rooms,
  threads
}: CompanyThreadsViewProps) {
  const { locale } = useI18n()
  const copy = useCompanyThreadsCopy()
  const [filter, setFilter] = useState<CompanyThreadFilter>('recent')
  const [visible, setVisible] = useState(pageSize)
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, ThreadOverride>>({})
  const roomsById = useMemo(() => new Map(rooms.map(room => [room.roomId, room])), [rooms])
  const presence = useStore($matrixPresence)

  // Once sync catches up, stop owning the field locally. A later reply must be able to make a
  // read thread unread again, and another device must be able to change its follow preference.
  useEffect(() => {
    setOverrides(current => {
      const next: Record<string, ThreadOverride> = {}
      let changed = false

      for (const [key, value] of Object.entries(current)) {
        const thread = threads.find(item => companyThreadKey(item) === key)

        if (!thread) {
          changed = true
          continue
        }

        const kept = { ...value }

        if (kept.followed === thread.followed) {
          delete kept.followed
          changed = true
        }

        if (kept.unread === false && (!thread.unread || thread.lastActivityAt > (kept.readAt ?? 0))) {
          delete kept.unread
          delete kept.readAt
          changed = true
        }

        if (Object.keys(kept).length) {
          next[key] = kept
        }
      }

      return changed ? next : current
    })
  }, [threads])

  const authorized = authorizedCompanyThreads(threads, companyId, rooms).map(thread => {
    const local = overrides[companyThreadKey(thread)]

    return {
      ...thread,
      ...(local?.followed === undefined ? {} : { followed: local.followed }),
      ...(local?.unread === undefined || thread.lastActivityAt > (local.readAt ?? Number.POSITIVE_INFINITY)
        ? {}
        : { unread: local.unread })
    }
  })

  const filtered = authorized.filter(thread =>
    filter === 'following' ? thread.followed : filter === 'unread' ? thread.unread : true
  )
  const shown = filtered.slice(0, visible)
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale])

  const changeFilter = (next: CompanyThreadFilter) => {
    setFilter(next)
    setVisible(pageSize)
  }

  const changeOverride = (key: string, value: ThreadOverride) => {
    setOverrides(current => ({ ...current, [key]: { ...current[key], ...value } }))
  }

  const empty = {
    recent: [copy.emptyRecentTitle, copy.emptyRecentBody],
    following: [copy.emptyFollowingTitle, copy.emptyFollowingBody],
    unread: [copy.emptyUnreadTitle, copy.emptyUnreadBody]
  }[filter]

  return (
    <section
      aria-labelledby="company-threads-title"
      className="flex min-h-0 flex-1 flex-col"
      data-matrix-company-threads
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-(--ak-s2) border-b border-(--ak-line) px-(--ak-s5) py-(--ak-s2)">
        <div className="flex min-w-0 items-center gap-(--ak-s2)">
          <Messages aria-hidden className="size-4 shrink-0 text-(--ak-ink-3)" />
          <h2 className="truncate [font:var(--ak-t-headline)] text-(--ak-ink)" id="company-threads-title">
            {copy.title}
          </h2>
        </div>
        <AtumSegmented
          label={copy.filterLabel}
          onChange={changeFilter}
          options={[
            { id: 'recent', label: copy.recent },
            { id: 'following', label: copy.following },
            { id: 'unread', label: copy.unread }
          ]}
          value={filter}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed && (
          <NoticeBand className="mx-(--ak-s5) mt-(--ak-s4)" role="alert">
            {copy.actionFailed}
          </NoticeBand>
        )}
        {shown.length === 0 && <EmptyState className="m-auto p-8" description={empty[1]} title={empty[0]} />}
        {shown.length > 0 && (
          <ul role="list">
            {shown.map(thread => {
              const room = roomsById.get(thread.roomId)!
              const key = companyThreadKey(thread)
              const busy = pending.has(key)
              const rowDisabled = busy || opening.has(key)
              const followLabel = thread.followed ? copy.unfollow : copy.follow
              const participants = thread.participantIds.filter(id => presence.users[id])

              return (
                <li
                  className="group/thread flex min-w-0 items-center gap-(--ak-s2) px-(--ak-s3) hover:bg-(--ak-fill-hover)"
                  data-matrix-company-thread-row={thread.root.id}
                  key={key}
                >
                  <button
                    aria-label={`${copy.open(room.name)}: ${thread.root.body || copy.noPreview}`}
                    className="min-w-0 flex-1 py-(--ak-s4) ps-(--ak-s2) text-start focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--ak-focus)"
                    disabled={rowDisabled}
                    onClick={() => {
                      setOpening(current => withBusyKey(current, key, true))
                      setFailed(false)
                      void onOpen(thread)
                        .catch(() => setFailed(true))
                        .finally(() => setOpening(current => withBusyKey(current, key, false)))
                    }}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 [font:var(--ak-t-caption)] text-(--ak-ink-3)">
                      {room.kind === 'channel' ? (
                        <Hash aria-hidden className="size-4 shrink-0" />
                      ) : (
                        <Messages aria-hidden className="size-4 shrink-0" />
                      )}
                      <span className="truncate">{room.name}</span>
                      {thread.unread && (
                        <>
                          <span aria-hidden className="ms-auto size-2 shrink-0 rounded-full bg-(--ak-ink)" />
                          <span className="sr-only">{copy.unread}</span>
                        </>
                      )}
                    </span>
                    <span className="mt-(--ak-s1) line-clamp-2 whitespace-pre-wrap break-words [font:var(--ak-t-chat)] text-(--ak-ink)">
                      {thread.root.body || copy.noPreview}
                    </span>
                    <span className="mt-(--ak-s1) flex flex-wrap items-center gap-(--ak-s2) [font:var(--ak-t-caption)] text-(--ak-ink-3)">
                      {participants.length > 0 && (
                        <span aria-label={participants.map(id => presence.users[id]!.displayName ?? '?').join(', ')}
                          className="flex -space-x-1" data-thread-participants>
                          {participants.slice(0, 3).map(id => (
                            <MatrixMemberAvatar
                              avatarMxc={presence.users[id]!.avatarMxc}
                              className="size-5 border border-(--ak-surface) text-[0.5625rem] leading-none"
                              id={id}
                              key={id}
                              name={presence.users[id]!.displayName ?? '?'}
                              presence={false}
                            />
                          ))}
                        </span>
                      )}
                      <span>{copy.replies(thread.replyCount)}</span>
                      <span aria-hidden>·</span>
                      <span title={date.format(thread.lastActivityAt)}>{copy.lastReply(matrixAgo(thread.lastActivityAt, locale))}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-(--ak-s1) opacity-70 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100">
                    {thread.unread && (
                      <Tip label={copy.markRead}>
                        <button
                          aria-label={copy.markRead}
                          className="ak-iconbtn"
                          disabled={rowDisabled}
                          onClick={() => {
                            const previous = thread.unread
                            setFailed(false)
                            setPending(current => withBusyKey(current, key, true))
                            changeOverride(key, { readAt: thread.lastActivityAt, unread: false })
                            void onRead(thread)
                              .catch(() => {
                                changeOverride(key, { readAt: thread.lastActivityAt, unread: previous })
                                setFailed(true)
                              })
                              .finally(() => setPending(current => withBusyKey(current, key, false)))
                          }}
                          type="button"
                        >
                          <CheckCircle2 aria-hidden className="ak-icon ak-icon--sm" />
                        </button>
                      </Tip>
                    )}
                    <Tip label={followLabel}>
                      <button
                        aria-label={followLabel}
                        className="ak-iconbtn"
                        disabled={rowDisabled}
                        onClick={() => {
                          const previous = thread.followed
                          const next = !previous
                          setFailed(false)
                          setPending(current => withBusyKey(current, key, true))
                          changeOverride(key, { followed: next })
                          void onFollow(thread, next)
                            .catch(() => {
                              changeOverride(key, { followed: previous })
                              setFailed(true)
                            })
                            .finally(() => setPending(current => withBusyKey(current, key, false)))
                        }}
                        type="button"
                      >
                        {thread.followed ? (
                          <BellOff aria-hidden className="ak-icon ak-icon--sm" />
                        ) : (
                          <Bell aria-hidden className="ak-icon ak-icon--sm" />
                        )}
                      </button>
                    </Tip>
                  </div>
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
