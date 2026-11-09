import { type ComponentProps, type ReactNode, useId } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { Check, ChevronRight, Info } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { useMatrixSettingsCopy } from './settings-copy'

/**
 * Settings' one pattern (DESIGN.md › Settings). A pane is a column of sections; a section
 * is a small title, at most one line of help, one card of rows and at most one footnote;
 * a row is a title, at most one muted line of help, and its control at the right. What
 * does not fit in one line waits behind a (?) tip, and what only support needs behind
 * "Technical details" — never a paragraph in the pane.
 */

/** The (?) beside a title: the explanation that would not fit on one line, a hover or a Tab away. */
export function SettingsTip({ label }: { label: string }) {
  const copy = useMatrixSettingsCopy()

  return (
    <Tip label={label} side="top">
      <button aria-label={copy.moreInfo} className="atum-settings-tip" data-matrix-settings-tip type="button">
        <Info aria-hidden className="size-3.5" />
      </button>
    </Tip>
  )
}

/** Attributes for a section's card: a class, a data attribute. */
type SettingsGroupAttributes = { className?: string } & { [key: `data-${string}`]: string | undefined }

/** A section: its title (and tip), one line of help, one card of rows, a footnote. */
export function SettingsSection({
  action,
  before,
  children,
  className,
  foot,
  group,
  help,
  tip,
  title,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  /** A quiet control at the end of the title line (a refresh). */
  action?: ReactNode
  /** Something that stands on its own above the card (a verification in progress). */
  before?: ReactNode
  foot?: ReactNode
  group?: SettingsGroupAttributes
  help?: ReactNode
  tip?: string
  title?: ReactNode
}) {
  const titleId = useId()

  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn('atum-settings-section', className)}
      {...props}
    >
      {(title || action) && (
        <div className="atum-settings-section-head">
          {title && (
            <h3 className="ak-section atum-settings-section-title" id={titleId}>
              {title}
            </h3>
          )}
          {tip && <SettingsTip label={tip} />}
          {action && <span className="atum-settings-section-action">{action}</span>}
        </div>
      )}
      {help && <p className="atum-settings-section-help">{help}</p>}
      {before}
      <div {...group} className={cn('ak-group atum-settings-group', group?.className)}>
        {children}
      </div>
      {foot && <p className="atum-settings-section-foot">{foot}</p>}
    </section>
  )
}

interface SettingsRowProps extends Omit<ComponentProps<'div'>, 'title'> {
  /** A whole-row label, so a click anywhere on it reaches the row's switch. */
  as?: 'div' | 'label'
  /** The control at the right: a switch, a segmented choice, a button, a status. */
  control?: ReactNode
  /** At most one line, muted: what the row is for, or its state. */
  help?: ReactNode
  /** A tile before the words: a source's or an app's glyph (Atum Kit What Atum knows board). */
  lead?: ReactNode
  /** The rest of the explanation, behind a (?). */
  tip?: string
  title: ReactNode
}

/** One row: its title, one muted line of help, its control at the right. */
export function SettingsRow({
  as = 'div',
  children,
  className,
  control,
  help,
  lead,
  tip,
  title,
  ...props
}: SettingsRowProps) {
  const body = (
    <>
      {lead && (
        <span aria-hidden className="atum-settings-row-lead">
          {lead}
        </span>
      )}
      <span className="atum-settings-row-text">
        <span className="atum-settings-row-title">
          {title}
          {tip && <SettingsTip label={tip} />}
        </span>
        {help && <span className="atum-settings-row-help">{help}</span>}
      </span>
      {control && <span className="atum-settings-row-control">{control}</span>}
      {children}
    </>
  )

  return as === 'label' ? (
    <label className={cn('ak-row atum-settings-row cursor-pointer', className)} {...(props as ComponentProps<'label'>)}>
      {body}
    </label>
  ) : (
    <div className={cn('ak-row atum-settings-row', className)} {...props}>
      {body}
    </div>
  )
}

/** A row that opens something else (a sheet, a page): its words and a chevron. */
export function SettingsLinkRow({
  children,
  className,
  trailing,
  ...props
}: ComponentProps<'button'> & { trailing?: ReactNode }) {
  return (
    <button className={cn('ak-row atum-settings-row atum-settings-link', className)} type="button" {...props}>
      <span className="atum-settings-row-text atum-settings-row-title">{children}</span>
      {trailing ?? <ChevronRight aria-hidden className="atum-settings-chevron" />}
    </button>
  )
}

/** A state at the end of a row: "✓ Allowed" when it is done, else plain quiet words. */
export function SettingsStatus({
  children,
  className,
  done = false,
  ...props
}: ComponentProps<'span'> & { done?: boolean }) {
  return (
    <span className={cn('atum-settings-status', className)} data-done={done || undefined} {...props}>
      {done && <Check aria-hidden className="size-3.5" strokeWidth={2.4} />}
      {children}
    </span>
  )
}
