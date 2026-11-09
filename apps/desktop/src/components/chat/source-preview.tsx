import { Fragment, type ReactNode, useMemo } from 'react'
import ShikiHighlighter from 'react-shiki'

import { chunkTextLines, useFixedRowWindow } from './fixed-row-window'
const SHIKI_THEME = { dark: 'github-dark-default', light: 'github-light-default' } as const
const SOURCE_CHUNK_LINES = 200
const SOURCE_LINE_PX = 20
const SOURCE_OVERSCAN_LINES = 400

/** Existing virtualized source renderer; selection/drag authority stays in callers. */
export function SourcePreview({
  language,
  text,
  gutter
}: {
  language: string
  text: string
  gutter?: (line: number) => ReactNode
}) {
  const chunks = useMemo(() => chunkTextLines(text, SOURCE_CHUNK_LINES), [text])
  const lastChunk = chunks.at(-1)
  const totalLines = lastChunk ? lastChunk.start + lastChunk.lines.length : 0

  const { afterRows, beforeRows, endChunk, onScroll, scrollerRef, startChunk } = useFixedRowWindow({
    overscanRows: SOURCE_OVERSCAN_LINES,
    rowPx: SOURCE_LINE_PX,
    rowsPerChunk: SOURCE_CHUNK_LINES,
    totalRows: totalLines
  })

  const visibleChunks = chunks.slice(startChunk, endChunk + 1)

  return (
    <div className="h-full overflow-auto" onScroll={onScroll} ref={scrollerRef}>
      <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)] font-mono text-[0.7rem] leading-relaxed">
        {beforeRows > 0 && <div aria-hidden className="col-span-2" style={{ height: beforeRows * SOURCE_LINE_PX }} />}
        {visibleChunks.map(chunk => (
          <Fragment key={chunk.start}>
            <div className="select-none text-right text-muted-foreground/55">
              {chunk.lines.map((_lineText, offset) => {
                const line = chunk.start + offset + 1

                return gutter ? (
                  <Fragment key={line}>{gutter(line)}</Fragment>
                ) : (
                  <div className="h-5 w-9 pr-2 leading-5 tabular-nums" key={line}>
                    {line}
                  </div>
                )
              })}
            </div>
            <div className="preview-source-code min-w-0 [&_pre]:m-0" data-selectable-text="true">
              <ShikiHighlighter
                addDefaultStyles={false}
                as="div"
                defaultColor="light-dark()"
                delay={80}
                language={language || 'text'}
                showLanguage={false}
                theme={SHIKI_THEME}
              >
                {chunk.text}
              </ShikiHighlighter>
            </div>
          </Fragment>
        ))}
        {afterRows > 0 && <div aria-hidden className="col-span-2" style={{ height: afterRows * SOURCE_LINE_PX }} />}
      </div>
    </div>
  )
}

export function ImagePreview({ name, dataUrl }: { name: string; dataUrl: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-transparent p-4">
      <img
        alt={name}
        className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
        draggable={false}
        src={dataUrl}
      />
    </div>
  )
}
