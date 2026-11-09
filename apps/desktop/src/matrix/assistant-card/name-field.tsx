import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { Pencil } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ASSISTANT_NAME_MAX, type AssistantNameCheck } from '../../../shared/matrix-assistant-name'

import { useAssistantCardCopy } from './copy'

/** Shown from this many characters on: how many are left. */
const COUNTER_FROM = 32

/**
 * The name, renamed where it stands (DESIGN.md › Assistant card). At rest it is the card's
 * title; a click, Return or Space turns the same box into a field with the same type, so
 * nothing moves — only the material changes. Return or leaving the field commits; Esc puts
 * the name back and does nothing else (the next Esc closes the sheet).
 */
export function InlineNameField({
  adornment,
  check,
  className,
  editable,
  name,
  refusal,
  onCommit,
  onEditingChange,
  startEditing
}: {
  adornment?: ReactNode
  /** The card's rules for a name (normalize, reserved, duplicates). */
  check(value: string): AssistantNameCheck
  className?: string
  editable: boolean
  name: string
  /** A refusal from the platform: the field reopens with the typed name and the reason. */
  refusal?: { message: string; draft: string }
  onCommit(next: string): void
  onEditingChange?(editing: boolean): void
  /** Open in edit mode with the text selected ("Rename…"). */
  startEditing?: boolean
}) {
  const copy = useAssistantCardCopy()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [problem, setProblem] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const helperId = useId()
  // Esc reverts; the blur that follows must not commit what was reverted.
  const cancelled = useRef(false)

  const begin = () => {
    if (!editable) {
      return
    }

    cancelled.current = false
    setDraft(name)
    setProblem(undefined)
    setEditing(true)
  }

  // "Rename…": the field opens, text selected, as soon as the card can save a name.
  const started = useRef(false)

  useEffect(() => {
    if (startEditing && editable && !started.current) {
      started.current = true
      cancelled.current = false
      setDraft(name)
      setEditing(true)
    }
  }, [startEditing, editable, name])

  // A refusal from the platform reopens the field with its message and the typed name.
  useEffect(() => {
    if (refusal && editable) {
      cancelled.current = false
      setDraft(refusal.draft)
      setProblem(refusal.message)
      setEditing(true)
    }
  }, [refusal, editable])

  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false

      return
    }

    // An unchanged name closes the field as it is: a stored name today's rules refuse (an
    // older "Atum Main") must not trap the field until Esc.
    if (draft.trim() === name) {
      setEditing(false)
      setProblem(undefined)

      return
    }

    const result = check(draft)

    if (result.ok === false) {
      setProblem(copy.problems[result.problem](draft.trim(), result.char))
      input.current?.focus()

      return
    }

    setEditing(false)
    setProblem(undefined)

    if (result.name !== name) {
      onCommit(result.name)
    }
  }

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      // One step back: the field, not the sheet.
      event.preventDefault()
      event.stopPropagation()
      cancelled.current = true
      setDraft(name)
      setProblem(undefined)
      setEditing(false)
    }
  }

  const typedLength = [...draft].length
  const helper = problem ?? (typedLength >= COUNTER_FROM ? copy.nameLeft(ASSISTANT_NAME_MAX - typedLength) : copy.nameHelper)

  const box = cn(
    'atum-card-name block w-full max-w-[22rem] truncate rounded-[0.625rem] px-2.5 text-center',
    className
  )

  if (!editable) {
    return (
      <h2 className={cn(box, 'flex items-center justify-center gap-1.5')}>
        <span className="min-w-0 truncate">{name}</span>
        {adornment}
      </h2>
    )
  }

  if (!editing) {
    return (
      <h2 className="m-0 flex w-full justify-center">
        {/* The pencil is always there (quietly), so renaming is found without hovering; a
            spacer of its width keeps the name centred. */}
        <button
          aria-label={copy.nameLabel(name)}
          className={cn(
            'atum-card-name atum-card-name-rest flex w-full max-w-[22rem] items-center justify-center gap-1.5 rounded-[0.625rem] px-2.5',
            className
          )}
          data-assistant-card-name
          onClick={begin}
          type="button"
        >
          <span aria-hidden className="atum-card-name-pencil-space" />
          <span className="min-w-0 truncate">{name}</span>
          {adornment}
          <Pencil aria-hidden className="atum-card-name-pencil" />
        </button>
      </h2>
    )
  }

  return (
    <div className="atum-card-name-editing flex w-full flex-col items-center">
      <span className="flex w-full items-center justify-center gap-1.5">
        <input
          aria-describedby={helperId}
          aria-invalid={problem ? true : undefined}
          aria-label={copy.nameField}
          autoComplete="off"
          className={cn(box, 'atum-card-name-field')}
          data-assistant-card-name-field
          onBlur={commit}
          onChange={event => {
            // A pasted line break is a space; past the limit, typing does nothing.
            const next = event.target.value.replace(/[\r\n]+/g, ' ')

            if ([...next.normalize('NFC')].length <= ASSISTANT_NAME_MAX) {
              setDraft(next)
              setProblem(undefined)
            }
          }}
          onKeyDown={keys}
          ref={input}
          spellCheck={false}
          value={draft}
        />
        {adornment}
      </span>
      <p
        aria-live={problem ? 'assertive' : 'polite'}
        className="atum-card-name-helper"
        data-tone={problem ? 'danger' : undefined}
        id={helperId}
      >
        {helper}
      </p>
    </div>
  )
}
