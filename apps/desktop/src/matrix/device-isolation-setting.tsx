import { useState } from 'react'

import { Switch } from '@/components/ui/switch'

import type { DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixDeviceIsolation } from '../../shared/matrix-device-isolation'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'

import { SettingsTip } from './settings-row'

export interface MatrixDeviceIsolationSettingProps {
  locale: DesktopLocale
  value: MatrixDeviceIsolation
  writable: boolean
  /** Native persists the per-install preference, then rebuilds all SDK hosts. */
  onChange(value: MatrixDeviceIsolation): Promise<void>
  onFailure(): void
}

/** A narrow Advanced row; authoritative value comes back through the native snapshot. */
export function MatrixDeviceIsolationSetting({
  locale,
  value,
  writable,
  onChange,
  onFailure
}: MatrixDeviceIsolationSettingProps) {
  const [pending, setPending] = useState(false)
  const copy = matrixDeviceIsolationCopy[locale]

  const save = async (checked: boolean) => {
    if (pending || !writable) {
      return
    }

    setPending(true)

    try {
      await onChange(checked ? 'signed' : 'all')
    } catch {
      onFailure()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="atum-settings-row" data-matrix-device-isolation>
      <span className="atum-settings-row-text">
        <span className="atum-settings-row-title">
          {copy.title}
          <SettingsTip label={copy.group} />
        </span>
        <span className="atum-settings-row-help">{copy.help}</span>
      </span>
      <Switch
        aria-label={copy.title}
        checked={value === 'signed'}
        disabled={!writable || pending}
        onCheckedChange={checked => void save(checked)}
      />
    </div>
  )
}
