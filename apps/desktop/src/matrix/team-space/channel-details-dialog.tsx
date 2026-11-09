import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Hash, Lock } from '@/lib/icons'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { focusDialogField, MatrixDialogHeader } from '../dialog-header'
import { SettingsTip } from '../settings-row'

import type { ChannelAbilities } from './abilities'
import { channelDescription } from './channel-chrome'
import { runChannelCommand } from './commands'
import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { type CompanyChannelView, isDefaultChannel } from './views'

export interface ChannelDetailsDialogProps {
  open: boolean
  onClose(): void
  bridge: MatrixCompanyBridge
  companyId: string
  channel: CompanyChannelView | undefined
  abilities: Pick<ChannelAbilities, 'edit'>
  /** Open on the description rather than the name (the channel intro's "Add a description"). */
  focusField?: 'purpose'
  mutate: TeamSpaceMutate
  onChanged(): void
}

const length = (value: string) => [...value].length

/**
 * A channel's name, topic and description, editable by the people the platform lets edit it, with
 * its visibility stated and never offered for change. Only what changed is sent.
 */
export function ChannelDetailsDialog({
  abilities,
  bridge,
  channel,
  companyId,
  focusField,
  mutate,
  onChanged,
  onClose,
  open
}: ChannelDetailsDialogProps) {
  const { company, team } = useTeamSpaceCopy()
  // The parent mounts this dialog afresh for each channel it opens, so the fields start from it and a
  // directory refresh underneath never overwrites what is being typed.
  const [name, setName] = useState(channel?.displayName ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [purpose, setPurpose] = useState(channel?.purpose ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  if (!channel) {
    return null
  }

  const fixedName = isDefaultChannel(channel)
  const nextName = name.trim()
  const changed = {
    ...(!fixedName && nextName !== channel.displayName ? { displayName: nextName } : {}),
    ...(topic.trim() !== channel.topic ? { topic: topic.trim() } : {}),
    ...(purpose.trim() !== channel.purpose ? { purpose: purpose.trim() } : {})
  }

  const valid =
    Object.keys(changed).length > 0 &&
    (fixedName || (length(nextName) >= 1 && length(nextName) <= 80)) &&
    length(topic.trim()) <= 250 &&
    length(purpose.trim()) <= 500

  const save = async () => {
    if (!valid || busy) {
      return
    }

    setBusy(true)
    setError(undefined)

    const outcome = await runChannelCommand(bridge, mutate, { companyId, channelId: channel.id }, generations => ({
      requestId: globalThis.crypto.randomUUID(),
      operation: 'update_metadata',
      expectedChannelGeneration: generations.channel,
      ...changed
    }))

    setBusy(false)

    if (!outcome) {
      return
    }

    if (outcome.ok) {
      onChanged()
      onClose()

      return
    }

    if (outcome.uncertain) {
      onClose()

      return
    }

    setError(outcomeText(outcome, team, company))
  }

  const Icon = channel.visibility === 'private' ? Lock : Hash

  return (
    <Dialog onOpenChange={next => !next && !busy && onClose()} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-md"
        data-matrix-company-channel-details
        onOpenAutoFocus={event => {
          const purposeField =
            focusField === 'purpose' && event.currentTarget instanceof HTMLElement
              ? event.currentTarget.querySelector<HTMLElement>('[data-matrix-channel-purpose]:not([disabled])')
              : null

          if (!purposeField) {
            focusDialogField(event)

            return
          }

          event.preventDefault()
          purposeField.focus({ preventScroll: true })
        }}
        showCloseButton={false}
      >
        <MatrixDialogHeader title={company.channelDetails} />
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <p className="flex items-center gap-2 text-sm font-medium text-(--atum-ink)">
            <Icon aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
            <span className="truncate">{fixedName ? company.defaultChannelName : channel.displayName}</span>
          </p>
          {abilities.edit ? (
            <>
              <label className="grid gap-1 text-sm">
                <span className="text-(--atum-ink-muted)">{team.channelNameLabel}</span>
                <Input disabled={busy || fixedName} onChange={event => setName(event.target.value)} value={fixedName ? company.defaultChannelName : name} />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-(--atum-ink-muted)">{team.channelTopicLabel}</span>
                <Input disabled={busy} maxLength={300} onChange={event => setTopic(event.target.value)} value={topic} />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-(--atum-ink-muted)">{team.channelPurposeLabel}</span>
                <Input
                  data-matrix-channel-purpose
                  disabled={busy}
                  maxLength={600}
                  onChange={event => setPurpose(event.target.value)}
                  // The default channel reads its localized line until someone writes their own.
                  placeholder={fixedName ? team.defaultChannelPurpose : team.channelPurposePlaceholder}
                  value={purpose}
                />
              </label>
            </>
          ) : (
            <div className="grid gap-1 text-sm text-(--atum-ink-muted)">
              {channel.topic && <p>{channel.topic}</p>}
              {channelDescription(channel, team) && <p className="break-words">{channelDescription(channel, team)}</p>}
            </div>
          )}
          <p className="text-xs text-(--atum-ink-muted)">
            {channel.visibility === 'private' ? team.detailsPrivateLine : team.detailsPublicLine}
            <SettingsTip label={team.detailsVisibilityFixed} />
          </p>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">{company.close}</Button>
            {abilities.edit && (
              <Button disabled={!valid || busy} type="submit">
                {busy ? team.savingChanges : team.saveChanges}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
