/** The Mac side of device-service/1.1. Only synthetic test homes opt in during Phase A.
 * DeviceConnection owns signatures and current-session admission. This class owns snapshot
 * lifetime: no bytes before admission, no restored writer while those bytes could commit,
 * and no answering switch before the generation-one receipt.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { DEVICE_SERVICE_PACK } from '../../../../../packages/device-protocol/contract-packs'
import type { MigrationAck, MigrationReport, MigrationRequest, MigrationResult } from '../../../../../packages/device-protocol/migration-messages'

import type { DeviceCloseReason, DeviceConnection, DeviceMigrationSink, DeviceSession } from './connection'
import type { MigrationOutcome, MigrationSnapshot } from './migration'
import type { MigrationWriterHolds } from './migration-hold'
import { inspectMigrationChoice, inspectMigrationReport, type MigrationChoice, migrationChoiceFields, type MigrationReportModel } from './migration-report'

const P = DEVICE_SERVICE_PACK.parameters as {
  admission_ms: number; skew_ms: number; migration_chunk_max_bytes: number;
  migration_archive_max_bytes: number; migration_files_max: number; migration_hold_ms: number
}

export interface MigrationLocalAgent {
  principal: string
  userId: string
  /** Remains owner/account-bound through every asynchronous continuation. */
  current(): boolean
  hasHome(): boolean
  quiesce(): Promise<void>
  snapshot(migrationId: string): Promise<MigrationSnapshot>
  restore(): Promise<void>
  switchToCloud(): Promise<void>
}

export interface DesktopHomeMigrationOptions {
  connection(): DeviceConnection | null
  holds: MigrationWriterHolds
  /** Only an owner-bound, explicitly enabled test agent can be a participant. */
  agent(principal: string, userId: string): MigrationLocalAgent | null
  confirm(agent: MigrationLocalAgent, report: MigrationReportModel): Promise<MigrationChoice | null>
  changed(): void
  now?(): number
}

type Phase = 'preparing' | 'offering' | 'uploading' | 'uploaded' | 'staged' | 'deciding' | 'chosen' | 'committed' | 'ended'
interface Move {
  id: string
  agent: MigrationLocalAgent
  role: 'initiator' | 'participant'
  phase: Phase
  deviceServiceId: string
  snapshot?: MigrationSnapshot
  session?: DeviceSession
  offeredAt?: number
  cancelled: boolean
  approved?: boolean
  upload?: Promise<void>
  outcome: Promise<MigrationOutcome>
  resolve(value: MigrationOutcome): void
}

export class DesktopHomeMigration implements DeviceMigrationSink {
  private readonly moves = new Map<string, Move>()

  constructor(private readonly o: DesktopHomeMigrationOptions) {}
  private now() { return this.o.now?.() ?? Date.now() }
  private live(move: Move) { return move.phase !== 'ended' && move.agent.current() }
  private fields(move: Move, session: DeviceSession) {
    return { migrationId: move.id, agentPrincipal: move.agent.principal, deviceServiceId: session.deviceServiceId,
      enrollmentEpoch: session.enrollmentEpoch, accountEpoch: session.accountEpoch, connectionId: session.connectionId }
  }

  private create(id: string, agent: MigrationLocalAgent, role: Move['role'], session: DeviceSession): Move {
    // Persistence must succeed before quiescing/exporting or sending any frame.
    this.o.holds.begin(id, agent.principal)
    let resolve!: Move['resolve']
    const outcome = new Promise<MigrationOutcome>(done => { resolve = done })
    const move: Move = { id, agent, role, deviceServiceId: session.deviceServiceId, phase: 'preparing', cancelled: false, outcome, resolve }
    this.moves.set(id, move)
    this.o.changed()

    return move
  }

  /** The caller obtains cloud trust and the Mac's device enrollment before starting. */
  async start(agent: MigrationLocalAgent, signal: AbortSignal): Promise<MigrationOutcome> {
    signal.throwIfAborted()

    if (!agent.current() || this.o.agent(agent.principal, agent.userId) === null || !agent.hasHome()) {
      throw Error('matrix_migration_no_local_home')
    }

    const committed = [...this.moves.values()].find(move => move.agent.principal === agent.principal &&
      move.phase === 'committed' && move.approved && move.agent.current())

    if (committed) {
      await committed.agent.switchToCloud()

      return { state: 'moved', snapshot: committed.snapshot ?? null, staged: true }
    }

    const session = this.o.connection()?.session()

    if (!session) {throw Error('matrix_migration_device_offline')}
    const move = this.create(randomUUID(), agent, 'initiator', session)

    const abort = () => { void this.cancel(move, 'owner_cancelled') }
    signal.addEventListener('abort', abort, { once: true })
    void this.prepare(move)

    try { return await move.outcome } finally { signal.removeEventListener('abort', abort) }
  }

  private async prepare(move: Move): Promise<void> {
    try {
      await move.agent.quiesce()

      if (!this.live(move) || move.cancelled) {return await this.end(move, 'declined', 'matrix_migration_cancelled')}
      move.snapshot = await move.agent.snapshot(move.id)

      if (!this.live(move) || move.cancelled) {return await this.end(move, 'declined', 'matrix_migration_cancelled')}
      const s = move.snapshot

      if (!Number.isSafeInteger(s.bytes) || s.bytes <= 0 || s.bytes > P.migration_archive_max_bytes ||
          !Number.isSafeInteger(s.files) || s.files < 0 || s.files > P.migration_files_max || !/^[0-9a-f]{64}$/.test(s.sha256)) {
        throw Error('matrix_migration_too_large')
      }
    } catch {
      // An export that fails has sent no snapshot. A participant's signed decline tells the
      // initiator to list this Mac as missing instead of waiting the full collection window.
      if (move.role === 'participant') {await this.decline(move, 'export_failed')}
      await this.end(move, 'declined', 'matrix_migration_export_failed')

      return
    }

    // A transport error can follow an accepted frame. Admission timeout or a terminal
    // controller result, rather than that error, decides whether writers may resume.
    await this.offer(move).catch(() => {})
  }

  private async offer(move: Move): Promise<void> {
    const connection = this.o.connection(), session = connection?.session()

    if (!connection || !session || session.deviceServiceId !== move.deviceServiceId || !move.snapshot || !this.live(move) || move.cancelled) {return}

    // An entirely sent archive may already be staged despite a lost acknowledgement. Never
    // re-offer it and interpret the resulting 'duplicate' as permission to resume writers.
    if (['uploaded', 'staged', 'deciding', 'chosen', 'committed'].includes(move.phase)) {return}
    move.phase = 'offering'
    move.session = session
    move.offeredAt = this.now()
    await connection.send('MigrationOffer', { ...this.fields(move, session), agentUserId: move.agent.userId,
      role: move.role, archive: { v: 1, sha256: move.snapshot.sha256, bytes: move.snapshot.bytes, files: move.snapshot.files }, createdAt: this.now() })
  }

  /** Never await a later inbound frame here: DeviceConnection serializes its incoming frames. */
  frame(type: Parameters<DeviceMigrationSink['frame']>[0], body: Record<string, unknown>, session: DeviceSession): void {
    if (this.o.connection()?.session() !== session) {return}

    if (type === 'MigrationRequest') {
      void this.request(body as unknown as MigrationRequest, session).catch(() => {})

      return
    }

    const move = this.moves.get(String(body.migrationId))

    if (!move || !this.live(move) || session.deviceServiceId !== move.deviceServiceId) {return}

    if (type === 'MigrationAck') {void this.ack(move, body as unknown as MigrationAck, session).catch(() => { void this.cancel(move, 'owner_cancelled') })}
    else if (type === 'MigrationReport') {void this.report(move, body as unknown as MigrationReport).catch(() => { void this.cancel(move, 'owner_cancelled') })}
    else if (type === 'MigrationResult') {void this.result(move, body as unknown as MigrationResult).catch(() => {
      move.resolve({ state: 'failed', step: 'switch', code: 'matrix_migration_switch_failed' })
    })}
  }

  private async request(body: MigrationRequest, session: DeviceSession): Promise<void> {
    if (body.targetDeviceServiceId !== session.deviceServiceId || body.connectionId !== session.connectionId ||
        body.enrollmentEpoch !== session.enrollmentEpoch || body.accountEpoch !== session.accountEpoch ||
        body.expiresAt < this.now() - P.skew_ms || body.issuedAt > this.now() + P.skew_ms ||
        body.holdUntil < body.expiresAt || body.holdUntil > body.issuedAt + P.migration_hold_ms ||
        body.initiatorDeviceServiceId === session.deviceServiceId) {return}

    const old = this.moves.get(body.migrationId)

    if (old) {return} // A repeated request never re-exports a held home.
    const agent = this.o.agent(body.agentPrincipal, body.agentUserId)

    if (!agent || !agent.current()) {return}

    const fields = { migrationId: body.migrationId, agentPrincipal: body.agentPrincipal, deviceServiceId: session.deviceServiceId,
      enrollmentEpoch: session.enrollmentEpoch, accountEpoch: session.accountEpoch, connectionId: session.connectionId }

    if (!agent.hasHome() || this.o.holds.held(agent.principal)) {
      await this.o.connection()?.send('MigrationDecline', { ...fields, reason: agent.hasHome() ? 'busy' : 'no_local_home' })

      return
    }

    const move = this.create(body.migrationId, agent, 'participant', session)
    this.o.holds.extend(move.id, body.holdUntil)
    await this.prepare(move)
  }

  private async ack(move: Move, ack: MigrationAck, session: DeviceSession): Promise<void> {
    if (ack.deviceServiceId !== move.deviceServiceId || move.session !== session || !move.snapshot) {return}

    if (ack.outcome === 'refused') {
      if (move.phase === 'offering' || move.phase === 'uploading' || move.phase === 'uploaded') {
        await this.end(move, 'offer_refused', 'matrix_migration_offer_refused')
      }

      return
    }

    if (ack.outcome === 'staged') {
      if (move.phase !== 'uploaded') {return}

      if (ack.bytes !== move.snapshot.bytes || ack.sha256 !== move.snapshot.sha256) {
        // The server claims different bytes. Cancel, but retain the hold until its terminal
        // result: locally treating this as harmless could race a defective server's commit.
        await this.cancel(move, 'owner_cancelled')

        return
      }

      move.phase = 'staged'

      return
    }

    if (move.phase !== 'offering' || move.cancelled || this.now() > move.offeredAt! + P.admission_ms) {return}

    // An authenticated controller still cannot pin local writers beyond the frozen window.
    // Participant acknowledgements may inherit the initiator's earlier deadline.
    if (!Number.isSafeInteger(ack.holdUntil) || ack.holdUntil < this.now() - P.skew_ms ||
        ack.holdUntil > this.now() + P.migration_hold_ms + P.skew_ms) {
      await this.cancel(move, 'owner_cancelled')

      return
    }

    if (!this.o.holds.extend(move.id, ack.holdUntil)) {
      await this.cancel(move, 'owner_cancelled')

      return
    }

    move.phase = 'uploading'
    move.upload = this.upload(move, session).catch(() => { void this.cancel(move, 'owner_cancelled') }).finally(() => { move.upload = undefined })
  }

  private async upload(move: Move, session: DeviceSession): Promise<void> {
    const snapshot = move.snapshot!
    const handle = await open(snapshot.archive, constants.O_RDONLY | constants.O_NOFOLLOW)

    try {
      const stat = await handle.stat()

      if (!stat.isFile() || stat.size !== snapshot.bytes) {throw Error('matrix_migration_snapshot_changed')}
      let offset = 0

      while (offset < snapshot.bytes) {
        if (!this.live(move) || move.cancelled || move.phase !== 'uploading') {return}
        const size = Math.min(P.migration_chunk_max_bytes, snapshot.bytes - offset)
        const bytes = Buffer.alloc(size)
        const read = await handle.read(bytes, 0, size, offset)

        if (read.bytesRead !== size) {throw Error('matrix_migration_snapshot_changed')}
        const connection = this.o.connection()
        const stalledAt = this.now()

        while (connection?.session() === session && this.live(move) && !move.cancelled) {
          if (connection.sendMigrationChunk(session, { migrationId: move.id, offset, size }, bytes)) {break}
          if (this.now() > stalledAt + P.admission_ms) {throw Error('matrix_migration_upload_stalled')}

          await delay(10)
        }

        if (connection?.session() !== session || move.cancelled || !this.live(move)) {return}
        offset += size

        // Mark before yielding: a staged acknowledgement can now arrive on the event loop.
        if (offset === snapshot.bytes) {move.phase = 'uploaded'}
        await delay(0)
      }
    } finally { await handle.close() }
  }

  private async report(move: Move, report: MigrationReport): Promise<void> {
    if (move.role !== 'initiator' || !move.snapshot || move.cancelled || !['uploaded', 'staged'].includes(move.phase)) {return}

    const inspected = inspectMigrationReport(report, { migrationId: move.id, agentPrincipal: move.agent.principal,
      deviceServiceId: move.deviceServiceId, archive: move.snapshot, holdUntil: this.o.holds.deadline(move.id)!, now: this.now() })

    if (!inspected.accepted) {return}
    move.phase = 'deciding'
    const choice = await this.o.confirm(move.agent, inspected.model)

    if (!this.live(move) || move.cancelled || move.phase !== 'deciding') {return}

    if (!choice) {return this.cancel(move, 'owner_cancelled')}

    if (!inspectMigrationChoice(inspected.model.choices, choice).accepted) {return this.cancel(move, 'owner_cancelled')}

    if (this.now() > report.expiresAt) {return this.cancel(move, 'owner_cancelled')}
    const connection = this.o.connection(), session = connection?.session()

    if (!session || session.deviceServiceId !== move.deviceServiceId) {
      move.phase = 'staged' // The controller resends this report on the next connection.

      return
    }

    const fields = migrationChoiceFields(inspected.model, choice)
    move.approved = true
    move.phase = 'chosen'

    if (!await connection!.send('MigrationChoose', { ...this.fields(move, session), ...fields, decidedAt: this.now() })) {move.phase = 'staged'}
  }

  private async result(move: Move, result: MigrationResult): Promise<void> {
    if (result.agentPrincipal !== move.agent.principal) {return}

    if (result.outcome === 'failed' || result.outcome === 'abandoned') {
      await this.end(move, result.outcome, `matrix_migration_${result.reason}`)

      return
    }

    if (result.outcome === 'refused') {
      // A refused cancel is not evidence the snapshot cannot commit. A refused choice keeps
      // the hold; the next report can be reviewed again, but never silently resubmitted.
      if (move.phase === 'chosen' && !move.cancelled) {move.phase = 'staged'}

      return
    }

    if (result.outcome !== 'committed' || result.homeGeneration !== 1 || !['uploaded', 'staged', 'deciding', 'chosen'].includes(move.phase)) {return}
    move.phase = 'committed'

    // Once Choose was sent, a local cancel is only a request. The controller may already
    // have committed that approved home; its authoritative result must finish the handoff.
    if (move.role === 'initiator' && move.approved && move.agent.current()) {
      await move.agent.switchToCloud()
      move.resolve({ state: 'moved', snapshot: move.snapshot ?? null, staged: true })
    }

    this.o.changed()
  }

  private async decline(move: Move, reason: 'export_failed' | 'owner_declined'): Promise<void> {
    const connection = this.o.connection(), session = connection?.session()

    if (session?.deviceServiceId === move.deviceServiceId) {await connection!.send('MigrationDecline', { ...this.fields(move, session), reason })}
  }

  private async cancel(move: Move, reason: 'owner_cancelled' | 'sign_out' | 'account_switch'): Promise<void> {
    if (move.phase === 'ended' || move.phase === 'committed') {return}
    move.cancelled = true
    const connection = this.o.connection(), session = connection?.session()

    if (session?.deviceServiceId === move.deviceServiceId && move.phase !== 'preparing') {
      await connection!.send('MigrationCancel', { ...this.fields(move, session), reason }).catch(() => false)
    }

    move.resolve({ state: 'cancelled', snapshot: move.snapshot ?? null })
    this.o.changed()
  }

  private async end(move: Move, reason: Parameters<MigrationWriterHolds['release']>[1], code: string): Promise<void> {
    if (move.phase === 'ended') {return}
    this.o.holds.release(move.id, reason)
    move.phase = 'ended'
    move.resolve(move.cancelled ? { state: 'cancelled', snapshot: move.snapshot ?? null } : { state: 'failed', step: 'stage', code })

    if (move.agent.current()) {await move.agent.restore()}
    this.o.changed()
  }

  closed(session: DeviceSession, reason: DeviceCloseReason): void {
    for (const move of this.moves.values()) {
      if (move.session !== session || move.phase === 'ended') {continue}

      if (reason === 'sign_out' || reason === 'account_switch' || reason === 'revoked' || reason === 'unenrolled') {
        void this.cancel(move, reason === 'account_switch' ? reason : 'sign_out')
      }
    }
  }

  /** Called by the desktop's ordinary service clock. Reconnect only retries partial uploads. */
  async tick(): Promise<void> {
    for (const move of this.moves.values()) {
      if (move.phase === 'ended') {continue}

      if (!this.o.holds.held(move.agent.principal)) {
        await this.end(move, 'abandoned', 'matrix_migration_expired')
      } else if (move.phase === 'offering' && this.now() > move.offeredAt! + P.admission_ms) {
        // No bytes are ever sent without 'send'; the frozen protocol treats this as refusal.
        await this.end(move, 'offer_refused', 'matrix_migration_admission_timeout')
      } else if (!move.cancelled && !move.upload && ['offering', 'uploading', 'preparing'].includes(move.phase) && move.snapshot &&
          move.session !== this.o.connection()?.session()) {
        await this.offer(move)
      }
    }
  }
}
