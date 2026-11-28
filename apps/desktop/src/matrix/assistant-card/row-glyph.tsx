import type { ComponentProps } from 'react'

import type { IconComponent } from '@/lib/phosphor-icon'

/** A card row's leading glyph (Atum Kit STYLE §13): Phosphor Light, ink-2, before the label. */
export function RowGlyph({ icon: Icon }: { icon: IconComponent }) {
  return <Icon aria-hidden className="atum-card-row-glyph" />
}

/**
 * One state notice under the card's header (kit `.ak-notice`): a glyph, a title, at most one line,
 * and its one action. The card shows one at a time.
 */
export function CardNotice({
  action,
  body,
  icon: Icon,
  title,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  action?: { label: string; onClick(): void; disabled?: boolean }
  body?: string
  icon: IconComponent
  title: string
}) {
  return (
    <div className="ak-notice atum-card-notice" role="status" {...props}>
      <Icon aria-hidden className="ak-icon" />
      <div className="ak-notice-main">
        <span className="ak-notice-title">{title}</span>
        {body && <span className="ak-notice-body">{body}</span>}
      </div>
      {action && (
        <div className="ak-notice-actions">
          <button className="ak-btn ak-btn--sm" disabled={action.disabled} onClick={action.onClick} type="button">
            {action.label}
          </button>
        </div>
      )}
    </div>
  )
}
