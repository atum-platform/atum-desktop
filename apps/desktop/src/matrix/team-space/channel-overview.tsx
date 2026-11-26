import { useEffect, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { Hash, PinFilled, UserPlus, X } from '@/lib/icons'

import type { MatrixMember, MatrixPinnedMessage } from '../../../shared/matrix'
import { matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import { companyDesktopAdapter, listCompleteCompanyBoard } from '../company-desktop-adapter'
import { MatrixMemberAvatar } from '../member-avatar'

import type { CompanyChannelView } from './views'

/** Five locales, changed together. */
const copies: Record<
  Locale,
  { overview: string; close: string; noPurpose: string; ask: string; following: (name: string) => string; members: (n: number) => string; addPeople: string; openBoard: string; pinned: (n: number) => string; you: string; unavailable: string }
> = {
  en: {
    overview: 'Channel overview',
    close: 'Close',
    noPurpose: 'No purpose yet.',
    ask: 'Ask',
    following: name => `Following #${name}`,
    members: n => `Members · ${n}`,
    addPeople: 'Add people',
    openBoard: 'Open the board',
    pinned: n => `Pinned · ${n}`,
    you: 'You',
    unavailable: 'Unavailable'
  },
  vi: {
    overview: 'Tổng quan kênh',
    close: 'Đóng',
    noPurpose: 'Chưa có mục đích.',
    ask: 'Hỏi',
    following: name => `Đang theo dõi #${name}`,
    members: n => `Thành viên · ${n}`,
    addPeople: 'Thêm người',
    openBoard: 'Mở bảng việc',
    pinned: n => `Đã ghim · ${n}`,
    you: 'Bạn',
    unavailable: 'Không xem được'
  },
  ja: {
    overview: 'チャンネルの概要',
    close: '閉じる',
    noPurpose: '目的はまだありません。',
    ask: '質問',
    following: name => `#${name} をフォロー中`,
    members: n => `メンバー · ${n}`,
    addPeople: 'メンバーを追加',
    openBoard: 'ボードを開く',
    pinned: n => `ピン留め · ${n}`,
    you: 'あなた',
    unavailable: '表示できません'
  },
  zh: {
    overview: '频道概览',
    close: '关闭',
    noPurpose: '尚无用途说明。',
    ask: '提问',
    following: name => `正在关注 #${name}`,
    members: n => `成员 · ${n}`,
    addPeople: '添加成员',
    openBoard: '打开看板',
    pinned: n => `已置顶 · ${n}`,
    you: '你',
    unavailable: '无法显示'
  },
  'zh-hant': {
    overview: '頻道概覽',
    close: '關閉',
    noPurpose: '尚無用途說明。',
    ask: '提問',
    following: name => `正在關注 #${name}`,
    members: n => `成員 · ${n}`,
    addPeople: '新增成員',
    openBoard: '打開看板',
    pinned: n => `已釘選 · ${n}`,
    you: '你',
    unavailable: '無法顯示'
  }
}

/** The open room's members and pins, as the Matrix snapshot holds them (display only). */
export interface TeamSpaceChannelFacts {
  roomId: string
  members: readonly MatrixMember[]
  pinned: readonly MatrixPinnedMessage[]
  selfId?: string
}

/** Faces shown before "+N", and pins before the channel header's own list. */
const FACES = 6
const PINS = 3

type BoardCounts = { toDo: number; doing: number; done: number }

/** The channel's board at a glance: its project's cards when it has one, else the company's. */
function useBoardCounts(companyId: string, projectId: string | null): BoardCounts | null {
  const [counts, setCounts] = useState<{ key: string; counts: BoardCounts } | null>(null)
  const key = `${companyId}/${projectId ?? ''}`

  useEffect(() => {
    const adapter = companyDesktopAdapter()

    if (!adapter) {
      return
    }

    let alive = true

    void listCompleteCompanyBoard(adapter, companyId, { projectId, ownerMemberRef: null, due: 'all', includeArchived: false })
      .then(page => {
        if (!alive) {
          return
        }

        const count = (test: (status: string) => boolean) => page.cards.filter(card => test(card.status)).length

        setCounts({
          key,
          counts: {
            toDo: count(status => status === 'to_do' || status === 'suggested'),
            doing: count(status => status === 'in_progress' || status === 'blocked'),
            done: count(status => status === 'done')
          }
        })
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [companyId, key, projectId])

  return counts?.key === key ? counts.counts : null
}

/**
 * Team Space's neutral right panel inside a channel (layout r2 §2, owner 2026-11-24): its purpose, the
 * Chief of Staff following it (Ask), the board at a glance, and its members with Add people. A thread,
 * task, person or search opens over it in the detail pane; closing that comes back here.
 */
export function TeamSpaceChannelOverview({
  channel,
  chief,
  facts,
  onAddPeople,
  onAskChief,
  onClose,
  onOpenBoard,
  onOpenPinned
}: {
  channel: CompanyChannelView
  chief?: { name: string }
  facts?: TeamSpaceChannelFacts
  onAddPeople?(): void
  onAskChief?(): void
  onClose(): void
  onOpenBoard(): void
  onOpenPinned?(eventId: string, threadRootId?: string): void
}) {
  const { locale } = useI18n()
  const copy = copies[locale]
  const board = matrixCompanyBoardCopy(locale)
  const counts = useBoardCounts(channel.companyId, channel.projectId)
  const purpose = channel.purpose || channel.topic
  const joined = (facts?.members ?? []).filter(member => member.membership === 'join')
  const pins = facts?.pinned ?? []

  const nameOf = (userId: string) =>
    userId === facts?.selfId ? copy.you : joined.find(member => member.userId === userId)?.name ?? userId

  return (
    <aside
      aria-label={copy.overview}
      className="atum-neutral-panel"
      data-team-space-channel-overview={channel.id}
    >
      <header className="atum-neutral-panel-head">
        <Hash aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
        <h2 className="min-w-0 flex-1 truncate">{channel.displayName}</h2>
        <Tip label={copy.close}>
          <button aria-label={copy.close} className="ak-iconbtn ak-iconbtn--sm" onClick={onClose} type="button">
            <X aria-hidden className="ak-icon" />
          </button>
        </Tip>
      </header>
      <div className="atum-neutral-panel-body">
        <p className={purpose ? 'text-(--atum-ink)' : 'text-(--atum-ink-muted)'}>{purpose || copy.noPurpose}</p>
        {chief && (
          <section>
            <h3 className="atum-neutral-panel-label">{board.chiefOfStaff}</h3>
            <div className="atum-neutral-panel-card flex items-center gap-3">
              <span aria-hidden className="atum-avatar grid size-8 shrink-0 place-items-center bg-(--atum-sunk) text-xs font-semibold">
                {chief.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{copy.following(channel.displayName)}</span>
              {onAskChief && (
                <button className="ak-btn ak-btn--secondary ak-btn--sm" data-team-space-ask-chief onClick={onAskChief} type="button">
                  {copy.ask}
                </button>
              )}
            </div>
          </section>
        )}
        <section>
          <h3 className="atum-neutral-panel-label">{board.board}</h3>
          <button
            aria-label={copy.openBoard}
            className="grid w-full grid-cols-3 gap-2 text-start"
            data-team-space-board-summary
            onClick={onOpenBoard}
            type="button"
          >
            {(
              [
                ['toDo', board.toDo],
                ['doing', board.inProgress],
                ['done', board.done]
              ] as const
            ).map(([id, label]) => (
              <span className="atum-neutral-panel-card flex flex-col gap-0.5 hover:bg-(--atum-hover)" key={id}>
                <span className="text-lg font-semibold tabular-nums text-(--atum-ink)">{counts ? counts[id] : '–'}</span>
                <span className="truncate text-xs text-(--atum-ink-muted)">{label}</span>
              </span>
            ))}
          </button>
        </section>
        {pins.length > 0 && (
          <section data-team-space-channel-pins>
            <h3 className="atum-neutral-panel-label">{copy.pinned(pins.length)}</h3>
            <ul className="atum-neutral-panel-card flex flex-col gap-0.5 p-1">
              {pins.slice(0, PINS).map(entry => {
                const message = entry.message && !entry.message.decryptionFailed ? entry.message : undefined

                return (
                  <li key={entry.eventId}>
                    <button
                      className="flex w-full items-start gap-2 rounded-(--atum-r-control) px-2.5 py-2 text-start hover:bg-(--atum-hover) disabled:hover:bg-transparent"
                      data-team-space-channel-pin={entry.eventId}
                      disabled={!onOpenPinned}
                      onClick={() => onOpenPinned?.(entry.eventId, message?.threadRootId)}
                      type="button"
                    >
                      <PinFilled aria-hidden className="mt-0.5 size-3.5 shrink-0 text-(--atum-ink-faint)" />
                      <span className="min-w-0 flex-1">
                        {message ? (
                          <>
                            <span className="block truncate text-xs font-medium text-(--atum-ink-muted)">{nameOf(message.sender)}</span>
                            <span className="line-clamp-2 block break-words text-(--atum-ink)">{message.body}</span>
                          </>
                        ) : (
                          <span className="block text-(--atum-ink-muted)">{copy.unavailable}</span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        <section>
          <h3 className="atum-neutral-panel-label">{copy.members(channel.memberCount)}</h3>
          {(joined.length > 0 || onAddPeople) && (
            <div className="atum-neutral-panel-card flex items-center gap-3" data-team-space-channel-faces={joined.length}>
              {joined.length > 0 && (
                <span className="flex min-w-0 flex-1 items-center">
                  {joined.slice(0, FACES).map((member, index) => (
                    <Tip key={member.userId} label={nameOf(member.userId)}>
                      <span className={index ? '-ms-1.5' : undefined}>
                        <MatrixMemberAvatar
                          avatarMxc={member.avatarMxc}
                          className="size-7 shrink-0 rounded-(--atum-r-avatar) text-[0.75rem] leading-none ring-2 ring-(--atum-main-bg)"
                          id={member.userId}
                          name={member.name}
                          presence={false}
                        />
                      </span>
                    </Tip>
                  ))}
                  {channel.memberCount > Math.min(joined.length, FACES) && (
                    <span className="ms-1.5 text-xs tabular-nums text-(--atum-ink-muted)">
                      +{channel.memberCount - Math.min(joined.length, FACES)}
                    </span>
                  )}
                </span>
              )}
              {onAddPeople && (
                <button className="ak-btn ak-btn--secondary ak-btn--sm ms-auto shrink-0" data-team-space-channel-add-people onClick={onAddPeople} type="button">
                  <UserPlus aria-hidden className="ak-icon ak-icon--sm" />
                  {copy.addPeople}
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
