import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { setWorkActive } from '@/app/work/store'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Home, Messages } from '@/lib/icons'
import { ProviderMark } from '@/matrix/model-picker-provider-mark'
import { SettingsRow, SettingsSection, SettingsStatus } from '@/matrix/settings-row'
import {
  SubscriptionConnectDialog,
  SubscriptionManageDialog,
  subscriptionProviderStatus,
  useMatrixSubscriptions
} from '@/matrix/subscriptions'

import type { MatrixWorkBridge } from '../../../shared/matrix-work'
import type { WorkRelayPlan } from '../../../shared/matrix-work-relay'

import { AccountPlanMark } from './connect-sheet'
import { ACCOUNT_PLAN_NAMES, connectionsCopy, type ConnectionsWords } from './copy'
import { firstRunConnectionsCopy } from './first-run-copy'
import {
  $firstRunAutoEnabled,
  $firstRunLabels,
  loadFirstRunLabels,
  requestFirstRunRepick,
  setFirstRunAutoEnabled
} from './first-run-store'
import { $accountConnections, type ConnectionsBridge, loadAccountConnections, openAccountConnect } from './store'
import {
  accountPlanMacNames,
  type AccountPlanRow,
  accountPlanRows,
  accountToolRows,
  homeHubName
} from './view'

/** A plan row's one line: where it runs, when it was last seen, or that it is not connected. */
export function accountPlanLine(row: AccountPlanRow, copy: ConnectionsWords): string {
  switch (row.state) {
    case 'connected':
      return copy.onMacs(accountPlanMacNames({ ...row, macs: row.macs.filter(mac => !mac.stale) }, copy.thisMac))

    case 'stale':
      return copy.lastSeen(accountPlanMacNames(row, copy.thisMac))

    case 'needs_attention':
      return copy.needsAttention

    default:
      return copy.notConnected
  }
}

/** Which plans the owner's assistants may use now (the account consent), re-read on focus and after Stop using. */
function usePlansInUse(bridge: Partial<Pick<ConnectionsBridge, 'readPlanConsent'>> | undefined) {
  const [inUse, setInUse] = useState<ReadonlySet<WorkRelayPlan>>(new Set())

  const refresh = useCallback(() => {
    if (!bridge?.readPlanConsent) {
      return
    }

    const read = bridge.readPlanConsent
    const plans: WorkRelayPlan[] = ['codex', 'claude', 'antigravity']

    void Promise.all(plans.map(plan => Promise.resolve().then(() => read(plan)).then(consent => (consent?.state === 'on' ? plan : null), () => null))).then(on =>
      setInUse(new Set(on.filter((plan): plan is WorkRelayPlan => plan !== null)))
    )
  }, [bridge])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  return { inUse, refresh }
}

function useAccountConnections() {
  const view = useStore($accountConnections)

  useEffect(() => {
    const refresh = () => void loadAccountConnections()

    refresh()
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [])

  return view
}

/**
 * Settings › Connections, Subscriptions: every plan the account can use, one row each (its mark, where it runs, one action), and
 * the OpenCode Go key. Connect opens the one connect sheet; Manage opens the plan's own screen in Work on the Mac that holds it.
 * No meters, no terms, no per-assistant lists: connected means every assistant and every feature can use it.
 */
export function AccountSubscriptionsSection({
  bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.work,
  onLeave,
  scopeKey
}: {
  bridge?: Pick<ConnectionsBridge, 'openPlanConnect'> &
    Partial<Pick<MatrixWorkBridge, 'readPlanConsent' | 'revokePlanConsent' | 'readPlanLabels'>>
  /** Closes Settings so the owner lands on Work. */
  onLeave?: () => void
  scopeKey?: string
}) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale)
  const view = useAccountConnections()
  const rows = accountPlanRows(view)
  const opencode = useMatrixSubscriptions(scopeKey)
  const opencodeConnected = subscriptionProviderStatus(opencode.status, 'opencode-go')?.connected === true
  const free = opencode.status?.atumFree
  const [freeBusy, setFreeBusy] = useState(false)
  const [freeError, setFreeError] = useState(false)
  const [keyDialog, setKeyDialog] = useState<'connect' | 'manage' | null>(null)
  const firstRun = firstRunConnectionsCopy(locale)
  const labels = useStore($firstRunLabels)
  const automatic = useStore($firstRunAutoEnabled)
  const { inUse, refresh: refreshInUse } = usePlansInUse(bridge)

  useEffect(() => {
    void loadFirstRunLabels(bridge)
  }, [bridge])

  const disconnectFree = async () => {
    setFreeBusy(true)
    setFreeError(false)

    try {
      if (await opencode.bridge?.disconnectAtumFree?.()) {
        await opencode.reload()
      } else {
        setFreeError(true)
      }
    } catch {
      setFreeError(true)
    } finally {
      setFreeBusy(false)
    }
  }

  // Stop using: the account consent for this plan is revoked on every Mac (it stays off; the automatic pick never re-grants a
  // revoked plan) and the assistants move to the next best plan, or Atum's model.
  const stopUsing = (plan: WorkRelayPlan) => {
    void bridge?.revokePlanConsent?.(plan)
      .catch(() => undefined)
      .then(() => {
        refreshInUse()
        requestFirstRunRepick()
      })
  }

  const manage = (row: AccountPlanRow) => {
    onLeave?.()
    setWorkActive(true)
    void bridge?.openPlanConnect(row.plan).catch(() => undefined)
  }

  return (
    <SettingsSection data-matrix-settings-section="subscriptions" title={copy.subscriptions}>
      {rows.map(row => (
        <SettingsRow
          control={
            row.state === 'connected' && inUse.has(row.plan) && bridge?.revokePlanConsent ? (
              <button
                className="ak-btn ak-btn--sm"
                data-atum-connection-action="stop-using"
                onClick={() => stopUsing(row.plan)}
                type="button"
              >
                {firstRun.stopUsing}
              </button>
            ) : row.state === 'not_connected' || row.state === 'needs_attention' ? (
              <button
                className="ak-btn ak-btn--sm"
                data-atum-connection-action="connect"
                onClick={() => openAccountConnect(row.plan)}
                type="button"
              >
                {copy.connect}
              </button>
            ) : row.here && bridge ? (
              <button className="ak-btn ak-btn--sm ak-btn--plain" data-atum-connection-action="manage" onClick={() => manage(row)} type="button">
                {copy.manage}
              </button>
            ) : undefined
          }
          data-atum-connection={row.plan}
          data-atum-connection-state={row.state}
          help={
            row.state === 'connected' && inUse.has(row.plan)
              ? firstRun.inUse(labels?.[row.plan]?.label ?? ACCOUNT_PLAN_NAMES[row.plan])
              : accountPlanLine(row, copy)
          }
          key={row.plan}
          lead={<AccountPlanMark plan={row.plan} size="sm" />}
          title={ACCOUNT_PLAN_NAMES[row.plan]}
        />
      ))}
      <SettingsRow
        control={
          <button
            className={opencodeConnected ? 'ak-btn ak-btn--sm ak-btn--plain' : 'ak-btn ak-btn--sm'}
            data-atum-connection-action={opencodeConnected ? 'manage' : 'connect'}
            disabled={!opencode.bridge}
            onClick={() => setKeyDialog(opencodeConnected ? 'manage' : 'connect')}
            type="button"
          >
            {opencodeConnected ? copy.manage : copy.connect}
          </button>
        }
        data-atum-connection="opencode_go"
        data-atum-connection-state={opencodeConnected ? 'connected' : 'not_connected'}
        help={opencodeConnected ? copy.inCloud : copy.notConnected}
        lead={<ProviderMark provider={{ id: 'opencode-go', label: 'OpenCode Go' }} size="sm" />}
        title="OpenCode Go"
      />
      {free && (
        <SettingsRow
          control={
            <div className="flex gap-2">
              {free.keyHash && (
                <button className="ak-btn ak-btn--sm ak-btn--plain"
                  onClick={() => void window.atumMatrix.openLink(`https://openrouter.ai/keys/${free.keyHash}`)}
                  type="button">
                  Manage key in OpenRouter
                </button>
              )}
              {free.state === 'connected' && (
                <button className="ak-btn ak-btn--sm ak-btn--plain" disabled={freeBusy}
                  onClick={() => void disconnectFree()} type="button">
                  Disconnect OpenRouter
                </button>
              )}
            </div>
          }
          data-atum-connection="openrouter_free"
          data-atum-connection-state={free.state}
          help={freeError ? 'Could not disconnect OpenRouter. Try again.'
            : free.state === 'connected' ? 'Uses your OpenRouter account' : 'Connect from a cloud agent’s model picker'}
          lead={<ProviderMark provider={{ id: 'openrouter', label: 'OpenRouter' }} size="sm" />}
          title="Atum Free"
        />
      )}
      <SettingsRow
        control={
          <Switch
            aria-label={firstRun.autoTitle}
            checked={automatic}
            data-atum-first-run-auto
            onCheckedChange={on => {
              setFirstRunAutoEnabled(on)

              if (on) {
                requestFirstRunRepick()
              }
            }}
          />
        }
        data-atum-connection-preference="automatic"
        help={firstRun.autoLine}
        title={firstRun.autoTitle}
      />
      {keyDialog === 'connect' && (
        <SubscriptionConnectDialog
          onClose={() => setKeyDialog(null)}
          onConnected={() => void opencode.reload()}
          open
          provider="opencode-go"
        />
      )}
      {keyDialog === 'manage' && (
        <SubscriptionManageDialog
          onChanged={() => void opencode.reload()}
          onClose={() => setKeyDialog(null)}
          onReconnect={() => setKeyDialog('connect')}
          open
        />
      )}
    </SettingsSection>
  )
}

/**
 * Data and tools every assistant has by default: your chats (always on) and the home hubs the account has set up. One row each,
 * no switch: there is nothing to admit per assistant.
 */
export function AccountToolsSection() {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale)
  const view = useStore($accountConnections)
  const rows = accountToolRows(view)

  return (
    <SettingsSection data-matrix-settings-section="data-and-tools" title={copy.dataAndTools}>
      {rows.map(row =>
        row.id === 'owner_chats' ? (
          <SettingsRow
            data-atum-connection="owner_chats"
            help={copy.ownerChats.line}
            key={row.id}
            lead={<Messages className="size-4" />}
            title={copy.ownerChats.title}
          />
        ) : (
          <SettingsRow
            control={row.status === 'connected' ? undefined : <SettingsStatus>{copy.notConnected}</SettingsStatus>}
            data-atum-connection={row.id}
            help={copy.homeTools.line}
            key={row.id}
            lead={<Home className="size-4" />}
            title={homeHubName(row.id)}
          />
        )
      )}
    </SettingsSection>
  )
}
