import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import { type MatrixAliasCopy, matrixAliasCopy } from '../../shared/matrix-alias-copy'
import type {
  MatrixAliasAssignment,
  MatrixAliasBridge,
  MatrixAliasChange,
  MatrixAliasErrorCode,
  MatrixAliasResult
} from '../../shared/matrix-aliases'

import {
  foldMatrixHandle,
  localMatrixHandleProblem,
  MATRIX_AGENT_STEM_MAX,
  matrixAgentHandleFromStem,
  matrixAgentHandleStem,
  matrixHandleCheckProblem,
  matrixHandleFailure,
  matrixHandleNextChange,
  type MatrixHandleProblem,
  typedMatrixAgentHandleStem
} from './handle-rules'
import { rememberOwnMatrixHandle } from './person-handles'
import { SettingsRow, SettingsStatus } from './settings-row'

/** A request that never reached main reads as the directory being unreachable. */
const unreachable = (): MatrixAliasResult => ({ ok: false, error: 'unavailable' })

/** How long typing must pause before the directory is asked (each ask counts, 0177). */
export const MATRIX_HANDLE_CHECK_PAUSE_MS = 600

export interface MatrixHandleEditorProps {
  bridge: MatrixAliasBridge
  /** The assistant whose handle this is; none for the signed-in person. */
  assistantId?: string
  /** Who it is for, in a confirmation ("Alfred"); unused for the person. */
  name: string
  /** Offered in the field when there is no handle yet (an assistant's name, as tiep_thi_bot). */
  suggestion?: string
  /** Names a recovered change that was for another assistant. */
  names?: ReadonlyArray<{ assistantId?: string; name?: string | null }>
  disabled?: boolean
  /** After the directory confirms a new handle (and the one it replaced, if any). */
  onChanged?(handle: string, previous: string | null): void
}

interface Failure {
  code: MatrixAliasErrorCode
  retryAfterSeconds?: number
  /** A rename's 429 is its 30-day wait, not a check budget. */
  rename?: boolean
}

type Checked = { handle: string; problem: MatrixHandleProblem | null }

function failureText(failure: Failure, copy: MatrixAliasCopy, locale: string): string {
  if (failure.code === 'limit' && failure.rename && failure.retryAfterSeconds) {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
      matrixHandleNextChange(failure.retryAfterSeconds)
    )

    return copy.tooSoon(date)
  }

  return copy[matrixHandleFailure(failure.code)]
}

/**
 * One person's or assistant's public handle: what it is now, and a field to choose or change
 * it (Settings › Account and the assistant card). An assistant's field holds only the part before
 * its fixed `_bot` ending (shown after the field), read the way a name is ("Tiếp thị" →
 * tiep_thi), and says the 30-day rule only when there is a handle to change. The field checks a
 * well-formed handle once typing pauses; Save asks to confirm, then claims a first handle or renames from the one shown.
 * A change whose answer was lost stays with main and is offered again with its request id.
 * Remount per account and target: every cached answer belongs to one of each.
 */
export function MatrixHandleEditor({
  assistantId,
  bridge,
  disabled,
  name,
  names,
  onChanged,
  suggestion
}: MatrixHandleEditorProps) {
  const { locale } = useI18n()
  const copy = matrixAliasCopy(locale)
  const fieldId = useId()
  const hintId = useId()
  const kind = assistantId ? 'agent' : 'person'
  const [alias, setAlias] = useState<MatrixAliasAssignment | null>()
  const [pending, setPending] = useState<MatrixAliasChange | null>()
  const [readFailed, setReadFailed] = useState(true)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState('')
  const [checked, setChecked] = useState<Checked>()
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<Failure>()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirm, setConfirm] = useState<MatrixAliasChange>()
  const lifetime = useRef(0)
  const attempt = useRef(0)
  const inputVersion = useRef(0)
  const inFlight = useRef(false)

  // An assistant's field holds the part before `_bot`; the directory is asked about the whole.
  // Its text stays as typed (spaces, Telex composition); the stem is read from it.
  const folded =
    kind === 'agent' ? matrixAgentHandleFromStem(typedMatrixAgentHandleStem(raw)) : foldMatrixHandle(raw)

  const local = folded ? localMatrixHandleProblem(folded, kind) : null
  const unchanged = Boolean(alias && folded === alias.handle)

  const refresh = useCallback(async () => {
    const scope = lifetime.current
    const revision = ++attempt.current
    setLoading(true)
    setFailure(undefined)

    const [current, journal] = await Promise.all([
      bridge
        .request({ action: 'current', ...(assistantId ? { assistantId } : {}) })
        .catch(() => ({ ok: false as const, error: 'unavailable' as const })),
      bridge.pending().catch(() => ({ ok: false as const, error: 'unavailable' as const }))
    ])

    if (lifetime.current !== scope || attempt.current !== revision) {
      return
    }

    const read = current.ok && current.value.kind === 'current' ? current.value.alias : undefined

    if (read !== undefined) {
      setAlias(read)

      // The person's own handle (not an assistant's) shows beside their name everywhere.
      if (!assistantId) {
        rememberOwnMatrixHandle(read?.handle ?? null)
      }
    } else {
      // A failed read is never "no handle": the field stays closed until it succeeds.
      setFailure({ code: current.ok ? 'unavailable' : current.error })
    }

    if (journal.ok) {
      setPending(journal.request)
    } else {
      setFailure({ code: journal.error })
    }

    setReadFailed(read === undefined || !journal.ok)
    setLoading(false)
  }, [assistantId, bridge])

  useEffect(() => {
    const scopeRef = lifetime
    const revisionRef = attempt
    void refresh()

    return () => {
      scopeRef.current++
      revisionRef.current++
    }
  }, [refresh])

  // Ask the directory once typing pauses, and only about a well-formed, new handle.
  useEffect(() => {
    if (!editing || !folded || local || unchanged) {
      return
    }

    const scope = lifetime.current
    const version = inputVersion.current

    const timer = setTimeout(() => {
      setChecking(true)
      void bridge
        .request({ action: 'check', handle: folded, ...(assistantId ? { assistantId } : {}) })
        .catch(unreachable)
        .then(result => {
          if (lifetime.current !== scope || inputVersion.current !== version) {
            return
          }

          setChecking(false)

          if (result.ok && result.value.kind === 'check' && result.value.handle === folded) {
            setChecked({ handle: folded, problem: matrixHandleCheckProblem(result.value.code) })
          } else {
            setFailure(
              result.ok ? { code: 'unavailable' } : { code: result.error, retryAfterSeconds: result.retryAfterSeconds }
            )
          }
        })
    }, MATRIX_HANDLE_CHECK_PAUSE_MS)

    return () => clearTimeout(timer)
  }, [assistantId, bridge, editing, folded, local, unchanged])

  const startEditing = () => {
    inputVersion.current++
    const start = alias ? alias.handle : (suggestion ?? '')
    setRaw(kind === 'agent' ? matrixAgentHandleStem(start) : start)
    setChecked(undefined)
    setFailure(undefined)
    setSaved(false)
    setEditing(true)
  }

  const stopEditing = () => {
    inputVersion.current++
    setEditing(false)
    setRaw('')
    setChecked(undefined)
    setChecking(false)
    setFailure(undefined)
  }

  /** Sends one change; throws (keeping the confirmation open) with what went wrong. */
  async function send(change: MatrixAliasChange) {
    if (inFlight.current) {
      return
    }

    const scope = lifetime.current
    inFlight.current = true
    setBusy(true)
    setPending(change)
    setFailure(undefined)
    let refused: Failure | undefined

    try {
      const result = await bridge.request(change).catch(unreachable)

      if (lifetime.current !== scope) {
        return
      }

      // Re-read: a recovered change can be for another assistant, and a refusal may mean the
      // handle moved since it was shown.
      await refresh()

      if (lifetime.current !== scope) {
        return
      }

      if (result.ok && (result.value.kind === 'claim' || result.value.kind === 'rename')) {
        const previous = result.value.kind === 'rename' ? result.value.previous : null

        if ((change.assistantId ?? undefined) === assistantId) {
          setSaved(true)
          stopEditing()
        }

        onChanged?.(result.value.handle, previous)
      } else {
        refused = result.ok
          ? { code: 'unavailable' }
          : { code: result.error, retryAfterSeconds: result.retryAfterSeconds, rename: change.action === 'rename' }
        setFailure(refused)
      }
    } finally {
      inFlight.current = false

      if (lifetime.current === scope) {
        setBusy(false)
      }
    }

    if (refused && lifetime.current === scope) {
      throw new Error(failureText(refused, copy, locale))
    }
  }

  const problem = local ?? (checked?.handle === folded ? checked.problem : null)
  const available = Boolean(checked && checked.handle === folded && checked.problem === null && !local)
  const ready = !loading && !busy && !readFailed && pending === null && !disabled
  const canSave = ready && editing && available && !unchanged

  const pendingName = pending
    ? pending.assistantId
      ? (names?.find(each => each.assistantId === pending.assistantId)?.name ?? copy.assistant)
      : copy.person
    : ''

  const status =
    !editing || !folded
      ? undefined
      : unchanged
        ? copy.current
        : problem
          ? copy[problem]
          : available
            ? copy.available(folded)
            : !failure && (checking || !checked || checked.handle !== folded)
              ? copy.checking
              : undefined

  const ask = () => {
    if (!checked || !canSave) {
      return
    }

    const target = assistantId ? { assistantId } : {}

    setConfirm(
      alias
        ? {
            action: 'rename',
            handle: checked.handle,
            from: alias.handle,
            requestId: globalThis.crypto.randomUUID(),
            ...target
          }
        : { action: 'claim', handle: checked.handle, requestId: globalThis.crypto.randomUUID(), ...target }
    )
  }

  const confirmation = confirm
    ? confirm.action === 'rename'
      ? assistantId
        ? copy.renameTextAgent(confirm.from, confirm.handle, name)
        : copy.renameTextSelf(confirm.from, confirm.handle)
      : assistantId
        ? copy.claimTextAgent(confirm.handle, name)
        : copy.claimTextSelf(confirm.handle)
    : undefined

  // An assistant's handle has its own words ("Tên bot"), so its card never shows two labels for
  // one thing; the 30-day rule is said only when there is a handle to change.
  const agentWords = kind === 'agent'
  const fieldLabel = agentWords ? copy.botName : copy.handle
  const rule = agentWords && !alias ? undefined : copy.rule

  return (
    <>
      {alias === undefined && loading && (
        <SettingsRow className="atum-settings-row-quiet" role="status" title={copy.loading} />
      )}
      {alias !== undefined && !editing && (
        <SettingsRow
          className={alias ? undefined : 'atum-settings-row-quiet'}
          control={
            <span className="flex items-center gap-2">
              {alias && (
                <SettingsStatus data-matrix-handle done={saved || undefined}>
                  @{alias.handle}
                </SettingsStatus>
              )}
              <Button data-matrix-handle-edit disabled={!ready} onClick={startEditing} size="sm" variant="secondary">
                {alias ? copy.change : agentWords ? copy.botChoose : copy.choose}
              </Button>
            </span>
          }
          help={saved ? copy.saved : undefined}
          title={agentWords ? (alias ? copy.botCurrent : copy.botNone) : alias ? copy.assigned : copy.none}
        />
      )}
      {editing && (
        <div className="atum-settings-row" data-matrix-handle-field>
          <label className="sr-only" htmlFor={fieldId}>
            {fieldLabel}
          </label>
          <Input
            aria-describedby={hintId}
            aria-invalid={problem ? true : undefined}
            autoFocus
            containerClassName="atum-input atum-settings-field min-w-0 flex-1"
            disabled={busy}
            id={fieldId}
            maxLength={agentWords ? MATRIX_AGENT_STEM_MAX + 8 : 33}
            onBlur={agentWords ? () => setRaw(typedMatrixAgentHandleStem) : undefined}
            onChange={event => {
              inputVersion.current++
              setRaw(event.target.value)
              setChecking(false)
              setFailure(undefined)
              setConfirm(undefined)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                ask()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                stopEditing()
              }
            }}
            placeholder={agentWords ? matrixAgentHandleStem(suggestion ?? '') || copy.botName : copy.handle}
            prefix="@"
            suffix={agentWords ? '_bot' : undefined}
            value={raw}
          />
          <Button disabled={busy} onClick={stopEditing} size="sm" variant="text">
            {copy.cancel}
          </Button>
          <Button data-matrix-handle-save disabled={!canSave} onClick={ask} size="sm">
            {copy.save}
          </Button>
        </div>
      )}
      {editing && (
        <p
          aria-live="polite"
          className="atum-settings-row-help px-3 pb-2"
          data-matrix-handle-status={problem ?? (available ? 'available' : undefined)}
          id={hintId}
          role="status"
        >
          {status ?? rule}
        </p>
      )}
      {failure && (
        <SettingsRow
          className="atum-settings-row-quiet"
          control={
            <Button disabled={busy || loading} onClick={() => void refresh()} size="sm" variant="secondary">
              {copy.refresh}
            </Button>
          }
          data-error-code={failure.code}
          role="alert"
          title={failureText(failure, copy, locale)}
        />
      )}
      {pending && (
        <SettingsRow
          className="atum-settings-row-quiet"
          control={
            <Button
              disabled={busy || loading || readFailed}
              onClick={() => void send(pending).catch(() => {})}
              size="sm"
              variant="secondary"
            >
              {copy.retry}
            </Button>
          }
          help={`${copy.target}: ${pendingName} · @${pending.handle}`}
          title={copy.pending}
        />
      )}
      <ConfirmDialog
        confirmLabel={confirm?.action === 'rename' ? copy.renameConfirm : copy.claimConfirm}
        description={confirmation}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => (confirm ? send(confirm) : undefined)}
        open={Boolean(confirm)}
        title={confirm?.action === 'rename' ? copy.renameTitle : copy.claimTitle}
      />
    </>
  )
}
