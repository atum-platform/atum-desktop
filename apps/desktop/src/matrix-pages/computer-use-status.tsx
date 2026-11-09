import { useCallback, useEffect, useRef, useState } from 'react'

import { ListRow, Pill, SettingsSection } from '@/app/settings/primitives'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Monitor, RefreshCw } from '@/lib/icons'

import type { MatrixComputerUseClient, MatrixComputerUseSnapshot } from '../../shared/matrix-computer-use'

import { computerUseStatusCopy } from './computer-use-status-copy'

type LoadState = 'idle' | 'loading' | 'error'

function healthLabel(snapshot: MatrixComputerUseSnapshot, copy: (typeof computerUseStatusCopy)['en']) {
  if (snapshot.platform === 'unsupported') {
    return copy.unsupported
  }

  if (!snapshot.installed) {
    return copy.notInstalled
  }

  if (snapshot.ready === true) {
    return copy.ready
  }

  if (snapshot.ready === false) {
    return copy.notReady
  }

  return copy.unknown
}

function healthTone(snapshot: MatrixComputerUseSnapshot): 'muted' | 'primary' | 'warn' {
  if (snapshot.installed && snapshot.ready === true) {
    return 'primary'
  }

  return snapshot.ready === null || snapshot.platform === 'unsupported' ? 'muted' : 'warn'
}

function permissionLabel(value: boolean | null, copy: (typeof computerUseStatusCopy)['en']) {
  return value === true ? copy.granted : value === false ? copy.notGranted : copy.unknown
}

function permissionTone(value: boolean | null): 'muted' | 'primary' | 'warn' {
  return value === true ? 'primary' : value === false ? 'warn' : 'muted'
}

function captureLabel(value: boolean | null, copy: (typeof computerUseStatusCopy)['en']) {
  return value === true ? copy.captureAvailable : value === false ? copy.captureUnavailable : copy.unknown
}

interface MatrixComputerUseStatusProps {
  client: MatrixComputerUseClient
  agentName: string
}

/**
 * Passive, scoped presentation of the selected local agent's CuaDriver state.
 * It never performs install, grant, settings, or control operations.
 */
export function MatrixComputerUseStatus({ client, agentName }: MatrixComputerUseStatusProps) {
  const { locale } = useI18n()
  const copy = computerUseStatusCopy[locale]
  const [snapshot, setSnapshot] = useState<MatrixComputerUseSnapshot | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const mounted = useRef(false)
  const scope = useRef(0)
  const inFlight = useRef<{ promise: Promise<void>; scope: number } | null>(null)

  const refresh = useCallback(() => {
    const currentScope = scope.current
    const existing = inFlight.current

    if (existing?.scope === currentScope) {
      return existing.promise
    }

    if (mounted.current) {
      setLoadState('loading')
    }

    const promise = client
      .status()
      .then(next => {
        if (mounted.current && scope.current === currentScope) {
          setSnapshot(next)
          setLoadState('idle')
        }
      })
      .catch(() => {
        if (mounted.current && scope.current === currentScope) {
          setLoadState('error')
        }
      })
      .finally(() => {
        if (inFlight.current?.scope === currentScope) {
          inFlight.current = null
        }
      })

    inFlight.current = { promise, scope: currentScope }

    return promise
  }, [client])

  useEffect(() => {
    mounted.current = true
    scope.current += 1
    setSnapshot(null)
    setLoadState('loading')
    void refresh()

    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)

    return () => {
      window.removeEventListener('focus', onFocus)
      mounted.current = false
      scope.current += 1
    }
  }, [agentName, refresh])

  const checking = loadState === 'loading'
  const isMac = snapshot?.platform === 'darwin'
  const captureUnavailable = isMac && snapshot?.screenRecording === true && snapshot.screenRecordingCapturable === false

  return (
    <SettingsSection
      aside={
        <Button disabled={checking} onClick={() => void refresh()} size="sm" type="button" variant="text">
          <RefreshCw aria-hidden />
          {copy.refresh}
        </Button>
      }
      icon={Monitor}
      title={copy.title}
    >
      <div data-matrix-computer-use-status>
        <p className="pb-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {copy.scope(agentName)} · {copy.description}
        </p>

        {checking && !snapshot ? (
          <ListRow action={<Pill>{copy.checking}</Pill>} description={copy.localOnly} title={copy.driverHealth} />
        ) : null}

        {loadState === 'error' && !snapshot ? (
          <NoticeBand role="alert" tone="failure">
            <span>{copy.statusError}</span>{' '}
            <Button onClick={() => void refresh()} size="inline" type="button" variant="textStrong">
              {copy.retry}
            </Button>
          </NoticeBand>
        ) : null}

        {snapshot ? (
          <>
            <div className="divide-y divide-border/70">
              <ListRow
                action={<Pill tone={healthTone(snapshot)}>{healthLabel(snapshot, copy)}</Pill>}
                description={isMac ? copy.localOnly : copy.nonMac}
                title={isMac ? copy.macPermissions : copy.driverHealth}
              />

              {isMac ? (
                <>
                  <ListRow
                    action={
                      <Pill tone={permissionTone(snapshot.accessibility)}>
                        {permissionLabel(snapshot.accessibility, copy)}
                      </Pill>
                    }
                    title={copy.accessibility}
                  />
                  <ListRow
                    action={
                      <Pill tone={permissionTone(snapshot.screenRecording)}>
                        {permissionLabel(snapshot.screenRecording, copy)}
                      </Pill>
                    }
                    title={copy.screenRecording}
                  />
                  <ListRow
                    action={
                      <Pill tone={permissionTone(snapshot.screenRecordingCapturable)}>
                        {captureLabel(snapshot.screenRecordingCapturable, copy)}
                      </Pill>
                    }
                    description={captureUnavailable ? copy.reopenDriver : undefined}
                    title={copy.screenCapture}
                  />
                </>
              ) : null}
            </div>

            {isMac && (
              <NoticeBand role="status" tone="notice">
                {copy.macDriverOnly}
              </NoticeBand>
            )}
            {loadState === 'error' && (
              <NoticeBand role="status" tone="notice">
                {copy.statusError}
              </NoticeBand>
            )}
          </>
        ) : null}
      </div>
    </SettingsSection>
  )
}
