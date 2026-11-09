import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import {
  MATRIX_STATUS_EMOJI_MAX,
  MATRIX_STATUS_TEXT_MAX,
  type MatrixStatusInput,
  validMatrixStatusInput
} from '../../shared/matrix-presence'
import { matrixPresenceCopy } from '../../shared/matrix-presence-copy'

type ExpiryChoice = '30m' | '1h' | '4h' | 'today' | 'custom'

const localDateTime = (value: number) => {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)

  return date.toISOString().slice(0, 16)
}

export function matrixStatusExpiry(choice: ExpiryChoice, now: number, custom: string): number {
  if (choice === '30m') {return now + 30 * 60_000}

  if (choice === '1h') {return now + 60 * 60_000}

  if (choice === '4h') {return now + 4 * 60 * 60_000}

  if (choice === 'today') {
    const tomorrow = new Date(now)
    tomorrow.setHours(24, 0, 0, 0)

    return tomorrow.getTime()
  }

  return new Date(custom).getTime()
}

export function MatrixStatusEditor({ onOpenChange, open, snapshot }: {
  onOpenChange(open: boolean): void
  open: boolean
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixPresenceCopy(locale)
  const own = snapshot.presence?.users.find(user => user.userId === snapshot.identity?.userId)?.status
  const [emoji, setEmoji] = useState('')
  const [text, setText] = useState('')
  const [dnd, setDnd] = useState(false)
  const [choice, setChoice] = useState<ExpiryChoice>('1h')
  const [custom, setCustom] = useState(localDateTime(Date.now() + 60 * 60_000))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const emojiId = useId()
  const textId = useId()
  const customId = useId()

  useEffect(() => {
    if (!open) {return}

    setEmoji(own?.emoji ?? '')
    setText(own?.text ?? '')
    setDnd(own?.dnd ?? false)
    setChoice(own?.expiresAt ? 'custom' : '1h')
    setCustom(localDateTime(own?.expiresAt ?? Date.now() + 60 * 60_000))
    setFailed(false)
  }, [open, own?.dnd, own?.emoji, own?.expiresAt, own?.text])

  const expiresAt = matrixStatusExpiry(choice, Date.now(), custom)

  const status = useMemo<MatrixStatusInput>(() => ({
    dnd,
    expiresAt,
    ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
    ...(text.trim() ? { text } : {})
  }), [dnd, emoji, expiresAt, text])

  const valid = validMatrixStatusInput(status)

  const write = async (next: MatrixStatusInput | null) => {
    setSaving(true)
    setFailed(false)

    try {
      await window.atumMatrix.command({ kind: 'setStatus', status: next })
      onOpenChange(false)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (valid && !saving) {void write(status)}
  }

  return (
    <Dialog onOpenChange={next => !saving && onOpenChange(next)} open={open}>
      <DialogContent aria-describedby="matrix-status-description" className="atum-sheet max-w-md" data-matrix-status-editor>
        <DialogTitle>{copy.statusTitle}</DialogTitle>
        <DialogDescription id="matrix-status-description">{copy.statusDescription}</DialogDescription>
        <form className="mt-(--ak-s5) grid gap-(--ak-s4)" onSubmit={submit}>
          <div className="grid grid-cols-[5rem_1fr] gap-(--ak-s3)">
            <label className="grid gap-(--ak-s1) [font:var(--ak-t-body)] text-(--ak-ink-2)" htmlFor={emojiId}>
              {copy.emoji}
              <Input id={emojiId} maxLength={MATRIX_STATUS_EMOJI_MAX * 2}
                onChange={event => setEmoji(event.target.value)} placeholder={copy.emojiPlaceholder} value={emoji} />
            </label>
            <label className="grid gap-(--ak-s1) [font:var(--ak-t-body)] text-(--ak-ink-2)" htmlFor={textId}>
              {copy.message}
              <Input id={textId} maxLength={MATRIX_STATUS_TEXT_MAX * 2}
                onChange={event => setText(event.target.value)} placeholder={copy.messagePlaceholder} value={text} />
            </label>
          </div>
          <label className="grid gap-(--ak-s1) [font:var(--ak-t-body)] text-(--ak-ink-2)">
            {copy.expires}
            <Select onValueChange={value => setChoice(value as ExpiryChoice)} value={choice}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30m">{copy.thirtyMinutes}</SelectItem>
                <SelectItem value="1h">{copy.oneHour}</SelectItem>
                <SelectItem value="4h">{copy.fourHours}</SelectItem>
                <SelectItem value="today">{copy.today}</SelectItem>
                <SelectItem value="custom">{copy.custom}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {choice === 'custom' && (
            <label className="grid gap-(--ak-s1) [font:var(--ak-t-body)] text-(--ak-ink-2)" htmlFor={customId}>
              {copy.customTime}
              <Input id={customId} min={localDateTime(Date.now() + 60_000)} onChange={event => setCustom(event.target.value)}
                type="datetime-local" value={custom} />
            </label>
          )}
          <label className="flex items-center justify-between gap-(--ak-s4) rounded-(--ak-r-lg) bg-(--ak-fill-quiet) p-(--ak-s3)">
            <span className="grid gap-(--ak-s1)">
              <span className="[font:var(--ak-t-body-strong)] text-(--ak-ink)">{copy.dnd}</span>
              <span className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">{copy.dndHelp}</span>
            </span>
            <Switch aria-label={copy.dnd} checked={dnd} onCheckedChange={setDnd} />
          </label>
          {failed && <p className="[font:var(--ak-t-body)] text-(--ak-danger)" role="alert">{copy.failed}</p>}
          <DialogFooter>
            {own && <Button disabled={saving} onClick={() => void write(null)} type="button" variant="text">{copy.clear}</Button>}
            <Button disabled={saving} onClick={() => onOpenChange(false)} type="button" variant="text">{copy.cancel}</Button>
            <Button disabled={!valid || saving} type="submit">{saving ? copy.saving : copy.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
