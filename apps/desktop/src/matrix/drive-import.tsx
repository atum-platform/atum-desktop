import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { Locale } from '@/i18n'

import type { MatrixDriveBridge, MatrixDriveImportPlan, MatrixDriveImportResult } from '../../shared/matrix-drive'

import { matrixDriveImportCopy } from './drive-import-copy'

interface DriveImportSheetProps {
  bridge: MatrixDriveBridge
  plan: Exclude<MatrixDriveImportPlan, { state: 'cancelled' }>
  locale: Locale
  formatSize(bytes: number): string
  onClose(): void
  onChanged(): void
}

/** Native counts only; copying starts with the person's explicit Add copies. */
export function MatrixDriveImportSheet({
  bridge,
  plan,
  locale,
  formatSize,
  onClose,
  onChanged
}: DriveImportSheetProps) {
  const copy = matrixDriveImportCopy[locale]
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<MatrixDriveImportResult | undefined>()
  const pending = useRef(false)
  const alive = useRef(true)
  const deferredCancel = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const planId = 'planId' in plan ? plan.planId : undefined

  useEffect(() => {
    alive.current = true
    clearTimeout(deferredCancel.current)

    return () => {
      alive.current = false
      // Same-tick StrictMode remount clears this; actual departure cancels the intent.
      deferredCancel.current = setTimeout(() => {
        if (planId) {
          void bridge.importCancel?.(planId).catch(() => {})
        }
      }, 0)
    }
  }, [bridge, planId])

  const dismiss = async () => {
    if (planId) {
      await bridge.importCancel?.(planId).catch(() => {})
      onChanged()
    }

    if (alive.current) {
      onClose()
    }
  }

  const run = async () => {
    if (pending.current || !planId || plan.state === 'blocked' || !bridge.importRun) {
      return
    }

    pending.current = true
    setWorking(true)

    try {
      const next = await bridge.importRun(planId)
      onChanged()

      if (alive.current) {
        setResult(next)
      }
    } catch {
      if (alive.current) {
        setResult({ state: 'unavailable', added: 0 })
      }
    } finally {
      if (alive.current) {
        setWorking(false)
      }
    }
  }

  const resultText =
    result &&
    (result.state === 'completed'
      ? copy.done
      : result.state === 'cancelled'
        ? copy.partial
        : result.state === 'no_room'
          ? copy.noRoom
          : copy[result.state])

  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const skipped = 'skipped' in plan ? Object.entries(plan.skipped).filter(([, count]) => count > 0) : []

  return (
    <Sheet
      onOpenChange={open => {
        if (!open) {
          void dismiss()
        }
      }}
      open
    >
      <SheetContent className="gap-4 bg-(--atum-paper) p-6 text-(--atum-ink)" showCloseButton={false}>
        <SheetHeader className="p-0">
          <SheetTitle>{copy.title}</SheetTitle>
          <SheetDescription>{copy.help}</SheetDescription>
        </SheetHeader>
        {result ? (
          <p role="status">{resultText!.replace('{count}', number(result.added))}</p>
        ) : plan.state === 'refused' ? (
          <NoticeBand tone="notice">{copy.refused[plan.reason]}</NoticeBand>
        ) : (
          <>
            <dl className="space-y-2 text-sm">
              {[
                [copy.files, number(plan.files)],
                [copy.folders, number(plan.folders)],
                [copy.size, formatSize(plan.bytes)]
              ].map(([label, value]) => (
                <div className="flex justify-between gap-4" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {skipped.length > 0 && (
              <section className="text-sm">
                <p className="font-medium">
                  {copy.notAdded.replace('{count}', number(skipped.reduce((count, [, n]) => count + n, 0)))}
                </p>
                <ul className="mt-2 space-y-1 text-(--atum-ink-muted)">
                  {skipped.map(([reason, count]) => (
                    <li key={reason}>
                      {copy.skipped[reason as keyof typeof copy.skipped]} · {number(count)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="border-t border-(--atum-line) pt-3 text-sm">
              <p>{copy.after}</p>
              <p className="mt-1 font-medium">
                {plan.space.estimated
                  ? copy.about.replace('{size}', formatSize(Math.max(0, plan.space.remainingAfter)))
                  : formatSize(Math.max(0, plan.space.remainingAfter))}
              </p>
            </div>
            {plan.state === 'warning' && <NoticeBand tone="notice">{copy.warning}</NoticeBand>}
            {plan.state === 'blocked' && (
              <NoticeBand tone="notice">
                {copy.blocked
                  .replace('{needed}', formatSize(plan.bytes))
                  .replace('{remaining}', formatSize(Math.max(0, plan.space.total - plan.space.used)))}
              </NoticeBand>
            )}
          </>
        )}
        <SheetFooter className="p-0">
          {working && <Loader label={copy.working} size="sm" />}
          {!result && plan.state !== 'refused' && (
            <Button disabled={working || plan.state === 'blocked'} onClick={() => void run()}>
              {copy.add}
            </Button>
          )}
          <Button onClick={() => void dismiss()} variant="secondary">
            {result || plan.state === 'refused' ? copy.close : copy.cancel}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
