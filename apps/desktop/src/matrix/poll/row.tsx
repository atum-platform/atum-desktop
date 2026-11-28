import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { MatrixPoll, MatrixPollCommand } from '../../../shared/matrix-rich-content'
import { runMatrixCommand } from '../text-document-actions'

export function MatrixPollRow({ eventId, roomId, poll, readOnly }: {
  eventId: string
  roomId: string
  poll: MatrixPoll
  readOnly: boolean
}) {
  const [pending, setPending] = useState(false)
  const [fault, setFault] = useState('')
  const [retry, setRetry] = useState(0)
  const ready = poll.ready

  useEffect(() => {
    if (ready) {
      return
    }

    let current = true
    void runMatrixCommand({ kind: 'pollRead', roomId, eventId }).catch(() => {
      if (current) {
        setFault('Could not load poll.')
      }
    })

    return () => {
      current = false
    }
  }, [eventId, ready, retry, roomId])

  const submit = async (action: MatrixPollCommand) => {
    setPending(true)
    setFault('')

    try {
      await runMatrixCommand(action)
    } catch {
      setFault('Could not update poll. Try again.')
    } finally {
      setPending(false)
    }
  }

  const vote = (id: string) => {
    const answers = poll.maxSelections === 1
      ? [id]
      : poll.selected.includes(id)
        ? poll.selected.filter(answer => answer !== id)
        : [...poll.selected, id]

    void submit({ kind: 'pollVote', roomId, eventId, answers })
  }

  return (
    <div className="matrix-chat-bubble w-72 max-w-full space-y-2" data-matrix-poll>
      <div className="font-medium">{poll.question}</div>
      <div aria-label={poll.question} className="space-y-1.5" role="group">
        {poll.answers.map(answer => {
          const selected = poll.selected.includes(answer.id)
          const full = poll.maxSelections > 1 && poll.selected.length >= poll.maxSelections && !selected

          return (
            <button
              aria-pressed={selected}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-(--ak-line) px-3 py-1.5 text-start aria-pressed:bg-(--ak-fill-press) disabled:cursor-default"
              disabled={pending || !poll.canVote || readOnly || full || (poll.maxSelections === 1 && selected)}
              key={answer.id}
              onClick={() => vote(answer.id)}
              type="button"
            >
              <span className="min-w-0 break-words">{answer.text}</span>
              {answer.votes !== undefined && (
                <span className="shrink-0 text-xs">{answer.votes} {answer.votes === 1 ? 'vote' : 'votes'}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-(--ak-ink-3)">
        {poll.ended ? <span>Poll closed</span> : poll.undisclosed ? <span>Results appear when closed</span> : null}
        {!readOnly && poll.canEnd && (
          <Button disabled={pending} onClick={() => void submit({ kind: 'pollEnd', roomId, eventId })} size="sm" type="button" variant="text">
            End poll
          </Button>
        )}
        {fault && <span role="status">{fault}</span>}
        {fault && !ready && (
          <Button onClick={() => { setFault(''); setRetry(value => value + 1) }} size="sm" type="button" variant="text">
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}
