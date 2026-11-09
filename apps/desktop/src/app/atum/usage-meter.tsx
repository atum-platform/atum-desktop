import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { BarChart3 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $atumProtonWallet, refreshAtumProtonWallet } from '@/store/atum-proton-wallet'

import { SETTINGS_ROUTE } from '../routes'

/** The rail's usage popover. It never shows what is left to spend — only a pause or a failed read, and the way to Settings. */
export function UsageMeterPopover({ buttonClassName }: { buttonClassName: string }) {
  const { t } = useI18n()
  const walletView = useStore($atumProtonWallet)
  const accountId = useStore($atumAccountScopeId)
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const copy = t.atum.protons
  const ownView = walletView.accountId === accountId ? walletView : null
  const wallet = ownView?.state === 'resolved' ? ownView.wallet : null
  const loading = !ownView || ownView.state === 'idle' || ownView.state === 'loading'

  useEffect(() => { void refreshAtumProtonWallet() }, [accountId])

  const onOpenChange = (next: boolean) => {
    setOpen(next)

    if (next) { void refreshAtumProtonWallet() }
  }

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <Tip label={t.atum.nav.usage} side="right">
        <PopoverTrigger asChild>
          <button
            aria-label={t.atum.nav.usage}
            className={cn(buttonClassName, 'relative text-(--atum-ink-muted) hover:bg-(--atum-hover)')}
            data-rail-item
            type="button"
          >
            <BarChart3 aria-hidden className="size-4" />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-64 p-3" side="right">
        <p className="text-[length:var(--atum-t-title)] font-semibold text-(--atum-ink)">{copy.title}</p>
        {wallet && !wallet.spending_enabled && (
          <p className="mt-1 text-[length:var(--atum-t-caption)] text-(--atum-ink-muted)">{t.atum.managedModel.service_paused}</p>
        )}
        {!wallet && !loading && (
          <Button
            className="mt-2"
            onClick={() => void refreshAtumProtonWallet()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t.atum.managedModel.retry}
          </Button>
        )}
        <div className="mt-2 border-t border-(--atum-line) pt-2">
          <Button onClick={() => { setOpen(false); navigate(`${SETTINGS_ROUTE}?tab=atum:protons`) }} size="sm" type="button" variant="ghost">
            {t.atum.managedModel.details}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
