import { useEffect, useRef, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { Hash, Plus } from '@/lib/icons'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { focusDialogField, MatrixDialogHeader } from '../dialog-header'

import type { CompanyAbilities } from './abilities'
import { channelDescription } from './channel-chrome'
import { useTeamSpaceCopy } from './copy'
import { loadJoinableChannelBrowse } from './discovery-store'
import { companyErrorText, outcomeText, type TeamSpaceMutate } from './outcome'
import { requestTeamSpace } from './request'
import { isDefaultChannel, type PublicChannelView, publicChannelView, sortChannels } from './views'

export interface ChannelBrowserDialogProps {
  open: boolean
  onClose(): void
  accountKey: string
  bridge: MatrixCompanyBridge
  companyId: string
  abilities: Pick<CompanyAbilities, 'createChannel' | 'creationBlocked'>
  mutate: TeamSpaceMutate
  /** Opens a channel the viewer is already in; the dialog closes. */
  onOpenChannel(channelId: string): void
  /** The platform admitted the channel; the workspace opens it once its room is ready. */
  onJoined(channelId: string): void
  onCreate(): void
}

type Filter = 'archived' | 'public'

/**
 * Mattermost's "Browse channels": every public channel's name, purpose, size and whether you are in
 * it, searchable by name, with Archived apart. Private channels never appear here (the platform
 * does not send them); being listed grants nothing, and a channel's content still needs admission.
 * The additive 1.6 browse carries the platform generation required by Join. Older platforms fall
 * back to their read-only 1.4 list instead of guessing that generation.
 */
export function ChannelBrowserDialog({
  abilities,
  accountKey,
  bridge,
  companyId,
  mutate,
  onClose,
  onCreate,
  onJoined,
  onOpenChannel,
  open
}: ChannelBrowserDialogProps) {
  const { company, locale, team } = useTeamSpaceCopy()
  const [channels, setChannels] = useState<readonly PublicChannelView[]>()
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<Filter>('public')
  const [joining, setJoining] = useState<string>()
  const [joinError, setJoinError] = useState<string>()
  const [query, setQuery] = useState('')
  const attempt = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }

    const mine = ++attempt.current
    setChannels(undefined)
    setFailed(false)
    setFilter('public')
    setJoining(undefined)
    setJoinError(undefined)
    setQuery('')

    void loadJoinableChannelBrowse(bridge, accountKey, companyId, { force: true }).then(async joinable => {
      if (attempt.current !== mine) {
        return
      }

      if (joinable.ok) {
        setChannels(joinable.value.channels.map(publicChannelView))

        return
      }

      // 1.6 is an additive direct probe, not part of the ordered capability prefix. An older
      // platform keeps Browse useful through its read-only 1.4 response.
      if (joinable.error !== 'missing' && joinable.error !== 'invalid') {
        setFailed(true)

        return
      }

      const legacy = await requestTeamSpace(bridge, { action: 'browse-channels', companyId })

      if (attempt.current !== mine) {
        return
      }

      if (legacy.ok) {
        setChannels(legacy.value.channels.map(publicChannelView))

        return
      }

      setFailed(true)
    })

    return () => {
      attempt.current += 1
    }
  }, [accountKey, bridge, companyId, open])

  const needle = query.trim().toLocaleLowerCase(locale)

  const shown = sortChannels(
    (channels ?? []).filter(
      channel =>
        (filter === 'archived') === (channel.state === 'archived') &&
        (needle === '' || (isDefaultChannel(channel) ? company.defaultChannelName : channel.displayName)
          .toLocaleLowerCase(locale)
          .includes(needle))
    ),
    locale
  )

  const join = async (channel: PublicChannelView) => {
    if (joining || channel.channelGeneration === undefined || channel.state === 'archived') {
      return
    }

    const mine = attempt.current
    setJoining(channel.id)
    setJoinError(undefined)

    // Another member joining advances the shared channel generation. Read it again at the click,
    // so a sheet left open for a while does not submit the generation it first painted.
    const refreshed = await loadJoinableChannelBrowse(bridge, accountKey, companyId, { force: true })

    if (attempt.current !== mine) {
      return
    }

    if (!refreshed.ok) {
      setJoining(undefined)
      setJoinError(companyErrorText(refreshed.error, company))

      return
    }

    const next = refreshed.value.channels.map(publicChannelView)
    const fresh = next.find(candidate => candidate.id === channel.id)
    setChannels(next)

    if (!fresh) {
      setJoining(undefined)
      setJoinError(company.missing)

      return
    }

    if (fresh.state === 'archived') {
      setJoining(undefined)
      setJoinError(team.refusal.channel_archived)

      return
    }

    if (fresh.joined) {
      onClose()
      onJoined(fresh.id)

      return
    }

    if (fresh.channelGeneration === undefined) {
      setJoining(undefined)
      setJoinError(company.unavailable)

      return
    }

    const outcome = await mutate({
      action: 'channel-command',
      companyId,
      channelId: fresh.id,
      command: {
        requestId: globalThis.crypto.randomUUID(),
        operation: 'join',
        expectedChannelGeneration: fresh.channelGeneration
      }
    })

    if (attempt.current !== mine) {
      return
    }

    setJoining(undefined)

    if (!outcome) {
      setJoinError(company.unavailable)

      return
    }

    if (outcome.ok) {
      onClose()
      onJoined(fresh.id)

      return
    }

    if (outcome.uncertain) {
      // The workspace journal owns the one request and its Retry; never start a second join here.
      onClose()

      return
    }

    setJoinError(outcomeText(outcome, team, company))
  }

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-xl"
        data-matrix-company-browse
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={team.browseTitle} />
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={team.browseSearchLabel}
              className="min-w-40 flex-1"
              onChange={event => setQuery(event.target.value)}
              placeholder={team.browseSearchLabel}
              value={query}
            />
            <AtumSegmented<Filter>
              label={team.browseTitle}
              onChange={setFilter}
              options={[
                { id: 'public', label: team.browseFilterPublic },
                { id: 'archived', label: team.browseFilterArchived }
              ]}
              value={filter}
            />
            {abilities.createChannel && (
              <Button onClick={onCreate} size="sm" variant="secondary">
                <Plus aria-hidden />
                {team.createChannelItem}
              </Button>
            )}
          </div>

          {channels === undefined && !failed && <Loader className="size-5" label={company.loadingChannels} size="sm" />}
          {failed && <p className="text-sm text-destructive" role="alert">{team.browseLoadFailed}</p>}
          {channels && shown.length === 0 && (
            <p className="text-sm text-(--atum-ink-muted)">
              {channels.some(channel => (filter === 'archived') === (channel.state === 'archived')) ? team.browseEmpty : team.browseNone}
            </p>
          )}

          {shown.length > 0 && (
            <ul aria-label={team.browseTitle} className="grid max-h-80 gap-1 overflow-y-auto">
              {shown.map(channel => {
                const label = isDefaultChannel(channel) ? company.defaultChannelName : channel.displayName
                const about = channelDescription(channel, team)

                return (
                  <li className="flex items-center gap-3 rounded-(--atum-r-control) px-2 py-1.5 text-sm" data-browse-channel={channel.id} key={channel.id}>
                    <Hash aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate font-medium text-(--atum-ink)">{label}</span>
                      <span className="truncate text-xs text-(--atum-ink-muted)">
                        {team.channelMemberCount(channel.memberCount)}
                        {about ? ` · ${about}` : ''}
                      </span>
                    </span>
                    {channel.joined ? (
                      <>
                        <span className="rounded-full border border-(--atum-line) px-2 py-0.5 text-xs text-(--atum-ink-muted)">
                          {team.joinedBadge}
                        </span>
                        <Button disabled={joining !== undefined} onClick={() => onOpenChannel(channel.id)} size="sm" variant="secondary">
                          {team.openChannelAction}
                        </Button>
                      </>
                    ) : channel.state === 'archived' ? null : (
                      channel.channelGeneration === undefined ? (
                        <Tip label={team.browseJoinUnavailable}>
                          {/* A disabled button takes no pointer events, so the tip hangs on its wrapper. */}
                          <span className="inline-flex" data-join-unavailable>
                            <Button aria-label={`${team.joinChannel}: ${label}`} disabled size="sm" variant="secondary">
                              {team.joinChannel}
                            </Button>
                          </span>
                        </Tip>
                      ) : (
                        <Button
                          aria-label={`${team.joinChannel}: ${label}`}
                          disabled={joining !== undefined}
                          onClick={() => void join(channel)}
                          size="sm"
                          variant="secondary"
                        >
                          {joining === channel.id ? team.working : team.joinChannel}
                        </Button>
                      )
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {joinError && <p className="text-sm text-destructive" role="alert">{joinError}</p>}

          {abilities.creationBlocked === 'restricted' && (
            <p className="text-xs text-(--atum-ink-muted)">{team.browseCreateRestricted}</p>
          )}
          {abilities.creationBlocked === 'rooms' && <p className="text-xs text-(--atum-ink-muted)">{team.browseRoomsNotReady}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
