import { type ReactNode, useEffect, useState } from 'react'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge, MatrixCompanySnapshot11 } from '../../../shared/matrix-company'

import type { ChannelAbilities } from './abilities'
import { channelDescription, ChannelGlyph } from './channel-chrome'
import { useTeamSpaceCopy } from './copy'
import { requestTeamSpaceIntent } from './intents'
import { useCompanyChannelFacts } from './use-channel-facts'
import { type CompanyChannelView, isDefaultChannel, rosterName } from './views'

export interface ChannelIntroProps {
  channel: CompanyChannelView
  abilities: Pick<ChannelAbilities, 'addPeople' | 'edit'>
  /** The viewer may invite people to the company (the way into a public channel is the company). */
  canInvite: boolean
  /** Who made the channel, when the company's roster names them. */
  creatorName?: string
  /** When its room was made (the room's create event). */
  createdAt?: number
  /** Another step the empty channel offers after the intro's own (Ask the assistant). */
  extra?: ReactNode
  /** An empty channel's intro is the view's one call to act; above a history it stays quiet. */
  emphasis?: boolean
}

/**
 * The very start of a channel (Slack's "This is the very beginning", Mattermost's channel intro):
 * its name, what it is for, who made it and when, and the next step for this viewer. It opens the
 * history once nothing older is left, so whoever joins and scrolls back, or opens a young channel,
 * reads why it exists. Editors of a channel with no description are offered to write one.
 */
export function ChannelIntro({ abilities, canInvite, channel, createdAt, creatorName, emphasis, extra }: ChannelIntroProps) {
  const { company, locale, team } = useTeamSpaceCopy()
  const name = isDefaultChannel(channel) ? company.defaultChannelName : channel.displayName
  const description = channelDescription(channel, team)
  const archived = channel.state === 'archived'

  const date =
    createdAt !== undefined && Number.isFinite(createdAt)
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(createdAt))
      : undefined

  const made = date ? (creatorName ? team.channelCreatedBy(creatorName, date) : team.channelCreatedOn(date)) : undefined

  const actions = archived
    ? []
    : [
        abilities.addPeople
          ? { id: 'add-people', label: team.addPeople, run: () => requestTeamSpaceIntent({ kind: 'add-people', channelId: channel.id }) }
          : canInvite && channel.visibility === 'public'
            ? { id: 'invite', label: team.inviteTeammates, run: () => requestTeamSpaceIntent({ kind: 'invite-members' }) }
            : null,
        abilities.edit && !description
          ? { id: 'describe', label: team.addDescription, run: () => requestTeamSpaceIntent({ kind: 'channel-details', channelId: channel.id, field: 'purpose' }) }
          : null
      ].filter(action => action !== null)

  return (
    <section aria-label={team.channelStartTitle(name)} className="grid min-w-0 justify-items-start gap-1" data-matrix-channel-intro>
      <h2 className="flex min-w-0 max-w-full items-center gap-1.5 text-(--ak-ink) [font:var(--ak-t-title)]">
        <ChannelGlyph channel={channel} className="size-4.5 shrink-0" />
        <span className="min-w-0 break-words">{name}</span>
      </h2>
      {description && (
        <p className="max-w-[60ch] break-words text-(--ak-ink-2) [font:var(--ak-t-body)]" data-matrix-channel-intro-description>
          {description}
        </p>
      )}
      {made && <p className="text-(--ak-ink-3) [font:var(--ak-t-callout)]" data-matrix-channel-intro-made>{made}</p>}
      {(actions.length > 0 || extra) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <button
              className={emphasis && index === 0 ? 'ak-btn ak-btn--primary ak-btn--sm' : 'ak-btn ak-btn--sm'}
              data-matrix-channel-intro-action={action.id}
              key={action.id}
              onClick={action.run}
              type="button"
            >
              {action.label}
            </button>
          ))}
          {extra}
        </div>
      )}
    </section>
  )
}

function ChannelIntroPlaceholder({ extra, name }: { extra?: ReactNode; name: string }) {
  const { team } = useTeamSpaceCopy()

  return (
    <section aria-label={team.channelStartTitle(name)} className="grid min-w-0 justify-items-start gap-1" data-matrix-channel-intro>
      <h2 className="min-w-0 max-w-full break-words text-(--ak-ink) [font:var(--ak-t-title)]">{name}</h2>
      {extra && <div className="mt-2 flex flex-wrap gap-2">{extra}</div>}
    </section>
  )
}

type IntroRoom = Pick<MatrixRoom, 'companyChannel'> & Partial<Pick<MatrixRoom, 'companyConversation' | 'createdAt' | 'id'>>

/** Names read per account and company this session: one roster read serves every channel intro in it. */
const rosterNames = new Map<string, Promise<ReadonlyMap<string, string>>>()

async function readRoster(bridge: Pick<MatrixCompanyBridge, 'request'>, companyId: string) {
  const result = await bridge.request({ action: 'read', companyId })
  const value = result.ok ? result.value : undefined

  if (!value || !('members' in value) || !('schemaVersion' in value) || value.schemaVersion !== 2) {
    throw new Error('roster_unavailable')
  }

  // A person with neither a name nor a handle goes unnamed: "Created on…", never "Someone created…".
  return new Map((value as MatrixCompanySnapshot11).members.map(member => [member.memberRef, rosterName(member, '')]))
}

function startRosterRead(bridge: Pick<MatrixCompanyBridge, 'request'>, key: string, companyId: string) {
  const read = readRoster(bridge, companyId)

  read.catch(() => {
    if (rosterNames.get(key) === read) {
      rosterNames.delete(key)
    }
  })
  rosterNames.set(key, read)

  return read
}

/**
 * The display name of one member of a company. A name the cached roster does not have (someone who
 * joined since it was read) asks once more; a failed read is forgotten, so the next intro asks again.
 */
export async function companyMemberName(
  bridge: Pick<MatrixCompanyBridge, 'request'>,
  accountKey: string,
  companyId: string,
  memberRef: string
): Promise<string | undefined> {
  const key = `${accountKey}\n${companyId}`

  for (const fresh of [false, true]) {
    const read = (!fresh && rosterNames.get(key)) || startRosterRead(bridge, key, companyId)
    const name = (await read).get(memberRef)

    if (name || fresh) {
      return name || undefined
    }
  }
}

/** Forget the cached rosters (tests). */
export function clearChannelIntroNames(): void {
  rosterNames.clear()
}

/** The intro for the open company channel, from the workspace's stores and the company roster. */
export function ChannelIntroFor({
  accountKey,
  bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.companies,
  emphasis,
  extra,
  placeholderName,
  room
}: {
  accountKey: string
  bridge?: Pick<MatrixCompanyBridge, 'request'>
  emphasis?: boolean
  extra?: ReactNode
  /** An empty channel names itself by its room while the directory is still on its way. */
  placeholderName?: string
  room: IntroRoom
}) {
  const facts = useCompanyChannelFacts(accountKey, room)
  const channel = facts.channel
  const owner = channel?.ownerMemberRef
  const [creator, setCreator] = useState<{ ref: string; name: string }>()

  const companyId = channel?.companyId

  useEffect(() => {
    if (!bridge || !companyId || !owner) {
      return
    }

    let live = true

    companyMemberName(bridge, accountKey, companyId, owner)
      .then(name => {
        if (live && name) {
          setCreator({ ref: owner, name })
        }
      })
      .catch(() => {})

    return () => {
      live = false
    }
  }, [accountKey, bridge, companyId, owner])

  // Until the platform's directory names the channel, nothing it says is drawn: at most the room's name.
  if (!channel) {
    return placeholderName ? <ChannelIntroPlaceholder extra={extra} name={placeholderName} /> : null
  }

  return (
    <ChannelIntro
      abilities={facts.abilities}
      canInvite={facts.company.invite}
      channel={channel}
      createdAt={room.createdAt}
      creatorName={creator?.ref === owner ? creator?.name : undefined}
      emphasis={emphasis}
      extra={extra}
    />
  )
}
