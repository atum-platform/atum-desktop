import { useStore } from '@nanostores/react'
import { type ReactNode } from 'react'

import { UtilityConnectionCard } from '@/app/atum/utilities/connection-card'
import { LanguageSwitcher } from '@/components/language-switcher'
import { AtumSegmented } from '@/components/ui/atum-segmented'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { displayModelName } from '@/lib/model-status-label'
import { $currentModel } from '@/store/session'
import {
  $zoomPercent,
  normalizeTextSizeSliderPercent,
  setZoomPercent,
  TEXT_SIZE_MAX_PERCENT,
  TEXT_SIZE_MIN_PERCENT,
  TEXT_SIZE_STEP_PERCENT
} from '@/store/zoom'
import { useTheme } from '@/themes'

import { MODE_OPTIONS } from './constants'
import { PetSettings } from './pet-settings'

/** Mock 2b: rows min-h 64, pad 12 18, title 14/500 + desc 12.5 muted, control right; 1px inset dividers. */
export function AtumSettingsRow({ action, description, title }: { action: ReactNode; description?: ReactNode; title: ReactNode }) {
  return (
    <div className="flex min-h-16 items-center gap-4 px-[1.125rem] py-3 shadow-[inset_0_-1px_0_var(--atum-line)] last:shadow-none" data-atum-settings-row>
      <div className="min-w-0 flex-1">
        <div className="text-[0.875rem] font-medium text-(--atum-ink)">{title}</div>
        {description && <div className="mt-0.5 text-(length:--atum-t-body) text-(--atum-ink-muted)">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center">{action}</div>
    </div>
  )
}

/** Mock 2b grouped card: r16 glass card, rows inside. */
export function AtumSettingsGroup({ children }: { children: ReactNode }) {
  return <div className="atum-glass-card mt-7 flex flex-col overflow-hidden rounded-[var(--atum-r-group)] first:mt-8">{children}</div>
}

export function AtumSettingsPage({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return (
    <section className="min-h-0 overflow-hidden">
      <div className="h-full min-h-0 overflow-y-auto px-10 pb-16 pt-[3.75rem]">
        <div className="mx-auto max-w-[38.75rem]">
          <h2 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-(--atum-ink)">{title}</h2>
          <p className="mt-1.5 text-[0.875rem] text-(--atum-ink-muted)">{description}</p>
          {children}
        </div>
      </div>
    </section>
  )
}

/** The intentionally small, consumer-facing Atum settings home (mock 2b). */
export function AtumConsumerSettings() {
  const { isSavingLocale, t } = useI18n()
  const { mode, setMode } = useTheme()
  const zoomPercent = useStore($zoomPercent)
  const currentModel = useStore($currentModel)
  const textSizePercent = normalizeTextSizeSliderPercent(zoomPercent)
  const copy = t.atum.settings
  const modeOptions = MODE_OPTIONS.map(({ id }) => ({ id, label: t.settings.modeOptions[id].label }))
  const sliderPercent = ((textSizePercent - TEXT_SIZE_MIN_PERCENT) / (TEXT_SIZE_MAX_PERCENT - TEXT_SIZE_MIN_PERCENT)) * 100

  return (
    <AtumSettingsPage description={copy.description} title={copy.general}>
      <div className="mt-8"><UtilityConnectionCard manage /></div>
      <AtumSettingsGroup>
        <AtumSettingsRow
          action={<LanguageSwitcher />}
          description={isSavingLocale ? t.language.saving : t.language.description}
          title={t.language.label}
        />
        <AtumSettingsRow
          action={
            <AtumSegmented
              label={copy.appearance}
              onChange={next => {
                triggerHaptic('selection')
                setMode(next)
              }}
              options={modeOptions}
              value={mode}
            />
          }
          description={copy.appearanceDescription}
          title={copy.appearance}
        />
        <AtumSettingsRow
          action={
            <div className="flex w-[13.75rem] items-center gap-2.5">
              <span aria-hidden className="text-(length:--atum-t-label) text-(--atum-ink-faint)">
                A
              </span>
              <span className="relative flex h-1 flex-1 items-center rounded-[2px] bg-(--atum-pressed)">
                <span aria-hidden className="absolute left-0 top-0 h-1 rounded-[2px] bg-(--atum-ink)" style={{ width: `${sliderPercent}%` }} />
                <input
                  aria-label={copy.textSize}
                  className="atum-slider absolute inset-0 h-1 w-full cursor-pointer appearance-none bg-transparent"
                  max={TEXT_SIZE_MAX_PERCENT}
                  min={TEXT_SIZE_MIN_PERCENT}
                  onChange={event => setZoomPercent(Number(event.target.value))}
                  step={TEXT_SIZE_STEP_PERCENT}
                  type="range"
                  value={textSizePercent}
                />
              </span>
              <span aria-hidden className="text-base text-(--atum-ink-muted)">
                A
              </span>
              <output className="w-10 text-right text-(length:--atum-t-body) text-(--atum-ink-muted) [font-variant-numeric:tabular-nums]">
                {textSizePercent}%
              </output>
            </div>
          }
          description={copy.textSizeDescription}
          title={copy.textSize}
        />
      </AtumSettingsGroup>

      <AtumSettingsGroup>
        <AtumSettingsRow
          action={<span className="max-w-48 truncate text-(length:--atum-t-body) text-(--atum-ink-muted)">{displayModelName(currentModel)}</span>}
          description={copy.modelDescription}
          title={copy.model}
        />
      </AtumSettingsGroup>

      {/* Pets are a consumer feature — one per assistant, adopted from the
          store — so they are managed here in the open, not behind Advanced.
          The section carries the anchor (PET_SETTINGS_SECTION_ID) the account
          menu's "Pet settings…" deep link lands on. It also still renders
          inside AppearanceSettings for the legacy shell and Advanced — the two
          views are mutually exclusive, so it never shows twice. */}
      <div className="mt-10">
        <PetSettings />
      </div>
    </AtumSettingsPage>
  )
}
