import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import { matrixCompanyPrivateCosCopy, matrixCompanyPrivateCosRowCopy } from '../../../shared/matrix-company-private-cos-copy'
import { CompanyAIAvatar } from '../company-ai-status'
import { useMatrixHandleContacts } from '../person-handle-contacts'
import { PersonHandleLine } from '../person-handle-line'
import { $matrixHandles } from '../person-handles'

import { teamSpaceKey } from './keys'
import {
  $companyPrivateCos,
  $companyPrivateCosDiscovery,
  type CompanyPrivateCosRowStatus,
  companyPrivateCosRowStatus
} from './private-cos-store'

export interface PrivateCosMemberRowProps {
  accountKey: string
  companyId: string
  name: string
  principal: string
  /** The accessible name of Open ("Open conversation with …"); the visible word stays short. */
  openLabel?: string
  /** The workspace's one private-CoS opener; the row never provisions or selects a room itself. */
  onOpen?: () => Promise<void>
  /** Runs the workspace's first-visit admission again, now. */
  onRetry?: () => Promise<void>
  onOpened?: () => void
  onOpenFailed?: () => void
}

/** The real state as one short line and at most one action. Ready says nothing and offers Open. */
export function privateCosMemberRowParts(status: CompanyPrivateCosRowStatus, locale: keyof typeof matrixCompanyPrivateCosRowCopy) {
  const row = matrixCompanyPrivateCosRowCopy[locale]

  switch (status) {
    case 'ready':
      return { line: undefined, action: 'open' as const, actionLabel: row.open }
    case 'setting_up':
      return { line: row.settingUp, action: undefined, actionLabel: undefined }
    case 'paused':
      return { line: matrixCompanyPrivateCosCopy[locale].paused, action: 'retry' as const, actionLabel: row.retry }
    default:
      return { line: row.notAvailable, action: 'retry' as const, actionLabel: row.retry }
  }
}

/**
 * The Chief of Staff in a channel's members: the member-private conversation's real state, never a
 * silently disabled row. "Setting up…" while the platform prepares it, Open once it is ready, and
 * "Not available yet" with Retry when the last look left nothing usable.
 */
export function PrivateCosMemberRow({ accountKey, companyId, name, onOpen, onOpenFailed, onOpened, onRetry,
  openLabel, principal }: PrivateCosMemberRowProps) {
  const { locale } = useI18n()
  const key = teamSpaceKey(accountKey, companyId)
  const state = useStore($companyPrivateCos, { keys: [key] })[key]
  const discovery = useStore($companyPrivateCosDiscovery, { keys: [key] })[key]
  const handleState = useStore($matrixHandles)
  const userId = state && 'binding' in state.view ? state.view.binding.agentUserId : undefined
  useMatrixHandleContacts(handleState.owner, [userId])
  const [busy, setBusy] = useState<'open' | 'retry'>()

  useEffect(() => setBusy(undefined), [key])

  const status: CompanyPrivateCosRowStatus = busy === 'retry' ? 'setting_up' : companyPrivateCosRowStatus(state, discovery)

  const { action, actionLabel, line } = privateCosMemberRowParts(status, locale)

  const run = () => {
    if (busy || !action) {return}

    if (action === 'open') {
      if (!onOpen) {return}
      setBusy('open')
      void onOpen().then(
        () => {
          setBusy(undefined)
          onOpened?.()
        },
        () => {
          setBusy(undefined)
          onOpenFailed?.()
        }
      )

      return
    }

    if (!onRetry) {return}
    setBusy('retry')
    void onRetry().catch(() => {}).finally(() => setBusy(undefined))
  }

  return (
    <li className="flex items-center gap-2 text-sm text-(--atum-ink)" data-company-channel-service-member
      data-company-private-cos-member-status={status}>
      <CompanyAIAvatar className="size-6 shrink-0 text-[0.5625rem] leading-none" name={name} principal={principal} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        <PersonHandleLine handle={userId ? handleState.byUser[userId] : undefined} name={name} />
        {line && <span className="block truncate text-xs text-(--atum-ink-muted)" role="status">{line}</span>}
      </span>
      {action && (action === 'open' ? onOpen : onRetry) && (
        <Button
          aria-label={action === 'open' ? openLabel : `${actionLabel} · ${name}`}
          className="ms-auto"
          disabled={Boolean(busy)}
          onClick={run}
          size="sm"
          variant="text"
        >
          {actionLabel}
        </Button>
      )}
    </li>
  )
}
