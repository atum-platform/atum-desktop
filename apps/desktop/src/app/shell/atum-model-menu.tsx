import { useEffect, useRef, useState } from 'react'

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { displayModelName, reasoningEffortLabel } from '@/lib/model-status-label'
import type { ModelOptionProvider } from '@/types/hermes'

import { AtumModelSlider } from './atum-model-slider'
import {
  atumModelSelectionLabel,
  type AtumModelSliderOption,
  atumModelSliderOptions,
  atumThinkingSliderOptions
} from './atum-model-slider-options'

interface AtumModelMenuProps {
  currentEffort: string
  currentModel: string
  error: boolean
  loading: boolean
  onAdvanced: () => void
  onSelect: (option: AtumModelSliderOption) => Promise<boolean>
  providers: readonly ModelOptionProvider[]
}

/**
 * Two surfaces, one at a time — never both at once.
 *
 * The everyday surface is the slider alone: the choice a person makes daily is
 * "quicker or deeper", and in Default mode one drag picks the model AND its
 * thinking depth together. Which model to fix that slider to is a rarer,
 * different question, so it lives one step in — behind the chevron on the
 * header, which reads as the current selection and opens the list.
 *
 * Stacking the radio list on top of the slider made every open present two
 * competing controls and left it ambiguous which one the pick had come from.
 *
 * Mode is local to each opening; opening the menu never writes session config.
 */
export function AtumModelMenu({
  currentEffort,
  currentModel,
  error,
  loading,
  onAdvanced,
  onSelect,
  providers
}: AtumModelMenuProps) {
  const { t } = useI18n()
  const copy = t.atum.composer
  const [fixedModel, setFixedModel] = useState<string | null>(null)
  const [choosingModel, setChoosingModel] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const selecting = useRef(false)
  // A switch outlives the menu when the dropdown is dismissed mid-flight. React
  // drops the resulting updates, but only silently — make the boundary explicit
  // so a later continuation cannot quietly acquire a side effect.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])
  const recommended = atumModelSliderOptions(providers)
  const options = fixedModel ? atumThinkingSliderOptions(providers, fixedModel) : recommended

  const select = async (option: AtumModelSliderOption, nextMode?: string | null) => {
    if (selecting.current || option.unavailable) {
      return false
    }

    selecting.current = true
    setPending(true)
    setFailed(false)

    try {
      if (!(await onSelect(option))) {
        if (mounted.current) {
          setFailed(true)
        }

        return false
      }

      if (nextMode !== undefined && mounted.current) {
        setFixedModel(nextMode)
      }

      return true
    } catch {
      if (mounted.current) {
        setFailed(true)
      }

      return false
    } finally {
      selecting.current = false

      if (mounted.current) {
        setPending(false)
      }
    }
  }

  const chooseModel = async (option: AtumModelSliderOption) => {
    const efforts = atumThinkingSliderOptions(providers, option.model)
    // Preserve a supported depth when changing model; otherwise use its
    // recommended pair. Never send the old model's unsupported effort.
    const selection = efforts.find(candidate => candidate.effort === currentEffort) ?? option

    // Return to the slider only once the switch has actually landed. Leaving
    // on the click would show the slider under the OLD model while the request
    // was still in flight, and would drop a person back onto it with no idea
    // their pick had failed — the failure notice lives on this view.
    if (await select(selection, option.model) && mounted.current) {
      setChoosingModel(false)
    }
  }

  const defaultOption =
    recommended.find(option => option.model === currentModel && !option.unavailable) ??
    recommended.find(option => !option.unavailable)

  const effortLabel = (effort: string) => {
    const labels: Record<string, string> = {
      none: t.common.off,
      minimal: t.shell.modelOptions.minimal,
      low: t.shell.modelOptions.low,
      medium: t.shell.modelOptions.medium,
      high: t.shell.modelOptions.high,
      xhigh: t.shell.modelOptions.xhigh,
      max: t.shell.modelOptions.max,
      ultra: t.shell.modelOptions.ultra
    }

    return labels[effort] ?? reasoningEffortLabel(effort)
  }

  if (choosingModel) {
    return (
      <div className="py-1 text-[13px]" data-testid="atum-model-menu" data-view="models">
        <div className="flex items-center gap-1 px-1.5 py-1">
          <button
            aria-label={t.common.back}
            className="grid size-6 shrink-0 place-items-center rounded-md text-(--atum-ink-muted) hover:bg-(--atum-hover) hover:text-(--atum-ink)"
            data-testid="atum-model-menu-back"
            disabled={pending}
            onClick={() => setChoosingModel(false)}
            type="button"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--atum-ink)">
            {copy.modelChoose}
          </span>
        </div>
        <DropdownMenuRadioGroup value={fixedModel ?? 'default'}>
          <DropdownMenuRadioItem
            aria-description={copy.modelDefaultDescription}
            aria-label={copy.modelDefault}
            className="mx-1 px-2 py-2 text-[13px]"
            disabled={pending || loading || !defaultOption}
            onSelect={event => {
              event.preventDefault()

              if (defaultOption) {
                void select(defaultOption, null).then(ok => {
                  if (ok && mounted.current) {
                    setChoosingModel(false)
                  }
                })
              }
            }}
            value="default"
          >
            <span>
              <span className="block">{copy.modelDefault}</span>
              <span className="mt-0.5 block text-xs text-(--atum-ink-muted)">{copy.modelDefaultDescription}</span>
            </span>
          </DropdownMenuRadioItem>
          {recommended.map(option => (
            <DropdownMenuRadioItem
              className="mx-1 px-2 py-2 text-[13px]"
              disabled={pending || option.unavailable}
              key={option.model}
              onSelect={event => {
                event.preventDefault()
                void chooseModel(option)
              }}
              value={option.model}
            >
              {displayModelName(option.model)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {failed && (
          <p className="px-3 pb-2 pt-1 text-xs text-(--atum-ink-muted)" role="status">
            {t.shell.modelOptions.updateFailed}
          </p>
        )}
      </div>
    )
  }

  // The header both READS the current selection and is the only way into the
  // model list. It names the model and its depth — the same string the slider
  // speaks as `aria-valuetext` — over a quiet line saying which mode produced
  // it: Default, where one drag picks model and depth together, or a model the
  // person pinned, where the drag only moves depth.
  const headerTitle =
    atumModelSelectionLabel(options, currentModel, currentEffort, displayModelName, effortLabel, options[0]) ||
    copy.modelDefault

  // Under the header, one line only when it adds something: in Default mode
  // it says the model is chosen automatically. With a model pinned the slider
  // already carries its own "thinking depth" label, and repeating it here read
  // as a duplicate.
  const headerDetail = fixedModel ? null : copy.modelDefaultDescription

  return (
    <div className="py-1 text-[13px]" data-testid="atum-model-menu" data-view="slider">
      <DropdownMenuLabel className="sr-only">{t.modelPicker.title}</DropdownMenuLabel>
      <button
        aria-label={`${copy.modelChoose}: ${headerTitle}`}
        className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--atum-hover)"
        data-testid="atum-model-menu-open-models"
        disabled={pending || loading}
        onClick={() => setChoosingModel(true)}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-(--atum-ink)">{headerTitle}</span>
          {headerDetail && <span className="mt-0.5 block truncate text-xs text-(--atum-ink-muted)">{headerDetail}</span>}
        </span>
        <ChevronRight className="size-4 shrink-0 text-(--atum-ink-faint)" />
      </button>
      {loading ? (
        <div className="px-3 py-2">
          <Skeleton className="h-11 w-full" />
        </div>
      ) : error ? (
        <p className="px-3 py-2 text-xs">{t.modelPicker.loadFailed}</p>
      ) : options.length ? (
        <AtumModelSlider
          currentEffort={currentEffort}
          currentModel={currentModel}
          disabled={pending}
          fasterLabel={copy.modelFaster}
          key={fixedModel ?? 'default'}
          onSelect={option => select(option)}
          options={options}
          smarterLabel={copy.modelSmarter}
          thinkingOnly={fixedModel !== null}
          unavailableLabel={copy.modelUnavailable}
        />
      ) : (
        <p className="px-3 py-2 text-xs">{t.shell.modelMenu.noModels}</p>
      )}
      {failed && (
        <p className="px-3 pb-2 text-xs text-(--atum-ink-muted)" role="status">
          {t.shell.modelOptions.updateFailed}
        </p>
      )}
      <DropdownMenuSeparator className="mx-0" />
      <DropdownMenuItem
        className="mx-1 px-2 py-2 text-xs text-(--atum-ink-muted)"
        disabled={pending}
        onSelect={event => {
          event.preventDefault()
          onAdvanced()
        }}
      >
        {t.atum.settings.advancedOptions}
      </DropdownMenuItem>
    </div>
  )
}
