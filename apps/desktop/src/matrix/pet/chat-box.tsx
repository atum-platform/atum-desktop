import type * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ComposerSurface } from '@/app/chat/composer/composer-surface'
import type { Locale } from '@/i18n'
import { AlertCircle, ArrowUp, MoreHorizontal, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { PetInfo } from '../../../shared/pet'
import {
  ATUM_PET_CHAT_MESSAGE_MAX,
  type AtumPetChatErrorCode,
  type AtumPetChatTurn
} from '../../../shared/pet-chat/atum-pet-chat'
import { matrixClock, matrixDayLabel, matrixNewDay } from '../message-time'
import { petCopy } from '../pet-copy'

import type { PetAction } from './menu'
import { PetFace } from './pet-face'

/** A message on its way to the pet, or one that did not get there. */
export interface PetChatPending {
  text: string
  at: string
  state: 'sending' | 'failed'
  /** Why it failed; `send` when nothing more specific is known. */
  code?: AtumPetChatErrorCode | 'send'
}

export interface PetChatBoxProps extends React.ComponentProps<'section'> {
  name: string
  locale: Locale
  sprite?: PetInfo
  /** The pet's history, then this session's answered turns the history does not hold yet. */
  turns: readonly AtumPetChatTurn[]
  pending?: PetChatPending
  /** History has not answered yet: quiet placeholders instead of the empty greeting. */
  loading?: boolean
  available: boolean
  draft: string
  onDraft(value: string): void
  onSend(): void
  onRetry(): void
  onClose(): void
  onTopUp?(): void
  /** One short line above the box when something other than a message failed (an action). */
  notice?: string
  /** The pet's own actions (wave, sit, …), behind one "…" in the header. */
  actions?: readonly PetAction[]
  inputRef?: React.Ref<HTMLTextAreaElement>
  autoFocus?: boolean
}

const FACE = 24

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function PetChatBox({
  name,
  locale,
  sprite,
  turns,
  pending,
  loading = false,
  available,
  draft,
  onDraft,
  onSend,
  onRetry,
  onClose,
  onTopUp,
  notice,
  actions,
  inputRef,
  autoFocus,
  className,
  children,
  ...props
}: PetChatBoxProps) {
  const copy = petCopy[locale]
  const thread = useRef<HTMLDivElement>(null)
  const sending = pending?.state === 'sending'
  const canSend = available && !sending && Boolean(draft.trim())
  const empty = turns.length === 0 && !pending

  // The newest line is always in view, as in any chat.
  useLayoutEffect(() => {
    const element = thread.current

    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [turns, pending])

  return (
    <section
      aria-label={copy.chatWith(name)}
      className={cn('atum-pet-chat flex flex-col overflow-hidden', className)}
      data-pet-chat
      {...props}
    >
      {children}
      <header className="flex h-11 shrink-0 items-center gap-(--ak-s2) border-b border-(--ak-line) ps-(--ak-s3) pe-(--ak-s2)">
        <PetFace size={FACE} sprite={sprite} />
        <h2 className="min-w-0 flex-1 truncate [font:var(--ak-t-headline)] text-(--ak-ink)">{name}</h2>
        {actions && actions.length > 0 && <PetChatMenu actions={actions} label={copy.actions} />}
        <button aria-label={copy.closeChat} className="ak-iconbtn ak-iconbtn--sm" onClick={onClose} type="button">
          <X aria-hidden className="ak-icon ak-icon--sm" />
        </button>
      </header>
      <div
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto px-(--ak-s3) py-(--ak-s2)"
        data-pet-thread
        ref={thread}
        role="log"
      >
        {loading && empty ? (
          <div aria-hidden className="grid gap-(--ak-s2) pt-(--ak-s2)" data-pet-chat-loading>
            <span className="ak-skeleton h-8 w-3/5 rounded-[18px]" />
            <span className="ak-skeleton ms-auto h-8 w-2/5 rounded-[18px]" />
          </div>
        ) : empty ? (
          <div
            className="grid h-full place-content-center justify-items-center gap-(--ak-s2) text-center"
            data-pet-chat-empty
          >
            <PetFace size={48} sprite={sprite} />
            <p className="[font:var(--ak-t-headline)] text-(--ak-ink)">{name}</p>
            <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)">{copy.listening(name)}</p>
          </div>
        ) : (
          <PetChatRuns locale={locale} name={name} pending={pending} sprite={sprite} turns={turns} />
        )}
        {pending?.state === 'failed' && (
          <PetChatFailure
            code={pending.code ?? 'send'}
            locale={locale}
            name={name}
            onRetry={available ? onRetry : undefined}
            onTopUp={onTopUp}
          />
        )}
      </div>
      {notice && (
        <p className="shrink-0 px-(--ak-s4) pb-(--ak-s1) [font:var(--ak-t-callout)] text-(--ak-ink-2)" role="status">
          {notice}
        </p>
      )}
      <form
        className="shrink-0 px-(--ak-s2) pb-(--ak-s2)"
        onSubmit={event => {
          event.preventDefault()

          if (canSend) {
            onSend()
          }
        }}
      >
        <div className="rounded-(--ak-r-xl)" data-matrix-kit-composer>
          <ComposerSurface
            actions={
              <button
                aria-label={copy.send}
                className="ak-iconbtn ak-iconbtn--sm ak-iconbtn--primary disabled:opacity-30"
                disabled={!canSend}
                type="submit"
              >
                <ArrowUp aria-hidden className="size-4" />
              </button>
            }
            input={
              <PetChatInput
                aria-label={copy.chatInput(name)}
                autoFocus={autoFocus}
                disabled={!available}
                onChange={event => onDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={copy.chatInput(name)}
                ref={inputRef}
                value={draft}
              />
            }
          />
        </div>
      </form>
    </section>
  )
}

/** Turns grouped into runs by sender, with a day label where the day changes. */
function PetChatRuns({
  turns,
  pending,
  name,
  locale,
  sprite
}: {
  turns: readonly AtumPetChatTurn[]
  pending?: PetChatPending
  name: string
  locale: Locale
  sprite?: PetInfo
}) {
  const copy = petCopy[locale]
  const lines = pending ? [...turns, { role: 'user' as const, text: pending.text, at: pending.at }] : [...turns]
  const runs: { role: AtumPetChatTurn['role']; turns: AtumPetChatTurn[]; day?: string }[] = []
  let previous: number | undefined

  for (const turn of lines) {
    const at = Date.parse(turn.at)
    const newDay = Number.isFinite(at) && matrixNewDay(previous, at)
    const last = runs.at(-1)

    if (!last || last.role !== turn.role || newDay) {
      runs.push({ role: turn.role, turns: [turn], day: newDay ? matrixDayLabel(at, locale) : undefined })
    } else {
      last.turns.push(turn)
    }

    if (Number.isFinite(at)) {
      previous = at
    }
  }

  return (
    <div className="grid gap-(--ak-s3)">
      {runs.map((run, index) => {
        const own = run.role === 'user'
        const at = Date.parse(run.turns.at(-1)!.at)
        // The message on its way, or one that failed, carries no time of its own.
        const unsent = Boolean(pending) && index === runs.length - 1 && own

        return (
          <div className="grid gap-(--ak-s3)" key={`${run.turns[0]!.at}:${index}`}>
            {run.day && (
              <p className="text-center [font:var(--ak-t-caption)] text-(--ak-ink-3)" data-pet-chat-day>
                {run.day}
              </p>
            )}
            <div className={cn('flex items-start gap-(--ak-s2)', own && 'justify-end')} data-pet-run={run.role}>
              {!own && <PetFace className="mt-0.5" size={FACE} sprite={sprite} />}
              <div className={cn('grid max-w-[78%] gap-(--ak-s1)', own ? 'justify-items-end' : 'justify-items-start')}>
                {run.turns.map((turn, line) => (
                  <p
                    className={cn(
                      'whitespace-pre-wrap break-words',
                      own ? 'composer-human-message' : 'matrix-chat-bubble'
                    )}
                    data-pet-turn={turn.role}
                    key={`${turn.at}:${line}`}
                  >
                    {turn.text}
                  </p>
                ))}
                {!unsent && Number.isFinite(at) && (
                  <time
                    className="px-(--ak-s1) [font:var(--ak-t-caption)] text-(--ak-ink-3)"
                    dateTime={new Date(at).toISOString()}
                  >
                    {matrixClock(at, locale)}
                  </time>
                )}
              </div>
            </div>
          </div>
        )
      })}
      {pending?.state === 'sending' && (
        <div
          aria-label={copy.thinking(name)}
          className="flex items-start gap-(--ak-s2)"
          data-pet-thinking
          role="status"
        >
          <PetFace className="mt-0.5" size={FACE} sprite={sprite} />
          <span className="matrix-chat-bubble matrix-chat-bubble-small">
            <span aria-hidden className="atum-pet-chat-dots">
              <span />
              <span />
              <span />
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

/** Under the message that did not get there: why, in a few words, and the one next step. */
function PetChatFailure({
  code,
  locale,
  name,
  onRetry,
  onTopUp
}: {
  code: AtumPetChatErrorCode | 'send'
  locale: Locale
  name: string
  onRetry?(): void
  onTopUp?(): void
}) {
  const copy = petCopy[locale]
  const protons = code === 'insufficient_protons'
  const missing = code === 'not_found'

  const line = protons
    ? copy.noProtons
    : code === 'rate_limited' || code === 'temporarily_unavailable'
      ? copy.busy(name)
      : missing
        ? copy.missingPet
        : copy.notSent

  return (
    <div
      className="mt-(--ak-s1) flex flex-wrap items-center justify-end gap-x-(--ak-s2) gap-y-(--ak-s1)"
      data-pet-chat-failure={code}
    >
      <AlertCircle aria-hidden className="ak-icon ak-icon--sm shrink-0 text-(--ak-danger)" />
      <p className="[font:var(--ak-t-callout)] text-(--ak-ink-2)" role="alert">
        {line}
      </p>
      {protons && onTopUp ? (
        <button className="ak-btn ak-btn--sm" onClick={onTopUp} type="button">
          {copy.topUp}
        </button>
      ) : (
        !missing &&
        !protons &&
        onRetry && (
          <button className="ak-btn ak-btn--sm" onClick={onRetry} type="button">
            {copy.tryAgain}
          </button>
        )
      )}
    </div>
  )
}

/** The box's text: grows with what you write, up to a few lines, then scrolls. */
function PetChatInput({ ref, value, ...props }: React.ComponentProps<'textarea'>) {
  const own = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const element = own.current

    if (element) {
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 96)}px`
    }
  }, [value])

  return (
    <textarea
      className="block max-h-24 min-h-[1.625rem] w-full resize-none bg-transparent px-1 py-0.5 [font:var(--ak-t-chat)] text-(--ak-ink) outline-none placeholder:text-(--ak-ink-3) disabled:opacity-50"
      data-pet-chat-input
      maxLength={ATUM_PET_CHAT_MESSAGE_MAX}
      ref={element => {
        own.current = element

        if (typeof ref === 'function') {
          ref(element)
        } else if (ref) {
          ref.current = element
        }
      }}
      rows={1}
      value={value}
      {...props}
    />
  )
}

/** The pet's own actions, behind one "…": drawn inside the box, so the popped-out window, which
 * has no shell palette outside the box, still paints it. */
function PetChatMenu({ actions, label }: { actions: readonly PetAction[]; label: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    window.document.addEventListener('pointerdown', away)

    return () => window.document.removeEventListener('pointerdown', away)
  }, [open])

  return (
    <div
      className="relative"
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
      }}
      ref={root}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="ak-iconbtn ak-iconbtn--sm"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <MoreHorizontal aria-hidden className="ak-icon ak-icon--sm" />
      </button>
      {open && (
        <div
          aria-label={label}
          className="atum-pet-glass ak-menu absolute end-0 top-full z-10 mt-(--ak-s1) min-w-44"
          data-pet-chat-menu
          role="menu"
        >
          {actions.map(action => (
            <button
              className="ak-menu-item w-full text-start disabled:opacity-40"
              disabled={action.disabled}
              key={action.id}
              onClick={() => {
                setOpen(false)
                action.run()
              }}
              role="menuitem"
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
