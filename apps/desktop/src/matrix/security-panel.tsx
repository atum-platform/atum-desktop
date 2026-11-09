import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { writeClipboardText } from '@/components/ui/copy-button'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Spinner, X } from '@/lib/icons'

import type { MatrixDevice, MatrixSnapshot } from '../../shared/matrix'
import { matrixApprovalCopy } from '../../shared/matrix-approval-copy'
import {
  isMatrixVerificationPending,
  type MatrixRecoveryKey,
  type MatrixSecurityCommand
} from '../../shared/matrix-security'

import { useAttentionCopy } from './attention-copy'
import { MatrixApprovalRequest } from './device-approval'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { personHandleText } from './person-handle-line'
import { useMatrixPeople } from './person-handles'
import { matrixPersonLabel } from './person-name'
import { PersonSearch } from './person-search'
import { useRosterCreateCopy } from './roster-create-copy'
import { useSecurityCopy } from './security-copy'
import { SettingsLinkRow, SettingsRow, SettingsSection, SettingsStatus } from './settings-row'

/** How long an ended verification stays: "Verified" briefly, a cancel long enough to read. */
const VERIFIED_MS = 3_000
const CANCELLED_MS = 8_000

export function VerificationPrompt({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useSecurityCopy()
  const people = useMatrixPeople(undefined, snapshot.identity?.userId)
  const words = useAttentionCopy()
  const request = snapshot.security?.verification
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  // The ended request the person closed, or that cleared by itself.
  const [cleared, setCleared] = useState<string>()
  // The request this window watched while it ran: only that one says "Verified" at its end.
  const watched = useRef<string | undefined>(undefined)
  const card = useRef<HTMLElement>(null)
  const ended = Boolean(request && !isMatrixVerificationPending(request))
  const owned = Boolean(snapshot.security?.approval && request?.userId === snapshot.identity?.userId)
  // Confirming who is on the other side: their @handle, asked for once.
  useMatrixHandleContacts(snapshot.identity?.userId, [request?.userId], Boolean(snapshot.domainEnabled))

  const hidden =
    !request ||
    cleared === request.id ||
    (request.state === 'done' && watched.current !== request.id) ||
    // One-tap approval owns the person's own devices' comparisons while it runs
    // (device-approval.tsx); verifying someone else stays here.
    owned

  useEffect(() => {
    setError(false)
    setPending(false)
  }, [request?.id])

  useEffect(() => {
    if (request && !ended) {
      watched.current = request.id
    }
  }, [request, ended])

  // An ended request clears by itself, but never from under the person's focus. Its clock is the
  // request's id and state: every snapshot from main brings a new request object.
  const requestId = request?.id
  const requestState = request?.state

  useEffect(() => {
    if (!requestId || !ended || hidden) {
      return
    }

    const timer = window.setTimeout(
      () => {
        const element = card.current

        if (element?.contains(document.activeElement)) {
          element.addEventListener('focusout', () => setCleared(requestId), { once: true })
        } else {
          setCleared(requestId)
        }
      },
      requestState === 'done' ? VERIFIED_MS : CANCELLED_MS
    )

    return () => window.clearTimeout(timer)
  }, [requestId, requestState, ended, hidden])

  if (hidden) {
    return null
  }

  const respond = (action: Extract<MatrixSecurityCommand, { kind: 'verificationRespond' }>['action']) => {
    setPending(true)
    setError(false)
    void window.atumMatrix
      .command({ kind: 'verificationRespond', id: request.id, action })
      .catch(() => setError(true))
      .finally(() => setPending(false))
  }

  const terminal = !isMatrixVerificationPending(request)
  const hasNumbers = request.decimals?.length === 3
  const hasEmoji = request.emoji?.length === 7

  // Who is on the other side, as the chats know them: never a raw address or device ID.
  const direct = snapshot.rooms.find(
    room => room.direct && room.name?.trim() && room.participants?.some(person => person.userId === request.userId)
  )

  const who =
    request.userId === snapshot.identity?.userId
      ? copy.otherDevice
      : direct?.name?.trim() ||
        matrixPersonLabel({
          handle: people.handles?.[request.userId],
          ownerUserId: people.ownerUserId,
          unnamed: people.unnamed,
          userId: request.userId
        }).name

  return (
    <section
      aria-label={copy.request}
      className="atum-glass-card relative p-4"
      data-matrix-verification={request.state}
      ref={card}
    >
      {terminal && (
        <Button
          aria-label={words.close}
          className="absolute top-2 right-2"
          onClick={() => setCleared(request.id)}
          size="icon-xs"
          variant="ghost"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      )}
      <h2 className="text-sm font-semibold">{copy.request}</h2>
      <p className="text-xs text-(--atum-ink-muted)">
        {/* Confirming who is on the other side: their @handle too, when the directory vouched for it. */}
        {[who, request.userId === snapshot.identity?.userId ? undefined : personHandleText(people.handles?.[request.userId])]
          .filter((part, index, parts) => part && (index === 0 || part !== parts[0]))
          .join(' · ')}
      </p>
      {request.state === 'compare' ? (
        <>
          <p>{copy.compare}</p>
          {hasEmoji && (
            <ol aria-label={copy.emoji} className="flex flex-wrap gap-3 py-2">
              {request.emoji!.map(([symbol, description], index) => (
                <li className="flex flex-col items-center text-sm" key={index}>
                  <span aria-hidden="true" className="text-2xl">
                    {symbol}
                  </span>
                  <span>{description}</span>
                </li>
              ))}
            </ol>
          )}
          {hasNumbers && (
            <p aria-label={copy.numbers} className="py-2 text-xl font-semibold">
              {request.decimals!.join(' · ')}
            </p>
          )}
          <Button disabled={pending || (!hasNumbers && !hasEmoji)} onClick={() => respond('confirm')}>
            {copy.confirm}
          </Button>
          <Button disabled={pending} onClick={() => respond('mismatch')} variant="secondary">
            {copy.mismatch}
          </Button>
        </>
      ) : (
        <p role="status">{request.state === 'done' ? words.verified : terminal ? copy.cancelled : copy.waiting}</p>
      )}
      {request.incoming && request.state === 'requested' && (
        <Button disabled={pending} onClick={() => respond('accept')}>
          {copy.accept}
        </Button>
      )}
      {request.state === 'ready' && (
        <Button disabled={pending} onClick={() => respond('start')}>
          {copy.start}
        </Button>
      )}
      {!terminal && (
        <Button disabled={pending} onClick={() => respond('cancel')} variant="text">
          {copy.cancel}
        </Button>
      )}
      {error && <NoticeBand tone="failure">{copy.error}</NoticeBand>}
    </section>
  )
}

/**
 * Settings' recovery row: its name, whether it is on (the section above says what it is
 * for), and the one thing to do; its steps open in place under it.
 */
function RecoveryRow({
  actions,
  children,
  snapshot
}: {
  actions?: ReactNode
  children: ReactNode
  snapshot: MatrixSnapshot
}) {
  const copy = useSecurityCopy()
  const storage = snapshot.security?.storage
  const on = storage === 'present' || snapshot.security?.recovery === 'ready'

  return (
    <div className="atum-settings-item atum-settings-recovery" data-matrix-recovery-row>
      <SettingsRow
        control={actions}
        help={
          on ? (
            // One line, centred on the check: "✓ On · Saved on this Mac".
            <span className="inline-flex flex-wrap items-center gap-x-1">
              <SettingsStatus data-matrix-recovery-status="on" done>
                {copy.recoveryOn}
              </SettingsStatus>
              {/* Kept on this Mac (made quietly at first run, or the person's own): signing in
                  again here unlocks by itself. */}
              {(snapshot.security?.kept || snapshot.security?.custody === 'device') && (
                <>
                  <span aria-hidden>·</span>
                  <span data-matrix-recovery-custody>{copy.onThisMac}</span>
                </>
              )}
            </span>
          ) : storage === 'absent' ? (
            <SettingsStatus data-matrix-recovery-status="off">{copy.recoveryOff}</SettingsStatus>
          ) : undefined
        }
        title={copy.recoveryTitle}
      />
      {children}
    </div>
  )
}

/**
 * The key's copy in iCloud Keychain (electron/matrix/icloud-keychain.ts): a new Mac on the same
 * Apple ID unlocks by itself. Shown only in a build whose Atum Keys helper works; on by default.
 * Turning it off removes the copy on every device of that Apple ID, so it asks first.
 */
function ICloudKeychainRow({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useSecurityCopy()
  const icloud = snapshot.security?.icloud
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!icloud || !window.atumMatrix.icloudKeychain) {
    return null
  }

  const change = (enabled: boolean) => {
    setPending(true)
    setFailed(false)
    void window.atumMatrix.icloudKeychain!(enabled)
      .then(() => setConfirming(false))
      .catch(() => setFailed(true))
      .finally(() => setPending(false))
  }

  return (
    <div className="atum-settings-item" data-matrix-icloud-keychain={icloud}>
      <SettingsRow
        control={
          <Switch
            aria-label={copy.icloudTitle}
            checked={icloud === 'on'}
            disabled={pending}
            onCheckedChange={value => (value ? change(true) : setConfirming(true))}
          />
        }
        help={copy.icloudHelp}
        title={copy.icloudTitle}
      />
      {confirming && (
        <div className="flex flex-col gap-2 px-3.5 pb-3" role="group">
          <p className="atum-security-lead">{copy.icloudOffConfirm}</p>
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => change(false)} size="sm" variant="destructive">
              {copy.icloudRemove}
            </Button>
            <Button disabled={pending} onClick={() => setConfirming(false)} size="sm" variant="text">
              {copy.cancel}
            </Button>
          </div>
        </div>
      )}
      {failed && <NoticeBand tone="failure">{copy.icloudFailed}</NoticeBand>}
    </div>
  )
}

/** How long a new key stays on screen before it is forgotten, here and in main. */
const KEY_SHOWN_MS = 120_000

/** "1:45": what is left of the two minutes, shown beside the key. */
function KeyCountdown({ since }: { since: number }) {
  const copy = useSecurityCopy()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000)

    return () => window.clearInterval(id)
  }, [])

  const left = Math.max(0, Math.ceil((KEY_SHOWN_MS - (now - since)) / 1_000))

  return (
    <span className="text-(length:--atum-t-caption) text-(--atum-ink-muted) tabular-nums" data-matrix-key-countdown>
      {copy.hiddenIn(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)}
    </span>
  )
}

/** Asks the Privacy pane to open the write-down at once (signing out, before the key is
 * written down): one-shot, read and cleared by the panel when it shows. */
export const $matrixRecoveryWriteDown = atom(false)

/**
 * The key this Mac keeps (owner-keys.ts), shown when the person asks: for two minutes, with
 * Copy. A key made quietly on this first Mac (`write-down`) is then confirmed ("I've written it
 * down"), after which forgetting it at sign-out no longer asks for it first; one the person
 * already has (`show`, typed or approved) just closes. Hidden again on Cancel, on the timer and
 * when the panel goes away; main hands the key over only for this account.
 */
function RecoveryWriteDown({ mode = 'write-down' }: { mode?: 'write-down' | 'show' }) {
  const copy = useSecurityCopy()
  const requested = useStore($matrixRecoveryWriteDown)
  const [key, setKey] = useState<string | null>(null)
  const [shownAt, setShownAt] = useState(0)
  const [written, setWritten] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = useRef(true)
  // Bumped when a reveal is superseded (hidden, or the panel went away): a late key is dropped.
  const revealRequest = useRef(0)
  const bridge = window.atumMatrix.recoveryKey

  const hide = () => {
    revealRequest.current += 1
    setKey(null)
    setWritten(false)
    setCopied(false)
  }

  const reveal = () => {
    if (!bridge) {
      setFailed(true)

      return
    }

    const request = ++revealRequest.current
    setPending(true)
    setFailed(false)
    void bridge
      .reveal()
      .then(value => {
        if (live.current && request === revealRequest.current) {
          setKey(value)
          setShownAt(Date.now())
        }
      })
      .catch(() => live.current && setFailed(true))
      .finally(() => live.current && setPending(false))
  }

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
      revealRequest.current += 1
    }
  }, [])

  useEffect(() => {
    if (requested) {
      $matrixRecoveryWriteDown.set(false)
      reveal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested])

  useEffect(() => {
    if (!key) {
      return
    }

    // Shown for two minutes, then hidden, as a new key is.
    const timer = setTimeout(hide, KEY_SHOWN_MS)

    return () => clearTimeout(timer)
  }, [key])

  return (
    <div className="atum-recovery" data-matrix-recovery-write-down={mode}>
      <p className="atum-security-lead">{mode === 'show' ? copy.showKeyLead : copy.writeDownLead}</p>
      {key ? (
        <div className="flex flex-col gap-3">
          {shownAt > 0 && <KeyCountdown since={shownAt} />}
          <div className="flex items-center gap-3">
            <textarea
              aria-label={copy.key}
              autoComplete="off"
              className="atum-recovery-key"
              readOnly
              rows={3}
              spellCheck={false}
              value={key}
            />
            <Button
              onClick={() => {
                void writeClipboardText(key)
                  .then(() => live.current && setCopied(true))
                  .catch(() => {})
              }}
              size="sm"
              variant="secondary"
            >
              {copied ? copy.copied : copy.copyKey}
            </Button>
          </div>
          {mode === 'write-down' && (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={written}
                className="border-(--atum-line-strong)"
                onCheckedChange={value => setWritten(value === true)}
              />
              {copy.writtenCheck}
            </label>
          )}
          <div className="flex gap-2">
            {mode === 'show' ? (
              <Button onClick={hide} size="sm">
                {copy.writtenDone}
              </Button>
            ) : (
              <Button
                disabled={pending || !written}
                onClick={() => {
                  setPending(true)
                  setFailed(false)
                  void bridge!
                    .written()
                    .then(() => live.current && hide())
                    .catch(() => live.current && setFailed(true))
                    .finally(() => live.current && setPending(false))
                }}
                size="sm"
              >
                {copy.writtenDone}
              </Button>
            )}
            {mode === 'write-down' && (
              <Button disabled={pending} onClick={hide} size="sm" variant="text">
                {copy.cancel}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={reveal} size="sm" variant="secondary">
            {mode === 'show' ? copy.showKey : copy.writeDown}
          </Button>
        </div>
      )}
      {failed && <NoticeBand tone="failure">{copy.revealFailed}</NoticeBand>}
    </div>
  )
}

/**
 * The recovery key: set one up (shown once, for two minutes, confirmed separately) or use
 * yours to unlock this Mac. Keyed by native identity at its call sites, so nothing typed
 * here crosses accounts or devices. A key that was created but never confirmed is
 * discarded when it times out, when it is cancelled, and when the panel goes away; a key
 * typed to restore is cleared the moment it is sent.
 *
 * At launch, `intent` (from whether the account already has a key on the server) leaves
 * one action: make the key on a first Mac, enter it on another. The card around the panel
 * says why in one sentence. In Settings the panel is a row that says whether recovery is
 * on, and offers the one action the account needs (make a key, or use yours); both stay on
 * offer only while that is not known yet.
 */
export function RecoveryKeyPanel({
  intent,
  launch = false,
  snapshot
}: {
  intent?: 'create' | 'restore'
  launch?: boolean
  snapshot: MatrixSnapshot
}) {
  const copy = useSecurityCopy()
  const approvalCopy = matrixApprovalCopy(useI18n().locale)
  const only = launch ? intent : undefined
  const storage = snapshot.security?.storage
  // In Settings: what the account already has decides the one action on offer.
  const offer = launch ? undefined : storage === 'present' ? 'restore' : storage === 'absent' ? 'create' : undefined
  const [mode, setMode] = useState<'choose' | 'create' | 'restore'>('choose')
  // The person chose their key over approving from another device (`key`), or said they have no
  // other device (`none`, with a word on where the key usually is).
  const [keyChosen, setKeyChosen] = useState<'key' | 'none' | null>(null)
  const approval = snapshot.security?.approval
  // Entering the key is the only step when the account already has one (the intent can
  // arrive after the first sync, so this is derived rather than initial state).
  const view = only === 'restore' && mode === 'choose' ? 'restore' : mode
  const [created, setCreated] = useState<MatrixRecoveryKey | null>(null)
  const [shownAt, setShownAt] = useState(0)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [key, setKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<'create' | 'other' | null>(null)
  const live = useRef(true)
  // Bumped when a key request is superseded (by unmount), so a late key is discarded, not shown.
  const keyRequest = useRef(0)
  const recovery = snapshot.security?.recovery
  const disabled = pending || snapshot.state !== 'ready' || recovery === 'working'
  // While main works, and once it is done, the status line is the whole panel.
  const settled = recovery === 'working' || recovery === 'ready'

  const run = (work: () => Promise<unknown>, failure: 'create' | 'other' = 'other') => {
    setPending(true)
    setError(null)
    void work()
      .catch(() => live.current && setError(failure))
      .finally(() => live.current && setPending(false))
  }

  const forget = () => {
    setCreated(null)
    setSaved(false)
    setCopied(false)
    setMode('choose')
  }

  const discard = () => {
    forget()
    void window.atumMatrix.command({ kind: 'recoveryDiscard' }).catch(() => {})
  }

  useEffect(() => {
    if (!created) {
      return
    }

    // Shown for two minutes, then gone here and in main.
    const timer = setTimeout(discard, KEY_SHOWN_MS)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created])
  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
      keyRequest.current += 1
      void window.atumMatrix.command({ kind: 'recoveryDiscard' }).catch(() => {})
    }
  }, [])

  // In Settings, when the account says which one action it needs, that action is the
  // row's control; on the launch card, and while it is not known yet, the steps hold it.
  const actionInRow = !launch && offer !== undefined

  const chooseActions = (
    <>
      {offer !== 'restore' && (
        <Button
          className={only ? 'h-11 w-full rounded-[var(--atum-r-input)] text-[0.875rem]' : undefined}
          disabled={disabled}
          onClick={() => {
            const request = ++keyRequest.current

            run(async () => {
              const made = (await window.atumMatrix.command({ kind: 'recoveryCreateKey' })) as MatrixRecoveryKey

              // Main finished after this panel went away: forget the key there too, never show it.
              if (!live.current || request !== keyRequest.current) {
                void window.atumMatrix.command({ kind: 'recoveryDiscard' }).catch(() => {})

                return
              }

              setCreated(made)
              setShownAt(Date.now())
              setMode('create')
            }, 'create')
          }}
          size={only ? 'default' : 'sm'}
          variant={only || offer === 'create' ? 'default' : 'secondary'}
        >
          {copy.create}
        </Button>
      )}
      {!only && offer !== 'create' && (
        <Button disabled={disabled} onClick={() => setMode('restore')} size="sm" variant="secondary">
          {copy.use}
        </Button>
      )}
    </>
  )

  const body = (
    <div className="atum-recovery" data-matrix-recovery>
      {/* One line of explanation per step: this one only while choosing (a launch card with
            one action already says it). */}
      {!settled && view === 'choose' && !only && launch && (
        <p className="atum-security-lead">{copy.agentRecoveryHelp}</p>
      )}

      {!settled && view === 'choose' && !actionInRow && <div className="flex flex-wrap gap-2">{chooseActions}</div>}

      {!settled && view === 'create' && created && (
        <div className="flex flex-col gap-3">
          <p className="atum-security-lead">{copy.keyShown}</p>
          {shownAt > 0 && <KeyCountdown since={shownAt} />}
          {/* One line of text drawn as three rows of four groups: selecting or copying keeps its spaces. */}
          <div className="flex items-center gap-3">
            <textarea
              aria-label={copy.key}
              autoComplete="off"
              className="atum-recovery-key"
              readOnly
              rows={3}
              spellCheck={false}
              value={created.key}
            />
            <Button
              onClick={() => {
                void writeClipboardText(created.key)
                  .then(() => setCopied(true))
                  .catch(() => {})
              }}
              size="sm"
              variant="secondary"
            >
              {copied ? copy.copied : copy.copyKey}
            </Button>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={saved}
              className="border-(--atum-line-strong)"
              onCheckedChange={value => setSaved(value === true)}
            />
            {copy.savedCheck}
          </label>
          <div className="flex gap-2">
            <Button
              disabled={disabled || !saved}
              onClick={() =>
                run(async () => {
                  const id = created.id
                  forget()
                  await window.atumMatrix.command({ kind: 'recoverySetUp', id })
                })
              }
              size="sm"
            >
              {copy.turnOn}
            </Button>
            <Button disabled={pending} onClick={discard} size="sm" variant="text">
              {copy.cancel}
            </Button>
          </div>
        </div>
      )}

      {!settled && view === 'restore' && keyChosen === 'none' && (
        <p className="atum-security-lead" data-matrix-no-other-device>
          {approvalCopy.noOtherDeviceHelp}
        </p>
      )}

      {/* The key kept here stopped working: changed from another device or sign-in. */}
      {!settled && view === 'restore' && snapshot.security?.keyStale && (
        <NoticeBand data-matrix-key-stale role="status" tone="notice">
          {approvalCopy.keyStale}
        </NoticeBand>
      )}

      {!settled && view === 'restore' && (
        <form
          className={only === 'restore' ? 'flex flex-col gap-2' : 'flex items-center gap-2'}
          onSubmit={event => {
            event.preventDefault()
            // A key copied from a note or a web page may carry tabs or non-breaking spaces; the SDK only skips plain spaces.
            const value = key.replace(/\s+/g, ' ').trim()
            setKey('')
            run(() => window.atumMatrix.command({ kind: 'recoveryRestore', key: value }))
          }}
        >
          <Input
            aria-label={copy.key}
            autoComplete="off"
            autoFocus
            className={
              only === 'restore'
                ? 'h-11 w-full rounded-[var(--atum-r-input)]'
                : 'atum-input atum-settings-field min-w-0 flex-1'
            }
            disabled={disabled}
            onChange={event => setKey(event.target.value)}
            placeholder={copy.key}
            type="password"
            value={key}
          />
          <Button
            className={only === 'restore' ? 'h-11 w-full rounded-[var(--atum-r-input)] text-[0.875rem]' : undefined}
            disabled={disabled || !key.trim()}
            size={only === 'restore' ? 'default' : 'sm'}
          >
            {copy.unlock}
          </Button>
          {/* With entering the key the only way on, there is no other step to go back to. */}
          {only !== 'restore' && (
            <Button
              onClick={() => {
                // A key typed and then abandoned is forgotten, as one that is sent is.
                setKey('')
                setMode('choose')
              }}
              size="sm"
              type="button"
              variant="text"
            >
              {copy.cancel}
            </Button>
          )}
        </form>
      )}

      {recovery === 'working' && (
        <div className="flex items-center gap-2 text-(--atum-ink-muted)" role="status">
          <Spinner className="size-4 animate-spin" />
          {copy.working}
        </div>
      )}
      {recovery === 'ready' && (
        <p className="text-(--atum-ink-muted)" role="status">
          {snapshot.security?.restored !== undefined ? copy.readyRestored : copy.readySetUp}
        </p>
      )}
      {error === 'create' ? (
        <NoticeBand tone="failure">{copy.createFailed}</NoticeBand>
      ) : (
        (error || recovery === 'failed') && <NoticeBand tone="failure">{copy.error}</NoticeBand>
      )}
    </div>
  )

  // Approving this Mac from another of the person's devices comes first on the recovery step,
  // with the key one quiet link away (device-approval.tsx).
  if (launch && approval?.role === 'request' && !keyChosen && recovery !== 'working' && recovery !== 'ready') {
    return (
      <div className="text-sm">
        <MatrixApprovalRequest
          approval={approval}
          onNoDevice={() => {
            setKeyChosen('none')
            setMode('restore')
          }}
          onUseKey={() => {
            setKeyChosen('key')
            setMode('restore')
          }}
        />
      </div>
    )
  }

  // A key this Mac keeps: Settings offers to write it down (made quietly here) or to show it
  // (the person's own), nothing else: this Mac already unlocks by itself.
  if (
    !launch &&
    (snapshot.security?.kept || snapshot.security?.custody === 'device') &&
    !snapshot.security?.keyStale &&
    recovery !== 'working'
  ) {
    return (
      <>
        <RecoveryRow snapshot={snapshot}>
          <RecoveryWriteDown mode={snapshot.security?.custody === 'device' ? 'write-down' : 'show'} />
        </RecoveryRow>
        <ICloudKeychainRow snapshot={snapshot} />
      </>
    )
  }

  // The wrapper never changes for one panel, so the steps inside keep their state.
  return launch ? (
    <div className="text-sm">{body}</div>
  ) : (
    <RecoveryRow actions={actionInRow && !settled && view === 'choose' ? chooseActions : undefined} snapshot={snapshot}>
      {body}
    </RecoveryRow>
  )
}

/** Asks the devices list to show one of the person's own devices (the title bar's reminder to
 * verify it, owner finding 1a): one-shot, read and cleared by the panel once that device's row
 * is on screen, with its Verify button focused. */
export const $matrixDeviceToShow = atom<string | null>(null)

/** "2 days ago", in the window's language. */
function seenAgo(at: number, locale: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((Math.min(at, now) - now) / 60_000)

  if (minutes > -60) {
    return format.format(minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)

  return hours > -24 ? format.format(hours, 'hour') : format.format(Math.round(hours / 24), 'day')
}

/**
 * Your devices, loaded when the row is shown: this Mac first, then the others by the name
 * each gave itself and when it was last active (never a raw ID), each with its
 * verification and (for your own) a way to sign it out in your account. Verifying someone
 * else's device and the account's device page wait under "More". A comparison started
 * here shows here, since Settings covers the chat.
 */
export function DevicesPanel({ snapshot }: { snapshot: MatrixSnapshot }) {
  const copy = useSecurityCopy()
  const people = useRosterCreateCopy()
  const { locale } = useI18n()
  const identity = snapshot.identity!
  const [devices, setDevices] = useState<MatrixDevice[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [other, setOther] = useState(false)
  const [target, setTarget] = useState('')
  const [otherDevices, setOtherDevices] = useState<MatrixDevice[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const toShow = useStore($matrixDeviceToShow)
  // The device the reminder asked for, marked in its row while this panel shows.
  const [shown, setShown] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const live = useRef(true)
  // Each read answers one request: an older answer never replaces a newer one.
  const ownRead = useRef(0)
  const otherRead = useRef(0)
  const ready = snapshot.state === 'ready'
  const disabled = pending || !ready

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  const run = (work: () => Promise<unknown>) => {
    setPending(true)
    setError(false)
    void work()
      .catch(() => live.current && setError(true))
      .finally(() => live.current && setPending(false))
  }

  const load = () => {
    const request = ++ownRead.current
    const current = () => live.current && request === ownRead.current
    setFailed(false)
    void window.atumMatrix
      .command({ kind: 'devices', userId: identity.userId })
      .then(rows => current() && setDevices(rows as MatrixDevice[]))
      .catch(() => current() && setFailed(true))
  }

  useEffect(() => {
    if (ready) {
      load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, identity.userId])

  const isThisMac = (device: MatrixDevice) => device.userId === identity.userId && device.deviceId === identity.deviceId

  // The reminder's device, once its row is here: brought into view with Verify focused. The ask
  // is spent either way; a device no longer listed (signed out meanwhile) just shows the list.
  useEffect(() => {
    if (!toShow || devices === null) {
      return
    }

    $matrixDeviceToShow.set(null)
    const element = rows.current.get(`${identity.userId}:${toShow}`)

    if (!element) {
      return
    }

    setShown(toShow)
    element.scrollIntoView?.({ block: 'center' })
    element.querySelector<HTMLButtonElement>('[data-matrix-device-verify]')?.focus({ preventScroll: true })
  }, [toShow, devices, identity.userId])

  const row = (device: MatrixDevice) => (
    <li
      className={`atum-settings-row${shown === device.deviceId && device.userId === identity.userId ? ' rounded-lg bg-(--atum-hover)' : ''}`}
      data-matrix-device-shown={shown === device.deviceId && device.userId === identity.userId ? '' : undefined}
      key={`${device.userId}:${device.deviceId}`}
      ref={element => {
        const key = `${device.userId}:${device.deviceId}`

        if (element) {
          rows.current.set(key, element)
        } else {
          rows.current.delete(key)
        }
      }}
    >
      <span className="atum-settings-row-text">
        <span className="atum-settings-row-title block truncate">
          {isThisMac(device) ? copy.current : (device.name ?? copy.otherDevice)}
        </span>
        <span className="atum-settings-row-help">
          {[
            device.verified ? copy.verified : isThisMac(device) ? copy.thisMacUnverified : copy.notVerified,
            !isThisMac(device) && device.lastSeenAt !== undefined ? copy.seen(seenAgo(device.lastSeenAt, locale)) : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {!isThisMac(device) && (
        <span className="atum-settings-row-control">
          {device.userId === identity.userId && (
            <Button
              disabled={disabled}
              onClick={() => run(() => window.atumMatrix.endDeviceSession(device.deviceId))}
              size="sm"
              variant="text"
            >
              {copy.revoke}
            </Button>
          )}
          {!device.verified && (
            <Button
              data-matrix-device-verify
              disabled={disabled}
              onClick={() =>
                run(() =>
                  window.atumMatrix.command({
                    kind: 'verificationStart',
                    userId: device.userId,
                    deviceId: device.deviceId
                  })
                )
              }
              size="sm"
              variant="secondary"
            >
              {copy.verify}
            </Button>
          )}
        </span>
      )}
    </li>
  )

  /** Someone else's devices, found by their @name (never a raw address); one answer per ask. */
  const showTheirs = (userId: string) =>
    run(async () => {
      const request = ++otherRead.current

      const rows = (await window.atumMatrix.command({
        kind: 'devices',
        userId
      })) as MatrixDevice[]

      // The search changed while this answer was on its way: it belongs to someone else now.
      if (live.current && request === otherRead.current) {
        setOtherDevices(rows)
      }
    })

  const ordered = devices ? [...devices].sort((a, b) => Number(isThisMac(b)) - Number(isThisMac(a))) : null

  // A section of its own: this Mac first, then the others by name, each a row with its own
  // sign-out; verifying someone else waits under "More".
  return (
    <SettingsSection
      before={<VerificationPrompt snapshot={snapshot} />}
      data-matrix-devices
      foot={copy.manageHelp}
      help={copy.devicesLead}
      title={copy.devicesTitle}
    >
      {ordered === null && !failed && (
        <div className="atum-settings-row">
          <Spinner className="size-5 animate-spin text-(--atum-ink-muted)" label={copy.loading} />
        </div>
      )}
      {failed && (
        <SettingsRow
          className="atum-settings-row-quiet"
          control={
            <Button onClick={load} size="sm" variant="secondary">
              {copy.retry}
            </Button>
          }
          role="status"
          title={copy.devicesFailed}
        />
      )}
      {ordered && <ul className="atum-settings-item">{ordered.map(row)}</ul>}
      {error && (
        <div className="atum-settings-item">
          <NoticeBand tone="failure">{copy.error}</NoticeBand>
        </div>
      )}
      <details data-matrix-devices-more>
        <summary>{copy.more}</summary>
        <div className="atum-settings-rows">
          {other ? (
            <div className="atum-settings-item px-3.5 py-3">
              <PersonSearch
                autoFocus
                disabled={disabled}
                label={people.handleLabel}
                offer={person => ({ label: copy.devices, onSelect: () => showTheirs(person.userId), disabled })}
                onQueryChange={value => {
                  otherRead.current += 1
                  setTarget(value)
                  setOtherDevices([])
                }}
                placeholder={people.handlePlaceholder}
                query={target}
                snapshot={snapshot}
              />
              {otherDevices.length > 0 && <ul className="atum-settings-device-list">{otherDevices.map(row)}</ul>}
            </div>
          ) : (
            <SettingsLinkRow onClick={() => setOther(true)}>{copy.someoneElse}</SettingsLinkRow>
          )}
        </div>
      </details>
    </SettingsSection>
  )
}
