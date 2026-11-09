import { useEffect, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'

import type { CompanyDirectAddPolicy, CompanyPolicy3 } from '../../../shared/matrix-company-team-space'

import type { CompanyChannelCreationPolicy } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'

export interface PolicyControlProps {
  companyId: string
  value: CompanyChannelCreationPolicy
  /** The authority generation the policy was read at; a stale one is refused, never overwritten. */
  authorityGeneration: number
  blocked: boolean
  mutate: TeamSpaceMutate
}

/**
 * "Who can create channels" (decision 3): everyone by default, or the owner and admins. The control
 * paints the choice at once and rolls back with the reason when the platform refuses it. It governs
 * future channels only; nothing existing is rewritten.
 */
export function PolicyControl({ authorityGeneration, blocked, companyId, mutate, value }: PolicyControlProps) {
  const { company, team } = useTeamSpaceCopy()
  const [shown, setShown] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // The platform's answer wins whenever it arrives.
  useEffect(() => setShown(value), [value])

  const choose = async (next: CompanyChannelCreationPolicy) => {
    if (busy || next === shown) {
      return
    }

    setError(undefined)
    setShown(next)
    setBusy(true)

    const outcome = await mutate({
      action: 'policy-update',
      companyId,
      requestId: globalThis.crypto.randomUUID(),
      policy: { channelCreation: next },
      expectedAuthorityGeneration: authorityGeneration
    })

    setBusy(false)

    if (!outcome || !outcome.ok) {
      setShown(value)

      if (outcome && !outcome.ok && !outcome.uncertain) {
        setError(outcomeText(outcome, team, company))
      }
    }
  }

  return (
    <div className="grid gap-2 border-t border-(--atum-line) pt-5" data-matrix-company-policy>
      <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{team.policyTitle}</h3>
      <AtumSegmented<CompanyChannelCreationPolicy>
        disabled={blocked || busy}
        label={team.policyTitle}
        onChange={next => void choose(next)}
        options={[
          { id: 'members', label: team.policyEveryone },
          { id: 'admins_only', label: team.policyAdmins }
        ]}
        value={shown}
      />
      <p className="text-xs text-(--atum-ink-muted)">{team.policyHint}</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}

export interface DirectAddPolicyControlProps {
  companyId: string
  /** The whole policy 1.3 the administration read answered; the update sends all five fields, one of them changed. */
  policy: CompanyPolicy3
  authorityGeneration: number
  blocked: boolean
  mutate: TeamSpaceMutate
}

/**
 * "Who can add people directly" (policy 1.3, Mattermost's Add Team Members): members by default, or admins only. A
 * member who may not add still invites. Like the channel control it paints at once and rolls back on a refusal.
 */
export function DirectAddPolicyControl({ authorityGeneration, blocked, companyId, mutate, policy }: DirectAddPolicyControlProps) {
  const { company, team } = useTeamSpaceCopy()
  const copy = team.inviteSheet
  const value = policy.directMemberAdd
  const [shown, setShown] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => setShown(value), [value])

  const choose = async (next: CompanyDirectAddPolicy) => {
    if (busy || next === shown) {
      return
    }

    setError(undefined)
    setShown(next)
    setBusy(true)

    const outcome = await mutate({
      action: 'policy-update',
      companyId,
      requestId: globalThis.crypto.randomUUID(),
      policy: { ...policy, directMemberAdd: next },
      expectedAuthorityGeneration: authorityGeneration
    })

    setBusy(false)

    if (!outcome || !outcome.ok) {
      setShown(value)

      if (outcome && !outcome.ok && !outcome.uncertain) {
        setError(outcomeText(outcome, team, company))
      }
    }
  }

  return (
    <div className="grid gap-2 border-t border-(--atum-line) pt-5" data-matrix-company-direct-add-policy>
      <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{copy.directAddTitle}</h3>
      <AtumSegmented<CompanyDirectAddPolicy>
        disabled={blocked || busy}
        label={copy.directAddTitle}
        onChange={next => void choose(next)}
        options={[
          { id: 'members', label: copy.directAddMembers },
          { id: 'admins', label: copy.directAddAdmins }
        ]}
        value={shown}
      />
      <p className="text-xs text-(--atum-ink-muted)">{copy.directAddHint}</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}
