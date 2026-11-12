import { MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { type FC } from 'react'

import { messageContentText } from '@/components/assistant-ui/thread/content'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { TIMELINE_DELEGATION_MARKER, TIMELINE_MODEL_MARKER } from '@/lib/chat-messages'
import { LinkifiedText } from '@/lib/external-link'
import { displayModelName } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'

const SLASH_STATUS_RE = /^slash:(?<command>\/[^\n]+)\n(?<output>[\s\S]*)$/
const STEER_NOTE_RE = /^steer:(?<text>[\s\S]+)$/

export const SystemMessage: FC = () => {
  const text = useAuiState(s => messageContentText(s.message.content))
  const { t } = useI18n()

  if (!text) {
    return null
  }

  // Timeline notes arrive as machine markers (see `toChatMessages`) and are
  // spoken here, in the user's language: which model the session moved to,
  // and from which, when the transcript can tell.
  const modelNote = text.match(TIMELINE_MODEL_MARKER)
  const delegationNote = text.match(TIMELINE_DELEGATION_MARKER)

  if (modelNote?.groups || delegationNote?.groups) {
    const note = modelNote?.groups
      ? modelNote.groups.from
        ? t.timeline.modelChanged(displayModelName(modelNote.groups.from), displayModelName(modelNote.groups.to))
        : t.timeline.modelChangedTo(displayModelName(modelNote.groups.to))
      : Number(delegationNote!.groups!.count) < 0
        ? t.timeline.delegationFinished
        : t.timeline.delegationCountFinished(Number(delegationNote!.groups!.count))

    return (
      <MessagePrimitive.Root
        className="w-[60%] max-w-[44rem] self-center px-2 py-0.5 text-center text-[0.6875rem] leading-5 text-muted-foreground/55"
        data-role="system"
        data-slot="aui_system-message-root"
        data-timeline-note={modelNote ? 'model' : 'delegation'}
      >
        <span className="whitespace-pre-wrap">{note}</span>
      </MessagePrimitive.Root>
    )
  }

  const steerNote = text.match(STEER_NOTE_RE)

  if (steerNote?.groups) {
    return (
      <MessagePrimitive.Root
        className="flex max-w-[min(86%,44rem)] items-center gap-1.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60"
        data-role="system"
        data-slot="aui_system-message-root"
      >
        <Codicon className="text-muted-foreground/55" name="compass" size="0.75rem" />
        <span className="text-muted-foreground/55">{t.uiLabels.steered}</span>
        <span className="text-muted-foreground/35">·</span>
        <span className="whitespace-pre-wrap">{steerNote.groups.text.trim()}</span>
      </MessagePrimitive.Root>
    )
  }

  const slashStatus = text.match(SLASH_STATUS_RE)

  if (slashStatus?.groups) {
    const output = slashStatus.groups.output.trim()
    // Single-line status (e.g. "model → x") reads best centered inline; padded
    // multiline output (catalogs, usage tables) needs left-aligned, wider room
    // or the column alignment breaks.
    const multiline = output.includes('\n')

    return (
      <MessagePrimitive.Root
        className={cn(
          'w-[60%] max-w-[44rem] self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60',
          multiline ? 'text-left' : 'text-center'
        )}
        data-role="system"
        data-slot="aui_system-message-root"
      >
        <span className="font-mono text-muted-foreground/55">{slashStatus.groups.command}</span>
        {multiline ? (
          <LinkifiedText className="mt-0.5 block whitespace-pre-wrap" explicitOnly pretty={false} text={output} />
        ) : (
          <>
            <span className="mx-1.5 text-muted-foreground/35">·</span>
            <LinkifiedText className="whitespace-pre-wrap" explicitOnly pretty={false} text={output} />
          </>
        )}
      </MessagePrimitive.Root>
    )
  }

  const multiline = text.includes('\n')

  return (
    <MessagePrimitive.Root
      className={cn(
        'w-[60%] max-w-[44rem] self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/55',
        multiline ? 'text-left' : 'text-center'
      )}
      data-role="system"
      data-slot="aui_system-message-root"
    >
      <LinkifiedText className="whitespace-pre-wrap" explicitOnly pretty={false} text={text} />
    </MessagePrimitive.Root>
  )
}
