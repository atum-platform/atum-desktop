import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import { MATRIX_CAPTURE_MODES, MATRIX_TERMINAL_BACKENDS } from '../../shared/matrix-tool-settings'
import type {
  MatrixTerminalBackend,
  MatrixToolSetting,
  MatrixToolSettingsConfirmation,
  MatrixToolSettingsResult,
  MatrixToolSettingsSnapshot,
  MatrixToolSettingValue
} from '../../shared/matrix-tool-settings'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/tool-settings/'
const CONFIG = '/api/config?profile=default'
const SCHEMA = '/api/config/schema?profile=default'
const BACKENDS = '/api/tools/terminal/backends?profile=default'
const SET_BACKEND = '/api/tools/terminal/backend?profile=default'
const FORBIDDEN = 'matrix_pages_request_forbidden'
const UNAVAILABLE = 'matrix_pages_agent_unavailable'
const INVALID = 'matrix_tool_settings_response_invalid'
const FAILED = 'matrix_tool_settings_request_failed'

function fail(code: string): never {
  throw new Error(code)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function backend(value: unknown): value is MatrixTerminalBackend {
  return typeof value === 'string' && MATRIX_TERMINAL_BACKENDS.some(id => id === value)
}

function field(value: unknown): value is MatrixToolSetting {
  return ['terminal.backend', 'computer_use.max_image_dimension', 'computer_use.capture_after_mode'].includes(
    value as string
  )
}

function at(config: unknown, key: string): unknown {
  let next = config

  for (const part of key.split('.')) {
    if (!object(next)) {return undefined}
    next = next[part]
  }

  return next
}

function exact(value: unknown, path: string, method: string, fields?: string[]): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some(key => !['path', 'method', 'body'].includes(key)) ||
    value.path !== path ||
    (value.method ?? 'GET') !== method
  )
    {fail(FORBIDDEN)}

  if (!fields) {
    if (value.body !== undefined) {fail(FORBIDDEN)}

    return {}
  }

  if (
    !object(value.body) ||
    Object.keys(value.body).length !== fields.length ||
    Object.keys(value.body).some(key => !fields.includes(key))
  )
    {fail(FORBIDDEN)}

  return value.body
}

export function isMatrixToolSettingsRequest(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(PREFIX)
}

export interface MatrixPagesToolSettingsDeps {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(request: MatrixToolSettingsConfirmation): boolean | Promise<boolean>
}
export class MatrixPagesToolSettingsScope {
  private writing = false
  constructor(private readonly deps: MatrixPagesToolSettingsDeps) {}
  private current() {
    if (!this.deps.isCurrent()) {fail(UNAVAILABLE)}
  }
  private async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    this.current()
    const value = await this.deps.forward(request)
    this.current()

    return value
  }
  private async snapshot(): Promise<MatrixToolSettingsSnapshot> {
    const terminal = await this.forward({ path: BACKENDS, method: 'GET' })
    const schema = await this.forward({ path: SCHEMA, method: 'GET' })
    const config = await this.forward({ path: CONFIG, method: 'GET' })

    if (
      !object(terminal) ||
      !Array.isArray(terminal.backends) ||
      !object(schema) ||
      !object(schema.fields) ||
      !object(config)
    )
      {fail(INVALID)}

    const backends: MatrixToolSettingsSnapshot['backends'] = []

    for (const row of terminal.backends) {
      if (
        !object(row) ||
        !backend(row.name) ||
        !['ready', 'needs_setup', 'unavailable'].includes(row.status as string) ||
        backends.some(entry => entry.id === row.name)
      )
        {fail(INVALID)}

      backends.push({ id: row.name, status: row.status as MatrixToolSettingsSnapshot['backends'][number]['status'] })
    }

    if (!backends.length) {fail(INVALID)}
    const configured = at(config, 'terminal.backend')
    const dimension = at(config, 'computer_use.max_image_dimension')
    const mode = at(config, 'computer_use.capture_after_mode')
    const dimensionSchema = schema.fields['computer_use.max_image_dimension']
    const modeSchema = schema.fields['computer_use.capture_after_mode']

    return {
      configuredBackend: backend(configured) ? configured : null,
      backends,
      capture: {
        maxImageDimension:
          typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension >= 0 ? dimension : null,
        mode: MATRIX_CAPTURE_MODES.some(option => option === mode)
          ? (mode as MatrixToolSettingsSnapshot['capture']['mode'])
          : null,
        dimensionEditable: object(dimensionSchema) && dimensionSchema.type === 'number',
        modeEditable: object(modeSchema) && ['string', 'select'].includes(modeSchema.type as string)
      }
    }
  }
  private async eligible(field: MatrixToolSetting, value: unknown): Promise<void> {
    const state = await this.snapshot()

    const valid =
      field === 'terminal.backend'
        ? backend(value) && state.backends.some(row => row.id === value)
        : field === 'computer_use.max_image_dimension'
          ? state.capture.dimensionEditable &&
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 4096
          : state.capture.modeEditable && MATRIX_CAPTURE_MODES.some(mode => mode === value)

    if (!valid) {fail(FORBIDDEN)}
  }
  private async set(body: Record<string, unknown>): Promise<MatrixToolSettingsResult> {
    if (!field(body.field)) {fail(FORBIDDEN)}
    const fieldName = body.field
    const value = body.value
    await this.eligible(fieldName, value)
    const confirmed = await this.deps.confirm({ field: fieldName, value: value as MatrixToolSettingValue })
    this.current()

    if (!confirmed) {return { status: 'cancelled' }}
    await this.eligible(fieldName, value)

    const result = await this.forward(
      fieldName === 'terminal.backend'
        ? { path: SET_BACKEND, method: 'PUT', body: { backend: value } }
        : { path: CONFIG, method: 'PUT', body: { config: { computer_use: { [fieldName.split('.')[1]]: value } } } }
    )

    if (!object(result) || result.ok !== true || (fieldName === 'terminal.backend' && result.backend !== value))
      {fail(INVALID)}

    const readback = await this.forward({ path: CONFIG, method: 'GET' })

    if (at(readback, fieldName) !== value) {fail(INVALID)}

    return { status: 'applied', field: fieldName, value: value as MatrixToolSettingValue }
  }
  async request(request: MatrixPagesRequest): Promise<MatrixToolSettingsSnapshot | MatrixToolSettingsResult> {
    try {
      this.current()

      if (request?.path === PREFIX + 'snapshot') {
        exact(request, PREFIX + 'snapshot', 'GET')

        return await this.snapshot()
      }

      const body = exact(request, PREFIX + 'set', 'POST', ['field', 'value'])

      if (this.writing) {fail(FAILED)}
      this.writing = true

      try {
        return await this.set(body)
      } finally {
        this.writing = false
      }
    } catch (error) {
      fail(
        error instanceof Error && [FORBIDDEN, UNAVAILABLE, INVALID, FAILED].includes(error.message)
          ? error.message
          : FAILED
      )
    }
  }
}
