import type { ReactNode } from 'react'

import { MarkdownTextContent, PEER_MARKDOWN_HOST } from '@/components/assistant-ui/markdown-text'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { AtumMessagingMessage } from '@/lib/atum-messaging-client'
import { AlertCircle, AlertTriangle, Clock, ShieldLock } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { setAtumDmConversationPreviewTarget } from '@/store/atum-dm-workspace'

import { AtumAssistantAvatar } from '../atum/assistant-avatar'

import { isSpecialistPending, parseDmMetadata, type ProviderMemoryReceipt, type SpecialistDispatch } from './dm-metadata'
import { DmArtifactCard, DmResourceCard } from './dm-resource-card'
import { parseDmResources } from './dm-resources'

interface DmMessageBubbleProps {
  message: AtumMessagingMessage
  own: boolean
  retryLabel: string
  onRetry: (clientMessageId: string) => void
  onReply?: (message: AtumMessagingMessage) => void
  onReact?: (messageId: string, emoji: string) => void
  onEdit?: (messageId: string, content: string) => void
  onRecall?: (messageId: string) => void
  onReport?: (messageId: string) => void
  onQuote?: (message: AtumMessagingMessage) => void
  quoteEnabled?: boolean
  quoteLimit?: number
  immutable?: boolean
  replySource?: AtumMessagingMessage | null
  senderLabel?: ReactNode
  read?: boolean
  onJumpToMessage?: (messageId: string) => void
}

const REACTION_SET = ['❤️', '👍', '😂', '😮', '😢'] as const

/**
 * The transcript renderer paints its own container with `text-foreground` and
 * Tailwind Typography's `prose` colours, both of which resolve to ink. An own
 * bubble sits on ink, so every prose colour channel is pointed back at the
 * card tone here; otherwise the sender's words vanish into the bubble.
 */
const OWN_MARKDOWN_CLASS = [
  'text-(--atum-card)',
  'prose-headings:text-(--atum-card) prose-strong:text-(--atum-card) prose-a:text-(--atum-card) prose-code:text-(--atum-card)',
  'prose-li:marker:text-(--atum-card)/70',
  '[--tw-prose-body:var(--atum-card)] [--tw-prose-headings:var(--atum-card)] [--tw-prose-bold:var(--atum-card)] [--tw-prose-links:var(--atum-card)]',
  '[--tw-prose-bullets:var(--atum-card)] [--tw-prose-counters:var(--atum-card)] [--tw-prose-code:var(--atum-card)] [--tw-prose-quotes:var(--atum-card)]',
  '[--tw-prose-quote-borders:var(--atum-card)] [--tw-prose-hr:var(--atum-card)] [--tw-prose-th-borders:var(--atum-card)] [--tw-prose-td-borders:var(--atum-card)]'
].join(' ')

function reactionRows(value: unknown[]): Array<{ emoji: string; count: number }> {
  const counts = new Map<string, number>()

  for (const item of value) {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const emoji = typeof item === 'string' ? item : typeof row?.emoji === 'string' ? row.emoji : null

    if (emoji && REACTION_SET.includes(emoji as (typeof REACTION_SET)[number])) {
      counts.set(emoji, typeof row?.count === 'number' ? row.count : (counts.get(emoji) ?? 0) + 1)
    }
  }

  return [...counts].map(([emoji, count]) => ({ emoji, count }))
}

export function DmMessageBubble({
  immutable = false,
  message,
  onEdit,
  onJumpToMessage,
  onReact,
  onRecall,
  onReply,
  onReport,
  onQuote,
  onRetry,
  own,
  quoteEnabled = false,
  quoteLimit = 0,
  read,
  replySource,
  retryLabel,
  senderLabel
}: DmMessageBubbleProps) {
  const { t } = useI18n()
  // `failed_terminal` is the engine's own state name (MutationState). An earlier
  // spelling here, `failed_permanent`, existed nowhere else in the codebase, so a
  // terminally failed message matched no branch and rendered as delivered.
  const failed = message.delivery === 'failed_retryable' || message.delivery === 'failed_terminal'
  const pending = message.delivery === 'queued' || message.delivery === 'sending'
  const conflicted = message.delivery === 'conflicted'

  // Attachments and metadata are both optional and both server-controlled, so
  // each is normalized behind a parser that drops anything malformed. A bubble
  // with neither renders exactly as it always has.
  const resources = parseDmResources(message.attachments)
  const metadata = parseDmMetadata(message.metadata, message.sender)
  const dispatch = metadata?.specialistDispatch ?? null
  const mentionDispatch = metadata?.mentionDispatch ?? null
  const targetDispatches = metadata?.targetDispatches ?? []
  const assistantIdentity = metadata?.assistantIdentity ?? null
  const recalled = Boolean(message.recalledAt)
  const reactions = reactionRows(message.reactions)
  const images = resources.filter(resource => resource.kind === 'image')
  const canQuote = Boolean(quoteEnabled && message.id && !recalled && [...message.content].length <= (quoteLimit ?? 0))

  return (
    <div
      className={cn('group flex py-1.5', own ? 'justify-end' : 'justify-start')}
      id={message.id ? `dm-message-${message.id}` : undefined}
    >
      <div className="flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {!immutable && (
          <>
            <Button aria-label={t.dm.reply} onClick={() => onReply?.(message)} size="icon" variant="ghost">
              ↩
            </Button>
            {message.id && (
              <details className="relative">
                <summary
                  aria-label={t.dm.reactions}
                  className="grid size-8 cursor-pointer list-none place-items-center rounded-md hover:bg-(--atum-hover)"
                >
                  ♡
                </summary>
                <div className="absolute bottom-full z-20 flex rounded-full border bg-(--atum-card) p-1 shadow-lg">
                  {REACTION_SET.map(emoji => (
                    <button className="size-8" key={emoji} onClick={() => onReact?.(message.id!, emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              </details>
            )}
            {own && message.id && !recalled && (
              <details className="relative">
                <summary className="grid size-8 cursor-pointer list-none place-items-center rounded-md hover:bg-(--atum-hover)">
                  ⋯
                </summary>
                <div className="absolute bottom-full z-20 min-w-28 rounded-lg border bg-(--atum-card) p-1 shadow-lg">
                  <button
                    className="block w-full px-2 py-1 text-left text-xs"
                    onClick={() => {
                      const content = window.prompt(t.dm.edit, message.content)

                      if (content?.trim()) {
                        onEdit?.(message.id!, content)
                      }
                    }}
                  >
                    {t.dm.edit}
                  </button>
                  <button
                    className="block w-full px-2 py-1 text-left text-xs text-destructive"
                    onClick={() => onRecall?.(message.id!)}
                  >
                    {t.dm.recall}
                  </button>
                </div>
              </details>
            )}
          </>
        )}
        {message.id && onReport && (
          <Button
            aria-label={t.dm.group.reportAction}
            onClick={() => onReport(message.id!)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t.dm.group.reportAction}
          </Button>
        )}
        {canQuote && (
          <Button
            aria-label={t.dm.group.quoteAction}
            onClick={() => onQuote?.(message)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t.dm.group.quoteAction}
          </Button>
        )}
      </div>
      <div
        className={cn(
          'max-w-[min(36rem,78%)] rounded-[17px] px-3.5 py-2 text-(length:--atum-t-ui) leading-(--atum-lh-ui) shadow-xs',
          own
            ? 'rounded-br-[6px] bg-(--atum-ink) text-(--atum-card)'
            : 'rounded-bl-[6px] border border-(--atum-line) bg-(--atum-card) text-(--atum-ink)',
          failed && 'opacity-75 ring-1 ring-destructive/50',
          conflicted && 'ring-1 ring-amber-500/70'
        )}
      >
        {!senderLabel &&
          assistantIdentity &&
          message.sender.type === 'assistant' &&
          assistantIdentity.id === message.sender.id && (
            <div className="mb-1 flex items-center gap-1.5 text-(length:--atum-t-caption) leading-(--atum-lh-caption) opacity-75">
              <AtumAssistantAvatar
                avatarUrl={assistantIdentity.avatarUrl}
                className="size-5 shrink-0 rounded-full"
                id={assistantIdentity.id}
                name={assistantIdentity.displayName}
              />
              <span>{assistantIdentity.displayName}</span>
            </div>
          )}
        {senderLabel && (
          <p
            className="mb-1 truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) font-medium opacity-75"
            data-dm-group-sender
          >
            {senderLabel}
          </p>
        )}
        {message.replyToMessageId && (
          <button
            className="mb-1 block w-full truncate rounded border-l-2 border-current/40 bg-black/5 px-2 py-1 text-left text-(length:--atum-t-caption) leading-(--atum-lh-caption) opacity-75"
            onClick={() =>
              onJumpToMessage
                ? onJumpToMessage(message.replyToMessageId!)
                : document
                    .getElementById(`dm-message-${message.replyToMessageId}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          >
            {replySource?.content || t.dm.reply}
          </button>
        )}
        {recalled ? (
          <p className="italic opacity-70">{t.dm.recalled}</p>
        ) : (
          message.content && (
            <MarkdownTextContent
              containerClassName={cn('wrap-break-word', own && OWN_MARKDOWN_CLASS)}
              containerProps={{ 'data-dm-markdown': '', 'data-dm-own': own ? '' : undefined } as never}
              {...(own ? {} : { host: PEER_MARKDOWN_HOST })}
              isRunning={false}
              text={message.content}
            />
          )
        )}
        {!recalled &&
          images.map(resource => (
            <button
              className="my-1 block overflow-hidden rounded-xl"
              key={`image-${resource.id}`}
              onClick={() => {
                setAtumDmConversationPreviewTarget(message.conversationId, {
                  kind: 'url',
                  label: resource.name,
                  source: resource.url,
                  url: resource.url
                })
              }}
            >
              <img alt={resource.name} className="max-h-80 max-w-full object-contain" src={resource.url} />
            </button>
          ))}
        {!recalled &&
          resources
            .filter(resource => resource.kind !== 'image')
            .map(resource => (
              <DmResourceCard conversationId={message.conversationId} key={resource.id} own={own} resource={resource} />
            ))}
        {metadata?.resourceRefs.map(resource => (
          <DmArtifactCard
            conversationId={message.conversationId}
            key={resource.resourceId}
            own={own}
            resource={resource}
          />
        ))}
        {metadata?.providerMemory && <DmMemoryReceipt own={own} receipt={metadata.providerMemory} />}
        {mentionDispatch && targetDispatches.length === 0 && (
          <DmMentionState errorCode={mentionDispatch.errorCode} state={mentionDispatch.state} />
        )}
        {targetDispatches.map(dispatch => (
          <DmMentionState
            displayName={dispatch.displayName}
            errorCode={dispatch.errorCode}
            key={`${dispatch.targetType}:${dispatch.targetId}`}
            state={dispatch.state}
          />
        ))}
        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1 text-[0.625rem]',
            own ? 'text-(--atum-card)/65' : 'text-(--atum-ink-muted)'
          )}
        >
          {isSpecialistPending(dispatch) && <DmSpecialistPending dispatch={dispatch!} />}
          <time dateTime={message.createdAt}>
            {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
              new Date(message.createdAt)
            )}
          </time>
          {pending && <Clock aria-label="sending" className="size-3" />}
          {failed && <AlertCircle aria-label="failed" className="size-3" />}
          {failed && <span>{t.dm.sendFailed}</span>}
          {conflicted && <AlertTriangle aria-label="conflicted" className="size-3" />}
          {message.editedAt && !recalled && <span>{t.dm.edited}</span>}
          {own && read && <span>{t.dm.messageRead}</span>}
        </div>
        {!immutable && message.delivery === 'failed_retryable' && message.clientMessageId && (
          <Button
            className="mt-1 h-6 px-2 text-[0.6875rem]"
            onClick={() => onRetry(message.clientMessageId!)}
            size="sm"
            variant="outline"
          >
            {retryLabel}
          </Button>
        )}
        {reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {reactions.map(reaction => (
              <button
                className="rounded-full border border-(--atum-line) bg-(--atum-card) px-2 py-0.5 text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink)"
                disabled={immutable}
                key={reaction.emoji}
                onClick={() => message.id && onReact?.(message.id, reaction.emoji)}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DmMentionState({
  displayName,
  errorCode,
  state
}: {
  displayName?: string
  errorCode: string | null
  state: 'completed' | 'dead_lettered' | 'pending' | 'processing'
}) {
  const { t } = useI18n()
  const pending = state === 'pending' || state === 'processing'

  const copy =
    state === 'completed'
      ? displayName
        ? t.dm.mention.targetCompleted(displayName)
        : t.dm.mention.completed
      : pending
        ? displayName
          ? t.dm.mention.targetReplying(displayName)
          : t.dm.mention.replying
        : errorCode === 'insufficient_protons' || errorCode === 'funding_required'
          ? displayName
            ? t.dm.mention.targetInsufficientProtons(displayName)
            : t.dm.mention.insufficientProtons
          : displayName
            ? t.dm.mention.targetFailed(displayName, errorCode)
            : t.dm.mention.failed(errorCode)

  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 border-t border-current/15 pt-1.5 text-(length:--atum-t-caption) leading-(--atum-lh-caption) opacity-75"
      data-dm-mention-state={state}
      role="status"
    >
      {pending && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />}
      <span>{copy}</span>
    </div>
  )
}

/** Only actual sharing belongs beside an answer; permission state lives in app settings. */
function DmMemoryReceipt({ own, receipt }: { own: boolean; receipt: ProviderMemoryReceipt }) {
  const { t } = useI18n()
  const copy = t.dm.memory

  if (receipt.outcome !== 'supplied' || receipt.used !== true) {
    return null
  }

  return (
    <div
      className={cn(
        'mt-1.5 flex items-center gap-1.5 border-t pt-1.5 text-(length:--atum-t-caption) leading-(--atum-lh-caption)',
        own ? 'border-(--atum-card)/20 text-(--atum-card)/75' : 'border-(--atum-line) text-(--atum-ink-muted)'
      )}
      data-dm-memory-outcome={receipt.outcome}
    >
      <ShieldLock aria-hidden className="size-3" />
      <span className="min-w-0 truncate">{copy.outcome[receipt.outcome]}</span>
    </div>
  )
}

/** Subtle in-flight marker while the hosted side is still asking a specialist. */
function DmSpecialistPending({ dispatch }: { dispatch: SpecialistDispatch }) {
  const { t } = useI18n()

  return (
    <span className="mr-auto flex items-center gap-1 truncate" data-dm-dispatch-state={dispatch.state}>
      <span aria-hidden className="size-1 shrink-0 animate-pulse rounded-full bg-current" />
      <span className="truncate">
        {dispatch.specialist ? t.dm.specialist.pendingWith(dispatch.specialist) : t.dm.specialist.pending}
      </span>
    </span>
  )
}
