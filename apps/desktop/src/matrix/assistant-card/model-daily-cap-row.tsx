import { type FormEvent, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixModelDailyCapView, MatrixModelDestinationsView } from '../../../shared/matrix-models'

type Bridge = NonNullable<MatrixUiBridge['modelDestinations']>

/**
 * The card's "Hạn mức mỗi ngày" row (`atum.model-choice/1.3`, item 23): the agent's daily
 * Proton cap as the server stores it, and a small editor for it. 0 reads as "Không giới hạn".
 * The row shows the server's own `warning`/`exhausted` state as one plain sentence, and only
 * when the server says so — nothing here computes spend, shows a running meter or claims that
 * turns stop (enforcement does not exist yet). A refused or stale write keeps the value the
 * row already showed and offers a plain retry.
 */
export function ModelDailyCapRow({
  bridge,
  cap,
  onView,
  principal
}: {
  bridge: Bridge
  cap: MatrixModelDailyCapView
  /** A fresh server view after a refusal (its revision fences the retry). */
  onView(view: MatrixModelDestinationsView): void
  principal: string
}) {
  const { locale, t } = useI18n()
  const copy = t.matrixShell
  const [open, setOpen] = useState(false)
  const [unlimited, setUnlimited] = useState(false)
  const [amount, setAmount] = useState('')
  const [failure, setFailure] = useState<'invalid' | 'failed'>()
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<number>()
  const inputId = useId()
  const unlimitedId = useId()
  const failureId = useId()
  const input = useRef<HTMLInputElement>(null)

  // A saved cap is held until the server's snapshot carries it, so the row never jumps back
  // to the old value while the publish is in flight.
  useEffect(() => {
    if (pending === undefined) {
      return
    }

    if (cap.dailyProtons === pending) {
      setPending(undefined)

      return
    }

    const timer = setTimeout(() => setPending(undefined), 5000)

    return () => clearTimeout(timer)
  }, [pending, cap.dailyProtons])

  const shown = pending ?? cap.dailyProtons

  const value = shown === 0 ? copy.dailyCapUnlimited : copy.dailyCapProtons(new Intl.NumberFormat(locale).format(shown))

  const begin = (next: boolean) => {
    setOpen(next)

    if (next) {
      setUnlimited(cap.dailyProtons === 0)
      setAmount(cap.dailyProtons === 0 ? '' : String(cap.dailyProtons))
      setFailure(undefined)
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()

    if (saving) {
      return
    }

    const protons = unlimited ? 0 : Number(amount.trim())

    if (!unlimited && (!/^\d+$/.test(amount.trim()) || !Number.isSafeInteger(protons))) {
      setFailure('invalid')

      return
    }

    setSaving(true)
    setFailure(undefined)

    try {
      const result = await bridge.cap(principal, protons)

      if (result.status !== 'saved') {
        // The row keeps the last value the server said. A fresh read settles a revision
        // another device changed, so the same edit can be tried again.
        setFailure('failed')

        const fresh = await bridge.read(principal).catch(() => undefined)

        if (fresh) {
          onView(fresh)
        }

        return
      }

      setOpen(false)
      setPending(protons)
    } catch {
      setFailure('failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Popover onOpenChange={begin} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-expanded={open}
            aria-haspopup="dialog"
            className="atum-settings-row atum-settings-link"
            data-assistant-card-daily-cap
            type="button"
          >
            <span className="atum-settings-row-title shrink-0">{copy.dailyCap}</span>
            <span className="atum-card-row-value ms-auto" title={value}>
              {value}
            </span>
            <ChevronRight aria-hidden className="atum-settings-chevron" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={copy.dailyCap}
          className="w-72 p-3"
          onOpenAutoFocus={event => {
            event.preventDefault()
            input.current?.focus()
          }}
          side="bottom"
        >
          <form className="grid gap-3" noValidate onSubmit={event => void save(event)}>
            <div className="grid gap-1.5">
              <label className="text-xs text-(--atum-ink-muted)" htmlFor={inputId}>
                {copy.dailyCapAmount}
              </label>
              <Input
                aria-describedby={failure ? failureId : undefined}
                aria-invalid={failure === 'invalid' || undefined}
                containerClassName="w-full"
                disabled={unlimited || saving}
                id={inputId}
                inputMode="numeric"
                min={0}
                onChange={event => {
                  setAmount(event.target.value)
                  setFailure(undefined)
                }}
                ref={input}
                step={1}
                suffix="Proton"
                type="number"
                value={unlimited ? '0' : amount}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={unlimited}
                disabled={saving}
                id={unlimitedId}
                onCheckedChange={next => {
                  setUnlimited(next === true)
                  setFailure(undefined)
                }}
              />
              <label className="text-xs" htmlFor={unlimitedId}>
                {copy.dailyCapUnlimited}
              </label>
            </div>
            <p className="text-xs text-(--atum-ink-muted)">{copy.dailyCapHelp}</p>
            {failure && (
              <p
                className="text-xs text-(--atum-ink-muted)"
                data-assistant-card-daily-cap-failure={failure}
                id={failureId}
                role="status"
              >
                {failure === 'invalid' ? copy.dailyCapInvalid : copy.dailyCapSaveFailed}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button disabled={saving} onClick={() => begin(false)} size="sm" type="button" variant="text">
                {t.common.cancel}
              </Button>
              <Button disabled={saving} size="sm" type="submit">
                {saving ? t.common.saving : t.common.save}
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      {/* Only the reached limit is worth a line; no "nearly reached" warning (no meters on user surfaces). */}
      {cap.spend.state === 'exhausted' && (
        <p className="atum-settings-row-help px-2 pb-1" data-assistant-card-daily-cap-state={cap.spend.state}>
          {copy.dailyCapExhausted}
        </p>
      )}
    </>
  )
}
