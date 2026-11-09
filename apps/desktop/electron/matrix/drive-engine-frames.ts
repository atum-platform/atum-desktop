import type { MatrixDriveProgress, MatrixDriveQuota } from '../../shared/matrix-drive'

/** Wire boundary shared by the native receiver and the canonical 1.1 conformance tests. */
export const MATRIX_DRIVE_FRAME_BYTES = 16_384
export const MATRIX_DRIVE_FACT_FEATURES = ['progress', 'sync', 'quota', 'exclusions'] as const
const features = [...MATRIX_DRIVE_FACT_FEATURES, 'trash']
export type MatrixDriveEngineFeature = (typeof MATRIX_DRIVE_FACT_FEATURES)[number] | 'trash'

export interface MatrixDriveSync {
  lastSyncAt: number
  conflicts: number
  errors: number
  excluded: number
}
export interface MatrixDriveFrameContext {
  phase: 'awaiting_hello' | 'hello' | 'started'
  offered: readonly string[]
  accepted: readonly string[]
  issuer: string
  origin: string
  previousProgress?: MatrixDriveProgress
  lastSyncAt?: number
  pending?: { requestId: string; kind: 'trash' | 'trash_result'; id?: string; after?: string }
}

function reject(code: string): never {
  throw new Error(code)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('object')
  }

  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    reject('field_unknown')
  }

  if (required.some(key => !Object.hasOwn(value, key))) {
    reject('field_type')
  }
}

function number(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    reject('number_range')
  }
}

function handle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    reject('handle')
  }
}

function hasControl(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!

    return code < 0x20 || (code >= 0x7f && code <= 0x9f)
  })
}

function member(value: unknown, values: string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) {
    reject('enum')
  }
}

export function matrixDriveFrameFeatures(value: unknown): MatrixDriveEngineFeature[] {
  if (!Array.isArray(value)) {
    reject('field_type')
  }

  if (value.length > 8) {
    reject('feature_limit')
  }

  if (value.some(item => !features.includes(item))) {
    reject('feature_unknown')
  }

  if (new Set(value).size !== value.length) {
    reject('feature_duplicate')
  }

  return [...value] as MatrixDriveEngineFeature[]
}

/** Cap each complete or pending line, not an OS read containing several valid frames. */
export class MatrixDriveFrameReader {
  private pending = Buffer.alloc(0)
  private failed = false

  push(chunk: Buffer): Record<string, unknown>[] {
    if (this.failed) {
      reject('protocol')
    }

    const frames: Record<string, unknown>[] = []

    try {
      let start = 0

      while (start < chunk.length) {
        const end = chunk.indexOf(10, start)
        const complete = end !== -1
        const part = chunk.subarray(start, complete ? end : chunk.length)

        if (this.pending.length + part.length + (complete ? 1 : 0) > MATRIX_DRIVE_FRAME_BYTES) {
          reject('line_cap')
        }

        const line = this.pending.length ? Buffer.concat([this.pending, part]) : part

        if (!complete) {
          this.pending = Buffer.from(line)

          break
        }

        this.pending = Buffer.alloc(0)

        if (line.at(-1) === 13) {
          reject('line_ending')
        }

        let decoded: string

        try {
          decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)
        } catch {
          reject('utf8')
        }

        let value: unknown

        try {
          value = JSON.parse(decoded)
        } catch {
          reject('json')
        }

        frames.push(object(value))
        start = end + 1
      }

      return frames
    } catch (error) {
      this.pending = Buffer.alloc(0)
      this.failed = true
      throw error
    }
  }
}

/** Legacy fields retain their existing receiver guards; only extensions add strict schemas. */
export function validateMatrixDriveFrame(
  message: Record<string, unknown>,
  context: MatrixDriveFrameContext,
  direction: 'engine_to_app' | 'app_to_engine' = 'engine_to_app'
): void {
  const kind = message.kind

  if (kind === 'hello') {
    if (direction !== 'engine_to_app') {
      reject('direction')
    }

    if (context.phase !== 'awaiting_hello') {
      reject('phase')
    }

    if (message.protocol !== 1) {
      reject('protocol_version')
    }

    if (
      message.issuer !== context.issuer ||
      typeof message.origin !== 'string' ||
      message.origin.replace(/\/$/, '') !== context.origin
    ) {
      reject('identity_mismatch')
    }

    if (Object.hasOwn(message, 'features')) {
      matrixDriveFrameFeatures(message.features)
    }

    return
  }

  if (kind === 'start') {
    if (direction !== 'app_to_engine') {
      reject('direction')
    }

    if (context.phase !== 'hello') {
      reject('phase')
    }

    if (Object.hasOwn(message, 'features')) {
      if (matrixDriveFrameFeatures(message.features).some(feature => !context.offered.includes(feature))) {
        reject('feature_not_offered')
      }
    }

    if (Object.hasOwn(message, 'credential')) {
      const credential = object(message.credential)
      keys(credential, ['accessToken'], ['expiresAt'])

      if (
        typeof credential.accessToken !== 'string' ||
        !credential.accessToken ||
        credential.accessToken.length > 4096 ||
        [...credential.accessToken].some(character => {
          const code = character.codePointAt(0)!

          return /\s/.test(character) || code < 0x20 || code === 0x7f
        })
      ) {
        reject('credential_token')
      }

      if (Object.hasOwn(credential, 'expiresAt')) {
        number(credential.expiresAt)
      }
    }

    return
  }

  const feature =
    typeof kind === 'string' && ['trash', 'trash_result', 'trash_list', 'trash_restore'].includes(kind) ? 'trash' : kind

  if (typeof feature !== 'string' || !features.includes(feature as MatrixDriveEngineFeature)) {
    reject('kind_unknown')
  }

  const command = kind === 'trash_list' || kind === 'trash_restore'

  if (direction !== (command ? 'app_to_engine' : 'engine_to_app')) {
    reject('direction')
  }

  if (context.phase !== 'started') {
    reject('phase')
  }

  if (!context.accepted.includes(feature)) {
    reject('feature_not_accepted')
  }

  if (kind === 'progress') {
    keys(message, ['kind', 'active', 'files', 'bytes', 'etaSeconds', 'direction'])

    if (typeof message.active !== 'boolean') {
      reject('field_type')
    }

    for (const field of ['files', 'bytes'] as const) {
      const counter = object(message[field])
      keys(counter, ['done', 'total'])
      number(counter.done)
      number(counter.total)

      if (counter.done > counter.total) {
        reject('counter_total')
      }

      const previous = context.previousProgress

      if (previous?.active && (counter.done < previous[field].done || counter.total < previous[field].total)) {
        reject('progress_regression')
      }
    }

    if (message.etaSeconds !== null) {
      number(message.etaSeconds)
    }

    member(message.direction, ['up', 'down', 'mixed'])
  } else if (kind === 'sync') {
    keys(message, ['kind', 'lastSyncAt', 'conflicts', 'errors', 'excluded'])

    for (const field of ['lastSyncAt', 'conflicts', 'errors', 'excluded']) {
      number(message[field])
    }

    if ((message.lastSyncAt as number) < (context.lastSyncAt ?? 0)) {
      reject('sync_regression')
    }
  } else if (kind === 'quota') {
    keys(message, ['kind', 'total', 'used', 'remaining', 'state'])

    for (const field of ['total', 'used', 'remaining']) {
      number(message[field])
    }

    const { total, used, remaining } = message as unknown as MatrixDriveQuota

    if (!total) {
      reject('quota_total')
    }

    if (remaining !== Math.max(total - used, 0)) {
      reject('quota_remaining')
    }

    member(message.state, ['normal', 'nearing', 'critical', 'exceeded'])

    if ((message.state === 'exceeded') !== used >= total) {
      reject('quota_state')
    }
  } else if (kind === 'exclusions') {
    keys(message, ['kind', 'patterns'])

    if (!Array.isArray(message.patterns)) {
      reject('field_type')
    }

    if (!message.patterns.length || message.patterns.length > 256) {
      reject('exclusion_limit')
    }

    for (const pattern of message.patterns) {
      if (
        typeof pattern !== 'string' ||
        !pattern ||
        Buffer.byteLength(pattern) > 256 ||
        /^[\\/]|^[a-zA-Z]:/.test(pattern) ||
        hasControl(pattern) ||
        pattern.split(/[\\/]/).includes('..')
      ) {
        reject('exclusion_pattern')
      }
    }

    if (new Set(message.patterns).size !== message.patterns.length) {
      reject('exclusion_duplicate')
    }
  } else {
    keys(
      message,
      kind === 'trash'
        ? ['kind', 'requestId', 'items']
        : kind === 'trash_result'
          ? ['kind', 'requestId', 'id', 'result']
          : kind === 'trash_restore'
            ? ['kind', 'requestId', 'id']
            : ['kind', 'requestId'],
      kind === 'trash' ? ['next'] : kind === 'trash_list' ? ['after'] : []
    )
    handle(message.requestId)

    for (const field of ['id', 'next', 'after']) {
      if (Object.hasOwn(message, field)) {
        handle(message[field])
      }
    }

    if (command) {
      return
    }

    const pending = context.pending

    if (
      !pending ||
      message.requestId !== pending.requestId ||
      pending.kind !== kind ||
      (kind === 'trash_result' && pending.id !== message.id)
    ) {
      reject('request_mismatch')
    }

    if (kind === 'trash_result') {
      member(message.result, ['restored', 'renamed', 'not_found', 'no_room', 'failed'])

      return
    }

    if (!Array.isArray(message.items)) {
      reject('field_type')
    }

    if (message.items.length > 40) {
      reject('trash_limit')
    }

    if (message.next && (!message.items.length || message.next === pending.after)) {
      reject('trash_page')
    }

    const ids = new Set<string>()
    let previousTime = Number.MAX_SAFE_INTEGER
    let previousId = ''

    for (const value of message.items) {
      const item = object(value)
      keys(item, ['id', 'name', 'deletedAt', 'size', 'type'])
      handle(item.id)

      if (ids.has(item.id)) {
        reject('trash_duplicate')
      }

      ids.add(item.id)

      if (
        typeof item.name !== 'string' ||
        !item.name ||
        ['.', '..'].includes(item.name) ||
        Buffer.byteLength(item.name) > 255 ||
        /[\\/]/.test(item.name) ||
        hasControl(item.name)
      ) {
        reject('trash_name')
      }

      number(item.deletedAt)
      number(item.size)
      member(item.type, ['file', 'folder'])

      if (item.deletedAt > previousTime || (item.deletedAt === previousTime && item.id < previousId)) {
        reject('trash_order')
      }

      previousTime = item.deletedAt
      previousId = item.id
    }
  }
}
