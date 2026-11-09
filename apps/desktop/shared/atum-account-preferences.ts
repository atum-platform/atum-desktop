export interface AtumPetBinding {
  ref:
    | null
    | { kind: 'personal'; pet_id: string }
    | { kind: 'catalog'; item_id: string }
    | { kind: 'bundled' | 'petdex'; slug: string }
  enabled: boolean
  scale: number
}
export interface AtumAccountPreferences {
  schema_version: 1
  app?: {
    language?: 'vi' | 'en'
    appearance_mode?: 'system' | 'light' | 'dark'
    text_size_percent?: number
    notifications?: {
      enabled: boolean
      kinds: Record<'approval' | 'input' | 'turnDone' | 'turnError' | 'backgroundDone' | 'credits', boolean>
    }
    completion_sound_variant?: number
    pet_roaming?: boolean
  }
  roster?: { pins: string[]; order: string[] }
  chat_pins?: string[]
  assistants?: Record<string, { pet: AtumPetBinding }>
}
export interface AtumCloudPreferences {
  accountId: string
  revision: number
  snapshot: AtumAccountPreferences
}
export interface AtumPreferencesStatus extends AtumCloudPreferences {
  status: 'pending' | 'synced' | 'error'
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const slug = /^[a-z0-9][a-z0-9._-]{0,79}$/u
function invalid(): never {
  throw new Error('invalid_account_preferences')
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid()
  }
  if (Object.keys(value).some(key => !keys.includes(key))) {
    return invalid()
  }

  return value as Record<string, unknown>
}
function bool(value: unknown) {
  if (typeof value !== 'boolean') {
    invalid()
  }
}
function ids(value: unknown, max: number) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    new Set(value).size !== value.length ||
    value.some(id => typeof id !== 'string' || !uuid.test(id))
  ) {
    invalid()
  }
}
export function parsePetBinding(value: unknown): AtumPetBinding {
  const row = object(value, ['ref', 'enabled', 'scale'])
  bool(row.enabled)
  if (typeof row.scale !== 'number' || !Number.isFinite(row.scale) || row.scale < 0.1 || row.scale > 3) {
    invalid()
  }
  if (row.ref !== null) {
    const ref = object(row.ref, ['kind', 'pet_id', 'item_id', 'slug'])
    const key =
      ref.kind === 'personal'
        ? 'pet_id'
        : ref.kind === 'catalog'
          ? 'item_id'
          : ['bundled', 'petdex'].includes(String(ref.kind))
            ? 'slug'
            : invalid()
    if (
      Object.keys(ref).length !== 2 ||
      typeof ref[key] !== 'string' ||
      !(key === 'pet_id' ? uuid : slug).test(ref[key] as string)
    ) {
      invalid()
    }
  }

  return structuredClone(row) as unknown as AtumPetBinding
}
/** A narrow wire allowlist: never serialize config.yaml or localStorage wholesale. */
export function parseAccountPreferences(value: unknown): AtumAccountPreferences {
  const row = object(value, ['schema_version', 'app', 'roster', 'chat_pins', 'assistants'])
  if (row.schema_version !== 1 || new TextEncoder().encode(JSON.stringify(row)).byteLength > 32_768) {
    invalid()
  }
  if (row.app !== undefined) {
    const app = object(row.app, [
      'language',
      'appearance_mode',
      'text_size_percent',
      'notifications',
      'completion_sound_variant',
      'pet_roaming'
    ])
    if (app.language !== undefined && !['vi', 'en'].includes(String(app.language))) {
      invalid()
    }
    if (app.appearance_mode !== undefined && !['system', 'light', 'dark'].includes(String(app.appearance_mode))) {
      invalid()
    }
    if (
      app.text_size_percent !== undefined &&
      (!Number.isInteger(app.text_size_percent) ||
        Number(app.text_size_percent) < 19 ||
        Number(app.text_size_percent) > 516)
    ) {
      invalid()
    }
    if (
      app.completion_sound_variant !== undefined &&
      (!Number.isInteger(app.completion_sound_variant) ||
        Number(app.completion_sound_variant) < 1 ||
        Number(app.completion_sound_variant) > 14)
    ) {
      invalid()
    }
    if (app.pet_roaming !== undefined) {
      bool(app.pet_roaming)
    }
    if (app.notifications !== undefined) {
      const prefs = object(app.notifications, ['enabled', 'kinds'])
      bool(prefs.enabled)
      const names = ['approval', 'input', 'turnDone', 'turnError', 'backgroundDone', 'credits']
      const kinds = object(prefs.kinds, names)
      if (Object.keys(kinds).length !== names.length) {
        invalid()
      }
      Object.values(kinds).forEach(bool)
    }
  }
  if (row.roster !== undefined) {
    const roster = object(row.roster, ['pins', 'order'])
    ids(roster.pins, 200)
    ids(roster.order, 200)
  }
  if (row.chat_pins !== undefined) {
    ids(row.chat_pins, 5)
  }
  if (row.assistants !== undefined) {
    if (!row.assistants || typeof row.assistants !== 'object' || Array.isArray(row.assistants)) {
      invalid()
    }
    const entries = Object.entries(row.assistants)
    if (entries.length > 200) {
      invalid()
    }
    for (const [id, entry] of entries) {
      if (!uuid.test(id)) {
        invalid()
      }
      parsePetBinding(object(entry, ['pet']).pet)
    }
  }

  return structuredClone(row) as unknown as AtumAccountPreferences
}
export function parseCloudPreferences(value: unknown): AtumCloudPreferences {
  const row = object(value, ['account_id', 'revision', 'snapshot'])
  if (
    typeof row.account_id !== 'string' ||
    !uuid.test(row.account_id) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0
  ) {
    invalid()
  }

  return {
    accountId: row.account_id as string,
    revision: Number(row.revision),
    snapshot: parseAccountPreferences(row.snapshot)
  }
}
/** Lists and pet bindings are atomic groups; app preferences merge independently. */
export function preferenceFields(snapshot: AtumAccountPreferences): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(snapshot.app ?? {}).map(([key, value]) => [`app.${key}`, value])),
    ...(snapshot.roster ? { roster: snapshot.roster } : {}),
    ...(snapshot.chat_pins ? { chat_pins: snapshot.chat_pins } : {}),
    ...Object.fromEntries(Object.entries(snapshot.assistants ?? {}).map(([id, value]) => [`assistant.${id}`, value]))
  }
}
export function preferencesFromFields(fields: Record<string, unknown>): AtumAccountPreferences {
  const result: AtumAccountPreferences = { schema_version: 1 }
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('app.')) {
      ;(result.app ??= {} as NonNullable<AtumAccountPreferences['app']>)[
        key.slice(4) as keyof NonNullable<AtumAccountPreferences['app']>
      ] = value as never
    } else if (key.startsWith('assistant.')) {
      ;(result.assistants ??= {})[key.slice(10)] = value as { pet: AtumPetBinding }
    } else if (key === 'roster') {
      result.roster = value as AtumAccountPreferences['roster']
    } else if (key === 'chat_pins') {
      result.chat_pins = value as string[]
    } else {
      invalid()
    }
  }

  return parseAccountPreferences(result)
}
