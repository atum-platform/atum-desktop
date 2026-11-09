import type * as React from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

export interface ToolIconProps {
  className?: string
  name: string
  size?: number | string
}

/**
 * In-thread tool glyph. Tool rows are secondary, muted lines (Shell v2 §1a:
 * 13.5 muted text with 15px icons), so they use the same outline glyphs as the
 * rest of the app; the old filled tool paths are gone. Names stay the TOOL_META
 * keys; `Codicon` resolves them through the one name map.
 */
export function ToolIcon({ className, name, size = '1rem' }: ToolIconProps) {
  const dimension: React.CSSProperties['width'] = size

  return <Codicon className={cn('shrink-0', className)} name={name} size={dimension} />
}
