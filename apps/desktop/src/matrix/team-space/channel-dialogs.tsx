import { ConfirmDialog } from '@/components/ui/confirm-dialog'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'

import { channelAbilities, type CompanyAbilities, NO_CHANNEL_ABILITIES, type TeamSpaceProfile } from './abilities'
import { ChannelBrowserDialog } from './channel-browser-dialog'
import { ChannelCreateDialog } from './channel-create-dialog'
import { ChannelDetailsDialog } from './channel-details-dialog'
import { ChannelMembersDialog } from './channel-members-dialog'
import { runChannelCommand } from './commands'
import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { channelFactsOf, type CompanyChannelView, isDefaultChannel, type RosterMember } from './views'

export type ChannelDialog =
  | { kind: 'browse' }
  | { kind: 'create' }
  | { kind: 'details'; channelId: string; field?: 'purpose' }
  | { kind: 'members' | 'members-panel' | 'leave' | 'archive'; channelId: string }

export interface ChannelDialogsProps {
  accountKey: string
  dialog: ChannelDialog | undefined
  onDialog(next: ChannelDialog | undefined): void
  bridge: MatrixCompanyBridge
  companyId: string
  profile: TeamSpaceProfile
  viewerRole: 'admin' | 'member' | 'owner' | undefined
  abilities: CompanyAbilities
  views: readonly CompanyChannelView[]
  roster: readonly RosterMember[]
  mutate: TeamSpaceMutate
  /** Opens a channel the viewer is already in, by the room its directory row names. */
  onOpenChannel(channelId: string): void
  /** Opens or prepares this member's private Chief of Staff room through the workspace-owned path. */
  onOpenPrivateCos?: () => Promise<void>
  /** Asks again for this member's private Chief of Staff (the members row's Retry). */
  onRetryPrivateCos?: () => Promise<void>
  /** A new channel was admitted: open it as soon as its room is ready. */
  onCreated(channelId: string): void
  /** Who is in a channel, or what it is called, changed: look at the directory again. */
  onChanged(): void
  /** The viewer left a channel: if it was the one on screen, move to the default. */
  onLeft(channelId: string): void
}

/**
 * The C2 dialogs, in one place so any part of the window can ask for one (through the intents) while
 * the workspace stays the only thing that sends. At most one is open: browsing hands over to creating.
 */
export function ChannelDialogs({
  accountKey,
  abilities,
  bridge,
  companyId,
  dialog,
  mutate,
  onChanged,
  onCreated,
  onDialog,
  onLeft,
  onOpenChannel,
  onOpenPrivateCos,
  onRetryPrivateCos,
  profile,
  roster,
  views,
  viewerRole
}: ChannelDialogsProps) {
  const { company, team } = useTeamSpaceCopy()
  const close = () => onDialog(undefined)
  const channel = dialog && 'channelId' in dialog ? views.find(view => view.id === dialog.channelId) : undefined

  const channelFacts = (view: CompanyChannelView) => channelAbilities(profile, viewerRole, channelFactsOf(view))

  const confirm = async (operation: 'archive' | 'leave') => {
    if (!channel) {
      return
    }

    const outcome = await runChannelCommand(bridge, mutate, { companyId, channelId: channel.id }, generations =>
      operation === 'leave'
        ? {
            requestId: globalThis.crypto.randomUUID(),
            operation: 'leave',
            expectedChannelGeneration: generations.channel,
            expectedAdmissionGeneration: generations.admission
          }
        : { requestId: globalThis.crypto.randomUUID(), operation: 'archive', expectedChannelGeneration: generations.channel }
    )

    if (!outcome) {
      return
    }

    if (outcome.ok) {
      onChanged()

      if (operation === 'leave') {
        onLeft(channel.id)
      }

      return
    }

    // An unclear outcome stays with the workspace's Retry; a refusal is said here, in the dialog.
    if (!outcome.uncertain) {
      throw new Error(outcomeText(outcome, team, company))
    }
  }

  return (
    <>
      <ChannelCreateDialog
        abilities={abilities}
        bridge={bridge}
        channels={views}
        companyId={companyId}
        mutate={mutate}
        onChanged={onChanged}
        onClose={close}
        onCreated={onCreated}
        open={dialog?.kind === 'create'}
        roster={roster}
      />
      <ChannelBrowserDialog
        abilities={abilities}
        accountKey={accountKey}
        bridge={bridge}
        companyId={companyId}
        mutate={mutate}
        onClose={close}
        onCreate={() => onDialog({ kind: 'create' })}
        onJoined={onCreated}
        onOpenChannel={channelId => {
          close()
          onOpenChannel(channelId)
        }}
        open={dialog?.kind === 'browse'}
      />
      {dialog?.kind === 'details' && channel && (
        <ChannelDetailsDialog
          abilities={channelFacts(channel)}
          bridge={bridge}
          channel={channel}
          companyId={companyId}
          focusField={dialog.field}
          key={channel.id}
          mutate={mutate}
          onChanged={onChanged}
          onClose={close}
          open
        />
      )}
      <ChannelMembersDialog
        abilities={channel ? channelFacts(channel) : NO_CHANNEL_ABILITIES}
        accountKey={accountKey}
        bridge={bridge}
        channel={channel}
        companyId={companyId}
        mutate={mutate}
        onChanged={onChanged}
        onClose={close}
        onOpenPrivateCos={onOpenPrivateCos}
        onRetryPrivateCos={onRetryPrivateCos}
        open={dialog?.kind === 'members' || dialog?.kind === 'members-panel'}
        presentation={dialog?.kind === 'members-panel' ? 'panel' : 'dialog'}
        roster={roster}
      />
      {(dialog?.kind === 'leave' || dialog?.kind === 'archive') && channel && (
        <ConfirmDialog
          // Opened under one standing, still open under another: say so, and offer nothing to confirm.
          blockedReason={channelFacts(channel)[dialog.kind] ? undefined : team.noLongerAllowed}
          cancelLabel={company.cancel}
          confirmLabel={dialog.kind === 'leave' ? team.leaveChannelConfirm : team.archiveChannelConfirm}
          description={
            dialog.kind === 'leave'
              ? channel.visibility === 'private'
                ? team.leaveChannelPrivate
                : team.leaveChannelPublic
              : team.archiveChannelBody
          }
          destructive
          onClose={close}
          onConfirm={() => confirm(dialog.kind as 'archive' | 'leave')}
          open
          title={
            (dialog.kind === 'leave' ? team.leaveChannelTitle : team.archiveChannelTitle)(
              isDefaultChannel(channel) ? company.defaultChannelName : channel.displayName
            )
          }
        />
      )}
    </>
  )
}

