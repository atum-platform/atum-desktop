import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { Settings } from '@/lib/icons'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { DAILY_TURNS_DEFAULT, effectiveMode, type ParticipationMode, roomBudget } from '../../shared/room-participation'

import { groupAssistantMode, groupAssistantRecipients } from './group-assistants'
import { useGroupRoomPolicy } from './group-room-policy'
import { matrixRosterAgentName } from './roster-model'
import { SettingsRow, SettingsSection } from './settings-row'

const en = {
  title: 'Group assistants',
  everyone: 'Everyone',
  off: 'Off',
  addressed: 'Only when called',
  joins: 'Joins the conversation',
  cap: 'Daily answer limit',
  today: (n: number, cap: number) => `Today: ${n}/${cap} answers`,
  paused: 'Assistants are resting until tomorrow. Raise the limit to continue today.',
  unavailable: 'Group settings could not be read.',
  failed: 'The change could not be saved. Your previous setting is kept.',
  retry: 'Try again',
  following: 'Assistants are following the conversation',
  called: 'Assistants answer only when called',
  everyoneNote: 'Everyone: up to 2 assistants answer each message, one at a time. Type @name to ask one assistant.'
}

type Copy = typeof en

const vi: Copy = {
  title: 'Trợ lý trong nhóm',
  everyone: 'Cả nhóm',
  off: 'Tắt',
  addressed: 'Chỉ khi được gọi',
  joins: 'Tham gia trò chuyện',
  cap: 'Giới hạn câu trả lời mỗi ngày',
  today: (n, cap) => `Hôm nay: ${n}/${cap} câu trả lời`,
  paused: 'Các trợ lý tạm nghỉ đến ngày mai. Bạn có thể tăng giới hạn để tiếp tục hôm nay.',
  unavailable: 'Chưa đọc được cài đặt nhóm.',
  failed: 'Chưa lưu được thay đổi. Cài đặt trước đó được giữ lại.',
  retry: 'Thử lại',
  following: 'Trợ lý đang theo dõi cuộc trò chuyện',
  called: 'Trợ lý chỉ trả lời khi được gọi',
  everyoneNote: 'Cả nhóm: tối đa 2 trợ lý trả lời mỗi tin, lần lượt từng người. Gõ @tên để hỏi riêng một trợ lý.'
}

const ja: Copy = {
  title: 'グループのアシスタント',
  everyone: '全員',
  off: 'オフ',
  addressed: '呼ばれたときだけ',
  joins: '会話に参加',
  cap: '1日の返信上限',
  today: (n, cap) => `今日の返信：${n}/${cap}`,
  paused: 'アシスタントは明日まで休憩します。上限を増やすと今日も続けられます。',
  unavailable: 'グループ設定を読み込めませんでした。',
  failed: '変更を保存できませんでした。以前の設定を保持しています。',
  retry: '再試行',
  following: 'アシスタントが会話を見守っています',
  called: 'アシスタントは呼ばれたときだけ返信します',
  everyoneNote: '全員：各メッセージに最大2人のアシスタントが順番に返信します。@名前で1人に質問できます。'
}

const zh: Copy = {
  title: '群组助理',
  everyone: '全体',
  off: '关闭',
  addressed: '仅在被呼叫时',
  joins: '参与对话',
  cap: '每日回复上限',
  today: (n, cap) => `今天：${n}/${cap} 条回复`,
  paused: '助理将休息到明天。提高上限即可今天继续。',
  unavailable: '无法读取群组设置。',
  failed: '无法保存更改。已保留之前的设置。',
  retry: '重试',
  following: '助理正在关注对话',
  called: '助理仅在被呼叫时回复',
  everyoneNote: '全体：每条消息最多由2位助理依次回复。输入 @名字 可单独询问一位助理。'
}

const zhHant: Copy = {
  title: '群組助理',
  everyone: '全體',
  off: '關閉',
  addressed: '僅在被呼叫時',
  joins: '參與對話',
  cap: '每日回覆上限',
  today: (n, cap) => `今天：${n}/${cap} 則回覆`,
  paused: '助理將休息到明天。提高上限即可今天繼續。',
  unavailable: '無法讀取群組設定。',
  failed: '無法儲存變更。已保留之前的設定。',
  retry: '重試',
  following: '助理正在關注對話',
  called: '助理僅在被呼叫時回覆',
  everyoneNote: '全體：每則訊息最多由2位助理依次回覆。輸入 @名字 可單獨詢問一位助理。'
}

const copies: Record<Locale, Copy> = { en, vi, ja, zh, 'zh-hant': zhHant }
export const groupRoomCopy = (locale: Locale) => copies[locale] ?? en

export function GroupRoomSettings({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const { locale, t } = useI18n()
  const copy = groupRoomCopy(locale)
  const policy = useGroupRoomPolicy(room, snapshot)
  const [open, setOpen] = useState(false)
  const recipients = groupAssistantRecipients(room, snapshot)
  const mode = groupAssistantMode(room, snapshot)

  const budget =
    policy.value &&
    roomBudget({
      now: Date.now(),
      dailyTurns: policy.value.policy.dailyTurns ?? DAILY_TURNS_DEFAULT,
      usage: policy.value.usage
    })

  return (
    <Popover
      onOpenChange={value => {
        setOpen(value)

        if (value) {
          void policy.refresh(true)
        }
      }}
      open={open}
    >
      <Tip label={copy.title}>
        <PopoverTrigger asChild>
          <Button aria-label={copy.title} size="icon-sm" variant="ghost">
            <Settings aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" aria-label={copy.title} className="w-[min(26rem,calc(100vw-2rem))]" role="dialog">
        <SettingsSection foot={budget ? copy.today(budget.turns, budget.cap) : undefined} title={copy.title}>
          {!policy.value ? (
            policy.failed ? (
              <SettingsRow
                control={
                  <Button onClick={() => void policy.refresh(true)} size="sm" variant="textStrong">
                    {copy.retry}
                  </Button>
                }
                title={copy.unavailable}
              />
            ) : (
              <SettingsRow title={<Loader size="sm" />} />
            )
          ) : (
            <>
              {recipients.map(agent => {
                const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)
                const value = effectiveMode({ roomMode: mode, stored: policy.value!.policy.agents[agent.userId]?.mode })

                return (
                  <SettingsRow
                    control={
                      <select
                        aria-label={name}
                        className="atum-settings-select"
                        disabled={policy.pending}
                        onChange={event =>
                          void policy.change({ agentId: agent.userId, mode: event.target.value as ParticipationMode })
                        }
                        value={value}
                      >
                        <option value="off">{copy.off}</option>
                        <option value="addressed">{copy.addressed}</option>
                        {mode === 'meeting' && <option value="joins">{copy.joins}</option>}
                      </select>
                    }
                    key={agent.userId}
                    title={name}
                  />
                )
              })}
              <SettingsRow
                control={
                  <input
                    aria-label={copy.cap}
                    className="atum-input atum-settings-field w-20"
                    defaultValue={budget?.cap}
                    disabled={policy.pending}
                    key={budget?.cap}
                    max={200}
                    min={1}
                    onBlur={event => {
                      const value = event.currentTarget.valueAsNumber

                      if (Number.isSafeInteger(value) && value >= 1 && value <= 200) {
                        if (value !== budget?.cap) {
                          void policy.change({ dailyTurns: value })
                        }
                      } else {
                        event.currentTarget.value = String(budget?.cap ?? DAILY_TURNS_DEFAULT)
                      }
                    }}
                    type="number"
                  />
                }
                title={copy.cap}
              />
              {budget && !budget.allowed && <SettingsRow title={copy.paused} />}
              {policy.failed && (
                <NoticeBand role="alert" tone="failure">
                  {copy.failed}
                </NoticeBand>
              )}
            </>
          )}
        </SettingsSection>
      </PopoverContent>
    </Popover>
  )
}
