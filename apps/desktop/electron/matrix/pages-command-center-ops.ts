import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import type {
  MatrixLocalAction,
  MatrixLocalActionResult,
  MatrixLocalActionStatus
} from '../../shared/matrix-command-center-ops'
import { redactSecrets } from '../diagnostic-redaction'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/command-center/maintenance/'
const DENIED = 'matrix_pages_request_denied'
const UNAVAILABLE = 'matrix_pages_agent_unavailable'
const INVALID = 'matrix_local_maintenance_invalid_response'
const FAILED = 'matrix_local_maintenance_failed'
interface Options {
  home: string
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(action: MatrixLocalAction): Promise<boolean>
  reveal(path: string): void
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code: string): never {
  throw new Error(code)
}

export function isMatrixCommandCenterOpsRequest(value: unknown): boolean {
  return record(value) && typeof value.path === 'string' && value.path.startsWith(PREFIX)
}

/** Only two fixed local actions. Current native scope owns process, profile and
 * archive custody. Neither a PID nor a filesystem path crosses into the page. */
export class MatrixPagesCommandCenterOpsScope {
  private writing = false
  constructor(private readonly options: Options) {}
  private current(): void {
    if (!this.options.isCurrent()) {
      fail(UNAVAILABLE)
    }
  }
  private async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    this.current()
    const result = await this.options.forward(request)
    this.current()

    return result
  }
  private async archive(value: unknown): Promise<string | undefined> {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      return undefined
    }

    const home = path.resolve(this.options.home)
    const directory = path.join(home, 'backups')

    if (
      path.dirname(value) !== directory ||
      !/^hermes-backup-\d{4}-\d{2}-\d{2}-\d{6}-[a-f0-9]{8}\.zip$/.test(path.basename(value))
    ) {
      return undefined
    }

    try {
      const [resolvedHome, resolvedDirectory, resolvedArchive, stat] = await Promise.all([
        realpath(home),
        realpath(directory),
        realpath(value),
        lstat(value)
      ])

      this.current()

      if (
        resolvedDirectory !== path.join(resolvedHome, 'backups') ||
        resolvedArchive !== path.join(resolvedDirectory, path.basename(value)) ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 22 ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      ) {
        return undefined
      }

      return value
    } catch {
      this.current()

      return undefined
    }
  }
  private async read(action: MatrixLocalAction): Promise<{ value: MatrixLocalActionStatus; archive?: string }> {
    const raw = await this.forward({ path: `/api/actions/${action}/status?lines=200&profile=default`, method: 'GET' })

    if (
      !record(raw) ||
      raw.name !== action ||
      raw.profile_scoped !== true ||
      typeof raw.running !== 'boolean' ||
      !Array.isArray(raw.lines) ||
      raw.lines.some(line => typeof line !== 'string') ||
      !(raw.exit_code === null || (typeof raw.exit_code === 'number' && Number.isSafeInteger(raw.exit_code))) ||
      (raw.running && raw.exit_code !== null)
    ) {
      fail(INVALID)
    }

    const state = raw.running
      ? 'running'
      : raw.exit_code === null
        ? 'unknown'
        : raw.exit_code === 0
          ? 'succeeded'
          : 'failed'

    const archive =
      action === 'backup' && state === 'succeeded' && raw.profile_only === true
        ? await this.archive(raw.archive)
        : undefined

    const lines = raw.lines as string[]

    return {
      value: {
        action,
        state,
        lines: lines
          .slice(-200)
          .map(line => redactSecrets(line).split(this.options.home).join('[agent home]').slice(0, 4096)),
        truncated: lines.length > 200 || lines.some(line => line.length > 4096),
        backupAvailable: Boolean(archive)
      },
      archive
    }
  }
  private async run(action: MatrixLocalAction): Promise<MatrixLocalActionResult> {
    this.current()

    if (!(await this.options.confirm(action))) {
      this.current()

      return { status: 'cancelled' }
    }

    this.current()
    const before = await this.read(action)

    if (before.value.state === 'running') {
      return { status: 'started', value: before.value }
    }

    const result = await this.forward({
      path: `/api/ops/${action}?profile=default`,
      method: 'POST',
      ...(action === 'backup' ? { body: {} } : {})
    })

    if (
      !record(result) ||
      result.ok !== true ||
      result.name !== action ||
      typeof result.pid !== 'number' ||
      !Number.isSafeInteger(result.pid) ||
      result.pid <= 0
    ) {
      fail(INVALID)
    }

    return { status: 'started', value: (await this.read(action)).value }
  }
  async request(value: unknown): Promise<MatrixLocalActionStatus | MatrixLocalActionResult | { revealed: true }> {
    if (
      !record(value) ||
      Object.keys(value).some(key => !['path', 'method'].includes(key)) ||
      typeof value.path !== 'string'
    ) {
      fail(DENIED)
    }

    const method = value.method ?? 'GET'
    const match = /^\/api\/command-center\/maintenance\/(doctor|backup)\/(status|run)$/.exec(value.path)
    const reveal = value.path === PREFIX + 'backup/reveal'

    if (
      (!match && !reveal) ||
      (match && method !== (match[2] === 'status' ? 'GET' : 'POST')) ||
      (reveal && method !== 'POST')
    ) {
      fail(DENIED)
    }

    this.current()

    try {
      if (match?.[2] === 'status') {
        return (await this.read(match[1] as MatrixLocalAction)).value
      }

      if (this.writing) {
        fail('matrix_local_maintenance_busy')
      }

      this.writing = true

      try {
        if (reveal) {
          const result = await this.read('backup')
          this.current()

          if (!result.archive) {
            fail('matrix_local_backup_unavailable')
          }

          this.options.reveal(result.archive)

          return { revealed: true }
        }

        return await this.run(match![1] as MatrixLocalAction)
      } finally {
        this.writing = false
      }
    } catch (error) {
      if (
        error instanceof Error &&
        [DENIED, UNAVAILABLE, INVALID, 'matrix_local_maintenance_busy', 'matrix_local_backup_unavailable'].includes(
          error.message
        )
      ) {
        throw error
      }

      fail(FAILED)
    }
  }
}
