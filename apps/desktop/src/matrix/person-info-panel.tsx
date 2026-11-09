import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import type { AtumShellFrameMotion } from '@/app/atum/shell-frame'
import { AtumWorkspaceSurface } from '@/app/atum/workspace-surface'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  ArrowDown,
  Bell,
  BellOff,
  Building,
  Calendar,
  ChevronLeft,
  Flag,
  Info,
  Link,
  Lock,
  LogOut,
  Movie,
  Play,
  ShieldLock,
  Trash2,
  Users
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixRoomSharedItem, MatrixRoomSharedSection } from '../../shared/matrix-room-shared'

import { useChatCopy } from './chat-copy'
import { matrixChatDate, matrixChatTitle } from './chat-title'
import { MatrixMembers } from './conversation-controls'
import { useMatrixChatActions } from './conversation-menu'
import { MatrixFileGlyph } from './file-glyph'
import { openMatrixMarkdownLink } from './markdown-host'
import { MatrixMemberAvatar } from './member-avatar'
import { MatrixFileSave, matrixFileSize } from './message-actions'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { useMatrixPeople } from './person-handles'
import { type MatrixPersonInfoCopy, matrixPersonInfoCopy } from './person-info-copy'
import {
  type MatrixConversationInfo,
  type MatrixRoomSharedState,
  matrixSharedCompanies,
  matrixSharedRevision,
  useMatrixRoomShared,
  useMatrixRoomSharedThumbnail
} from './person-info-model'
import { matrixMemberLabel } from './person-name'
import { useMatrixPresence } from './presence-store'
import { matrixPresenceLabel, MatrixPresenceLine } from './presence-view'
import { runMatrixCommand } from './text-document-actions'

/** Items each section shows before "See all", and one "See all" read's size. */
const PREVIEW = { media: 6, files: 3, links: 3 } as const
const PAGE = 30

interface PanelProps {
  compact: boolean
  expanded: boolean
  fail(cause?: unknown): void
  hidden: boolean
  info: MatrixConversationInfo
  motion: AtumShellFrameMotion
  onClose(): void
  onExpand(value: boolean): void
  onPercentChange(value: number): void
  percent: number
  room: MatrixRoom
  snapshot: MatrixSnapshot
  windowControls: ReactNode
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixPersonInfoPanel(props: PanelProps) {
  // Everything the panel holds (a "See all" page, a dialog) belongs to one chat.
  return <PersonInfoPanelFor key={props.room.id} {...props} />
}

function PersonInfoPanelFor({
  compact,
  expanded,
  fail,
  hidden,
  info,
  motion,
  onClose,
  onExpand,
  onPercentChange,
  percent,
  room,
  snapshot,
  windowControls
}: PanelProps) {
  const { locale } = useI18n()
  const copy = matrixPersonInfoCopy(locale)
  const panelId = useId()
  const [section, setSection] = useState<MatrixRoomSharedSection | null>(null)
  const title = info.kind === 'person' ? copy.conversationInfo : copy.groupInfo

  return (
    <AtumWorkspaceSurface
      activeId="info"
      drawer={compact}
      fullFrame={expanded}
      hidden={hidden}
      motionPhase={motion.phase}
      onActivate={() => setSection(null)}
      onClose={onClose}
      onCloseTab={onClose}
      onExpand={onExpand}
      onMotionEnd={motion.finishExit}
      onPercentChange={onPercentChange}
      panelId={panelId}
      percent={percent}
      tabs={[{ id: 'info', title, icon: <Info aria-hidden className="size-3.5" />, pinned: true }]}
      windowControls={windowControls}
    >
      <div className="h-full min-h-0 overflow-y-auto px-3 pb-6" data-matrix-person-info={info.kind}>
        {section ? (
          <SharedSectionPage
            copy={copy}
            onBack={() => setSection(null)}
            room={room}
            section={section}
            snapshot={snapshot}
          />
        ) : (
          <InfoHome copy={copy} fail={fail} info={info} onSeeAll={setSection} room={room} snapshot={snapshot} />
        )}
      </div>
    </AtumWorkspaceSurface>
  )
}

function InfoHome({
  copy,
  fail,
  info,
  onSeeAll,
  room,
  snapshot
}: {
  copy: MatrixPersonInfoCopy
  fail(cause?: unknown): void
  info: MatrixConversationInfo
  onSeeAll(section: MatrixRoomSharedSection): void
  room: MatrixRoom
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const chat = useChatCopy()
  const chatActions = useMatrixChatActions(room, snapshot, fail)
  const { actions, blocked, confirm, dialogs, low, lowable, mute, ready, report, reportable, unblock } = chatActions

  return (
    <>
      {info.kind === 'person' ? (
        <PersonIdentity room={room} snapshot={snapshot} userId={info.userId} />
      ) : (
        <GroupIdentity copy={copy} room={room} snapshot={snapshot} />
      )}
      {info.kind === 'person' && <SharedTeamSpaces copy={copy} snapshot={snapshot} userId={info.userId} />}
      <h3 className="ak-section">{copy.conversation}</h3>
      <div className="ak-group ak-group--plain" data-matrix-person-info-conversation>
        <div className="ak-row" data-matrix-person-info-encryption={room.encrypted ? 'encrypted' : 'plain'}>
          {room.encrypted ? (
            <ShieldLock aria-hidden className="ak-icon size-4" />
          ) : (
            <Lock aria-hidden className="ak-icon size-4" />
          )}
          <span className="ak-row-main">{room.encrypted ? copy.encrypted : copy.notEncrypted}</span>
        </div>
        {room.createdAt !== undefined && (
          <div className="ak-row">
            <Calendar aria-hidden className="ak-icon size-4" />
            <span className="ak-row-main">{copy.started(matrixChatDate(room.createdAt, locale))}</span>
          </div>
        )}
        <label className="ak-row">
          {mute.value ? (
            <BellOff aria-hidden className="ak-icon size-4" />
          ) : (
            <Bell aria-hidden className="ak-icon size-4" />
          )}
          <span className="ak-row-main">{copy.muteNotifications}</span>
          <Switch
            aria-label={copy.muteNotifications}
            checked={mute.value}
            data-matrix-person-info-mute
            disabled={!ready || mute.busy}
            onCheckedChange={() => mute.toggle()}
          />
        </label>
        {lowable && (
          <label className="ak-row">
            <ArrowDown aria-hidden className="ak-icon size-4" />
            <span className="ak-row-main">{copy.lowPriority}</span>
            <Switch
              aria-label={copy.lowPriority}
              checked={low.value}
              data-matrix-person-info-low-priority
              disabled={!ready || low.busy}
              onCheckedChange={() => low.toggle()}
            />
          </label>
        )}
      </div>
      <SharedPreview copy={copy} onSeeAll={onSeeAll} room={room} section="media" snapshot={snapshot} />
      <SharedPreview copy={copy} onSeeAll={onSeeAll} room={room} section="files" snapshot={snapshot} />
      <SharedPreview copy={copy} onSeeAll={onSeeAll} room={room} section="links" snapshot={snapshot} />
      {(reportable || actions.person || actions.end) && (
        <div className="ak-group ak-group--plain mt-4" data-matrix-person-info-actions>
          {reportable && (
            <button
              className="ak-row w-full text-left"
              data-matrix-person-info-report
              disabled={!ready}
              onClick={report}
              type="button"
            >
              <Flag aria-hidden className="ak-icon size-4" />
              <span className="ak-row-main">{chat.reportPerson}</span>
            </button>
          )}
          {actions.person && (
            <button
              className="ak-row w-full text-left"
              data-matrix-person-info-block={blocked ? 'unblock' : 'block'}
              disabled={!ready}
              onClick={() => (blocked ? unblock() : confirm('block'))}
              type="button"
            >
              <Users aria-hidden className="ak-icon size-4" />
              <span className="ak-row-main">{blocked ? chat.unblockPerson : chat.blockPerson}</span>
            </button>
          )}
          {actions.end && (
            <button
              className="ak-row w-full text-left text-(--ak-danger)"
              data-matrix-person-info-end={actions.end}
              disabled={!ready}
              onClick={() => confirm(actions.end!)}
              type="button"
            >
              {actions.end === 'leave' ? (
                <LogOut aria-hidden className="size-4 text-(--ak-danger)" />
              ) : (
                <Trash2 aria-hidden className="size-4 text-(--ak-danger)" />
              )}
              <span className="ak-row-main">{actions.end === 'leave' ? chat.leave : chat.deleteChat}</span>
            </button>
          )}
        </div>
      )}
      {dialogs}
    </>
  )
}

/** The person: their face, their name, their verified @handle, and their status when known. */
function PersonIdentity({ room, snapshot, userId }: { room: MatrixRoom; snapshot: MatrixSnapshot; userId?: string }) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const people = useMatrixPeople(snapshot.members, snapshot.identity?.userId)
  const presence = useMatrixPresence(userId)
  const member = userId ? snapshot.members?.find(value => value.userId === userId) : undefined
  // Who this is, with their @handle under the name: the panel is about the person, not the chat.
  useMatrixHandleContacts(snapshot.identity?.userId, [userId], Boolean(snapshot.domainEnabled))

  const label = userId
    ? matrixMemberLabel(member ?? { userId, name: '' }, people)
    : { name: matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn }) }

  // A chat the person named themselves keeps its name; the person is still who they are.
  const name = room.title?.trim() || label.name
  const state = presence ? matrixPresenceLabel({ ...presence, status: undefined }, locale) : ''

  return (
    <div className="flex flex-col items-center gap-1 px-2 pt-5 pb-3 text-center" data-matrix-person-info-identity>
      {userId ? (
        <MatrixMemberAvatar
          avatarMxc={member?.avatarMxc ?? room.peerAvatarMxc}
          className="mb-2 size-16 text-2xl"
          id={userId}
          name={label.name}
        />
      ) : (
        <AtumAssistantAvatar className="mb-2 size-16 rounded-full text-2xl" id={room.id} name={name} />
      )}
      <h2 className="max-w-full truncate [font:var(--ak-t-title)] text-(--ak-ink)">{name}</h2>
      {'address' in label && label.address && (
        <p className="max-w-full truncate [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-matrix-person-info-handle>
          {label.address}
        </p>
      )}
      {state && (
        <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)" data-matrix-person-info-presence>
          {state}
        </p>
      )}
      <MatrixPresenceLine presence={presence} />
    </div>
  )
}

/** A group: its name, its topic, how many are in it (opening the same members list as the header). */
function GroupIdentity({
  copy,
  room,
  snapshot
}: {
  copy: MatrixPersonInfoCopy
  room: MatrixRoom
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const chat = useChatCopy()
  const [members, setMembers] = useState(false)
  const joined = room.participants?.filter(member => member.membership === 'join').length ?? 0
  const name = matrixChatTitle(room, { locale, untitled: t.atum.roster.untitledChat, chatOn: chat.chatOn })

  return (
    <div className="flex flex-col items-center gap-1 px-2 pt-5 pb-3 text-center" data-matrix-person-info-identity>
      <AtumAssistantAvatar className="mb-2 size-16 rounded-full text-2xl" id={room.id} name={name} />
      <h2 className="max-w-full truncate [font:var(--ak-t-title)] text-(--ak-ink)">{name}</h2>
      {room.topic && <p className="line-clamp-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)">{room.topic}</p>}
      {joined > 0 && (
        <Button
          className="mt-1"
          data-matrix-person-info-members
          onClick={() => setMembers(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Users aria-hidden />
          {copy.members(joined)}
        </Button>
      )}
      <MatrixMembers onOpenChange={setMembers} open={members} room={room} snapshot={snapshot} />
    </div>
  )
}

/** The Team Spaces both of you are in, by name once the platform has named them. */
function SharedTeamSpaces({
  copy,
  snapshot,
  userId
}: {
  copy: MatrixPersonInfoCopy
  snapshot: MatrixSnapshot
  userId?: string
}) {
  const ids = matrixSharedCompanies(snapshot, userId)
  const key = ids.join(',')
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    const bridge = window.atumMatrix.companies

    if (!key || !bridge) {
      return
    }

    let live = true

    void bridge
      .request({ action: 'list' })
      .then(result => {
        if (live && result.ok && 'companies' in result.value) {
          setNames(new Map(result.value.companies.map(company => [company.id, company.displayName])))
        }
      })
      .catch(() => {})

    return () => {
      live = false
    }
  }, [key])

  const named = ids.flatMap(id => (names.get(id) ? [{ id, name: names.get(id)! }] : []))

  if (!named.length) {
    return null
  }

  return (
    <>
      <h3 className="ak-section">{copy.teamSpaces}</h3>
      <div className="ak-group ak-group--plain" data-matrix-person-info-team-spaces>
        {named.map(company => (
          <div className="ak-row" key={company.id}>
            <Building aria-hidden className="ak-icon size-4" />
            <span className="ak-row-main truncate">{company.name}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** What would make a section stale, read from the open chat's loaded messages only. */
function sharedRevision(room: MatrixRoom, section: MatrixRoomSharedSection, snapshot: MatrixSnapshot) {
  return matrixSharedRevision(snapshot.roomId === room.id ? snapshot.messages : [], section)
}

function sectionTitle(copy: MatrixPersonInfoCopy, section: MatrixRoomSharedSection) {
  return section === 'media' ? copy.media : section === 'files' ? copy.files : copy.links
}

/**
 * One section's newest few, with "See all" once there is anything to see or older history still
 * unread (a capped read can find nothing in recent messages, e.g. an encrypted chat of text).
 */
function SharedPreview({
  copy,
  onSeeAll,
  room,
  section,
  snapshot
}: {
  copy: MatrixPersonInfoCopy
  onSeeAll(section: MatrixRoomSharedSection): void
  room: MatrixRoom
  section: MatrixRoomSharedSection
  snapshot: MatrixSnapshot
}) {
  const shared = useMatrixRoomShared(room.id, section, PREVIEW[section], sharedRevision(room, section, snapshot))
  const seeAll = section === 'media' ? copy.seeAllMedia : section === 'files' ? copy.seeAllFiles : copy.seeAllLinks
  const items = shared.items.slice(0, PREVIEW[section])

  return (
    <section aria-label={sectionTitle(copy, section)} data-matrix-person-info-section={section}>
      <div className="flex items-center justify-between pe-1">
        <h3 className="ak-section">{sectionTitle(copy, section)}</h3>
        {shared.state === 'ready' && (items.length > 0 || shared.more) && (
          <Button
            aria-label={seeAll}
            data-matrix-person-info-see-all={section}
            onClick={() => onSeeAll(section)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {copy.seeAll}
          </Button>
        )}
      </div>
      <SharedItems copy={copy} room={room} section={section} shared={{ ...shared, items }} />
    </section>
  )
}

/** "See all": the whole section, newest first, read one bounded page at a time. */
function SharedSectionPage({
  copy,
  onBack,
  room,
  section,
  snapshot
}: {
  copy: MatrixPersonInfoCopy
  onBack(): void
  room: MatrixRoom
  section: MatrixRoomSharedSection
  snapshot: MatrixSnapshot
}) {
  // The same revision as the previews: a new photo, file or link appears here too, merged with
  // the pages already loaded.
  const shared = useMatrixRoomShared(room.id, section, PAGE, sharedRevision(room, section, snapshot))

  return (
    <section aria-label={sectionTitle(copy, section)} data-matrix-person-info-all={section}>
      <div className="flex items-center gap-1 pt-2 pb-1">
        <Tip label={copy.back}>
          <Button
            aria-label={copy.back}
            data-matrix-person-info-back
            onClick={onBack}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeft aria-hidden />
          </Button>
        </Tip>
        <h3 className="[font:var(--ak-t-headline)] text-(--ak-ink)">{sectionTitle(copy, section)}</h3>
      </div>
      <SharedItems copy={copy} room={room} section={section} shared={shared} />
      {shared.state === 'ready' && shared.more && (
        <div className="flex justify-center pt-3">
          <Button
            data-matrix-person-info-more
            disabled={shared.loadingMore}
            onClick={shared.loadMore}
            size="sm"
            type="button"
            variant="ghost"
          >
            {shared.loadingMore ? copy.loading : copy.loadMore}
          </Button>
        </div>
      )}
      {shared.state === 'ready' && shared.unreadable > 0 && (
        <p className="px-2.5 pt-3 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-matrix-person-info-unreadable>
          {copy.unreadable(shared.unreadable)}
        </p>
      )}
    </section>
  )
}

function SharedItems({
  copy,
  room,
  section,
  shared
}: {
  copy: MatrixPersonInfoCopy
  room: MatrixRoom
  section: MatrixRoomSharedSection
  shared: MatrixRoomSharedState
}) {
  if (shared.state === 'loading') {
    return section === 'media' ? (
      <div aria-busy className="grid grid-cols-3 gap-1 px-2.5" data-matrix-person-info-loading={section}>
        {Array.from({ length: 3 }, (_, index) => (
          <span className="ak-skeleton aspect-square rounded-(--ak-r-sm)" key={index} />
        ))}
      </div>
    ) : (
      <p
        aria-busy
        className="px-2.5 py-2 [font:var(--ak-t-callout)] text-(--ak-ink-3)"
        data-matrix-person-info-loading={section}
      >
        {copy.loading}
      </p>
    )
  }

  if (shared.state === 'failed') {
    return (
      <p
        className="flex items-center gap-2 px-2.5 py-2 [font:var(--ak-t-callout)] text-(--ak-ink-3)"
        data-matrix-person-info-failed={section}
      >
        {copy.failed}
        <Button onClick={shared.retry} size="sm" type="button" variant="ghost">
          {copy.tryAgain}
        </Button>
      </p>
    )
  }

  if (!shared.items.length) {
    return (
      <p
        className="px-2.5 py-3 text-center [font:var(--ak-t-callout)] text-(--ak-ink-3)"
        data-matrix-person-info-empty={section}
        data-matrix-person-info-scan={shared.more ? 'partial' : 'complete'}
      >
        {shared.more
          ? copy.noneRecent
          : section === 'media'
            ? copy.noMedia
            : section === 'files'
              ? copy.noFiles
              : copy.noLinks}
      </p>
    )
  }

  if (section === 'media') {
    return (
      <ul className="grid grid-cols-3 gap-1 px-2.5" data-matrix-person-info-items={section}>
        {shared.items.map(item => (
          <li key={item.id}>
            <MediaTile copy={copy} item={item} room={room} />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="ak-group ak-group--plain" data-matrix-person-info-items={section}>
      {shared.items.map(item => (
        <li key={item.id}>
          {section === 'files' ? <FileRow item={item} room={room} /> : <LinkRow copy={copy} item={item} />}
        </li>
      ))}
    </ul>
  )
}

function save(room: MatrixRoom, item: MatrixRoomSharedItem) {
  void runMatrixCommand({ kind: 'download', roomId: room.id, eventId: item.eventId }).catch(() => {})
}

/** A photo or video: its picture (or its kind), saved with one click like a file in the chat. */
function MediaTile({ copy, item, room }: { copy: MatrixPersonInfoCopy; item: MatrixRoomSharedItem; room: MatrixRoom }) {
  const { locale } = useI18n()
  const chat = useChatCopy()
  const picture = useMatrixRoomSharedThumbnail(room.id, item)
  const name = item.name ?? (item.kind === 'video' ? copy.video : chat.save)
  const label = copy.mediaLabel(name, matrixChatDate(item.at, locale))

  return (
    <Tip label={chat.saveFile(name)}>
      <button
        aria-label={label}
        className={cn(
          'relative grid aspect-square w-full place-items-center overflow-hidden rounded-(--ak-r-sm) bg-(--ak-sunk) text-(--ak-ink-3)',
          picture === undefined && 'ak-skeleton'
        )}
        data-matrix-person-info-media={item.kind}
        onClick={() => save(room, item)}
        type="button"
      >
        {picture ? (
          <img alt="" className="size-full object-cover" draggable={false} src={picture} />
        ) : picture === null ? (
          item.kind === 'video' ? (
            <Movie aria-hidden className="size-5" />
          ) : (
            <MatrixFileGlyph className="size-5" name={item.name ?? 'image.jpg'} />
          )
        ) : null}
        {item.kind === 'video' && picture && (
          <span className="absolute grid size-7 place-items-center rounded-full bg-(--ak-ink)/60 text-(--ak-on-ink)">
            <Play aria-hidden className="size-3.5" />
          </span>
        )}
      </button>
    </Tip>
  )
}

function FileRow({ item, room }: { item: MatrixRoomSharedItem; room: MatrixRoom }) {
  const { locale } = useI18n()
  const name = item.name ?? '…'

  const meta = [
    item.size !== undefined ? matrixFileSize(item.size, locale) : undefined,
    matrixChatDate(item.at, locale)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="ak-row" data-matrix-person-info-file={item.eventId}>
      <span className="grid size-8 shrink-0 place-items-center rounded-(--ak-r-md) bg-(--ak-sunk) text-(--ak-ink-3)">
        <MatrixFileGlyph className="size-4" name={name} />
      </span>
      <span className="ak-row-main">
        <span className="truncate [font:var(--ak-t-body-strong)]">{name}</span>
        <span className="ak-row-meta">{meta}</span>
      </span>
      <MatrixFileSave name={name} onSave={() => save(room, item)} />
    </div>
  )
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}

function LinkRow({ copy, item }: { copy: MatrixPersonInfoCopy; item: MatrixRoomSharedItem }) {
  const url = item.url ?? ''
  const host = useMemo(() => linkHost(url), [url])

  return (
    <button
      aria-label={copy.openLink(url)}
      className="ak-row w-full text-left"
      data-matrix-person-info-link={url}
      onClick={() => void openMatrixMarkdownLink(url).catch(() => {})}
      type="button"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-(--ak-r-md) bg-(--ak-sunk) text-(--ak-ink-3)">
        <Link aria-hidden className="size-4" />
      </span>
      <span className="ak-row-main">
        <span className="truncate [font:var(--ak-t-body-strong)]">{host}</span>
        <span className="ak-row-meta">{url}</span>
      </span>
    </button>
  )
}
