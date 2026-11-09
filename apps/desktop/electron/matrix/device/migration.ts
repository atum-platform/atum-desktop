/**
 * Moving one agent from this Mac's local brain to the cloud brain (S1 WS-3b; plan §5 "Migration",
 * build plan WS-3b `device/migration.ts`, acceptance test 10).
 *
 *  1. Inventory every writer of the agent on this Mac: its local executor and Hermes, its scheduled
 *     jobs, the answering lease, continuous listening, messaging gateways.
 *  2. Quiesce them.
 *  3. Snapshot its Hermes home privately (`python -m hermes_cli.atum_home export`: one consistent
 *     SQLite backup, the hydration allowlist, never settings or credentials).
 *  4. Hand the snapshot to the cloud for reconciliation, when the staging channel exists.
 *  5. Make sure its cloud enrollment is trusted (`cloud_enrollment_required` otherwise).
 *  6. Ask the owner, naming what moves and what stays.
 *  7. Switch it to the cloud (`POST /agents/{p}/answering`): DA fences every local entry point and
 *     revokes the local executors in the same transaction, so the old writers cannot write again.
 *
 * Anything that fails before the switch puts the local writers back, so nothing regresses: the
 * agent keeps answering here. After the switch the local writers stay off for good (DA refuses
 * them anyway). Every step is journaled in the device store for diagnosis.
 *
 * S1 gap (recorded in the session log): `atum.device-service/1` has no message that carries a home
 * snapshot to the controller, so `stage` is absent in this build. The snapshot then stays on this
 * Mac as a backup, the owner is told so, and the agent starts with a fresh cloud home.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { MatrixCloudMoveOutcome } from '../../../shared/matrix'

import type { DeviceStateStore } from './epochs'

/** What writes this agent on this Mac right now. */
export interface AgentWriters {
  /** An enrolled local executor (its Matrix device here, and a Hermes for it). */
  executor: boolean
  /** Hermes scheduled jobs run on this Mac (the `matrix-run-jobs` vault key). */
  cron: boolean
  /** This Mac holds or seeks the agent's answering lease. */
  lease: boolean
  /** Continuous listening is on for one of its rooms. */
  listening: boolean
  /** Messaging gateways answering as this agent from this Mac. */
  gateways: string[]
}

/** The agent's Hermes home snapshot: `archive` is on this Mac (mode 0600, under the device's own
 * folder). The shapes are the renderer's too (`shared/matrix.ts`). */
export type MigrationSnapshot = NonNullable<Extract<MatrixCloudMoveOutcome, { state: 'moved' }>['snapshot']>

export type MigrationStep = Extract<MatrixCloudMoveOutcome, { state: 'failed' }>['step']

export type MigrationOutcome = MatrixCloudMoveOutcome

export interface MigrationPlan {
  agentName: string
  writers: AgentWriters
  snapshot: MigrationSnapshot | null
  /** True when the snapshot reaches the cloud; false keeps it on this Mac as a backup. */
  staged: boolean
}

export interface MigrationCloudEnrollment {
  enrollmentId: string
  /** Whether this move issued the enrollment create, rather than reusing one already there. */
  created: boolean
}

export interface AgentMigrationDeps {
  agentPrincipal: string
  agentName: string
  writers(): AgentWriters
  /** Stop every writer `writers()` names. Idempotent. */
  quiesce(): Promise<void>
  /** Put them back (the move did not happen). */
  restore(): Promise<void>
  /** The agent's Hermes home on this Mac, or null when it has none. */
  hermesHome(): string | null
  exportHome(home: string, archive: string): Promise<{ files: number; bytes: number }>
  /** The snapshot's way to the cloud's staging area. Absent in S1 (no contract carries it yet). */
  stage?(snapshot: MigrationSnapshot, signal: AbortSignal): Promise<void>
  /** Create or reuse this agent's enrollment, reporting whether this move created it. */
  beginCloudEnrollment(signal: AbortSignal): Promise<MigrationCloudEnrollment>
  /** Wait until that enrollment is trusted. */
  waitCloudEnrollment(signal: AbortSignal): Promise<void>
  /** Revoke an enrollment this move created. Uses its own bounded cleanup signal. */
  revokeCloudEnrollment(enrollmentId: string): Promise<void>
  /** The owner's decision, shown natively with what moves and what stays. */
  confirm(plan: MigrationPlan): Promise<boolean>
  /** The switch to `cloud` (an agent already in the cloud is a success). */
  switchToCloud(signal: AbortSignal): Promise<void>
  /** Where snapshots are kept on this Mac (the device's own folder, never the synced Drive). */
  stagingDir: string
  store: DeviceStateStore
  now?(): number
  log(line: string): void
}

const JOURNAL = (agent: string) => `device-migration-v1:${agent}`

/** Runs the Python home tool from the bundled runtime: standard library only, no network. */
export function exportAgentHome(
  runtime: { python: string; source: string },
  home: string,
  archive: string,
  run: typeof execFile = execFile
): Promise<{ files: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    run(
      runtime.python,
      ['-s', '-P', '-B', '-m', 'hermes_cli.atum_home', 'export', '--home', home, '--out', archive],
      {
        cwd: runtime.source,
        env: { PYTHONPATH: runtime.source, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', LANG: 'en_US.UTF-8' },
        timeout: 10 * 60_000,
        maxBuffer: 1_048_576,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('matrix_migration_export_failed'))

          return
        }

        try {
          const value = JSON.parse(String(stdout).trim().split('\n').pop() ?? '') as {
            files?: unknown
            bytes?: unknown
          }

          if (!Number.isSafeInteger(value.files) || !Number.isSafeInteger(value.bytes)) {
            throw new Error('invalid')
          }

          resolve({ files: value.files as number, bytes: value.bytes as number })
        } catch {
          reject(new Error('matrix_migration_export_failed'))
        }
      }
    )
  })
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
  }

  return hash.digest('hex')
}

export class AgentMigration {
  private running?: Promise<MigrationOutcome>

  constructor(private readonly deps: AgentMigrationDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private journal(step: MigrationStep, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.store.setItem(
        JOURNAL(this.deps.agentPrincipal),
        JSON.stringify({ v: 1, agent: this.deps.agentPrincipal, step, at: this.now(), ...extra })
      )
    } catch {
      // The journal is for diagnosis; a vault failure never blocks the owner's decision.
    }
  }

  /** The last journaled step for this agent, if any. */
  last(): { step: MigrationStep; at: number; outcome?: string } | null {
    try {
      const raw = this.deps.store.getItem(JOURNAL(this.deps.agentPrincipal))

      return raw ? (JSON.parse(raw) as { step: MigrationStep; at: number; outcome?: string }) : null
    } catch {
      return null
    }
  }

  /** One move at a time per agent. */
  run(signal: AbortSignal): Promise<MigrationOutcome> {
    this.running ??= this.move(signal).finally(() => {
      this.running = undefined
    })

    return this.running
  }

  private async move(signal: AbortSignal): Promise<MigrationOutcome> {
    let step: MigrationStep = 'inventory'
    let quiesced = false
    let snapshot: MigrationSnapshot | null = null
    let staged = false
    let createdEnrollmentId: string | undefined

    const restore = async (): Promise<void> => {
      if (createdEnrollmentId) {
        const enrollmentId = createdEnrollmentId
        createdEnrollmentId = undefined

        try {
          await this.deps.revokeCloudEnrollment(enrollmentId)
        } catch (error) {
          const code = error instanceof Error && /^[a-z_:0-9]+$/.test(error.message) ? error.message : 'unexpected'
          this.deps.log(
            `[Device] migration of ${this.deps.agentPrincipal.slice(0, 8)}: cloud enrollment cleanup pending: ${code}`
          )
        }
      }

      await this.deps.restore()
    }

    const fail = async (code: string): Promise<MigrationOutcome> => {
      if (quiesced) {
        try {
          await restore()
        } catch {
          this.deps.log(`[Device] migration of ${this.deps.agentPrincipal.slice(0, 8)}: local writers not restored`)
        }
      }

      this.journal(step, { outcome: 'failed', code })
      this.deps.log(`[Device] migration of ${this.deps.agentPrincipal.slice(0, 8)} stopped at ${step}: ${code}`)

      return { state: 'failed', step, code }
    }

    try {
      const writers = this.deps.writers()
      this.journal(step, { writers })

      step = 'quiesce'
      this.journal(step)
      quiesced = true
      await this.deps.quiesce()
      signal.throwIfAborted()

      step = 'snapshot'
      this.journal(step)
      const home = this.deps.hermesHome()

      if (home) {
        await mkdir(this.deps.stagingDir, { recursive: true, mode: 0o700 })
        const archive = path.join(this.deps.stagingDir, `${this.deps.agentPrincipal}-${this.now()}.atum-home`)
        const exported = await this.deps.exportHome(home, archive)
        const size = (await stat(archive)).size
        snapshot = { archive, sha256: await fileSha256(archive), bytes: size, files: exported.files }
        this.journal(step, { archive, sha256: snapshot.sha256, bytes: snapshot.bytes, files: snapshot.files })
      }

      signal.throwIfAborted()

      if (snapshot && this.deps.stage) {
        step = 'stage'
        this.journal(step)
        await this.deps.stage(snapshot, signal)
        staged = true
      }

      step = 'cloud_enrollment'
      this.journal(step)
      const enrollment = await this.deps.beginCloudEnrollment(signal)
      createdEnrollmentId = enrollment.created ? enrollment.enrollmentId : undefined
      await this.deps.waitCloudEnrollment(signal)
      signal.throwIfAborted()

      step = 'confirm'
      this.journal(step)

      if (!(await this.deps.confirm({ agentName: this.deps.agentName, writers, snapshot, staged }))) {
        if (quiesced) {
          await restore()
        }

        this.journal(step, { outcome: 'cancelled' })

        return { state: 'cancelled', snapshot }
      }

      step = 'switch'
      this.journal(step)
      await this.deps.switchToCloud(signal)
      // From here the local writers stay off: DA has fenced and revoked them.
      quiesced = false

      step = 'done'
      this.journal(step, { outcome: 'moved', staged })
      this.deps.log(`[Device] agent ${this.deps.agentPrincipal.slice(0, 8)} now answers in the cloud`)

      return { state: 'moved', snapshot, staged }
    } catch (error) {
      return fail(error instanceof Error && /^[a-z_:0-9]+$/.test(error.message) ? error.message : 'unexpected')
    }
  }
}

// ------------------------------------------------------------------ the owner's confirmation

type MigrationLocale = 'vi' | 'en' | 'zh' | 'zh-hant' | 'ja'

interface MigrationCopy {
  title: (name: string) => string
  detail: (name: string, staged: boolean, backup: string | null) => string
  move: string
  cancel: string
}

const COPY: Record<MigrationLocale, MigrationCopy> = {
  vi: {
    title: name => `Chuyển ${name} lên đám mây?`,
    detail: (name, staged, backup) =>
      staged
        ? `${name} chuyển lên đám mây; tệp và công cụ Mac ở lại đây.`
        : backup
          ? `${name} chuyển không kèm trí nhớ hiện tại; bản sao ở ${backup}.`
          : `${name} chuyển không kèm trí nhớ hiện tại; tệp và công cụ Mac ở lại đây.`,
    move: 'Chuyển lên đám mây',
    cancel: 'Để sau'
  },
  en: {
    title: name => `Move ${name} to the cloud?`,
    detail: (name, staged, backup) =>
      staged
        ? `${name} moves to cloud; Mac-only files and tools stay here.`
        : backup
          ? `${name} moves without current memory; its backup stays at ${backup}.`
          : `${name} moves without current memory; Mac-only files and tools stay here.`,
    move: 'Move to the cloud',
    cancel: 'Not now'
  },
  zh: {
    title: name => `将 ${name} 移到云端？`,
    detail: (name, staged, backup) =>
      staged
        ? `${name} 移到云端；Mac 专属文件和工具留在这里。`
        : backup
          ? `${name} 不带当前记忆移到云端；备份留在 ${backup}。`
          : `${name} 不带当前记忆移到云端；Mac 专属文件和工具留在这里。`,
    move: '移到云端',
    cancel: '以后再说'
  },
  'zh-hant': {
    title: name => `將 ${name} 移到雲端？`,
    detail: (name, staged, backup) =>
      staged
        ? `${name} 移到雲端；Mac 專屬檔案和工具留在這裡。`
        : backup
          ? `${name} 不帶目前記憶移到雲端；備份留在 ${backup}。`
          : `${name} 不帶目前記憶移到雲端；Mac 專屬檔案和工具留在這裡。`,
    move: '移到雲端',
    cancel: '稍後再說'
  },
  ja: {
    title: name => `${name} をクラウドに移しますか？`,
    detail: (name, staged, backup) =>
      staged
        ? `${name} をクラウドへ移し、Mac 専用のファイルとツールはここに残します。`
        : backup
          ? `${name} は現在の記憶なしで移り、バックアップは ${backup} に残ります。`
          : `${name} は現在の記憶なしで移り、Mac 専用のファイルとツールはここに残ります。`,
    move: 'クラウドに移す',
    cancel: 'あとで'
  }
}

/** The confirmation's words in `locale` (Vietnamese by default). */
export function migrationConfirmCopy(locale: string | undefined, plan: MigrationPlan) {
  const copy = COPY[(Object.hasOwn(COPY, locale ?? '') ? locale : 'vi') as MigrationLocale]
  const backup = plan.snapshot && !plan.staged ? plan.snapshot.archive : null

  return {
    title: copy.title(plan.agentName),
    detail: copy.detail(plan.agentName, plan.staged, backup),
    move: copy.move,
    cancel: copy.cancel
  }
}
