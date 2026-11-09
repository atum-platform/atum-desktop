import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchField } from '@/components/ui/search-field'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'

import type { DocumentNavigationApi, DocumentSearchStatus } from './document-editor-controller'

export { documentOutline, documentWordCount } from './document-navigation-model'

export interface DocumentNavigationProps {
  api: DocumentNavigationApi
  composing: boolean
  disabled: boolean
  editorKey: string
  focusRequest: number
  onClose: () => void
  onFocusEditor: () => void
  outline: boolean
  text: string
}

export function DocumentNavigation({ text, outline, api, composing, disabled, editorKey, focusRequest, onClose, onFocusEditor }: DocumentNavigationProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const replacementRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [status, setStatus] = useState<DocumentSearchStatus>({ current: 0, total: 0 })
  // Source text is the revision signal, but the active editor owns heading text
  // and positions. Rich titles therefore contain no Markdown delimiters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const headings = useMemo(() => outline ? api.getOutline() : [], [api, text, outline, editorKey])

  useEffect(() => {
    if (!outline) { inputRef.current?.focus() }
  }, [outline, focusRequest])

  useEffect(() => {
    if (!disabled) { setStatus(api.setSearchQuery(outline ? '' : query)) }
  }, [api, query, text, outline, editorKey, disabled])

  useEffect(() => () => { api.setSearchQuery('') }, [api, editorKey])

  const find = (direction: 1 | -1) => {
    if (!disabled && query) { setStatus(api.search(query, direction)) }
  }

  const close = () => { if (!composing) { onClose(); onFocusEditor() } }

  const replace = () => {
    if (disabled || !query) { return }
    api.replaceSearchMatch(query, replacement)
    find(1)
  }

  return (
    <div
      aria-label={outline ? t.document.outline : t.document.findReplace}
      className="max-h-40 shrink-0 overflow-auto border-b border-(--atum-line) px-3 py-2"
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) { return }

        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        } else if (event.key === 'Enter' && event.target === inputRef.current) {
          event.preventDefault()
          event.stopPropagation()
          find(event.shiftKey ? -1 : 1)
        } else if (event.key === 'Enter' && event.target === replacementRef.current) {
          event.preventDefault()
          event.stopPropagation()
          replace()
        }
      }}
      role="region"
    >
      <div className="flex items-start gap-2">
        {outline ? (
          <nav aria-label={t.document.outline} className="flex min-w-0 flex-1 flex-col items-start gap-1">
            {headings.map(heading => (
              <Button
                disabled={disabled}
                key={heading.from}
                onClick={() => { if (!disabled && api.navigateToHeading(heading.from)) { onFocusEditor() } }}
                size="xs"
                variant="ghost"
              >
                {'\u00a0'.repeat((heading.level - 1) * 2)}{heading.title}
              </Button>
            ))}
          </nav>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <SearchField aria-label={t.document.find} containerClassName="w-32" inputRef={inputRef} onChange={setQuery} placeholder={t.document.find} value={query} />
            <Button disabled={disabled || !query || !status.total} onClick={() => find(-1)} size="xs" variant="ghost">{t.document.previousMatch}</Button>
            <Button disabled={disabled || !query || !status.total} onClick={() => find(1)} size="xs" variant="ghost">{t.document.next}</Button>
            <span aria-live="polite" className="text-xs text-(--atum-ink-muted)" role="status">
              {query ? status.total ? t.document.matchCount.replace('{current}', String(status.current)).replace('{total}', String(status.total)) : t.document.noMatches : ''}
            </span>
            <Input aria-label={t.document.replace} className="w-32" onChange={event => setReplacement(event.target.value)} placeholder={t.document.replace} ref={replacementRef} size="xs" value={replacement} />
            <Button disabled={disabled || !query || !status.total} onClick={replace} size="xs" variant="ghost">{t.document.replaceSelection}</Button>
          </div>
        )}
        <Button aria-label={t.common.close} disabled={composing} onClick={close} size="icon-xs" variant="ghost"><X /></Button>
      </div>
    </div>
  )
}
