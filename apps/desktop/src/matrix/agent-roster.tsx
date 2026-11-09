import { useEffect, useMemo, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { ATUM_AVATAR_ACCEPT } from '@/lib/atum-avatar'
import { ChevronRight, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'
import { matrixAliasCopy } from '../../shared/matrix-alias-copy'
import type { MatrixAliasBridge, MatrixAliasResult } from '../../shared/matrix-aliases'
import { checkAssistantName } from '../../shared/matrix-assistant-name'
import type { MatrixHandleSheetDiagnostic } from '../../shared/matrix-handle-diagnostic'

import { noteMatrixAgentHandleSheetClaim } from './agent-handle-backfill'
import { claimMatrixAgentHandle, matrixAgentHandleRetryable } from './agent-handle-claim'
import { useAssistantCardCopy } from './assistant-card/copy'
import { photoPreviewUrl, type PreparedPhoto } from './assistant-card/photo'
import { PhotoCropDialog } from './assistant-card/photo-crop'
import { MATRIX_HANDLE_CHECK_PAUSE_MS } from './handle-editor'
import {
  localMatrixHandleProblem,
  MATRIX_AGENT_STEM_MAX,
  matrixAgentHandleCandidates,
  matrixAgentHandleFromStem,
  matrixAgentHandleStem,
  matrixHandleCheckProblem,
  type MatrixHandleProblem,
  numberedMatrixAgentHandle,
  suggestMatrixAgentHandle,
  typedMatrixAgentHandleStem
} from './handle-rules'
import { assistantPersona } from './people'
import { useRosterCreateCopy } from './roster-create-copy'
import { runMatrixCommand } from './text-document-actions'

/** What an agent's row says about it, when not simply ready. One agent's trouble shows on its
 * own row and never blocks another's composer (per-agent runtime plan §2.8, review B12). */
export function agentStatus(agent: MatrixAgentView): 'agentSettingUp' | 'agentUnavailable' | undefined {
  // A cloud-only assistant has no local setup to finish or fail: the cloud answers it.
  if (matrixAgentAnswersInCloud(agent)) {
    return undefined
  }

  if (
    agent.setup === 'failed' ||
    agent.setup === 'action_required' ||
    agent.readiness?.phase === 'blocked' ||
    agent.readiness?.phase === 'degraded'
  ) {
    return 'agentUnavailable'
  }

  return agent.setup === 'working' || agent.readiness?.phase !== 'ready' ? 'agentSettingUp' : undefined
}

/** Retiring is final, and the confirmation says so. */
export function RetireAgent({
  agent,
  name,
  onClose,
  onCloseAutoFocus,
  open
}: {
  agent: MatrixAgentView
  name: string
  onClose(): void
  onCloseAutoFocus?(event: Event): void
  open: boolean
}) {
  const { t } = useI18n()
  const shell = t.matrixShell

  return (
    <ConfirmDialog
      cancelLabel={shell.agentCancel}
      confirmLabel={shell.agentRetireConfirm}
      description={shell.agentRetireBody(name)}
      destructive
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      onConfirm={async () => {
        try {
          await window.atumMatrix.retireAgent(agent.principal)
        } catch {
          // Main never relays a server's error text.
          throw new Error(shell.agentRetireFailed)
        }
      }}
      open={open}
      title={shell.agentRetireTitle(name)}
    />
  )
}

/** The way to grow the assistants list: a real button under it, as in the old app (an
 * affordance, not a row, so it is never mistaken for an assistant with nobody in it). */
export function NewAssistantButton({ disabled, onClick }: { disabled?: boolean; onClick(): void }) {
  const { t } = useI18n()

  return (
    <div className="pt-0.5" data-atum-agents-foot>
      <button
        className="atum-row mt-2 flex h-9 w-full items-center gap-2.5 bg-(--atum-sunk) px-2.5 text-left text-[0.84375rem] font-medium text-(--atum-ink-muted) hover:text-(--atum-ink) disabled:opacity-45 disabled:hover:text-(--atum-ink-muted)"
        data-atum-create-agent
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <Plus aria-hidden className="size-[1.0625rem] shrink-0" strokeWidth={1.6} />
        <span className="min-w-0 flex-1 truncate">{t.matrixShell.newAgent}</span>
      </button>
    </div>
  )
}

/** Each field's longest answer: two of them, with headings, stay well inside the 64 KiB a
 * persona may be (`createAgent` in main), in any script. */
const ANSWER_MAX = 8_000

/** The assistant the sheet made, and the handle it should get, as both were at Create. */
interface CreatedAssistant {
  principal: string
  name: string
  assistantId?: string
  handle: {
    /** The part before `_bot` the field showed, when usable; otherwise the name's candidates. */
    stem?: string
    source: MatrixHandleSheetDiagnostic['source']
    check: MatrixHandleSheetDiagnostic['check']
  }
}

/** What the directory last said about the handle the field shows. */
type HandleCheck = { handle: string; problem: MatrixHandleProblem | null } | { handle: string; problem: 'failed' }

/** A check that never reached main reads as the directory being unreachable. */
const unreachable = (): MatrixAliasResult => ({ ok: false, error: 'unavailable' })

function handleCheckState(
  full: string,
  local: MatrixHandleProblem | null,
  checked: HandleCheck | undefined
): MatrixHandleSheetDiagnostic['check'] {
  if (local) {
    return 'invalid'
  }

  const problem = checked?.handle === full ? checked.problem : undefined

  return problem === null
    ? 'available'
    : problem === 'unavailable'
      ? 'taken'
      : problem === 'reserved'
        ? 'reserved'
        : problem === 'invalid' || problem === 'botRequired' || problem === 'botReserved'
          ? 'invalid'
          : 'unchecked'
}

function sendHandleDiagnostic(bridge: MatrixAliasBridge | undefined, line: MatrixHandleSheetDiagnostic) {
  try {
    bridge?.diagnostic?.(line)
  } catch {
    // Diagnostics only.
  }
}

/**
 * Another assistant, in one sheet: its display name (the one answer it needs) and its bot
 * handle, then, if wanted, its face, who they are and what they do. The handle field is filled
 * from the name ("Tiếp thị" → @tiep_thi_bot) and follows it until the person changes it; it is
 * checked as typing pauses, a taken one offers the same with a short number, and it is claimed
 * once the assistant exists. The handle never holds up creating the assistant: an empty, unusable
 * or taken one falls back to the name's own candidates. Everything else is defaulted: Atum's
 * model; its card changes any of it later. Create makes it, gives it the chosen photo
 * and opens its one conversation; no second sheet follows (the card used to, for the photo).
 * Importing a prepared profile is an advanced path, folded away.
 *
 * The draft and the creation live here, outside the dialog's content: dismissing it while
 * it works neither drops the new assistant nor lets a reopened sheet start a second one. A
 * photo is uploaded only once the assistant exists, and one that does not save never replays
 * the creation: the sheet keeps the assistant it made and retries only the photo.
 */
export function NewAssistantDialog({
  agents,
  apps,
  onCreated,
  onOpenChange,
  open,
  ready
}: {
  /** The owner's assistants, so a second "Lan" is refused before anything is created. */
  agents?: readonly MatrixAgentView[]
  /** The names the catalog's apps go by (`appCatalogNames`), so nobody is called what an app is. */
  apps?: readonly string[]
  /** The new assistant exists and is ready (its room, when local, was just selected). */
  onCreated?(): void
  onOpenChange(open: boolean): void
  open: boolean
  ready: boolean
}) {
  const { locale, t } = useI18n()
  const shell = t.matrixShell
  const sheet = t.atum.agents
  const copy = useRosterCreateCopy()
  const cardCopy = useAssistantCardCopy()
  const handleCopy = matrixAliasCopy(locale)
  // Photos are owner-authenticated canonical agent state; no agent host is required.
  const assistants = window.atumMatrix?.assistants
  const aliases = window.atumMatrix?.aliases
  const [name, setName] = useState('')
  // The handle field's text as typed, once the person has changed it; until then it follows the
  // name. Kept as typed so spaces and Telex composition survive; the stem is read from it.
  const [typedRaw, setTypedRaw] = useState<string>()
  const [stemSource, setStemSource] = useState<'typed' | 'suggested'>('typed')
  const [handleCheck, setHandleCheck] = useState<HandleCheck>()
  const [who, setWho] = useState('')
  const [job, setJob] = useState('')
  const [photo, setPhoto] = useState<{ prepared: PreparedPhoto; preview: string }>()
  const [cropFile, setCropFile] = useState<File>()
  const [advanced, setAdvanced] = useState(false)
  const [pending, setPending] = useState<'create' | 'handle' | 'photo'>()
  const [failed, setFailed] = useState(false)
  const [refused, setRefused] = useState<'account' | 'limit' | 'name' | 'short'>()
  // The hire the platform asks for before it makes the third+ assistant: its monthly Proton price.
  const [hireRequired, setHireRequired] = useState<number>()
  const [hireImporting, setHireImporting] = useState(false)
  // The card's own reason for a name the rules refuse here (reserved, taken, unshowable).
  const [nameProblem, setNameProblem] = useState<string>()
  // The assistant this sheet made while its photo is still to save: a retry finishes it.
  const [created, setCreated] = useState<CreatedAssistant>()
  const [handleFailed, setHandleFailed] = useState<string>()
  const [photoFailed, setPhotoFailed] = useState(false)
  const lifetime = useRef(true)
  const shown = useRef(open)
  const photoInput = useRef<HTMLInputElement>(null)

  shown.current = open

  useEffect(() => {
    lifetime.current = true

    return () => {
      lifetime.current = false
    }
  }, [])

  const derivedStem = matrixAgentHandleStem(suggestMatrixAgentHandle(name))
  const typedStem = typedRaw === undefined ? undefined : typedMatrixAgentHandleStem(typedRaw)
  const stem = typedStem ?? derivedStem
  const fullHandle = matrixAgentHandleFromStem(stem)
  const localHandleProblem = fullHandle ? localMatrixHandleProblem(fullHandle, 'agent') : null

  // The directory answers for "an assistant of this account", so any of the owner's assistants
  // can ask before the new one exists; the platform checks again when the handle is claimed.
  const checker =
    (agents ?? []).find(each => each.isDefault && each.assistantId)?.assistantId ??
    (agents ?? []).find(each => each.assistantId)?.assistantId

  const handleLocked = Boolean(pending || created)

  // Ask once typing pauses, and only about a well-formed handle.
  useEffect(() => {
    if (!open || !aliases || !checker || handleLocked || !fullHandle || localHandleProblem) {
      return
    }

    let current = true

    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => aliases.request({ action: 'check', handle: fullHandle, assistantId: checker }))
        .catch(unreachable)
        .then(result => {
          if (!current || !lifetime.current) {
            return
          }

          setHandleCheck(
            result.ok && result.value.kind === 'check' && result.value.handle === fullHandle
              ? { handle: fullHandle, problem: matrixHandleCheckProblem(result.value.code) }
              : { handle: fullHandle, problem: 'failed' }
          )
        })
    }, MATRIX_HANDLE_CHECK_PAUSE_MS)

    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [aliases, checker, fullHandle, handleLocked, localHandleProblem, open])

  const refusal = {
    account: shell.agentAccountRefused,
    limit: shell.agentLimitRefused,
    name: shell.agentNameRefused,
    short: shell.agentHireShort
  }

  const reset = () => {
    setName('')
    setTypedRaw(undefined)
    setStemSource('typed')
    setHandleCheck(undefined)
    setWho('')
    setJob('')
    setPhoto(undefined)
    setCropFile(undefined)
    setAdvanced(false)
    setFailed(false)
    setRefused(undefined)
    setHireRequired(undefined)
    setHireImporting(false)
    setNameProblem(undefined)
    setCreated(undefined)
    setHandleFailed(undefined)
    setPhotoFailed(false)
  }

  /** The next sheet starts empty. One dismissed meanwhile stays shut, and never closes
   * whichever creation dialog took its place. */
  const finish = () => {
    reset()

    if (shown.current) {
      onOpenChange(false)
    }
  }

  const changeOpen = (next: boolean) => {
    // Closing after the assistant exists is done with it: its card can add the photo later.
    if (!next && created && !pending) {
      reset()
    }

    onOpenChange(next)
  }

  /** The made assistant's face, through the canonical owner path; a failure keeps the sheet open
   * with this assistant held, so Retry repeats only the photo. */
  const savePhoto = (agent: CreatedAssistant, prepared: PreparedPhoto) => {
    setCreated(agent)
    setPending('photo')
    setPhotoFailed(false)

    void assistants!.avatar({ principal: agent.principal, avatar: prepared })
      .then(result => {
        if (!result.ok) {throw new Error(result.error)}
        if (lifetime.current) {
          finish()
        }
      })
      .catch(() => {
        if (lifetime.current) {
          setPhotoFailed(true)
        }
      })
      .finally(() => {
        if (lifetime.current) {
          setPending(undefined)
        }
      })
  }

  /** A handle is part of making an assistant, not a setting the person has to discover later:
   * the one the field showed is claimed once the assistant exists (then its numbers, then the
   * name's own), so a refusal retries only the handle and never creates a twin. */
  const assignHandle = (agent: CreatedAssistant, prepared?: PreparedPhoto) => {
    const next = () => (prepared ? savePhoto(agent, prepared) : finish())

    const report = (outcome: MatrixHandleSheetDiagnostic['outcome']) =>
      sendHandleDiagnostic(aliases, { source: agent.handle.source, check: agent.handle.check, outcome })

    // No directory on this Mac, or an older native host that made the assistant without the
    // stable directory ID: the assistant is complete, and its card offers a handle later. This
    // path never creates a second assistant just to obtain an ID.
    if (!aliases || !agent.assistantId) {
      report('skipped')
      next()

      return
    }

    setCreated(agent)
    setPending('handle')
    setHandleFailed(undefined)

    const groups = matrixAgentHandleCandidates(agent.name, Math.random, agent.handle.stem)

    // This sheet claims this assistant's handle; the launch walk never races it.
    noteMatrixAgentHandleSheetClaim(agent.assistantId)

    void claimMatrixAgentHandle(aliases, agent.assistantId, groups)
      .catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
      .then(outcome => {
        if (outcome.ok) {
          report(outcome.handle === groups[0]?.[0] ? 'claimed' : 'claimed_other')
        } else {
          report(matrixAgentHandleRetryable(outcome) ? 'retry' : 'later')
        }

        if (!lifetime.current) {
          return
        }

        // Only a refusal that a Retry can change keeps the sheet. Handles not open yet, or every
        // handle tried taken or reserved: the assistant is complete, and its card offers a
        // handle later.
        if (!matrixAgentHandleRetryable(outcome)) {
          next()
        } else {
          setHandleFailed(copy.handleFailed(agent.name))
        }
      })
      .finally(() => {
        if (lifetime.current) {
          setPending(current => (current === 'handle' ? undefined : current))
        }
      })
  }

  const create = (importing = false, hireConfirmed = false) => {
    if (!ready || pending || created || !name.trim()) {
      return
    }

    // The card's rules for a name (one line, 1–40 characters, never one of Atum's own or a
    // look-alike, not one the owner already uses), checked before anything is created; the
    // platform checks again.
    const checked = checkAssistantName(name, {
      primary: false,
      principal: '',
      others: (agents ?? []).map(each => ({ principal: each.principal, name: each.name })),
      apps
    })

    if (checked.ok === false) {
      setFailed(false)
      setRefused(undefined)
      setNameProblem(cardCopy.problems[checked.problem](name.trim(), checked.char))

      return
    }

    const requestedName = checked.name
    // The photo and the handle as they were when Create was pressed. An empty or unusable
    // handle falls back to the name's own candidates rather than stopping the creation.
    const chosen = assistants ? photo?.prepared : undefined
    const usableStem = fullHandle && !localHandleProblem ? stem : undefined

    const handle: CreatedAssistant['handle'] = {
      stem: usableStem,
      source: typedStem === undefined || !usableStem ? 'derived' : stemSource,
      check: handleCheckState(fullHandle, localHandleProblem, handleCheck)
    }

    setPending('create')
    setFailed(false)
    setRefused(undefined)
    setNameProblem(undefined)

    // An import brings its own instructions; the answers here are never sent with it.
    const result = importing
      ? hireConfirmed
        ? window.atumMatrix.importAgent(requestedName, true)
        : window.atumMatrix.importAgent(requestedName)
      : hireConfirmed
        ? window.atumMatrix.createAgent(requestedName, assistantPersona(requestedName, who, job), true)
        : window.atumMatrix.createAgent(requestedName, assistantPersona(requestedName, who, job))

    void result
      .then(result => {
        if (!lifetime.current || 'cancelled' in result) {
          return
        }

        if ('refused' in result) {
          const reason = result.refused

          if (typeof reason === 'object' && 'hire' in reason) {
            setHireRequired(reason.hire)
            setHireImporting(importing)

            return
          }

          setRefused(reason)

          if (reason === 'short') {
            void window.atumMatrix.openTopUp()
          }

          return
        }

        // Its one conversation opens now; the sheet stays only while a chosen photo saves.
        // A cloud-placed assistant has no local room yet (the controller's is learned from the
        // roster later), so the list is where it appears, already ready.
        onCreated?.()

        if (result.roomId) {
          void runMatrixCommand({ kind: 'select', roomId: result.roomId }).catch(() => {})
        }

        assignHandle(
          { principal: result.principal, name: requestedName, assistantId: result.assistantId, handle },
          chosen
        )
      })
      .catch(() => {
        if (lifetime.current) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (lifetime.current) {
          setPending(current => (current === 'create' ? undefined : current))
        }
      })
  }

  const retryPhoto = () => {
    if (created && photo && !pending) {
      savePhoto(created, photo.prepared)
    }
  }

  const retryHandle = () => {
    if (created && !pending) {
      assignHandle(created, assistants ? photo?.prepared : undefined)
    }
  }

  const locked = Boolean(pending || created)
  const canCreate = ready && !locked && Boolean(name.trim())
  const retryingHandle = Boolean(created && handleFailed)
  const retryingPhoto = Boolean(created && photoFailed)
  const label = 'mb-1.5 block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)'
  const hint = 'text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)'
  const shownCheck = handleCheck?.handle === fullHandle ? handleCheck.problem : undefined
  // Offered only when the plain handle is taken: the same with a short number.
  const numbered = useMemo(() => (stem ? numberedMatrixAgentHandle(stem) : undefined), [stem])

  const handleStatus = !fullHandle
    ? undefined
    : localHandleProblem
      ? handleCopy[localHandleProblem]
      : shownCheck === null
        ? handleCopy.available(fullHandle)
        : shownCheck && shownCheck !== 'failed'
          ? handleCopy[shownCheck]
          : checker && shownCheck === undefined && !handleLocked
            ? handleCopy.checking
            : undefined

  return (
    <>
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent className="max-w-[27.5rem]" data-atum-agent-sheet>
        <DialogHeader>
          <DialogTitle>{shell.newAgent}</DialogTitle>
          <DialogDescription>{copy.assistantIntro}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          id="matrix-new-assistant"
          onSubmit={event => {
            event.preventDefault()

            if (retryingHandle) {
              retryHandle()
            } else if (retryingPhoto) {
              retryPhoto()
            } else {
              create()
            }
          }}
        >
          <div>
            <label className={label} htmlFor="matrix-new-assistant-name">
              {cardCopy.nameField}
            </label>
            <Input
              aria-describedby="matrix-new-assistant-name-help"
              autoFocus
              className="atum-input"
              disabled={locked}
              id="matrix-new-assistant-name"
              maxLength={40}
              onChange={event => {
                setName(event.target.value)
                setNameProblem(undefined)
              }}
              placeholder={sheet.namePlaceholder}
              required
              value={name}
            />
            <p className={cn(hint, 'mt-1')} id="matrix-new-assistant-name-help">
              {cardCopy.nameHelper}
            </p>
          </div>
          {aliases && (
            <div data-atum-agent-sheet-handle>
              <label className={label} htmlFor="matrix-new-assistant-handle">
                {handleCopy.botName}
              </label>
              <Input
                aria-describedby="matrix-new-assistant-handle-help matrix-new-assistant-handle-status"
                aria-invalid={localHandleProblem || (shownCheck && shownCheck !== 'failed') ? true : undefined}
                containerClassName="atum-input"
                disabled={locked}
                id="matrix-new-assistant-handle"
                maxLength={MATRIX_AGENT_STEM_MAX + 8}
                onBlur={() => setTypedRaw(raw => (raw === undefined ? raw : typedMatrixAgentHandleStem(raw)))}
                onChange={event => {
                  setTypedRaw(event.target.value)
                  setStemSource('typed')
                }}
                placeholder={derivedStem || undefined}
                prefix="@"
                suffix="_bot"
                value={typedRaw ?? derivedStem}
              />
              <p className={cn(hint, 'mt-1')} id="matrix-new-assistant-handle-help">
                {handleCopy.botNameHelp}
              </p>
              {handleStatus && (
                <p
                  aria-live="polite"
                  className={cn(hint, 'mt-0.5 flex flex-wrap items-center gap-x-1.5')}
                  data-atum-agent-sheet-handle-status={
                    localHandleProblem ?? (shownCheck === null ? 'available' : (shownCheck ?? undefined))
                  }
                  id="matrix-new-assistant-handle-status"
                  role="status"
                >
                  <span>{handleStatus}</span>
                  {shownCheck === 'unavailable' && numbered && !locked && (
                    <Button
                      onClick={() => {
                        setTypedRaw(matrixAgentHandleStem(numbered))
                        setStemSource('suggested')
                      }}
                      size="inline"
                      type="button"
                      variant="textStrong"
                    >
                      {handleCopy.botTry(numbered)}
                    </Button>
                  )}
                </p>
              )}
            </div>
          )}
          {assistants && (
            // Its face beside the name it will go by: the initial follows what is typed until
            // a photo is chosen.
            <div className="flex items-center gap-3" data-atum-agent-sheet-photo>
              <AtumAssistantAvatar
                avatarUrl={photo?.preview}
                className="size-12 shrink-0 rounded-(--atum-r-avatar-lg) text-base"
                id="matrix-new-assistant"
                name={name}
              />
              <div className="min-w-0 space-y-1">
                <span className="block text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)">
                  {copy.photo}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    disabled={locked}
                    onClick={() => photoInput.current?.click()}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {photo ? copy.photoChange : copy.photoChoose}
                  </Button>
                  {photo && (
                    <Button
                      disabled={locked}
                      onClick={() => {
                        setPhoto(undefined)
                      }}
                      size="sm"
                      type="button"
                      variant="text"
                    >
                      {copy.photoRemove}
                    </Button>
                  )}
                </div>
              </div>
              <input
                accept={ATUM_AVATAR_ACCEPT}
                aria-hidden
                aria-label={copy.photo}
                className="sr-only"
                disabled={locked}
                onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''

                  if (file) {
                    setCropFile(file)
                  }
                }}
                ref={photoInput}
                tabIndex={-1}
                type="file"
              />
            </div>
          )}
          <div>
            <label className={label} htmlFor="matrix-new-assistant-who">
              {sheet.personaLabel}
            </label>
            <Textarea
              className="atum-input"
              disabled={locked}
              id="matrix-new-assistant-who"
              maxLength={ANSWER_MAX}
              onChange={event => setWho(event.target.value)}
              placeholder={sheet.personaPlaceholder}
              rows={2}
              spellCheck
              value={who}
            />
          </div>
          <div>
            <label className={label} htmlFor="matrix-new-assistant-job">
              {sheet.jobLabel}
            </label>
            <Textarea
              className="atum-input"
              disabled={locked}
              id="matrix-new-assistant-job"
              maxLength={ANSWER_MAX}
              onChange={event => setJob(event.target.value)}
              placeholder={sheet.jobPlaceholder}
              rows={3}
              spellCheck
              value={job}
            />
          </div>
          <div>
            <button
              aria-controls="matrix-new-assistant-advanced"
              aria-expanded={advanced}
              className="flex items-center gap-1 text-(length:--atum-t-caption) font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)"
              onClick={() => setAdvanced(value => !value)}
              type="button"
            >
              <ChevronRight
                aria-hidden
                className={cn('size-3.5 transition-transform motion-reduce:transition-none', advanced && 'rotate-90')}
              />
              {copy.advanced}
            </button>
            {advanced && (
              <div className="mt-2 space-y-1.5 ps-[1.125rem]" id="matrix-new-assistant-advanced">
                <Button disabled={!canCreate} onClick={() => create(true)} size="sm" type="button" variant="secondary">
                  {shell.agentImport}
                </Button>
                <p className="text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                  {shell.agentImportHelp}
                </p>
              </div>
            )}
          </div>
          {pending && (
            <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)" role="status">
              {pending === 'photo' ? copy.photoSaving : shell.agentCreating}
            </p>
          )}
          {(refused || nameProblem) && (
            <NoticeBand role="alert" tone="failure">
              {nameProblem ?? (refused ? refusal[refused] : undefined)}
            </NoticeBand>
          )}
          {hireRequired !== undefined && !pending && (
            <NoticeBand role="alert" tone="notice">
              <strong>{shell.agentHireTitle}</strong> · {new Intl.NumberFormat(locale).format(hireRequired)} Protons / 30 days
              <div className="mt-2 flex gap-2">
                <button onClick={() => create(hireImporting, true)} type="button">{shell.agentHireConfirm}</button>
                <button onClick={() => {
                  setHireRequired(undefined)
                  setHireImporting(false)
                }} type="button">{shell.agentHireLater}</button>
              </div>
            </NoticeBand>
          )}
          {failed && (
            <NoticeBand role="alert" tone="failure">
              {shell.agentCreateFailed}
            </NoticeBand>
          )}
          {handleFailed && (
            <NoticeBand role="alert" tone="failure">
              {handleFailed}
            </NoticeBand>
          )}
          {retryingPhoto && (
            <NoticeBand role="alert" tone="failure">
              {copy.photoFailed(created!.name)}
            </NoticeBand>
          )}
        </form>
        <DialogFooter>
          <Button onClick={() => changeOpen(false)} type="button" variant="ghost">
            {created ? t.common.done : t.common.cancel}
          </Button>
          {/* One button that becomes Retry, so focus stays where the person pressed. */}
          <Button
            disabled={retryingHandle || retryingPhoto ? Boolean(pending) : !canCreate}
            form="matrix-new-assistant"
            type="submit"
          >
            {retryingHandle ? t.common.retry : retryingPhoto ? copy.photoRetry : shell.agentCreate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {cropFile && (
      <PhotoCropDialog
        file={cropFile}
        onCancel={() => setCropFile(undefined)}
        onConfirm={prepared => {
          setCropFile(undefined)
          setPhoto({
            prepared,
            preview: photoPreviewUrl(prepared)
          })
        }}
      />
    )}
    </>
  )
}
