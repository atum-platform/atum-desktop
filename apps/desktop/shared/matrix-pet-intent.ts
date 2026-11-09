export const MATRIX_PET_INTENT_KEY = 'io.atum.pet'
export const MATRIX_PET_INTENT_PACK_SHA256 = '2b4e828daebb2f840b673a48b3a58d0a0b52eb79b371e82a755f64dadeef23eb'
/** Join-A build gate; activation and producer handshake belong to PT-12. */
export const MATRIX_PET_INTENT_PLAYBACK = false

/** Frozen wire data, structurally assignable to engine commands without native engine imports. */
export type MatrixPetIntent =
  | { action: 'go'; place: 'left' | 'right' | 'center' }
  | { action: 'wave' | 'jump' | 'sit' | 'lounge' }

export interface MatrixPetIntentEnvelope {
  v: 1
  intents: MatrixPetIntent[]
}

export interface MatrixPetIntentProjection {
  commands: readonly MatrixPetIntent[]
  /** SDK timeline provenance, never read from the sender's content. */
  live: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Frozen v1: reject the whole mixin when any entry or extra field is invalid. */
export function parseMatrixPetIntents(value: unknown): MatrixPetIntent[] | undefined {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    value.v !== 1 ||
    !Array.isArray(value.intents) ||
    value.intents.length < 1 ||
    value.intents.length > 3
  ) {
    return undefined
  }

  const commands: MatrixPetIntent[] = []

  for (const intent of value.intents) {
    if (!record(intent)) {
      return undefined
    }

    if (
      intent.action === 'go' &&
      Object.keys(intent).length === 2 &&
      (intent.place === 'left' || intent.place === 'right' || intent.place === 'center')
    ) {
      commands.push({ action: 'go', place: intent.place })
    } else if (
      Object.keys(intent).length === 1 &&
      (intent.action === 'wave' || intent.action === 'jump' || intent.action === 'sit' || intent.action === 'lounge')
    ) {
      commands.push({ action: intent.action })
    } else {
      return undefined
    }
  }

  return commands
}

/** Text remains independently renderable when cosmetic data fails this parser. */
export function parseMatrixPetReply(content: unknown): MatrixPetIntent[] | undefined {
  if (!record(content) || content.msgtype !== 'm.text' || typeof content.body !== 'string' || !content.body.length) {
    return undefined
  }

  return parseMatrixPetIntents(content[MATRIX_PET_INTENT_KEY])
}

/** Cosmetic completion data cannot invalidate the independently successful text answer. */
export function matrixPetIntentEnvelope(value: unknown): MatrixPetIntentEnvelope | undefined {
  const intents = parseMatrixPetIntents(value)

  return intents ? { v: 1, intents } : undefined
}

/** The gateway returns a bare list; the host capability was fixed before this turn ran. */
export function matrixPetCompletionIntents(value: unknown, petSurface: boolean): MatrixPetIntentEnvelope | undefined {
  return petSurface === true ? matrixPetIntentEnvelope({ v: 1, intents: value }) : undefined
}

/** Used only for ordinary m.text publication, after the SDK has confirmed a private room. */
export function matrixPetReplyMixin(
  value: unknown,
  privateRoom: boolean,
  enabled = MATRIX_PET_INTENT_PLAYBACK
): { 'io.atum.pet'?: MatrixPetIntentEnvelope } {
  const pet = enabled === true && privateRoom === true ? matrixPetIntentEnvelope(value) : undefined

  return pet ? { [MATRIX_PET_INTENT_KEY]: pet } : {}
}
