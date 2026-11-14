/**
 * Atum's models (the owner's lineup, 2026-09-26; the three-row picker, 2026-10-17). The ids
 * are the gateway's aliases (atum-platform services/gateway/config.yaml); names and versions
 * are the product's own display strings, matching the server's `displayName`, and never name
 * the provider. Thái Cực, the flagship, is announced and not served yet.
 */
import {
  type MatrixModelCapabilities,
  type MatrixModelChoice,
  type MatrixProductEffort,
  parseMatrixModelCapabilities,
  readMatrixModelChoice,
  writeMatrixModelChoice
} from './matrix-model-choice'
import { matrixModelDisplayName } from './matrix-model-display-name'
import type { MatrixShelfModelId, MatrixShelfModelView } from './matrix-shelf-models'

export const MATRIX_MODELS = ['nguyet-thuc', 'nhat-thuc'] as const

export type MatrixModelId = (typeof MATRIX_MODELS)[number]

export const MATRIX_DEFAULT_MODEL: MatrixModelId = 'nguyet-thuc'

export interface MatrixModelLineupRow {
  id: MatrixModelId | null
  name: string
  /** The display string the server's `displayName` also carries; absent for an announced row. */
  version?: string
  tagline: 'everyday' | 'hard' | 'flagship'
}

/** The picker's rows, in order. `id: null` is announced, not selectable. */
export const MATRIX_MODEL_LINEUP: readonly MatrixModelLineupRow[] = [
  { id: 'nguyet-thuc', name: 'Nguyệt Thực', version: '1.3', tagline: 'everyday' },
  { id: 'nhat-thuc', name: 'Nhật Thực', version: '1.1', tagline: 'hard' },
  { id: null, name: 'Thái Cực', tagline: 'flagship' }
]

/** One of Atum's models as the product names it: "Nguyệt Thực 1.3". Never translated. */
export function matrixModelName(model: MatrixModelId): string {
  const row = MATRIX_MODEL_LINEUP.find(each => each.id === model)

  return row?.version ? `${row.name} ${row.version}` : (row?.name ?? model)
}

/**
 * The frozen agent-home catalog's label grammar is ASCII only, so the wire carries a
 * diacritic-free form; the window shows the product name from `matrixModelName`.
 */
export function matrixManagedModelLabel(model: MatrixModelId): string {
  const label = matrixModelName(model)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9 ._+/-]/gu, '')
    .trim()

  return label || model
}

/**
 * The cloud's model-choice offer for one agent, as main read it from the platform's
 * `atum.model-choice/1.1GET /agents/{principal}/models` route. Absent when no offer was
 * reachable (the flag is off, or the read failed): the picker then offers Nguyệt Thực only,
 * exactly as it did before the offer existed. Nothing here is authority: the server refuses
 * an ineligible alias when the choice is written.
 */
export interface MatrixCloudModelChoiceView {
  /** Server aliases eligible right now, in the server's order. */
  offered: readonly string[]
  /** The alias the server says this agent runs now. */
  current?: string
  /** The eligible OpenRouter shelf models, in the server's order, with their Proton prices. */
  shelf?: readonly MatrixShelfModelView[]
  /** The OpenCode Go model this cloud agent runs (the account subscription), when one is chosen. */
  subscription?: { source: 'opencode_go' | 'chatgpt_plan'; model: string; effort: MatrixEffort; displayName: string }
  /** The OpenCode Go models the connected account serves (`provider-connections` status). */
  subscriptionModels?: readonly MatrixCloudSubscriptionModel[]
  /**
   * The account connection behind a subscription choice. `revoked` means the choice survived
   * but its key is gone: the picker must offer Reconnect, never silently use Atum.
   */
  subscriptionCustody?: 'carried'
  subscriptionState?: 'connected' | 'revoked' | 'disconnected' | 'unavailable'
  /** The ChatGPT relay Mac's presence (`atum.chatgpt-relay` `relayPresence`), when the platform
   * sends it. Read only through `shared/matrix-subscription-availability.ts`. */
  relayPresence?: 'online' | 'offline' | 'none'
}

/** One OpenCode Go model offered to a cloud agent by the account connection. */
export interface MatrixCloudSubscriptionModel {
  id: string
  displayName: string
  efforts: readonly MatrixEffort[]
  defaultEffort: MatrixEffort
}

/** A server alias as one of the picker's own models; `default` is Nguyệt Thực. */
export function matrixCloudModelAlias(alias: unknown): MatrixModelId | undefined {
  return alias === 'default' || alias === 'google-protected' ? MATRIX_DEFAULT_MODEL : parseMatrixModel(alias)
}

/**
 * One destination's default model on the assistant card (`atum.model-choice/1.3`): the
 * cloud or one of the owner's Macs. Native main reads the server snapshot strictly and
 * sends only this display row: the owner's name for the Mac (never its id in the window),
 * the reference model, and the line-up rows this destination may pick.
 */
export interface MatrixModelDestinationView {
  /** `cloud`, or the destination the server stores (`mac:<device-service-id>`). */
  id: string
  kind: 'cloud' | 'mac'
  /** The owner's Computer Name for that Mac, when the registry answered. */
  deviceName?: string
  /** That Mac's model, when main knows it (a fallback name). */
  deviceModel?: string
  /** This Mac, so the row can say "(máy này)" like the failover rows. */
  thisMac?: boolean
  /** 1-based place among the Macs, for a Mac the registry cannot name. */
  macOrdinal?: number
  /** The destination's reference model: its saved choice, else the server's recommendation. */
  current: MatrixModelId
  /**
   * The cloud's saved OpenRouter shelf model, when that is what it runs. `current` is then only the
   * Atum fallback a Mac would use; the row names the shelf model.
   */
  shelf?: MatrixShelfModelId
  /** Exact saved non-Atum default. `current` remains the selectable Atum fallback only. */
  external?: {
    source: 'chatgpt_plan' | 'opencode_go' | `own_key:${string}`
    providerLabel: string
    model: string
    modelLabel: string
    effort: MatrixProductEffort
  }
  /** True when the reference model is the server's recommended default ("Đề xuất"). */
  recommended: boolean
  /** The line-up models this destination can take, in line-up order. */
  models: readonly MatrixModelId[]
  /** The line-up models it cannot take now (a cloud alias dispatch does not offer). */
  unavailable: readonly MatrixModelId[]
}

/**
 * One agent's daily cap (item 23, `atum.model-choice/1.3`), exactly as the server snapshot
 * states it. `dailyProtons: 0` means no limit. `state` and `notice` are the server's own
 * computation; the window shows them and never derives them from the amounts.
 */
export interface MatrixModelDailyCapView {
  /** The server's cap, in Protons per day; 0 means no limit. */
  dailyProtons: number
  /** The snapshot revision a cap write is fenced by. */
  revision: number
  /** Today's settled Atum-billed spend, as the server computed it. */
  spend: {
    day: string
    usedProtons: number
    state: 'normal' | 'warning' | 'exhausted'
    notice: 'none' | 'eighty_percent' | 'exhausted'
  }
}

/** The assistant card's model rows, from main's strict v1.3 snapshot. */
export interface MatrixModelDestinationsView {
  /** The server's recommended default (the line-up alias). */
  recommended: MatrixModelId
  choices: readonly MatrixModelDestinationView[]
  /** The default for the destination that answers a turn here (composer fallback). */
  here?: MatrixModelId
  /** The server's daily cap and today's spend; absent for an older main or a bare view. */
  dailyCap?: MatrixModelDailyCapView
}

/**
 * The owner's model for one conversation: per-user room account data, which only they
 * can write and nobody else in the room can read. Absent means the default.
 */
export const MATRIX_MODEL_ACCOUNT_DATA = 'io.atum.model'

/** Names Hermes may still hold for a conversation from before the lineup. */
const RETIRED_MODELS = new Set(['binh-minh'])

export function parseMatrixModel(value: unknown): MatrixModelId | undefined {
  return MATRIX_MODELS.find(model => model === value)
}

/** True for any name of Atum's own model, current or retired. */
export function isAtumModelName(value: unknown): boolean {
  return parseMatrixModel(value) !== undefined || (typeof value === 'string' && RETIRED_MODELS.has(value))
}

/**
 * The model a turn runs on: the one recorded when its message was sent, else the room's
 * current choice, else the default. A request outside any turn gets the default, which is
 * the cheaper model: a stray request is never upgraded.
 */
export function matrixTurnModel(
  rooms: readonly { id: string; model?: MatrixModelId }[],
  roomId: string | undefined,
  recorded?: unknown
): MatrixModelId {
  return parseMatrixModel(recorded) ?? rooms.find(room => room.id === roomId)?.model ?? MATRIX_DEFAULT_MODEL
}

/**
 * Check-ins' own model name (cron/check_ins.py CHECK_IN_MODEL; plan
 *  §2): always the everyday model,
 * never the choice of a turn that happens to be running, and never part of a Store task.
 */
export const MATRIX_CHECK_IN_MODEL_ALIAS = 'atum-check-in'
export const MATRIX_CHECK_IN_MODEL: MatrixModelId = 'nguyet-thuc'

/**
 * The model a request through Atum's proxy goes to. Hermes keeps each conversation's
 * stored model name, so the choice is applied here, per request: any name of Atum's model
 * becomes the running turn's choice, and the check-in name the everyday model. Anything
 * else is left for the gateway to refuse.
 */
export function matrixRequestModel(requested: unknown, chosen: MatrixModelId): unknown {
  if (requested === MATRIX_CHECK_IN_MODEL_ALIAS) {
    return MATRIX_CHECK_IN_MODEL
  }

  return isAtumModelName(requested) ? chosen : requested
}

/**
 * How hard the model thinks (Nhanh / Cân bằng / Kỹ), per conversation, kept with the model
 * choice in `io.atum.model`. Sent as `reasoning_effort` low/medium/high: through the proxy
 * to the gateway for Atum's models, and as the Hermes session's thinking level for every
 * model. No "max" until each model has its own output cap and hold (critique MP-1).
 * Absent means the model's own default, shown as Cân bằng.
 */
export const MATRIX_EFFORTS = ['low', 'medium', 'high'] as const

export type MatrixEffort = (typeof MATRIX_EFFORTS)[number]

export const MATRIX_DEFAULT_EFFORT: MatrixEffort = 'medium'

export function parseMatrixEffort(value: unknown): MatrixEffort | undefined {
  return MATRIX_EFFORTS.find(effort => effort === value)
}

/**
 * The levels the picker offers for each of Atum's models: one, out of the box (2026-10-17).
 * The gateway's rows keep `low`, `medium` and `high`, so the dial can return by widening
 * this client list, with no gateway change.
 */
export const MATRIX_MODEL_EFFORTS: Readonly<Record<MatrixModelId, readonly MatrixEffort[]>> = {
  'nguyet-thuc': ['medium'],
  'nhat-thuc': ['medium']
}

/**
 * The thinking level a turn runs with: the one recorded when its message was sent, else the
 * conversation's current choice. Undefined means none was chosen: nothing is sent and the
 * model keeps its default.
 */
export function matrixTurnEffort(
  rooms: readonly { id: string; effort?: MatrixEffort }[],
  roomId: string | undefined,
  recorded?: unknown
): MatrixEffort | undefined {
  return parseMatrixEffort(recorded) ?? rooms.find(room => room.id === roomId)?.effort
}

/** Atum-only picker write; retain v2 assistant overrides and refuse foreign source rewrites. */
export function matrixModelChoiceContent(
  existing: unknown,
  change: { model?: MatrixModelId; effort?: MatrixEffort }
): MatrixModelChoice {
  const current = existing === undefined ? undefined : readMatrixModelChoice(existing)

  if (
    (existing !== undefined && !current) ||
    current?.source === 'connection' ||
    (current && !isAtumModelName(current.model))
  ) {
    throw new Error('matrix_model_choice_invalid')
  }

  const model = change.model ?? parseMatrixModel(current?.model) ?? MATRIX_DEFAULT_MODEL
  const effort = change.effort ?? parseMatrixEffort(current?.effort)

  return writeMatrixModelChoice(existing, { v: 2, source: 'atum', model, ...(effort ? { effort } : {}) })
}

/** The proxy's request body with the turn's thinking level, when one was chosen. */
export function matrixRequestEffort(request: Record<string, unknown>, effort: MatrixEffort | undefined) {
  return effort ? { ...request, reasoning_effort: effort } : request
}

/**
 * The model an assistant answers with when it is not Atum's: a connection the person made
 * (their ChatGPT plan, an API key, a model on this Mac). `reasoning` is Hermes's catalog
 * answer to "does it take a thinking level", absent when unknown.
 */
export interface MatrixConnectedModel {
  provider: string
  model: string
  reasoning?: boolean
  /** Explicit native advertisement; a reasoning boolean never implies a level list. */
  capability?: MatrixModelCapabilities
}

export function parseMatrixConnectedModel(value: unknown): MatrixConnectedModel | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const { provider, model, reasoning, capability: rawCapability } = value as Record<string, unknown>

  // A plain name: it becomes one word of a `/model` command, so never a flag or two words.
  const name = (text: unknown, max: number) =>
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= max &&
    !text.startsWith('-') &&
    !/[\p{Cc}\s]/u.test(text)

  if (!name(provider, 200) || !name(model, 1024)) {
    return undefined
  }

  const capability = parseMatrixModelCapabilities(rawCapability)

  return {
    provider: provider as string,
    model: model as string,
    ...(typeof reasoning === 'boolean' ? { reasoning } : {}),
    ...(capability && capability.id === model
      ? { capability: { ...capability, efforts: capability.efforts.filter(level => level !== 'max') } }
      : {})
  }
}

/** How a provider row is connected, for a safe account subtitle and no credential detail. */
export type MatrixModelConnection = 'plan' | 'key' | 'endpoint' | 'local'

/**
 * What a pick changes. A connected route is the agent's profile on this Mac (the same switch
 * Settings › Connections writes), Atum's own model is this conversation's account data, and a
 * cloud agent's model is the platform's choice for that assistant.
 */
export type MatrixModelRouteTarget = 'conversation_override' | 'agent_default' | 'destination_default'

/**
 * One selectable route: `(provider connection, model)`, never a model name alone. The same
 * model through a ChatGPT plan, an API key or a local endpoint is a separate row.
 *
 * Rows carry only presentation facts. They are built in main from the agent's own Hermes
 * provider snapshot; the window never sees a token, key, endpoint URL, private address or raw
 * provider response.
 */
export interface MatrixModelRoute {
  /**
   * Stable non-secret identity for this provider+model route. It stays the same across
   * snapshots so favorites and recents do not churn; main still revalidates it against a
   * fresh catalog before any write.
   */
  id: string
  provider: string
  model: string
  /** The catalog's own model name; never a guessed display string. */
  name: string
  /** Safe service label, e.g. "ChatGPT" or a custom endpoint's owner-chosen name. */
  providerLabel: string
  /** Safe account label; never a private email, token, endpoint URL or subject. */
  accountLabel: string
  connection: MatrixModelConnection
  target: MatrixModelRouteTarget
  /** Where this route runs. A local plan never appears as a cloud route. */
  destination: 'this_mac' | 'cloud'
  /** Explicit levels this exact model advertises; an absent list offers none. */
  efforts: MatrixEffort[]
  /** This route is what the agent answers with right now. */
  current: boolean
  /** False for an announced model that cannot be chosen yet. */
  ready: boolean
}

/** One provider connection, for the picker's account filter and honest empty states. */
export interface MatrixModelAccount {
  id: string
  providerLabel: string
  accountLabel: string
  connection: MatrixModelConnection
  /** Signed in and usable now. A signed-out account contributes no routes. */
  ready: boolean
  /** Models the catalog lists for this account, before the picker's bound. */
  models: number
  /** Some of this account's models are not in `routes` because of the picker's bound. */
  truncated?: boolean
}

/**
 * Main's sanitized model catalog for the room's connected agent. It is built from the same
 * `MatrixPagesProvidersScope` snapshot the Connections page uses; it is not a second catalog
 * and it never carries credentials.
 */
export interface MatrixModelCatalog {
  routes: MatrixModelRoute[]
  accounts: MatrixModelAccount[]
  /** The route Hermes reads back as current, when it is in this catalog. */
  current?: string
  /** The assistant whose profile a connected pick changes. */
  agentName?: string
  destination: 'this_mac'
  /** More routes exist than the picker carries; Connections lists every model. */
  truncated?: boolean
  /** Accounts that are present but not signed in/usable now. */
  unavailable: number
  /**
   * Atum's managed models this profile can answer with. Placement only (agent-home/2.5): the
   * conversation picker changes local connections, never Atum's own model. A Mac publishes this
   * connection so it can be a place the assistant moves to even when no plan or key is connected.
   */
  managed?: readonly MatrixModelId[]
}

/** A bounded catalog keeps a 500+ model account responsive without hiding its current route. */
export const MATRIX_MODEL_ROUTE_LIST_MAX = 1000

/** Stable, non-secret route identity. Main treats it as untrusted and revalidates it. */
export function matrixModelRouteId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}

/** Decode a route id into its provider and model; never select without a fresh catalog read. */
export function parseMatrixModelRouteId(value: unknown): { provider: string; model: string } | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\p{Cc}\s]/u.test(value)) {
    return undefined
  }

  const separator = value.indexOf(':')

  if (separator <= 0 || separator === value.length - 1) {
    return undefined
  }

  try {
    const provider = decodeURIComponent(value.slice(0, separator))
    const model = decodeURIComponent(value.slice(separator + 1))

    if (
      !/^[a-z0-9][a-z0-9_-]{0,199}$/.test(provider) ||
      model.length === 0 ||
      model.length > 1024 ||
      model !== model.trim() ||
      model.startsWith('-') ||
      /[\p{Cc}\s]/u.test(model)
    ) {
      return undefined
    }

    return { provider, model }
  } catch {
    return undefined
  }
}

/** The route id of a model the agent already answers with. */
export function matrixRouteIdOfChoice(choice: Pick<MatrixConnectedModel, 'provider' | 'model'>): string {
  return matrixModelRouteId(choice.provider, choice.model)
}

/** `cancelled`: Hermes said the model costs extra and the person declined in main's dialog. */
export type MatrixModelRouteSelection = { status: 'applied'; current?: string } | { status: 'cancelled' }

/** Main's closed refusals for the picker's connection list and switch; never Hermes's words. */
export const MATRIX_CONNECTED_MODEL_ERRORS = {
  /** A turn, setup or another change holds the agent: nothing changed, try again after it. */
  busy: 'matrix_connected_model_busy',
  /** Not this connection's model, or the connection is not signed in or not in use. */
  unavailable: 'matrix_connected_model_unavailable',
  failed: 'matrix_connected_model_failed'
} as const

export type MatrixConnectedModelProblem = keyof typeof MATRIX_CONNECTED_MODEL_ERRORS

/** The closed reason inside an IPC failure (`Error invoking remote method …: Error: <code>`). */
export function matrixConnectedModelProblem(cause: unknown): MatrixConnectedModelProblem {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''

  return text.includes(MATRIX_CONNECTED_MODEL_ERRORS.busy)
    ? 'busy'
    : text.includes(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
      ? 'unavailable'
      : 'failed'
}

/** Service names, never translated; anything else shows the model's own name. */
const CONNECTED_SERVICE_NAME: Readonly<Record<string, string>> = {
  'openai-codex': 'ChatGPT',
  'openai-api': 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google',
  openrouter: 'OpenRouter'
}

/** A connection's service name ("ChatGPT", "OpenRouter"), or its own id when it has none. */
export function matrixConnectedServiceName(provider: string): string {
  return Object.hasOwn(CONNECTED_SERVICE_NAME, provider) ? CONNECTED_SERVICE_NAME[provider]! : provider
}

/** The chip's name for a connection: "ChatGPT · GPT-5.5", or just the model's name. */
export function matrixConnectedModelLabel(choice: MatrixConnectedModel): string {
  const service = Object.hasOwn(CONNECTED_SERVICE_NAME, choice.provider)
    ? CONNECTED_SERVICE_NAME[choice.provider]
    : undefined

  const model = matrixModelDisplayName(choice.model)

  return service ? `${service} · ${model}` : model
}

/** Existing profile-selected own models retain Hermes's legacy dial until slice 9's offer.
 * Explicit advertisements take precedence, including an empty list. This compatibility
 * path cannot authorize a v2 connection choice, which native intake refuses. */
export function matrixConnectedModelEfforts(choice: MatrixConnectedModel): readonly MatrixEffort[] {
  const capability = parseMatrixModelCapabilities(choice.capability)

  return capability && capability.id === choice.model
    ? capability.efforts.filter((level): level is MatrixEffort => Boolean(parseMatrixEffort(level)))
    : choice.reasoning === false
      ? []
      : MATRIX_EFFORTS
}

/** Atum's endpoint in every profile (electron/matrix/hermes-setup.ts MATRIX_MANAGED_ENDPOINT). */
export const MATRIX_ATUM_PROVIDER = 'atum-gateway'

/**
 * The upstream session-scoped model switch (`config.set model` with the session) a resumed
 * conversation needs before its next turn, or undefined when it already runs on `wanted`.
 * Applied at the turn boundary only, so a running turn never changes model. A named custom
 * endpoint reports itself as `custom`/`custom:<name>`, so only a model name decides there;
 * Atum's own model names all count as one (the proxy picks among them per request).
 */
export function matrixSessionModelSwitch(
  session: { model?: unknown; provider?: unknown } | undefined,
  wanted: MatrixConnectedModel
): string | undefined {
  const model = typeof session?.model === 'string' ? session.model.trim() : ''
  const provider = typeof session?.provider === 'string' ? session.provider.trim().toLowerCase() : ''

  if (!model) {
    // Not built yet: it is created from the profile's model, which is `wanted`.
    return undefined
  }

  const atum = wanted.provider === MATRIX_ATUM_PROVIDER

  const sameModel = atum ? isAtumModelName(model) : model === wanted.model

  const sameProvider =
    atum ||
    !provider ||
    provider === wanted.provider.toLowerCase() ||
    provider === 'custom' ||
    provider.startsWith('custom:')

  if (sameModel && sameProvider) {
    return undefined
  }

  return `${wanted.model} --provider ${wanted.provider} --session`
}
