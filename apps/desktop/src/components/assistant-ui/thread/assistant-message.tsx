import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  useMessageRuntime
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useOpenStorefront } from '@/app/atum/use-open-storefront'
import { useSessionView } from '@/app/chat/session-view'
import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { SETTINGS_ROUTE } from '@/app/routes'
import {
  contentHasVisibleText,
  messageContentText,
  pickPrimaryPreviewTarget
} from '@/components/assistant-ui/thread/content'
import { MESSAGE_PARTS_COMPONENTS } from '@/components/assistant-ui/thread/message-parts'
import { ResponseLoadingIndicator, StreamStallIndicator } from '@/components/assistant-ui/thread/status'
import { formatMessageTimestamp } from '@/components/assistant-ui/thread/timestamp'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { type ManagedModelFailure, managedModelFailureCopy } from '@/lib/atum-managed-model-failure'
import { reportProductEvent } from '@/lib/atum-reporting'
import { triggerHaptic } from '@/lib/haptics'
import { ThumbsDown, ThumbsUp } from '@/lib/icons'
import { AudioLines, GitForkIcon, Loader2Icon, RefreshCwIcon, VolumeXIcon, XIcon } from '@/lib/icons'
import { extractPreviewTargets } from '@/lib/preview-targets'
import { formatAgo } from '@/lib/time'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { playSpeechText, stopVoicePlayback } from '@/lib/voice-playback'
import { refreshManagedModelAccess } from '@/store/atum-managed-model'
import { signInToAtum } from '@/store/atum-messaging'
import { notifyError } from '@/store/notifications'
import { $voicePlayback } from '@/store/voice-playback'

interface MessageActionProps {
  messageId: string
  errored?: boolean
  /** Lazy accessor — reads the live message text at action time. Passing the
   *  text itself as a prop forces the whole footer to re-render on every
   *  streaming delta flush (the text changes ~30×/s), which profiling showed
   *  was a large slice of per-token script time on long transcripts. */
  getMessageText: () => string
  onBranchInNewChat?: (messageId: string) => void
  managedFailure?: ManagedModelFailure
}

export const AssistantMessage: FC<{
  onBranchInNewChat?: (messageId: string) => void
  onDismissError?: (messageId: string) => void
}> = ({ onBranchInNewChat, onDismissError }) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRuntime = useMessageRuntime()
  const { t } = useI18n()

  // PERF: this component must NOT subscribe to the streaming text. Every
  // selector here returns a value that stays referentially stable across
  // token flushes (booleans, status strings, '' while running), so the
  // 30 Hz delta stream only re-renders the markdown part and the tiny
  // StreamStallIndicator leaf — not the footer/preview/root subtree.
  const messageStatus = useAuiState(s => s.message.status?.type)
  const isRunning = messageStatus === 'running'
  const isErrored = useAuiState(s => s.message.status?.type === 'incomplete' && s.message.status.reason === 'error')
  const isPlaceholder = useAuiState(s => s.message.status?.type === 'running' && s.message.content.length === 0)
  const hasVisibleText = useAuiState(s => contentHasVisibleText(s.message.content))
  // Sealed mid-turn commentary keeps its text but not the footer, so a
  // tool-heavy turn doesn't grow a copy/refresh bar per paragraph (see
  // ChatMessage.interim).
  const isInterim = useAuiState(s => s.message.metadata?.custom?.interim === true)
  const managedFailure = useAuiState(s => s.message.metadata?.custom?.managedFailure as ManagedModelFailure | undefined)

  // Preview targets only materialize once the turn completes — while running
  // the selector returns '' (stable), so per-token flushes skip the regex
  // scan and the re-render it would cause.
  const completedText = useAuiState(s =>
    s.message.status?.type === 'running' ? '' : messageContentText(s.message.content)
  )

  const previewTargets = useMemo(() => {
    if (!completedText || !/(https?:\/\/|file:\/\/)/i.test(completedText)) {
      return []
    }

    return pickPrimaryPreviewTarget(extractPreviewTargets(completedText))
  }, [completedText])

  const getMessageText = useCallback(() => messageContentText(messageRuntime.getState().content), [messageRuntime])

  const enterRef = useEnterAnimation(isRunning, `assistant-message:${messageId}`)

  return (
    <MessagePrimitive.Root
      aria-busy={isRunning || undefined}
      className="group flex w-full min-w-0 max-w-full flex-col gap-0 self-start overflow-hidden"
      data-role="assistant"
      data-slot="aui_assistant-message-root"
      data-streaming={isRunning ? 'true' : undefined}
      ref={enterRef}
    >
      <div
        className="wrap-anywhere min-w-0 max-w-full overflow-hidden text-pretty text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground"
        data-slot="aui_assistant-message-content"
      >
        {/* Todos render in the composer status stack now, not inline. */}
        <MessagePrimitive.Parts components={MESSAGE_PARTS_COMPONENTS} />
        {isPlaceholder ? <ResponseLoadingIndicator /> : isRunning && <StreamStallIndicator />}
        {previewTargets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {previewTargets.map(target => (
              <PreviewAttachment key={target} source="explicit-link" target={target} />
            ))}
          </div>
        )}
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root
            className="mt-1.5 flex items-start gap-1.5 text-[0.78rem] leading-5 text-[color-mix(in_srgb,var(--dt-destructive)_78%,var(--ui-text-secondary))]"
            role="alert"
          >
            <div className="min-w-0 flex-1">
              <p>{t.errors.turnFailed ?? t.errors.genericFailure}</p>
              <ErrorPrimitive.Message className="block text-[0.7rem] text-(--ui-text-tertiary)" />
            </div>
            {onDismissError && (
              <TooltipIconButton
                className="-my-0.5 shrink-0 text-current opacity-70 hover:opacity-100"
                onClick={() => onDismissError(messageId)}
                side="top"
                tooltip={t.assistant.thread.dismissError}
              >
                <XIcon className="size-3.5" />
              </TooltipIconButton>
            )}
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      {(hasVisibleText || isErrored) && !isInterim && (
        <AssistantFooter
          errored={isErrored}
          getMessageText={getMessageText}
          managedFailure={managedFailure}
          messageId={messageId}
          onBranchInNewChat={onBranchInNewChat}
        />
      )}
    </MessagePrimitive.Root>
  )
}

const AssistantActionBar: FC<MessageActionProps> = ({
  errored = false,
  messageId,
  getMessageText,
  onBranchInNewChat,
  managedFailure
}) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const [rating, setRating] = useState<string | null>(null)

  return (
    <div className="relative flex w-full shrink-0 justify-end">
      <ActionBarPrimitive.Root
        className={cn(
          // NOTE: intentionally NOT `hideWhenRunning`. That prop unmounts the
          // bar while the thread streams, which collapses every completed
          // assistant message's footer by this bar's height and shifts the
          // whole conversation when the turn resolves. The bar is already
          // invisible by default (opacity-0 + pointer-events-none, reveals on
          // hover), so keeping it mounted reserves stable layout height with
          // no visual change during streaming.
          'relative flex flex-row items-center justify-end gap-1.5 py-1.5 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
          errored && 'pointer-events-auto opacity-100'
        )}
        data-slot="aui_msg-actions"
      >
        <MessageAge />
        {(['helpful', 'notHelpful'] as const).map(kind => (
          <TooltipIconButton
            disabled={rating !== null}
            key={kind}
            onClick={() => {
              setRating(kind)
              reportProductEvent('feedback_submitted', { kind: kind === 'helpful' ? 'helpful' : 'not_helpful' })
            }}
            tooltip={t.settings.reporting[kind]}
          >
            {kind === 'helpful' ? <ThumbsUp className="size-3.5" /> : <ThumbsDown className="size-3.5" />}
          </TooltipIconButton>
        ))}
        <TooltipIconButton
          onClick={() => {
            triggerHaptic('selection')
            onBranchInNewChat?.(messageId)
          }}
          tooltip={copy.branchNewChat}
        >
          <GitForkIcon className="size-3.5" />
        </TooltipIconButton>
        <CopyButton appearance="icon" buttonSize="icon" label={copy.copy} text={getMessageText} />
        <ReadAloudButton getText={getMessageText} messageId={messageId} />
        {managedFailure ? (
          <ManagedFailureAction failure={managedFailure} messageId={messageId} />
        ) : (
          <ActionBarPrimitive.Reload asChild>
            <TooltipIconButton
              onClick={() => triggerHaptic('submit')}
              tooltip={errored ? (t.assistant.retry ?? copy.refresh) : copy.refresh}
            >
              <RefreshCwIcon className="size-3.5" />
            </TooltipIconButton>
          </ActionBarPrimitive.Reload>
        )}
      </ActionBarPrimitive.Root>
    </div>
  )
}

const ManagedFailureAction: FC<{ failure: ManagedModelFailure; messageId: string }> = ({ failure, messageId }) => {
  const messageRuntime = useMessageRuntime()
  const navigate = useNavigate()
  const openStorefront = useOpenStorefront()
  const view = useSessionView()
  const messages = useStore(view.$messages)
  const busy = useStore(view.$busy)
  const lastMessageId = messages.filter(message => !message.hidden).at(-1)?.id
  const { requestGateway } = useGatewayRequest()
  const { t } = useI18n()
  const [cancelled, setCancelled] = useState(false)
  const runningRef = useRef(false)
  const [running, setRunning] = useState(false)
  const copy = managedModelFailureCopy(failure)

  const recover = useCallback(async () => {
    if (runningRef.current) {
      return
    }

    runningRef.current = true
    setRunning(true)

    try {
      const focusDraft = () => document.querySelector<HTMLElement>('[data-slot="composer-rich-input"]')?.focus()

      if (failure.recovery === 'pause') {
        const sessionId = view.$runtimeId.get()

        if (
          !sessionId ||
          view.kind !== 'primary' ||
          view.$busy.get() ||
          view.$messages
            .get()
            .filter(message => !message.hidden)
            .at(-1)?.id !== messageId
        ) {
          return
        }

        let result: { state: string }

        try {
          result = await requestGateway<{ state: string }>('prompt.managed_cancel', { session_id: sessionId })
        } catch {
          throw new Error(t.atum.managedModel.cancelFailed)
        }

        if (result.state !== 'cancelled') {
          throw new Error(t.atum.managedModel.cancelFailed)
        }
        setCancelled(true)
        focusDraft()
      } else if (failure.recovery === 'reauthenticate') {
        await signInToAtum()
        await refreshManagedModelAccess(failure.access_alias)

        if (failure.preserve_draft) {
          focusDraft()
        } else {
          await messageRuntime.reload()
        }
      } else if (failure.recovery === 'retry' || failure.recovery === 'wait_for_turn') {
        if (failure.preserve_draft) {
          focusDraft()
        } else {
          await messageRuntime.reload()
        }
      } else if (failure.recovery === 'review_hiring') {
        openStorefront('agents')
      } else if (failure.recovery === 'review_training') {
        openStorefront('skills')
      } else if (failure.recovery === 'review_account') {
        navigate(`${SETTINGS_ROUTE}?tab=atum:account`)
      } else if (failure.recovery === 'review_access') {
        navigate(`${SETTINGS_ROUTE}?tab=atum:protons`)
        await refreshManagedModelAccess(failure.access_alias)

        if (failure.preserve_draft) {
          focusDraft()
        }
      } else if (failure.recovery === 'repair') {
        await window.hermesDesktop?.repairBootstrap()

        if (failure.preserve_draft) {
          focusDraft()
        }
      } else {
        focusDraft()
      }
    } catch (error) {
      notifyError(error, `Couldn't ${copy.action.toLowerCase()}`)
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [
    copy.action,
    failure,
    messageId,
    messageRuntime,
    navigate,
    openStorefront,
    requestGateway,
    t.atum.managedModel.cancelFailed,
    view
  ])

  if (
    cancelled ||
    (failure.recovery === 'pause' &&
      (failure.code === 'managed_request_cancelled' || view.kind !== 'primary' || busy || lastMessageId !== messageId))
  ) {
    return null
  }

  return (
    <TooltipIconButton
      disabled={running}
      onClick={() => void recover()}
      tooltip={failure.recovery === 'pause' ? t.atum.managedModel.stopTask : copy.action}
    >
      {failure.recovery === 'pause' ? (
        <XIcon className="size-3.5" />
      ) : (
        <RefreshCwIcon className={cn('size-3.5', running && 'animate-spin')} />
      )}
    </TooltipIconButton>
  )
}

const ReadAloudButton: FC<{ getText: () => string; messageId: string }> = ({ getText, messageId }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const voicePlayback = useStore($voicePlayback)

  const readAloudStatus =
    voicePlayback.source === 'read-aloud' && voicePlayback.messageId === messageId ? voicePlayback.status : 'idle'

  const isPreparing = readAloudStatus === 'preparing'
  const isSpeaking = readAloudStatus === 'speaking'
  const anyPlaybackActive = voicePlayback.status !== 'idle'
  const Icon = isPreparing ? Loader2Icon : isSpeaking ? VolumeXIcon : AudioLines
  const tooltip = isPreparing ? copy.preparingAudio : isSpeaking ? copy.stopReading : copy.readAloud

  const read = useCallback(async () => {
    const text = getText()

    if (!text || $voicePlayback.get().status !== 'idle') {
      return
    }

    try {
      await playSpeechText(text, { messageId, source: 'read-aloud' })
    } catch (error) {
      notifyError(error, copy.readAloudFailed)
    }
  }, [copy.readAloudFailed, getText, messageId])

  return (
    <TooltipIconButton
      disabled={isPreparing || (!isSpeaking && anyPlaybackActive)}
      onClick={() => {
        triggerHaptic('selection')
        void (isSpeaking ? stopVoicePlayback() : read())
      }}
      tooltip={tooltip}
    >
      <Icon className={cn('size-3.5', isPreparing && 'animate-spin')} />
    </TooltipIconButton>
  )
}

const MessageAge: FC = () => {
  const { t } = useI18n()
  const createdAt = useAuiState(s => s.message.createdAt)
  const date = createdAt ? new Date(createdAt) : null

  if (!date || Number.isNaN(date.getTime())) {
    return null
  }

  // Compact "2h ago" (shared util) with the absolute time on hover.
  return (
    <span
      className="px-0.5 text-[0.6875rem] tabular-nums text-muted-foreground"
      title={formatMessageTimestamp(date, t.assistant.thread) || undefined}
    >
      {formatAgo(date.getTime(), t.agents)}
    </span>
  )
}

const AssistantFooter: FC<MessageActionProps> = props => (
  <div className="flex min-h-6 flex-col items-end gap-1 pr-(--message-text-indent) pl-(--message-text-indent)">
    <BranchPickerPrimitive.Root
      className="inline-flex h-6 items-center gap-1 text-xs text-muted-foreground"
      hideWhenSingleBranch
    >
      <BranchPickerPrimitive.Previous className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35">
        <Codicon name="chevron-left" size="0.875rem" />
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-35">
        <Codicon name="chevron-right" size="0.875rem" />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
    <AssistantActionBar {...props} />
  </div>
)
