import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { BookmarkFilled, Hash, Trash2 } from '@/lib/icons'

import type {
  MatrixSavedMessagePointer,
  MatrixSavedMessagesSnapshot,
  MatrixSavedMessageView
} from '../../../shared/matrix-saved-messages'

import { useSavedMessagesCopy } from './saved-messages-copy'

export interface SavedMessagesViewProps {
  accountKey: string
  companies: readonly { id: string; displayName: string }[]
  saved: MatrixSavedMessagesSnapshot
  onOpen(message: MatrixSavedMessageView & { available: true }): Promise<void>
}

function keyOf(message: Pick<MatrixSavedMessagePointer, 'room_id' | 'event_id'>): string {
  return `${message.room_id}\0${message.event_id}`
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validRows(value: unknown): MatrixSavedMessageView[] {
  if (!Array.isArray(value)) {
    throw new Error('matrix_saved_messages_invalid')
  }

  return value.map(candidate => {
    if (!record(candidate) || typeof candidate.room_id !== 'string' || typeof candidate.event_id !== 'string' ||
      !Number.isSafeInteger(candidate.saved_at) || typeof candidate.available !== 'boolean') {
      throw new Error('matrix_saved_messages_invalid')
    }

    const pointer = {
      room_id: candidate.room_id,
      event_id: candidate.event_id,
      saved_at: Number(candidate.saved_at)
    }

    if (!candidate.available) {
      return { ...pointer, available: false }
    }

    if (typeof candidate.companyId !== 'string' || typeof candidate.roomName !== 'string' ||
      !['channel', 'conversation'].includes(String(candidate.roomKind)) ||
      typeof candidate.senderName !== 'string' || typeof candidate.own !== 'boolean' ||
      typeof candidate.body !== 'string' || !Number.isSafeInteger(candidate.sentAt) ||
      (candidate.threadRootId !== undefined && typeof candidate.threadRootId !== 'string')) {
      throw new Error('matrix_saved_messages_invalid')
    }

    return {
      ...pointer,
      available: true,
      companyId: candidate.companyId,
      roomName: candidate.roomName,
      roomKind: candidate.roomKind as 'channel' | 'conversation',
      senderName: candidate.senderName,
      own: candidate.own,
      body: candidate.body,
      sentAt: Number(candidate.sentAt),
      ...(candidate.threadRootId ? { threadRootId: candidate.threadRootId } : {})
    }
  })
}

/** Account-wide Saved messages. Matrix remains the source; this view owns only request state. */
export function SavedMessagesView({ accountKey, companies, onOpen, saved }: SavedMessagesViewProps) {
  const { locale } = useI18n()
  const copy = useSavedMessagesCopy()
  const [rows, setRows] = useState<MatrixSavedMessageView[]>([])
  const [loading, setLoading] = useState(saved.records.length > 0)
  const [failed, setFailed] = useState(false)
  const [opening, setOpening] = useState<string>()
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const attempt = useRef(0)
  const companiesById = useMemo(() => new Map(companies.map(company => [company.id, company.displayName])), [companies])
  const recordsKey = saved.records.map(keyOf).join('\n')

  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const load = () => {
    const current = ++attempt.current

    if (saved.records.length === 0) {
      setRows([])
      setLoading(false)
      setFailed(false)

      return
    }

    setLoading(true)
    setFailed(false)
    void window.atumMatrix.command({ kind: 'savedMessagesRead' })
      .then(value => {
        if (attempt.current === current) {
          setRows(validRows(value))
        }
      })
      .catch(() => {
        if (attempt.current === current) {
          setRows([])
          setFailed(true)
        }
      })
      .finally(() => {
        if (attempt.current === current) {
          setLoading(false)
        }
      })
  }

  useEffect(() => {
    load()

    return () => {
      attempt.current += 1
    }
  // The account and pointer set are the request identity; writer readiness alone does not change the rows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, recordsKey])

  const remove = async (message: MatrixSavedMessageView) => {
    const key = keyOf(message)
    const before = rows
    setRemoving(current => new Set(current).add(key))
    setRows(current => current.filter(candidate => keyOf(candidate) !== key))
    setFailed(false)

    try {
      await window.atumMatrix.command({
        kind: 'savedMessage',
        roomId: message.room_id,
        eventId: message.event_id,
        saved: false
      })
    } catch {
      setRows(before)
      setFailed(true)
    } finally {
      setRemoving(current => {
        const next = new Set(current)
        next.delete(key)

        return next
      })
    }
  }

  return (
    <section aria-labelledby="saved-messages-title" className="flex min-h-0 flex-1 flex-col" data-matrix-saved-messages>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--atum-line) px-5">
        <BookmarkFilled aria-hidden className="size-4 text-(--atum-accent)" />
        <h2 className="text-(length:--atum-t-section) font-semibold text-(--atum-ink)" id="saved-messages-title">
          {copy.title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && <Loader className="m-6 size-5" label={copy.loading} size="sm" />}
        {failed && (
          <div className="grid justify-items-start gap-2 p-6" role="alert">
            <p className="text-sm text-destructive">{copy.failed}</p>
            <Button onClick={load} size="sm" variant="text">{copy.retry}</Button>
          </div>
        )}
        {!loading && !failed && rows.length === 0 && (
          <EmptyState className="m-auto p-8" description={copy.emptyBody} title={copy.emptyTitle} />
        )}
        {!loading && rows.length > 0 && (
          <ul className="divide-y divide-(--atum-line)" role="list">
            {rows.map(message => {
              const key = keyOf(message)
              const companyName = message.available ? companiesById.get(message.companyId) : undefined
              const available = message.available && Boolean(companyName)

              return (
                <li className="group/saved flex gap-3 px-5 py-4 hover:bg-(--atum-row-hover)" key={key}>
                  <div className="min-w-0 flex-1">
                    {available ? (
                      <button
                        aria-label={`${copy.open}: ${message.body}`}
                        className="grid w-full min-w-0 gap-1 text-start focus-visible:outline-2 focus-visible:outline-(--atum-accent)"
                        disabled={Boolean(opening)}
                        onClick={() => {
                          setOpening(key)
                          setFailed(false)
                          void onOpen(message).catch(() => setFailed(true)).finally(() => setOpening(undefined))
                        }}
                        type="button"
                      >
                        <span className="flex min-w-0 items-center gap-1 text-xs text-(--atum-ink-muted)">
                          <span className="truncate">{companyName}</span>
                          <span aria-hidden>·</span>
                          {message.roomKind === 'channel' && <Hash aria-hidden className="size-3" />}
                          <span className="truncate">{message.roomName}</span>
                        </span>
                        <span className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-(--atum-ink)">{message.body}</span>
                        <span className="text-xs text-(--atum-ink-faint)">
                          {message.own ? copy.you : message.senderName} · {date.format(message.sentAt)}
                        </span>
                      </button>
                    ) : (
                      <div className="grid gap-1">
                        <span className="text-sm font-medium text-(--atum-ink-muted)">{copy.unavailable}</span>
                        <span className="text-xs text-(--atum-ink-faint)">{copy.unavailableBody}</span>
                      </div>
                    )}
                  </div>
                  <Button
                    aria-label={copy.remove}
                    disabled={removing.has(key) || !saved.writable}
                    onClick={() => void remove(message)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
