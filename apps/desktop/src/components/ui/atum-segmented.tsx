import { cn } from '@/lib/utils'

/** Existing Atum consumer-settings segmented control, without profile/store dependencies. */
export function AtumSegmented<T extends string>({
  label,
  onChange,
  options,
  value,
  disabled = false
}: {
  label: string
  onChange(next: T): void
  /** A badge says what is not shipped yet; a disabled option stays visible but cannot be chosen. */
  options: ReadonlyArray<{ id: T; label: string; badge?: string; disabled?: boolean }>
  value: T
  disabled?: boolean
}) {
  return (
    <div
      aria-label={label}
      className="flex h-8 rounded-[var(--atum-r-tab)] bg-(--atum-sunk) p-[3px] text-(length:--atum-t-control)"
      role="radiogroup"
    >
      {options.map(option => (
        <button
          aria-checked={option.id === value}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            option.id === value
              ? 'bg-(--atum-glass-strong) font-medium text-(--atum-ink) shadow-[0_1px_3px_rgba(23,25,31,0.12)]'
              : 'text-(--atum-ink-muted) hover:text-(--atum-ink)'
          )}
          disabled={disabled || option.disabled}
          key={option.id}
          onClick={() => onChange(option.id)}
          role="radio"
          type="button"
        >
          {option.label}
          {option.badge ? (
            <span className="rounded-full bg-(--atum-glass-strong) px-1.5 py-px text-(length:--atum-t-caption) font-normal text-(--atum-ink-faint)">
              {option.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
