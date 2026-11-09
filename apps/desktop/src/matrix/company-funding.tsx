import { type FormEvent, useEffect, useId, useRef, useState } from 'react'

import { ProtonAmount } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import type { MatrixCompanyBridge, MatrixCompanyErrorCode, MatrixCompanyWallet } from '../../shared/matrix-company'
import { matrixCompanyFundingCopy } from '../../shared/matrix-company-funding-copy'

import { MICRO_PROTONS, microProtons } from './wallet-ui'

export interface MatrixCompanyFundingPanelProps {
  bridge: MatrixCompanyBridge
  accountKey: string
  companyId: string
  blocked: boolean
  pendingChange: boolean
  refreshKey: number
  onConfigure: (enabled: boolean, taskLimit: number) => void
}

interface ScopedWallet {
  accountKey: string
  companyId: string
  refreshKey: number
  value: MatrixCompanyWallet
}

const MAX_MICRO_PROTONS = BigInt(Number.MAX_SAFE_INTEGER)
const MICRO_PROTONS_BIGINT = BigInt(MICRO_PROTONS)

interface NumberSeparators {
  group: string
  decimal: string
}

/** How this locale writes 1.234,5 / 1,234.5: Vietnamese groups with a dot and decimals with a comma. */
function numberSeparators(locale: string): NumberSeparators {
  let parts: Intl.NumberFormatPart[] = []

  try {
    parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
  } catch {
    parts = new Intl.NumberFormat('en').formatToParts(12345.6)
  }

  return {
    group: parts.find(part => part.type === 'group')?.value ?? ',',
    decimal: parts.find(part => part.type === 'decimal')?.value ?? '.'
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reads a positive Proton amount the way the person's locale writes numbers and returns
 * exact micro-Protons. In Vietnamese "1.000" is one thousand and "1,5" one and a half; a
 * separator that could mean either ("1.5" in Vietnamese, "1,5" in English) is refused
 * rather than guessed, so a typed thousand never silently becomes one.
 */
export function parseCompanyTaskLimit(value: string, locale = 'en'): number | null {
  const { decimal, group } = numberSeparators(locale)
  const pieces = value.trim().split(decimal)

  if (pieces.length > 2) {
    return null
  }

  const [integer = '', fraction] = pieces

  if (fraction !== undefined && !/^\d{1,6}$/.test(fraction)) {
    return null
  }

  // Plain digits, or digits grouped in threes by the locale's separator (or a space).
  const grouped = new RegExp(`^\\d{1,3}(?:[${escapeRegExp(group)}\\s\\u00a0\\u202f]\\d{3})+$`)

  if (!/^\d+$/.test(integer) && !grouped.test(integer)) {
    return null
  }

  const whole = integer.replace(/\D/g, '')
  const micro = BigInt(whole) * MICRO_PROTONS_BIGINT + BigInt((fraction ?? '').padEnd(6, '0'))

  if (micro <= 0n || micro > MAX_MICRO_PROTONS) {
    return null
  }

  return Number(micro)
}

/** The inverse of the parser: what the field shows for a saved limit, in the same locale. */
export function formatCompanyTaskLimit(value: number | null, locale = 'en'): string {
  if (value === null) {
    return ''
  }

  const integer = BigInt(value)
  const whole = integer / MICRO_PROTONS_BIGINT
  const fraction = String(integer % MICRO_PROTONS_BIGINT).padStart(6, '0').replace(/0+$/, '')
  let wholeText: string

  try {
    wholeText = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole)
  } catch {
    wholeText = String(whole)
  }

  return fraction ? `${wholeText}${numberSeparators(locale).decimal}${fraction}` : wholeText
}

function isBalance(value: unknown): value is MatrixCompanyWallet['balances'] {
  if (!value || typeof value !== 'object') {
    return false
  }

  const balances = value as Record<string, unknown>

  return ['paid', 'earned', 'promo', 'held', 'available'].every(key => Number.isSafeInteger(balances[key]) && (balances[key] as number) >= 0)
}

function isWallet(value: unknown, companyId: string): value is MatrixCompanyWallet {
  if (!value || typeof value !== 'object') {
    return false
  }

  const wallet = value as Record<string, unknown>
  const funding = wallet.funding as Record<string, unknown> | null

  return (
    wallet.schemaVersion === 1 &&
    wallet.companyId === companyId &&
    wallet.unit === 'micro_proton' &&
    wallet.checkoutOpen === false &&
    isBalance(wallet.balances) &&
    Boolean(funding) &&
    typeof funding!.enabled === 'boolean' &&
    (funding!.taskLimit === null || (Number.isSafeInteger(funding!.taskLimit) && (funding!.taskLimit as number) > 0)) &&
    Number.isSafeInteger(funding!.revision) &&
    (funding!.revision as number) >= 0
  )
}

function errorCopy(error: MatrixCompanyErrorCode | undefined, copy: ReturnType<typeof matrixCompanyFundingCopy>) {
  if (error === 'authentication') {
    return copy.authentication
  }

  if (error === 'denied') {
    return copy.denied
  }

  if (error === 'invalid') {
    return copy.invalid
  }

  return copy.unavailable
}

/**
 * Displays only the aggregate company wallet. Configuration is intentionally
 * delegated to the parent, which owns request IDs, persistence, and retries.
 */
export function MatrixCompanyFundingPanel({
  accountKey,
  blocked,
  bridge,
  companyId,
  onConfigure,
  pendingChange,
  refreshKey
}: MatrixCompanyFundingPanelProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyFundingCopy(locale)
  const limitErrorId = useId()
  const [wallet, setWallet] = useState<ScopedWallet>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<MatrixCompanyErrorCode>()
  const [enabled, setEnabled] = useState(false)
  const [limit, setLimit] = useState('')
  const [limitInvalid, setLimitInvalid] = useState(false)
  const mounted = useRef(true)
  const scopeRef = useRef('')
  const requestRef = useRef(0)
  const scope = `${accountKey}\u0000${companyId}`

  // A result resolving between render and the effect must still fail closed.
  scopeRef.current = scope

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    const request = ++requestRef.current

    setWallet(undefined)
    setError(undefined)
    setLoading(true)
    setLimitInvalid(false)

    void bridge
      .request({ action: 'wallet', companyId })
      .then(result => {
        if (!mounted.current || requestRef.current !== request || scopeRef.current !== scope) {
          return
        }

        if (!result.ok) {
          setWallet(undefined)
          setError(result.error)

          return
        }

        if (!isWallet(result.value, companyId)) {
          setWallet(undefined)
          setError('invalid')

          return
        }

        setWallet({ accountKey, companyId, refreshKey, value: result.value })
        setEnabled(result.value.funding.enabled)
        setLimit(formatCompanyTaskLimit(result.value.funding.taskLimit, locale))
      })
      .catch(() => {
        if (mounted.current && requestRef.current === request && scopeRef.current === scope) {
          setWallet(undefined)
          setError('unavailable')
        }
      })
      .finally(() => {
        if (mounted.current && requestRef.current === request && scopeRef.current === scope) {
          setLoading(false)
        }
      })
  }, [accountKey, bridge, companyId, locale, refreshKey, scope])

  const visible = wallet?.accountKey === accountKey && wallet.companyId === companyId && wallet.refreshKey === refreshKey ? wallet.value : undefined
  const policyKnown = Boolean(visible) && !pendingChange
  const disabled = blocked || pendingChange || !policyKnown

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (disabled) {
      return
    }

    const parsed = parseCompanyTaskLimit(limit, locale)

    if (parsed === null) {
      setLimitInvalid(true)

      return
    }

    setLimitInvalid(false)
    onConfigure(enabled, parsed)
  }

  return (
    <section aria-label={copy.title} className="grid gap-4" data-matrix-company-funding>
      <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{copy.title}</h3>

      {loading && !visible && <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={copy.loading} />}
      {error && <p className="text-sm text-destructive" role="alert">{errorCopy(error, copy)}</p>}

      {visible && !error && (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-(--atum-ink-muted)">{copy.available}</dt>
              <dd className="font-medium text-(--atum-ink)" data-company-wallet-available><ProtonAmount amount={microProtons(visible.balances.available, locale)} spoken={`${microProtons(visible.balances.available, locale)} ${copy.protons}`} /></dd>
            </div>
            <div>
              <dt className="text-(--atum-ink-muted)">{copy.held}</dt>
              <dd className="font-medium text-(--atum-ink)" data-company-wallet-held><ProtonAmount amount={microProtons(visible.balances.held, locale)} spoken={`${microProtons(visible.balances.held, locale)} ${copy.protons}`} /></dd>
            </div>
          </dl>
          <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.checkoutUnavailable}</p>
        </>
      )}

      {pendingChange && <p className="text-sm text-(--atum-ink-muted)" role="status">{copy.policyUnknown}</p>}

      <form className="grid gap-3" onSubmit={submit}>
        <fieldset className="grid gap-3" disabled={disabled}>
          {/* The section heading already says what this is; the legend names the group for assistive tech. */}
          <legend className="sr-only">{copy.funding}</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={policyKnown ? enabled : 'indeterminate'} disabled={disabled} onCheckedChange={value => setEnabled(value === true)} />
            {copy.enabled}
          </label>
          <label className="grid max-w-72 gap-1 text-sm">
            <span>{copy.taskLimit}</span>
            <Input
              aria-describedby={limitInvalid ? limitErrorId : undefined}
              aria-invalid={limitInvalid || undefined}
              aria-label={copy.taskLimit}
              disabled={disabled}
              inputMode="decimal"
              onChange={event => {
                setLimit(event.target.value)
                setLimitInvalid(false)
              }}
              placeholder={formatCompanyTaskLimit(1000 * MICRO_PROTONS, locale)}
              suffix={copy.protons}
              value={policyKnown ? limit : ''}
            />
          </label>
        </fieldset>
        {limitInvalid && (
          <p className="text-sm text-destructive" id={limitErrorId} role="alert">
            {copy.limitInvalid(formatCompanyTaskLimit(1000 * MICRO_PROTONS, locale))}
          </p>
        )}
        <Button className="justify-self-start" disabled={disabled} size="sm" type="submit" variant="secondary">
          {copy.save}
        </Button>
      </form>
    </section>
  )
}
