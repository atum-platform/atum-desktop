import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import { AtumSettingsGroup, AtumSettingsRow } from './atum-consumer-settings'
import { SettingsContent } from './primitives'
import type { SettingsView } from './types'

interface AtumAdvancedSettingsProps {
  onOpen: (view: SettingsView) => void
}

/** Navigation to the existing Hermes settings; provider setup stays there. */
export function AtumAdvancedSettings({ onOpen }: AtumAdvancedSettingsProps) {
  const { t } = useI18n()
  const copy = t.atum.settings.advancedPage

  return (
    <SettingsContent>
      <h1 className="text-xl font-semibold text-(--atum-ink)">{t.atum.settings.advanced}</h1>
      <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.description}</p>
      <section aria-labelledby="advanced-models-heading" className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-(--atum-ink)" id="advanced-models-heading">{copy.modelsTitle}</h2>
        <AtumSettingsGroup>
          <AtumSettingsRow
            action={<Button onClick={() => onOpen('config:model')} variant="secondary">{copy.choose}</Button>}
            description={copy.modelDescription}
            title={t.atum.settings.model}
          />
          <AtumSettingsRow
            action={<Button onClick={() => onOpen('providers')} variant="secondary">{copy.manage}</Button>}
            description={copy.providersDescription}
            title={copy.providersTitle}
          />
        </AtumSettingsGroup>
        <p className="mt-3 text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.scope}</p>
      </section>
      <section aria-label={t.atum.settings.systemConfiguration} className="mt-6">
        <AtumSettingsGroup>
          <AtumSettingsRow
            action={<Button onClick={() => onOpen('config:advanced')} variant="secondary">{copy.open}</Button>}
            description={copy.systemDescription}
            title={t.atum.settings.systemConfiguration}
          />
        </AtumSettingsGroup>
      </section>
    </SettingsContent>
  )
}
