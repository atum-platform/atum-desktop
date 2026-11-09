import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { SETTINGS_ROUTE } from '@/app/routes'
import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import {
  type ManagedModelAccessAlias,
  managedModelAccessLabel,
  type ManagedModelAccessSnapshot
} from '@/lib/atum-managed-model-access'
import {
  $managedModelAccess,
  type ManagedModelAccessView,
  refreshManagedModelAccess,
  retainManagedModelAccessPolling
} from '@/store/atum-managed-model'
import { signInToAtum } from '@/store/atum-messaging'

export function useManagedModelAccessLifecycle(accessAlias: ManagedModelAccessAlias | null): void {
  useEffect(() => (accessAlias ? retainManagedModelAccessPolling(accessAlias) : undefined), [accessAlias])
}

export function managedModelStatusVisible(
  accessAlias: ManagedModelAccessAlias | null,
  view: ManagedModelAccessView
): boolean {
  // Background reads do not own the composer. Only a current, actionable
  // server answer appears here; task failures use their own recovery surface.
  return accessAlias !== null && view.state === 'resolved' && view.accessAlias === accessAlias &&
    !view.freshness?.consecutiveFailures &&
    view.access.state !== 'ready' && view.access.state !== 'unavailable'
}

type ManagedModelRecoveryAction = 'fund' | 'reauthenticate' | 'retry'

export function managedModelPresentation(access: ManagedModelAccessSnapshot): {
  action: ManagedModelRecoveryAction | null
  messageKey: Exclude<ManagedModelAccessSnapshot['state'], 'ready'> | 'funding_required' | 'model_reserved' | null
} {
  if (access.state === 'ready' || access.state === 'unavailable') {
    return { action: null, messageKey: null }
  }

  if (access.state === 'authentication_expired') {
    return { action: 'reauthenticate', messageKey: access.state }
  }

  if (access.state === 'insufficient_funds' || ('reason' in access && access.reason === 'funding_required')) {
    return { action: 'fund', messageKey: access.state === 'insufficient_funds' ? access.state : 'funding_required' }
  }

  if ('reason' in access && access.reason === 'model_reserved') {
    return { action: null, messageKey: 'model_reserved' }
  }

  return { action: access.state === 'service_paused' ? 'retry' : null, messageKey: access.state }
}

export function ManagedModelBanner({ accessAlias }: { accessAlias: ManagedModelAccessAlias }) {
  const accessView = useStore($managedModelAccess)
  const { t } = useI18n()
  const navigate = useNavigate()
  const copy = t.atum.managedModel

  if (!managedModelStatusVisible(accessAlias, accessView) || accessView.state !== 'resolved') {
    return null
  }

  const { action, messageKey } = managedModelPresentation(accessView.access)

  if (!messageKey) {
    return null
  }

  const state = accessView.access.state
  const message = copy[messageKey]
  const destructive = state === 'insufficient_funds' || state === 'denied'

  const recover = async () => {
    if (action === 'fund') {
      navigate(`${SETTINGS_ROUTE}?tab=atum:protons`)

      return
    }

    if (action === 'reauthenticate') {
      await signInToAtum()
      await refreshManagedModelAccess(accessAlias)
    } else if (action === 'retry') {
      await refreshManagedModelAccess(accessAlias)
    }

    requestComposerFocus('active')
  }

  return (
    <StatusRow
      leading={
        <Codicon
          className={destructive ? 'text-destructive/85' : 'text-(--ui-yellow)'}
          name={destructive ? 'error' : 'warning'}
          size="0.8rem"
        />
      }
      trailing={
        action ? (
          <Button onClick={() => void recover()} size="micro" type="button" variant="text">
            {action === 'fund' ? copy.addProtons : action === 'reauthenticate' ? t.dm.signIn : copy.retry}
          </Button>
        ) : undefined
      }
      trailingVisible={Boolean(action)}
    >
      <span className="min-w-0 truncate text-[0.73rem] leading-4 text-foreground/92">
        <span data-managed-access-alias={accessAlias}>{managedModelAccessLabel(accessAlias)}</span>: {message}
      </span>
    </StatusRow>
  )
}
