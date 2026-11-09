import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { $approvalModes, approvalModeForProfile } from '@/store/approval-mode'
import { $atumAccountStatus } from '@/store/atum-messaging'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { type AtumConsentClass, atumConsentFromAllowlistEntry } from '../../../shared/atum-interaction-capability'

interface ConsentEntry {
  consent: AtumConsentClass
  patternKey: string
}

/**
 * The signed-in account's durable consents. Hermes owns them: each is one
 * `plugin_rule:atum:<accountKey>:<consent>` entry in Hermes's
 * `command_allowlist`, written when the user answered "Always allow" on the
 * approval card. Revoking removes the entry on disk, in memory, and from every
 * live session cache, so the next matching action asks again.
 */
export function AccountInteractionPermissions() {
  const { t } = useI18n()
  const gateway = useStore($gateway)
  // Subscribe so the note follows the status-bar zap; the helper reads the map.
  useStore($approvalModes)
  const approvalsOff = approvalModeForProfile(useStore($activeGatewayProfile)) === 'off'
  // Bound to the live account: an A→B switch changes the prefix, which drops
  // A's entries immediately and refetches B's before revoke is enabled.
  const prefix = useStore($atumAccountStatus).current?.consentRulePrefix ?? null
  const [entries, setEntries] = useState<ConsentEntry[]>([])
  const [state, setState] = useState<'failed' | 'loading' | 'ready'>('loading')
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    setEntries([])

    if (!prefix) {
      setState('ready')

      return
    }

    if (!gateway) {
      setState('failed')

      return
    }

    let active = true
    setState('loading')
    const boundPrefix = prefix

    void gateway
      .request<{ entries?: unknown }>('approval.allowlist.list', { prefix: boundPrefix })
      .then(result => {
        if (!active) {
          return
        }

        const next: ConsentEntry[] = []

        for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
          if (typeof entry !== 'string') {
            continue
          }

          const consent = atumConsentFromAllowlistEntry(entry, boundPrefix)

          if (consent) {
            next.push({ consent, patternKey: entry })
          }
        }

        setEntries(next)
        setState('ready')
      })
      .catch(() => {
        if (active) {
          setState('failed')
        }
      })

    return () => {
      active = false
    }
  }, [gateway, prefix])

  const revoke = async (patternKey: string) => {
    if (!gateway || revoking || !prefix || !patternKey.startsWith(prefix)) {
      return
    }

    setRevoking(patternKey)

    try {
      await gateway.request('approval.allowlist.remove', { pattern_key: patternKey })
      setEntries(current => current.filter(entry => entry.patternKey !== patternKey))
    } catch {
      setState('failed')
    } finally {
      setRevoking(null)
    }
  }

  const consentCopy = t.atum.account.consent

  const labelFor = (consent: AtumConsentClass): string => {
    switch (consent) {
      case 'browser':
        return consentCopy.browser

      case 'computer.observe':
        return consentCopy.computerObserve

      case 'computer.control':
        return consentCopy.computerControl

      default:
        return consentCopy.workspaceWrite
    }
  }

  return (
    <section aria-labelledby="atum-interaction-permissions-heading">
      <h3 className="text-sm font-semibold" id="atum-interaction-permissions-heading">
        {t.atum.account.interactionPermissions}
      </h3>
      <p className="mt-1 text-xs text-(--atum-ink-muted)">{t.atum.account.interactionPermissionsHint}</p>
      {approvalsOff && (
        <p className="mt-1 text-xs text-(--atum-ink)" data-approvals-off>
          {t.atum.account.approvalsOff}
        </p>
      )}
      {state === 'loading' ? (
        <p className="mt-2 text-xs text-(--atum-ink-muted)">{t.common.loading}</p>
      ) : state === 'failed' ? (
        <NoticeBand className="mt-2" role="alert">
          {t.atum.account.interactionPermissionsFailed}
        </NoticeBand>
      ) : entries.length === 0 ? (
        <p className="mt-2 text-xs text-(--atum-ink-muted)">{t.atum.account.interactionPermissionsEmpty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-(--atum-line) border-y border-(--atum-line)">
          {entries.map(entry => (
            <li
              className="flex items-start justify-between gap-3 py-2"
              data-consent={entry.consent}
              data-interaction-capability=""
              key={entry.patternKey}
            >
              <div className="min-w-0 space-y-0.5 text-xs">
                <p className="font-medium text-(--atum-ink)">{labelFor(entry.consent)}</p>
                <p className="text-(--atum-ink-muted)">{t.atum.account.consentAlwaysAllowed}</p>
              </div>
              <Button
                disabled={revoking === entry.patternKey}
                onClick={() => void revoke(entry.patternKey)}
                size="sm"
                variant="ghost"
              >
                {t.atum.account.revokePermission}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
