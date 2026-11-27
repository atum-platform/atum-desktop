import { type FormEvent, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { matrixGeoPoint } from '../../shared/matrix-rich-content'

import { runMatrixCommand } from './text-document-actions'

export function MatrixRichContentDialog({ kind, roomId, close, sent }: {
  kind: 'poll' | 'location'
  roomId: string
  close(): void
  sent?(): void
}) {
  const [input, setInput] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [undisclosed, setUndisclosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const poll = kind === 'poll'
  const point = matrixGeoPoint(input)
  const answers = options.map(option => option.trim()).filter(Boolean)

  const canSend = poll
    ? Boolean(input.trim()) && answers.length >= 2 && new Set(answers).size === answers.length
    : Boolean(point)

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (!canSend || busy) {
      return
    }

    setBusy(true)
    setFailed(false)

    try {
      await runMatrixCommand(poll
        ? { kind: 'pollCreate', roomId, question: input.trim(), options: answers, undisclosed }
        : { kind: 'locationSend', roomId, geoUri: point! })
      close()
      sent?.()
    } catch {
      setBusy(false)
      setFailed(true)
    }
  }

  return (
    <Dialog onOpenChange={open => { if (!open && !busy) {close()} }} open>
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>{poll ? 'Create poll' : 'Share a place'}</DialogTitle>
        <DialogDescription className={poll ? 'sr-only' : undefined}>
          {poll ? 'Add a question and at least two options.' : 'Enter the latitude and longitude of the place you want to share.'}
        </DialogDescription>
        <form className="grid gap-3" onSubmit={event => void submit(event)}>
          <Input
            aria-label={poll ? 'Question' : 'Latitude, longitude'}
            disabled={busy}
            maxLength={poll ? 500 : 128}
            onChange={event => setInput(event.currentTarget.value)}
            placeholder={poll ? 'Question' : 'Latitude, longitude'}
            value={input}
          />
          {poll && (
            <>
              {options.map((option, index) => (
                <Input
                  aria-label={`Option ${index + 1}`}
                  disabled={busy}
                  key={index}
                  maxLength={240}
                  onChange={event => {
                    const value = event.currentTarget.value
                    setOptions(previous => previous.map((entry, i) => index === i ? value : entry))
                  }}
                  placeholder={`Option ${index + 1}`}
                  value={option}
                />
              ))}
              <Button
                className="justify-self-start"
                disabled={busy || options.length === 20}
                onClick={() => setOptions(previous => [...previous, ''])}
                size="sm"
                type="button"
                variant="text"
              >
                Add option
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input checked={undisclosed} disabled={busy} onChange={event => setUndisclosed(event.currentTarget.checked)} type="checkbox" />
                Hide results until the poll closes
              </label>
            </>
          )}
          {failed && <span className="text-sm" role="status">Could not send. Try again.</span>}
          <Button className="justify-self-end" disabled={!canSend || busy} type="submit">Send</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
