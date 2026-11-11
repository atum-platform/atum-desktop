import {
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Loader2, MessageQuestion } from '@/lib/icons'
import { cn } from '@/lib/utils'

export const letterFor = (index: number): string => String.fromCharCode(65 + index)

const OPTION_ROW_CLASS =
  'flex w-full items-start gap-2 rounded-[0.25rem] px-1.5 py-1 text-left disabled:cursor-not-allowed disabled:opacity-50'

// field-sizing on top of Textarea's shared chrome; kill min-h-16 for one-liners.
const CLARIFY_TEXTAREA_CLASS = 'field-sizing-content max-h-40 min-h-0 resize-none'

const CLARIFY_SHELL_CLASS =
  'my-1.5 rounded-md border border-primary/20 bg-(--ui-chat-surface-background) text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary)'

const CLARIFY_ICON_CLASS = 'mt-px size-4 shrink-0 text-(--ui-text-tertiary)'

export function ClarifyShell({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <ConsentBoundary><div className={cn(CLARIFY_SHELL_CLASS, className)} data-slot="clarify-inline" {...props}>
      {children}
    </div></ConsentBoundary>
  )
}

export function ClarifyLine({
  children,
  className,
  icon: Icon,
  ...props
}: ComponentProps<'div'> & { icon: typeof MessageQuestion }) {
  return (
    <ConsentBoundary><div className={cn('flex items-start gap-2', className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      <Icon aria-hidden className={CLARIFY_ICON_CLASS} />
    </div></ConsentBoundary>
  )
}

function KeyBadge({ char, preview, selected }: { char: string; preview?: boolean; selected: boolean }) {
  return (
    <ConsentBoundary><Kbd
      className={cn(
        'mt-px',
        selected && 'border-primary bg-primary text-white shadow-none',
        !selected && preview && 'border-primary text-primary shadow-none'
      )}
      size="sm"
    >
      {char}
    </Kbd></ConsentBoundary>
  )
}

/** A letter-badged option row. Shared by the live pending card (where a click
 * selects an answer) and the settled skip card (where a click drafts a
 * follow-up), so both stay visually identical. */
export function ChoiceButton({
  active = false,
  char,
  choice,
  disabled,
  keyShortcuts,
  onClick,
  selected = false,
  title
}: {
  active?: boolean
  char: string
  choice: string
  disabled?: boolean
  keyShortcuts?: string
  onClick: () => void
  selected?: boolean
  title?: string
}) {
  // `Tip` is the repo's themed replacement for native `title=` (a native
  // tooltip on a <button> is banned by the no-native-title guard). It renders
  // the child untouched when `label` is falsy, so the live card (no tip) is
  // unaffected and only the settled skip card gets the hover hint.
  //
  // `active` is the keyboard cursor on the live card (arrow-key navigation);
  // it highlights the row and previews its key badge. The settled skip card
  // never passes it, so its rows stay plain.
  return (
    <ConsentBoundary><Tip label={title}>
      <button
        aria-current={active || undefined}
        aria-keyshortcuts={keyShortcuts}
        className={cn(
          OPTION_ROW_CLASS,
          'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
          active && 'bg-(--chrome-action-hover) text-(--ui-text-primary)',
          selected && 'text-(--ui-text-primary)'
        )}
        data-choice
        data-highlighted={active || undefined}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <KeyBadge char={char} preview={active} selected={selected} />
        <span className="flex-1 wrap-anywhere">{choice}</span>
      </button>
    </Tip></ConsentBoundary>
  )
}

export interface ClarifyPromptProps {
  question: string
  choices: string[]
  ready: boolean
  onRespond: (answer: string) => Promise<void>
  onError: (error: unknown) => void
  shortcuts?: boolean
  maxLength?: number
}

/** Shared question controls, without session/gateway/composer ownership. */
export function ClarifyPrompt({
  question,
  choices,
  ready,
  onRespond,
  onError,
  shortcuts = true,
  maxLength
}: ClarifyPromptProps) {
  const { t } = useI18n()
  const copy = t.assistant.clarify
  const hasChoices = choices.length > 0

  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)
  // The keyboard cursor. Indices 0..choices.length-1 are the options; the
  // trailing index (=== choices.length) is the "Other" free-text row.
  const [activeIndex, setActiveIndex] = useState(0)
  const [otherFocused, setOtherFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Race: tool.start fires a tick before clarify.request, so request_id
  // arrives slightly after the tool block mounts. Hold the whole panel on a
  // spinner until the gateway request is wired — showing disabled choices or
  // a "loading question" stub is worse than a brief wait.
  const loading = !ready && !submitting

  const respond = useCallback(
    async (answer: string) => {
      if (!ready || submitting) {
        return
      }

      setSubmitting(true)

      try {
        await onRespond(answer)
      } catch (error) {
        onError(error)
        setSubmitting(false)
      }
    },
    [onRespond, onError, ready, submitting]
  )

  const trimmedDraft = draft.trim()
  // The answer is whichever input is active: a picked choice, or typed text.
  // Picking a choice no longer fires immediately — it selects, then the user
  // confirms with Continue (or Enter from the field).
  const pendingAnswer = selectedChoice ?? (trimmedDraft || null)

  const selectChoice = useCallback((choice: string, index: number) => {
    // Picking a choice and typing are mutually exclusive answers.
    setDraft('')
    setSelectedChoice(choice)
    setActiveIndex(index)
  }, [])

  // Keep the cursor in range when the choice set changes (never past "Other").
  useEffect(() => {
    setActiveIndex(index => Math.min(index, choices.length))
  }, [choices.length])

  const moveActive = useCallback(
    (delta: number) => {
      const itemCount = choices.length + 1

      // Arrow navigation is a move, not a pick — clear any staged answer so the
      // cursor and the selection can't disagree.
      setDraft('')
      setSelectedChoice(null)
      setActiveIndex(index => (index + delta + itemCount) % itemCount)
    },
    [choices.length]
  )

  const submitAnswer = useCallback(() => {
    if (selectedChoice !== null) {
      void respond(selectedChoice)

      return
    }

    if (trimmedDraft) {
      void respond(trimmedDraft)
    }
  }, [respond, selectedChoice, trimmedDraft])

  const activateActive = useCallback(() => {
    // A staged answer (picked choice or typed text) wins — confirm it.
    if (pendingAnswer) {
      submitAnswer()

      return
    }

    // Otherwise act on the highlighted row: a choice responds immediately, and
    // the trailing "Other" row focuses the free-text field.
    const choice = choices[activeIndex]

    if (choice) {
      void respond(choice)

      return
    }

    textareaRef.current?.focus()
  }, [activeIndex, choices, pendingAnswer, respond, submitAnswer])

  const handleTextareaKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) {
        return
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitAnswer()
      }
    },
    [submitAnswer]
  )

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitAnswer()
    },
    [submitAnswer]
  )

  // Arrow keys move a visual cursor, 1-9 and A/B/C… pick directly, and Enter
  // confirms the current answer (or acts on the highlighted row). Stands down
  // whenever a focusable control (a field, a choice button, the action bar) is
  // focused, so it never eats keystrokes meant for the composer, the Other box,
  // or a button the user tabbed to.
  useEffect(() => {
    if (!shortcuts || !ready || !hasChoices || submitting) {
      return
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) {
        return
      }

      const active = document.activeElement as HTMLElement | null

      if (
        active &&
        (active.isContentEditable || active.matches('a[href], button, input, select, textarea, [role="button"]'))
      ) {
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveActive(event.key === 'ArrowDown' ? 1 : -1)

        return
      }

      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      const key = event.key.toLowerCase()

      if (key.length === 1 && key >= 'a' && key <= 'z') {
        const index = key.charCodeAt(0) - 97

        if (index < choices.length) {
          event.preventDefault()
          selectChoice(choices[index], index)
        } else if (index === choices.length) {
          event.preventDefault()
          setActiveIndex(index)
          textareaRef.current?.focus()
        }

        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        activateActive()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateActive, choices, hasChoices, moveActive, ready, selectChoice, submitting, shortcuts])

  if (loading) {
    return (
      <ConsentBoundary><ClarifyShell
        aria-label={copy.loadingQuestion}
        className="grid min-h-12 place-items-center px-2.5 py-3"
        role="status"
      >
        <Loader2 aria-hidden className="size-4 animate-spin text-(--ui-text-tertiary)" />
      </ClarifyShell></ConsentBoundary>
    )
  }

  const onDraftChange = (value: string) => {
    setDraft(value)

    // Typing is its own answer — drop any picked choice so the two inputs can't
    // both look selected.
    if (value.trim()) {
      setSelectedChoice(null)
    }
  }

  return (
    // `data-clarify-choices` marks the panel as owning printable/Enter keys
    // while its A/B/C… shortcuts are live, so the global type-to-focus listener
    // (`composerFocusBlockedBySurface`) stands down and the letters reach this
    // card instead of being redirected into the composer.
    <ConsentBoundary><ClarifyShell className="grid gap-2 px-2.5 py-2" data-clarify-choices={hasChoices ? '' : undefined}>
      <div className="flex items-start gap-2">
        <span className="flex-1 whitespace-pre-wrap font-medium leading-(--conversation-line-height)">{question}</span>
        <MessageQuestion aria-hidden className="mt-px size-4 shrink-0 text-(--ui-text-tertiary)" />
      </div>

      <form className="grid gap-2" onSubmit={handleSubmit}>
        {hasChoices ? (
          <div className="grid gap-px" role="group">
            {choices.map((choice, index) => (
              <ChoiceButton
                active={activeIndex === index}
                char={letterFor(index)}
                choice={choice}
                disabled={submitting}
                key={`${index}-${choice}`}
                keyShortcuts={shortcuts ? `${letterFor(index)} ${index + 1}` : undefined}
                onClick={() => selectChoice(choice, index)}
                selected={selectedChoice === choice}
              />
            ))}
            <label
              className={cn(
                OPTION_ROW_CLASS,
                'items-center',
                activeIndex === choices.length && 'bg-(--chrome-action-hover)'
              )}
              data-highlighted={activeIndex === choices.length || undefined}
            >
              <KeyBadge
                char={letterFor(choices.length)}
                preview={otherFocused || activeIndex === choices.length}
                selected={Boolean(trimmedDraft)}
              />
              <Textarea
                aria-current={activeIndex === choices.length || undefined}
                aria-keyshortcuts={shortcuts ? `${letterFor(choices.length)} ${choices.length + 1}` : undefined}
                aria-label={copy.other}
                className={CLARIFY_TEXTAREA_CLASS}
                disabled={submitting}
                maxLength={maxLength}
                onBlur={() => setOtherFocused(false)}
                onChange={event => onDraftChange(event.target.value)}
                onFocus={() => {
                  setSelectedChoice(null)
                  setActiveIndex(choices.length)
                  setOtherFocused(true)
                }}
                onKeyDown={handleTextareaKey}
                placeholder={copy.other}
                ref={textareaRef}
                rows={1}
                size="sm"
                value={draft}
              />
            </label>
          </div>
        ) : (
          <Textarea
            aria-label={copy.placeholder}
            className={CLARIFY_TEXTAREA_CLASS}
            disabled={submitting}
            maxLength={maxLength}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={handleTextareaKey}
            placeholder={copy.placeholder}
            ref={textareaRef}
            rows={1}
            size="sm"
            value={draft}
          />
        )}

        <div className="flex items-center justify-end gap-1">
          <Button disabled={submitting} onClick={() => void respond('')} size="xs" type="button" variant="text">
            {copy.skip}
          </Button>
          <Button disabled={submitting || !pendingAnswer} size="xs" type="submit">
            {submitting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <>
                {copy.continueLabel}
                <span aria-hidden className="ml-0.5 text-[0.625rem] opacity-70">
                  ⏎
                </span>
              </>
            )}
          </Button>
        </div>
      </form>
    </ClarifyShell></ConsentBoundary>
  )
}
