import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

/**
 * A handed-off question that the other Mac has not answered in its bounded time: answer it
 * on this Mac, once (the platform's grant keeps it from running on both), or from now on.
 */
export function MatrixTurnHandoffActions({ turnId }: { turnId: string }) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const answer = (always: boolean) => {
    setPending(true)
    setFailed(false)
    // No bridge, or the turn moved on: say so and keep the buttons, never a silent no-op.
    const request = window.atumMatrix.answerTurnHere?.(turnId, always) ?? Promise.reject(new Error('matrix_not_ready'))

    void request.catch(() => setFailed(true)).finally(() => setPending(false))
  }

  return (
    <span className="flex items-center gap-1" data-matrix-turn-handoff>
      {failed && (
        <span className="text-xs text-(--atum-ink-muted)" role="status">
          {t.matrixShell.turnAnswerHereFailed}
        </span>
      )}
      <Button disabled={pending} onClick={() => answer(false)} size="sm" variant="text">
        {t.matrixShell.turnAnswerHere}
      </Button>
      <Button disabled={pending} onClick={() => answer(true)} size="sm" variant="text">
        {t.matrixShell.turnAlwaysAnswerHere}
      </Button>
    </span>
  )
}
