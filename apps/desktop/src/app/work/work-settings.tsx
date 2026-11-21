import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { SettingsRow } from '@/matrix/settings-row'

import type { MatrixWorkBridge } from '../../../shared/matrix-work'

import { workCopy } from './copy'
import { $work } from './store'

/** The assistants states in which the owner's switch means something; `needs_grant` waits for the enrollment text. */
const ASSISTANT_SWITCH = new Set(['on', 'off', 'holding', 'stale', 'unreachable'])

/**
 * Settings › This Mac: Work itself on or off, and "Assistants can start work here" beside it when this Mac has the
 * route. Nothing is drawn while main reports no Work for this account (the projection is null): a build or an
 * account without Work has no row that does nothing.
 */
export function MatrixWorkSettings({ bridge = window.atumMatrix?.work }: { bridge?: Pick<MatrixWorkBridge, 'setAssistants' | 'setWork'> }) {
  const { locale } = useI18n()
  const copy = workCopy(locale)
  const projection = useStore($work)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  if (!bridge || !projection) {
    return null
  }

  const run = async (action: () => Promise<void>) => {
    setPending(true)
    setFailed(false)

    try {
      await action()
    } catch {
      if (mounted.current) {
        setFailed(true)
      }
    } finally {
      if (mounted.current) {
        setPending(false)
      }
    }
  }

  const workOn = projection.view !== 'off'

  return (
    <div data-matrix-work-settings>
      <SettingsRow
        as="label"
        control={
          <Switch
            aria-label={copy.settings.title}
            checked={workOn}
            disabled={pending}
            onCheckedChange={on => void run(() => bridge.setWork(on))}
          />
        }
        help={copy.settings.help}
        title={copy.settings.title}
      />
      {workOn && ASSISTANT_SWITCH.has(projection.assistants) && (
        <SettingsRow
          as="label"
          control={
            <Switch
              aria-label={copy.switchLabel}
              checked={projection.assistants !== 'off'}
              disabled={pending}
              onCheckedChange={on => void run(() => bridge.setAssistants(on))}
            />
          }
          title={copy.switchLabel}
        />
      )}
      {failed && (
        <NoticeBand role="status" tone="notice">
          {copy.settings.failed}
        </NoticeBand>
      )}
    </div>
  )
}
