import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { Files, SearchIcon } from '@/lib/icons'

import type { MatrixCompanyErrorCode } from '../../../shared/matrix-company'
import type { MatrixCompanyCopy } from '../../../shared/matrix-company-copy'
import type {
  MatrixCompanyMessageSearchBridge,
  MatrixCompanyMessageSearchResult,
  MatrixCompanyMessageSearchValue
} from '../../../shared/matrix-company-search'
import {
  type MatrixCompanySearchFileType,
  type MatrixCompanySearchTab,
  parseMatrixCompanySearchQuery
} from '../../../shared/matrix-company-search-query'
import { MatrixFileGlyph } from '../file-glyph'

import { companyErrorText } from './outcome'

interface CompanySearchProps {
  bridge: Required<Pick<MatrixCompanyMessageSearchBridge, 'search' | 'open'>>
  companyId: string
  copy: MatrixCompanyCopy
  locale: string
  onOpen(result: MatrixCompanyMessageSearchResult): Promise<void>
}

const FILE_TYPES: MatrixCompanySearchFileType[] = ['all', 'images', 'pdfs', 'documents', 'other']

function today(): string {
  const value = new Date()

  return `${value.getFullYear().toString().padStart(4, '0')}-${(value.getMonth() + 1).toString().padStart(2, '0')}-${value.getDate().toString().padStart(2, '0')}`
}

export function CompanySearch({ bridge, companyId, copy, locale, onOpen }: CompanySearchProps) {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<MatrixCompanySearchTab>('messages')
  const [selectedFileType, setSelectedFileType] = useState<MatrixCompanySearchFileType>('all')
  const [value, setValue] = useState<MatrixCompanyMessageSearchValue>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<MatrixCompanyErrorCode>()
  const [opening, setOpening] = useState<string>()
  const [focused, setFocused] = useState(false)
  const attemptRef = useRef(0)
  const openAttemptRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseMatrixCompanySearchQuery(query.trim()), [query])

  useEffect(() => () => {
    attemptRef.current += 1
    openAttemptRef.current += 1
  }, [])

  const search = async (
    nextTab: MatrixCompanySearchTab = tab,
    nextFileType: MatrixCompanySearchFileType = selectedFileType,
    nextBatch?: string
  ) => {
    const trimmed = query.trim()
    const parsedQuery = parseMatrixCompanySearchQuery(trimmed)

    if (parsedQuery.errors.length > 0 || [...trimmed].length < 2) {return}
    const attempt = ++attemptRef.current
    nextBatch ? setLoadingMore(true) : setLoading(true)
    setError(undefined)
    if (!nextBatch) {setValue(undefined)}

    try {
      const result = await bridge.search({ companyId, query: trimmed, limit: 25, tab: nextTab, fileType: nextFileType,
        ...(nextBatch ? { nextBatch } : {}) })

      if (attemptRef.current !== attempt) {return}

      if (!result.ok) {setError(result.error);

 return}

      setValue(current => nextBatch && current ? {
        ...result.value,
        results: [...current.results, ...result.value.results.filter(item =>
          !current.results.some(existing => existing.eventId === item.eventId))]
      } : result.value)
    } catch {
      if (attemptRef.current === attempt) {setError('unavailable')}
    } finally {
      if (attemptRef.current === attempt) {setLoading(false); setLoadingMore(false)}
    }
  }

  const switchTab = (next: MatrixCompanySearchTab) => {
    attemptRef.current += 1
    setTab(next)
    setValue(undefined)
    setError(undefined)
    setLoading(false)

  }

  const switchFileType = (next: MatrixCompanySearchFileType) => {
    attemptRef.current += 1
    setSelectedFileType(next)
    setValue(undefined)
    setError(undefined)
    setLoading(false)

  }

  const open = async (result: MatrixCompanyMessageSearchResult) => {
    if (opening) {return}
    const attempt = ++openAttemptRef.current
    setOpening(result.eventId)
    setError(undefined)

    try {
      const opened = await bridge.open({ companyId, channelId: result.channelId, roomId: result.roomId,
        eventId: result.eventId, ...(result.threadRootId ? { threadRootId: result.threadRootId } : {}) })

      if (openAttemptRef.current !== attempt) {return}

      if (!opened.ok) {setError(opened.error);

 return}

      await onOpen(result)
    } catch {
      if (openAttemptRef.current === attempt) {setError('unavailable')}
    } finally {
      if (openAttemptRef.current === attempt) {setOpening(undefined)}
    }
  }

  const suggestions = [
    { key: 'from', syntax: 'from:@', description: copy.searchSuggestions.from },
    { key: 'in', syntax: 'in:#', description: copy.searchSuggestions.in },
    { key: 'before', syntax: `before:${today()}`, description: copy.searchSuggestions.before },
    { key: 'after', syntax: `after:${today()}`, description: copy.searchSuggestions.after },
    { key: 'phrase', syntax: `"${copy.searchSuggestions.phrase}"`, description: copy.searchSuggestions.phrase }
  ] as const

  const lastPart = query.trimStart().split(/\s/u).at(-1)?.toLocaleLowerCase() ?? ''

  const visibleSuggestions = focused && !lastPart.startsWith('"')
    ? suggestions.filter(item => !lastPart || item.key.startsWith(lastPart.split(':', 1)[0]!)).slice(0, 5)
    : []

  return (
    <section className="grid gap-(--ak-s2)" data-matrix-company-search>
      <div className="flex flex-wrap items-center justify-between gap-(--ak-s2)">
        <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{copy.searchMessages}</h3>
        <div aria-label={copy.searchMessages} className="ak-seg ak-seg--sm" role="radiogroup">
          {(['messages', 'files'] as const).map(item => (
            <button aria-checked={tab === item} className={tab === item ? 'is-selected' : undefined}
              key={item} onClick={() => switchTab(item)} role="radio" type="button">
              {item === 'messages' ? copy.searchMessagesTab : copy.searchFilesTab}
            </button>
          ))}
        </div>
      </div>
      <form className="grid gap-(--ak-s2)" onSubmit={event => {event.preventDefault(); void search()}}>
        <div className="relative">
          <label className="ak-field ak-field--search">
            <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
            <input aria-label={copy.searchMessages} maxLength={200} onBlur={() => setFocused(false)}
              onChange={event => {
                attemptRef.current += 1
                setQuery(event.currentTarget.value)
                setValue(undefined)
                setError(undefined)
                setLoading(false)
              }} onFocus={() => setFocused(true)} placeholder={copy.searchPlaceholder} ref={inputRef} value={query} />
          </label>
          {visibleSuggestions.length > 0 && (
            <div aria-label={copy.searchOperators} className="ak-menu absolute inset-x-0 top-full z-10 mt-(--ak-s1)" role="listbox">
              {visibleSuggestions.map(item => (
                <button key={item.key} onMouseDown={event => {
                  event.preventDefault()
                  const prefix = query.trimEnd()
                  const replaceLast = lastPart && !lastPart.includes(' ') && item.key.startsWith(lastPart.split(':', 1)[0]!)
                  const base = replaceLast ? prefix.slice(0, Math.max(0, prefix.length - lastPart.length)).trimEnd() : prefix
                  setQuery(`${base}${base ? ' ' : ''}${item.syntax}`)
                  inputRef.current?.focus()
                }} role="option" type="button">
                  <span>{item.syntax}</span><span className="text-(--ak-ink-3)">{item.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {parsed.chips.length > 0 && (
          <div aria-label={copy.searchOperators} className="flex flex-wrap gap-(--ak-s1)">
            {parsed.chips.map((chip, index) => <span className="ak-badge ak-badge--quiet" key={`${chip.operator}:${chip.value}:${index}`}>{chip.label}</span>)}
          </div>
        )}
        {parsed.errors.length > 0 && <p className="ak-field-help ak-field-help--error" role="alert">{copy.searchInvalidQuery}</p>}
        {tab === 'files' && (
          <div aria-label={copy.searchFileType} className="ak-seg ak-seg--sm flex-wrap" role="radiogroup">
            {FILE_TYPES.map(type => (
              <button aria-checked={selectedFileType === type} className={selectedFileType === type ? 'is-selected' : undefined}
                key={type} onClick={() => switchFileType(type)} role="radio" type="button">
                {copy.searchFileTypes[type]}
              </button>
            ))}
          </div>
        )}
        <Button disabled={loading || parsed.errors.length > 0 || [...query.trim()].length < 2}
          type="submit" variant="secondary">
          <SearchIcon aria-hidden />{copy.searchAction}
        </Button>
      </form>
      {loading && <Loader className="size-5" label={copy.searchMessages} size="sm" />}
      {error && <p className="text-sm text-destructive" role="alert">{companyErrorText(error, copy)}</p>}
      {value && !error && (
        <div className="grid gap-(--ak-s2)">
          <p className="text-xs text-(--atum-ink-muted)" role="status">
            {value.coverage.source === 'loaded_history'
              ? copy.searchLoadedHistory
              : copy.searchCoverage(value.coverage.searchedRooms, value.coverage.eligibleRooms)}
          </p>
          {Boolean(value.coverage.encryptedRooms) && <p className="text-xs text-(--atum-ink-muted)" role="status">
            {copy.searchEncryptedUnavailable(value.coverage.encryptedRooms ?? 0)}
          </p>}
          {value.results.length === 0 ? (
            <p className="text-sm text-(--atum-ink-muted)">{tab === 'files' ? copy.searchNoFiles : copy.searchNoResults}</p>
          ) : (
            <ul aria-label={tab === 'files' ? copy.searchFilesTab : copy.searchMessagesTab} className="grid gap-(--ak-s2)">
              {value.results.map(result => (
                <li className="rounded-(--atum-r-control) border border-(--atum-line) p-(--ak-s3)" key={result.eventId}>
                  <Button aria-label={result.file ? copy.openFileResult(result.file.name, result.channelName) : undefined}
                    className="h-auto w-full justify-start p-0 text-left" disabled={Boolean(opening)} onClick={() => void open(result)} variant="text">
                    {result.file && <MatrixFileGlyph className="ak-icon ak-icon--lg shrink-0" name={result.file.name} />}
                    <span className="grid min-w-0 gap-(--ak-s1)">
                      {!result.file && <span className="sr-only">{copy.openSearchResult(result.channelName)}: </span>}
                      <span className="text-xs text-(--atum-ink-muted)">
                        # {result.channelName} · {result.sender} · {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium', timeStyle: 'short'
                        }).format(new Date(result.at))}
                      </span>
                      <span className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-(--atum-ink)">{result.snippet}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {value.nextBatch ? <Button disabled={loadingMore} onClick={() => void search(tab, selectedFileType, value.nextBatch)}
            type="button" variant="secondary">{copy.searchLoadMore}</Button>
            : value.results.length > 0 && value.coverage.truncated && <p className="text-xs text-(--atum-ink-muted)">{copy.searchTruncated}</p>}
        </div>
      )}
      {tab === 'files' && !value && !loading && <div className="flex items-center gap-(--ak-s1) text-(--ak-ink-3)">
        <Files aria-hidden className="ak-icon ak-icon--sm" /><span className="text-xs">{copy.searchPlaceholder}</span>
      </div>}
    </section>
  )
}
