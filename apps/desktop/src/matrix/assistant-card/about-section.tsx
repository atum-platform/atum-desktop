import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { matrixAssistantAboutSummary } from '../../../shared/matrix-assistant-about'
import type { ParsedPersona } from '../../../shared/matrix-assistant-persona'

import { useAssistantCardCopy } from './copy'

export interface PersonaChange {
  field: 'who' | 'what' | 'instructions'
  before: string
  after: string
}

type EditorFocus = 'main' | 'who'

/**
 * About (agent card revamp 2026-11-28): what the assistant helps with as three lines of plain text,
 * and its personality as a row. Edit, or the row, opens the editor sheet with the persona's fields;
 * the raw text (Markdown, paths, a hand-written persona's sections) only ever appears there. Each
 * field saves when the person is done with it, as before, and offers Undo on the card.
 */
export function AboutSection({
  disabled,
  failed,
  longPersona,
  name,
  note,
  onSave,
  persona,
  rejected
}: {
  disabled: boolean
  /** The card's info could not be read: its retry row stands in for the summary. */
  failed?: ReactNode
  /** The saved persona exceeds what the agent loads: said under the field, in the editor. */
  longPersona: boolean
  name: string
  /** The saved / failed line for the field that saved last. */
  note?: { field: PersonaChange['field']; node: ReactNode }
  onSave(change: PersonaChange): void
  persona: ParsedPersona
  rejected?: { field?: PersonaChange['field'] }
}) {
  const copy = useAssistantCardCopy()
  const [editing, setEditing] = useState<EditorFocus>()
  const summary = useMemo(() => matrixAssistantAboutSummary(persona), [persona])
  const who = persona.who.trim()

  return (
    <section className="atum-card-section" data-assistant-card-section="about">
      <div className="atum-settings-section-head">
        <h3 className="ak-section atum-settings-section-title">{copy.sectionAbout}</h3>
        {!failed && (
          <span className="atum-settings-section-action">
            <Button
              className="font-semibold text-(--atum-ink)"
              data-assistant-card-about-edit
              disabled={disabled}
              onClick={() => setEditing('main')}
              size="inline"
              type="button"
              variant="text"
            >
              {copy.aboutEdit}
            </Button>
          </span>
        )}
      </div>
      {failed ?? (
        <div className="ak-group atum-settings-group" data-assistant-card-persona={persona.kind}>
          <p className="atum-card-about" data-assistant-card-about data-empty={summary ? undefined : true}>
            {summary || copy.aboutEmpty}
          </p>
          {note && note.field !== 'who' && !editing && <div className="atum-card-row-note">{note.node}</div>}
          <button
            aria-label={`${copy.personality}, ${who || copy.personalityEmpty}`}
            className="atum-settings-row atum-settings-link"
            data-assistant-card-personality
            disabled={disabled}
            onClick={() => setEditing('who')}
            type="button"
          >
            <span className="atum-settings-row-title min-w-0 flex-1">{copy.personality}</span>
            <span className="atum-card-row-value" data-empty={who ? undefined : true}>
              {who || copy.personalityEmpty}
            </span>
            <ChevronRight aria-hidden className="atum-settings-chevron" />
          </button>
          {note?.field === 'who' && !editing && <div className="atum-card-row-note">{note.node}</div>}
        </div>
      )}
      {editing && (
        <AboutEditor
          focus={editing}
          longPersona={longPersona}
          name={name}
          note={note}
          onClose={() => setEditing(undefined)}
          onSave={onSave}
          persona={persona}
          rejected={rejected}
        />
      )}
    </section>
  )
}

/**
 * The About editor: a sheet titled "About {name}" with what it helps with (or, for a hand-written
 * persona, its whole Instructions) and its personality. The rules are the card's: leaving a field or
 * ⌘Return saves; Esc in a field puts back what was saved (the next Esc closes the sheet); closing,
 * by Done or otherwise, keeps what was typed.
 */
function AboutEditor({
  focus,
  longPersona,
  name,
  note,
  onClose,
  onSave,
  persona,
  rejected
}: {
  focus: EditorFocus
  longPersona: boolean
  name: string
  note?: { field: PersonaChange['field']; node: ReactNode }
  onClose(): void
  onSave(change: PersonaChange): void
  persona: ParsedPersona
  rejected?: { field?: PersonaChange['field'] }
}) {
  const copy = useAssistantCardCopy()
  const custom = persona.kind === 'custom'
  const mainField = custom ? 'instructions' : 'what'

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent
        className={cn('z-[150] flex max-w-lg flex-col gap-4 p-6', custom && 'h-[78vh] max-w-2xl')}
        data-assistant-card-about-editor={persona.kind}
        onEscapeKeyDown={event => {
          // Esc steps back one level: a field first (it puts back what was saved), then the sheet.
          if ((event.target as HTMLElement | null)?.closest('[data-assistant-card-field], [data-assistant-card-personality-field]')) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={event => {
          // The field it was opened for (Edit: what it helps with; the Personality row: personality).
          const target = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLTextAreaElement>(
            focus === 'who' ? '[data-assistant-card-personality-field]' : '[data-assistant-card-field]'
          )

          if (target) {
            event.preventDefault()
            target.focus()
            target.setSelectionRange(target.value.length, target.value.length)
          }
        }}
        overlayClassName="z-[140]"
        showCloseButton={false}
      >
        <DialogTitle>{copy.editorTitle(name)}</DialogTitle>
        <EditorField
          grow={custom}
          label={custom ? copy.instructions : copy.editorWhat(name)}
          note={note?.field === mainField ? note.node : undefined}
          onSave={(before, after) => onSave({ field: mainField, before, after })}
          placeholder={copy.purposePlaceholder}
          rejected={rejected?.field === mainField ? rejected : undefined}
          rows={custom ? 12 : 5}
          value={custom ? persona.instructions : persona.what}
        />
        {longPersona && (
          <p className="atum-settings-section-foot" role="status">
            {copy.longPersona}
          </p>
        )}
        <EditorField
          label={copy.personality}
          note={note?.field === 'who' ? note.node : undefined}
          onSave={(before, after) => onSave({ field: 'who', before, after })}
          placeholder={copy.personalityPlaceholder}
          rejected={rejected?.field === 'who' ? rejected : undefined}
          singleLine
          value={persona.who}
        />
        <p className="atum-settings-section-foot">{copy.footnote}</p>
        <div className="flex justify-end">
          <Button data-assistant-card-about-done onClick={onClose} type="button">
            {copy.done}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One field of the editor. It saves once per visit — on leaving it or on ⌘Return (Return alone for
 * the one-line personality) — so one edit is one write and one Undo, never a write per pause in
 * typing. Esc puts back what was saved and leaves the field without saving. Closing the editor with
 * the field still holding typing keeps it.
 */
function EditorField({
  grow,
  label,
  note,
  onSave,
  placeholder,
  rejected,
  rows,
  singleLine,
  value
}: {
  /** Fill the sheet's height (a hand-written persona's whole text). */
  grow?: boolean
  label: string
  note?: ReactNode
  onSave(before: string, after: string): void
  placeholder?: string
  rejected?: object
  rows?: number
  singleLine?: boolean
  value: string
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const committed = useRef(value)
  // Esc reverts; the blur that follows must not save what was reverted.
  const cancelled = useRef(false)
  const latest = useRef({ draft, onSave })

  latest.current = { draft, onSave }

  // A newer saved value (another device, an Undo) shows unless the person is typing.
  useEffect(() => {
    if (!focused.current) {
      committed.current = value
      setDraft(value)
    }
  }, [value])

  useEffect(() => {
    if (rejected && !focused.current) {
      committed.current = value
      setDraft(value)
    }
  }, [rejected, value])

  // The editor closed (Done, a click outside, the card closing) while the field held typing.
  useEffect(
    () => () => {
      const pending = latest.current
      const before = committed.current

      if (pending.draft.trim() !== before.trim()) {
        committed.current = pending.draft
        pending.onSave(before, pending.draft)
      }
    },
    []
  )

  const commit = (text: string) => {
    const before = committed.current

    if (text.trim() !== before.trim()) {
      committed.current = text
      onSave(before, text)
    }
  }

  return (
    <div className={cn('flex flex-col gap-1.5', grow && 'min-h-0 flex-1')}>
      <label className="atum-card-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        className={cn('atum-input atum-card-field', grow && 'min-h-0 flex-1 resize-none')}
        data-assistant-card-field={singleLine ? undefined : label}
        data-assistant-card-personality-field={singleLine ? true : undefined}
        id={id}
        onBlur={() => {
          focused.current = false

          if (cancelled.current) {
            cancelled.current = false

            return
          }

          commit(draft)
        }}
        onChange={event => setDraft(singleLine ? event.target.value.replace(/[\r\n]+/g, ' ') : event.target.value)}
        onFocus={() => {
          focused.current = true
          cancelled.current = false
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) {
            return
          }

          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (singleLine && !event.shiftKey))) {
            event.preventDefault()
            commit(draft)
          } else if (event.key === 'Escape') {
            // One step back: the field, never the sheet.
            event.stopPropagation()
            cancelled.current = true
            committed.current = value
            setDraft(value)
            latest.current = { draft: value, onSave }
            event.currentTarget.blur()
          }
        }}
        placeholder={placeholder}
        rows={singleLine ? 1 : rows}
        value={draft}
      />
      {note}
    </div>
  )
}
