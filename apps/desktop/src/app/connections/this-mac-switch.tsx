import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { $work } from '@/app/work/store'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { MatrixNativeSshAction, MatrixNativeSshView } from '../../../shared/matrix-native-mac'
import type { MatrixWorkBridge } from '../../../shared/matrix-work'

import { connectionsCopy } from './copy'

/** Whether this Mac is on for the assistants: reachable (files and terminal), and its plans allowed when it holds one. */
export function thisMacOn(native: MatrixNativeSshView | undefined, plan: 'on' | 'off' | undefined): boolean {
  return (native?.status === 'connected' || native?.status === 'set_up') && plan !== 'off'
}

/**
 * This Mac's one off switch (owner Q1: "the per-Mac switch in Connections is the off switch"). Off: the assistants stop reaching it
 * (`disconnect`) and stop using its plans (`setPlan(false)`, which interrupts every plan thread at once). On: both come back. Other
 * Macs are turned off on that Mac.
 */
export function ThisMacSwitch({
  native,
  bridge = typeof window === 'undefined' ? undefined : window.atumMatrix?.work
}: {
  native: { view?: MatrixNativeSshView; busy: boolean; run(action: MatrixNativeSshAction): void }
  bridge?: Pick<MatrixWorkBridge, 'setPlan'>
}) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale).mac
  const plan = useStore($work)?.plan
  const [pending, setPending] = useState(false)

  const change = (on: boolean) => {
    native.run(on ? 'connect' : 'disconnect')

    if (plan && bridge) {
      setPending(true)
      void bridge
        .setPlan(on)
        .catch(() => undefined)
        .finally(() => setPending(false))
    }
  }

  return (
    <Switch
      aria-label={copy.label}
      checked={thisMacOn(native.view, plan)}
      data-atum-this-mac-switch
      disabled={native.busy || pending}
      onCheckedChange={change}
    />
  )
}
