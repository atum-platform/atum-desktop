import { ProtonWalletSection } from '@/app/atum/proton-wallet'
import { useI18n } from '@/i18n'

import { AtumSettingsPage } from './atum-consumer-settings'

export function AtumProtonsSettings() {
  const { t } = useI18n()

  return (
    <AtumSettingsPage description={t.atum.protons.description} title={t.atum.protons.title}>
      <ProtonWalletSection />
    </AtumSettingsPage>
  )
}
