import { BrandMark } from '@/components/brand-mark'
import type { ErrorBoundaryFallbackProps } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AppViewOverlayHold } from '@/store/use-app-view-overlay'

/**
 * What the Matrix window shows if its view crashes (launch night, 2026-10-04): Atum's ground
 * and mark, one plain sentence, Try again and Reload — never the raw error text (it goes to
 * the report) and never the old engine's "Open logs", which has no bridge in this window.
 */
export function MatrixCrashFallback({ reset }: Pick<ErrorBoundaryFallbackProps, 'reset'>) {
  const { t } = useI18n()

  return (
    <div
      className="atum-shell atum-window-ground fixed inset-0 z-[1500] grid place-items-center p-6 text-(--atum-ink)"
      data-matrix-crash
      role="alert"
    >
      <AppViewOverlayHold />
      <div className="flex w-full max-w-[24rem] flex-col items-center text-center">
        <BrandMark className="mb-5 size-10 rounded-[var(--atum-r-sidebar)]" />
        <h1 className="text-(length:--atum-t-section) leading-tight font-semibold">{t.errors.boundaryTitle}</h1>
        <p className="mt-2 text-(length:--atum-t-ui) leading-normal text-(--atum-ink-muted)">{t.errors.boundaryDesc}</p>
        <div className="mt-6 flex items-center gap-2">
          <Button onClick={reset}>{t.common.retry}</Button>
          <Button onClick={() => window.location.reload()} variant="text">
            {t.errors.reloadWindow}
          </Button>
        </div>
      </div>
    </div>
  )
}
