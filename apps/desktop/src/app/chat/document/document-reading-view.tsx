import './document-reading-view.css'

import type { CSSProperties } from 'react'

import { documentPageStyle } from '@/components/chat/document-canvas'

import type { ResolvedDocumentTheme } from '../../../../shared/atum-office/document-theme'
import { MarkdownPreview } from '../right-rail/preview-markdown'

export function DocumentReadingView({
  text,
  theme,
  zoom
}: {
  text: string
  theme: ResolvedDocumentTheme
  zoom: number | 'fit'
}) {
  const scale = zoom === 'fit' ? 1 : zoom / 100

  const style = {
    ...documentPageStyle(theme, zoom),
    '--document-heading-font': theme.headingFont.css,
    '--document-accent': `#${theme.accentHex}`,
    ...Object.fromEntries(theme.headingSizesPt.map((size, index) => [`--document-h${index + 1}`, `${size * scale}pt`]))
  } as CSSProperties

  return (
    <div className="atum-document-reading h-full overflow-auto px-3 pt-5 pb-10">
      <div style={style}>
        <MarkdownPreview text={text} />
      </div>
    </div>
  )
}
