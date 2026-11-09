import {
  MATRIX_COMMAND_LOG_FILES,
  MATRIX_COMMAND_LOG_LEVELS,
  MATRIX_COMMAND_USAGE_DAYS,
  type MatrixCommandCurator,
  type MatrixCommandHealth,
  type MatrixCommandLogFile,
  type MatrixCommandLogLevel,
  type MatrixCommandLogs,
  type MatrixCommandStatus,
  type MatrixCommandUsage,
  type MatrixCommandUsageDays
} from '../../shared/matrix-command-center'
import { redactSecrets } from '../diagnostic-redaction'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/command-center/'
interface Options {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function invalid(): never {
  throw new Error('matrix_pages_command_center_invalid_response')
}

function denied(): never {
  throw new Error('matrix_pages_request_denied')
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function health(v: unknown): MatrixCommandHealth {
  return v === 'ok' || v === 'degraded' ? v : 'unknown'
}

function status(value: unknown): MatrixCommandStatus {
  if (!record(value) || Object.hasOwn(value, 'error')) {
    return invalid()
  }

  const components = record(value.components) ? value.components : {}

  return {
    version:
      typeof value.version === 'string' &&
      /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.version) &&
      value.version.length <= 80
        ? value.version
        : null,
    gatewayRunning: bool(value.gateway_running),
    activeSessions: count(value.active_sessions),
    overall: health(value.overall),
    components: (['gateway', 'dashboard', 'storage', 'platforms'] as const).map(name => ({
      name,
      status: health(record(components[name]) ? components[name].status : undefined)
    }))
  }
}

function logs(value: unknown, file: MatrixCommandLogFile): MatrixCommandLogs {
  if (
    !record(value) ||
    value.file !== file ||
    !Array.isArray(value.lines) ||
    value.lines.some(line => typeof line !== 'string')
  ) {
    return invalid()
  }

  const lines = value.lines as string[]

  return {
    file,
    lines: lines.slice(-200).map(line => redactSecrets(line).slice(0, 4096)),
    truncated: lines.length > 200 || lines.some(line => line.length > 4096)
  }
}

function usage(value: unknown, days: MatrixCommandUsageDays): MatrixCommandUsage {
  if (
    !record(value) ||
    value.period_days !== days ||
    !record(value.totals) ||
    !Array.isArray(value.daily) ||
    !Array.isArray(value.by_model)
  ) {
    return invalid()
  }

  const totals = value.totals

  return {
    days,
    totals: {
      sessions: count(totals.total_sessions),
      calls: count(totals.total_api_calls),
      input: count(totals.total_input),
      output: count(totals.total_output)
    },
    daily: value.daily
      .slice(-days)
      .flatMap(row =>
        record(row) &&
        typeof row.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
        Number.isFinite(Date.parse(row.day))
          ? [{ day: row.day, input: count(row.input_tokens), output: count(row.output_tokens) }]
          : []
      ),
    models: value.by_model
      .slice(0, 6)
      .flatMap(row =>
        record(row) &&
        typeof row.model === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(row.model) &&
        !row.model.includes('://')
          ? [{ name: redactSecrets(row.model), input: count(row.input_tokens), output: count(row.output_tokens) }]
          : []
      )
  }
}

function curator(value: unknown): MatrixCommandCurator {
  if (!record(value) || Object.hasOwn(value, 'error')) {
    return invalid()
  }

  return {
    enabled: bool(value.enabled),
    paused: bool(value.paused),
    intervalHours: count(value.interval_hours),
    lastRunKnown:
      value.last_run_at === null ||
      (typeof value.last_run_at === 'string' &&
        value.last_run_at.length <= 64 &&
        /^\d{4}-\d{2}-\d{2}T/.test(value.last_run_at) &&
        Number.isFinite(Date.parse(value.last_run_at))),
    lastRunAt:
      typeof value.last_run_at === 'string' &&
      value.last_run_at.length <= 64 &&
      /^\d{4}-\d{2}-\d{2}T/.test(value.last_run_at) &&
      Number.isFinite(Date.parse(value.last_run_at))
        ? value.last_run_at
        : null
  }
}

export function isMatrixCommandCenterRequest(value: unknown): boolean {
  return record(value) && typeof value.path === 'string' && value.path.startsWith(PREFIX)
}

/** Native-only projection over existing reads. The renderer cannot name a home,
 * profile, source endpoint, credential, action, process or deployment path. */
export class MatrixPagesCommandCenterScope {
  constructor(private readonly options: Options) {}
  async request(
    value: unknown
  ): Promise<MatrixCommandStatus | MatrixCommandLogs | MatrixCommandUsage | MatrixCommandCurator> {
    if (
      !record(value) ||
      Object.keys(value).some(key => !['path', 'method'].includes(key)) ||
      typeof value.path !== 'string' ||
      value.path.length > 512 ||
      /[%\\#\s]/.test(value.path) ||
      value.path.includes('..') ||
      (value.method !== undefined && value.method !== 'GET')
    ) {
      return denied()
    }

    const url = new URL(value.path, 'http://pages.invalid')

    if (url.origin !== 'http://pages.invalid' || !value.path.startsWith(PREFIX)) {
      return denied()
    }

    const read = async (path: string): Promise<unknown> => {
      if (!this.options.isCurrent()) {
        throw new Error('matrix_pages_agent_unavailable')
      }

      const result = await this.options.forward({ path, method: 'GET' })

      if (!this.options.isCurrent()) {
        throw new Error('matrix_pages_agent_unavailable')
      }

      return result
    }

    try {
      if (url.pathname === PREFIX + 'status' || url.pathname === PREFIX + 'curator') {
        if (url.search || value.path.endsWith('?')) {
          return denied()
        }

        return url.pathname.endsWith('status')
          ? status(await read('/api/status?profile=default'))
          : curator(await read('/api/curator?profile=default'))
      }

      const query = url.searchParams

      const exactQuery = (keys: string[]) => {
        for (const key of query.keys()) {
          if (!keys.includes(key) || query.getAll(key).length !== 1) {
            return denied()
          }
        }
      }

      if (url.pathname === PREFIX + 'logs') {
        exactQuery(['file', 'level'])
        const file = (query.get('file') ?? 'agent') as MatrixCommandLogFile
        const level = (query.get('level') ?? 'ALL') as MatrixCommandLogLevel

        if (!MATRIX_COMMAND_LOG_FILES.includes(file) || !MATRIX_COMMAND_LOG_LEVELS.includes(level)) {
          return denied()
        }

        return logs(
          await read(`/api/logs?${new URLSearchParams({ file, level, lines: '200', profile: 'default' })}`),
          file
        )
      }

      if (url.pathname === PREFIX + 'usage') {
        exactQuery(['days'])
        const raw = query.get('days') ?? '30'
        const days = Number(raw) as MatrixCommandUsageDays

        if (!/^(7|30|90)$/.test(raw) || !MATRIX_COMMAND_USAGE_DAYS.includes(days)) {
          return denied()
        }

        return usage(await read(`/api/analytics/usage?days=${days}&profile=default`), days)
      }

      return denied()
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'matrix_pages_agent_unavailable',
          'matrix_pages_request_denied',
          'matrix_pages_command_center_invalid_response'
        ].includes(error.message)
      ) {
        throw error
      }

      throw new Error('matrix_pages_command_center_failed')
    }
  }
}
