import {
  compareIds,
  conversationRecencyRank,
  ConversationUnavailableError,
  rankConversationCandidates,
  resolveConversationRoom
} from '../../../shared/agent-conversation'
import type { ConversationResolution, ConversationWrite } from '../../../shared/agent-conversation/types'
import type { ConversationCandidateRead, MatrixConversationView } from '../../../shared/agent-conversation/view'

import {
  type ConversationMigrationJournal,
  type ConversationMigrationOutcome,
  executeConversationMigration,
  retryConversationMigration
} from './migrate'
import { conversationSweepWrites } from './sweep'

export interface ConversationMigrationServicePorts {
  /** True only while this account and agent instance still own the native operation. */
  current(): boolean
  /** Native no-live-turn barrier for the agent. */
  idle(): boolean
  read(): Promise<ConversationCandidateRead[]>
  /** Owner-checked prior projection used only for an unreadable-main replacement. */
  knownMain(): string | undefined
  /** `plainReady`: every active Mac reports 0.20, so an encrypted main may move to a plain room. */
  facts(): Promise<ConversationFacts>
  /** Counts persisted job origins before an owner confirms a move. */
  jobs(rooms: readonly string[], main?: string): Promise<number>
  /** The native port rechecks the current owner and gates before every non-empty write. */
  write(write: ConversationWrite): Promise<void>
  /** Repoint jobs and converge the local home only after marker work succeeds. */
  finish(main: string, rooms: readonly string[]): Promise<void>
  /** Makes the owner's new plain room with the agent and has the agent join it. With `reuse`, the
   * room is one an earlier attempt already made: only the agent's join is repeated. */
  create(reuse?: string): Promise<string>
  readJournal(): ConversationMigrationJournal | null
  saveJournal(journal: ConversationMigrationJournal | null): void
  changed(view: MatrixConversationView): void
  now(): number
}

export interface ConversationFacts {
  cloudMayAnswer: boolean
  cloudReady: boolean
  fleetReady: boolean
  plainReady?: boolean
}

const AUTO_RETRY_MS = 60_000
const AUTO_RETRY_MAX_MS = 30 * 60_000
/** Automatic legacy migrations that did not finish before the owner is told about it once. */
const AUTO_STUCK_AFTER = 4

/** `resume` is main's background retry of a move that wrote its markers but did not settle (never
 * the renderer's: ipc-policy admits only the owner's actions). */
export type ConversationMigrationAction =
  | 'preview'
  | 'reconcile'
  | 'keep'
  | 'makeMain'
  | 'replaceMain'
  | 'retry'
  | 'resume'

interface MigrationSnapshot {
  candidates: ConversationCandidateRead[]
  knownMain?: string
  resolution: ConversationResolution
  view: MatrixConversationView
  rooms: string[]
}

/**
 * Coordinates the owner-confirmed migration policy around native ports. This is
 * intentionally per captured account/agent instance: it never shares a prior
 * read or a rendered view across identities.
 */
export class ConversationMigrationService {
  #previousResolution: ConversationResolution | undefined
  #previousView: MatrixConversationView | undefined
  /** Automatic (reconcile) moves that did not finish in a row, and when the next may run. */
  #autoFailures = 0
  #autoRetryAt = 0
  /** Automatic picks of an unmarked room that did not finish in a row, and when the next may run. */
  #pickFailures = 0
  #pickRetryAt = 0
  /** An automatic attempt publishes its final quiet view, never a failed one. */
  #quietFailure = false
  /** Background resumes of an unsettled move that did not finish in a row, and when the next may run. */
  #resumeFailures = 0
  #resumeRetryAt = 0

  constructor(private readonly ports: ConversationMigrationServicePorts) {}

  async request(action: ConversationMigrationAction, roomId?: string): Promise<MatrixConversationView> {
    const journal = this.ports.readJournal()

    if (action === 'resume') {
      return this.resume(journal)
    }

    if (journal && action !== 'retry') {
      return this.emit(this.pendingView(journal))
    }

    if (action === 'retry') {
      return this.retry(journal, roomId)
    }

    const snapshot = await this.snapshot()

    if (!snapshot) {
      return this.staleView()
    }

    if (snapshot.view.reason === 'read_unavailable' && action !== 'replaceMain') {
      if (!snapshot.view.replaceable) {
        return this.emit(snapshot.view)
      }
      // The replacement does not exist yet: jobs in the old main also move.
      const view = await this.withJobs(snapshot.view, snapshot.rooms)
      if (view.reason === 'failed') {
        return view
      }
      const gate = await this.gate()
      if (!gate) {
        return this.staleView()
      }
      return this.emit(gate.reason ? blocked(view, gate.reason) : view)
    }

    if (action === 'preview') {
      return roomId ? this.previewTarget(snapshot, roomId) : this.preview(snapshot)
    }

    if (action === 'reconcile') {
      return this.reconcile(snapshot)
    }

    if (action === 'replaceMain') {
      return this.replace(snapshot, roomId)
    }

    return this.migrate(snapshot, roomId)
  }

  private async snapshot(): Promise<MigrationSnapshot | undefined> {
    if (!this.ports.current()) {
      return undefined
    }
    const candidates = await this.ports.read()

    if (!this.ports.current()) {
      return undefined
    }

    if (candidates.some(candidate => candidate.read === 'transient')) {
      return {
        candidates,
        knownMain: this.ports.knownMain(),
        resolution: this.#previousResolution ?? emptyResolution(),
        rooms: candidateRooms(candidates),
        view: this.transientView()
      }
    }

    let resolution: ConversationResolution

    try {
      resolution = resolveConversationRoom(candidates, this.#previousResolution)
    } catch (error) {
      if (!(error instanceof ConversationUnavailableError)) {
        throw error
      }
      resolution = emptyResolution()
    }

    const knownMain = this.ports.knownMain()
    const priorMain = candidates.find(candidate => candidate.roomId === knownMain)

    const view =
      priorMain?.read === 'unreachable'
        ? replacementView(viewFor(candidates, resolution, this.ports.now()), knownMain!)
        : viewFor(candidates, resolution, this.ports.now())

    this.#previousResolution = copyResolution(resolution)
    this.#previousView = copyView(view)

    return { candidates, knownMain, resolution, rooms: candidateRooms(candidates), view }
  }

  private transientView(): MatrixConversationView {
    const prior = this.#previousView

    return {
      state: 'blocked',
      ...(prior?.main ? { main: prior.main } : {}),
      ...(prior?.proposed ? { proposed: prior.proposed } : {}),
      candidates: prior ? [...prior.candidates] : [],
      earlier: prior ? [...prior.earlier] : [],
      skipped: prior ? [...prior.skipped] : [],
      jobs: prior?.jobs ?? null,
      reason: 'read_unavailable'
    }
  }

  private async preview(snapshot: MigrationSnapshot): Promise<MatrixConversationView> {
    const gate = await this.gate()
    if (!gate) {
      return this.staleView()
    }
    if (gate.reason) {
      return this.emit(blocked(snapshot.view, gate.reason))
    }

    // `replaceable` says the background reconcile pass will move this main (autoReplace), or
    // restore the main a crossed move lost (headlessMain, proposed); the renderer offers no manual
    // Replace since 0.19.4.
    const restoring = gate.plainReady ? headlessMain(snapshot) : undefined

    const view =
      encryptedMain(snapshot) && gate.plainReady
        ? { ...snapshot.view, replaceable: true }
        : restoring
          ? { ...snapshot.view, proposed: restoring, replaceable: true }
          : snapshot.view

    // A stuck automatic pick is published by `reconcile`'s pick path; preview stays read-only.
    return this.withJobs(view, snapshot.rooms, snapshot.resolution.main ?? view.proposed)
  }

  /** Native-only second phase, acquired after a read-only preview finds actual work. */
  private async reconcile(snapshot: MigrationSnapshot): Promise<MatrixConversationView> {
    const gate = await this.gate()

    if (!gate) {
      return this.staleView()
    }

    if (gate.reason) {
      return this.emit(blocked(snapshot.view, gate.reason))
    }

    if (snapshot.resolution.main) {
      // 0.20: an encrypted main moves to a fresh plain room once every Mac can follow it there.
      // An unmarked legacy room is first marked main (below); it moves on the next pass.
      return encryptedMain(snapshot) && gate.plainReady ? this.autoReplace(snapshot) : this.sweep(snapshot)
    }

    // Preserve state, recovery and failure handling across interrupted operations.
    const headless = headlessMain(snapshot)

    if (headless) {
      if (!gate.plainReady) {
        return this.withJobs(snapshot.view, snapshot.rooms, snapshot.view.proposed)
      }

      return this.migrate(snapshot, headless)
    }

    // Unmarked rooms (or rooms left without a main by an older move): the app picks the
    // conversation the owner was last in, with no choice, preview, or confirmation.
    return this.autoPick(snapshot)
  }

  /**
   * The automatic pick of an unmarked conversation: the most recent room the owner talked in
   * (the same `proposed` ranking every Mac computes), falling back to the next writable room when
   * that one cannot be marked. It runs quietly; a failure is retried on the minute pass with a
   * growing pause, and only after several failures does one line and its Try again appear.
   */
  private async autoPick(snapshot: MigrationSnapshot, selected?: string): Promise<MatrixConversationView> {
    const chosen = selected ?? legacyMain(snapshot, this.ports.now())

    if (this.#pickFailures >= AUTO_STUCK_AFTER) {
      return this.emit({ ...snapshot.view, state: 'retry', proposed: chosen, reason: 'failed' })
    }

    if (this.ports.now() < this.#pickRetryAt) {
      return this.quietPick(snapshot, chosen)
    }

    this.#quietFailure = true

    let view: MatrixConversationView

    try {
      view = chosen
        ? await this.migrate(snapshot, chosen)
        : blocked({ ...snapshot.view, proposed: snapshot.view.proposed }, 'chosen_not_writable')
    } finally {
      this.#quietFailure = false
    }

    if (view.state === 'marked') {
      this.#pickFailures = 0
      this.#pickRetryAt = 0

      // Two Macs can pick different rooms when their reads differ while sync settles. Follow the
      // main the other Mac marked (as `replace` follows a completed move) instead of leaving two
      // mains; the sweep marks this Mac's pick Earlier under the winner.
      const refreshed = await this.snapshot()

      if (refreshed && !refreshed.view.reason && refreshed.resolution.main && refreshed.resolution.main !== chosen) {
        return this.sweep(refreshed)
      }

      return view
    }

    // A move whose markers were written but whose effects did not settle is resumed by its own
    // background pass; a rollback waits for the owner's Try again. Neither is a failed pick.
    if (view.state === 'retry' && view.reason !== 'failed') {
      return view
    }

    if (!this.ports.current()) {
      return view
    }

    this.#pickFailures++
    this.#pickRetryAt =
      this.ports.now() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_MS * 2 ** (this.#pickFailures - 1))

    if (this.#pickFailures >= AUTO_STUCK_AFTER) {
      return this.emit({ ...snapshot.view, state: 'retry', proposed: chosen, reason: 'failed' })
    }

    return this.quietPick(snapshot, chosen)
  }

  /** No owner prompt while the pick will be tried again by the background pass. */
  private quietPick(snapshot: MigrationSnapshot, chosen?: string): MatrixConversationView {
    return this.emit({
      ...snapshot.view,
      ...(chosen ? { proposed: chosen } : {}),
      state: 'legacy',
      reason: undefined
    })
  }

  /**
   * The background move is the only path to a plain main (the renderer has no manual Replace
   * since 0.19.4). It runs every minute; after one that did not finish, the next waits longer
   * (1, 2, 4 ... up to 30 minutes) so a lasting failure does not repeat the work every minute. No
   * sweep meanwhile: it would mark the room an earlier attempt made Earlier, and the next attempt
   * reuses that room.
   */
  private async autoReplace(snapshot: MigrationSnapshot): Promise<MatrixConversationView> {
    if (this.ports.now() < this.#autoRetryAt) {
      return this.withJobs({ ...snapshot.view, replaceable: true }, snapshot.rooms, snapshot.resolution.main)
    }

    const view = await this.replace(snapshot)

    if (view.state === 'marked' && !view.replaceable) {
      this.#autoFailures = 0
      this.#autoRetryAt = 0
    } else if (this.ports.current()) {
      this.#autoFailures++
      this.#autoRetryAt = this.ports.now() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_MS * 2 ** (this.#autoFailures - 1))
    }

    return view
  }

  /** Explicit target previews never write markers, sweep, or restart an engine. */
  private async previewTarget(snapshot: MigrationSnapshot, roomId: string): Promise<MatrixConversationView> {
    const candidate = snapshot.candidates.find(value => value.roomId === roomId)
    const view = { ...snapshot.view, proposed: roomId }
    if (!candidate || candidate.read !== 'readable' || !candidate.writable) {
      return this.emit(blocked(view, 'chosen_not_writable'))
    }
    const withJobs = await this.withJobs(view, snapshot.rooms, roomId)
    if (withJobs.reason === 'failed') {
      return withJobs
    }
    const gate = await this.gate()
    if (!gate) {
      return this.staleView()
    }
    return this.emit(gate.reason ? blocked(withJobs, gate.reason) : withJobs)
  }

  private async sweep(snapshot: MigrationSnapshot): Promise<MatrixConversationView> {
    const main = snapshot.resolution.main!
    const withJobs = await this.withJobs(snapshot.view, snapshot.rooms, main)

    if (withJobs.reason === 'failed') {
      return withJobs
    }

    const writes = conversationSweepWrites({
      resolution: snapshot.resolution,
      markers: new Map(snapshot.candidates.map(candidate => [candidate.roomId, candidate.marker ?? null])),
      transient: false,
      at: this.ports.now()
    }).filter(write => snapshot.candidates.some(candidate => candidate.roomId === write.roomId && candidate.writable))

    this.emit({ ...withJobs, state: 'working' })

    for (const write of writes) {
      const gate = await this.gate()

      if (!gate) {
        return this.staleView()
      }

      if (gate.reason) {
        return this.emit(blocked(withJobs, gate.reason))
      }

      try {
        await this.ports.write(write)
      } catch {
        return this.emit({ ...withJobs, state: 'retry', reason: 'failed' })
      }

      if (!this.ports.current()) {
        return this.staleView()
      }
    }

    try {
      const gate = await this.gate()

      if (!gate) {
        return this.staleView()
      }

      if (gate.reason) {
        return this.emit(blocked(withJobs, gate.reason))
      }
      await this.ports.finish(main, snapshot.rooms)

      if (!this.ports.current()) {
        return this.staleView()
      }
    } catch {
      return this.emit({ ...withJobs, state: 'retry', reason: 'effects_pending' })
    }

    return this.emit({ ...withJobs, state: 'marked', main, proposed: undefined })
  }

  private async migrate(snapshot: MigrationSnapshot, selected?: string): Promise<MatrixConversationView> {
    const chosen = selected ?? snapshot.view.proposed
    const candidate = snapshot.candidates.find(value => value.roomId === chosen)

    if (!chosen || !candidate || candidate.read !== 'readable' || !candidate.writable) {
      return this.emit(blocked(snapshot.view, 'chosen_not_writable'))
    }

    const withJobs = await this.withJobs(snapshot.view, snapshot.rooms, chosen)

    if (withJobs.state === 'blocked') {
      return withJobs
    }
    const gate = await this.gate()

    if (!gate) {
      return this.staleView()
    }

    if (gate.reason) {
      return this.emit(blocked(withJobs, gate.reason))
    }

    this.emit({ ...withJobs, state: 'working', proposed: chosen })

    const outcome = await executeConversationMigration(
      {
        rooms: snapshot.rooms,
        chosen,
        ownerConfirmed: true,
        noLiveTurn: this.ports.idle(),
        cloudMayAnswer: gate.cloudMayAnswer,
        cloudReady: gate.cloudReady,
        fleetReady: gate.fleetReady,
        writable: snapshot.candidates
          .filter(candidate => candidate.read === 'readable' && candidate.writable)
          .map(candidate => candidate.roomId)
      },
      this.ports.now(),
      this.enginePorts(snapshot.rooms, gate)
    )

    return this.outcomeView({ ...withJobs, proposed: chosen }, outcome, chosen)
  }

  private async replace(snapshot: MigrationSnapshot, requested?: string): Promise<MatrixConversationView> {
    const knownMain = snapshot.knownMain
    const formerMain = snapshot.candidates.find(candidate => candidate.roomId === knownMain)
    // A main nobody can read any more, or (0.20) a readable encrypted main moving to a plain room.
    const unreadable = Boolean(knownMain) && formerMain?.read === 'unreachable'
    const former = unreadable ? knownMain : encryptedMain(snapshot)

    if (!former || (requested && requested !== former)) {
      return this.emit(blocked(snapshot.view, 'read_unavailable'))
    }

    const withJobs = await this.withJobs(snapshot.view, snapshot.rooms)

    if (withJobs.reason === 'failed') {
      return withJobs
    }
    const gate = await this.gate()

    if (!gate) {
      return this.staleView()
    }

    if (gate.reason) {
      return this.emit(blocked(withJobs, gate.reason))
    }

    // A 0.19 Mac cannot follow its agent into a plain room: wait until every Mac is on 0.20.
    if (!unreadable && !gate.plainReady) {
      return this.emit(blocked(withJobs, 'fleet_not_ready'))
    }

    let roomId: string
    // A room an earlier attempt made but never marked: plain, unmarked, readable and writable.
    // Reusing it keeps a failed attempt from leaving one more empty room behind on every pass.
    const reuse = earlierAttempt(snapshot.candidates, former)

    try {
      roomId = await this.ports.create(reuse)
    } catch {
      return this.emit({ ...withJobs, state: 'retry', reason: 'failed' })
    }

    if (!this.ports.current()) {
      return this.staleView()
    }

    const refreshed = await this.snapshot()

    if (!refreshed) {
      return this.staleView()
    }

    // Another Mac finished this same move while this one made its room: follow its plain main
    // (the sweep marks the room made here Earlier) instead of writing a second main over it.
    if (!refreshed.view.reason && movedElsewhere(refreshed, former)) {
      return this.sweep(refreshed)
    }

    // Preserve state, recovery and failure handling across interrupted operations.
    const first = refreshed.view.reason ? undefined : firstAttempt(refreshed.candidates, former)

    if (first && first !== roomId) {
      try {
        roomId = await this.ports.create(first)
      } catch {
        return this.emit({ ...withJobs, state: 'retry', reason: 'failed' })
      }

      if (!this.ports.current()) {
        return this.staleView()
      }
    }

    const created = refreshed.candidates.find(candidate => candidate.roomId === roomId)

    if (!created || created.read !== 'readable' || !created.writable) {
      return this.emit(blocked({ ...refreshed.view, jobs: withJobs.jobs }, 'read_unavailable'))
    }

    const rooms = [...new Set([...refreshed.rooms, roomId])].sort()
    const freshGate = await this.gate()

    if (!freshGate) {
      return this.staleView()
    }

    const prepared = { ...refreshed.view, main: roomId, proposed: roomId, jobs: withJobs.jobs }

    if (freshGate.reason || (!unreadable && !freshGate.plainReady)) {
      return this.emit(blocked(prepared, freshGate.reason ?? 'fleet_not_ready'))
    }

    this.emit({ ...prepared, state: 'working' })

    // The new room becomes main, and every readable old room gets an explicit Earlier marker that
    // points at it, so an older client stops answering there. The durable journal keeps every old
    // room, so a restart can still finish every job-origin move.
    const outcome = await executeConversationMigration(
      {
        rooms,
        chosen: roomId,
        ownerConfirmed: true,
        noLiveTurn: this.ports.idle(),
        cloudMayAnswer: freshGate.cloudMayAnswer,
        cloudReady: freshGate.cloudReady,
        fleetReady: freshGate.fleetReady,
        writable: [
          roomId,
          ...refreshed.candidates
            .filter(candidate => candidate.roomId !== roomId && candidate.read === 'readable' && candidate.writable)
            .map(candidate => candidate.roomId)
        ]
      },
      this.ports.now(),
      this.enginePorts(rooms, freshGate)
    )

    return this.outcomeView(prepared, outcome, roomId)
  }

  private async retry(
    journal: ConversationMigrationJournal | null,
    selected?: string
  ): Promise<MatrixConversationView> {
    if (!journal) {
      // Try again is the owner's one action after an automatic pick got stuck; it restarts the
      // quiet retries with a fresh budget.
      this.#pickFailures = 0
      this.#pickRetryAt = 0

      const retryingSweep = this.#previousView?.state === 'retry' && Boolean(this.#previousView.main)
      const chosen = selected ?? (this.#previousView?.state === 'retry' ? this.#previousView.proposed : undefined)
      const snapshot = await this.snapshot()

      if (!snapshot) {
        return this.staleView()
      }

      if (snapshot.view.reason === 'read_unavailable') {
        return this.emit(snapshot.view)
      }

      // A completed rollback removes the journal. Retry is a fresh owner intent
      // for the displayed selection, so re-read and preflight it before writing.
      if (chosen) {
        return this.autoPick(snapshot, chosen)
      }

      if (snapshot.resolution.main && retryingSweep) {
        return this.reconcile(snapshot)
      }

      if (legacyMain(snapshot, this.ports.now())) {
        return this.autoPick(snapshot)
      }

      return this.emit({ ...snapshot.view, state: 'retry', reason: 'failed' })
    }

    if (journal.phase === 'effects') {
      // Another Mac's markers replaced this move's while it was unsettled (two Macs moving at
      // once): finishing it would converge on a main the rooms no longer name, and fail forever.
      // The rooms decide instead; nothing of this journal is written again. Only once every
      // marker is written: a forward journal is the owner's choice still being written (a room
      // it has yet to mark reads Earlier), and its Retry goes on writing it.
      const snapshot = await this.snapshot()

      if (!snapshot) {
        return this.staleView()
      }

      if (supersededJournal(snapshot, journal)) {
        this.ports.saveJournal(null)

        return this.reconcile(snapshot)
      }
    }

    const view = this.pendingView(journal)

    const gate =
      journal.phase === 'rollback' ? { cloudMayAnswer: false, cloudReady: false, fleetReady: true } : await this.gate()

    if (!gate) {
      return this.staleView()
    }

    if (gate.reason) {
      return this.emit(blocked(view, gate.reason))
    }
    this.emit({ ...view, state: 'working' })
    const outcome = await retryConversationMigration(this.enginePorts(journal.rooms, gate))

    return this.outcomeView(view, outcome, journal.main)
  }

  /**
   * main's background pass for a move whose markers are all written but whose local effects (job
   * origins, the agent's home) did not settle. Until it does, the agent refuses every turn on this
   * Mac and its Hermes does not start (the 0.20.1 incident's mini), so it is not left for an owner's
   * Retry: it runs again by itself, waiting longer after each pass that did not finish, like the
   * background move. A rollback still waits for the owner: it clears markers.
   */
  private async resume(journal: ConversationMigrationJournal | null): Promise<MatrixConversationView> {
    if (!journal || journal.phase !== 'effects') {
      return journal ? this.emit(this.pendingView(journal)) : this.staleView()
    }

    if (this.ports.now() < this.#resumeRetryAt) {
      return this.emit(this.pendingView(journal))
    }

    const view = await this.retry(journal)

    if (view.state === 'marked') {
      this.#resumeFailures = 0
      this.#resumeRetryAt = 0
    } else if (this.ports.current()) {
      this.#resumeFailures++
      this.#resumeRetryAt =
        this.ports.now() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_MS * 2 ** (this.#resumeFailures - 1))
    }

    return view
  }

  private enginePorts(
    allRooms: readonly string[],
    gate: { cloudMayAnswer: boolean; cloudReady: boolean; fleetReady: boolean }
  ) {
    return {
      ready: () => this.ports.current() && this.ports.idle(),
      gate: () => gate,
      readJournal: () => this.ports.readJournal(),
      saveJournal: (journal: ConversationMigrationJournal | null) => this.ports.saveJournal(journal),
      write: (write: ConversationWrite) => this.ports.write(write),
      finish: (main: string) => this.ports.finish(main, allRooms)
    }
  }

  private outcomeView(
    base: MatrixConversationView,
    outcome: ConversationMigrationOutcome,
    main: string
  ): MatrixConversationView {
    if (!this.ports.current()) {
      return this.staleView()
    }

    switch (outcome.status) {
      case 'applied':
        return this.emit({
          ...base,
          state: 'marked',
          main: outcome.main,
          proposed: undefined,
          replaceable: undefined,
          reason: undefined
        })

      case 'rollback_pending':
        return this.emit({ ...base, state: 'retry', reason: 'rollback_pending' })

      case 'effects_pending':
        return this.emit({ ...base, state: 'retry', main: outcome.main, reason: 'effects_pending' })

      case 'rolled_back':
        return this.emit({ ...base, state: 'retry', main: undefined, proposed: main, reason: 'failed' })

      case 'blocked':
        return this.emit(blocked(base, mapBlock(outcome.reason)))
    }
  }

  private pendingView(journal: ConversationMigrationJournal): MatrixConversationView {
    const prior = this.#previousView

    return {
      state: 'retry',
      main: journal.main,
      candidates: prior ? [...prior.candidates] : [...journal.rooms],
      earlier: prior ? [...prior.earlier] : [],
      skipped: prior ? [...prior.skipped] : [],
      jobs: prior?.jobs ?? null,
      reason: journal.phase === 'rollback' ? 'rollback_pending' : 'effects_pending'
    }
  }

  private async withJobs(
    view: MatrixConversationView,
    rooms: readonly string[],
    main?: string
  ): Promise<MatrixConversationView> {
    try {
      const jobs = await this.ports.jobs(rooms, main)

      if (!this.ports.current()) {
        return this.staleView()
      }

      return this.emit({ ...view, jobs })
    } catch {
      return this.emit(blocked(view, 'failed'))
    }
  }

  private async gate(): Promise<(ConversationFacts & { reason?: MatrixConversationView['reason'] }) | undefined> {
    if (!this.ports.current()) {
      return undefined
    }
    const facts = await this.ports.facts()

    if (!this.ports.current()) {
      return undefined
    }

    if (!this.ports.idle()) {
      return { ...facts, reason: 'turn_live' }
    }

    if (facts.cloudMayAnswer && !facts.cloudReady) {
      return { ...facts, reason: 'cloud_not_ready' }
    }

    if (!facts.fleetReady) {
      return { ...facts, reason: 'fleet_not_ready' }
    }

    return facts
  }

  private emit(view: MatrixConversationView): MatrixConversationView {
    this.#previousView = copyView(view)

    // A failed automatic pick is retried quietly; the owner hears about it only once it is stuck.
    const quiet = this.#quietFailure && view.state === 'retry' && view.reason === 'failed'

    if (this.ports.current() && !quiet) {
      this.ports.changed(view)
    }

    return view
  }

  private staleView(): MatrixConversationView {
    return this.#previousView
      ? copyView(this.#previousView)
      : {
          state: 'blocked',
          candidates: [],
          earlier: [],
          skipped: [],
          jobs: null,
          reason: 'read_unavailable'
        }
  }
}

function viewFor(
  candidates: readonly ConversationCandidateRead[],
  resolution: ConversationResolution,
  now: number
): MatrixConversationView {
  const readable = candidates.filter(candidate => candidate.read === 'readable')
  const ranked = rankConversationCandidates(readable, now)
  const skipped = candidates
    .filter(candidate => candidate.read !== 'readable' || !candidate.writable)
    .map(candidate => candidate.roomId)
    .sort()

  if (!readable.length) {
    return { state: 'blocked', candidates: [], earlier: [], skipped, jobs: null, reason: 'read_unavailable' }
  }

  if (resolution.main) {
    return {
      state: 'marked',
      main: resolution.main,
      candidates: ranked,
      earlier: [...resolution.earlier],
      skipped,
      jobs: null
    }
  }

  // `earlier` is empty for unmarked rooms; marked rooms with no main (headlessMain) list them.
  return { state: 'legacy', proposed: ranked[0], candidates: ranked, earlier: [...resolution.earlier], skipped, jobs: null }
}

/** A plain readable room this Mac may mark, the only kind a repair or a converged move picks. */
function plainWritable(candidate: ConversationCandidateRead): boolean {
  return candidate.read === 'readable' && candidate.writable && candidate.encrypted === false
}

/** Earliest made first (the create event's server time), then the lowest ID: a pick every Mac
 * makes the same from the same rooms. A room whose creation time is unknown sorts last. */
function madeFirst(a: ConversationCandidateRead, b: ConversationCandidateRead): number {
  return (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY) || compareIds(a.roomId, b.roomId)
}

/**
 * The main to restore when the agent's rooms are marked but none of them is main (every marker
 * Earlier): what two Macs moving the agent at once leave when their writes cross.
 *
 * Only that shape is repaired here. The pick is a plain room (the 0.20 move's target) that some
 * room's marker names as main, so the repair completes a replacement the markers already record
 * and never picks a main of its own; every other way to lose the main goes through autoPick.
 * Undefined when the shape is not that one, and while any read is uncertain.
 *
 * Every Mac picks the same room from the same rooms: the one made first, then the lowest ID. Two
 * Macs repairing at once therefore write the same markers, and converge.
 */
function headlessMain(snapshot: MigrationSnapshot): string | undefined {
  const { resolution, candidates } = snapshot

  if (resolution.main || !resolution.earlier.length || candidates.some(candidate => candidate.read === 'transient')) {
    return undefined
  }

  const named = new Set(
    candidates.flatMap(candidate => (candidate.read === 'readable' && candidate.marker ? [candidate.marker.main] : []))
  )

  return candidates.filter(candidate => plainWritable(candidate) && named.has(candidate.roomId)).sort(madeFirst)[0]
    ?.roomId
}

/**
 * The room an automatic migration picks: the owner's last conversation, from the same ranking
 * every Mac computes (`proposed`), skipping a readable room this Mac may not mark. Among rooms of
 * equal recency, a plain room wins: marking it avoids a second migration through
 * `encryptedMain` → `replace`. The recency order itself is unchanged.
 */
function legacyMain(snapshot: MigrationSnapshot, now: number): string | undefined {
  const writable = new Set(
    snapshot.candidates.filter(candidate => candidate.read === 'readable' && candidate.writable).map(candidate => candidate.roomId)
  )
  const byRoom = new Map(snapshot.candidates.map(candidate => [candidate.roomId, candidate]))
  const ranked = snapshot.view.candidates.filter(roomId => writable.has(roomId))
  const first = ranked[0]
  const firstCandidate = first ? byRoom.get(first) : undefined

  if (!first || !firstCandidate) {
    return undefined
  }

  const rank = conversationRecencyRank(firstCandidate, now)
  const sameRank = (roomId: string): boolean => {
    const candidate = byRoom.get(roomId)

    if (!candidate) {
      return false
    }

    const candidateRank = conversationRecencyRank(candidate, now)

    return candidateRank[0] === rank[0] && candidateRank[1] === rank[1]
  }

  return ranked.find(roomId => byRoom.get(roomId)?.encrypted === false && sameRank(roomId)) ?? first
}

/** Another Mac already finished the move this one is making: the rooms name a plain main that is
 * not the room being replaced. */
function movedElsewhere(snapshot: MigrationSnapshot, former: string): boolean {
  const main = snapshot.resolution.main
  const candidate = main && main !== former ? snapshot.candidates.find(value => value.roomId === main) : undefined

  return Boolean(candidate && candidate.read === 'readable' && candidate.encrypted === false)
}

/** The plain, unmarked room made first other than the main being replaced: the room every Mac
 * that made one during the same move settles on. */
function firstAttempt(candidates: readonly ConversationCandidateRead[], former: string): string | undefined {
  return candidates
    .filter(candidate => candidate.roomId !== former && plainWritable(candidate) && !candidate.marker)
    .sort(madeFirst)[0]?.roomId
}

/**
 * The rooms no longer name this unsettled (effects) move's main, by a marker someone else wrote
 * or cleared: its room now reads Earlier, reads with no marker at all, or another room's main won
 * over it. An effects journal exists only after every one of its writes was acknowledged, and this
 * is the server's own room state, not this Mac's sync, so a main room with no marker had it
 * cleared (another Mac's rollback). A room this read could not read is no proof: the journal
 * goes on.
 */
function supersededJournal(snapshot: MigrationSnapshot, journal: ConversationMigrationJournal): boolean {
  if (snapshot.view.reason || snapshot.candidates.some(candidate => candidate.read === 'transient')) {
    return false
  }

  const room = snapshot.candidates.find(candidate => candidate.roomId === journal.main)

  return room?.read === 'readable' && (room.marker?.role !== 'main' || snapshot.resolution.main !== journal.main)
}

/** The marked main when it is a readable encrypted room (0.20: it moves to a plain one). */
function encryptedMain(snapshot: MigrationSnapshot): string | undefined {
  const main = snapshot.resolution.main
  const candidate = main ? snapshot.candidates.find(value => value.roomId === main) : undefined

  return snapshot.resolution.source === 'marked' && candidate?.read === 'readable' && candidate.encrypted === true
    ? main
    : undefined
}

/** The newest plain, unmarked, readable and writable room other than the main being replaced. */
function earlierAttempt(candidates: readonly ConversationCandidateRead[], former: string): string | undefined {
  return candidates
    .filter(
      candidate =>
        candidate.roomId !== former &&
        candidate.read === 'readable' &&
        candidate.writable &&
        candidate.encrypted === false &&
        !candidate.marker
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.roomId.localeCompare(b.roomId))[0]?.roomId
}

function replacementView(view: MatrixConversationView, main: string): MatrixConversationView {
  return {
    ...view,
    state: 'blocked',
    main,
    proposed: main,
    replaceable: true,
    candidates: view.candidates.includes(main) ? view.candidates : [main, ...view.candidates],
    skipped: view.skipped.includes(main) ? view.skipped : [...view.skipped, main].sort(),
    reason: 'read_unavailable'
  }
}

function candidateRooms(candidates: readonly ConversationCandidateRead[]): string[] {
  return [...new Set(candidates.map(candidate => candidate.roomId))].sort()
}

function emptyResolution(): ConversationResolution {
  return { earlier: [], stray: [], unreachable: [], source: 'legacy' }
}

function copyResolution(resolution: ConversationResolution): ConversationResolution {
  return {
    ...resolution,
    earlier: [...resolution.earlier],
    stray: [...resolution.stray],
    unreachable: [...resolution.unreachable]
  }
}

function copyView(view: MatrixConversationView): MatrixConversationView {
  return { ...view, candidates: [...view.candidates], earlier: [...view.earlier], skipped: [...view.skipped] }
}

function blocked(view: MatrixConversationView, reason: MatrixConversationView['reason']): MatrixConversationView {
  return { ...view, state: 'blocked', reason }
}

function mapBlock(reason: string): MatrixConversationView['reason'] {
  switch (reason) {
    case 'cloud_not_ready':

    case 'fleet_not_ready':

    case 'turn_live':

    case 'chosen_not_writable':
      return reason

    default:
      return 'failed'
  }
}
