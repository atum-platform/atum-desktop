import { useEffect, useRef, useState } from 'react'

import { SettingsSection } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Monitor } from '@/lib/icons'

import {
  MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT,
  MATRIX_COMPUTER_USE_GRANT_POLL_MS,
  type MatrixComputerUseGrantClient
} from '../../shared/matrix-computer-use-grant'

import { computerUseGrantCopy } from './computer-use-grant-copy'

type State =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'unsupported'
  | 'not-installed'
  | 'busy'

interface MatrixComputerUseGrantProps {
  grantClient: MatrixComputerUseGrantClient
  onTerminal(): void
}

/** Explicit intent only. Native owns confirmation and the opaque operation's
 * original process; process completion never stands in for permission facts. */
export function MatrixComputerUseGrant({ grantClient, onTerminal }: MatrixComputerUseGrantProps) {
  const { locale } = useI18n()
  const copy = computerUseGrantCopy[locale]
  const [state, setState] = useState<State>('idle')
  const [checking, setChecking] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const operation = useRef<string | null>(null)
  const polls = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const terminal = useRef(onTerminal)
  terminal.current = onTerminal

  useEffect(() => {
    generation.current += 1
    pending.current = false
    operation.current = null
    polls.current = 0
    setState('idle')
    setChecking(false)

    return () => {
      generation.current += 1

      if (timer.current !== undefined) {clearTimeout(timer.current)}
    }
  }, [grantClient])

  const finish = (next: 'completed' | 'failed' | 'unknown') => {
    operation.current = null
    setState(next)
    terminal.current()
  }

  const check = async (scope: number, automatic: boolean) => {
    const id = operation.current

    if (scope !== generation.current || !id || pending.current) {return}
    pending.current = true
    setChecking(true)

    if (automatic) {polls.current += 1}

    try {
      const result = await grantClient.operationStatus(id)

      if (scope !== generation.current) {return}

      if (result.status !== 'running') {
        finish(result.status === 'completed' || result.status === 'failed' ? result.status : 'unknown')
      } else if (automatic && polls.current < MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT) {
        timer.current = setTimeout(() => void check(scope, true), MATRIX_COMPUTER_USE_GRANT_POLL_MS)
      } else {
        setState('paused')
      }
    } catch {
      if (scope === generation.current) {finish('unknown')}
    } finally {
      if (scope === generation.current) {
        pending.current = false
        setChecking(false)
      }
    }
  }

  const start = async () => {
    if (pending.current || operation.current) {return}
    const scope = generation.current
    pending.current = true
    setState('starting')

    try {
      const result = await grantClient.start()

      if (scope !== generation.current) {return}

      switch (result.status) {
        case 'started':
          operation.current = result.operationId
          polls.current = 0
          setState('waiting')
          timer.current = setTimeout(() => void check(scope, true), MATRIX_COMPUTER_USE_GRANT_POLL_MS)

          break

        case 'cancelled':
          setState('cancelled')

          break

        case 'blocked':
          setState(result.reason)

          break

        default:
          finish('unknown')
      }
    } catch {
      if (scope === generation.current) {finish('unknown')}
    } finally {
      if (scope === generation.current) {pending.current = false}
    }
  }

  const active = state === 'starting' || state === 'waiting' || state === 'paused'

  return (
    <SettingsSection icon={Monitor} title={copy.title}>
      <div className="space-y-3" data-matrix-computer-use-grant>
        <p className="text-sm text-(--ui-text-secondary)">{copy.description}</p>
        <Button disabled={active} onClick={() => void start()} size="sm" type="button" variant="textStrong">
          {copy.request}
        </Button>
        {state !== 'idle' && (
          <NoticeBand role="status" tone={state === 'failed' ? 'failure' : 'notice'}>
            {state === 'starting' ? copy.starting : state === 'waiting' ? copy.waiting : copy[state]}
          </NoticeBand>
        )}
        {state === 'paused' && (
          <Button
            disabled={checking}
            onClick={() => void check(generation.current, false)}
            size="sm"
            type="button"
            variant="text"
          >
            {checking ? copy.checking : copy.check}
          </Button>
        )}
        {active && <p className="text-sm text-(--ui-text-tertiary)">{copy.continued}</p>}
      </div>
    </SettingsSection>
  )
}
