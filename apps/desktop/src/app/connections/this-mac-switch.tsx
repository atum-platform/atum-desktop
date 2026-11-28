import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import type { MatrixNativeSshAction, MatrixNativeSshView } from '../../../shared/matrix-native-mac'

import { connectionsCopy } from './copy'

/** The native Mac connection also controls publication of its Work endpoint and plan facts. */
export function ThisMacSwitch({
  native
}: {
  native: { view?: MatrixNativeSshView; busy: boolean; run(action: MatrixNativeSshAction): void }
}) {
  const { locale } = useI18n()
  const copy = connectionsCopy(locale).mac
  const enabled = native.view?.status === 'connected' || native.view?.status === 'set_up'

  return (
    <Switch
      aria-label={copy.label}
      checked={enabled}
      data-atum-this-mac-switch
      disabled={native.busy}
      onCheckedChange={on => native.run(on ? 'connect' : 'disconnect')}
    />
  )
}
