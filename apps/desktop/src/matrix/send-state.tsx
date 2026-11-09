import type { ReactNode } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Check } from '@/lib/icons'

import type { MatrixAgentView, MatrixMember, MatrixMessage } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { MatrixPersonAvatar } from './member-avatar'
import { type MatrixPeopleContext, matrixPersonLine } from './person-name'

/** Up to three reader avatars; the rest become a count, as Element X draws them. */
const SEEN_AVATARS = 3

/**
 * Where your message is, in one quiet line under it: Sent (one tick) under the newest message
 * nobody has read, then the readers' own avatars under the message each public read receipt
 * names, at most three plus a count. In your assistant's chat the agent's face is the
 * acknowledgement. Display only: an assistant's receipt never says what its turn is doing.
 */
export function MatrixSendState({
  agents,
  assistantChat,
  edited,
  latest,
  members,
  message,
  people,
  time
}: {
  agents?: readonly MatrixAgentView[]
  assistantChat: boolean
  edited?: ReactNode
  latest: boolean
  members?: readonly MatrixMember[]
  message: MatrixMessage
  people: MatrixPeopleContext
  /** The run-ending timestamp shares this one line with Sent or the readers. */
  time?: ReactNode
}) {
  const chat = useChatCopy()
  const readers = message.readBy ?? []

  if (readers.length) {
    const shown = readers.slice(0, SEEN_AVATARS)
    const extra = readers.length - shown.length
    const names = readers.map(reader => matrixPersonLine(reader, people)).join(', ')

    const seen = (
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
    )

    return <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-faint)">
      {time}
      {(time || edited) && <span aria-hidden>·</span>}
      {edited}
      {edited && <span aria-hidden>·</span>}
      {seen}
    </span>
  }

  if (latest && message.sent) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-faint)" role="status">
        {time}
        {(time || edited) && <span aria-hidden>·</span>}
        {edited}
        {edited && <span aria-hidden>·</span>}
        <span className="inline-flex items-center gap-1 text-(--atum-ink-muted)" data-matrix-sent>
          <Check aria-hidden className="size-3" />
          {chat.sent}
        </span>
      </span>
    )
  }

  return time || edited ? (
    <span className="inline-flex items-center gap-1 text-xs text-(--atum-ink-faint)">
      {time}
      {time && edited && <span aria-hidden>·</span>}
      {edited}
    </span>
  ) : null
}
