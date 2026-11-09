import type { MatrixCuratorAction, MatrixCuratorResult, MatrixCuratorStatus } from '../../shared/matrix-curator'
import { redactSecrets } from '../diagnostic-redaction'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/command-center/curator/'
interface Options {
  home: string
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(action: MatrixCuratorAction): Promise<boolean>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code: string): never {
  throw new Error(code)
}

export function isMatrixCuratorRequest(value: unknown): boolean {
  return record(value) && typeof value.path === 'string' && value.path.startsWith(PREFIX)
}

export class MatrixPagesCuratorScope {
  private writing = false
  constructor(private readonly options: Options) {}
  private current() {
    if (!this.options.isCurrent()) {
      fail('pages_agent_unavailable')
    }
  }
  private async forward(request: MatrixPagesForwardRequest) {
    this.current()
    const result = await this.options.forward(request)
    this.current()

    return result
  }
  private async read(): Promise<MatrixCuratorStatus> {
    const [config, run] = await Promise.all([
      this.forward({ path: '/api/curator?profile=default', method: 'GET' }),
      this.forward({ path: '/api/actions/curator-run/status?profile=default&lines=200', method: 'GET' })
    ])

    if (
      !record(config) ||
      config.profile_scoped !== true ||
      typeof config.enabled !== 'boolean' ||
      typeof config.paused !== 'boolean' ||
      typeof config.consolidate !== 'boolean' ||
      !(
        config.last_run_at === null ||
        (typeof config.last_run_at === 'string' &&
          config.last_run_at.length <= 64 &&
          /^\d{4}-\d{2}-\d{2}T/.test(config.last_run_at) &&
          Number.isFinite(Date.parse(config.last_run_at)))
      ) ||
      !record(run) ||
      run.profile_scoped !== true ||
      run.name !== 'curator-run' ||
      typeof run.running !== 'boolean' ||
      !(run.exit_code === null || (typeof run.exit_code === 'number' && Number.isSafeInteger(run.exit_code))) ||
      (run.running && run.exit_code !== null) ||
      !Array.isArray(run.lines) ||
      run.lines.some(line => typeof line !== 'string')
    ) {
      fail('matrix_curator_unavailable')
    }

    const lines = run.lines as string[]

    return {
      enabled: config.enabled,
      paused: config.paused,
      consolidate: config.consolidate,
      intervalHours:
        typeof config.interval_hours === 'number' &&
        Number.isSafeInteger(config.interval_hours) &&
        config.interval_hours > 0
          ? config.interval_hours
          : null,
      lastRunAt: config.last_run_at as string | null,
      run: {
        state: run.running
          ? 'running'
          : run.exit_code === null
            ? 'unknown'
            : run.exit_code === 0
              ? 'succeeded'
              : 'failed',
        lines: lines
          .slice(-200)
          .map(line => redactSecrets(line).split(this.options.home).join('[agent home]').slice(0, 4096)),
        truncated: lines.length > 200 || lines.some(line => line.length > 4096)
      }
    }
  }
  async request(value: unknown): Promise<MatrixCuratorStatus | MatrixCuratorResult> {
    this.current()

    if (
      !record(value) ||
      Object.keys(value).some(key => !['path', 'method'].includes(key)) ||
      typeof value.path !== 'string'
    ) {
      fail('matrix_pages_request_denied')
    }

    if (value.path === PREFIX + 'status' && value.method === 'GET') {
      return this.read()
    }

    const action = value.path.slice(PREFIX.length)

    if (!value.path.startsWith(PREFIX) || value.method !== 'POST' || !['pause', 'resume', 'run'].includes(action)) {
      fail('matrix_pages_request_denied')
    }

    if (this.writing) {
      fail('pages_agent_busy')
    }

    this.writing = true

    try {
      // Capability is proven before any irreversible selected-home mutation.
      const before = await this.read()

      if (action === 'run' && before.run.state === 'running') {
        return { status: 'completed', value: before }
      }

      if (!(await this.options.confirm(action as MatrixCuratorAction))) {
        this.current()

        return { status: 'cancelled' }
      }

      this.current()

      const result = await this.forward(
        action === 'run'
          ? { path: '/api/curator/run?profile=default', method: 'POST' }
          : { path: '/api/curator/paused?profile=default', method: 'PUT', body: { paused: action === 'pause' } }
      )

      if (
        !record(result) ||
        result.ok !== true ||
        result.profile_scoped !== true ||
        (action === 'run' ? result.name !== 'curator-run' : result.paused !== (action === 'pause'))
      ) {
        fail('matrix_curator_unavailable')
      }

      const after = await this.read()

      if (action !== 'run' && after.paused !== (action === 'pause')) {
        fail('matrix_curator_unavailable')
      }

      return { status: 'completed', value: after }
    } catch {
      this.current()
      // A lost response does not prove the selected command made no changes.
      fail('matrix_curator_unavailable')
    } finally {
      this.writing = false
    }
  }
}
