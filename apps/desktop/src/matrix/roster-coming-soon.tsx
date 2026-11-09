import { useI18n } from '@/i18n'

import { appLocalizedCopy } from '../../shared/app-catalog'

import type { MatrixRosterPlaceholder } from './coming-soon-roster'
import { useRosterCopy } from './roster-copy'

/**
 * A coming-soon catalog row. It is text and art only: not a button, not focusable, and it
 * carries no route, room, consent or launch action. Clicking it can only reach whatever the
 * inert wrapper does, never the Matrix app bridge.
 */
export function MatrixComingSoonRow({ placeholder }: { placeholder: MatrixRosterPlaceholder }) {
  const copy = useRosterCopy()
  const { locale } = useI18n()
  const name = appLocalizedCopy(placeholder.name, locale, placeholder.app)

  return (
    <div
      aria-disabled="true"
      className="atum-row flex h-12 items-center px-2"
      data-matrix-coming-soon={placeholder.app}
      data-matrix-coming-soon-row
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {placeholder.icon ? (
          <img
            alt=""
            aria-hidden
            className="atum-avatar size-8 shrink-0 object-cover opacity-60 grayscale"
            data-face="app"
            src={placeholder.icon}
          />
        ) : (
          <span
            aria-hidden
            className="atum-avatar grid size-8 shrink-0 place-items-center bg-(--atum-glass-strong) font-semibold opacity-60"
            data-face="app"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-medium">{name}</p>
          <p className="truncate text-sm text-(--atum-ink-muted)">{copy.comingSoon}</p>
        </div>
      </div>
    </div>
  )
}
