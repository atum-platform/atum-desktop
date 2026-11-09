import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import type { DocumentStatusBarProps } from './document-command-types'

const ZOOM_LEVELS = [75, 100, 125, 150, 200]

/** A document-only view status row; zoom never changes the workspace chrome. */
export function DocumentStatusBar({
  fitWidthLabel,
  onZoom,
  status,
  wordCountLabel,
  zoom,
  zoomLabel
}: DocumentStatusBarProps) {
  const zoomValue = zoom === 'fit' ? 'fit' : String(zoom)

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-t border-(--atum-line) px-3 text-[0.6875rem] text-(--atum-ink-muted)">
      <span className="shrink-0 whitespace-nowrap">{wordCountLabel}</span>
      {status ? (
        <span aria-live="polite" className="ml-auto truncate" role="status">
          {status}
        </span>
      ) : (
        <span className="ml-auto" />
      )}
      <Select onValueChange={value => onZoom(value === 'fit' ? 'fit' : Number(value))} value={zoomValue}>
        <SelectTrigger aria-label={zoomLabel} className="w-28 shrink-0" size="xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="fit">{fitWidthLabel}</SelectItem>
          {ZOOM_LEVELS.map(level => (
            <SelectItem key={level} value={String(level)}>
              {level}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
