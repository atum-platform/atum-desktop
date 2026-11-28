import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type { MatrixThread } from '../../shared/matrix'

import { matrixThreadCopy } from './thread-copy'

interface GroupThreadPreviewProps {
  threads: readonly MatrixThread[]
  onOpen(rootId?: string): void
}

export function GroupThreadPreview({ threads, onOpen }: GroupThreadPreviewProps) {
  const { locale } = useI18n()
  const copy = matrixThreadCopy(locale)

  if (!threads.length) {
    return null
  }

  return (
    <section aria-label={copy.threads}>
      <h3 className="ak-section">{copy.threads}</h3>
      <div className="ak-group ak-group--plain">
        {threads.slice(0, 3).map(thread => (
          <button
            className="ak-row w-full text-left"
            key={thread.root.id}
            onClick={() => onOpen(thread.root.id)}
            type="button"
          >
            {thread.unread && (
              <span aria-label={copy.unread} className="size-1.5 shrink-0 rounded-full bg-(--ak-ink)" role="img" />
            )}
            <span className="ak-row-main min-w-0 truncate">{thread.root.body || copy.thread}</span>
            <span className="shrink-0 [font:var(--ak-t-callout)] text-(--ak-ink-3)">{copy.replies(thread.replyCount)}</span>
          </button>
        ))}
        <button className="ak-row w-full text-left" onClick={() => onOpen()} type="button">
          <span className="ak-row-main">{copy.allThreads}</span>
          <ChevronRight aria-hidden className="ak-icon shrink-0" />
        </button>
      </div>
    </section>
  )
}
