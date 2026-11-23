import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { workCopy } from './copy'
import { $work, $workPlanConnectSeen, loadWorkPlanConnectSeen, markWorkPlanConnectSeen, openWorkPlanConnect } from './store'

/** The step shows only while gate 4a is open for this account, nothing is connected yet, and it was never answered here. */
export function workPlanConnectStepShown(projection: MatrixWorkProjection | null | undefined, seen: boolean): boolean {
  return projection?.planConnect === 'offer' && !seen
}

/**
 * Gate 4a, the first-sign-in step: "Use your ChatGPT plan here". One line, Connect, Not now. Connect shows Work and opens T3's own
 * Codex screen in it: the sign-in is OpenAI's page and Codex's own store, never an Atum form. Either answer closes it for good on
 * this Mac; Settings keeps the same Connect row.
 */
export function WorkPlanConnectStep({ bridge = window.atumMatrix?.work }: { bridge?: Pick<MatrixWorkBridge, 'openPlanConnect'> }) {
  const { locale } = useI18n()
  const copy = workCopy(locale).connect
  const projection = useStore($work)
  const seen = useStore($workPlanConnectSeen)

  useEffect(() => loadWorkPlanConnectSeen(), [])

  if (!bridge || !workPlanConnectStepShown(projection, seen)) {
    return null
  }

  return (
    <Dialog onOpenChange={open => !open && markWorkPlanConnectSeen()} open>
      <DialogContent className="max-w-sm gap-4" data-atum-work-plan-connect showCloseButton={false}>
        <div className="grid gap-1.5">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.line}</DialogDescription>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button onClick={() => markWorkPlanConnectSeen()} size="sm" type="button" variant="ghost">
            {copy.skip}
          </Button>
          <Button
            onClick={() => {
              markWorkPlanConnectSeen()
              void openWorkPlanConnect(bridge).catch(() => undefined)
            }}
            size="sm"
            type="button"
          >
            {copy.action}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
