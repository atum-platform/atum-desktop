import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import spec from './model-picker-spec.json'

/** The shared picker measures (model-picker-spec.json) as the custom properties the classes below read. */
export const MODEL_PICKER_SPEC = spec

const px = (value: number) => `${value}px`

export const MODEL_PICKER_VARS = {
  '--mp-list-w': px(spec.card.listWidth),
  '--mp-effort-w': px(spec.card.effortWidth),
  '--mp-body-h': px(spec.card.bodyHeight),
  '--mp-rail-w': px(spec.rail.width),
  '--mp-rail-item': px(spec.rail.item),
  '--mp-rail-radius': px(spec.rail.itemRadius),
  '--mp-rail-icon': px(spec.rail.icon),
  '--mp-ind-w': px(spec.rail.indicatorWidth),
  '--mp-ind-h': px(spec.rail.indicatorHeight),
  '--mp-ind-inset': px(spec.rail.indicatorInset),
  '--mp-search-top': px(spec.search.insetTop),
  '--mp-search-x': px(spec.search.insetX),
  '--mp-search-h': px(spec.search.height),
  '--mp-search-icon': px(spec.search.icon),
  '--mp-search-rule': px(spec.search.underline),
  '--mp-row-h': px(spec.row.height),
  '--mp-row-x': px(spec.row.paddingX),
  '--mp-row-r': px(spec.row.radius),
  '--mp-row-gap': px(spec.row.gap),
  '--mp-mark': px(spec.row.mark),
  '--mp-text': px(spec.type.size),
  '--mp-weight': String(spec.type.weight),
  '--mp-trigger-h': px(spec.trigger.height),
  '--mp-trigger-x': px(spec.trigger.paddingX),
  '--mp-trigger-gap': px(spec.trigger.gap),
  '--mp-trigger-mark': px(spec.trigger.mark),
  '--mp-trigger-text': px(spec.trigger.size),
  '--mp-trigger-weight': String(spec.trigger.weight)
} as CSSProperties

/** The composer's chip that opens the card: the current model's mark and name in a plain capsule, no chevron. */
export const PICKER_TRIGGER = cn(
  'inline-flex h-(--mp-trigger-h) max-w-56 min-w-0 shrink-0 items-center gap-(--mp-trigger-gap) rounded-full px-(--mp-trigger-x)',
  'text-(length:--mp-trigger-text) [font-weight:var(--mp-trigger-weight)] whitespace-nowrap text-(--ak-ink-2)',
  'hover:bg-(--atum-hover) aria-expanded:bg-(--atum-hover) disabled:opacity-45 [-webkit-app-region:no-drag]'
)

/** A row of the card: a model, its connection, and why it cannot be chosen. */
export const PICKER_ROW = cn(
  'flex min-h-(--mp-row-h) w-full min-w-0 items-center gap-(--mp-row-gap) rounded-(--mp-row-r) px-(--mp-row-x) py-1 text-left',
  'text-(length:--mp-text) text-(--atum-ink) hover:bg-(--atum-hover) disabled:cursor-default',
  'disabled:opacity-45 disabled:hover:bg-transparent aria-disabled:opacity-45 aria-disabled:hover:bg-transparent'
)

/** A section's header: the connection's mark and name, and the caret that opens it. */
export const PICKER_HEADER = cn(
  'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[var(--atum-r-row)] px-2 py-1 text-left',
  'text-(length:--atum-t-caption) font-medium text-(--atum-ink-muted) hover:bg-(--atum-hover) hover:text-(--atum-ink)'
)

/** The one column of a stacked grid, able to shrink below its widest row's text. */
export const PICKER_TRACK = 'grid-cols-[minmax(0,1fr)]'

/** A small status word beside a model's name ("Default", "Coming soon"). */
export const PICKER_BADGE =
  'shrink-0 rounded-[0.375rem] bg-(--atum-hover) px-1.5 py-0.5 text-[10px] font-medium leading-none text-(--atum-ink-muted)'

export const PICKER_NOTE = 'text-xs whitespace-normal text-(--atum-ink-muted)'
