import { useMemo } from 'react'

import { MarkdownContent, type MarkdownHost } from '@/components/assistant-ui/markdown-surface'

import type { MatrixMessage } from '../../../shared/matrix'
import { MATRIX_MARKDOWN_HOST } from '../markdown-host'
import { matrixMentionMarkdown } from '../matrix-mentions'
import type { MatrixPeopleContext } from '../person-name'

export function TeamSpaceMentionContent({
  message,
  people,
  roomId
}: {
  message: MatrixMessage
  people: MatrixPeopleContext
  roomId: string
}) {
  const rendered = useMemo(
    () => matrixMentionMarkdown(message.body, message.mentions, people, roomId),
    [message.body, message.mentions, people, roomId]
  )

  const host = useMemo<MarkdownHost>(
    () => ({
      ...MATRIX_MARKDOWN_HOST,
      renderLink: href => {
        const label = href ? rendered.labels.get(href) : undefined

        return label ? (
          <span
            className="inline-flex max-w-full items-center rounded-full bg-(--atum-row-hover) px-1.5 font-semibold text-(--atum-ink)"
            data-matrix-mention-pill
          >
            {label}
          </span>
        ) : null
      }
    }),
    [rendered.labels]
  )

  return <MarkdownContent host={host} isRunning={false} text={rendered.text} />
}
