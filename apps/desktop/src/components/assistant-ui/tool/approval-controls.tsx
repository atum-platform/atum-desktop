import { type FC, useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { type ApprovalChoice, approvalChoicesFor, primaryApprovalChoice } from '@/lib/approval-response'
import { ChevronDown, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

/** Transport-free shared presentation. The adapter owns response authority. */
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

export interface ApprovalControlsProps {
  request: { command: string; choices?: string[]; allowPermanent?: boolean; smartDenied?: boolean }
  surface: 'floating' | 'inline'
  onRespond: (choice: ApprovalChoice) => Promise<void>
  onError: (error: unknown) => void
  autoFocus?: boolean
  shortcuts?: boolean
  /** Plainer words for the two decisions on a surface whose people are not asked to read tools
   * (the Matrix prompt card: "Allow" / "Not now"). Absent, the tool wording stays. */
  labels?: { allow?: string; deny?: string }
}

export const ApprovalControls: FC<ApprovalControlsProps> = ({
  request,
  surface,
  onRespond,
  onError,
  autoFocus = true,
  labels,
  shortcuts = true
}) => {
  const { t } = useI18n()
  const copy = t.assistant.approval
  const toolCopy = t.assistant.tool
  const [submitting, setSubmitting] = useState<ApprovalChoice | null>(null)
  // The pending tool row only shows a single truncated line of the command, and
  // a pending row can't be expanded (no result yet), so let the user reveal the
  // full command inline before deciding.
  const [showCommand, setShowCommand] = useState(false)
  const busy = submitting !== null
  // Permission is asked once and remembered: "Always allow" is the primary
  // action (main button, ⌘⏎, OS notification) whenever the backend permits a
  // durable allow. The gateway's choice list stays authoritative — a Smart
  // DENY override or a Tirith warning (allow_permanent: false) keeps "Allow
  // once" primary and never sends "always".
  const choices = approvalChoicesFor(request)
  // `null` when the backend declared no affirmative choice: only Deny renders.
  const primary = primaryApprovalChoice(request)

  // Every other declared approval goes in the options menu, narrowest last.
  const secondaryChoices = (['once', 'session'] as const).filter(
    choice => choice !== primary && choices.includes(choice)
  )

  const hasMoreOptions = secondaryChoices.length > 0
  const hasCommand = request.command.trim().length > 0
  const rootRef = useRef<HTMLDivElement | null>(null)

  const labelFor = (choice: ApprovalChoice): string => {
    switch (choice) {
      case 'always':
        return toolCopy.approveAlways ?? copy.alwaysAllow

      case 'session':
        return toolCopy.approveSession ?? copy.allowSession

      case 'deny':
        return labels?.deny ?? toolCopy.deny ?? copy.reject

      default:
        return labels?.allow ?? toolCopy.approveOnce ?? copy.run
    }
  }

  useEffect(() => {
    if (!autoFocus || surface !== 'inline') {
      return
    }

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusId = requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })

    return () => {
      cancelAnimationFrame(focusId)

      if (previous?.isConnected) {
        previous.focus()
      }
    }
  }, [surface, autoFocus])

  const respond = useCallback(
    async (choice: ApprovalChoice) => {
      if (busy) {
        return
      }

      setSubmitting(choice)

      try {
        await onRespond(choice)
      } catch (error) {
        onError(error)
        setSubmitting(null)
      }
    },
    [busy, onRespond, onError]
  )

  // ⌘/Ctrl+Enter → the primary choice, Esc → Deny.
  useEffect(() => {
    if (!shortcuts) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()

        if (primary) {
          void respond(primary)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void respond('deny')
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [primary, respond, shortcuts])

  return (
    <ConsentBoundary><div
      aria-label={toolCopy.approvalTitle ?? copy.jumpToApproval}
      className={cn(surface === 'inline' ? 'mt-1 ps-5' : 'mt-2')}
      data-primary-choice={primary ?? 'none'}
      data-slot={surface === 'inline' ? 'tool-approval-inline' : 'tool-approval-actions'}
      ref={rootRef}
      role="alertdialog"
    >
      <div className="flex items-center gap-2.5">
        {primary && (
          <div className="inline-flex items-stretch rounded-md border border-primary/25 bg-primary/10 text-primary">
            <Button
              className="gap-1 rounded-none px-2 text-xs font-medium text-primary hover:bg-primary/15 hover:text-primary"
              disabled={busy}
              onClick={() => void respond(primary)}
              size="xs"
              variant="ghost"
            >
              {submitting === primary ? <Loader2 className="size-3 animate-spin" /> : labelFor(primary)}
              {shortcuts && submitting !== primary && (
                <span className="text-[0.625rem] text-primary/60">{isMac ? '⌘⏎' : 'Ctrl⏎'}</span>
              )}
            </Button>
            {hasMoreOptions && <span aria-hidden className="w-px self-stretch bg-primary/20" />}
            {hasMoreOptions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={copy.moreOptions}
                    className="h-full w-5 rounded-none px-0 text-primary hover:bg-primary/15 hover:text-primary"
                    disabled={busy}
                    size="xs"
                    variant="ghost"
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-44">
                  {secondaryChoices.map(choice => (
                    <DropdownMenuItem key={choice} onSelect={() => void respond(choice)}>
                      {labelFor(choice)}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onSelect={() => void respond('deny')} variant="destructive">
                    {labelFor('deny')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        <Button
          className="h-6 gap-1.5 rounded-md px-1.5 text-xs font-normal text-(--ui-text-tertiary) hover:text-foreground"
          disabled={busy}
          onClick={() => void respond('deny')}
          size="xs"
          variant="ghost"
        >
          {submitting === 'deny' ? <Loader2 className="size-3 animate-spin" /> : labelFor('deny')}
          {shortcuts && submitting !== 'deny' && <span className="text-[0.625rem] opacity-55">Esc</span>}
        </Button>

        {hasCommand && (
          <Button
            aria-expanded={showCommand}
            className="h-6 gap-1 rounded-md px-1.5 text-xs font-normal text-(--ui-text-tertiary) hover:text-foreground"
            onClick={() => setShowCommand(value => !value)}
            size="xs"
            variant="ghost"
          >
            {copy.command}
            <ChevronDown className={cn('size-3 transition-transform', showCommand && 'rotate-180')} />
          </Button>
        )}
      </div>

      {showCommand && hasCommand && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-2.5 py-1.5 font-mono text-xs leading-snug text-foreground">
          {request.command.trim()}
        </pre>
      )}
    </div></ConsentBoundary>
  )
}
