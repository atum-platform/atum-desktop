import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import { MATRIX_VOICE_SETTING_RULES } from '../../shared/matrix-voice-settings'
import type {
  MatrixVoiceSettingField,
  MatrixVoiceSettingKey,
  MatrixVoiceSettingsConfirmation,
  MatrixVoiceSettingsSnapshot,
  MatrixVoiceSettingsWriteResult,
  MatrixVoiceSettingValue
} from '../../shared/matrix-voice-settings'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const PREFIX = '/api/voice-settings/'
const CONFIG = '/api/config?profile=default'
const SCHEMA = '/api/config/schema?profile=default'
const FORBIDDEN = 'matrix_pages_request_forbidden'
const UNAVAILABLE = 'matrix_pages_agent_unavailable'
const INVALID = 'matrix_voice_settings_response_invalid'
const FAILED = 'matrix_voice_settings_request_failed'

function fail(code: string): never {
  throw new Error(code)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function string(value: unknown, empty = true): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= 1024 && !/[\p{Cc}]/u.test(value)
}

function key(value: unknown): value is MatrixVoiceSettingKey {
  return typeof value === 'string' && Object.hasOwn(MATRIX_VOICE_SETTING_RULES, value)
}

function valueAt(config: unknown, field: string): unknown {
  let next = config

  for (const part of field.split('.')) {
    if (!object(next)) {return undefined}
    next = next[part]
  }

  return next
}

function projected(config: unknown, schema: unknown): MatrixVoiceSettingField[] {
  if (!object(config) || !object(schema) || !object(schema.fields)) {fail(INVALID)}
  const result: MatrixVoiceSettingField[] = []

  for (const [field, rawRule] of Object.entries(MATRIX_VOICE_SETTING_RULES)) {
    const rule: { type: string; min?: number; max?: number; integer?: boolean; options?: readonly number[] } = rawRule
    const row = schema.fields[field]

    if (!object(row)) {continue}
    let type: MatrixVoiceSettingField['type']
    let options: (string | number)[] | undefined

    if (rule.type === 'provider') {
      if (row.type !== 'select' || !Array.isArray(row.options)) {fail(INVALID)}
      options = [
        ...new Set(
          row.options.filter(
            (entry): entry is string => string(entry, false) && /^[a-z0-9][a-z0-9_-]{0,199}$/.test(entry)
          )
        )
      ]

      if (!options.length) {fail(INVALID)}
      type = 'select'
    } else {
      if (row.type !== rule.type && !(rule.type === 'string' && row.type === 'select')) {fail(INVALID)}
      type = rule.type as MatrixVoiceSettingField['type']

      if (Array.isArray(row.options) && rule.type === 'string') {
        options = [...new Set(row.options.filter((entry): entry is string => string(entry)))]
        type = 'select'
      }

      if (rule.options) {
        options = [...rule.options]
        type = 'select'
      }
    }

    const raw = valueAt(config, field)

    const scalar =
      rule.type === 'boolean'
        ? typeof raw === 'boolean'
        : rule.type === 'number'
          ? typeof raw === 'number' && Number.isFinite(raw)
          : string(raw)

    let value: MatrixVoiceSettingValue | null = scalar ? (raw as MatrixVoiceSettingValue) : null

    // The editor reports Matrix's actual recording cap rather than promising a longer recording.
    if (field === 'voice.max_recording_seconds' && typeof value === 'number' && value > 0)
      {value = Math.min(120, Math.trunc(value))}

    result.push({
      key: field as MatrixVoiceSettingKey,
      type,
      value,
      ...(options ? { options } : {}),
      ...(rule.min === undefined ? {} : { min: rule.min }),
      ...(rule.max === undefined ? {} : { max: rule.max }),
      ...(rule.integer === undefined ? {} : { integer: rule.integer })
    })
  }

  return result
}

function valid(field: MatrixVoiceSettingField, value: unknown): value is MatrixVoiceSettingValue {
  if (field.type === 'boolean') {return typeof value === 'boolean'}

  if (field.options) {return field.options.some(option => option === value)}

  if (field.type === 'string') {return string(value)}

  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!field.integer || Number.isSafeInteger(value)) &&
    (field.min === undefined || value >= field.min) &&
    (field.max === undefined || value <= field.max)
  )
}

function patch(field: MatrixVoiceSettingKey, value: MatrixVoiceSettingValue): Record<string, unknown> {
  let child: unknown = value

  for (const part of field.split('.').reverse()) {child = { [part]: child }}

  return child as Record<string, unknown>
}

function exact(value: unknown, path: string, method: string, fields?: string[]): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some(field => !['path', 'method', 'body'].includes(field)) ||
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
    Object.keys(value.body).some(field => !fields.includes(field))
  )
    {fail(FORBIDDEN)}

  return value.body
}

export function isMatrixVoiceSettingsRequest(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(PREFIX)
}

export interface MatrixPagesVoiceSettingsDeps {
  isCurrent(): boolean
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  confirm(request: MatrixVoiceSettingsConfirmation): boolean | Promise<boolean>
}
export class MatrixPagesVoiceSettingsScope {
  private writing = false
  constructor(private readonly deps: MatrixPagesVoiceSettingsDeps) {}
  private current(): void {
    if (!this.deps.isCurrent()) {fail(UNAVAILABLE)}
  }
  private async forward(request: MatrixPagesForwardRequest) {
    this.current()
    const response = await this.deps.forward(request)
    this.current()

    return response
  }
  private async snapshot(): Promise<MatrixVoiceSettingsSnapshot> {
    const schema = await this.forward({ path: SCHEMA, method: 'GET' })
    const config = await this.forward({ path: CONFIG, method: 'GET' })

    return { fields: projected(config, schema) }
  }
  private async eligible(field: MatrixVoiceSettingKey, value: unknown): Promise<void> {
    const descriptor = (await this.snapshot()).fields.find(row => row.key === field)

    if (!descriptor || !valid(descriptor, value)) {fail(FORBIDDEN)}
  }
  private async set(body: Record<string, unknown>): Promise<MatrixVoiceSettingsWriteResult> {
    if (!key(body.field)) {fail(FORBIDDEN)}
    const field = body.field
    const value = body.value
    await this.eligible(field, value)
    const confirmed = await this.deps.confirm({ field, value: value as MatrixVoiceSettingValue })
    this.current()

    if (!confirmed) {return { status: 'cancelled' }}
    await this.eligible(field, value)

    const result = await this.forward({
      path: CONFIG,
      method: 'PUT',
      body: { config: patch(field, value as MatrixVoiceSettingValue) }
    })

    if (!object(result) || result.ok !== true) {fail(INVALID)}
    const config = await this.forward({ path: CONFIG, method: 'GET' })

    if (valueAt(config, field) !== value) {fail(INVALID)}

    return { status: 'applied', field, value: value as MatrixVoiceSettingValue }
  }
  async request(value: MatrixPagesRequest): Promise<MatrixVoiceSettingsSnapshot | MatrixVoiceSettingsWriteResult> {
    try {
      this.current()

      if (value?.path === `${PREFIX}snapshot`) {
        exact(value, `${PREFIX}snapshot`, 'GET')

        return await this.snapshot()
      }

      const body = exact(value, `${PREFIX}set`, 'POST', ['field', 'value'])

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
