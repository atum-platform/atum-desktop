import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'

import { AppCatalogAvatar, AppCatalogRow } from '@/app/atum/app-catalog-presentation'
import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { AtumAtom } from '@/components/brand/atum-atom'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Tip } from '@/components/ui/tooltip'
import { VerifiedMark } from '@/components/verified-mark'
import { useI18n } from '@/i18n'
import { BellOff } from '@/lib/icons'
import { MINUTE } from '@/lib/time'
import { cn } from '@/lib/utils'

import { type AppDescriptor, appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import { matrixAgentAccessPausedLabel } from '../../shared/matrix-agent-access-band-copy'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import { accountVerificationTier, appVerificationTier } from '../../shared/verification'

import { matrixAgentAttention, useMatrixAttentionNow } from './agent-attention'
import { agentStatus } from './agent-roster'
import { useAppCopy } from './app-copy'
import { useChatCopy } from './chat-copy'
import { matrixChatTitle } from './chat-title'
import { matrixAgentAccessEnded, useMatrixCloudAccess } from './cloud-access'
import { useConversationCopy } from './conversation-copy'
import { resolveProjectedConversation } from './conversation-marker'
import { useMatrixCopy } from './copy'
import { executionPolicyAvailability, executionPolicyRosterLine } from './execution-policy-trigger'
import { FounderAvatar } from './founder/founder-avatar'
import { useFounderCopy } from './founder/founder-copy'
import { $founderDraftOpen, closeFounderDraft, openFounderDraft, openFounderProfile } from './founder/founder-store'
import { FounderProfileSheet } from './founder/profile-sheet'
import { useLaunchCopy } from './launch-copy'
import { MatrixMemberAvatar } from './member-avatar'
import { directPartner } from './people'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { PersonHandleInline, personHandleText } from './person-handle-line'
import { useMatrixHandles } from './person-handles'
import { MatrixProfileAvatar } from './profile-avatar'
import { type MatrixReadinessAction, matrixReadinessCopy, type MatrixReadinessShellCopy } from './readiness-copy'
import { sortConversations } from './room-navigation'
import { RosterBadge } from './roster-badge'
import { MatrixComingSoonRow } from './roster-coming-soon'
import { RosterAgentMenu, RosterAppMenu, RosterMenuHost, RosterRoomMenu } from './roster-context-menu'
import { useRosterCopy } from './roster-copy'
import {
  filterMatrixRoster,
  isAppBotRoom,
  matrixRosterAgentName,
  normalizeMatrixRosterQuery,
  projectMatrixRoster
} from './roster-model'
import {
  matrixAgentConversationRoom,
  matrixAgentCounts,
  matrixRoomCounts,
  matrixRoomHasUnread,
  type MatrixRosterBadge,
  matrixRosterBadge,
  matrixRosterPreview
} from './roster-preview'
import { matrixAgentWorkingRow, matrixWorkingRooms, matrixWorkingStep } from './roster-working'
import { openMatrixTopUp } from './store/top-up'
import { runMatrixCommand } from './text-document-actions'
import { useWorkingCopy } from './working-copy'

interface MatrixRosterConversationsProps {
  snapshot: MatrixSnapshot
  /** Names only; the account-scoped shell owns this window's query. */
  query?: string
  /** Results rendered by the account shell above this local roster (people, company rooms/messages). */
  externalResultCount?: number
  /** Suppresses the final empty state while those external sources are still answering. */
  externalSearching?: boolean
  assistantOpening: boolean
  /** Owns default-agent creation and its pending room identity in MatrixApp. `roomId`
   * names the chat to open (its unread one, or its newest) when it is one of the default
   * agent's. */
  openAssistant(fresh?: boolean, roomId?: string): void | Promise<void>
  /** Shares MatrixApp's private creation/retry path with every active agent. */
  openAgentChat(agent: MatrixAgentView): void | Promise<void>
  /** The shell's single navigation/drawer close action. */
  onOpen(): void
  fail(): void
  onEditAgent?(agent: MatrixAgentView, focus?: 'name'): void
  /** Agent creation stays outside history groups but before ordinary chats. */
  agentActions?: ReactNode
  /** Opens an app's row (the roster's apps, after the chats): an official bot's chat, which
   * MatrixApp opens through main, or an app's own view. Without it the rows cannot be opened. */
  onOpenApp?(app: AppDescriptor): void
  /** The app whose chat is opening now, if any: its row says so and every app row waits. */
  openingApp?: string | null
  /** An app's read-only card (its row's "Info"). */
  onAppInfo?(app: AppDescriptor): void
  /** Composed after the apps, outside search. */
  children?: ReactNode
}

const hireRenewCopy = {
  vi: (price: string) => [`Trợ lý này đang tạm dừng. Gia hạn ${price} Proton/tháng để tiếp tục.`, 'Gia hạn'],
  en: (price: string) => [`This assistant is paused. Renew for ${price} Protons/month to continue.`, 'Renew'],
  ja: (price: string) => [
    `このアシスタントは一時停止中です。続けるには月額 ${price} Proton で更新してください。`,
    '更新'
  ],
  zh: (price: string) => [`此助手已暂停。续订每月 ${price} Proton 后即可继续。`, '续订'],
  'zh-hant': (price: string) => [`此助理已暫停。續訂每月 ${price} Proton 後即可繼續。`, '續訂']
} as const

/** A row's face (Element's room list: one size for every chat). */
const AVATAR = 'size-7 shrink-0 rounded-(--atum-r-avatar) text-[0.75rem] leading-none'

/** The roster's clock: relative times move on once a minute, in the window's language. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE)

    return () => clearInterval(timer)
  }, [])

  return now
}

/** An assistant at work: Atum's atom in the time's place, with its words for a tip and a
 * screen reader (launch night). */
function RosterWorking({ id, label }: { id?: string; label: string }) {
  return (
    <Tip label={label}>
      <span
        className="grid size-4 shrink-0 place-items-center self-center text-(--atum-ink-muted)"
        data-roster-working
        id={id}
      >
        <AtumAtom className="size-3.5" />
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  )
}

/** A chat's row: name and time on top, its latest message and badge under them. */
function RosterLines({
  adornment,
  badge,
  badgeId,
  handle,
  invited,
  muted,
  preview,
  previewId,
  title,
  titleClassName,
  working,
  workingPreview,
  workingId
}: {
  /** Drawn right after the name, never cut off with it: a verification mark. */
  adornment?: ReactNode
  badge: MatrixRosterBadge
  badgeId?: string
  /** A person's @handle beside the name (a direct chat), quieter than it and cut first. */
  handle?: ReactNode
  invited?: boolean
  muted?: boolean
  preview?: string
  previewId?: string
  title: ReactNode
  titleClassName?: string
  /** Who is at work here, when an assistant's turn is running: the atom takes the time's place. */
  working?: string
  /** The current step replaces the stale latest-message preview while work is running. */
  workingPreview?: string
  workingId?: string
}) {
  const conversation = useConversationCopy()
  const roster = useRosterCopy()
  const unread = badge !== null

  // A row carries no time (Atum Kit, FlowChat): only an assistant at work shows its atom there.
  const clock = working ? <RosterWorking id={workingId} label={working} /> : null

  const marks = (
    <>
      {muted && (
        <span className="shrink-0 text-(--atum-ink-faint)">
          <BellOff aria-hidden className="size-3.5" />
          <span className="sr-only">{roster.muted}</span>
        </span>
      )}
      {invited ? (
        <span className="shrink-0 rounded-full bg-(--atum-sunk) px-1.5 text-(length:--atum-t-label) leading-(--atum-lh-label) text-(--atum-ink-muted)">
          {conversation.invited}
        </span>
      ) : (
        <RosterBadge badge={badge} id={badgeId} />
      )}
    </>
  )

  const name = (
    <span
      className={cn(
        'min-w-0 truncate text-(--atum-ink)',
        !adornment && !handle && 'flex-1',
        'text-(length:--atum-t-ui) leading-(--atum-lh-ui)',
        unread ? 'font-semibold' : 'font-medium',
        titleClassName
      )}
    >
      {title}
    </span>
  )

  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        {adornment || handle ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-1" data-roster-name>
            {name}
            {adornment && <span className="flex shrink-0 items-center self-center">{adornment}</span>}
            {handle}
          </span>
        ) : (
          name
        )}
        {clock}
      </span>
      {(workingPreview || preview || badge || muted || invited) && (
        <span className="flex min-h-(--atum-unread-pill) min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-(length:--atum-t-body) leading-(--atum-lh-body) text-(--atum-ink-muted)"
            data-roster-preview
            id={previewId}
          >
            {workingPreview ?? preview}
          </span>
          {marks}
        </span>
      )}
    </span>
  )
}

/** A group's face (Atum Kit: two stacked faces, FlowChat): the latest speaker in front of the
 * group's own initial. One-to-one chats and an assistant's histories keep one face: it says who,
 * the title says what it is about. */
function RoomFace({ room, title }: { room: MatrixRoom; title: string }) {
  const joined = room.participants?.filter(member => member.membership === 'join').length ?? 0
  const speaker = room.preview && !room.preview.own ? room.preview.sender?.trim() : undefined
  const name = room.assistant && room.name.trim() ? room.name : title

  if (room.direct || room.assistant || joined < 3 || !speaker) {
    return <AtumAssistantAvatar className={AVATAR} id={room.id} name={name} />
  }

  return (
    <span aria-hidden className="atum-group-face" data-matrix-group-face>
      <AtumAssistantAvatar className="atum-avatar" id={room.id} name={name} />
      <AtumAssistantAvatar className="atum-avatar" id={`${room.id}:${speaker}`} name={speaker} />
    </span>
  )
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
function FounderDraftRow({ disabled, now, onOpen }: { disabled: boolean; now: number; onOpen(): void }) {
  const founderCopy = useFounderCopy()
  const draftOpen = useStore($founderDraftOpen)

  return (
    <div
      className="atum-row flex h-12 items-center"
      data-current={draftOpen ? 'true' : undefined}
      data-matrix-founder-draft="true"
    >
      <button
        aria-current={draftOpen ? 'page' : undefined}
        aria-label={founderCopy.name}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[inherit] ps-2 pe-2 text-left"
        data-roster-row
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <FounderAvatar size={32} />
        <RosterLines
          adornment={<VerifiedMark tier="official" />}
          badge={null}
          preview={founderCopy.subtitle}
          title={founderCopy.name}
        />
      </button>
    </div>
  )
}

function MatrixRoomRow({
  adornment,
  avatar,
  disabled,
  emptyPreview,
  fail,
  handle,
  name,
  now,
  onOpen,
  profile,
  room,
  selected,
  snapshot,
  subtitle,
  working,
  workingPreview,
  ...data
}: {
  /** After the name; by default the mark of the person a direct chat is with, when Atum marks them. */
  adornment?: ReactNode
  /** The face, when the app draws one of its own (the Founder's raven). */
  avatar?: ReactNode
  disabled: boolean
  /** The second line while nobody has written yet. */
  emptyPreview?: string
  fail(cause?: unknown): void
  /** The @handle of the person a direct chat is with, beside the name, when the directory vouched for it. */
  handle?: string
  /** The name, when the app knows it better than the room does (the Founder). */
  name?: string
  now: number
  onOpen(): void
  /** View profile, first in the row's menu. */
  profile?: { label: string; open(): void }
  room: MatrixRoom
  selected: boolean
  snapshot: MatrixSnapshot
  /** A stand-in second line in place of the latest message (a company channel's company). */
  subtitle?: string
  /** Whose turn is running in this chat, when one is. */
  working?: string
  /** The assistant's current step while this chat is running. */
  workingPreview?: string
  [key: `data-${string}`]: string | undefined
}) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const roster = useRosterCopy()
  const ids = useId()

  const title =
    name ?? matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn }, now)

  const badge = room.membership === 'invite' ? null : matrixRosterBadge(matrixRoomCounts(room))
  const latest = matrixRosterPreview(room, roster, chat.messageDeleted)
  const preview = subtitle ?? latest ?? emptyPreview
  // Someone Atum marks (an official or verified account), by their exact id: never a name.
  const partner = snapshot.identity ? directPartner(room, snapshot.identity.userId) : undefined
  const tier = partner ? accountVerificationTier(snapshot.officialAccounts, partner) : null
  const mark = adornment ?? (tier ? <VerifiedMark tier={tier} /> : undefined)
  const previewId = preview ? `${ids}-preview` : undefined
  const badgeId = badge ? `${ids}-badge` : undefined
  const pinnedId = room.favourite ? `${ids}-pinned` : undefined
  // Low priority shows only where the chat sits (last), as Pin does (first); a reader hears it.
  const lowId = room.lowPriority && !room.favourite ? `${ids}-low` : undefined
  const workingId = working ? `${ids}-working` : undefined

  // Element's row: the face, the name (bold while unread) and when it last spoke, then one
  // line of its latest message with the badge. Right-click, the context-menu key or a long
  // press opens the chat's actions.
  return (
    <RosterRoomMenu fail={fail} profile={profile} room={room} snapshot={snapshot} title={title}>
      <div
        className="atum-row flex h-12 items-center"
        data-current={selected ? 'true' : undefined}
        data-matrix-room={room.id}
        {...data}
      >
        <button
          aria-current={selected ? 'page' : undefined}
          aria-describedby={[pinnedId, lowId, workingId, previewId, badgeId].filter(Boolean).join(' ') || undefined}
          aria-label={title}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[inherit] ps-2 pe-2 text-left"
          data-roster-row
          disabled={disabled}
          onClick={onOpen}
          type="button"
        >
          {avatar ??
            (partner && room.peerAvatarMxc ? (
              // An ordinary person's (or app bot's) one-to-one chat wears their real Matrix
              // profile photo, loaded through the authenticated member bridge.
              <MatrixMemberAvatar avatarMxc={room.peerAvatarMxc} className={AVATAR} id={partner} name={title} presence={false} />
            ) : (
              <RoomFace room={room} title={title} />
            ))}
          <RosterLines
            adornment={mark}
            badge={badge}
            badgeId={badgeId}
            handle={handle ? <PersonHandleInline handle={handle} name={title} /> : undefined}
            invited={room.membership === 'invite'}
            muted={room.muted}
            preview={preview}
            previewId={previewId}
            // A stand-in line (the Founder's "Atum founder") is no one's message: no time beside it.
            title={
              <>
                {title}
                {room.favourite && (
                  <span className="sr-only" id={pinnedId}>
                    {t.sidebar.pinned}
                  </span>
                )}
                {lowId && (
                  <span className="sr-only" id={lowId}>
                    {chat.lowPriorityLabel}
                  </span>
                )}
              </>
            }
            working={working}
            workingId={workingId}
            workingPreview={workingPreview}
          />
        </button>
      </div>
    </RosterRoomMenu>
  )
}

/**
 * An official bot's one row (Moon, Andy): its face and name, then its chat's latest message,
 * time and badge, as a chat row shows them. The chat is never listed again on its own, so the
 * bot is never two rows and one click never lights two. Opening goes through MatrixApp (main
 * pins the bot first, then opens the same room every time). A chat the person deleted shows
 * nothing here until it is opened again or something new arrives in it.
 */
function MatrixAppBotRow({
  app,
  disabled,
  locale,
  now,
  onInfo,
  onOpen,
  pending,
  room,
  searchHandle,
  selected
}: {
  app: AppDescriptor & { bot: NonNullable<AppDescriptor['bot']> }
  disabled: boolean
  locale: string
  now: number
  onInfo?(): void
  onOpen(): void
  /** The words while its chat opens. */
  pending?: string
  room?: MatrixRoom
  /** During roster search, identify the public bot account under its display name. */
  searchHandle?: string
  selected: boolean
}) {
  const chat = useChatCopy()
  const roster = useRosterCopy()
  const ids = useId()
  const shown = room && !room.appBot?.hidden ? room : undefined
  const badge = shown && shown.membership !== 'invite' ? matrixRosterBadge(matrixRoomCounts(shown)) : null
  const latest = shown ? matrixRosterPreview(shown, roster, chat.messageDeleted) : undefined
  // A bot that is not up says so; otherwise its chat's latest message, else nothing.
  const state = app.bot.state === 'active' ? undefined : appChatCopy(locale).botRowState[app.bot.state]
  const preview = pending ?? (searchHandle ? `@${searchHandle.replace(/^@/u, '')}` : state ?? latest)
  const previewId = preview ? `${ids}-preview` : undefined
  const badgeId = badge ? `${ids}-badge` : undefined
  const tier = appVerificationTier(app)

  return (
    <RosterAppMenu onInfo={onInfo}>
      <div
        className="atum-row flex h-12 items-center"
        data-current={selected ? 'true' : undefined}
        data-matrix-app-bot={app.app_id}
      >
        <button
          aria-busy={pending ? true : undefined}
          aria-current={selected ? 'page' : undefined}
          aria-describedby={[previewId, badgeId].filter(Boolean).join(' ') || undefined}
          aria-label={app.bot.display_name}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[inherit] ps-2 pe-2 text-left"
          data-roster-row
          disabled={disabled || Boolean(pending)}
          onClick={onOpen}
          type="button"
        >
          {room?.peerAvatarMxc ? (
            // The bot's own Matrix profile photo is the face it actually chats with. The
            // catalog URL stays a fallback: the renderer cannot paint remote images.
            <MatrixMemberAvatar
              avatarMxc={room.peerAvatarMxc}
              className={AVATAR}
              id={app.bot.user_id}
              name={app.bot.display_name}
              presence={false}
            />
          ) : (
            <AppCatalogAvatar app={app} className={AVATAR} locale={locale} />
          )}
          <RosterLines
            adornment={tier ? <VerifiedMark subject="app" tier={tier} /> : undefined}
            badge={badge}
            badgeId={badgeId}
            muted={shown?.muted}
            preview={preview}
            previewId={previewId}
            title={app.bot.display_name}
          />
        </button>
      </div>
    </RosterAppMenu>
  )
}

/** The bot chat its row can still open while the bot itself cannot be: one the person is in
 * and has not deleted. An invitation cannot be read before joining, and joining is the bot open
 * path's job. */
function appBotReadableRoom(room: MatrixRoom | undefined): MatrixRoom | undefined {
  return room && room.membership === 'join' && !room.appBot?.hidden ? room : undefined
}

/** What an assistant's avatar dot says. Every assistant row carries one: `live` while it can
 * answer (here, or on another of your Macs), `needs_you` when something the person can do
 * would bring it back, and `off` (a hollow ring) while it is not running anywhere yet. People
 * get none: the homeserver's presence is not read into the window (see the 2026-10-05
 * status-dots session log). */
export type MatrixAgentDot = 'live' | 'needs_you' | 'off'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
const AGENT_DOT: Record<MatrixAgentDot, { tone: StatusTone; className: string }> = {
  live: { tone: 'good', className: 'bg-(--atum-ready)' },
  needs_you: { tone: 'warn', className: '' },
  off: { tone: 'muted', className: 'border-[1.5px] border-(--atum-ink-muted) bg-transparent' }
}

/** Connectivity failures stay quiet; agent-attention.ts owns who needs the person. */
const AGENT_OFF_CODES = new Set([
  'offline',
  'chat_unreachable',
  'chat_unavailable',
  'platform_unavailable',
  'ai_unavailable',
  'agent_roster_unavailable',
  'agent_reconnecting'
])

/** Listening pauses the app passes through on its own (renewing its watch, turning it on or
 * cancelling a turn): nothing for the person to do, so the assistant reads as it otherwise
 * would. */
const LISTENING_ROUTINE_PAUSES = new Set(['renewing', 'busy'])

export interface MatrixAgentDotCopy extends MatrixReadinessShellCopy {
  agentSettingUp: string
  agentDotReady: string
  agentDotNeedsYou: string
  agentDotOffline: string
  agentDotUnreachable: string
}

export function matrixAgentDot(
  agent: MatrixAgentView,
  locale: keyof typeof matrixActionCopy,
  shell: MatrixAgentDotCopy,
  opening: string,
  now = Date.now()
): { dot: MatrixAgentDot; label: string } {
  const copy = matrixActionCopy[locale]
  const listening = agent.listening
  const attention = matrixAgentAttention(agent, now)

  if (listening?.state === 'listening') {
    return { dot: 'live', label: listening.mode === 'continuous' ? copy.continuousListening : copy.listening }
  }

  // Another of your Macs is answering for it: it is up, and where is not said (0.19.4 Q4).
  if (listening?.state === 'paused' && listening.reason === 'lease_elsewhere') {
    return { dot: 'live', label: shell.agentDotReady }
  }

  // A cloud-answering agent answers from another destination even when this Mac keeps a standby
  // runtime: its local setup/readiness can fail on a platform blip with the cloud still serving.
  // Mirror `agentStatus`'s cloud exemption: the dot follows the destination that answers, never
  // this Mac's runtime. Grey only when no destination can take a turn (paused, or all down).
  if (agent.answering === 'cloud' && agent.macRole !== 'answering') {
    const availability = executionPolicyAvailability(agent.executionPolicy)

    if (availability === 'paused') {
      return { dot: 'off', label: matrixAgentAccessPausedLabel(locale) }
    }

    if (availability === 'unavailable') {
      return { dot: 'off', label: shell.agentDotUnreachable }
    }

    // `unknown` is a stale cache or no status yet, never a fact that the agent is down: the
    // availability contract (`executionPolicyAvailability`) says unknown is never "down" and the
    // title bar paints its own muted loading icon for the same state. The dot stays green rather
    // than claiming a paused or unreachable agent from an absent fact.
    return { dot: 'live', label: shell.agentDotReady }
  }

  if (agent.setup === 'failed' || agent.setup === 'action_required') {
    return {
      dot: attention.state === 'needs_you' ? 'needs_you' : 'off',
      label: attention.state === 'needs_you' ? shell.agentDotNeedsYou : shell.agentSettingUp
    }
  }

  const readiness = agent.readiness

  if (readiness?.phase === 'blocked' || readiness?.phase === 'degraded') {
    const code = readiness.code ?? ''

    // Say what it needs ("You're out of Protons."), never just that it needs something.
    if (attention.state === 'needs_you') {
      return {
        dot: 'needs_you',
        label: matrixReadinessCopy(readiness, undefined, shell, opening, locale).title || shell.agentDotNeedsYou
      }
    }

    return {
      dot: 'off',
      label:
        code === 'offline'
          ? shell.agentDotOffline
          : AGENT_OFF_CODES.has(code) && code !== 'agent_reconnecting'
            ? shell.agentDotUnreachable
            : shell.agentSettingUp
    }
  }

  if (listening?.state === 'paused' && listening.reason === 'offline') {
    return { dot: 'off', label: shell.agentDotOffline }
  }

  const routinePause = listening?.state === 'paused' && LISTENING_ROUTINE_PAUSES.has(listening.reason ?? '')

  // Listening that stopped on its own, or paused for a reason the person can lift.
  if (
    (listening?.state === 'paused' && !routinePause) ||
    (listening?.state === 'stopped' &&
      (listening.result || ['unavailable', 'overflow'].includes(listening.reason ?? '')))
  ) {
    return {
      dot: attention.state === 'needs_you' ? 'needs_you' : 'off',
      label:
        listening.state === 'paused' && listening.mode === 'continuous'
          ? copy.continuousListeningPaused
          : copy.listeningStopped
    }
  }

  if (agent.setup === 'working' || readiness?.phase !== 'ready') {
    return { dot: 'off', label: shell.agentSettingUp }
  }

  if (routinePause) {
    return { dot: 'live', label: listening.mode === 'continuous' ? copy.continuousListening : copy.listening }
  }

  return { dot: 'live', label: shell.agentDotReady }
}

/** The dot on an assistant's avatar corner, set in a notch cut out of the face
 * (`.atum-agent-face` in styles.css) so it reads on any ground: the translucent roster, a
 * hovered or selected row. Decoration: its words are in the row's description, so the tip
 * only repeats them for a pointer. */
export function MatrixAgentStatusDot({ dot, label }: { dot: MatrixAgentDot; label: string }) {
  // Ready is the normal state and draws nothing (Atum Kit: colour is rare; the boards mark only
  // an assistant that needs the person or is off). Its words stay in the row for a screen reader.
  if (dot === 'live') {
    return null
  }

  const { className, tone } = AGENT_DOT[dot]

  return (
    <Tip label={label}>
      <span className="absolute -right-0.5 -bottom-0.5 flex" data-agent-dot={dot}>
        <StatusDot className={cn('size-2', className)} data-matrix-agent-dot={tone} tone={tone} />
      </span>
    </Tip>
  )
}

/** The dot's words end as a sentence, so a screen reader pauses before the row's next line. */
function sentence(text: string, locale: string) {
  return /[.!?…。！？]$/u.test(text) ? text : `${text}${/^(ja|zh)/u.test(locale) ? '。' : '.'}`
}

/**
 * An assistant's avatar dot and its words. Amber only when this assistant itself needs the
 * person (agent-attention.ts); a cause every assistant shares (this Mac's unlock, a sign-in,
 * Protons) and anything the app clears by itself is a quiet ring: the title bar's indicator
 * holds the one action, never a row per assistant.
 */
export function matrixListenerStatus(
  agent: MatrixAgentView,
  locale: keyof typeof matrixActionCopy,
  now = Date.now()
): { text: string; tone: StatusTone } | null {
  const copy = matrixActionCopy[locale]
  const asks: StatusTone = matrixAgentAttention(agent, now).state === 'needs_you' ? 'warn' : 'muted'

  if (agent.listening?.state === 'listening') {
    return { text: agent.listening.mode === 'continuous' ? copy.continuousListening : copy.listening, tone: 'good' }
  }

  // Another of your Macs answering for it is nothing to report (0.19.4 Q4).
  if (agent.listening?.state === 'paused' && agent.listening.reason === 'lease_elsewhere') {
    return null
  }

  if (agent.listening?.state === 'paused') {
    return {
      text: agent.listening.mode === 'continuous' ? copy.continuousListeningPaused : copy.listeningStopped,
      tone: asks
    }
  }

  if (
    agent.listening?.state === 'stopped' &&
    (agent.listening.result || ['unavailable', 'overflow'].includes(agent.listening.reason ?? ''))
  ) {
    return { text: copy.listeningStopped, tone: asks }
  }

  return agent.setup === 'failed' ||
    agent.setup === 'action_required' ||
    agent.readiness?.phase === 'blocked' ||
    agent.readiness?.phase === 'degraded'
    ? { text: '', tone: asks }
    : null
}

/** Whether a not-ready assistant's row offers Try again (or Reconnect): one rule for the button and
 * for the row's line, which must not say a Mac "answers" next to a button that says it is broken. */
function agentRetryKind(
  agent: MatrixAgentView,
  readinessAction: MatrixReadinessAction | undefined
): 'reconnect' | 'retry' | undefined {
  if (agent.setup === 'failed' || agent.setup === 'action_required') {
    return 'retry'
  }

  return readinessAction === 'reconnect' || readinessAction === 'retry' ? readinessAction : undefined
}

/** An assistant that is not ready says what to do: Try again (set up again, for the
 * default one whose setup did not finish), with the reason in its tip — only where trying
 * again can help (never for a Mac no longer allowed to run it). */
function AgentTryAgain({ agent, fail }: { agent: MatrixAgentView; fail(cause?: unknown): void }) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const words = useLaunchCopy()
  const [pending, setPending] = useState(false)

  const readiness = agent.readiness
    ? matrixReadinessCopy(agent.readiness, undefined, { ...t.matrixShell, ...words }, t.atum.startup.opening, locale)
    : undefined

  const kind = agentRetryKind(agent, readiness?.action)

  // Reconnect replaces this agent's executor on this Mac (agent-reenroll.ts).
  const reconnect = kind === 'reconnect'

  if (!kind) {
    return null
  }

  const reason = readiness?.title ?? t.matrixShell.agentUnavailable

  return (
    <Tip label={reason}>
      <Button
        className="me-1 shrink-0"
        data-matrix-agent-retry={reconnect ? 'reconnect' : 'retry'}
        disabled={pending}
        onClick={() => {
          setPending(true)

          const request = reconnect
            ? (window.atumMatrix.reconnectAgent?.(agent.principal) ?? window.atumMatrix.retryReadiness())
            : agent.isDefault && (agent.setup === 'failed' || agent.setup === 'action_required')
              ? window.atumMatrix.setupAssistant()
              : window.atumMatrix.retryReadiness()

          void request.catch(fail).finally(() => setPending(false))
        }}
        size="sm"
        variant="text"
      >
        {reconnect ? words.reconnect : chat.agentTryAgain}
      </Button>
    </Tip>
  )
}

/**
 * An agent's roster line when it is not simply ready, in plain words: waiting for this Mac's
 * recovery key or approval (never "not ready" for something the person can mend once for every
 * agent), reconnecting, needing the person's Reconnect, or a new sign-in on this Mac.
 */
export function matrixAgentStatusLine(
  agent: MatrixAgentView,
  status: ReturnType<typeof agentStatus>,
  shell: { agentSettingUp: string; agentUnavailable: string },
  words: { waitingUnlock: string; reconnectingTitle: string; reconnectShort: string; signInAgainShort: string },
  locale = 'en',
  /** Try again / Reconnect is on the row: the error is the line, never "On Mac mini" beside it. */
  offersRetry = false
): string | undefined {
  if (!status) {
    return undefined
  }

  if (agent.readiness?.phase === 'blocked') {
    switch (agent.readiness.code) {
      case 'recovery_required':
        return words.waitingUnlock

      case 'agent_reconnecting':
        return words.reconnectingTitle

      case 'agent_reconnect_required':

      case 'authority_withdrawn':
        return words.reconnectShort

      case 'device_replaced':
        return words.signInAgainShort
    }
  }

  // A standby Mac is not "not ready" while the policy answers elsewhere (§9.6). A specific
  // readiness reason above still wins: it says what this Mac needs, which stays true. So does an
  // error with a retry button: the button and a line saying it answers fine would disagree.
  if (status === 'agentUnavailable' && agent.executionPolicy && !offersRetry) {
    const answersElsewhere = executionPolicyRosterLine(locale, agent.executionPolicy)

    if (answersElsewhere) {
      return answersElsewhere
    }
  }

  return shell[status]
}

/**
 * Matrix's Atum roster, as Element lists rooms: one row per trusted agent and per chat, each
 * with its latest message and Element's badge. Clicking an assistant opens its newest chat
 * holding unread messages (else its newest) and opens its few latest histories under it, with
 * "Show more"; clicking it again folds them. Everything not proven to be an assistant's
 * private pair remains a normal Matrix conversation below. A row's actions are its context
 * menu; there is no chevron and no "…".
 */
export function MatrixRosterConversations({
  agentActions,
  assistantOpening,
  children,
  externalResultCount = 0,
  externalSearching = false,
  fail,
  onAppInfo,
  onEditAgent,
  onOpen,
  onOpenApp,
  openAgentChat,
  openAssistant,
  openingApp = null,
  query = '',
  snapshot
}: MatrixRosterConversationsProps) {
  const { locale, t } = useI18n()
  const copy = useMatrixCopy()
  const chat = useChatCopy()
  const launchWords = useLaunchCopy()
  const roster = useRosterCopy()
  const founderCopy = useFounderCopy()
  const appWords = useAppCopy()
  const ids = useId()
  const projectionAll = projectMatrixRoster(snapshot)
  const founderHandle = snapshot.founder?.handle
  const handles = useMatrixHandles(snapshot.identity?.userId)
  const roomPartner = (room: MatrixRoom) => (snapshot.identity ? directPartner(room, snapshot.identity.userId) : undefined)
  const roomHandle = (room: MatrixRoom) => {
    const partner = roomPartner(room)
    return partner ? handles[partner] : undefined
  }
  // Include assistants without a room: finding them must not depend on a chat existing.
  useMatrixHandleContacts(
    snapshot.identity?.userId,
    [...snapshot.rooms.map(roomPartner), ...(snapshot.agents ?? []).map(agent => agent.userId), ...(projectionAll.apps ?? []).map(entry=>entry.app.bot?.user_id)],
    Boolean(snapshot.domainEnabled)
  )

  // One account-wide read; only a cloud agent this Mac does not answer for has an access state.
  const cloudAccess = useMatrixCloudAccess(
    projectionAll.groups.some(({ agent }) => agent.answering === 'cloud' && agent.macRole !== 'answering')
  )

  const projection = filterMatrixRoster(
    projectionAll,
    query,
    t.matrixShell.assistantName,
    [founderCopy.name, founderCopy.subtitle, ...(founderHandle ? [founderHandle] : [])],
    app => app.bot?.display_name ?? appLocalizedCopy(app.name, locale, app.app),
    roomHandle,
    agent => handles[agent.userId]
  )

  // The Founder chat is drawn once, pinned first under Chats; never again among the others.
  const founder = projection.founder
  const rest = projection.rest.filter(room => room.id !== projectionAll.founder?.id)
  // Each app once; an official bot's chat lives in its row (roster-model.ts).
  const apps = projection.apps ?? []
  const placeholders = projection.placeholders ?? []
  const searching = Boolean(normalizeMatrixRosterQuery(query))
  const attentionNow = useMatrixAttentionNow(snapshot)
  const groups = new Map(projectionAll.groups.map(group => [group.agent.principal, group]))
  const appByRoom = new Map(apps.flatMap(entry => entry.room ? [[entry.room.id, entry] as const] : []))
  const chatEntries = [
    ...sortConversations([...rest, ...apps.flatMap(entry => entry.room ? [entry.room] : [])]).map(room => {
      const app = appByRoom.get(room.id)
      return app ? { kind: 'app' as const, ...app } : { kind: 'room' as const, room }
    }),
    ...apps.filter(entry => !entry.room).map(entry => ({ kind: 'app' as const, ...entry })),
    ...placeholders.map(placeholder => ({ kind: 'placeholder' as const, placeholder }))
  ]

  // An assistant is one row, its one conversation: never a count of its rooms.
  const resultCount =
    projection.groups.length +
    rest.length +
    (founder ? 1 : 0) +
    (projection.founderDraft ? 1 : 0) +
    apps.length +
    placeholders.length
  const totalResultCount = resultCount + externalResultCount

  const selectedRoom = snapshot.roomId ? snapshot.rooms.find(room => room.id === snapshot.roomId) : undefined

  // A bot's row is where you are while any chat of that bot is on screen, or the app's own view.
  const appSelected = (app: AppDescriptor) =>
    Boolean(selectedRoom && isAppBotRoom(selectedRoom, app)) ||
    (snapshot.destination?.kind === 'app' && snapshot.destination.appId === app.app_id)

  const appDisabled = (app: AppDescriptor) =>
    !onOpenApp ||
    Boolean(openingApp) ||
    snapshot.state !== 'ready' ||
    snapshot.apps?.state !== 'ready' ||
    app.availability !== 'available' ||
    Boolean(app.bot && (app.bot.state !== 'active' || !app.bot.device))

  const ready = snapshot.state === 'ready'
  const now = useMinuteClock()
  const workingCopy = useWorkingCopy()
  const workingRooms = matrixWorkingRooms(snapshot)

  const selectRoom = (roomId: string) => {
    closeFounderDraft()
    onOpen()
    void runMatrixCommand({ kind: 'select', roomId }).catch(fail)
  }

  // Arrow keys walk the rows, as in a list; Tab still visits each once.
  const walk = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !target.matches('[data-roster-row]')) {
      return
    }

    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-roster-row]')].filter(
      row => !row.disabled && !row.closest('[inert]')
    )

    const index = rows.indexOf(target as HTMLButtonElement)

    const next =
      event.key === 'ArrowDown'
        ? rows[index + 1]
        : event.key === 'ArrowUp'
          ? rows[index - 1]
          : event.key === 'Home'
            ? rows[0]
            : rows.at(-1)

    if (next) {
      event.preventDefault()
      next.focus()
    }
  }

  return (
    <nav aria-label={copy.title} className="flex flex-col gap-0.5" data-matrix-roster-conversations onKeyDown={walk}>
      <RosterMenuHost>
        <span aria-atomic aria-live="polite" className="sr-only" data-matrix-roster-results>
          {searching ? t.atum.roster.results(totalResultCount) : ''}
        </span>
        {searching && !externalSearching && totalResultCount === 0 && (
          <EmptyState
            className="min-h-32 px-3 text-(--atum-ink)"
            description={t.atum.roster.emptySearchHint}
            title={t.atum.roster.emptySearch}
          />
        )}
        {projection.groups.length > 0 && (
          <h2 className="px-2 pt-2 pb-1 text-(length:--atum-t-label) font-medium tracking-wide text-(--atum-ink-muted)">
            {t.atum.roster.assistants}
          </h2>
        )}
        {projection.groups.map(({ agent }) => {
          const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)
          // Search changes presentation, never the agent row's navigation, unread total or
          // current marker. Those still describe its full trusted history.
          const allRooms = groups.get(agent.principal)!.rooms

          const projectedConversation = resolveProjectedConversation(allRooms, snapshot.identity?.userId, agent.userId)
          const legacyConversation = projectedConversation.source === 'legacy'
          // One conversation per assistant: the row opens it and speaks for it alone. Rooms
          // marked earlier stay on the server, not on screen.
          const target = matrixAgentConversationRoom(allRooms, projectedConversation.main)
          const conversationRooms = legacyConversation ? allRooms : target ? [target] : []
          const here = conversationRooms.some(room => room.id === snapshot.roomId)
          const status = agentStatus(agent)

          const accessEnded = matrixAgentAccessEnded(agent, cloudAccess)

          const retryKind = agentRetryKind(
            agent,
            agent.readiness
              ? matrixReadinessCopy(
                  agent.readiness,
                  undefined,
                  { ...t.matrixShell, ...launchWords },
                  t.atum.startup.opening,
                  locale
                ).action
              : undefined
          )

          const statusLine = accessEnded
            ? matrixAgentAccessPausedLabel(locale)
            : matrixAgentStatusLine(agent, status, t.matrixShell, launchWords, locale, Boolean(retryKind))

          const pausedHire =
            agent.hire?.state === 'paused' && agent.assistantId
              ? hireRenewCopy[locale](new Intl.NumberFormat(locale).format(agent.hire.price_protons))
              : undefined

          const dot = matrixAgentDot(
            agent,
            locale,
            { ...t.matrixShell, ...launchWords },
            t.atum.startup.opening,
            attentionNow
          )

          // A shared cause says the same waiting words once on this row. Access ended is not a
          // Mac trouble: the row goes quietly off and says the one word the chat's band explains.
          if (accessEnded) {
            dot.dot = 'off'
            dot.label = matrixAgentAccessPausedLabel(locale)
          } else if (statusLine && matrixAgentAttention(agent, attentionNow).waitsOn) {
            dot.label = statusLine
          }

          const dotId = statusLine === dot.label ? undefined : `${ids}-${agent.principal}-dot`
          const workingRow = matrixAgentWorkingRow(agent, allRooms, [], workingRooms)
          const workingId = workingRow === 'agent' ? `matrix-agent-working-${agent.principal}` : undefined
          const workingRoom = allRooms.find(room => workingRooms.has(room.id))
          const workingPreview = workingRoom ? matrixWorkingStep(snapshot, workingRoom.id) : undefined
          // The row sums its conversation's badges and previews the chat its badge points at,
          // else its latest message (a fresh chat nobody wrote in has none).
          const badge = matrixRosterBadge(matrixAgentCounts(conversationRooms))

          const spoken = legacyConversation
            ? (allRooms.find(matrixRoomHasUnread) ?? allRooms.find(room => room.preview) ?? target)
            : target

          const preview = spoken ? matrixRosterPreview(spoken, roster, chat.messageDeleted) : undefined
          // A named agent with no chat yet starts one: its row is never a dead end.
          const reachable = ready && !assistantOpening && (agent.isDefault || Boolean(target) || Boolean(agent.userId))
          const statusId = status || accessEnded ? `matrix-agent-status-${agent.principal}` : undefined

          const badgeId = badge ? `matrix-agent-unread-${agent.principal}` : undefined

          const searchHandle = searching ? personHandleText(handles[agent.userId]) : undefined
          const previewId =
            !status && !accessEnded && (searchHandle || preview || agent.title) ? `${ids}-${agent.principal}-preview` : undefined

          const openAgent = () => {
            if (!reachable) {
              return
            }

            if (agent.isDefault) {
              void (target ? openAssistant(false, target.id) : openAssistant())
            } else if (target) {
              selectRoom(target.id)
            } else {
              void openAgentChat(agent)
            }
          }

          return (
            <section data-matrix-agent={agent.principal} key={agent.principal}>
              <RosterAgentMenu agent={agent} name={name} onEditAgent={onEditAgent} ready={ready}>
                <div className="atum-row flex h-12 items-center" data-current={here || undefined}>
                  <button
                    aria-busy={assistantOpening || undefined}
                    aria-current={here ? 'page' : undefined}
                    aria-describedby={
                      [dotId, statusId, workingId, previewId, badgeId].filter(Boolean).join(' ') || undefined
                    }
                    aria-label={name}
                    className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[inherit] ps-2 pe-2 text-left"
                    data-roster-row
                    disabled={!reachable}
                    onClick={openAgent}
                    onKeyDown={event => {
                      // ⌘I, Get Info: the assistant's card.
                      if (
                        onEditAgent &&
                        (event.metaKey || event.ctrlKey) &&
                        !event.altKey &&
                        !event.shiftKey &&
                        event.key.toLowerCase() === 'i'
                      ) {
                        event.preventDefault()
                        onEditAgent(agent)
                      }
                    }}
                    type="button"
                  >
                    <span className="atum-agent-face relative shrink-0">
                      <MatrixProfileAvatar
                        avatarUrl={agent.avatarUrl}
                        brand={agent.isDefault}
                        className={AVATAR}
                        id={agent.principal}
                        inset
                        mark={agent.mark}
                        name={name}
                        profile={agent.profile}
                        rosterAvatar
                        scopeKey={`${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`}
                        target={{ kind: 'agent', principal: agent.principal }}
                      />
                      <MatrixAgentStatusDot dot={dot.dot} label={dot.label} />
                      {dotId && (
                        <span className="sr-only" id={dotId}>
                          {sentence(dot.label, locale)}
                        </span>
                      )}
                    </span>
                    <RosterLines
                      badge={badge}
                      badgeId={badgeId}
                      preview={searchHandle ?? pausedHire?.[0] ?? statusLine ?? preview ?? agent.title}
                      previewId={statusId ?? previewId}
                      title={name}
                      working={!searching && workingRow === 'agent' ? workingCopy.working(name) : undefined}
                      workingId={workingId}
                      workingPreview={!searching && workingRow === 'agent' ? workingPreview : undefined}
                    />
                  </button>
                  {status === 'agentUnavailable' && <AgentTryAgain agent={agent} fail={fail} />}
                  {pausedHire && (
                    <Button
                      data-agent-hire-renew
                      disabled={!ready || !window.atumMatrix.renewAgent}
                      onClick={() =>
                        void window.atumMatrix.renewAgent!(agent.assistantId!)
                          .then(result => {
                            if ('refused' in result) {
                              void openMatrixTopUp(snapshot)
                            }
                          })
                          .catch(fail)
                      }
                      size="sm"
                      variant="text"
                    >
                      {pausedHire[1]}
                    </Button>
                  )}
                </div>
              </RosterAgentMenu>
            </section>
          )
        })}
        {!searching && agentActions}
        {(founder ||
          projection.founderDraft ||
          chatEntries.length > 0 ||
          (!searching && children)) && (
          <h2 className="px-2 pt-3 pb-1 text-(length:--atum-t-label) font-medium tracking-wide text-(--atum-ink-muted)">
            {t.atum.roster.specialists}
          </h2>
        )}
        {!founder && projection.founderDraft && (
          <FounderDraftRow
            disabled={!ready}
            now={now}
            onOpen={() => {
              onOpen()
              openFounderDraft()
            }}
          />
        )}
        {founder && (
          <MatrixRoomRow
            adornment={<VerifiedMark tier="official" />}
            avatar={<FounderAvatar size={32} />}
            data-matrix-founder-row="true"
            disabled={!ready}
            emptyPreview={founderCopy.subtitle}
            fail={fail}
            name={founderCopy.name}
            now={now}
            onOpen={() => selectRoom(founder.id)}
            profile={{ label: founderCopy.viewProfile, open: openFounderProfile }}
            room={founder}
            selected={founder.id === snapshot.roomId}
            snapshot={snapshot}
            subtitle={searching && founderHandle ? `@${founderHandle.replace(/^@/u, '')}` : undefined}
          />
        )}
        {projectionAll.founder && <FounderProfileSheet fail={fail} onOpenChat={onOpen} snapshot={snapshot} />}
        {chatEntries.map(entry => {
          if (entry.kind === 'room') {
            // A person's @handle: under the name while searching (finding someone), beside it
            // otherwise, where the second line is the conversation's own.
            const handle = roomHandle(entry.room)
            const handleBelow = searching ? personHandleText(handle) : undefined

            return <MatrixRoomRow
              disabled={!ready}
              fail={fail}
              handle={searching ? undefined : handle}
              key={entry.room.id}
              now={now}
              onOpen={() => selectRoom(entry.room.id)}
              room={entry.room}
              selected={entry.room.id === snapshot.roomId}
              snapshot={snapshot}
              subtitle={handleBelow}
              working={workingRooms.has(entry.room.id) ? workingCopy.assistantWorking : undefined}
              workingPreview={workingRooms.has(entry.room.id) ? matrixWorkingStep(snapshot, entry.room.id) : undefined}
            />
          }
          if (entry.kind === 'placeholder') {
            return <MatrixComingSoonRow key={entry.placeholder.app} placeholder={entry.placeholder} />
          }
          const { app, room } = entry
          if (!app.bot) {
            return (
              <RosterAppMenu key={app.app_id} onInfo={onAppInfo ? () => onAppInfo(app) : undefined}>
                <AppCatalogRow
                  app={app}
                  disabled={appDisabled(app)}
                  locale={locale}
                  onSelect={() => onOpenApp?.(app)}
                  pending={openingApp === app.app_id ? appWords.openingChat : undefined}
                  selected={appSelected(app)}
                />
              </RosterAppMenu>
            )
          }

          // While the bot cannot be opened (paused, starting, its catalog not loaded), its
          // chat is still the person's to read: the row selects that room as any chat row does.
          // Sending there stays main's call (it re-checks the bot before a send).
          const readable = appDisabled(app) ? appBotReadableRoom(room) : undefined
          const blocked = !ready || Boolean(openingApp)

          return (
            <MatrixAppBotRow
              app={{ ...app, bot: app.bot }}
              disabled={readable ? blocked : appDisabled(app)}
              key={app.app_id}
              locale={locale}
              now={now}
              onInfo={onAppInfo ? () => onAppInfo(app) : undefined}
              onOpen={() => (readable ? selectRoom(readable.id) : onOpenApp?.(app))}
              pending={openingApp === app.app_id ? appWords.openingChat : undefined}
              room={room}
              searchHandle={searching ? handles[app.bot.user_id] ?? app.bot.handle : undefined}
              selected={appSelected(app)}
            />
          )
        })}
        {!searching && children}
      </RosterMenuHost>
    </nav>
  )
}
