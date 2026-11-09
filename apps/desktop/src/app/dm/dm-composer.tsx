import { useStore } from '@nanostores/react'
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { appSurfaceIcon } from '@/lib/atum-app-surface-icons'
import type { AppRoute, AppRoutes } from '@/lib/atum-app-surfaces'
import { ATUM_ADDRESSED_MENTIONS_CONTRACT, type AtumMentionTargetCandidate } from '@/lib/atum-messaging-client'
import { FileImage, Plus } from '@/lib/icons'
import {
  $atumDrafts,
  $atumMessages,
  $atumReplyTo,
  persistAtumDraft,
  sendAtumMessage,
  sendAtumTyping,
  setAtumDraft,
  setAtumReplyTo
} from '@/store/atum-messaging'
import { setWorkspaceOpen } from '@/store/atum-shell'
import { atumDmWorkbenchScopeKey, openWorkbenchAppView } from '@/store/workbench-tabs'

import type { GroupQuotedMessage } from '../../../shared/atum-group-conversations'
import { AtumAssistantAvatar } from '../atum/assistant-avatar'

import {
  type DmMentionSelection,
  mentionIsInvocable,
  mentionLabel,
  mentionSearchStart,
  reconcileMentionSelections,
  selectedMention
} from './dm-mentions'

interface DmComposerProps {
  accountId?: string | null
  /** Routes the app declares (main's projection of the manifest); composer-placed ones show in the menu. */
  appRoutes?: AppRoutes | null
  conversationId: string
  disabled: boolean
  /** A connection gate blocks sending while preserving local draft editing. */
  sendDisabled?: boolean
  privateAdvisory?: boolean
  sharedGroup?: boolean
  mentionEnabled?: boolean
  mediaEnabled?: boolean
  typingEnabled?: boolean
  mentionTargets?: readonly AtumMentionTargetCandidate[]
  mentionTargetState?: 'denied' | 'empty' | 'error' | 'legacy' | 'loading' | 'ready'
  mentionCardinality?: number
  /** Group rooms only: the backend has negotiated specialist addressing. */
  specialistAddressingEnabled?: boolean
  replySpecialist?: Pick<AtumMentionTargetCandidate, 'displayName'> | null
  replyAssistant?: Pick<AtumMentionTargetCandidate, 'displayName'> | null
  quotedMessage?: (GroupQuotedMessage & { preview: string }) | null
  onClearQuote?: (quote: GroupQuotedMessage) => void
  onSend?: (text: string) => Promise<void> | void
  placeholder?: string
}

export function DmComposer({
  accountId,
  appRoutes,
  conversationId,
  disabled,
  sendDisabled = false,
  privateAdvisory = false,
  sharedGroup = false,
  mentionEnabled = false,
  mentionCardinality = 8,
  mentionTargetState = 'denied',
  mentionTargets = [],
  mediaEnabled = true,
  onClearQuote,
  typingEnabled = true,
  onSend,
  placeholder,
  quotedMessage = null,
  replySpecialist = null,
  replyAssistant = null,
  specialistAddressingEnabled = false
}: DmComposerProps) {
  const { locale, t } = useI18n()
  const drafts = useStore($atumDrafts)
  const messages = useStore($atumMessages)
  const replies = useStore($atumReplyTo)
  const text = drafts[conversationId] ?? ''
  const replyId = replies[conversationId] ?? null
  const reply = (messages[conversationId] ?? []).find(message => message.id === replyId)
  const [attachmentIds, setAttachmentIds] = useState<string[]>([])
  const [upload, setUpload] = useState<{ progress: number; error: boolean } | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [mentions, setMentions] = useState<DmMentionSelection[]>([])
  const [mentionQueryStart, setMentionQueryStart] = useState<number | null>(null)

  const composerRoutes = appRoutes?.routes.filter(route => route.placements.includes('composer')) ?? []

  const openAppAction = (route: AppRoute) => {
    if (!appRoutes) {
      return
    }

    openWorkbenchAppView(
      appRoutes.app,
      route.id,
      locale === 'vi' ? route.label.vi : route.label.en,
      atumDmWorkbenchScopeKey(accountId, conversationId)
    )
    setWorkspaceOpen(true)
  }

  useEffect(
    () => () => {
      void persistAtumDraft(conversationId)
    },
    [conversationId]
  )
  useEffect(() => {
    if (typingEnabled) {
      sendAtumTyping(conversationId, false)
    }

    return () => {
      // The debounced "stopped typing" ping must not outlive the conversation
      // that armed it. After unmount there is no renderer left for the
      // transport to reach, and after a switch the ping would report the wrong
      // thread idle. The synchronous ping below still runs, from a component
      // that is only now tearing down.
      if (typingTimer.current) {
        clearTimeout(typingTimer.current)
        typingTimer.current = null
      }

      if (typingEnabled) {
        sendAtumTyping(conversationId, false)
      }
    }
  }, [conversationId, typingEnabled])
  useEffect(() => {
    setMentions([])
    setMentionQueryStart(null)
  }, [conversationId])

  const mentionQuery =
    mentionQueryStart === null
      ? ''
      : text.slice(mentionQueryStart + 1, textareaRef.current?.selectionStart ?? text.length).toLocaleLowerCase()

  const availableMentionTargets =
    mentionTargetState === 'legacy' || mentionTargetState === 'ready' ? mentionTargets : []

  const visibleMentionTargets = availableMentionTargets
    .filter(
      target =>
        (target.target.type === 'assistant' || specialistAddressingEnabled) &&
        target.displayName.toLocaleLowerCase().includes(mentionQuery)
    )
    // Cardinality limits selection, not discovery: a disabled first row must
    // not hide other participants in a room which allows only one mention.
    .slice(0, mentions.length < mentionCardinality ? 8 : 0)

  const mentionStatus = (target: AtumMentionTargetCandidate) => {
    if (target.target.type === 'specialist') {
      switch (target.availability) {
        case undefined:

        case 'available':
          return t.dm.group.specialistTargetState('available')

        case 'not_linked':

        case 'specialist_not_linked':
          return t.dm.group.specialistTargetState('specialist_not_linked')

        case 'unsupported':

        case 'specialist_room_unsupported':
          return t.dm.group.specialistTargetState('specialist_room_unsupported')

        default:
          return t.dm.group.advisory.unavailable
      }
    }

    if (!mentionIsInvocable(target)) {
      return t.dm.group.assistantTargetState(target.availability ?? 'unavailable')
    }

    return privateAdvisory
      ? t.dm.group.advisory.title
      : sharedGroup
        ? t.dm.group.assistantTargetState('available')
        : t.dm.mention.hostedHint
  }

  const chooseMention = (target: AtumMentionTargetCandidate) => {
    if (mentionQueryStart === null || mentions.length >= mentionCardinality || !mentionIsInvocable(target)) {
      return
    }

    const before = text.slice(0, mentionQueryStart)
    const after = text.slice(textareaRef.current?.selectionStart ?? text.length)
    const label = mentionLabel(target)
    const next = `${before}${label} ${after}`
    const selected = selectedMention(next, mentionQueryStart, target)

    if (!selected) {
      return
    }

    setAtumDraft(conversationId, next)
    const shifted = reconcileMentionSelections(text, next, mentions, mentionQueryStart + label.length + 1)
    setMentions([...shifted, selected].sort((left, right) => left.startOffset - right.startOffset))
    setMentionQueryStart(null)
    requestAnimationFrame(() => {
      const caret = mentionQueryStart + label.length + 1
      textareaRef.current?.setSelectionRange(caret, caret)
      textareaRef.current?.focus()
    })
  }

  const send = async () => {
    const hasAddressedTarget = mentions.length > 0 || Boolean(replySpecialist) || Boolean(replyAssistant)

    if (disabled || sendDisabled || !text.trim() || (quotedMessage && !hasAddressedTarget)) {
      return
    }

    if (onSend) {
      await onSend(text)
    } else {
      const legacyMention =
        mentions.length === 1 && mentions[0]?.target.id === 'binh-minh' && mentions[0]?.revision === 0
          ? {
              agent: 'binh-minh' as const,
              revision: 0 as const,
              startOffset: mentions[0].startOffset,
              endOffset: mentions[0].endOffset
            }
          : null

      const addressedMentions = legacyMention
        ? null
        : mentions.length > 0
          ? {
              contract: ATUM_ADDRESSED_MENTIONS_CONTRACT,
              targets: mentions.map(({ endOffset, revision, startOffset, target }) => ({
                endOffset,
                revision,
                startOffset,
                target
              }))
            }
          : null

      const quoteAtSend = quotedMessage
        ? { messageId: quotedMessage.messageId, sourceVersion: quotedMessage.sourceVersion }
        : null

      await sendAtumMessage(conversationId, text, locale, attachmentIds, legacyMention, addressedMentions, quoteAtSend)

      if (quoteAtSend) {
        onClearQuote?.(quoteAtSend)
      }

      setAttachmentIds([])
      setMentions([])
      setMentionQueryStart(null)
    }
  }

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file || !mediaEnabled) {
      return
    }

    // Closing the popover here is what actually prevents the refused
    // combination: disabling the control cannot retract a list that is already
    // on screen, and the user could still commit a mention mid-upload.
    setMentionQueryStart(null)
    setMentions([])
    setUpload({ progress: 0, error: false })

    try {
      const created = await window.hermesDesktop.messaging.createMediaUpload({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size
      })

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', created.uploadUrl)
        xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
        xhr.upload.onprogress = e =>
          e.lengthComputable && setUpload({ progress: Math.round((e.loaded / e.total) * 100), error: false })
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('upload_failed')))
        xhr.onerror = () => reject(new Error('upload_failed'))
        xhr.send(file)
      })
      await window.hermesDesktop.messaging.completeMediaUpload(created.attachmentId)
      setAttachmentIds(ids => [...ids, created.attachmentId])
      setUpload(null)
    } catch {
      setUpload({ progress: 0, error: true })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQueryStart !== null && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault()

      const firstInvocable = visibleMentionTargets.find(mentionIsInvocable)

      if (firstInvocable) {
        chooseMention(firstInvocable)
      }

      return
    }

    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()
    void send()
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-4">
      {reply && (
        <div className="mx-auto mb-1 flex max-w-3xl items-center gap-2 rounded-lg border-l-2 border-(--atum-accent) bg-(--atum-sunk) px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate">
            <b>{t.dm.replyingTo}:</b> {reply.content}
          </span>
          <Button
            aria-label={t.dm.cancelReply}
            onClick={() => setAtumReplyTo(conversationId, null)}
            size="icon"
            variant="ghost"
          >
            ×
          </Button>
        </div>
      )}
      {reply && (replySpecialist || replyAssistant) && specialistAddressingEnabled && (
        <div
          className="mx-auto mb-1 max-w-3xl rounded-lg border border-(--atum-line) bg-(--atum-sunk) px-3 py-2 text-xs text-(--atum-ink-soft)"
          data-dm-specialist-reply
          role="status"
        >
          <b>
            {replyAssistant
              ? t.dm.group.replyingToAssistant(replyAssistant.displayName)
              : t.dm.group.replyingToSpecialist(replySpecialist!.displayName)}
          </b>{' '}
          {sharedGroup ? t.dm.group.sharedContextDisclosure : t.dm.group.replySpecialistDisclosure}
        </div>
      )}
      {quotedMessage && (
        <div
          className="mx-auto mb-1 flex max-w-3xl items-center gap-2 rounded-lg border-l-2 border-(--atum-accent) bg-(--atum-sunk) px-3 py-1.5 text-xs"
          data-dm-app-quote
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">
            <b>{t.dm.group.quotePreview}</b> {quotedMessage.preview}
          </span>
          <Button
            aria-label={t.dm.group.clearQuote}
            onClick={() => onClearQuote?.(quotedMessage)}
            size="icon"
            variant="ghost"
          >
            ×
          </Button>
        </div>
      )}
      {mentions.length > 0 && (
        <div
          className="mx-auto mb-1 max-w-3xl rounded-lg border border-(--atum-line) bg-(--atum-sunk) px-3 py-2 text-xs text-(--atum-ink-soft)"
          data-dm-assistant-context={
            privateAdvisory ? 'private-advisory' : sharedGroup ? 'shared-group' : 'trigger-message-only'
          }
          role="status"
        >
          <b>
            {privateAdvisory
              ? t.dm.group.advisory.title
              : sharedGroup
                ? t.dm.group.sharedContextTitle
                : t.dm.mention.contextTitle}
          </b>{' '}
          {privateAdvisory
            ? t.dm.group.advisory.roundDisclosure
            : sharedGroup
              ? t.dm.group.sharedContextDisclosure
              : t.dm.mention.contextDisclosure}
        </div>
      )}
      {upload && (
        <div
          className="mx-auto mb-1 max-w-3xl text-xs text-(--atum-ink-muted)"
          role={upload.error ? 'alert' : 'status'}
        >
          {upload.error ? t.dm.uploadFailed : t.dm.uploading(upload.progress)}
        </div>
      )}
      <div className="atum-composer-pill relative mx-auto flex w-full max-w-(--composer-width) items-end gap-2 pe-2.5 ps-3">
        {mentionTargetState === 'error' && (
          <div className="mx-auto mb-1 max-w-3xl text-xs text-destructive" role="status">
            {t.dm.mention.targetsUnavailable}
          </div>
        )}
        {mentionQueryStart !== null && visibleMentionTargets.length > 0 && (
          <div
            className="absolute bottom-full left-2 z-20 mb-1 w-52 rounded-xl border border-(--atum-line-strong) bg-(--atum-card) p-1 shadow-(--atum-shadow-panel)"
            role="listbox"
          >
            {visibleMentionTargets.map(target => (
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-(--atum-hover)"
                disabled={!mentionIsInvocable(target)}
                key={`${target.target.type}:${target.target.id}:${target.revision}`}
                onMouseDown={event => {
                  event.preventDefault()
                  chooseMention(target)
                }}
                role="option"
              >
                {target.target.type === 'assistant' ? (
                  <AtumAssistantAvatar
                    avatarUrl={target.avatarUrl}
                    className="size-7 shrink-0 rounded-lg"
                    id={target.target.id}
                    name={target.displayName}
                  />
                ) : (
                  <span className="grid size-7 place-items-center rounded-lg bg-(--atum-accent)/15 font-semibold text-(--atum-accent)">
                    {target.avatar || target.displayName.slice(0, 1)}
                  </span>
                )}
                <span>
                  <b>{target.displayName}</b>
                  <small className="block text-(--atum-ink-muted)">
                    {mentionStatus(target)}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
        {mentions.length > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-1.5 left-[3.125rem] right-[3.125rem] overflow-hidden px-2.5 py-2 text-(length:--atum-t-ui) leading-(--atum-lh-ui) leading-normal whitespace-pre-wrap text-transparent"
          >
            {mentions.reduce<React.ReactNode[]>((parts, mention, index) => {
              const previousEnd = index === 0 ? 0 : mentions[index - 1]!.endOffset
              parts.push(
                text.slice(previousEnd, mention.startOffset),
                <mark
                  className="rounded bg-(--atum-accent)/20 text-transparent"
                  key={`${mention.target.id}:${mention.startOffset}`}
                >
                  {text.slice(mention.startOffset, mention.endOffset)}
                </mark>
              )

              if (index === mentions.length - 1) {
                parts.push(text.slice(mention.endOffset))
              }

              return parts
            }, [])}
          </div>
        )}
        {/* One "+" on the left, as Moon does on the web: app actions first,
            then attachments. Nothing else lives between the text and Send. */}
        <input
          accept="image/*"
          className="sr-only"
          disabled={!mediaEnabled || disabled || mentions.length > 0 || Boolean(upload && !upload.error)}
          onChange={event => void chooseImage(event)}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        {(mediaEnabled || composerRoutes.length > 0) && (
          <DropdownMenu>
            <Tip label={t.dm.composerMenu}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={t.dm.composerMenu}
                  className="mb-3 size-8 shrink-0 rounded-full text-(--atum-ink-muted) hover:bg-(--atum-hover) hover:text-(--atum-ink)"
                  data-icon-only
                  disabled={disabled}
                  size="icon"
                  variant="ghost"
                >
                  <Plus className="size-[1.125rem]" />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="start" side="top">
              {composerRoutes.length > 0 && (
                <>
                  {composerRoutes.map(route => {
                    const Icon = appSurfaceIcon(route.icon)

                    return (
                      <DropdownMenuItem key={route.id} onSelect={() => openAppAction(route)}>
                        <Icon aria-hidden />
                        {locale === 'vi' ? route.label.vi : route.label.en}
                      </DropdownMenuItem>
                    )
                  })}
                  <DropdownMenuSeparator />
                </>
              )}
              {mediaEnabled && (
                <DropdownMenuItem
                  disabled={Boolean(upload && !upload.error)}
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <FileImage aria-hidden />
                  {t.dm.attachImage}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <textarea
          aria-label={t.dm.compose}
          className="max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-4 text-(length:--atum-t-chat) leading-normal text-(--atum-ink) outline-none placeholder:text-(--atum-ink-faint) disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onBlur={() => void persistAtumDraft(conversationId)}
          onChange={event => {
            const next = event.target.value
            setAtumDraft(conversationId, next)

            setMentions(reconcileMentionSelections(text, next, mentions, event.target.selectionStart))

            // The hosted mention path carries no attachments, so a message
            // cannot be both. Suppressing the popover keeps the user from
            // building a combination the server will refuse outright.
            setMentionQueryStart(
              mentionEnabled &&
                mentionTargetState !== 'denied' &&
                mentionTargetState !== 'error' &&
                attachmentIds.length === 0 &&
                !upload &&
                mentions.length < mentionCardinality
                ? mentionSearchStart(next, event.target.selectionStart)
                : null
            )

            if (typingTimer.current) {
              clearTimeout(typingTimer.current)
              typingTimer.current = null
            }

            if (typingEnabled) {
              sendAtumTyping(conversationId, true)
              typingTimer.current = setTimeout(() => {
                typingTimer.current = null
                sendAtumTyping(conversationId, false)
              }, 2_000)
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={disabled ? t.dm.loadingMessages : (placeholder ?? t.dm.compose)}
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <Button
          aria-label={t.dm.send}
          className="mb-[0.6875rem] size-[2.125rem] shrink-0 rounded-full bg-(--atum-ink) text-(--atum-on-accent) hover:bg-(--atum-ink-soft) disabled:bg-(--atum-ink)/30 disabled:text-(--atum-on-accent) disabled:opacity-100"
          disabled={
            disabled ||
            sendDisabled ||
            (!text.trim() && attachmentIds.length === 0) ||
            Boolean(upload && !upload.error) ||
            Boolean(quotedMessage && mentions.length === 0 && !replySpecialist && !replyAssistant)
          }
          onClick={() => void send()}
          size="icon"
        >
          ↑
        </Button>
      </div>
    </div>
  )
}
