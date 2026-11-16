import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type { MatrixChatGptTrainingStatus } from '../../shared/matrix-subscriptions'

import { useChatGptTrainingCopy } from './chatgpt-training-copy'

/**
 * The one-time confirmation, inside the model picker's own card where ChatGPT was chosen: one
 * unticked box, its helper, the transfer line and two actions. Never a modal and never a second
 * picker. Confirm stays disabled until the person ticks the box; Keep leaves the saved model as it
 * is. Only the person's press sends the confirmation, for the connection the card read.
 */
export function ChatGptTrainingConfirm({
  bridge,
  training,
  onConfirmed,
  onKeep
}: {
  bridge: Pick<MatrixSubscriptionsBridge, 'chatGptTraining' | 'confirmChatGptTraining'>
  training: MatrixChatGptTrainingStatus
  onConfirmed(training: MatrixChatGptTrainingStatus): void
  onKeep(): void
}) {
  const words = useChatGptTrainingCopy()
  const [ticked, setTicked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<'failed' | 'stale'>()
  const [connectionId, setConnectionId] = useState(training.connectionId)
  const live = useRef(true)
  const box = useRef<HTMLButtonElement>(null)
  const boxId = useId()

  useEffect(() => {
    live.current = true
    // The card's one focus in this state is the box the person has to tick.
    box.current?.focus()

    return () => {
      live.current = false
    }
  }, [])

  const confirm = async () => {
    if (!ticked || saving || !bridge.confirmChatGptTraining) {
      return
    }

    setSaving(true)
    setNotice(undefined)

    try {
      const result = connectionId ? await bridge.confirmChatGptTraining(connectionId) : { status: 'unavailable' as const }

      if (!live.current) {
        return
      }

      if (result.status === 'confirmed') {
        onConfirmed(result.training)

        return
      }

      if (result.status === 'stale') {
        // A new relay connection: read it, untick, and let the person confirm for it.
        const fresh = await bridge.chatGptTraining?.().catch(() => undefined)

        if (!live.current) {
          return
        }

        if (fresh?.current) {
          onConfirmed(fresh)

          return
        }

        setConnectionId(fresh?.connectionId ?? null)
        setTicked(false)
        setNotice('stale')

        return
      }

      setNotice('failed')
    } catch {
      if (live.current) {
        setNotice('failed')
      }
    } finally {
      if (live.current) {
        setSaving(false)
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4" data-matrix-chatgpt-training>
      <p className="text-(length:--atum-t-body) font-medium text-(--atum-ink)">{words.title}</p>

      <label className="flex cursor-pointer items-start gap-2.5" htmlFor={boxId}>
        <Checkbox
          checked={ticked}
          className="mt-0.5"
          data-matrix-chatgpt-training-checkbox
          disabled={saving}
          id={boxId}
          onCheckedChange={value => {
            setTicked(value === true)
            setNotice(previous => (previous === 'failed' ? undefined : previous))
          }}
          ref={box}
        />
        <span className="text-(length:--atum-t-body) leading-snug text-(--atum-ink)">{words.checkbox}</span>
      </label>

      <p className="text-(length:--atum-t-caption) leading-snug text-(--atum-ink-muted)" data-matrix-chatgpt-training-helper>
        {words.helper}
      </p>
      <p className="text-(length:--atum-t-caption) leading-snug text-(--atum-ink-muted)" data-matrix-chatgpt-training-transfer>
        {words.transfer}
      </p>

      {notice && (
        <p
          className="text-(length:--atum-t-caption) leading-snug text-(--atum-ink-muted)"
          data-matrix-chatgpt-training-notice={notice}
          role="status"
        >
          {notice === 'stale' ? words.stale : words.failed}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Button
          data-matrix-chatgpt-training-confirm
          disabled={!ticked || saving}
          onClick={() => void confirm()}
          size="sm"
          type="button"
        >
          {saving ? words.saving : words.confirm}
        </Button>
        <Button data-matrix-chatgpt-training-keep disabled={saving} onClick={onKeep} size="sm" type="button" variant="ghost">
          {words.keep}
        </Button>
      </div>
    </div>
  )
}
