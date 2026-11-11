import type { MatrixModelCapabilities } from '../../shared/matrix-model-choice'
import {
  MATRIX_ATUM_PROVIDER,
  MATRIX_CONNECTED_MODEL_ERRORS,
  MATRIX_EFFORTS,
  MATRIX_MODEL_ROUTE_LIST_MAX,
  type MatrixConnectedModel,
  type MatrixEffort,
  type MatrixModelAccount,
  type MatrixModelCatalog,
  type MatrixModelConnection,
  type MatrixModelRoute,
  matrixModelRouteId,
  type MatrixModelRouteSelection,
  parseMatrixModel,
  parseMatrixModelRouteId
} from '../../shared/matrix-models'
import type {
  MatrixProviderRow,
  MatrixProviderSnapshot,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'

import type { MatrixPagesForwardRequest } from './pages-bridge'
import { MatrixPagesProvidersScope } from './pages-providers'
import { atumChatGptModelVisible } from './subscriptions'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export interface MatrixConnectedModelsAgent {
  /** The connection main remembered from Hermes's own readback; never a renderer fact. */
  connected: MatrixConnectedModel
  /** Catalog publication may inspect external connections while Atum is still current. */
  allowManagedCurrent?: boolean
  /** The assistant's own name, for copy that says whose model changes. */
  agentName?: string
  /** This agent's own Hermes REST (a management transport: writes wait for no turn, they refuse). */
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  isCurrent(): boolean
  /** Hermes says the model costs extra: only the person, in main's own dialog, may accept that. */
  confirmCost(request: { provider: string; model: string; message: string }): boolean | Promise<boolean>
  /** After Hermes reads the switch back: what the agent now answers with. */
  selected(model: MatrixConnectedModel): void | Promise<void>
}

export type MatrixConnectedModelRequest =
  | { kind: 'modelCatalog'; roomId: string }
  | { kind: 'selectModelRoute'; roomId: string; routeId: string; target: 'agent_default' }

/** The window's two requests: a room, and for a switch one route id plus its intended target. */
export function parseMatrixConnectedModelRequest(value: unknown): MatrixConnectedModelRequest {
  const row = value as Record<string, unknown> | null

  const roomId = (input: unknown) =>
    typeof input === 'string' && input.startsWith('!') && input.length <= 1024 && !/[\p{Cc}\s]/u.test(input)

  if (!row || typeof row !== 'object' || Array.isArray(row) || !roomId(row.roomId)) {
    throw new Error('matrix_command_invalid')
  }

  const keys = Object.keys(row).sort().join(',')

  if (row.kind === 'modelCatalog' && keys === 'kind,roomId') {
    return { kind: 'modelCatalog', roomId: row.roomId as string }
  }

  if (
    row.kind === 'selectModelRoute' &&
    keys === 'kind,roomId,routeId,target' &&
    typeof row.routeId === 'string' &&
    parseMatrixModelRouteId(row.routeId) &&
    row.target === 'agent_default'
  ) {
    return {
      kind: 'selectModelRoute',
      roomId: row.roomId as string,
      routeId: row.routeId,
      target: 'agent_default'
    }
  }

  throw new Error('matrix_command_invalid')
}

function refuse(error: unknown): never {
  const code = error instanceof Error ? error.message : ''

  if (code === 'pages_agent_busy') {
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.busy)
  }

  if (code === 'matrix_provider_not_ready' || code === MATRIX_CONNECTED_MODEL_ERRORS.unavailable) {
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
  }

  throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.failed)
}

/** Service names, never translated; anything else shows the provider's own safe name. */
const CONNECTED_SERVICE_NAME: Readonly<Record<string, string>> = {
  'openai-codex': 'ChatGPT',
  'openai-api': 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google',
  openrouter: 'OpenRouter',
  'xai-oauth': 'xAI',
  'minimax-oauth': 'MiniMax',
  'qwen-oauth': 'Qwen',
  'copilot-acp': 'Copilot'
}

function labels(row: MatrixProviderRow): {
  providerLabel: string
  accountLabel: string
  connection: MatrixModelConnection
} {
  const providerLabel = Object.hasOwn(CONNECTED_SERVICE_NAME, row.id) ? CONNECTED_SERVICE_NAME[row.id] : row.name

  const connection = row.kind ?? 'local'

  const accountLabel = connection === 'plan' ? `${providerLabel} Plan` : connection === 'key' ? 'API key' : row.name

  return { providerLabel, accountLabel, connection }
}

function levels(row: MatrixProviderRow, model: string): MatrixEffort[] {
  const advertised = row.efforts?.[model]

  if (!advertised) {
    return []
  }

  return [...new Set(advertised)]
}

/** The same model-identifier policy the route parser applies before any selection. */
function routeModelSupported(model: string): boolean {
  return (
    model.length > 0 &&
    model.length <= 1024 &&
    model === model.trim() &&
    !model.startsWith('-') &&
    !/[\p{Cc}\s]/u.test(model)
  )
}

/**
 * Build the picker's catalog from the Connections adapter's snapshot. Exported for the native
 * tests that prove two providers with the same model stay distinct and no private field leaks.
 */
export function matrixModelCatalogFromSnapshot(
  snapshot: MatrixProviderSnapshot,
  agentName?: string
): MatrixModelCatalog {
  const rows = snapshot.providers.filter(row => row.id !== 'nous' && row.id !== MATRIX_ATUM_PROVIDER)
  const currentChoice = snapshot.current

  const routes: MatrixModelRoute[] = []
  const uniqueModels = new Map<string, string[]>()

  for (const row of rows) {
    const models = [...new Set(row.models)].filter(model =>
      row.id !== 'openai-codex' || atumChatGptModelVisible(model))
    uniqueModels.set(row.id, models)

    if (!row.ready) {
      continue
    }

    const { providerLabel, accountLabel, connection } = labels(row)
    const supported = models.filter(routeModelSupported)
    const currentModel = currentChoice?.provider === row.id ? currentChoice.model : undefined

    const currentUnsupported =
      currentModel !== undefined && models.includes(currentModel) && !routeModelSupported(currentModel)
        ? currentModel
        : undefined

    for (const model of supported) {
      const current = currentModel === model
      const advertised = levels(row, model)

      routes.push({
        id: matrixModelRouteId(row.id, model),
        provider: row.id,
        model,
        name: model,
        providerLabel,
        accountLabel,
        connection,
        target: 'agent_default',
        destination: 'this_mac',
        // A provider that advertises no levels is not unusable: Hermes accepts the effort level
        // broadly and folds it where the model ignores it (matrixConnectedModelEfforts says the
        // same). Empty levels made every such route disappear, including every ChatGPT model.
        efforts: advertised.length > 0 ? advertised : [...MATRIX_EFFORTS],
        current,
        ready: true
      })
    }

    // Keep the model actually in use visible even when its identifier is outside the route
    // policy: it is current, but not selectable through this route. Never substitute another
    // supported model as "current", and never send this id to the adapter.
    if (currentUnsupported !== undefined) {
      routes.push({
        id: matrixModelRouteId(row.id, currentUnsupported),
        provider: row.id,
        model: currentUnsupported,
        name: currentUnsupported,
        providerLabel,
        accountLabel,
        connection,
        target: 'agent_default',
        destination: 'this_mac',
        efforts: levels(row, currentUnsupported),
        current: true,
        ready: false
      })
    }
  }

  const currentRoute = currentChoice
    ? routes.find(route => route.provider === currentChoice.provider && route.model === currentChoice.model)
    : undefined

  const bounded = routes.slice(0, MATRIX_MODEL_ROUTE_LIST_MAX)

  // The model in use is always listed, so it can be seen checked even far down a long catalog.
  if (currentRoute && !bounded.some(route => route.id === currentRoute.id)) {
    bounded[bounded.length - 1] = currentRoute
  }

  const listed = new Map<string, number>()

  for (const route of bounded) {
    listed.set(route.provider, (listed.get(route.provider) ?? 0) + 1)
  }

  const accounts: MatrixModelAccount[] = rows.map(row => {
    const { providerLabel, accountLabel, connection } = labels(row)
    const models = uniqueModels.get(row.id)?.length ?? 0
    const shown = row.ready ? (listed.get(row.id) ?? 0) : 0

    return {
      id: row.id,
      providerLabel,
      accountLabel,
      connection,
      ready: row.ready,
      models,
      ...(row.ready && models > shown ? { truncated: true } : {})
    }
  })

  // Atum's managed endpoint is the profile's own default and is deliberately not a room route
  // (the picker changes local connections, not Atum's model). It is still a model this Mac can
  // answer with, so placement needs it: without it a Mac with only Atum connected publishes an
  // empty catalog, which the platform cannot list as a place to move to. Only when it is the
  // profile's current provider: moving a ChatGPT profile and calling it Atum would be a lie,
  // because a `source: 'atum'` choice applies nothing to the Mac's profile.
  const managedRow = snapshot.providers.find(
    row => row.id === MATRIX_ATUM_PROVIDER && row.ready && row.current
  )
  // The model the profile leads with is the one it runs; a `source: 'atum'` choice applies
  // nothing on the Mac, so offering a second managed alias would name a model it does not use.
  const managedModel = managedRow?.models.map(parseMatrixModel).find(Boolean)
  const managed = managedModel ? [managedModel] : []

  return {
    routes: bounded,
    accounts,
    ...(currentRoute ? { current: currentRoute.id } : {}),
    ...(agentName ? { agentName } : {}),
    destination: 'this_mac',
    ...(managed.length > 0 ? { managed } : {}),
    ...(routes.length > bounded.length || accounts.some(account => account.truncated) ? { truncated: true } : {}),
    unavailable: accounts.filter(account => !account.ready).length
  }
}

function adapter(
  agent: MatrixConnectedModelsAgent,
  selected?: (
    provider: string,
    model: string,
    reasoning?: boolean,
    capability?: MatrixModelCapabilities
  ) => void | Promise<void>
) {
  if (agent.connected.provider === MATRIX_ATUM_PROVIDER && agent.allowManagedCurrent !== true) {
    // The interactive connection picker stays hidden while Atum is current. The placement
    // participant opts into a catalog-only read so a cloud-home agent can choose a Mac model.
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
  }

  return new MatrixPagesProvidersScope({
    // Only `snapshot` and `select` are ever asked of this adapter: no sign-in, key or endpoint.
    surface: 'connections',
    readPlanAcknowledgment: () => undefined,
    savePlanAcknowledgment: () => {
      throw new Error('matrix_pages_request_forbidden')
    },
    forward: request => agent.forward(request),
    isCurrent: () => agent.isCurrent(),
    // The person picked this route in Atum's own picker: that pick is the confirmation the
    // Connections page asks for. A model Hermes says costs extra still asks, in main's dialog.
    confirm: request =>
      request.kind === 'provider-select'
        ? true
        : request.kind === 'expensive-model'
          ? agent.confirmCost({ provider: request.provider, model: request.model, message: request.message })
          : false,
    openExternal: () => {
      throw new Error('matrix_pages_request_forbidden')
    },
    selected: selected
      ? selected
      : (provider, model, reasoning, capability) =>
          agent.selected({
            provider,
            model,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(capability ? { capability } : {})
          })
  })
}

/** Every ready route from the agent's Hermes catalog: names, safe labels and readiness only. */
export async function listMatrixModelCatalog(agent: MatrixConnectedModelsAgent): Promise<MatrixModelCatalog> {
  try {
    const snapshot = (await adapter(agent).request({
      path: '/api/provider-settings/snapshot',
      method: 'GET'
    })) as MatrixProviderSnapshot

    return matrixModelCatalogFromSnapshot(snapshot, agent.agentName)
  } catch (error) {
    refuse(error)
  }
}

/**
 * One switch through the native select. The route id names the provider and model, but main
 * never trusts it: the adapter re-reads the catalog, confirms the row is ready and lists that
 * model, performs the existing cost confirmation, writes, and reads back before `applied`.
 */
export async function selectMatrixModelRoute(
  agent: MatrixConnectedModelsAgent,
  routeId: string
): Promise<MatrixModelRouteSelection> {
  const route = parseMatrixModelRouteId(routeId)

  if (!route || route.provider === 'nous' || route.provider === MATRIX_ATUM_PROVIDER) {
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
  }

  if (route.provider === 'openai-codex' && !atumChatGptModelVisible(route.model)) {
    throw new Error(MATRIX_CONNECTED_MODEL_ERRORS.unavailable)
  }

  let readback: MatrixConnectedModel | undefined

  try {
    const result = (await adapter(agent, (provider, model, reasoning, capability) => {
      readback = {
        provider,
        model,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(capability ? { capability } : {})
      }

      return agent.selected(readback)
    }).request({
      path: '/api/provider-settings/select',
      method: 'POST',
      body: { provider: route.provider, model: route.model }
    })) as MatrixProviderWriteResult

    if (result.status === 'cancelled') {
      return { status: 'cancelled' }
    }

    return {
      status: 'applied',
      ...(readback ? { current: matrixModelRouteId(readback.provider, readback.model) } : {})
    }
  } catch (error) {
    refuse(error)
  }
}
