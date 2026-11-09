import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Check, Spinner } from '@/lib/icons'

import type { MatrixDomainIdentity, MatrixEnrollment, MatrixSnapshot } from '../../shared/matrix'

import { useMatrixCopy } from './copy'
import { hermesSetupCopy } from './hermes-setup-copy'
import { MatrixLaunchNotice } from './launch-notice'
import { matrixPrimaryAgentName } from './roster-model'
import { useMatrixSettingsCopy } from './settings-copy'
import { SettingsRow } from './settings-row'

/** A Repair is at least this long, so "checking" reads as a step, not a flicker. */
const REPAIR_MIN_MS = 1_500
/** It stops waiting for a still-starting assistant after this; the state below says the rest. */
const REPAIR_MAX_MS = 30_000

/**
 * "Assistant not answering?" and one Repair: the assistant's checks run again now (the
 * readiness gate's Try again), then the result in plain words — ready, or the reason with
 * the one action that helps (launch-notice.tsx). The technical controls wait behind
 * Technical details.
 */
export function AssistantRepair({ snapshot }: { snapshot: MatrixSnapshot }) {
  const { locale, t } = useI18n()
  const copy = hermesSetupCopy[locale]
  const [phase, setPhase] = useState<'idle' | 'checking' | 'done'>('idle')
  const [startedAt, setStartedAt] = useState(0)
  const starting = snapshot.readiness?.phase === 'starting'

  useEffect(() => {
    if (phase !== 'checking') {
      return
    }

    const settle = () => setPhase('done')
    const elapsed = Date.now() - startedAt
    const wait = starting ? REPAIR_MAX_MS - elapsed : REPAIR_MIN_MS - elapsed
    const id = window.setTimeout(settle, Math.max(0, wait))

    return () => window.clearTimeout(id)
  }, [phase, startedAt, starting])

  const repair = () => {
    setStartedAt(Date.now())
    setPhase('checking')
    void window.atumMatrix.retryReadiness().catch(() => {})
  }

  const ready = snapshot.readiness?.phase === 'ready'

  return (
    <div className="atum-settings-item" data-matrix-assistant-repair>
      <SettingsRow
        control={
          <Button disabled={phase === 'checking'} onClick={repair} size="sm" variant="secondary">
            {copy.repair}
          </Button>
        }
        help={copy.repairHelp}
        title={copy.repairTitle}
      />
      {phase === 'checking' && (
        <div className="atum-settings-item-note" role="status">
          <Spinner className="size-4 animate-spin" />
          {copy.repairing}
        </div>
      )}
      {phase === 'done' &&
        (ready ? (
          <p className="atum-settings-item-note text-(--atum-ink)" role="status">
            <Check aria-hidden className="size-3.5" />
            {copy.repairReady}
          </p>
        ) : (
          <div className="pb-3 [&>div]:px-3.5 [&>div]:pt-0">
            <MatrixLaunchNotice
              name={matrixPrimaryAgentName(snapshot, t.matrixShell.assistantName)}
              snapshot={snapshot}
            />
          </div>
        ))}
    </div>
  )
}

/**
 * Behind "Technical details": the token-free account read and this Mac's assistant
 * connection, for support. Not a second sign-in/account-linking interface.
 */
export function DomainIdentity({ visible = true }: { visible?: boolean }) {
  const copy = useMatrixCopy()
  const settings = useMatrixSettingsCopy()
  const [identity, setIdentity] = useState<MatrixDomainIdentity | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [enrollment, setEnrollment] = useState<MatrixEnrollment | null>(null)
  const [enrollmentPending, setEnrollmentPending] = useState(false)
  const [enrollmentFailed, setEnrollmentFailed] = useState(false)
  const live = useRef(true)
  const cancelled = useRef(false)
  const enrollmentRevision = useRef(0)
  const enrollmentWriting = useRef(false)

  useEffect(() => {
    if (enrollment?.state !== 'ready' || !enrollment.identity) {
      return
    }

    const timer = setTimeout(
      () => setEnrollment(current => (current?.state === 'ready' ? { ...current, state: 'expired' } : current)),
      Math.max(0, enrollment.identity.expiresAt - Date.now())
    )

    return () => clearTimeout(timer)
  }, [enrollment])

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const refreshEnrollment = useCallback(async () => {
    if (enrollmentWriting.current) {
      return
    }

    const revision = ++enrollmentRevision.current
    setEnrollmentFailed(false)

    try {
      const result = await window.atumMatrix.enrollment()

      if (live.current && revision === enrollmentRevision.current) {
        setEnrollment(result)
      }
    } catch {
      if (live.current && revision === enrollmentRevision.current) {
        // An unreadable refresh is not evidence that the retained registration
        // is still valid (nor that it is absent).
        setEnrollment(null)
        setEnrollmentFailed(true)
      }
    }
  }, [])

  useEffect(() => {
    if (visible) {
      void refreshEnrollment()
    }

    return () => {
      enrollmentRevision.current += 1
    }
  }, [refreshEnrollment, visible])

  const updateEnrollment = async (revoke: boolean) => {
    if (enrollmentWriting.current) {
      return
    }

    enrollmentWriting.current = true
    enrollmentRevision.current += 1
    setEnrollmentPending(true)
    setEnrollmentFailed(false)

    try {
      const result = await (revoke ? window.atumMatrix.revokeHermes() : window.atumMatrix.enrollHermes())

      if (live.current) {
        setEnrollment(result)
      }
    } catch {
      if (live.current) {
        setEnrollmentFailed(true)
      }

      try {
        const result = await window.atumMatrix.enrollment()

        if (live.current) {
          setEnrollment(result)
        }
      } catch {
        /* Preserve failure; an unreadable vault is not an absent enrollment. */
      }
    } finally {
      enrollmentWriting.current = false

      if (live.current) {
        setEnrollmentPending(false)
      }
    }
  }

  const read = async () => {
    cancelled.current = false
    setPending(true)
    setFailed(false)
    setIdentity(null)

    try {
      const result = await window.atumMatrix.readDomain()

      if (live.current && !cancelled.current) {
        setIdentity(result)
      }
    } catch {
      if (live.current && !cancelled.current) {
        setFailed(true)
      }
    } finally {
      if (live.current) {
        setPending(false)
      }
    }
  }

  const enrollmentState = enrollmentPending
    ? copy.enrollmentWorking
    : enrollment
      ? {
          absent: copy.enrollmentAbsent,
          pending: copy.enrollmentUnresolved,
          revoking: copy.enrollmentUnknown,
          ready: copy.enrollmentReady,
          expired: copy.enrollmentExpired,
          withdrawn: copy.enrollmentWithdrawn
        }[enrollment.state]
      : ''

  return (
    <details data-matrix-technical-assistant>
      <summary>{copy.technicalDetails}</summary>
      {/* Two checks support may ask for, each one row: what it is, how it stands, its act. */}
      <div className="atum-settings-rows">
        <SettingsRow
          control={
            pending ? (
              <Button
                onClick={() => {
                  cancelled.current = true
                  void window.atumMatrix.cancelDomain().catch(() => {
                    if (live.current) {
                      setFailed(true)
                    }
                  })
                }}
                size="sm"
                variant="text"
              >
                {copy.cancel}
              </Button>
            ) : (
              <Button
                aria-label={copy.domainRead}
                disabled={enrollmentPending}
                onClick={() => void read()}
                size="sm"
                variant="secondary"
              >
                {settings.check}
              </Button>
            )
          }
          help={
            pending ? (
              <span className="flex items-center gap-1.5" role="status">
                <Spinner className="size-3.5 shrink-0 animate-spin" />
                {copy.domainPending}
              </span>
            ) : identity ? (
              <span className="break-all" role="status">
                {copy.domainPrincipal}: {identity.principal}
              </span>
            ) : (
              settings.atumAccountHelp
            )
          }
          tip={copy.domainHelp}
          title={settings.atumAccount}
        />
        {failed && (
          <div className="atum-settings-item">
            <NoticeBand tone="failure">{copy.domainError}</NoticeBand>
          </div>
        )}
        <SettingsRow
          control={
            enrollment?.state !== 'withdrawn' ? (
              <>
                {!enrollment && enrollmentFailed && (
                  <Button onClick={() => void refreshEnrollment()} size="sm" variant="text">
                    {copy.retry}
                  </Button>
                )}
                <Button
                  disabled={pending || enrollmentPending || !enrollment || enrollment.state === 'absent'}
                  onClick={() => void updateEnrollment(true)}
                  size="sm"
                  variant="text"
                >
                  {copy.enrollmentRevoke}
                </Button>
                <Button
                  disabled={
                    pending ||
                    enrollmentPending ||
                    !enrollment ||
                    !['absent', 'expired', 'pending'].includes(enrollment.state)
                  }
                  onClick={() => void updateEnrollment(false)}
                  size="sm"
                  variant="secondary"
                >
                  {copy.enrollmentEnroll}
                </Button>
              </>
            ) : undefined
          }
          help={
            <>
              <span role="status">{enrollmentState}</span>
              {/* Behind Technical details, support may need to know which account it is. */}
              {enrollment?.identity && <span className="block break-all">{enrollment.identity.userId}</span>}
            </>
          }
          tip={copy.enrollmentHelp}
          title={copy.enrollmentTitle}
        />
        {enrollmentFailed && (
          <div className="atum-settings-item">
            <NoticeBand tone="failure">{enrollment ? copy.enrollmentError : copy.enrollmentLoadError}</NoticeBand>
          </div>
        )}
      </div>
    </details>
  )
}
