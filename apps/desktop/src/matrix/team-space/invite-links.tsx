import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Copy } from '@/lib/icons'

import type { MatrixCompanyBridge, MatrixCompanyValue } from '../../../shared/matrix-company'
import type { CompanyInviteLink, CompanyInviteLinkSummary } from '../../../shared/matrix-company-team-space'

import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { requestTeamSpace } from './request'
import { invitationDaysLeft } from './views'

const newRequestId = () => globalThis.crypto.randomUUID()
const nowSeconds = () => Math.floor(Date.now() / 1000)

/** The first answer to a create is the only one that carries the link itself (a bearer secret). */
function createdLink(value: MatrixCompanyValue): CompanyInviteLink | 'replayed' | undefined {
  if (!('link' in value) || !('replayed' in value)) {
    return undefined
  }

  return value.replayed ? 'replayed' : (value.link as CompanyInviteLink)
}

/**
 * The link a create answered with, when that answer was a replay (an earlier press's answer was lost, so the
 * link exists but its text was never seen). The workspace calls this for every create it runs, whichever
 * control ran it, so the notice does not depend on the invite dialog having been the one that asked.
 */
export function replayedInviteLinkId(value: MatrixCompanyValue): string | undefined {
  return 'link' in value && 'replayed' in value && value.replayed ? (value.link as CompanyInviteLinkSummary).id : undefined
}

export interface InviteLinksProps {
  bridge: MatrixCompanyBridge
  companyId: string
  /**
   * Which opening of the invite dialog this is. The one-time link text belongs to one company in one dialog:
   * a new company or a new opening never sees it.
   */
  dialogInstance: number
  /** Another change is running or waiting to be retried. */
  blocked: boolean
  mutate: TeamSpaceMutate
  /** Owners and admins revoke; a member who may make links does not see Revoke. Defaults to allowed. */
  canRevoke?: boolean
  /** Links whose create was replayed: they exist, but their text can no longer be shown. */
  replayedLinkIds: ReadonlySet<string>
}

/** A link's text, kept only for the company and dialog it was made in. */
interface LinkSecret {
  companyId: string
  dialogInstance: number
  link: CompanyInviteLink
}

/**
 * "Copy invite link": one press makes a member-only link and puts it on the clipboard (decision
 * 11: no email invitations). The link is shown once, here; afterwards only its use and expiry are
 * known, and an unwanted link is revoked, never re-issued.
 *
 * The link is a bearer secret, so it is held for exactly one `(company, dialog)`: it is dropped when
 * either changes and when this unmounts, and an answer that arrives after that is not kept at all.
 */
export function InviteLinks({ blocked, bridge, canRevoke = true, companyId, dialogInstance, mutate, replayedLinkIds }: InviteLinksProps) {
  const { company, team } = useTeamSpaceCopy()
  const [links, setLinks] = useState<readonly CompanyInviteLinkSummary[]>([])
  const [secret, setSecret] = useState<LinkSecret>()
  const [status, setStatus] = useState<'idle' | 'working' | 'copied' | 'copyFailed' | 'revoked'>('idle')
  const [error, setError] = useState<string>()
  const mounted = useRef(true)

  // What this screen is for right now. Assigned while rendering on purpose: an answer that resolves between a
  // render and the effect below must still find the screen it was asked for gone.
  const scope = `${companyId}\n${dialogInstance}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const created = secret && secret.companyId === companyId && secret.dialogInstance === dialogInstance ? secret.link : undefined

  const load = useCallback(async () => {
    const issued = scopeRef.current
    const result = await requestTeamSpace(bridge, { action: 'invite-links', companyId })

    if (mounted.current && scopeRef.current === issued && result.ok) {
      setLinks(result.value.links.filter(link => link.state === 'active'))
    }
  }, [bridge, companyId])

  useEffect(() => {
    mounted.current = true
    setSecret(undefined)
    setStatus('idle')
    setError(undefined)
    setLinks([])
    void load()

    return () => {
      mounted.current = false
      setSecret(undefined)
    }
  }, [dialogInstance, load])

  // A replay the workspace noted while this was open (its Retry ran the create, not this button) lands a link this list
  // has not read yet: look again, so its row is there to say what became of it.
  const replaysSeen = useRef(replayedLinkIds.size)

  useEffect(() => {
    if (replayedLinkIds.size > replaysSeen.current) {
      void load()
    }

    replaysSeen.current = replayedLinkIds.size
  }, [load, replayedLinkIds])

  const create = async () => {
    const issued = scopeRef.current
    const stillHere = () => mounted.current && scopeRef.current === issued

    setStatus('working')
    setError(undefined)
    setSecret(undefined)

    const outcome = await mutate({ action: 'invite-link-create', companyId, requestId: newRequestId(), role: 'member' })

    // The company or the dialog moved on while this was in flight: the link's text is not kept anywhere.
    if (!stillHere()) {
      return
    }

    if (!outcome) {
      setStatus('idle')

      return
    }

    if (!outcome.ok) {
      setStatus('idle')
      setError(outcomeText(outcome, team, company))

      return
    }

    const link = createdLink(outcome.value)

    if (link && link !== 'replayed') {
      setSecret({ companyId, dialogInstance, link })

      try {
        await writeClipboardText(link.url)

        if (stillHere()) {
          setStatus('copied')
        }
      } catch {
        if (stillHere()) {
          setStatus('copyFailed')
        }
      }
    } else {
      // A replay's text is not kept anywhere; the workspace has noted it, and the list below says so on its row.
      setStatus('idle')
    }

    if (stillHere()) {
      void load()
    }
  }

  const revoke = async (link: CompanyInviteLinkSummary) => {
    const issued = scopeRef.current

    setError(undefined)
    const outcome = await mutate({ action: 'invite-link-revoke', companyId, linkId: link.id, requestId: newRequestId() })

    if (!mounted.current || scopeRef.current !== issued || !outcome) {
      return
    }

    if (!outcome.ok) {
      setError(outcomeText(outcome, team, company))

      return
    }

    setStatus('revoked')
    setSecret(current => (current?.link.id === link.id ? undefined : current))
    void load()
  }

  return (
    <section aria-label={team.inviteLinkSection} className="grid gap-2" data-matrix-company-invite-links>
      <p className="text-xs text-(--atum-ink-muted)">{team.inviteLinkSection}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={blocked || status === 'working'} onClick={() => void create()} size="sm" type="button" variant="secondary">
          <Copy aria-hidden />
          {status === 'working' ? team.inviteLinkCreating : team.copyInviteLink}
        </Button>
        <span aria-live="polite" className="text-xs text-(--atum-ink-muted)" role="status">
          {status === 'copied' ? team.inviteLinkCopied : status === 'revoked' ? team.inviteLinkRevoked : ''}
        </span>
      </div>

      {created && (
        <div className="grid gap-1.5" data-matrix-company-invite-link-created>
          <Input aria-label={team.copyInviteLink} onFocus={event => event.currentTarget.select()} readOnly value={created.url} />
          <p className="text-xs text-(--atum-ink-muted)" title={team.inviteLinkAudience}>
            {team.inviteLinkDuration(Math.max(1, invitationDaysLeft(created.expiresAt, nowSeconds())))} {team.inviteLinkCapacity(created.maxUses)}
          </p>
          {status === 'copyFailed' && <p className="text-xs text-destructive" role="alert">{team.inviteLinkCopyFailed}</p>}
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {links.length > 0 && (
        <div className="grid gap-1" data-matrix-company-invite-links-active>
          <p className="text-xs text-(--atum-ink-muted)">{team.inviteLinksActive}</p>
          <ul aria-label={team.inviteLinksActive} className="grid gap-1.5">
            {links.map(link => (
              <li className="grid gap-0.5 text-sm text-(--atum-ink)" data-invite-link-id={link.id} key={link.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs text-(--atum-ink-muted)">
                    {team.inviteLinkUsage(link.uses, link.maxUses)} · {team.inviteLinkExpires(invitationDaysLeft(link.expiresAt, nowSeconds()))}
                  </span>
                  {canRevoke && (
                    <Button disabled={blocked} onClick={() => void revoke(link)} size="sm" type="button" variant="text">
                      {team.inviteLinkRevoke}
                    </Button>
                  )}
                </div>
                {replayedLinkIds.has(link.id) && (
                  <p className="text-xs text-(--atum-ink-muted)" data-invite-link-replayed role="status">
                    {team.inviteLinkReplayed}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
