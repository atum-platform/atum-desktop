import { MATRIX_PROMPT_MAX } from '../../../shared/matrix'
import type { MatrixGroupMode } from '../../../shared/matrix-group-room'
import { roomContextBlock } from '../../../shared/room-participation'
import type { GroupRecentRead, GroupRecentTarget } from '../../../shared/room-participation/recent'
import { type MatrixGroupQuote, matrixGroupTurnPrompt } from '../group-turns'

/** Check the new IPC projection against its native-owned target before prompt use. */
export function requireGroupRecentRead(value: unknown, target: GroupRecentTarget): GroupRecentRead {
  const read = value as GroupRecentRead | null
  const validName = (name: unknown) => typeof name === 'string' && [...name].length > 0 && [...name].length <= 255
  const counter = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0

  if (!read || read.roomId !== target.roomId || read.viewerAgentId !== target.viewerAgentId ||
    !Array.isArray(read.members) || !Array.isArray(read.context?.lines) || read.context.status !== 'ok' ||
    !counter(read.context.gaps) || !counter(read.context.omitted) || read.context.lines.length > target.limits.messages ||
    read.members.some(member => !member || !validName(member.displayName) ||
      !['join', 'invite'].includes(member.membership) ||
      (member.userId !== target.ownerId && !target.ownAgentIds.includes(member.userId))) ||
    ![target.ownerId, target.viewerAgentId].every(id => read.members.some(member => member.userId === id && member.membership === 'join'))) {
    throw new Error('matrix_room_unreadable')
  }

  let chars = 0
  const seen = new Set<string>()

  for (const line of read.context.lines) {
    const member = line && read.members.find(member => member.userId === line.senderRef && member.membership === 'join')
    const trust = line?.senderRef === target.ownerId ? 'owner' : line?.senderRef === target.viewerAgentId ? 'self' : 'own_assistant'

    if (!member || typeof line.eventId !== 'string' || !line.eventId.startsWith('$') ||
      line.eventId === target.excludeEventId || seen.has(line.eventId) || !validName(line.displayName) ||
      typeof line.text !== 'string' || !line.text.trim() || line.trust !== trust || !counter(line.at)) {
      throw new Error('matrix_room_unreadable')
    }

    seen.add(line.eventId)
    chars += [...line.text].length
  }

  if (chars > target.limits.chars) {
    throw new Error('matrix_room_unreadable')
  }

  return read
}

/** Preserves the existing quote and owner's complete text; context is only new user text. */
export function matrixGroupRecentPrompt(input: {
  text: string
  mode: MatrixGroupMode
  quote?: MatrixGroupQuote
  recent?: GroupRecentRead
}): string {
  const prompt = matrixGroupTurnPrompt(input)

  if (input.mode !== 'meeting' || !input.recent || prompt === input.text) {
    return prompt
  }

  // JSON quoting can expand raw text beyond the reader's code-point budget.
  // Drop oldest whole context lines until the complete prompt fits too.
  const context = { ...input.recent.context, lines: [...input.recent.context.lines] }
  const budget = MATRIX_PROMPT_MAX - prompt.length - 2
  let block = roomContextBlock(input.recent.members, context)

  while (block.length > budget && context.lines.length) {
    context.lines.shift()
    context.omitted++
    block = roomContextBlock(input.recent.members, context)
  }

  if (block.length > budget) {
    return prompt
  }

  const split = prompt.indexOf('\n\n')

  return split < 0 ? `${prompt}\n\n${block}` : `${prompt.slice(0, split)}\n\n${block}\n\n${prompt.slice(split + 2)}`
}
