import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'

import {
  MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
  type MatrixBackgroundSweepBridge
} from '../../../shared/background-sweep'

import type { AssistantCardCopy } from './copy'
import {
  $backgroundSweepSettings,
  backgroundSweepCacheKey,
  beginBackgroundSweepRead,
  beginBackgroundSweepSave,
  finishBackgroundSweepRead,
  finishBackgroundSweepSave
} from './store'

/**
 * The built-in follow-up sweep (on by default): it follows up on open threads on its own. Owner
 * 2026-11-28 (open question 1, yes): it is the first, built-in item of the Routines panel, with its
 * switch; only a window without the routines list keeps it as a row of its own.
 */
export function BackgroundSweepRow({
  agentPrincipal,
  bridge,
  copy,
  glyph,
  ownerKey,
  variant = 'row'
}: {
  agentPrincipal: string
  bridge: MatrixBackgroundSweepBridge
  copy: AssistantCardCopy
  /** The card's leading glyph, for the row form. */
  glyph?: ReactNode
  ownerKey: string
  variant?: 'routine' | 'row'
}) {
  const key = backgroundSweepCacheKey(ownerKey, agentPrincipal)
  const entry = useStore($backgroundSweepSettings, { keys: [key] })[key]

  const read = useCallback(() => {
    const generation = beginBackgroundSweepRead(key)

    void bridge.read(agentPrincipal).then(
      setting => finishBackgroundSweepRead(key, generation, setting),
      () => finishBackgroundSweepRead(key, generation)
    )
  }, [agentPrincipal, bridge, key])

  useEffect(() => {
    read()
  }, [read])

  const save = useCallback(
    (enabled: boolean) => {
      const started = beginBackgroundSweepSave(key, enabled)

      if (!started) {
        return
      }

      void bridge
        .save(agentPrincipal, {
          profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
          requestId: globalThis.crypto.randomUUID(),
          expectedRevision: started.previous.revision,
          enabled
        })
        .then(
          result =>
            finishBackgroundSweepSave(key, started.generation, {
              setting: result.setting,
              ...(result.status === 'conflict' ? { retryEnabled: enabled } : {})
            }),
          () =>
            finishBackgroundSweepSave(key, started.generation, {
              setting: started.previous,
              retryEnabled: enabled
            })
        )
    },
    [agentPrincipal, bridge, key]
  )

  const known = entry?.setting !== undefined
  const pending = entry?.pending === true

  const control = (
    <span className="flex shrink-0 items-center gap-2">
      {(entry?.loading || pending) && <Spinner className="size-3.5 animate-spin" />}
      {entry?.error && (
        <Button
          onClick={() => {
            if (entry.error === 'save' && entry.retryEnabled !== undefined) {
              save(entry.retryEnabled)
            } else {
              read()
            }
          }}
          size="inline"
          variant="textStrong"
        >
          {copy.retry}
        </Button>
      )}
      <Switch
        aria-busy={pending || undefined}
        aria-label={copy.followupsRoutine}
        checked={entry?.setting?.enabled ?? false}
        disabled={!known || entry?.loading === true}
        onCheckedChange={value => {
          if (!pending) {
            save(value)
          }
        }}
      />
    </span>
  )

  // In the Routines panel: the first item, built in, drawn like the routines under it.
  if (variant === 'routine') {
    return (
      <li className="flex items-center gap-3 py-2" data-assistant-card-background-sweep data-routine-built-in>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink)">{copy.followupsRoutine}</span>
          <span className="block text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.followupsBuiltIn}</span>
        </span>
        {control}
      </li>
    )
  }

  return (
    <div className="atum-settings-row" data-assistant-card-background-sweep>
      {glyph}
      <span className="atum-settings-row-title min-w-0 flex-1">{copy.followupsRoutine}</span>
      {control}
    </div>
  )
}
