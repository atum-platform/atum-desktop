import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { $matrixStoreDraft } from '../store/store-try'
import { runMatrixCommand } from '../text-document-actions'

import { useFounderCopy } from './founder-copy'
import { createFounderDraft, type MatrixFounderDraft } from './founder-draft'
import { closeFounderDraft } from './founder-store'
import { FounderIntroCard } from './intro-card'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function FounderDraftChat({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useFounderCopy()
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const draft = useRef<MatrixFounderDraft | null>(null)
  const ready = snapshot.state === 'ready'

  const sender = () => {
    draft.current ??= createFounderDraft({
      contact: () => {
        const bridge = window.atumMatrix?.founder

        return bridge ? bridge.contact() : Promise.resolve({ unavailable: true as const })
      },
      send: (roomId, body) => runMatrixCommand({ kind: 'send', roomId, body })
    })

    return draft.current
  }

  const send = () => {
    const body = text.trim()

    if (!body || sending || !ready) {
      return
    }

    setSending(true)
    setFailed(false)

    void sender()
      .send(body)
      .then(result => {
        if (result.outcome === 'sent') {
          setText('')
          // Main selects the chat it made; the next snapshot draws it as the Founder chat.
          closeFounderDraft()

          return
        }

        if (result.roomId) {
          // The chat was made (or found) but the message did not go: the words wait, unsent, in
          // that chat's own box instead of disappearing with this draft.
          $matrixStoreDraft.set({ roomId: result.roomId, text: body })
          setText('')
          closeFounderDraft()

          return
        }

        setFailed(true)
      })
      .finally(() => setSending(false))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-founder-draft>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto py-10">
        <FounderIntroCard />
      </div>
      <form
        className="mx-auto w-full max-w-[700px] shrink-0 px-10 pb-5"
        onSubmit={event => {
          event.preventDefault()
          send()
        }}
      >
        {failed && (
          <NoticeBand className="mb-2" role="alert" tone="failure">
            {copy.unready}
          </NoticeBand>
        )}
        <div className="flex items-end gap-2 rounded-(--atum-r-composer) border border-(--atum-line) bg-(--atum-panel) p-2">
          <textarea
            aria-label={t.atum.composer.placeholderFor(copy.name)}
            autoFocus
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-(length:--atum-t-control) text-(--atum-ink) outline-none placeholder:text-(--atum-ink-faint)"
            data-founder-draft-composer
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
            placeholder={t.atum.composer.placeholderFor(copy.name)}
            rows={1}
            value={text}
          />
          <Button data-founder-draft-send disabled={!ready || sending || !text.trim()} size="sm" type="submit">
            {t.common.send}
          </Button>
        </div>
      </form>
    </div>
  )
}
