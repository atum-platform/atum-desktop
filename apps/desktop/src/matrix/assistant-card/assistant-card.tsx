import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ATUM_AVATAR_ACCEPT } from '@/lib/atum-avatar'
import { Check, ChevronRight, MessageCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { appCatalogNames } from '../../../shared/app-catalog'
import type { MatrixAgentView, MatrixSnapshot } from '../../../shared/matrix'
import { matrixAgentActions, matrixAgentNeedsLocalSetup } from '../../../shared/matrix-agent-actions'
import { matrixAliasCopy } from '../../../shared/matrix-alias-copy'
import type { MatrixAssistantCard, MatrixAssistantCardError } from '../../../shared/matrix-assistant-card'
import {
  type AssistantNameProblem,
  checkAssistantName,
  isAssistantNameLocked
} from '../../../shared/matrix-assistant-name'
import { parsePersona, renderPersona } from '../../../shared/matrix-assistant-persona'
import { MatrixAgentHomeRow, MatrixAgentPlaceRow } from '../agent-home-control'
import { agentStatus, RetireAgent } from '../agent-roster'
import { changeMatrixCheckIns } from '../check-in-card'
import { matrixCheckInTime } from '../check-ins-copy'
import { MatrixHandleEditor } from '../handle-editor'
import { suggestMatrixAgentHandle } from '../handle-rules'
import { MainAgentBadge } from '../main-agent-badge'
import { rememberAgentHandle } from '../person-handles'
import { MatrixProfileAvatar } from '../profile-avatar'
import { matrixRosterAgentName } from '../roster-model'
import { SettingsSection } from '../settings-row'
import { $matrixStoreShelfRequest } from '../store/top-up'
import { runMatrixCommand } from '../text-document-actions'

import { BackgroundSweepRow } from './background-sweep-row'
import { type AssistantCardCopy, useAssistantCardCopy } from './copy'
import { AgentMemoryRow } from './memory-row'
import { ModelDestinationsRow } from './model-destinations-row'
import { InlineNameField } from './name-field'
import { type PersonaChange, PersonaFields } from './persona-fields'
import type { PreparedPhoto } from './photo'
import { PhotoCropDialog } from './photo-crop'
import { RoutinesRow } from './routines-panel'
import { SkillsRow } from './skills-popover'
import { setAssistantNameOverride } from './store'

/** How long a "Saved · Undo" note stays (then it fades). */
export const ASSISTANT_CARD_NOTE_MS = 6_000

type NoteField = 'name' | keyof PersonaChange | 'checkIns'

interface Note {
  field: NoteField
  kind: 'renamed' | 'saved' | 'undone'
  undo?: () => void
}

type Band = { kind: 'failure'; retry: () => void } | { kind: 'elsewhere' } | { kind: 'photo' }

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
  focusName,
  focusRoutines = false,
  onClose,
  onMessage,
  snapshot
}: {
  agent: MatrixAgentView
  compact: boolean
  focusName: boolean
  /** The composer's "Add routines" lands on the panel itself, not one row further in. */
  focusRoutines?: boolean
  onClose(): void
  onMessage(): void
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
  const cardRef = useRef<MatrixAssistantCard | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const live = useRef(true)
  const offline = snapshot.state === 'offline'

  cardRef.current = card

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

  /** One write at a time, each fenced by the revisions the card holds when it runs. A
   * conflict re-reads; when the field was not touched elsewhere it is re-applied once. */
  const write = useCallback(
    (patch: { displayName?: string; soul?: string }) => {
      const run = async (attempt: number): Promise<'ok' | 'elsewhere' | MatrixAssistantCardError> => {
        const base = cardRef.current

        if (!bridge || !base) {
          return 'unavailable'
        }

        const result = await bridge.save({
          principal: agent.principal,
          expectedDefinitionRevision: base.definitionRevision,
          expectedIdentityRevision: base.identityRevision,
          ...patch
        })

        if (!live.current) {
          return 'unavailable'
        }

        if (result.ok) {
          cardRef.current = result.card
          setCard(result.card)

          return 'ok'
        }

        if (result.error === 'conflict' && result.card) {
          cardRef.current = result.card
          setCard(result.card)

          const untouched =
            patch.displayName !== undefined
              ? result.card.displayName === base.displayName
              : result.card.soul === base.soul

          return untouched && attempt === 0 ? run(1) : 'elsewhere'
        }

        return result.error
      }

      const next = queue.current.then(
        () => run(0),
        () => run(0)
      )

      queue.current = next

      return next.catch(() => 'unavailable' as const)
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

    void write({ displayName: next }).then(outcome => {
      if (!live.current) {
        return
      }

      if (outcome === 'ok') {
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

  const persona = useMemo(
    () => (card ? parsePersona(card.soul, { inherited: card.inherited, primary: card.isDefault }) : undefined),
    [card]
  )

  const saveSoul = (soul: string, field: keyof PersonaChange, undoing = false) => {
    const previous = cardRef.current

    if (!previous) {
      return
    }

    // Undoing the first persona of an assistant that had none: back to none.
    const before = previous.inherited ? '' : previous.soul
    setBand(undefined)

    void write({ soul }).then(outcome => {
      if (!live.current) {
        return
      }

      if (outcome === 'ok') {
        setNote(
          undoing ? { field, kind: 'undone' } : { field, kind: 'saved', undo: () => saveSoul(before, field, true) }
        )
      } else if (outcome === 'elsewhere') {
        setBand({ kind: 'elsewhere' })
      } else {
        setBand({ kind: 'failure', retry: () => saveSoul(soul, field, undoing) })
      }
    })
  }

  const savePersona = (change: PersonaChange) => {
    const current = cardRef.current

    if (!current || !persona) {
      return
    }

    const soul = renderPersona(
      parsePersona(current.soul, { inherited: current.inherited, primary: current.isDefault }),
      {
        name: current.displayName,
        ...change
      }
    )

    if (soul.trim() === (current.inherited ? '' : current.soul).trim() || (current.inherited && !soul.trim())) {
      return
    }

    const field = (Object.keys(change)[0] ?? 'what') as keyof PersonaChange
    saveSoul(soul, field)
  }

  const noteLine = (field: NoteField) =>
    note?.field === field ? <CardNote copy={copy} note={note} onUndo={() => setNote(undefined)} /> : undefined

  const ready = snapshot.state === 'ready' && !offline
  const editable = Boolean(card) && ready && !nameLocked
  const status = agentStatus(agent)
  const name = shownName

  return (
    <>
      <div className="atum-card-top">
        <Button data-assistant-card-done onClick={onClose} variant="text">
          {copy.done}
        </Button>
      </div>
      <div className="atum-card-body" data-compact={compact || undefined}>
        <header className="atum-card-header" data-editing-name={editingName || undefined}>
          <CardAvatar
            agent={agent}
            compact={compact}
            copy={copy}
            key={`${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}/${agent.principal}`}
            name={name}
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
              startEditing={focusName}
            />
          )}
          {agent.title && <p className="atum-card-caption text-center" data-assistant-card-title>{agent.title}</p>}
          {noteLine('name')}
          <p className="atum-card-privacy" id="assistant-card-privacy">
            {copy.privacy(name)}
          </p>
          <div className="atum-card-pills">
            <button className="atum-card-pill" data-assistant-card-message onClick={onMessage} type="button">
              <MessageCircle aria-hidden className="size-3.5" />
              {copy.message}
            </button>
          </div>
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
                    : copy.changedElsewhere(name)}
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
        <AgentHandle agent={agent} name={name} ready={ready} snapshot={snapshot} />
        <section className="atum-card-section">
          {loadFailed ? (
            <div className="atum-settings-group">
              <div className="atum-settings-row atum-settings-row-quiet">
                <span className="atum-settings-row-text atum-settings-row-title">{copy.loadFailed(name)}</span>
                <Button onClick={() => setLoadAttempt(value => value + 1)} size="inline" variant="textStrong">
                  {copy.retry}
                </Button>
              </div>
            </div>
          ) : (
            <PersonaFields
              disabled={!card || !ready}
              name={name}
              note={
                note && note.field !== 'name' && note.field !== 'checkIns'
                  ? { field: note.field, node: <CardNote copy={copy} note={note} onUndo={() => setNote(undefined)} /> }
                  : undefined
              }
              onSave={savePersona}
              persona={persona ?? parsePersona('')}
            />
          )}
          <p className="atum-settings-section-foot">{copy.footnote}</p>
        </section>
        <CardRows
          agent={agent}
          card={card}
          copy={copy}
          focusRoutines={focusRoutines}
          locale={locale}
          onClose={onClose}
          snapshot={snapshot}
          status={status}
        />
        {!primary && (
          <section className="atum-card-section">
            <div className="atum-settings-group">
              <button
                className="atum-settings-row atum-card-danger"
                data-assistant-card-delete
                disabled={snapshot.state !== 'ready'}
                onClick={() => setRetiring(true)}
                type="button"
              >
                {copy.deleteRow(name)}
              </button>
            </div>
          </section>
        )}
      </div>
      {!primary && <RetireAgent agent={agent} name={name} onClose={() => setRetiring(false)} open={retiring} />}
    </>
  )
}

/**
 * The assistant's bot handle ("Tên bot", spec/public-handles/v1): how people find and @mention
 * it, beside its display name in the header. Shown where the directory exists; chosen or changed
 * in place, the platform deciding what is free. One editor per account and assistant.
 */
function AgentHandle({
  agent,
  name,
  ready,
  snapshot
}: {
  agent: MatrixAgentView
  name: string
  ready: boolean
  snapshot: MatrixSnapshot
}) {
  const { locale } = useI18n()
  const copy = matrixAliasCopy(locale)
  const bridge = window.atumMatrix?.aliases

  if (!bridge || !snapshot.domainEnabled || !snapshot.identity || !agent.assistantId) {
    return null
  }

  return (
    <SettingsSection
      className="atum-card-section"
      data-assistant-card-handle
      help={copy.botNameHelp}
      title={copy.botName}
    >
      <MatrixHandleEditor
        assistantId={agent.assistantId}
        bridge={bridge}
        disabled={!ready}
        key={`${snapshot.identity.userId}:${agent.assistantId}`}
        name={name}
        names={snapshot.agents}
        onChanged={(handle, previous) => rememberAgentHandle(agent.userId, handle, previous)}
        suggestion={suggestMatrixAgentHandle(name)}
      />
    </SettingsSection>
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
  onFailed,
  snapshot
}: {
  agent: MatrixAgentView
  compact: boolean
  copy: AssistantCardCopy
  name: string
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
      {avatarUrl && (
        <Button disabled={pending} onClick={() => void change()} size="inline" variant="text">
          {copy.photoRemove}
        </Button>
      )}
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

/** Card 2: its pet, its skills, its authoritative routines, and whether it still needs setting up. */
function CardRows({
  agent,
  card,
  copy,
  focusRoutines,
  locale,
  onClose,
  snapshot,
  status
}: {
  agent: MatrixAgentView
  card?: MatrixAssistantCard
  copy: AssistantCardCopy
  focusRoutines: boolean
  locale: string
  onClose(): void
  snapshot: MatrixSnapshot
  status: ReturnType<typeof agentStatus>
}) {
  const store = Boolean(snapshot.apps)
  const pet = useAgentPetName(agent, snapshot)
  const { t } = useI18n()
  const memoryName = matrixRosterAgentName(agent, t.matrixShell.assistantName)

  const openShelf = (shelf: 'pets' | 'skills') => {
    $matrixStoreShelfRequest.set(shelf)
    onClose()
    void runMatrixCommand({ kind: 'discoverApps' }).catch(() => $matrixStoreShelfRequest.set(null))
  }

  // The routines panel's "Chuyển lên đám mây" opens the card's one placement surface (D1 home).
  const openAnswerWhere = () => {
    const trigger = window.document.querySelector<HTMLElement>('[data-assistant-card-home]')

    if (trigger) {
      trigger.scrollIntoView({ block: 'nearest' })
      trigger.click()
    }
  }

  const rows: ReactNode[] = []
  // `agent.home` is main's data boundary for a migrated D1 assistant. Only then does this card show
  // the authoritative home, its owner-placement readiness, and manual moves.
  const homeBridge = window.atumMatrix.agentHome

  if (agent.home && homeBridge) {
    rows.push(
      <MatrixAgentHomeRow
        agentName={agent.name}
        agentPrincipal={agent.principal}
        bridge={homeBridge}
        key="agent-home"
        view={agent.home}
      />
    )
  }

  // Cloud-only U1: an assistant without `agent.home` gets the same row, read-only (where it answers
  // and the Macs it can use). The legacy execution-order editor is gone from the card.
  if (!(agent.home && homeBridge)) {
    rows.push(<MatrixAgentPlaceRow agent={agent} key="agent-home" />)
  }

  if (agent.modelDestinations) {
    rows.push(
      <ModelDestinationsRow
        agent={agent}
        key="model-destinations"
        preferenceScope={`account:${snapshot.identity?.userId ?? 'signed-out'}`}
      />
    )
  }

  if (store) {
    rows.push(
      <button
        aria-label={`${copy.pet}, ${pet ?? copy.petChoose}`}
        className="atum-settings-row atum-settings-link"
        data-assistant-card-pet
        key="pet"
        onClick={() => openShelf('pets')}
        type="button"
      >
        <span className="atum-settings-row-title min-w-0 flex-1">{copy.pet}</span>
        <span className="atum-card-row-value">{pet ?? copy.petChoose}</span>
        <ChevronRight aria-hidden className="atum-settings-chevron" />
      </button>
    )
  }

  if (card?.skills.length) {
    rows.push(
      <SkillsRow key="skills" onFindMore={store ? () => openShelf('skills') : undefined} skills={card.skills} />
    )
  }

  if (snapshot.identity && window.atumMatrix?.backgroundSweep) {
    rows.push(
      <BackgroundSweepRow
        agentPrincipal={agent.principal}
        bridge={window.atumMatrix.backgroundSweep}
        copy={copy}
        key="background-sweep"
        ownerKey={`${snapshot.identity.userId}\n${snapshot.identity.deviceId}`}
      />
    )
  }

  // What it remembers (cloud memory). Keyed by account so a switch starts from a fresh read; the
  // row hides itself while memory is not available for this assistant.
  if (snapshot.identity && window.atumMatrix?.agentMemory) {
    rows.push(
      <AgentMemoryRow
        agentName={memoryName}
        agentPrincipal={agent.principal}
        bridge={window.atumMatrix.agentMemory}
        key={`memory:${snapshot.identity.userId}:${snapshot.identity.deviceId}`}
      />
    )
  }

  if (window.atumMatrix?.routines) {
    rows.push(
      <RoutinesRow
        agent={agent}
        copy={copy}
        initiallyOpen={focusRoutines}
        key="routines"
        locale={locale}
        onMoveToCloud={agent.home && homeBridge ? openAnswerWhere : undefined}
      />
    )
  } else if (agent.isDefault && snapshot.checkIns && snapshot.identity) {
    // A window without the routines bridge keeps the check-in row where it was: one list needs
    // the native routine client, and an older runtime must not lose its only check-in control.
    rows.push(<CheckInsRow copy={copy} key="check-ins" locale={locale} snapshot={snapshot} />)
  }

  // A cloud assistant no Mac runs has nothing to set up here, and where it answers is not said
  // (0.19.4 Q4). One this Mac runs for it (answering or standing by, `macRole`) has a local runtime
  // that can be not ready, so it offers the same setup as any local assistant.
  if (!agent.ready && matrixAgentNeedsLocalSetup(agent)) {
    rows.push(<SetupRow agent={agent} copy={copy} key="setup" status={status} />)
  }

  if (!rows.length) {
    return null
  }

  return (
    <section className="atum-card-section">
      <div className="atum-settings-group" data-assistant-card-rows>
        {rows}
      </div>
    </section>
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

/** Shown only while an assistant that runs here is not ready, with the roster's own action. */
function SetupRow({
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
    <div className="atum-settings-row" data-assistant-card-setup>
      <span className="atum-settings-row-title min-w-0 flex-1">{copy.setupRow}</span>
      <span className="atum-card-row-value">{settingUp ? copy.setupRowWorking : copy.setupRowNotReady}</span>
      {!settingUp && (
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true)
            const request = agent.isDefault ? window.atumMatrix.setupAssistant() : window.atumMatrix.retryReadiness()
            void request.catch(() => {}).finally(() => setPending(false))
          }}
          size="sm"
          variant="secondary"
        >
          {copy.setUp}
        </Button>
      )}
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
