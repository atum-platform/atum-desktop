import { DAILY_TURNS_DEFAULT, roomBudget } from '../../../shared/room-participation'
import type { GroupPolicyRead } from '../../../shared/room-participation/runtime'

export function groupBudget(read: GroupPolicyRead, now: number = Date.now()) {
  return roomBudget({ now, dailyTurns: read.policy.dailyTurns ?? DAILY_TURNS_DEFAULT, usage: read.usage })
}

/** A canonical refusal repairs an advisory undercount, but never repeats an acknowledged notice. */
export function groupPauseBudget(
  read: GroupPolicyRead,
  input: { position: number; canonicalCap?: number; now?: number }
) {
  const budget = groupBudget(read, input.now)

  if (
    input.position !== 0 ||
    (read.usage.day === budget.day && read.usage.pausedNoticed === true) ||
    (input.canonicalCap !== undefined && input.canonicalCap !== budget.cap) ||
    (!budget.notice && input.canonicalCap === undefined)
  ) {
    return undefined
  }

  return budget
}

export function groupPausedTransaction(roomId: string, day: string) {
  return `atum-gd-${createHash('sha256')
    .update(JSON.stringify(['group-paused-v1', roomId, day]))
    .digest('hex')}`
}

/** Fixed product copy; the model never writes budget notices. */
export const groupPausedCopy = {
  vi: 'Nhóm này đã dùng hết {cap} câu trả lời hôm nay nên các trợ lý tạm nghỉ. Bạn có thể tăng giới hạn trong cài đặt nhóm; sang ngày mới sẽ tự tiếp tục.',
  en: 'This group has used its {cap} answers for today, so the assistants are paused. You can raise the limit in group settings; they resume on the next day.',
  ja: 'このグループは今日の上限（{cap}件）に達したため、アシスタントは一時停止しています。グループ設定で上限を増やせます。翌日には自動的に再開します。',
  zh: '这个群今天已用完 {cap} 次回答，助手暂时休息。你可以在群设置中提高上限；新的一天会自动继续。',
  'zh-hant': '這個群組今天已用完 {cap} 次回答，助理暫時休息。你可以在群組設定中提高上限；新的一天會自動繼續。'
} as const
import { createHash } from 'node:crypto'
