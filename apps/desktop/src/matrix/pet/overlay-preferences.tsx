import { useEffect, useState } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { useI18n } from '@/i18n'

import type { MatrixPetDisplayBridge } from '../../../shared/matrix-pet-display'

import { petOverlayCopy } from './overlay-copy'

export interface PetOverlayPreferencesProps {
  bridge: MatrixPetDisplayBridge
}

export function PetOverlayPreferences({ bridge }: PetOverlayPreferencesProps) {
  const { locale } = useI18n()
  const copy = petOverlayCopy[locale]
  const [value, setValue] = useState(false)
  const [pending, setPending] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setPending(true)
    void bridge
      .readPreferences()
      .then(preferences => {
        if (live) {
          setValue(preferences.showReplyExcerpt === true)
          setFailed(false)
        }
      })
      .catch(() => {
        if (live) {
          setValue(false)
          setFailed(true)
        }
      })
      .finally(() => {
        if (live) {
          setPending(false)
        }
      })

    return () => {
      live = false
    }
  }, [bridge])

  async function change(checked: boolean) {
    setPending(true)
    setFailed(false)

    try {
      setValue((await bridge.writePreferences({ showReplyExcerpt: checked })).showReplyExcerpt === true)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>{copy.showReplies}</span>
        <Checkbox
          aria-label={copy.showReplies}
          checked={value}
          disabled={pending}
          onCheckedChange={checked => void change(checked === true)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{copy.screenShare}</p>
      {failed && (
        <p className="text-xs text-muted-foreground" role="status">
          {copy.preferenceFailed}
        </p>
      )}
    </div>
  )
}
