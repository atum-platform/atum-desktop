/** Desktop reader for the frozen atum.model-choice/1 contract. No credential fields. */
export const MATRIX_MODEL_CHOICE_PIN = '275f382825eb1752d1046aca15dacabd8a22ff324c63c6c6e8aa726f388b1667'
export const MATRIX_PRODUCT_EFFORTS = ['low', 'medium', 'high', 'max'] as const
export type MatrixProductEffort = (typeof MATRIX_PRODUCT_EFFORTS)[number]

interface ChoiceBase {
  v: 2
  model: string
  effort?: MatrixProductEffort
}

export interface MatrixAtumChoice extends ChoiceBase {
  source: 'atum'
}

export interface MatrixConnectionChoice extends ChoiceBase {
  source: 'connection'
  connectionId: string
}

export type MatrixModelChoiceEntry = MatrixAtumChoice | MatrixConnectionChoice
export type MatrixModelChoice = MatrixModelChoiceEntry & { agents?: Record<string, MatrixModelChoiceEntry> }

export interface MatrixModelCapabilities {
  id: string
  displayName: string
  efforts: readonly MatrixProductEffort[]
}

const principalPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const forbiddenKey = /secret|token|api_key|authorization|password/iu
const forbiddenExact = new Set(['baseUrl', 'endpoint', 'url'])

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every(key => allowed.includes(key))
}

function publicData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') {
    return true
  }

  // Valid choices have at most the root, agents map and one entry; malformed nesting is bounded.
  if (seen.has(value) || seen.size >= 4) {
    return false
  }

  seen.add(value)

  const valid = Object.entries(value).every(
    ([key, child]) => !forbiddenKey.test(key) && !forbiddenExact.has(key) && publicData(child, seen)
  )

  seen.delete(value)

  return valid
}

function name(value: unknown, maximum: number, pattern: RegExp): value is string {
  return typeof value === 'string' && [...value].length >= 1 && [...value].length <= maximum && pattern.test(value)
}

export function parseMatrixProductEffort(value: unknown): MatrixProductEffort | undefined {
  return MATRIX_PRODUCT_EFFORTS.find(effort => effort === value)
}

function entry(value: unknown, withAgents = false): MatrixModelChoiceEntry | undefined {
  if (!object(value) || value.v !== 2 || !name(value.model, 200, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)) {
    return undefined
  }

  const allowed = ['v', 'source', 'model', 'effort', ...(withAgents ? ['agents'] : [])]
  const effort = parseMatrixProductEffort(value.effort)

  if (value.effort !== undefined && !effort) {
    return undefined
  }

  if (value.source === 'atum' && fields(value, allowed)) {
    return { v: 2, source: 'atum', model: value.model, ...(effort ? { effort } : {}) }
  }

  if (
    value.source === 'connection' &&
    fields(value, [...allowed, 'connectionId']) &&
    name(value.connectionId, 128, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u)
  ) {
    return {
      v: 2,
      source: 'connection',
      connectionId: value.connectionId,
      model: value.model,
      ...(effort ? { effort } : {})
    }
  }

  return undefined
}

/** Strict canonical reader; malformed v2 never downgrades to a legacy model. */
export function parseMatrixModelChoice(value: unknown): MatrixModelChoice | undefined {
  if (!object(value) || !publicData(value)) {
    return undefined
  }

  if (fields(value, ['model']) && name(value.model, 200, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)) {
    return { v: 2, source: 'atum', model: value.model }
  }

  const choice = entry(value, true)

  if (!choice) {
    return undefined
  }

  if (value.agents === undefined) {
    return choice
  }

  if (!object(value.agents)) {
    return undefined
  }

  const agents: Record<string, MatrixModelChoiceEntry> = {}

  for (const [principal, raw] of Object.entries(value.agents)) {
    const agent = entry(raw)

    if (!principalPattern.test(principal) || !agent) {
      return undefined
    }

    agents[principal] = agent
  }

  return { ...choice, agents }
}

/** 0.18.3 wrote unversioned {model, effort}; preserve its ordinary Atum effort on upgrade. */
export function readMatrixModelChoice(value: unknown): MatrixModelChoice | undefined {
  const canonical = parseMatrixModelChoice(value)

  if (canonical) {
    return canonical
  }

  if (
    object(value) &&
    fields(value, ['model', 'effort']) &&
    (value.model === undefined ||
      (typeof value.model === 'string' && ['nguyet-thuc', 'nhat-thuc', 'binh-minh'].includes(value.model))) &&
    typeof value.effort === 'string' &&
    ['low', 'medium', 'high'].includes(value.effort)
  ) {
    return parseMatrixModelChoice({ ...value, model: value.model ?? 'nguyet-thuc', v: 2, source: 'atum' })
  }

  return undefined
}

/** Complete entry write, preserving every other assistant's private room choice. */
export function writeMatrixModelChoice(
  existing: unknown,
  replacement: unknown,
  agentPrincipal?: string
): MatrixModelChoice {
  const previous = existing === undefined ? undefined : readMatrixModelChoice(existing)
  const next = publicData(replacement) ? entry(replacement) : undefined

  if (
    (existing !== undefined && !previous) ||
    !next ||
    (agentPrincipal !== undefined && !principalPattern.test(agentPrincipal))
  ) {
    throw new Error('matrix_model_choice_invalid')
  }

  if (agentPrincipal !== undefined) {
    if (!previous) {
      throw new Error('matrix_model_choice_invalid')
    }

    return { ...previous, agents: { ...previous.agents, [agentPrincipal]: next } }
  }

  return { ...next, ...(previous?.agents ? { agents: previous.agents } : {}) }
}

/** Descriptor-only capabilities: an absent or invalid advertisement offers no levels. */
export function parseMatrixModelCapabilities(value: unknown): MatrixModelCapabilities | undefined {
  if (
    !object(value) ||
    !publicData(value) ||
    !fields(value, ['id', 'displayName', 'efforts']) ||
    !name(value.id, 200, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u) ||
    typeof value.displayName !== 'string' ||
    [...value.displayName].length < 1 ||
    [...value.displayName].length > 120 ||
    !Array.isArray(value.efforts) ||
    value.efforts.length > 4 ||
    new Set(value.efforts).size !== value.efforts.length ||
    value.efforts.some(level => !parseMatrixProductEffort(level))
  ) {
    return undefined
  }

  return { id: value.id, displayName: value.displayName, efforts: Object.freeze([...value.efforts]) }
}
