import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { FileText } from '@/lib/icons'

import type { MatrixDocumentPreview } from '../../shared/matrix'

import { matrixWordError } from './word-error'
import { useMatrixWorkbenchCopy } from './workbench-copy'

/** Read-only snapshot of Word's live buffer. Native Word remains the editor. */
export function MatrixWordPane({
  preview,
  roomId
}: {
  preview: Extract<MatrixDocumentPreview, { kind: 'word' }>
  roomId: string
}) {
  const { t } = useI18n()
  const copy = useMatrixWorkbenchCopy()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `saved` comes from Word's live native capture. Older bridges that omit it
  // get no status; a filename or folder name is never used as a substitute.
  let saveStatus: string | null = null

  if (typeof preview.saved === 'boolean') {
    saveStatus = preview.saved ? copy.savedInWord : copy.unsavedInWord
  }

  const arrange = (show: boolean) => {
    setPending(true)
    setError(null)
    void window.atumMatrix.arrangeWord(roomId, show)
      .catch(error => setError(matrixWordError(error, t.atum.workspace, t.atum.workspace.wordOpenError)))
      .finally(() => setPending(false))
  }

  return <div className="flex h-full min-h-0 flex-col">
    <div
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-(--atum-line) py-1.5 ps-3 pe-2"
      data-matrix-word-header
    >
      <FileText aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-(length:--atum-t-control) font-semibold text-(--atum-ink)">{preview.name}</div>
        {saveStatus && (
          <div className="truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)" data-matrix-word-save-status>
            {saveStatus}
          </div>
        )}
      </div>
      <Button disabled={pending} onClick={() => arrange(true)} size="xs" variant="secondary">
        {copy.openInWord}
      </Button>
    </div>
    {error && <NoticeBand className="m-4" role="alert" tone="failure">{error}</NoticeBand>}
    {/* Word's text reads as a page, in the app's own type, not as code (Atum Kit 0.1): no gutter,
        no line numbers. It is still Word's plain buffer, so nothing is styled that Word did not say. */}
    {/* The page sits on the side panel's own card, a hairline round it (Atum Kit side panel board). */}
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <article
        className="mx-auto min-h-full max-w-[42rem] rounded-(--ak-r-lg) bg-(--ak-surface,var(--atum-card)) px-10 py-9 text-(--atum-ink) shadow-[0_0_0_0.5px_var(--atum-line)] select-text"
        data-matrix-word-page
      >
        {preview.text.split(/\r?\n/u).map((line, index) => (
          <p className="min-h-[1.5em] text-[0.9375rem] leading-[1.6] whitespace-pre-wrap break-words" key={index}>
            {line}
          </p>
        ))}
      </article>
    </div>
  </div>
}
