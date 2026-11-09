import { translateNow } from '@/i18n/runtime'

/** Human-readable receipt; ownership/delivery internals stay out of the bubble. */
export function surfaceReceiptText(capture: Record<string, unknown>): string {
  const label = typeof capture.label === 'string' ? capture.label : ''

  const provenance = capture.provenance === 'unsaved-buffer' ? 'capturedUnsaved'
    : capture.kind === 'image' ? 'capturedImage' : capture.kind === 'file' ? 'capturedFile' : 'capturedSaved'

  return [label, translateNow(`composer.${provenance}`), capture.truncated ? translateNow('composer.capturedTruncated') : '',
    typeof capture.text === 'string' ? capture.text : ''].filter(Boolean).join('\n')
}
