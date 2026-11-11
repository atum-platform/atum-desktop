import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import { companyDesktopAdapter, type CompanyWalletV2 } from './company-desktop-adapter'

/** Mirrors `atum.company-funding/2.1`: whole Protons, 1 to 1,000,000 per transfer. */
export const COMPANY_FUND_MAX_PROTONS = 1_000_000

type Problem = 'invalid' | 'insufficient' | 'denied' | 'unavailable'

/** Native codes that prove the server (or native, before any I/O) refused this request. */
const DEFINITE = new Set(['insufficient_protons', 'denied', 'invalid', 'missing', 'conflict', 'update_required'])

/** A whole number of Protons in range, or null. Digits only: no sign, decimals or exponent. */
export function companyFundProtons(text: string): number | null {
  const trimmed = text.trim()

  if (!/^[1-9][0-9]{0,6}$/u.test(trimmed)) {
    return null
  }

  const value = Number(trimmed)

  return value <= COMPANY_FUND_MAX_PROTONS ? value : null
}

function codeOf(error: unknown): string {
  return error instanceof Error ? error.message : error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

function problemOf(code: string): Problem {
  return code === 'insufficient_protons'
    ? 'insufficient'
    : code === 'denied'
      ? 'denied'
      : code === 'invalid'
        ? 'invalid'
        : 'unavailable'
}

interface Pending {
  requestId: string
  protons: number
  /** Sent at least once without a definite answer: it can only be retried, never dropped. */
  submitted: boolean
}

/**
 * "Nạp từ ví của bạn": an owner or admin moves their own Protons into the company
 * wallet (owner decision D2). Two steps, inline: enter an amount, then confirm the
 * exact debit. The server picks the buckets and has the last word on authority.
 *
 * Once sent, a request without a definite answer (a network failure, a timeout, an
 * answer that cannot be checked) stays: there is no Cancel, and reopening the wallet
 * recovers it from native's durable intent journal. Its only action re-sends the same
 * request ID, which the platform replays, so the Protons can never move twice.
 */
export function CompanyWalletFund({
  companyId,
  onFunded,
  prefillProtons
}: {
  companyId: string
  onFunded(wallet: CompanyWalletV2): void
  /** A shortfall to cover (whole Protons, already rounded up): fills the amount; the person still reviews it. */
  prefillProtons?: number
}) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const prefill = prefillProtons && prefillProtons > 0 ? Math.min(Math.ceil(prefillProtons), COMPANY_FUND_MAX_PROTONS) : 0
  const [text, setText] = useState(prefill ? String(prefill) : '')
  const [pending, setPending] = useState<Pending>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem>()
  const [done, setDone] = useState<number>()
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)

  useEffect(() => {
    const adapter = companyDesktopAdapter()
    let live = true

    void adapter
      ?.readPendingFund(companyId)
      .then(result => {
        if (live && result.pending) {
          setPending({ ...result.pending, submitted: true })
        }
      })
      .catch(() => {})

    return () => {
      live = false
    }
  }, [companyId])

  const review = () => {
    const protons = companyFundProtons(text)
    setDone(undefined)

    if (protons === null) {
      setProblem('invalid')

      return
    }

    setProblem(undefined)
    setPending({ requestId: globalThis.crypto.randomUUID(), protons, submitted: false })
  }

  const confirm = async () => {
    const adapter = companyDesktopAdapter()

    if (!pending || busy) {
      return
    }

    if (!adapter) {
      setProblem('unavailable')

      return
    }

    const request = { ...pending, submitted: true }
    setPending(request)
    setBusy(true)
    setProblem(undefined)

    try {
      const result = await adapter.fundFromMember(companyId, {
        schemaVersion: 2,
        requestId: request.requestId,
        protons: request.protons
      })

      if (result.companyId !== companyId || result.wallet.companyId !== companyId
        || result.requestId !== request.requestId || result.protons !== request.protons) {
        // An answer that cannot be checked may still mean the transfer happened.
        throw new Error('unconfirmed')
      }

      onFunded(result.wallet)
      setDone(result.protons)
      setPending(undefined)
      setText('')
    } catch (error) {
      const code = codeOf(error)
      setProblem(problemOf(code))

      // Only a definite refusal moved nothing. Anything else keeps the request.
      if (DEFINITE.has(code)) {
        setPending(undefined)
      }
    } finally {
      setBusy(false)
    }
  }

  const problemText =
    problem === 'invalid'
      ? copy.fundInvalid(format(COMPANY_FUND_MAX_PROTONS))
      : problem === 'insufficient'
        ? copy.fundInsufficient
        : problem === 'denied'
          ? copy.walletDenied
          : problem === 'unavailable'
            ? copy.fundUnavailable
            : null

  return (
    <ConsentBoundary><section aria-label={copy.fundFromMine} className="mt-7 grid gap-3" data-company-wallet-fund>
      <Tip label={copy.fundFromMineHint}>
        <h3 className="w-fit cursor-default text-xs font-semibold text-(--atum-ink-muted)" tabIndex={0}>
          {copy.fundFromMine}
        </h3>
      </Tip>
      {pending?.submitted ? (
        <div className="grid gap-3" data-company-wallet-fund-unresolved>
          <p
            className={problem ? 'text-sm text-(--atum-danger)' : 'text-sm text-(--atum-ink)'}
            role={problem ? 'alert' : 'status'}
          >
            {problem ? copy.fundUnavailable : copy.fundUnresolved(format(pending.protons))}
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void confirm()} size="sm">
              {copy.fundRetry}
            </Button>
          </div>
        </div>
      ) : pending ? (
        <div className="grid gap-3" data-company-wallet-fund-confirm>
          <p className="text-sm text-(--atum-ink)">{copy.fundConfirmLine(format(pending.protons))}</p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void confirm()} size="sm">
              {copy.fundConfirm}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setPending(undefined)
                setProblem(undefined)
              }}
              size="sm"
              variant="text"
            >
              {copy.fundCancel}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault()
            review()
          }}
        >
          <Input
            aria-invalid={problem === 'invalid' || undefined}
            aria-label={copy.fundAmount}
            className="w-36"
            inputMode="numeric"
            onChange={event => {
              setText(event.target.value)
              setProblem(undefined)
            }}
            placeholder={copy.fundAmount}
            value={text}
          />
          <Button disabled={text.trim() === ''} size="sm" type="submit" variant="secondary">
            {copy.fundReview}
          </Button>
        </form>
      )}
      {problemText && !pending?.submitted && (
        <p className="text-sm text-(--atum-danger)" data-company-wallet-fund-problem={problem} role="alert">
          {problemText}
        </p>
      )}
      {done !== undefined && !problemText && (
        <p className="text-sm text-(--atum-ink-muted)" data-company-wallet-fund-done role="status">
          {copy.fundDone(format(done))}
        </p>
      )}
    </section></ConsentBoundary>
  )
}
