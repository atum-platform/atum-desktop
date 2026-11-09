import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Hash, Lock } from '@/lib/icons'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'

import type { ChannelAbilities } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { requestTeamSpaceIntent } from './intents'
import { useCompanyChannelFacts } from './use-channel-facts'
import { type CompanyChannelView, isDefaultChannel } from './views'

/** The channel's mark: a hash, or a lock when the channel is private. */
export function ChannelGlyph({ channel, className }: { channel: Pick<CompanyChannelView, 'visibility'> | undefined; className?: string }) {
  const { team } = useTeamSpaceCopy()

  return channel?.visibility === 'private' ? (
    <Lock aria-label={team.privateChannel} className={className} role="img" />
  ) : (
    <Hash aria-hidden className={className} />
  )
}

/**
 * What a channel is for: its own description, else for the default channel the localized line it
 * starts with (its name is localized on screen too, so one stored sentence would suit one language).
 */
export function channelDescription(
  channel: Pick<CompanyChannelView, 'purpose' | 'systemKey'>,
  team: Pick<MatrixTeamSpaceCopy, 'defaultChannelPurpose'>
): string {
  return channel.purpose.trim() || (isDefaultChannel(channel) ? team.defaultChannelPurpose : '')
}

/**
 * The channel header beside the name: one line after a hairline (Atum Kit, FlowTeamSpace), the
 * topic when there is one, else the description, so whoever opens a channel reads what it is for.
 * The line opens Channel details, where the whole of it is (Slack's and Mattermost's header). The
 * channel's people sit with search on the header's right (`MatrixCompanyMembersButton`).
 */
export function ChannelHeaderMeta({ channel }: { channel: CompanyChannelView | undefined }) {
  const { team } = useTeamSpaceCopy()
  const compact = useMediaQuery('(max-width: 780px)')

  if (!channel || channel.wire !== '1.4') {
    return null
  }

  const line = channel.topic.trim() || channelDescription(channel, team)

  return (
    <>
      {channel.visibility === 'private' && <span className="sr-only">{team.privateChannel}</span>}
      {line && !compact && (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-(--atum-line)" />
          <button
            className="atum-header-identity -mx-1 min-w-0 truncate rounded-md px-1 text-start text-[0.8125rem] text-(--atum-ink-muted)"
            data-matrix-channel-topic
            onClick={() => requestTeamSpaceIntent({ kind: 'channel-details', channelId: channel.id })}
            type="button"
          >
            {line}
          </button>
        </>
      )}
    </>
  )
}

/**
 * An archived channel is read-only and says so. The platform's own state closes the composer (Matrix
 * power levels are only the second line of defence), and this stands in the box's place: it says why
 * and, to those who may, offers the way back.
 */
export function ArchivedChannelBanner({ abilities, channel }: { abilities: Pick<ChannelAbilities, 'restore'>; channel: CompanyChannelView }) {
  const { team } = useTeamSpaceCopy()

  return (
    <NoticeBand data-matrix-channel-archived role="status" tone="notice">
      {team.archivedBanner}
      {abilities.restore && (
        <Button
          onClick={() => requestTeamSpaceIntent({ kind: 'restore-channel', channelId: channel.id })}
          size="sm"
          variant="text"
        >
          {team.restoreChannel}
        </Button>
      )}
    </NoticeBand>
  )
}

type RoomWithBinding = Pick<MatrixRoom, 'companyChannel'> & Partial<Pick<MatrixRoom, 'companyConversation' | 'id'>>

/** The header's mark for the open company channel. */
export function ChannelGlyphFor({ accountKey, className, room }: { accountKey: string; className?: string; room: RoomWithBinding }) {
  return <ChannelGlyph channel={useCompanyChannelFacts(accountKey, room).channel} className={className} />
}

/** The header's topic and member count for the open company channel. */
export function ChannelHeaderMetaFor({ accountKey, room }: { accountKey: string; room: RoomWithBinding }) {
  return <ChannelHeaderMeta channel={useCompanyChannelFacts(accountKey, room).channel} />
}

/** The open default channel keeps the same localized #general label as its sidebar row. */
export function ChannelTitleFor({ accountKey, fallback, room }: {
  accountKey: string
  fallback: string
  room: RoomWithBinding
}) {
  const { company, team } = useTeamSpaceCopy()
  const channel = useCompanyChannelFacts(accountKey, room).channel
  const title = channel && isDefaultChannel(channel) ? company.defaultChannelName : channel?.displayName ?? fallback

  return <span title={(channel && (channel.topic || channelDescription(channel, team))) || undefined}>{title}</span>
}

/** A channel's name as the person sees it everywhere (header, composer, sidebar row). */
export function useChannelTitle(accountKey: string, room: RoomWithBinding, fallback: string): string {
  const { company } = useTeamSpaceCopy()
  const channel = useCompanyChannelFacts(accountKey, room).channel

  return channel && isDefaultChannel(channel) ? company.defaultChannelName : channel?.displayName ?? fallback
}
