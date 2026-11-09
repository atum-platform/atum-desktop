import { useStore } from '@nanostores/react'
import { useCallback, useEffect } from 'react'

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

export function BackgroundSweepRow({
  agentPrincipal,
  bridge,
  copy,
  ownerKey
}: {
  agentPrincipal: string
  bridge: MatrixBackgroundSweepBridge
  copy: AssistantCardCopy
  ownerKey: string
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

  return (
    <div className="atum-settings-row" data-assistant-card-background-sweep>
      <span className="atum-settings-row-title min-w-0 flex-1">{copy.backgroundFollowups}</span>
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
          aria-label={copy.backgroundFollowups}
          checked={entry?.setting?.enabled ?? false}
          disabled={!known || entry?.loading === true}
          onCheckedChange={value => {
            if (!pending) {
              save(value)
            }
          }}
          size="xs"
        />
      </span>
    </div>
  )
}
