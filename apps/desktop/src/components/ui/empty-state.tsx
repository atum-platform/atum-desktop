import { cn } from '@/lib/utils'

// Canonical centered empty state (title + description). The default for "no
// results / nothing here yet" page bodies. For richer master-detail lists that
// want an icon + action, use PanelEmpty (overlays/panel); the file-tree's
// inline uppercase error state is its own deliberately-distinct treatment.
export function EmptyState({
  title,
  description,
  className
}: {
  title: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn('grid min-h-48 place-items-center text-center', className)}>
      {/* Atum Kit 0.1 state: a headline and one quiet line. */}
      <div className="flex flex-col items-center gap-1.5">
        <div className="ak-state-title">{title}</div>
        {description && <div className="ak-state-body">{description}</div>}
      </div>
    </div>
  )
}
