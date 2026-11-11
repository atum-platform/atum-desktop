import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { matrixSuggestedTopUpPack } from '../../../shared/matrix-funds'
import { matrixFundsCopy } from '../../../shared/matrix-funds-copy'
import { MatrixCheckoutPane } from '../store/checkout'
import { matrixStoreCopy } from '../store/store-copy'
import { openMatrixTopUp } from '../store/top-up'

import { $fundsTopUp, closeFundsTopUp, registerFundsTopUpHost } from './top-up-request'

/**
 * Answers every funds line's button. With the in-app checkout this is the Store's own top-up
 * (server packs, the VietQR in place, the order watched until it lands) in a sheet over the
 * current view, the pack that covers a known need offered first; the person never leaves the
 * chat. A build without it keeps the existing path (`openMatrixTopUp`).
 */
export function FundsTopUpHost({ snapshot }: { snapshot: Pick<MatrixSnapshot, 'apps' | 'checkout' | 'wallet'> }) {
  const request = useStore($fundsTopUp)
  const { locale } = useI18n()
  const bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.checkout
  const checkout = snapshot.checkout
  const inPlace = Boolean(checkout && bridge)
  const nonce = request?.nonce

  useEffect(() => registerFundsTopUpHost(), [])

  useEffect(() => {
    if (nonce === undefined) {
      return
    }

    if (!inPlace) {
      closeFundsTopUp()
      void openMatrixTopUp(snapshot).catch(() => {})

      return
    }

    // Packs are read fresh each time the sheet is asked for; a failed read shows the pane's retry.
    void bridge?.refresh().catch(() => {})
    // The snapshot changes on every sync; only a new ask starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, inPlace])

  if (!request || !checkout || !bridge) {
    return null
  }

  const funds = matrixFundsCopy(locale)

  return (
    <Dialog onOpenChange={open => !open && closeFundsTopUp()} open>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[27.5rem]"
        data-funds-topup
        onOpenAutoFocus={event => {
          // The offered pack is where a keyboard starts, so focus and the one primary agree.
          const offered = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            '[data-matrix-topup-suggested]'
          )

          if (offered) {
            event.preventDefault()
            offered.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{funds.addProtons}</DialogTitle>
        </DialogHeader>
        <MatrixCheckoutPane
          checkout={{
            snapshot: checkout,
            onRefresh: () => void bridge.refresh().catch(() => {}),
            onStart: packId => bridge.start(packId),
            onStatus: () => bridge.status(),
            onResume: () => bridge.resume(),
            onOpenCheckout: () => bridge.openCheckout(),
            onDismissTerminal: () => bridge.dismissTerminal()
          }}
          copy={matrixStoreCopy(locale)}
          doneLabel={funds.backToChat}
          onDone={closeFundsTopUp}
          suggestedPackId={matrixSuggestedTopUpPack(checkout.packs, request.needProtons)}
          wallet={snapshot.wallet}
        />
      </DialogContent>
    </Dialog>
  )
}
