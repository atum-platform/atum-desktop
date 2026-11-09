import { useStore } from '@nanostores/react'

import { AccountInteractionPermissions } from '@/app/atum/account-interaction-permissions'
import { AtumAccountDialog } from '@/app/atum/account-menu'
import { LinkedAppsSettings } from '@/app/atum/linked-apps-settings'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $atumAccountStatus } from '@/store/atum-messaging'

import { AtumAwarenessSettings } from './atum-awareness-settings'
import { AtumSettingsGroup, AtumSettingsPage, AtumSettingsRow } from './atum-consumer-settings'

export function AtumAccountSettings() {
  const { t } = useI18n()
  const identity = useStore($atumAccountStatus).account

  return (
    <AtumSettingsPage description={t.atum.settings.accountDescription} title={t.atum.settings.account}>
      <AtumSettingsGroup>
        <AtumSettingsRow
          action={<AtumAccountDialog><Button size="sm" variant="outline">{t.atum.account.editProfile}</Button></AtumAccountDialog>}
          description={identity?.handle ? `@${identity.handle}` : undefined}
          title={identity?.displayName || t.atum.account.title}
        />
      </AtumSettingsGroup>
      <div className="mt-8"><LinkedAppsSettings /></div>
      <div className="mt-8"><AccountInteractionPermissions /></div>
      <AtumAwarenessSettings />
    </AtumSettingsPage>
  )
}
