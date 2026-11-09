import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { Pencil, X } from '@/lib/icons'

import { MATRIX_CHAT_TITLE_MAX, MATRIX_GROUP_TOPIC_MAX, type MatrixRoom, type MatrixSnapshot } from '../../shared/matrix'

import { useChatCopy } from './chat-copy'
import { personalGroupDetails } from './roster-model'
import { runMatrixCommand } from './text-document-actions'

export type MatrixGroupDetailField = 'name' | 'topic'

/**
 * The top of a personal group's sheet (Atum Kit: a sheet is its title and one line): the group's
 * name, then its topic. Whoever the room's power levels allow edits either in place, with Enter
 * to save and Escape to put it back; everyone else reads them. Both are the room's standard
 * `m.room.name` / `m.room.topic`, so the new words reach every member and every surface by sync.
 */
export function MatrixGroupDetailsHeader({
  details,
  editing,
  onEditing,
  room,
  title
}: {
  details: { name: boolean; topic: boolean }
  editing: MatrixGroupDetailField | null
  onEditing(field: MatrixGroupDetailField | null): void
  room: MatrixRoom
  /** The name the group goes by on screen. */
  title: string
}) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const topic = room.topic?.trim() ?? ''

  return (
    <div className="mb-4 flex items-start justify-between gap-3" data-matrix-group-details>
      <div className="min-w-0 flex-1">
        {editing === 'name' && details.name ? (
          <>
            <DialogTitle className="sr-only">{title}</DialogTitle>
            <GroupDetailEditor
              field="name"
              initial={room.title?.trim() || room.name.trim()}
              label={chat.renameGroupTitle}
              onDone={() => onEditing(null)}
              roomId={room.id}
            />
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <DialogTitle className="truncate" data-matrix-group-name>
              {title}
            </DialogTitle>
            {details.name && (
              <Tip label={chat.renameGroupTitle}>
                <Button
                  aria-label={chat.renameGroupTitle}
                  className="shrink-0"
                  data-matrix-group-name-edit
                  onClick={() => onEditing('name')}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Pencil aria-hidden />
                </Button>
              </Tip>
            )}
          </div>
        )}
        {editing === 'topic' && details.topic ? (
          <div className="mt-2">
            <GroupDetailEditor
              field="topic"
              initial={topic}
              label={chat.groupTopicLabel}
              onDone={() => onEditing(null)}
              placeholder={chat.groupTopicAdd}
              roomId={room.id}
            />
          </div>
        ) : topic ? (
          <div className="mt-1.5 flex min-w-0 items-start gap-1">
            <DialogDescription className="min-w-0 break-words" data-matrix-group-topic>
              {topic}
            </DialogDescription>
            {details.topic && (
              <Tip label={chat.groupTopicEdit}>
                <Button
                  aria-label={chat.groupTopicEdit}
                  className="-mt-0.5 shrink-0"
                  data-matrix-group-topic-edit
                  onClick={() => onEditing('topic')}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Pencil aria-hidden />
                </Button>
              </Tip>
            )}
          </div>
        ) : (
          details.topic && (
            <Button
              className="mt-1.5"
              data-matrix-group-topic-add
              onClick={() => onEditing('topic')}
              size="inline"
              type="button"
              variant="text"
            >
              {chat.groupTopicAdd}
            </Button>
          )
        )}
      </div>
      <Tip label={t.common.close}>
        <DialogClose asChild>
          <Button aria-label={t.common.close} className="-me-2 -mt-1 shrink-0" size="icon-sm" variant="ghost">
            <X aria-hidden />
          </Button>
        </DialogClose>
      </Tip>
    </div>
  )
}

/** One line edited in place: Save (or Enter) sends it, Cancel (or Escape, handled by the sheet)
 * puts it back. An unchanged line closes without a send; a group's name is never empty. */
function GroupDetailEditor({
  field,
  initial,
  label,
  onDone,
  placeholder,
  roomId
}: {
  field: MatrixGroupDetailField
  initial: string
  label: string
  onDone(): void
  placeholder?: string
  roomId: string
}) {
  const chat = useChatCopy()
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const next = value.trim().replace(/\s+/gu, ' ')
  const empty = field === 'name' && !next

  const save = () => {
    if (pending || empty) {
      return
    }

    if (next === initial.trim()) {
      onDone()

      return
    }

    setPending(true)
    setFailed(false)
    void runMatrixCommand(
      field === 'name' ? { kind: 'groupName', roomId, name: next } : { kind: 'groupTopic', roomId, topic: next }
    )
      .then(onDone, () => setFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <form
      className="flex flex-col gap-2"
      data-matrix-group-editor={field}
      onSubmit={event => {
        event.preventDefault()
        save()
      }}
    >
      <Input
        aria-label={label}
        autoFocus
        className="atum-input"
        disabled={pending}
        maxLength={field === 'name' ? MATRIX_CHAT_TITLE_MAX : MATRIX_GROUP_TOPIC_MAX}
        onChange={event => setValue(event.target.value)}
        onFocus={event => event.currentTarget.select()}
        placeholder={placeholder}
        value={value}
      />
      {failed && (
        <NoticeBand role="alert" tone="failure">
          {chat.errorGeneric}
        </NoticeBand>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={pending} onClick={onDone} size="sm" type="button" variant="ghost">
          {t.common.cancel}
        </Button>
        <Button disabled={pending || empty} size="sm" type="submit">
          {chat.save}
        </Button>
      </div>
    </form>
  )
}

/**
 * A personal group's topic beside its name in the chat's header, as a Team Space channel's is:
 * one quiet line after a hairline, cut to fit, the whole topic in its tip. Nothing on a narrow
 * window, for a group with no topic, or for any other chat.
 */
export function MatrixGroupHeaderTopic({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const compact = useMediaQuery('(max-width: 780px)')
  const topic = room.topic?.trim()

  if (!topic || compact || !personalGroupDetails(room, snapshot)) {
    return null
  }

  return (
    <>
      <span aria-hidden className="h-4 w-px shrink-0 bg-(--atum-line)" />
      <Tip label={topic}>
        <span className="min-w-0 truncate text-[0.8125rem] text-(--atum-ink-muted)" data-matrix-group-header-topic>
          {topic}
        </span>
      </Tip>
    </>
  )
}
