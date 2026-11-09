import type { ReactNode } from 'react'

import { RowButton } from '@/components/ui/row-button'
import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

/** Shared transport-free provider grouping and local-endpoint entry. Legacy
 * settings and native-selected Matrix pages retain the same glass controls. */
export function ProviderGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 px-0.5 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-tertiary)">
      {children}
    </p>
  )
}

export function ProviderLocalEndpointRow({ onOpen, disabled = false }: { onOpen: () => void; disabled?: boolean }) {
  const { t } = useI18n()
  const copy = t.settings.providers.localEndpoint

  return (
    <RowButton
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-[6px] px-3 py-2.5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
      disabled={disabled}
      onClick={onOpen}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[length:var(--conversation-text-font-size)] font-semibold">{copy.title}</span>
        <span className="truncate text-[length:var(--conversation-caption-font-size)] leading-5 text-muted-foreground">
          {copy.description}
        </span>
      </div>
      <ChevronRight className="size-4 text-muted-foreground transition group-hover:text-foreground" />
    </RowButton>
  )
}
