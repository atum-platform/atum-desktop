import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { setWorkActive } from '@/app/work/store'
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

import { AccountPlanMark } from './connect-sheet'
import { ACCOUNT_PLAN_NAMES, connectionsCopy, type ConnectionsWords } from './copy'
import { $accountConnections, $nativeRenewal, refreshNativeRenewal, type ConnectionsBridge, loadAccountConnections, openAccountConnect } from './store'
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

function useAccountConnections() {
  const view = useStore($accountConnections)

  useEffect(() => {
    const refresh = () => { void loadAccountConnections(); void refreshNativeRenewal() }

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
  bridge?: Pick<ConnectionsBridge, 'openPlanConnect'>
  /** Closes Settings so the owner lands on Work. */
  onLeave?: () => void
  scopeKey?: string
}) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale)
  const view = useAccountConnections()
  const renewal = useStore($nativeRenewal)
  const rows = accountPlanRows(view)
  const opencode = useMatrixSubscriptions(scopeKey)
  const opencodeConnected = subscriptionProviderStatus(opencode.status, 'opencode-go')?.connected === true
  const [keyDialog, setKeyDialog] = useState<'connect' | 'manage' | null>(null)

  const manage = (row: AccountPlanRow) => {
    onLeave?.()
    setWorkActive(true)
    void bridge?.openPlanConnect(row.plan).catch(() => undefined)
  }

  return (
    <SettingsSection data-matrix-settings-section="subscriptions" title={copy.subscriptions}>
      {renewal && (
        <SettingsRow title={copy.renewal} data-atum-native-renewal control={
          <button className="ak-btn ak-btn--sm" onClick={() => openAccountConnect(renewal, 'renew')} type="button">{copy.renew}</button>
        } />
      )}
      {rows.map(row => (
        <SettingsRow
          control={
            row.state === 'not_connected' || row.state === 'needs_attention' ? (
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
          help={accountPlanLine(row, copy)}
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
