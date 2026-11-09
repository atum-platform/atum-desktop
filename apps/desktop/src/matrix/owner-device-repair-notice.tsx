import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'

import type { MatrixSnapshot } from '../../shared/matrix'

import { useMatrixCopy } from './copy'
import { useLaunchCopy } from './launch-copy'

export type OwnerDeviceRepairSnapshot = Pick<
  MatrixSnapshot,
  'deviceDamaged' | 'ownerDeviceRepair' | 'deviceControlRequired'
>

/** Every entry point paints main's progress, including across a human SDK replacement. */
export function MatrixOwnerDeviceRepairNotice({ snapshot }: { snapshot: OwnerDeviceRepairSnapshot }) {
  const words = useLaunchCopy()
  const copy = useMatrixCopy()
  const [pending, setPending] = useState(false)
  const [repairError, setRepairError] = useState<string>()
  const repair = snapshot.ownerDeviceRepair
  const repairing = Boolean(snapshot.deviceDamaged || repair)
  const busy = pending || repair?.state === 'verifying'
  const resume = repair?.state === 'resume_pending'
  const failure = repairError ?? repair?.error

  if (!repairing) {
    return null
  }

  const run = () => {
    setPending(true)
    setRepairError(undefined)
    void Promise.resolve()
      .then(async () => {
        await window.atumMatrix.repairOwnerDevice()
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : ''
        // Electron wraps rejected IPC errors; only this closed code changes the sentence.
        if (!message.includes('matrix_login_cancelled')) {
          setRepairError(
            message.includes('matrix_account_mismatch') ? 'matrix_account_mismatch' : 'matrix_owner_repair_failed'
          )
        }
      })
      .finally(() => setPending(false))
  }

  return (
    <NoticeBand role="status" tone="notice">
      <div
        className="flex flex-col gap-1.5"
        data-matrix-owner-repair={repair?.state ?? 'damaged'}
      >
        <p className="font-medium">{words.deviceDamagedTitle}</p>
        <p>{resume ? words.ownerRepairPending : words.deviceDamagedHelp}</p>
        {failure && (
          <p role="alert">
            {failure === 'matrix_account_mismatch' ? words.ownerRepairMismatch : words.ownerRepairFailed}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button aria-busy={busy || undefined} disabled={busy} onClick={run} size="sm" variant="secondary">
            {busy ? words.ownerRepairBusy : resume ? words.ownerRepairRetry : words.ownerRepairAction}
          </Button>
          {(busy || resume) && (
            <Button
              onClick={() =>
                void window.atumMatrix
                  .cancelOwnerDeviceRepair()
                  .catch(() => setRepairError('matrix_owner_repair_failed'))
              }
              size="sm"
              variant="text"
            >
              {copy.cancel}
            </Button>
          )}
        </span>
      </div>
    </NoticeBand>
  )
}
