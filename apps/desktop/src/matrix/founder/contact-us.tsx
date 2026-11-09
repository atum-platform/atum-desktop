import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { VerifiedMark } from '@/components/verified-mark'

import { ATUM_MAILBOXES, atumMailLink } from '../../../shared/atum-company'
import type { MatrixSnapshot } from '../../../shared/matrix'
import { SettingsRow, SettingsSection } from '../settings-row'
import { runMatrixCommand } from '../text-document-actions'

import { useFounderCopy } from './founder-copy'
import { openFounderDraft, requestFounderChat } from './founder-store'
import { founderRoom, isFounderAccount } from './roster-founder'

/**
 * Settings › Account › Contact us (plan D10): the Founder row's Message opens the Founder chat, or asks
 * for it when the person has none (Contact us is their own request, so it may replace a chat
 * they left). While the Founder is offered as a local draft, it opens that draft instead:
 * nothing is made or invited until the first message. With no founder named, or none reachable,
 * Atum's support mailbox is the way, and the only address offered. Not on the founder's own account.
 */
export function FounderContactUs({ onClose, snapshot }: { onClose(): void; snapshot: MatrixSnapshot }) {
  const copy = useFounderCopy()
  const [state, setState] = useState<'idle' | 'opening' | 'unavailable'>('idle')

  if (isFounderAccount(snapshot)) {
    return null
  }

  const bridge = window.atumMatrix?.founder
  const ready = snapshot.state === 'ready'
  const founderOffered = Boolean(snapshot.founder && bridge) && state !== 'unavailable'

  // Settings steps aside first (the window behind it is inert while it is open), then the
  // roster brings the chat to the front.
  const opened = () => {
    setState('idle')
    onClose()
    requestFounderChat()
  }

  const message = async () => {
    const existing = founderRoom(snapshot)

    if (existing) {
      await runMatrixCommand({ kind: 'select', roomId: existing.id }).catch(() => {})
      opened()

      return
    }

    // Offered as a draft: open it. The room is made by the first message, never by this tap.
    if (snapshot.founder?.offer) {
      openFounderDraft()
      opened()

      return
    }

    setState('opening')

    const result = await (bridge?.contact() ?? Promise.resolve({ unavailable: true as const })).catch(() => ({
      unavailable: true as const
    }))

    if ('roomId' in result) {
      opened()
    } else {
      setState('unavailable')
    }
  }

  const email = () => void window.atumMatrix.openLink(atumMailLink('support', copy.emailSubject)).catch(() => {})

  return (
    <SettingsSection data-founder-contact title={copy.contactTitle}>
      {founderOffered ? (
        <SettingsRow
          control={
            <Button
              data-founder-contact-message
              disabled={!ready || state === 'opening'}
              onClick={() => void message()}
              size="sm"
              variant="secondary"
            >
              {copy.message}
            </Button>
          }
          help={copy.replyPromise}
          // Like every Settings row, a name and no face: "Founder" with its mark, then Message.
          title={
            <span className="inline-flex items-center gap-1" data-founder-contact-title>
              {copy.name}
              <VerifiedMark tier="official" />
            </span>
          }
        />
      ) : (
        <SettingsRow
          control={
            <Button data-founder-contact-email onClick={email} size="sm" variant="secondary">
              {copy.emailSupport}
            </Button>
          }
          help={state === 'unavailable' ? copy.contactUnavailable : ATUM_MAILBOXES.support}
          title={copy.emailSupport}
        />
      )}
    </SettingsSection>
  )
}
