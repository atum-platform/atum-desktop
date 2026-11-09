import {
  isManagedModelTemporarilyUnavailable,
  MANAGED_MODEL_ACCESS_ALIASES,
  managedModelTier
} from '@/lib/atum-managed-model-access'
import type { ModelOptionProvider } from '@/types/hermes'

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export interface AtumModelSliderOption {
  effort?: string
  model: string
  provider: string
  unavailable: boolean
}

/** Fixed-model mode exposes only reasoning depths advertised for that model. */
export function atumThinkingSliderOptions(
  providers: readonly ModelOptionProvider[],
  model: string
): AtumModelSliderOption[] {
  const provider = providers.find(candidate => candidate.slug === 'atum-managed' && candidate.models?.includes(model))

  if (!provider) {
    return []
  }

  const caps = provider.capabilities?.[model]
  const efforts = caps?.reasoning ? EFFORT_ORDER.filter(effort => caps.efforts?.includes(effort)) : []

  const option = {
    model,
    provider: provider.slug,
    unavailable: isManagedModelTemporarilyUnavailable(provider.slug, model)
  }

  return efforts.length ? efforts.map(effort => ({ ...option, effort })) : [option]
}

/**
 * The consumer picker deliberately has one useful choice at each stop. The
 * catalog remains authoritative for both availability and accepted reasoning
 * depths; this only orders the included Atum models from quicker to deeper.
 */
export function atumModelSliderOptions(providers: readonly ModelOptionProvider[]): AtumModelSliderOption[] {
  const provider = providers.find(candidate => candidate.slug === 'atum-managed')

  if (!provider) {
    return []
  }

  const models = new Set(provider.models ?? [])

  return MANAGED_MODEL_ACCESS_ALIASES.flatMap(model => {
    if (!models.has(model)) {
      return []
    }

    const caps = provider.capabilities?.[model]

    const efforts = caps?.reasoning ? EFFORT_ORDER.filter(effort => caps.efforts?.includes(effort)) : []

    const tier = managedModelTier(model)
    const effortIndex = tier === 'fast' ? 0 : tier === 'deep' ? efforts.length - 1 : Math.floor(efforts.length / 2)

    return [
      {
        ...(efforts[effortIndex] ? { effort: efforts[effortIndex] } : {}),
        model,
        provider: provider.slug,
        unavailable: isManagedModelTemporarilyUnavailable(provider.slug, model)
      }
    ]
  })
}

/**
 * What the current selection reads as: the model, plus its thinking depth when
 * the catalog advertises one for it. Shared by the menu header (which shows it)
 * and the slider (which speaks it as `aria-valuetext`), so the two can never
 * disagree about what is selected.
 */
export function atumModelSelectionLabel(
  options: readonly AtumModelSliderOption[],
  currentModel: string,
  currentEffort: string,
  displayName: (model: string) => string,
  effortLabel: (effort: string) => string,
  fallback?: AtumModelSliderOption
): string {
  const model = currentModel || fallback?.model || ''

  if (!model) {
    return ''
  }

  const effort = currentModel
    ? options.some(option => option.model === currentModel && option.effort)
      ? currentEffort
      : ''
    : (fallback?.effort ?? '')

  return `${displayName(model)}${effort ? ` · ${effortLabel(effort)}` : ''}`
}
