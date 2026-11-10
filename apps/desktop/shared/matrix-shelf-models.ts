/**
 * Atum's OpenRouter shelf (owner 2026-11-09): a curated list of other makers' models that a cloud
 * assistant can answer with through Atum's own OpenRouter account. They are charged in Protons on
 * the same basis as Atum's own models: 40,500 Protons per USD of provider cost, which is the 1.5×
 * inference markup (`atum.model-choice/1.7`). A model that costs more than Atum's own top model is
 * labelled, never gated behind a confirmation (owner ruling, 2026-11-09).
 *
 * The aliases are the platform's closed vocabulary. Whether one is offered, its name and its price
 * always come from the server's offer: a row the server does not list as eligible is never drawn,
 * so nothing appears before the platform activates the shelf. Cloud only: the gateway refuses these
 * aliases from a Mac, so no Mac path in this client accepts one.
 */
import type { MatrixEffort } from './matrix-models'

export const MATRIX_SHELF_MODELS = [
  'gemini',
  'glm',
  'sonnet',
  'opus',
  'gemini-pro',
  'grok',
  'deepseek',
  'kimi',
  'qwen',
  'glm-plus'
] as const

export type MatrixShelfModelId = (typeof MATRIX_SHELF_MODELS)[number]

export function parseMatrixShelfModel(value: unknown): MatrixShelfModelId | undefined {
  return MATRIX_SHELF_MODELS.find(model => model === value)
}

/** The rail entry: its own id, so it never merges with an OpenRouter key the person connected. */
export const MATRIX_SHELF_PROVIDER = { id: 'atum-openrouter', label: 'OpenRouter' } as const

/** Atum's conversion: 27,000 Protons per USD times the 1.5× inference markup. */
export const MATRIX_PROTONS_PER_USD = 40_500

/**
 * Nhật Thực's price in Protons per million tokens (2.00 / 10.00 USD). A shelf model above either
 * figure costs more than Atum's own top model, and its row says so.
 */
const COSTLY_INPUT_PROTONS = 81_000
const COSTLY_OUTPUT_PROTONS = 405_000

/** What the provider may keep, as the platform's catalog names it. Training is never allowed. */
export type MatrixShelfRetention = 'zero_data_retention' | 'safety_retention' | 'provider_policy'

const RETENTION: readonly MatrixShelfRetention[] = ['zero_data_retention', 'safety_retention', 'provider_policy']

/** The model's maker, from the provider model id (`anthropic/claude-opus-5.5`). */
export interface MatrixShelfMaker {
  id: string
  label: string
}

/** One shelf model as the picker draws it. */
export interface MatrixShelfModelView {
  alias: MatrixShelfModelId
  /** The model's own name, without its maker: "Claude Opus 5.5". */
  name: string
  maker: MatrixShelfMaker
  /** Protons per million tokens read and written, on Atum's basis. */
  inputProtonsPerMtok: number
  outputProtonsPerMtok: number
  /** Costs more than Nhật Thực; the row carries a label, nothing more. */
  costly: boolean
  efforts: readonly MatrixEffort[]
  defaultEffort?: MatrixEffort
  /** Absent until the server's offer states it. */
  retention?: MatrixShelfRetention
}

const USD = /^(?:0|[1-9][0-9]{0,5})(?:\.([0-9]{1,8}))?$/u

/** A USD-per-million price from the offer, in Protons per million tokens. Exact to 1e-8 USD. */
export function matrixShelfProtons(usd: unknown): number | undefined {
  if (typeof usd !== 'string') {
    return undefined
  }

  const match = USD.exec(usd)

  if (!match) {
    return undefined
  }

  const [whole, fraction = ''] = usd.split('.')
  const units = BigInt(whole ?? '0') * 100_000_000n + BigInt(fraction.padEnd(8, '0'))

  return Number(units * BigInt(MATRIX_PROTONS_PER_USD)) / 100_000_000
}

/** Makers' names for a display name that does not carry one, keyed by the provider model's prefix. */
const MAKERS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  moonshotai: 'Moonshot AI',
  openai: 'OpenAI',
  qwen: 'Qwen',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai'
}

function makerOf(providerModel: string, displayName: string): MatrixShelfMaker | undefined {
  const id = providerModel.split('/')[0]?.trim().toLocaleLowerCase()

  if (!id || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    return undefined
  }

  // OpenRouter's own names carry the maker as a prefix ("Anthropic: Claude Opus 5.5"); the server's
  // word wins over this client's list, which only covers a name without one.
  const prefix = displayName.includes(': ') ? displayName.slice(0, displayName.indexOf(': ')).trim() : ''

  return { id, label: prefix || MAKERS[id] || id }
}

/** "Anthropic: Claude Opus 5.5" is listed under OpenRouter as "Claude Opus 5.5". */
function modelName(displayName: string): string {
  const separator = displayName.indexOf(': ')
  const name = separator > 0 ? displayName.slice(separator + 2).trim() : displayName.trim()

  return name || displayName.trim()
}

/**
 * A shelf row from the server's offer, or undefined when any fact the row needs is missing. A paid
 * model is never drawn without its name and price.
 */
export function matrixShelfModelView(row: {
  alias: string
  displayName?: string
  providerModel?: string
  inputUsdPerMtok?: string
  outputUsdPerMtok?: string
  efforts: readonly string[]
  defaultEffort?: string
  retention?: unknown
}): MatrixShelfModelView | undefined {
  const alias = parseMatrixShelfModel(row.alias)
  const inputProtonsPerMtok = matrixShelfProtons(row.inputUsdPerMtok)
  const outputProtonsPerMtok = matrixShelfProtons(row.outputUsdPerMtok)
  const displayName = row.displayName?.trim()
  const maker = displayName && row.providerModel ? makerOf(row.providerModel, displayName) : undefined

  if (!alias || !displayName || !maker || inputProtonsPerMtok === undefined || outputProtonsPerMtok === undefined) {
    return undefined
  }

  const efforts = row.efforts.filter(
    (effort): effort is MatrixEffort => effort === 'low' || effort === 'medium' || effort === 'high'
  )

  const defaultEffort = efforts.find(effort => effort === row.defaultEffort)
  const retention = RETENTION.find(each => each === row.retention)

  return {
    alias,
    name: modelName(displayName),
    maker,
    inputProtonsPerMtok,
    outputProtonsPerMtok,
    costly: inputProtonsPerMtok > COSTLY_INPUT_PROTONS || outputProtonsPerMtok > COSTLY_OUTPUT_PROTONS,
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(retention ? { retention } : {})
  }
}

/** Whole Protons, grouped the reader's way: "405,000" / "405.000". */
export function matrixShelfProtonsLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value))
}
