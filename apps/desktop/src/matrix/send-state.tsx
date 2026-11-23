import { Tip } from '@/components/ui/tooltip'

import type { MatrixAgentView, MatrixMember, MatrixMessage } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { MatrixPersonAvatar } from './member-avatar'
import { type MatrixPeopleContext, matrixPersonLine } from './person-name'

/** Up to three reader avatars; the rest become a count, as Element X draws them. */
const SEEN_AVATARS = 3

/**
 * Who has read your message, in one quiet line under it: the readers' own avatars under the
 * message each public read receipt names, at most three plus a count. In your assistant's chat the
 * agent's face is the acknowledgement. This is the only read signal a message carries (owner
 * 2026-11-19: the bubble's Sent/Seen ticks said the same thing twice): a message nobody has read
 * yet shows just its time. Display only: an assistant's receipt never says what its turn is doing.
 */
export function MatrixSendState({
  agents,
  assistantChat,
  members,
  message,
  people
}: {
  agents?: readonly MatrixAgentView[]
  assistantChat: boolean
  members?: readonly MatrixMember[]
  message: MatrixMessage
  people: MatrixPeopleContext
}) {
  const chat = useChatCopy()
  const readers = message.readBy ?? []

  if (!readers.length) {
    return null
  }

  const shown = readers.slice(0, SEEN_AVATARS)
  const extra = readers.length - shown.length
  const names = readers.map(reader => matrixPersonLine(reader, people)).join(', ')

  return (
    <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-faint)">
      <Tip label={names}>
        <span
          aria-label={assistantChat ? chat.seen : chat.seenBy(readers.length)}
          className="inline-flex items-center gap-1"
          data-matrix-seen
          tabIndex={0}
        >
          <span aria-hidden className="flex items-center -space-x-1.5">
            {shown.map(reader => {
              const member = members?.find(value => value.userId === reader)

              return (
                <span className="contents" data-matrix-reader-avatar={reader} key={reader}>
                  <MatrixPersonAvatar
                    agent={agents?.find(agent => agent.userId === reader)}
                    avatarMxc={member?.avatarMxc}
                    className="size-4 shrink-0 rounded-[5px] text-[0.5rem] leading-none"
                    id={reader}
                    name={member?.name ?? matrixPersonLine(reader, people)}
                    presence={false}
                  />
                </span>
              )
            })}
          </span>
          {extra > 0 && (
            <span className="text-xs text-(--atum-ink-muted)" data-matrix-seen-more>
              +{extra}
            </span>
          )}
        </span>
      </Tip>
    </span>
  )
}
