import { cn } from '@/lib/utils'

/** A row of the card: a model, its connection, and why it cannot be chosen. */
export const PICKER_ROW = cn(
  'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--atum-r-row)] px-2.5 py-1.5 text-left',
  'text-(length:--atum-t-body) text-(--atum-ink) hover:bg-(--atum-hover) disabled:cursor-default',
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
