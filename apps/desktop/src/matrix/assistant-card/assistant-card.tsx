import { type DragEvent, Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ATUM_AVATAR_ACCEPT } from '@/lib/atum-avatar'
import { AlertCircle, CalendarCheck, Check, ChevronRight, MessageCircle, PawPrint, PuzzlePiece, Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'

import contextFileLimits from '../../../../../hermes_cli/data/context-file-limits.json'
import { appCatalogNames } from '../../../shared/app-catalog'
import type { MatrixAgentView, MatrixSnapshot } from '../../../shared/matrix'
import { matrixAgentActions, matrixAgentAnswersInCloud, matrixAgentNeedsLocalSetup } from '../../../shared/matrix-agent-actions'
import type { MatrixAssistantCard, MatrixAssistantCardError } from '../../../shared/matrix-assistant-card'
import {
  type AssistantNameProblem,
  checkAssistantName,
  isAssistantNameLocked
} from '../../../shared/matrix-assistant-name'
import { type ParsedPersona, parsePersona, renderPersona } from '../../../shared/matrix-assistant-persona'
import { MatrixAgentHomeRow, MatrixAgentPlaceRow } from '../agent-home-control'
import { agentStatus, RetireAgent } from '../agent-roster'
import { changeMatrixCheckIns } from '../check-in-card'
import { matrixCheckInTime } from '../check-ins-copy'
import { MainAgentBadge } from '../main-agent-badge'
import { MatrixProfileAvatar } from '../profile-avatar'
import { matrixRosterAgentName } from '../roster-model'
import { SettingsSection } from '../settings-row'
import { $matrixStoreShelfRequest } from '../store/top-up'
import { runMatrixCommand } from '../text-document-actions'

import { AboutSection, type PersonaChange } from './about-section'
import type { AssistantCardControlSlots } from './agent-controls'
import { BackgroundSweepRow } from './background-sweep-row'
import { CardHandle, CardMenu, type CardPhotoActions, useAgentHandle } from './card-menu'
import { type AssistantCardCopy, useAssistantCardCopy } from './copy'
import { ModelDestinationsRow } from './model-destinations-row'
import { InlineNameField } from './name-field'
import type { PreparedPhoto } from './photo'
import { PhotoCropDialog } from './photo-crop'
import { RoutinesRow } from './routines-panel'
import { CardNotice, RowGlyph } from './row-glyph'
import { SkillsRow } from './skills-popover'
import { setAssistantNameOverride } from './store'

/** How long a "Saved · Undo" note stays (then it fades). */
export const ASSISTANT_CARD_NOTE_MS = 6_000

type NoteField = 'name' | PersonaChange['field'] | 'checkIns'

interface Note {
  field: NoteField
  kind: 'renamed' | 'saved' | 'undone'
  undo?: () => void
}

type CardPatch = { displayName: string } | { soul: string }
type CardWriteOutcome =
  | { kind: 'saved'; previous: MatrixAssistantCard; card: MatrixAssistantCard }
  | 'unchanged'
  | 'elsewhere'
  | MatrixAssistantCardError

function cardPersona(card: MatrixAssistantCard) {
  return parsePersona(card.soul, { inherited: card.inherited, primary: card.isDefault })
}

interface PersonaUndo {
  currentKind: ParsedPersona['kind']
  currentField: PersonaChange['field']
  previousKind: ParsedPersona['kind']
  inheritedSoul?: string
}

type Band = { kind: 'failure'; retry: () => void } | { kind: 'elsewhere'; field?: PersonaChange['field'] } | { kind: 'photo' }

function visibleField(persona: ParsedPersona, field: PersonaChange['field']): PersonaChange['field'] {
  return field === 'who' ? field : persona.kind === 'custom' ? 'instructions' : 'what'
}

const NAME_PROBLEMS: Partial<Record<MatrixAssistantCardError, AssistantNameProblem>> = {
  reserved: 'reserved',
  invalid: 'invalidChars',
  duplicate: 'duplicate'
}

/**
 * The assistant card (DESIGN.md › Assistant card): an assistant's own page, like a contact
 * card. Its face and name at the top (renamed where it stands), how it works, then its pet,
 * skills and check-ins; deleting it at the bottom. Every field saves when the person is done
 * with it and offers Undo; "Done" only closes.
 */
export function AssistantCard({
  agent,
  compact,
  controls,
  focusName,
  focusRoutines = false,
  lead,
  onClose,
  onMessage,
  placement = 'sheet',
  snapshot,
  trail
}: {
  agent: MatrixAgentView
  compact: boolean
  /** The panel's live controls for this chat, each placed in its section (notifications, devices, Pause). */
  controls?: AssistantCardControlSlots
  focusName: boolean
  /** What it is doing now, under its name; only while it works or waits (the panel's). */
  lead?: ReactNode
  /** Its files, after its rows (the panel's, only when there are some). */
  trail?: ReactNode
  /** The composer's "Add routines" lands on the panel itself, not one row further in. */
  focusRoutines?: boolean
  onClose(): void
  onMessage(): void
  /**
   * The sheet (its own Done and a Message pill) or Chat's right panel beside the assistant's chat,
   * where the panel's × closes it and Message would open the chat already open. Every row stays.
   */
  placement?: 'panel' | 'sheet'
  snapshot: MatrixSnapshot
}) {
  const copy = useAssistantCardCopy()
  const { locale, t } = useI18n()
  const bridge = window.atumMatrix.assistants
  const primary = agent.isDefault
  // Owner decision D1 (PRIMARY_ASSISTANT_KEEPS_NAME): whether this name can change at all.
  const nameLocked = isAssistantNameLocked(agent)
  const shownName = matrixRosterAgentName(agent, t.matrixShell.assistantName)
  const [card, setCard] = useState<MatrixAssistantCard>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [note, setNote] = useState<Note>()
  const [band, setBand] = useState<Band>()
  const [refusal, setRefusal] = useState<{ message: string; draft: string }>()
  const [retiring, setRetiring] = useState(false)
  const [editingName, setEditingName] = useState(false)
  // "Rename…" in the "…" menu opens the name field again each time (a new token).
  const [renameRequest, setRenameRequest] = useState(0)
  const [photo, setPhoto] = useState<CardPhotoActions>()
  const handle = useAgentHandle(agent, snapshot)
  const pet = useAgentPetName(agent, snapshot)
  const store = Boolean(snapshot.apps)
  const cardRef = useRef<MatrixAssistantCard | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const live = useRef(true)
  const offline = snapshot.state === 'offline'

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!bridge) {
      setLoadFailed(true)

      return
    }

    let current = true
    setLoadFailed(false)
    void bridge
      .read(agent.principal)
      .then(result => {
        if (!current) {
          return
        }

        if (result.ok) {
          cardRef.current = result.card
          setCard(result.card)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => current && setLoadFailed(true))

    return () => {
      current = false
    }
  }, [bridge, agent.principal, loadAttempt])

  // A note says its piece, then goes.
  useEffect(() => {
    if (!note) {
      return
    }

    const timer = setTimeout(() => setNote(undefined), ASSISTANT_CARD_NOTE_MS)

    return () => clearTimeout(timer)
  }, [note])

  /** Build the patch from the confirmed card at dispatch, and again after a revision conflict. */
  const write = useCallback(
    (prepare: (base: MatrixAssistantCard) => CardPatch | 'unchanged' | 'elsewhere') => {
      const confirm = (next: MatrixAssistantCard) => {
        cardRef.current = next

        if (live.current) {
          setCard(next)
        }
      }

      const run = async (attempt: number): Promise<CardWriteOutcome> => {
        const base = cardRef.current

        if (!bridge || !base) {
          return 'unavailable'
        }

        const patch = prepare(base)

        if (typeof patch === 'string') {
          return patch
        }

        const result = await bridge.save({
          principal: agent.principal,
          expectedDefinitionRevision: base.definitionRevision,
          expectedIdentityRevision: base.identityRevision,
          ...patch
        })

        if (result.ok) {
          confirm(result.card)

          return { kind: 'saved', previous: base, card: result.card }
        }

        if (result.error === 'conflict' && result.card) {
          confirm(result.card)

          if (attempt === 0) {
            return run(1)
          }

          const retry = prepare(result.card)

          return typeof retry === 'string' ? retry : 'conflict'
        }

        return result.error
      }

      const next = queue.current.then(() => run(0)).catch(() => 'unavailable' as const)
      queue.current = next

      return next
    },
    [agent.principal, bridge]
  )

  const others = useMemo(
    () => (snapshot.agents ?? []).map(each => ({ principal: each.principal, name: each.name })),
    [snapshot.agents]
  )

  // The names the catalog's apps go by: not an assistant's to take.
  const apps = useMemo(() => appCatalogNames(snapshot.apps?.apps), [snapshot.apps?.apps])

  const check = useCallback(
    (value: string) => checkAssistantName(value, { primary, principal: agent.principal, others, apps }),
    [agent.principal, apps, others, primary]
  )

  const rename = (next: string, undoing = false) => {
    const previous = cardRef.current?.displayName ?? shownName
    // Paint first: the header, the roster row and the chat header take the name at once.
    setAssistantNameOverride(agent.principal, next)
    setBand(undefined)
    setRefusal(undefined)

    void write(base => base.displayName === previous ? { displayName: next } : 'elsewhere').then(outcome => {
      if (!live.current) {
        return
      }

      if (typeof outcome !== 'string') {
        setNote(
          undoing
            ? { field: 'name', kind: 'undone' }
            : { field: 'name', kind: 'renamed', undo: () => rename(previous, true) }
        )

        return
      }

      // Rolled back, visibly.
      setAssistantNameOverride(agent.principal, undefined)
      const problem = NAME_PROBLEMS[outcome as MatrixAssistantCardError]

      if (problem) {
        setRefusal({ message: copy.problems[problem](next), draft: next })
      } else if (outcome === 'locked') {
        setRefusal({ message: copy.primaryTip, draft: next })
      } else if (outcome === 'elsewhere') {
        setBand({ kind: 'elsewhere' })
        setRefusal({ message: copy.changedElsewhere(cardRef.current?.displayName ?? previous), draft: next })
      } else {
        setBand({ kind: 'failure', retry: () => rename(next, undoing) })
      }
    })
  }

  const persona = useMemo(() => (card ? cardPersona(card) : undefined), [card])
  // Hermes counts Unicode code points after the file read normalizes newlines.
  const soul = card?.soul

  const longPersona = useMemo(() => {
    if (!soul || soul.length <= contextFileLimits.defaultMaxChars) {
      return false
    }

    return Array.from(soul.trim().replace(/\r\n?/g, '\n')).length > contextFileLimits.defaultMaxChars
  }, [soul])

  const savePersona = (change: PersonaChange, undo?: PersonaUndo) => {
    const { field, before, after } = change
    setBand(undefined)

    void write(base => {
      const current = cardPersona(base)

      const currentField = visibleField(current, field)

      if (field !== 'who' && (undo?.currentField ?? field) !== currentField) {
        return 'elsewhere'
      }

      const undoChangesKind = undo && undo.currentKind === current.kind && undo.previousKind !== current.kind

      if (!undoChangesKind && current[currentField].trim() === after.trim()) {
        return 'unchanged'
      }

      if (current[currentField].trim() !== before.trim()) {
        return 'elsewhere'
      }

      const parsed = undoChangesKind ? { ...current, kind: undo.previousKind } : current
      const rendered = renderPersona(parsed, { name: base.displayName, [field]: after })

      return { soul: rendered.trim() === undo?.inheritedSoul?.trim() ? '' : rendered }
    }).then(outcome => {
      if (!live.current) {
        return
      }

      if (typeof outcome !== 'string') {
        const saved = cardPersona(outcome.card)
        const savedField = visibleField(saved, field)

        if (undo) {
          setNote({ field: savedField, kind: 'undone' })

          return
        }

        const previous = cardPersona(outcome.previous)
        setNote({
          field: savedField,
          kind: 'saved',
          undo: () => savePersona(
            { field, before: saved[savedField], after: previous[field] },
            {
              currentKind: saved.kind,
              currentField: savedField,
              previousKind: previous.kind,
              ...(outcome.previous.inherited ? { inheritedSoul: outcome.previous.soul } : {})
            }
          )
        })
      } else if (outcome === 'elsewhere') {
        setNote(undefined)
        setBand({ kind: 'elsewhere', field: cardRef.current ? visibleField(cardPersona(cardRef.current), field) : field })
      } else if (outcome !== 'unchanged') {
        setBand({ kind: 'failure', retry: () => savePersona(change, undo) })
      }
    })
  }

  const noteLine = (field: NoteField) =>
    note?.field === field ? <CardNote copy={copy} note={note} onUndo={() => setNote(undefined)} /> : undefined

  const ready = snapshot.state === 'ready' && !offline
  const editable = Boolean(card) && ready && !nameLocked
  const status = agentStatus(agent)
  const name = shownName

  const openShelf = (shelf: 'pets' | 'skills') => {
    $matrixStoreShelfRequest.set(shelf)
    onClose()
    void runMatrixCommand({ kind: 'discoverApps' }).catch(() => $matrixStoreShelfRequest.set(null))
  }

  return (
    <>
      {placement === 'sheet' && (
        <div className="atum-card-top">
          <Button data-assistant-card-done onClick={onClose} variant="text">
            {copy.done}
          </Button>
        </div>
      )}
      <div className="atum-card-body" data-compact={compact || undefined} data-placement={placement}>
        <header className="atum-card-header" data-editing-name={editingName || undefined}>
          <CardMenu
            agent={agent}
            handle={{ editable: handle.editable, value: handle.handle }}
            name={name}
            onDelete={primary ? undefined : () => setRetiring(true)}
            onHandleChanged={next => handle.setHandle(next)}
            onPet={store ? () => openShelf('pets') : undefined}
            onRename={nameLocked || !editable ? undefined : () => setRenameRequest(value => value + 1)}
            pet={pet}
            photo={photo}
            ready={ready}
            snapshot={snapshot}
          />
          <CardAvatar
            agent={agent}
            compact={compact}
            copy={copy}
            key={`${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}/${agent.principal}`}
            name={name}
            onActions={setPhoto}
            onFailed={() => setBand({ kind: 'photo' })}
            snapshot={snapshot}
          />
          {nameLocked ? (
            <Tip label={copy.primaryTip}>
              <h2
                className="atum-card-name flex max-w-[22rem] items-center justify-center gap-1.5 px-2.5 text-center"
                tabIndex={0}
              >
                <span className="min-w-0 truncate">{name}</span>
                {primary && <MainAgentBadge tip={false} />}
              </h2>
            </Tip>
          ) : (
            <InlineNameField
              adornment={primary ? <MainAgentBadge tip={false} /> : undefined}
              check={check}
              editable={editable}
              key={agent.principal}
              name={name}
              onCommit={next => rename(next)}
              onEditingChange={setEditingName}
              refusal={refusal}
              startEditing={renameRequest || focusName}
            />
          )}
          <CardHandle handle={handle.handle} />
          {agent.title && <p className="atum-card-caption text-center" data-assistant-card-title>{agent.title}</p>}
          {noteLine('name')}
          {placement === 'sheet' && (
            <div className="atum-card-pills">
              <button className="atum-card-pill" data-assistant-card-message onClick={onMessage} type="button">
                <MessageCircle aria-hidden className="size-3.5" />
                {copy.message}
              </button>
            </div>
          )}
        </header>
        {band && (
          <NoticeBand
            role={band.kind === 'failure' || band.kind === 'photo' ? 'alert' : 'status'}
            tone={band.kind === 'elsewhere' ? 'notice' : 'failure'}
          >
            <span className="flex items-center gap-2" data-assistant-card-band={band.kind}>
              <span className="min-w-0 flex-1">
                {band.kind === 'failure'
                  ? copy.saveFailed
                  : band.kind === 'photo'
                    ? copy.photoError
                    : band.field ? copy.personaConflict : copy.changedElsewhere(name)}
              </span>
              {band.kind === 'failure' && (
                <Button onClick={band.retry} size="inline" variant="textStrong">
                  {copy.retry}
                </Button>
              )}
            </span>
          </NoticeBand>
        )}
        {offline && <p className="atum-card-caption text-center">{copy.offline}</p>}
        {lead}
        <CardStateNotice agent={agent} band={Boolean(band)} copy={copy} paused={controls?.paused} status={status} />
        <AboutSection
          disabled={!card || !ready}
          failed={
            loadFailed ? (
              <div className="atum-settings-group">
                <div className="atum-settings-row atum-settings-row-quiet">
                  <span className="atum-settings-row-text atum-settings-row-title">{copy.loadFailed(name)}</span>
                  <Button onClick={() => setLoadAttempt(value => value + 1)} size="inline" variant="textStrong">
                    {copy.retry}
                  </Button>
                </div>
              </div>
            ) : undefined
          }
          longPersona={longPersona}
          name={name}
          note={
            note && note.field !== 'name' && note.field !== 'checkIns'
              ? { field: note.field, node: <CardNote copy={copy} note={note} onUndo={() => setNote(undefined)} /> }
              : undefined
          }
          onSave={change => savePersona(change)}
          persona={persona ?? parsePersona('')}
          rejected={band?.kind === 'elsewhere' && band.field ? band : undefined}
        />
        <CardSections
          agent={agent}
          card={card}
          controls={controls}
          copy={copy}
          focusRoutines={focusRoutines}
          locale={locale}
          name={name}
          openShelf={openShelf}
          pet={pet}
          snapshot={snapshot}
        />
        {trail}
      </div>
      {!primary && <RetireAgent agent={agent} name={name} onClose={() => setRetiring(false)} open={retiring} />}
    </>
  )
}

/** "✓ Renamed · Undo": said politely, then gone. */
function CardNote({ copy, note, onUndo }: { copy: AssistantCardCopy; note: Note; onUndo(): void }) {
  return (
    <p className="atum-card-note" data-assistant-card-note={note.kind} role="status">
      {note.kind !== 'undone' && <Check aria-hidden className="size-3.5" strokeWidth={2.4} />}
      <span>{note.kind === 'renamed' ? copy.renamed : note.kind === 'saved' ? copy.saved : copy.undone}</span>
      {note.undo && (
        <>
          <span aria-hidden>·</span>
          <button
            className="atum-card-note-undo"
            onClick={() => {
              const undo = note.undo!
              onUndo()
              undo()
            }}
            type="button"
          >
            {copy.undo}
          </button>
        </>
      )}
    </p>
  )
}

/**
 * The face: a rounded square (people stay round). Where the photo can be changed
 * (`matrixAgentActions`), a click (or a dropped picture) changes it; elsewhere it is just the
 * face, with no tip about where (0.19.4 Q4). The primary assistant's face is the Atum mark
 * until a photo is chosen.
 */
function CardAvatar({
  agent,
  compact,
  copy,
  name,
  onActions,
  onFailed,
  snapshot
}: {
  agent: MatrixAgentView
  compact: boolean
  copy: AssistantCardCopy
  name: string
  /** What the "…" menu can do with the photo, or nothing where it cannot change here. */
  onActions(actions: CardPhotoActions | undefined): void
  onFailed(): void
  snapshot: MatrixSnapshot
}) {
  const bridge = window.atumMatrix.assistants
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [cropFile, setCropFile] = useState<File>()
  const [avatarUrl, setAvatarUrl] = useState(agent.avatarUrl)
  const canEdit = Boolean(bridge && matrixAgentActions(agent).photo && snapshot.state === 'ready')
  const target = { kind: 'agent' as const, principal: agent.principal }

  useEffect(() => setAvatarUrl(agent.avatarUrl), [agent.avatarUrl])

  const change = async (photo?: PreparedPhoto) => {
    if (!bridge || pending) {
      return
    }

    setPending(true)

    try {
      const result = await bridge.avatar({ principal: agent.principal, avatar: photo ?? null })
      if (!result.ok) {throw new Error(result.error)}
      setAvatarUrl(result.avatarUrl)
    } catch {
      onFailed()
    } finally {
      setPending(false)
    }
  }

  // The menu's Change photo / Remove photo do what a click on the face and the old link did.
  useEffect(() => {
    onActions(
      canEdit
        ? {
            hasPhoto: Boolean(avatarUrl),
            pending,
            change: () => input.current?.click(),
            remove: () => void change()
          }
        : undefined
    )
    // `change` reads the latest state through its closure each render; the menu only needs these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarUrl, canEdit, onActions, pending])

  const face = (
    <MatrixProfileAvatar
      avatarUrl={avatarUrl}
      brand={agent.isDefault}
      className={cn('atum-card-avatar', compact && 'atum-card-avatar-compact')}
      id={agent.principal}
      inset
      mark={agent.mark}
      name={name}
      profile={agent.profile}
      scopeKey={`${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`}
      target={target}
    />
  )

  if (!canEdit) {
    return face
  }

  const drop = (event: DragEvent) => {
    const file = event.dataTransfer.files?.[0]

    if (file) {
      event.preventDefault()
      if (!pending) {setCropFile(file)}
    }
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        aria-busy={pending || undefined}
        aria-label={copy.avatarLabel(name)}
        className="atum-card-avatar-button group"
        data-assistant-card-avatar
        disabled={pending}
        onClick={() => input.current?.click()}
        onDragOver={event => event.preventDefault()}
        onDrop={drop}
        type="button"
      >
        {face}
        <span aria-hidden className="atum-card-avatar-band">
          {copy.avatarBand}
        </span>
      </button>
      <input
        accept={ATUM_AVATAR_ACCEPT}
        aria-hidden
        className="sr-only"
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''

          if (file) {setCropFile(file)}
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      {cropFile && (
        <PhotoCropDialog
          file={cropFile}
          onCancel={() => setCropFile(undefined)}
          onConfirm={photo => {
            setCropFile(undefined)
            void change(photo)
          }}
        />
      )}
    </div>
  )
}

/** Whether this assistant is still on a Mac or moving: only then does its home row say anything. */
function awayFromCloud(agent: MatrixAgentView): boolean {
  // Cloud-only (AGENT_HOMES_CLOUD_ONLY): every assistant lives in the cloud, so "Lives on: The cloud"
  // says nothing and the row goes (owner 2026-11-26: "obsolete now"); the Macs it can use are the
  // panel's Your devices row. Only an assistant still on a Mac, or one moving, keeps it: there it is
  // the way to the cloud, and the place it answers from is news.
  const placed = agent.home?.placement

  return agent.home
    ? agent.home.lives.kind !== 'cloud' ||
        Boolean(agent.home.move || agent.home.issue) ||
        (placed !== undefined && placed.current !== 'cloud')
    : !matrixAgentAnswersInCloud(agent)
}

/**
 * The one state notice under the header, in the revamp's priority (2026-11-28): a save failure (the
 * band, drawn by the card) > not set up > off the cloud or moving > paused. Now (working or waiting)
 * is not a notice and sits above it.
 */
function CardStateNotice({
  agent,
  band,
  copy,
  paused,
  status
}: {
  agent: MatrixAgentView
  band: boolean
  copy: AssistantCardCopy
  paused?: ReactNode
  status: ReturnType<typeof agentStatus>
}) {
  if (band) {
    return null
  }

  // A cloud assistant no Mac runs has nothing to set up here, and where it answers is not said
  // (0.19.4 Q4). One this Mac runs for it (answering or standing by, `macRole`) has a local runtime
  // that can be not ready, so it offers the same setup as any local assistant.
  if (!agent.ready && matrixAgentNeedsLocalSetup(agent)) {
    return <SetupNotice agent={agent} copy={copy} status={status} />
  }

  // `agent.home` is main's data boundary for a migrated D1 assistant. Only then does this card show
  // the authoritative home, its owner-placement readiness, and manual moves.
  const homeBridge = window.atumMatrix.agentHome

  if (awayFromCloud(agent)) {
    return (
      <section className="atum-card-section">
        <div className="atum-settings-group">
          {agent.home && homeBridge ? (
            <MatrixAgentHomeRow
              agentName={agent.name}
              agentPrincipal={agent.principal}
              bridge={homeBridge}
              view={agent.home}
            />
          ) : (
            <MatrixAgentPlaceRow agent={agent} />
          )}
        </div>
      </section>
    )
  }

  return paused ? <div className="atum-card-section">{paused}</div> : null
}

/**
 * The card's settings, grouped by what they are about (agent card revamp 2026-11-28): "On its own"
 * (routines, Pause), "In this chat" (the model that answers, notifications, its pet; the privacy line
 * at its foot), "Can use" (your devices, its skills). A section with nothing in it is absent. Every
 * assistant shows the same rows; the primary keeps its privileges, never extra rows.
 */
function CardSections({
  agent,
  card,
  controls,
  copy,
  focusRoutines,
  locale,
  name,
  openShelf,
  pet,
  snapshot
}: {
  agent: MatrixAgentView
  card?: MatrixAssistantCard
  controls?: AssistantCardControlSlots
  copy: AssistantCardCopy
  focusRoutines: boolean
  locale: string
  name: string
  openShelf(shelf: 'pets' | 'skills'): void
  /** Its pet's name, once it has one; choosing one lives in the "…" menu. */
  pet?: string
  snapshot: MatrixSnapshot
}) {
  const store = Boolean(snapshot.apps)
  const homeBridge = window.atumMatrix.agentHome

  // The routines panel's "Chuyển lên đám mây" opens the card's one placement surface (D1 home).
  const openAnswerWhere = () => {
    const trigger = window.document.querySelector<HTMLElement>('[data-assistant-card-home]')

    if (trigger) {
      trigger.scrollIntoView({ block: 'nearest' })
      trigger.click()
    }
  }

  const own: ReactNode[] = []

  if (window.atumMatrix?.routines) {
    own.push(
      <RoutinesRow
        agent={agent}
        copy={copy}
        glyph={<RowGlyph icon={CalendarCheck} />}
        initiallyOpen={focusRoutines}
        key="routines"
        locale={locale}
        onMoveToCloud={agent.home && homeBridge ? openAnswerWhere : undefined}
        paused={controls?.routinesPaused}
      />
    )
  } else if (agent.isDefault && snapshot.checkIns && snapshot.identity) {
    // A window without the routines bridge keeps the check-in row where it was: one list needs
    // the native routine client, and an older runtime must not lose its only check-in control.
    own.push(<CheckInsRow copy={copy} key="check-ins" locale={locale} snapshot={snapshot} />)
  }

  if (controls?.pause) {
    own.push(<Fragment key="pause">{controls.pause}</Fragment>)
  }

  if (snapshot.identity && window.atumMatrix?.backgroundSweep) {
    own.push(
      <BackgroundSweepRow
        agentPrincipal={agent.principal}
        bridge={window.atumMatrix.backgroundSweep}
        copy={copy}
        key="background-sweep"
        ownerKey={`${snapshot.identity.userId}\n${snapshot.identity.deviceId}`}
      />
    )
  }

  const chat: ReactNode[] = []

  if (agent.modelDestinations) {
    chat.push(
      <ModelDestinationsRow
        agent={agent}
        glyph={<RowGlyph icon={Sparkles} />}
        key="model-destinations"
        label={copy.answersWith}
        preferenceScope={`account:${snapshot.identity?.userId ?? 'signed-out'}`}
      />
    )
  }

  if (controls?.notifications) {
    chat.push(<Fragment key="notifications">{controls.notifications}</Fragment>)
  }

  // Owner 2026-11-28 (open question 2, yes): the row shows once a pet is chosen; until then
  // "Choose a pet…" is in the "…" menu, so the card carries no upsell row.
  if (store && pet) {
    chat.push(
      <button
        aria-label={`${copy.pet}, ${pet}`}
        className="atum-settings-row atum-settings-link"
        data-assistant-card-pet
        key="pet"
        onClick={() => openShelf('pets')}
        type="button"
      >
        <RowGlyph icon={PawPrint} />
        <span className="atum-settings-row-title min-w-0 flex-1">{copy.pet}</span>
        <span className="atum-card-row-value">{pet}</span>
        <ChevronRight aria-hidden className="atum-settings-chevron" />
      </button>
    )
  }

  const canUse: ReactNode[] = []

  if (controls?.devices) {
    canUse.push(<Fragment key="devices">{controls.devices}</Fragment>)
  }

  if (card?.skills.length) {
    canUse.push(
      <SkillsRow
        glyph={<RowGlyph icon={PuzzlePiece} />}
        key="skills"
        onFindMore={store ? () => openShelf('skills') : undefined}
        skills={card.skills}
      />
    )
  }

  const privacy = (
    <span data-assistant-card-privacy id="assistant-card-privacy">
      {copy.privacy(name)}
    </span>
  )

  return (
    <>
      {own.length > 0 && (
        <SettingsSection className="atum-card-section" data-assistant-card-section="own" title={copy.sectionOwn}>
          {own}
        </SettingsSection>
      )}
      {chat.length > 0 ? (
        <SettingsSection
          className="atum-card-section"
          data-assistant-card-section="chat"
          foot={privacy}
          title={copy.sectionChat}
        >
          {chat}
        </SettingsSection>
      ) : (
        // The trust line stays even when this chat has no rows of its own.
        <p className="atum-card-section atum-settings-section-foot">{privacy}</p>
      )}
      {canUse.length > 0 && (
        <SettingsSection className="atum-card-section" data-assistant-card-section="can-use" title={copy.sectionCanUse}>
          {canUse}
        </SettingsSection>
      )}
    </>
  )
}

/** The pet this assistant has, by name, or nothing (the row then says "Choose"). */
function useAgentPetName(agent: MatrixAgentView, snapshot: MatrixSnapshot): string | undefined {
  const [name, setName] = useState<string>()
  const pets = window.atumMatrix.pets
  const scope = snapshot.petScope

  useEffect(() => {
    if (!pets || !scope) {
      return
    }

    let current = true
    void pets
      .read({ scope, agent: agent.principal })
      .then(view => {
        if (current) {
          setName(view.sprite?.enabled ? view.sprite.displayName : undefined)
        }
      })
      .catch(() => {})

    return () => {
      current = false
    }
  }, [pets, scope, agent.principal])

  return name
}

/** Check-ins, the primary's only: the card's Check-ins row (check-in "Change" opens this card). */
function CheckInsRow({
  copy,
  locale,
  snapshot
}: {
  copy: AssistantCardCopy
  locale: string
  snapshot: MatrixSnapshot
}) {
  const [pending, setPending] = useState(false)
  const checkIns = snapshot.checkIns!
  const on = checkIns.settings.enabled
  const brief = checkIns.settings.brief

  return (
    <label className="atum-settings-row cursor-pointer" data-assistant-card-check-ins>
      <RowGlyph icon={CalendarCheck} />
      <span className="atum-settings-row-text">
        <span className="atum-settings-row-title">{copy.checkIns}</span>
        {on && (
          <span className="atum-settings-row-help">
            {brief ? copy.checkInsBrief(matrixCheckInTime(brief, locale)) : copy.checkInsOff}
          </span>
        )}
      </span>
      <Switch
        aria-label={copy.checkIns}
        checked={on}
        disabled={pending || !checkIns.writable || snapshot.state !== 'ready'}
        onCheckedChange={value => {
          setPending(true)
          void changeMatrixCheckIns(snapshot.identity!, { field: 'enabled', value, by: 'settings' })
            .catch(() => {})
            .finally(() => setPending(false))
        }}
      />
    </label>
  )
}

/** Shown only while an assistant that runs here is not ready: a notice with the roster's own action. */
function SetupNotice({
  agent,
  copy,
  status
}: {
  agent: MatrixAgentView
  copy: AssistantCardCopy
  status: ReturnType<typeof agentStatus>
}) {
  const [pending, setPending] = useState(false)
  // Working on it (a setup or a start in progress), versus not set up yet.
  const settingUp = status === 'agentSettingUp' && (agent.setup === 'working' || agent.readiness?.phase === 'starting')

  return (
    <div className="atum-card-section">
      <CardNotice
        action={
          settingUp
            ? undefined
            : {
                label: copy.setUp,
                disabled: pending,
                onClick: () => {
                  setPending(true)
                  const request = agent.isDefault ? window.atumMatrix.setupAssistant() : window.atumMatrix.retryReadiness()
                  void request.catch(() => {}).finally(() => setPending(false))
                }
              }
        }
        data-assistant-card-setup
        icon={AlertCircle}
        title={settingUp ? copy.setupRowWorking : copy.setupRowNotReady}
      />
    </div>
  )
}

/** The sheet around a card: opaque, Settings' material, no title bar (the name is the title). */
export function AssistantCardSheet({
  children,
  compact,
  focusName,
  label,
  onClose,
  open
}: {
  children: ReactNode
  compact: boolean
  focusName?: boolean
  label: string
  onClose(): void
  open: boolean
}) {
  const content = useRef<HTMLDivElement>(null)

  return (
    <Dialog onOpenChange={value => !value && onClose()} open={open}>
      <DialogContent
        aria-describedby="assistant-card-privacy"
        className={cn('atum-sheet atum-assistant-card', compact && 'atum-assistant-card-compact')}
        data-assistant-card
        onEscapeKeyDown={event => {
          // Esc steps back one level: a field first (it reverts itself), then the sheet.
          const target = event.target as HTMLElement | null

          if (
            target?.closest(
              '[data-assistant-card-name-field], [data-assistant-card-personality-field], [data-assistant-card-field], [data-matrix-handle-field]'
            )
          ) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={event => {
          event.preventDefault()

          if (!focusName) {
            content.current?.closest<HTMLElement>('[data-slot="dialog-content"]')?.focus()
          }
        }}
        ref={content}
        showCloseButton={false}
        tabIndex={-1}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** Opens the card's assistant's most recent chat (or a new one). */
export function openAssistantChat(
  agent: MatrixAgentView,
  snapshot: MatrixSnapshot,
  open: ((fresh?: boolean, agentId?: string, roomId?: string) => Promise<void>) | null | undefined
): void {
  const room = snapshot.rooms
    .filter(each => each.agentPrincipal === agent.principal && each.membership === 'join')
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]

  if (room) {
    if (room.id !== snapshot.roomId) {
      void runMatrixCommand({ kind: 'select', roomId: room.id }).catch(() => {})
    }

    return
  }

  void open?.(true, agent.isDefault ? undefined : agent.userId)
}
