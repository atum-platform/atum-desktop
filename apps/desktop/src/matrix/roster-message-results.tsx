import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { type Locale, useI18n } from '@/i18n'
import { Lock } from '@/lib/icons'

import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixRosterMessageHit, MatrixRosterSearchScope } from '../../shared/matrix-roster-search'

import { foldSearchChar, foldSearchQuery } from './chat-search-matches'
import type { MatrixRosterGlobalEvent } from './roster-global-search'
import { matrixLocalpart } from './roster-model'

const english = {
  plain: 'Plain chats',
  device: 'Private · This device',
  privatePlaceholder: 'Search loaded private messages',
  latest: 'Back to latest',
  company: 'Company',
  searched: (count: number) => `Searched ${count} ${count === 1 ? 'chat' : 'chats'}`,
  skipped: (count: number) => `${count} private not searched`,
  loaded: (messages: number, rooms: number, eligible: number) => `Loaded history only · ${messages} messages in ${rooms} of ${eligible} private chats`,
  partial: 'Partial results'
}

const copy: Record<Locale, typeof english> = {
  en: english,
  vi: {
    plain: 'Trò chuyện thường', device: 'Riêng tư · Thiết bị này',
    privatePlaceholder: 'Tìm tin nhắn riêng tư đã tải', latest: 'Về tin nhắn mới nhất', company: 'Công ty',
    searched: count => `Đã tìm trong ${count} cuộc trò chuyện`, skipped: count => `Bỏ qua ${count} cuộc trò chuyện riêng tư`,
    loaded: (messages, rooms, eligible) => `Chỉ lịch sử đã tải · ${messages} tin nhắn trong ${rooms}/${eligible} cuộc trò chuyện riêng tư`,
    partial: 'Kết quả một phần'
  },
  ja: {
    plain: '通常のチャット', device: 'プライベート · この端末',
    privatePlaceholder: '読み込み済みのプライベートメッセージを検索', latest: '最新に戻る', company: '会社',
    searched: count => `${count}件のチャットを検索済み`, skipped: count => `プライベート${count}件は対象外`,
    loaded: (messages, rooms, eligible) => `読み込み済みのみ · プライベート${eligible}件中${rooms}件の${messages}メッセージ`,
    partial: '一部の結果'
  },
  zh: {
    plain: '普通聊天', device: '私密 · 此设备',
    privatePlaceholder: '搜索已加载的私密消息', latest: '返回最新消息', company: '公司',
    searched: count => `已搜索 ${count} 个聊天`, skipped: count => `${count} 个私密聊天未搜索`,
    loaded: (messages, rooms, eligible) => `仅已加载的历史 · ${eligible} 个私密聊天中 ${rooms} 个的 ${messages} 条消息`,
    partial: '部分结果'
  },
  'zh-hant': {
    plain: '一般聊天', device: '私密 · 此裝置',
    privatePlaceholder: '搜尋已載入的私密訊息', latest: '返回最新訊息', company: '公司',
    searched: count => `已搜尋 ${count} 個聊天`, skipped: count => `${count} 個私密聊天未搜尋`,
    loaded: (messages, rooms, eligible) => `僅已載入的歷史 · ${eligible} 個私密聊天中 ${rooms} 個的 ${messages} 則訊息`,
    partial: '部分結果'
  }
}

export function useRosterSearchCopy() {
  return copy[useI18n().locale]
}

export type MatrixRosterHit = MatrixRosterMessageHit | MatrixRosterGlobalEvent

function snippetMatch(snippet: string, query: string) {
  const needle = foldSearchQuery(query)
  let folded = ''
  const offsets: Array<{ start: number; end: number }> = []
  let offset = 0

  for (const character of snippet) {
    const end = offset + character.length

    for (const unit of foldSearchChar(character)) {
      if (unit === ' ' && (!folded || folded.endsWith(' '))) {continue}

      folded += unit

      for (let index = 0; index < unit.length; index++) {offsets.push({ start: offset, end })}
    }

    offset = end
  }

  const index = needle ? folded.indexOf(needle) : -1

  return index < 0 ? undefined : { start: offsets[index]!.start, end: offsets[index + needle.length - 1]!.end }
}

export function MatrixRosterMessageResults({
  companyNames, hits, onOpen, query, rooms, scope
}: {
  companyNames: ReadonlyMap<string, string>
  hits: readonly MatrixRosterHit[]
  onOpen(hit: MatrixRosterHit): void
  query: string
  rooms: ReadonlyMap<string, MatrixRoom>
  scope: MatrixRosterSearchScope
}) {
  const { locale } = useI18n()
  const byRoom = new Map<string, MatrixRosterHit[]>()

  for (const hit of [...hits].sort((left, right) => right.at - left.at)) {
    const group = byRoom.get(hit.roomId)

    if (group) {group.push(hit)} else {byRoom.set(hit.roomId, [hit])}
  }

  return [...byRoom].map(([roomId, results]) => {
    const room = rooms.get(roomId)

    if (!room) {return null}

    const companyId = room.companyChannel?.companyId ?? room.companyConversation?.companyId
    const companyName = companyId ? companyNames.get(companyId) ?? copy[locale].company : undefined
    const name = room.title || room.name

    return (
      <section aria-label={name} className="pb-2" key={roomId}>
        <h3 className="flex items-center gap-2 px-2 pt-2 pb-0.5 text-sm font-medium text-(--atum-ink)">
          <AtumAssistantAvatar className="size-5 shrink-0 rounded-full text-[9px]" id={roomId} name={name} />
          <span className="min-w-0 truncate">{name}</span>
          {companyName && <span className="min-w-0 truncate text-xs font-normal text-(--atum-ink-muted)">{companyName}</span>}
        </h3>
        {results.map(hit => {
          const snippet = hit.snippet.trim()
          const match = snippetMatch(snippet, query)
          const leading = match ? [...snippet.slice(0, match.start)] : []
          const beforeMatch = leading.length > 12 ? `…${leading.slice(-12).join('')}` : leading.join('')
          const time = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(hit.at)
          const sender = ('senderName' in hit ? hit.senderName : undefined) || matrixLocalpart(hit.sender)

          return (
            <button className="atum-row flex min-h-11 w-full flex-col justify-center px-2 py-1 text-left"
              key={hit.eventId} onClick={() => onOpen(hit)} type="button">
              <span className="w-full truncate text-sm text-(--atum-ink)">
                {match ? <>
                  {beforeMatch}
                  <mark className="rounded-sm bg-(--atum-fill-soft) font-semibold text-(--atum-ink)">{snippet.slice(match.start, match.end)}</mark>
                  {snippet.slice(match.end)}
                </> : snippet}
              </span>
              <span className="flex w-full items-center gap-1.5 text-xs text-(--atum-ink-muted)">
                <span className="truncate">{sender}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{time}</span>
                {scope === 'device' && <Lock aria-label={copy[locale].device} className="size-3 shrink-0" />}
              </span>
            </button>
          )
        })}
      </section>
    )
  })
}
