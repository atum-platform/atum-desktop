import { AppSurfaceError } from './app-view/protocol'

/** Intake field names, per `@atum/protocol`'s `IntakeFieldNameSchema`. */
export const INTAKE_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
export const MAX_INTAKE_FIELDS = 32
export const MAX_INTAKE_FIELD_VALUE_LENGTH = 512

const MAX_INTAKE_OPTIONS = 64

export type IntakeFieldType = 'date' | 'select' | 'text' | 'time'

export interface IntakeFieldOption {
  value: string
  label: string | null
}

/**
 * One control to render. `type` and `options` come from the app's declaration
 * when the server sends one; a field the server names but does not describe
 * degrades to a plain text input rather than being guessed at.
 */
export interface IntakeFieldSpec {
  name: string
  type: IntakeFieldType
  label: string | null
  placeholder: string | null
  options: IntakeFieldOption[]
}

export interface IntakeStatus {
  complete: boolean
  fields: IntakeFieldSpec[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  return trimmed && trimmed.length <= max ? trimmed : null
}

function fieldType(value: unknown): IntakeFieldType {
  return value === 'date' || value === 'time' || value === 'select' ? value : 'text'
}

/**
 * Read the app's field declaration. Tolerant on purpose: the authoritative
 * signal is `missing[]` (pinned by `@atum/protocol`'s IntakeStatusResponse),
 * and `fields[]` is a richer description the server may or may not send.
 * A malformed `fields[]` degrades the controls, never the field list.
 */
function parseDeclaredFields(value: unknown): Map<string, IntakeFieldSpec> {
  const declared = new Map<string, IntakeFieldSpec>()

  if (!Array.isArray(value)) {
    return declared
  }

  for (const entry of value.slice(0, MAX_INTAKE_FIELDS)) {
    const field = record(entry)
    const name = field ? text(field.name, 64) : null

    if (!name || !INTAKE_FIELD_NAME_PATTERN.test(name) || declared.has(name)) {
      continue
    }

    const options: IntakeFieldOption[] = []

    if (Array.isArray(field!.options)) {
      for (const rawOption of field!.options.slice(0, MAX_INTAKE_OPTIONS)) {
        const option = record(rawOption)
        const optionValue = option ? text(option.value, MAX_INTAKE_FIELD_VALUE_LENGTH) : null

        if (optionValue && !options.some(existing => existing.value === optionValue)) {
          options.push({ value: optionValue, label: text(option!.label, 200) })
        }
      }
    }

    const type = fieldType(field!.type)

    declared.set(name, {
      name,
      // A select with nothing to select from is a broken control, not a select.
      type: type === 'select' && options.length === 0 ? 'text' : type,
      label: text(field!.label, 200),
      placeholder: text(field!.placeholder, 200),
      options
    })
  }

  return declared
}

/**
 * `{complete, missing[]}` is the contract. The form is exactly `missing[]`, in
 * server order; an app that declares nothing sends an empty array and renders
 * no form. This parser is shared by legacy app surfaces and native Matrix so
 * Matrix does not import the legacy messaging authority graph.
 */
export function parseAppIntakeStatus(value: unknown): IntakeStatus {
  const body = record(value)

  if (!body || typeof body.complete !== 'boolean') {
    throw new AppSurfaceError('intake_status_invalid')
  }

  const declared = parseDeclaredFields(body.fields)
  const fields: IntakeFieldSpec[] = []

  if (Array.isArray(body.missing)) {
    for (const entry of body.missing.slice(0, MAX_INTAKE_FIELDS)) {
      const name = text(entry, 64)

      if (!name || !INTAKE_FIELD_NAME_PATTERN.test(name) || fields.some(field => field.name === name)) {
        continue
      }

      fields.push(declared.get(name) ?? { name, type: 'text', label: null, placeholder: null, options: [] })
    }
  }

  // `complete` and a non-empty `missing[]` cannot both be true. Trust the
  // missing fields: showing a dismissible form is safer than stranding setup.
  return { complete: body.complete && fields.length === 0, fields }
}
