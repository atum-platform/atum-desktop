import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Maximize } from '@/lib/icons'
import { ChevronRight } from '@/lib/icons'

import type { ParsedPersona } from '../../../shared/matrix-assistant-persona'

import { useAssistantCardCopy } from './copy'

export interface PersonaChange {
  who?: string
  what?: string
  instructions?: string
}

/**
 * Card 1: how the assistant works, in the words it was made with. The template's two
 * sections are two fields — what it helps with (always open) and its personality (a row
 * that opens in place). A hand-written persona uses the same fields: its full text except
 * `Who you are` is the first field, and that section is the personality. Each saves when the
 * person is done with it; there is no Save button.
 */
export function PersonaFields({
  disabled,
  name,
  note,
  onSave,
  persona
}: {
  disabled: boolean
  name: string
  /** The saved / failed line under the field that saved last. */
  note?: { field: keyof PersonaChange; node: ReactNode }
  onSave(change: PersonaChange): void
  persona: ParsedPersona
}) {
  const copy = useAssistantCardCopy()
  const custom = persona.kind === 'custom'
  const mainField = custom ? 'instructions' : 'what'

  return (
    <div className="atum-settings-group" data-assistant-card-persona={persona.kind}>
      <AutoField
        disabled={disabled}
        label={copy.purposeLabel(name)}
        note={note?.field === mainField ? note.node : undefined}
        onSave={value => onSave(custom ? { instructions: value } : { what: value })}
        placeholder={copy.purposePlaceholder}
        rows={8}
        value={custom ? persona.instructions : persona.what}
      />
      <PersonalityRow
        disabled={disabled}
        note={note?.field === 'who' ? note.node : undefined}
        onSave={value => onSave({ who: value })}
        value={persona.who}
      />
    </div>
  )
}

/**
 * A field that is always open. It saves once per visit — on leaving it or on ⌘Return — so
 * one edit is one write and one Undo, never a write per pause in typing. Esc puts back what
 * was saved and leaves the field without saving (the sheet stays; the next Esc closes it).
 * Closing the card with the field still open keeps what was typed.
 *
 * It starts tall and grows with the text up to a cap; the expand button opens the same text in
 * a window-sized editor with the same rules: closing or ⌘Return saves, Esc puts back and closes.
 */
function AutoField({
  disabled,
  label,
  note,
  onSave,
  placeholder,
  rows,
  value
}: {
  disabled: boolean
  label: string
  note?: ReactNode
  onSave(value: string): void
  placeholder?: string
  rows: number
  value: string
}) {
  const copy = useAssistantCardCopy()
  const id = useId()
  const expandedId = useId()
  const [draft, setDraft] = useState(value)
  const [expanded, setExpanded] = useState(false)
  const [expandedDraft, setExpandedDraft] = useState(value)
  const field = useRef<HTMLTextAreaElement>(null)
  const expandedField = useRef<HTMLTextAreaElement>(null)
  const focused = useRef(false)
  const committed = useRef(value)
  // Esc reverts; the blur that follows must not save what was reverted.
  const cancelled = useRef(false)
  // The expanded editor's Esc closes without saving, so the close that follows must not either.
  const expandedCancelled = useRef(false)
  const latest = useRef({ draft, onSave })
  const expandedLive = useRef(expanded)

  latest.current = { draft: expanded ? expandedDraft : draft, onSave }
  expandedLive.current = expanded

  // A newer saved value (another device, an Undo) shows unless the person is typing.
  useEffect(() => {
    committed.current = value

    if (!focused.current) {
      setDraft(value)

      if (!expandedLive.current) {
        setExpandedDraft(value)
      }
    }
  }, [value])

  // The card closed (Xong, a click outside) while the field still held unsaved typing.
  useEffect(
    () => () => {
      const pending = latest.current

      if (pending.draft.trim() !== committed.current.trim()) {
        committed.current = pending.draft
        pending.onSave(pending.draft)
      }
    },
    []
  )

  // Grows with the text, up to the cap; the row's height is otherwise the field's own.
  useLayoutEffect(() => {
    const element = field.current

    if (!element) {
      return
    }

    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  useLayoutEffect(() => {
    if (expanded) {
      const element = expandedField.current
      element?.focus()
      element?.setSelectionRange(element.value.length, element.value.length)
    }
  }, [expanded])

  const commit = (text: string) => {
    if (text.trim() !== committed.current.trim()) {
      committed.current = text
      onSave(text)
    }
  }

  const openExpanded = () => {
    expandedCancelled.current = false
    setExpandedDraft(draft)
    setExpanded(true)
  }

  const closeExpanded = (save: boolean) => {
    setExpanded(false)

    if (save) {
      setDraft(expandedDraft)
      commit(expandedDraft)
    }
  }

  return (
    <div className="atum-settings-row atum-card-field-row">
      <div className="flex items-center justify-between gap-2">
        <label className="atum-card-field-label" htmlFor={id}>
          {label}
        </label>
        <Button
          aria-label={copy.expandField(label)}
          className="text-(--atum-ink-faint) hover:text-foreground"
          data-assistant-card-field-expand
          disabled={disabled}
          onClick={openExpanded}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Maximize aria-hidden className="size-3.5" />
        </Button>
      </div>
      <textarea
        className="atum-input atum-card-field max-h-80"
        data-assistant-card-field={label}
        disabled={disabled}
        id={id}
        onBlur={() => {
          focused.current = false

          if (cancelled.current) {
            cancelled.current = false

            return
          }

          commit(draft)
        }}
        onChange={event => setDraft(event.target.value)}
        onFocus={() => {
          focused.current = true
          cancelled.current = false
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) {
            return
          }

          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            commit(draft)
          } else if (event.key === 'Escape') {
            // One step back: the field, never the sheet.
            event.preventDefault()
            event.stopPropagation()
            cancelled.current = true
            setDraft(committed.current)
            latest.current = { draft: committed.current, onSave }
            event.currentTarget.blur()
          }
        }}
        placeholder={placeholder}
        ref={field}
        rows={rows}
        value={draft}
      />
      {note}
      <Dialog
        onOpenChange={next => {
          if (!next) {
            closeExpanded(!expandedCancelled.current)
            expandedCancelled.current = false
          }
        }}
        open={expanded}
      >
        <DialogContent
          className="flex h-[70vh] w-[70vw] max-w-[70vw] flex-col gap-3 p-6"
          data-assistant-card-field-dialog={label}
          onEscapeKeyDown={event => {
            // One step back: the expanded editor saves on close, Esc means "put it back".
            event.preventDefault()
            expandedCancelled.current = true
            setExpanded(false)
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{label}</DialogTitle>
            <Button onClick={() => closeExpanded(true)} size="inline" type="button" variant="text">
              {copy.done}
            </Button>
          </div>
          <textarea
            aria-label={label}
            className="atum-input atum-card-field min-h-0 flex-1 resize-none"
            id={expandedId}
            onChange={event => setExpandedDraft(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) {
                return
              }

              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                closeExpanded(true)
              }
            }}
            placeholder={placeholder}
            ref={expandedField}
            value={expandedDraft}
          />
          <p className="atum-settings-section-foot">{copy.fieldKeys}</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** "Personality": a row with its value that opens into a two-line field in place. */
function PersonalityRow({
  disabled,
  note,
  onSave,
  value
}: {
  disabled: boolean
  note?: ReactNode
  onSave(value: string): void
  value: string
}) {
  const copy = useAssistantCardCopy()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const field = useRef<HTMLTextAreaElement>(null)
  const cancelled = useRef(false)
  const id = useId()
  const latest = useRef({ open, draft, value, onSave })

  latest.current = { open, draft, value, onSave }

  // The card closed while the row was open: what was typed is kept, as leaving it would.
  useEffect(
    () => () => {
      const pending = latest.current

      if (pending.open && !cancelled.current && pending.draft.trim() !== pending.value.trim()) {
        pending.onSave(pending.draft)
      }
    },
    []
  )

  useLayoutEffect(() => {
    if (open) {
      field.current?.focus()
      field.current?.setSelectionRange(field.current.value.length, field.current.value.length)
    }
  }, [open])

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false

      return
    }

    setOpen(false)
    latest.current = { ...latest.current, open: false }

    if (draft.trim() !== value.trim()) {
      onSave(draft)
    }
  }

  if (!open) {
    return (
      <>
        <button
          aria-label={`${copy.personality}, ${value.trim() || copy.personalityEmpty}`}
          className="atum-settings-row atum-settings-link"
          data-assistant-card-personality
          disabled={disabled}
          onClick={() => {
            cancelled.current = false
            setDraft(value)
            setOpen(true)
          }}
          type="button"
        >
          <span className="atum-settings-row-title min-w-0 flex-1">{copy.personality}</span>
          <span className="atum-card-row-value" data-empty={value.trim() ? undefined : true}>
            {value.trim() || copy.personalityEmpty}
          </span>
          <ChevronRight aria-hidden className="atum-settings-chevron" />
        </button>
        {note && <div className="atum-card-row-note">{note}</div>}
      </>
    )
  }

  return (
    <div className="atum-settings-row atum-card-field-row">
      <label className="atum-card-field-label" htmlFor={id}>
        {copy.personality}
      </label>
      <textarea
        className="atum-input atum-card-field"
        data-assistant-card-personality-field
        id={id}
        onBlur={commit}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) {
            return
          }

          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancelled.current = true
            setDraft(value)
            setOpen(false)
          }
        }}
        placeholder={copy.personalityPlaceholder}
        ref={field}
        rows={2}
        value={draft}
      />
    </div>
  )
}
