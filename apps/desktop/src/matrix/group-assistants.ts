import { type Locale, useI18n } from '@/i18n'

import type { MatrixAgentView, MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { isMatrixGroupRoom, matrixGroupMode, type MatrixGroupMode } from '../../shared/matrix-group-room'

/**
 * Your own assistants in a group's composer (owner-only, 2026-10-06): the group's "Send to"
 * row lists those that are in it, and a message sent to one names it (`@Name …` and a standard
 * mention), which is what lets it answer. Replying to its message names it too. Display only:
 * main re-reads the room and the message and decides (electron/matrix/group-turns.ts).
 */
export function groupAssistantRecipients(room: MatrixRoom, snapshot: MatrixSnapshot): MatrixAgentView[] {
  if (room.assistant || room.appGroup || !isMatrixGroupRoom(room)) {
    return []
  }

  const joined = new Set((room.participants ?? []).filter(m => m.membership === 'join').map(m => m.userId))

  return (snapshot.agents ?? []).filter(agent => joined.has(agent.userId))
}

/** The "Send to" choice for one of your assistants. */
export const groupAssistantRecipientId = (agent: Pick<MatrixAgentView, 'principal'>) => `agent:${agent.principal}`

/** The group's mode as the window shows it; main decides again at every turn. */
export function groupAssistantMode(room: MatrixRoom, snapshot: MatrixSnapshot): MatrixGroupMode {
  const owner = snapshot.identity?.userId

  return owner
    ? matrixGroupMode(
        room.participants ?? [],
        owner,
        (snapshot.agents ?? []).map(agent => agent.userId)
      )
    : 'shared'
}

/** A message to your assistant names it where everyone sees it, the way a mention reads. */
export function groupAssistantMessage(body: string, name: string): string {
  const prefix = `@${name}`

  return body.trimStart().startsWith(prefix) ? body : `${prefix} ${body}`
}

/** A reply to your own assistant's message in a group names it (it answers you then). */
export function groupReplyMentions(
  reply: Pick<MatrixMessage, 'sender'> | undefined,
  recipients: readonly Pick<MatrixAgentView, 'userId'>[]
): string[] | undefined {
  return reply && recipients.some(agent => agent.userId === reply.sender) ? [reply.sender] : undefined
}

/** Only the owner's client interprets names. Match literal Unicode names, longest first. */
export { groupTypedMentions } from '../../shared/room-participation/mentions'

const en = {
  shared: (name: string) =>
    `Only you can ask ${name}. Everyone here reads its answers. Here it doesn't use your memory or Google, but it can still use files and apps on this Mac.`,
  meeting: (name: string) => `Just you and your assistants here: ${name} works as it does in your private chat.`
}

type GroupAssistantCopy = typeof en

const vi: GroupAssistantCopy = {
  shared: name =>
    `Chỉ bạn nhờ được ${name}. Mọi người ở đây đọc được câu trả lời. Ở đây trợ lý không dùng trí nhớ hay Google của bạn, nhưng vẫn dùng được tệp và ứng dụng trên máy Mac này.`,
  meeting: name => `Nhóm chỉ có bạn và trợ lý của bạn: ${name} làm việc như khi trò chuyện riêng với bạn.`
}

const ja: GroupAssistantCopy = {
  shared: name =>
    `${name} に頼めるのはあなただけです。返信はここにいる全員が読めます。ここではあなたの記憶や Google は使いませんが、この Mac のファイルやアプリは引き続き使えます。`,
  meeting: name => `ここにいるのはあなたとあなたのアシスタントだけです。${name} は個別チャットと同じように動きます。`
}

const zh: GroupAssistantCopy = {
  shared: name =>
    `只有你能请 ${name} 帮忙。这里的所有人都能看到它的回复。在这里它不会使用你的记忆或 Google，但仍可以使用这台 Mac 上的文件和应用。`,
  meeting: name => `这里只有你和你的助理：${name} 会像在私聊中一样工作。`
}

const zhHant: GroupAssistantCopy = {
  shared: name =>
    `只有你能請 ${name} 幫忙。這裡的所有人都能看到它的回覆。在這裡它不會使用你的記憶或 Google，但仍可以使用這台 Mac 上的檔案和應用程式。`,
  meeting: name => `這裡只有你和你的助理：${name} 會像在私聊中一樣運作。`
}

const copies: Record<Locale, GroupAssistantCopy> = { en, vi, ja, zh, 'zh-hant': zhHant }

export function groupAssistantCopy(locale: Locale): GroupAssistantCopy {
  return copies[locale] ?? en
}

export function useGroupAssistantCopy(): GroupAssistantCopy {
  return groupAssistantCopy(useI18n().locale)
}
