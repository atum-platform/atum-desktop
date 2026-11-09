import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { FileText } from '@/lib/icons'
import { $documentContext } from '@/store/document-context'
import { $wordCompanion, $wordCompanionError, $wordCompanionOpening, endWordCompanion, wordCompanionErrorMessage } from '@/store/word-companion'

export function WordCompanionBar() {
  const { t } = useI18n()
  const pair = useStore($wordCompanion)
  const opening = useStore($wordCompanionOpening)
  const error = useStore($wordCompanionError)
  const context = useStore($documentContext)
  const copy = t.atum.workspace
  // This bar reports window arrangement only. A different document can be
  // manually linked in the composer, so the displayed Word window must never
  // borrow that link's "live context" claim.
  const pairedContext = Boolean(pair && context?.identity.path === pair.descriptor.path)

  if (!pair && !opening && !error) {return null}

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-(--atum-line) px-4 py-2 text-(length:--atum-t-caption) text-(--atum-ink) [-webkit-app-region:no-drag]" data-word-companion role={error ? 'alert' : 'status'}>
      <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--atum-ink-muted)" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={pair?.descriptor.path}>{opening ? copy.wordOpening : pair?.descriptor.name ?? copy.wordCompanionLabel}</div>
        <p className="mt-0.5 text-(--atum-ink-muted)">{error ? wordCompanionErrorMessage(error) : pairedContext ? copy.wordLiveContext : copy.launcherNoLiveContext}</p>
      </div>
      <Button className="shrink-0" onClick={() => {
        if (pair || opening) {void endWordCompanion()}
        $wordCompanionError.set(null)
      }} size="sm" variant="ghost">
        {opening ? copy.wordCancel : pair ? copy.wordExit : copy.wordDismiss}
      </Button>
    </div>
  )
}
