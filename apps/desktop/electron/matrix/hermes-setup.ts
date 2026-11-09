import type { MatrixHermesModel, MatrixHermesSetupResult } from '../../shared/matrix'
import { type MatrixConnectedModel, parseMatrixConnectedModel } from '../../shared/matrix-models'
import { matrixPlanSignInOffered } from '../../shared/matrix-provider-terms'
import { MATRIX_NARRATION_DISPLAY } from '../../shared/matrix-turn-style'
import { REQUIRED_SETUP_METHODS } from '../../shared/setup-methods'
import { ATUM_APPROVALS_DEFAULT_MODE } from '../atum-approval-default'

import type { MatrixHermesConnection } from './hermes-runtime'

/** Hermes derives the auth-pool slug from name. Setup and cleanup share this
 * identity; the native layer must not duplicate Hermes's slug algorithm. */
export const MATRIX_HERMES_ENDPOINT = { id: 'matrix-local', name: 'Local executor model' } as const

/** Native input boundary, not a provider catalog or a room-controlled endpoint. */
export function parseMatrixHermesModel(value: unknown): MatrixHermesModel {
  const input = value as MatrixHermesModel

  if (
    !input ||
    typeof input.baseUrl !== 'string' ||
    input.baseUrl.length > 2048 ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    input.model.length > 256 ||
    typeof input.apiKey !== 'string' ||
    input.apiKey.length > 8192 ||
    /[\r\n\0]/.test(input.baseUrl + input.model + input.apiKey)
  ) {
    throw new Error('matrix_setup_invalid')
  }

  let url: URL

  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new Error('matrix_setup_invalid')
  }

  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('matrix_setup_invalid')
  }

  return { baseUrl: url.href.replace(/\/$/, ''), model: input.model.trim(), apiKey: input.apiKey.trim() }
}

/** Resolve readiness through the same native Hermes provider path as session creation.
 * Hermes v0.22.5 retired Tirith and its installer, so setup has no helper to install. */
export async function matrixHermesReadiness(
  connection: MatrixHermesConnection,
  signal: AbortSignal
): Promise<MatrixHermesSetupResult> {
  signal.throwIfAborted()
  // A profile's first check can load provider modules and migrate its home.
  const model = await connection.gateway.request<{ ok: boolean }>(REQUIRED_SETUP_METHODS.runtimeCheck, {}, 60_000, signal)
  signal.throwIfAborted()

  return { state: model?.ok === true ? 'ready' : 'model_required' }
}

/** Atum's model through the loopback proxy; the person can still choose their own later. */
// Not 'atum-managed': that name is the old app's built-in Hermes provider, which
// takes its key from ATUM_MANAGED_MODEL_PROXY_TOKEN. A custom endpoint with the same
// id resolves to that provider, finds no key, and leaves the assistant without a model.
export const MATRIX_MANAGED_ENDPOINT = { id: 'atum-gateway', name: 'Atum' } as const

/** Atum's default model's catalogue budget, declared so Hermes does not probe the
 * gateway for it each time it builds an agent. Nguyệt Thực 1.3 (GPT-6 Luna) carries
 * 1,000,000 tokens in the model-choice policy map (
 * §3.2) and the plan's limits audit sets the Mac's declared window to the catalogue's
 * `context_tokens` for the default alias, 1M (2026-10-17-reliability-first-program.md
 * §6.1 A). Nhật Thực 1.1's catalogue budget is smaller (120,000) but no human edge
 * enforces it (line-up §1.2 item 3), so one number is declared for both. This is not
 * the old app's 75,000 (atum-managed-model-proxy.ts MANAGED_CONTEXT_LENGTH), which
 * advertised a smaller window to fit that proxy's 400 KB body cap. */
export const MATRIX_MANAGED_CONTEXT_LENGTH = 1_000_000

/** Rooms carry their own names, so Hermes's chat-title call only delayed the reply
 * (the app posts once Hermes is idle) and cost an extra model call. */
const MATRIX_TITLES_OFF = { title_generation: { enabled: false } }

/** A lasting conversation lets Hermes compact every non-system message. Keep its
 * thresholds and tail protection unchanged until the owner-run cost measurement. */
const MATRIX_COMPRESSION = { protect_first_n: 0 } as const

/** How an endpoint is written: its key replaced, made the default, no model discovery. */
const MATRIX_ENDPOINT_OPTIONS = { replace_api_key: true, make_default: true, discover_models: false } as const

export function configureMatrixHermes(
  connection: MatrixHermesConnection,
  value: MatrixHermesModel,
  signal: AbortSignal
): Promise<MatrixHermesSetupResult> {
  return configureEndpoint(connection, MATRIX_HERMES_ENDPOINT, parseMatrixHermesModel(value), signal)
}

/** The default for a new assistant: no endpoint or key to type (parity with the old app). */
export function configureMatrixManagedModel(
  connection: MatrixHermesConnection,
  proxy: { baseUrl: string; apiKey: string; model: string },
  signal: AbortSignal
): Promise<MatrixHermesSetupResult> {
  return configureEndpoint(connection, MATRIX_MANAGED_ENDPOINT, parseMatrixHermesModel(proxy), signal, {
    model: { context_length: MATRIX_MANAGED_CONTEXT_LENGTH }
  })
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export const MATRIX_FULL_HERMES_CONFIG = {
  approvals: { mode: ATUM_APPROVALS_DEFAULT_MODE },
  compression: MATRIX_COMPRESSION,
  memory: { memory_enabled: true, user_profile_enabled: true },
  terminal: { home_mode: 'auto', auto_source_bashrc: true },
  // The agent's remarks and started tools reach the owner's chat (agent-turns/1.4): the values Hermes
  // defaults to, written out so they do not depend on a default. Applied once, with the rest, to a new
  // home; a home that already had this profile applied is not rewritten (a choice of the person's stays theirs).
  display: MATRIX_NARRATION_DISPLAY,
  // Web search for everyone with no key (FR6): DuckDuckGo through the bundled ddgs package.
  // It searches only; `web_extract` reads pages with the bundled keyless reader
  // (plugins/web/direct, which `web_extract` falls back to for a search-only backend) and the
  // bundled browser opens the pages that need JavaScript. A provider the person picks later
  // replaces it (this is applied once).
  web: { backend: 'ddgs' }
} as const

export async function applyMatrixFullHermes(connection: MatrixHermesConnection, signal: AbortSignal) {
  signal.throwIfAborted()
  await connection.api('/api/config', { config: MATRIX_FULL_HERMES_CONFIG })
}

/** Everything the launch-time model check writes into a profile besides the proxy's address,
 * model and key, as data. A change to any of it invalidates the stamp that lets a later launch
 * skip the check (model-check.ts); hermes-setup.test.ts fails when a write is not listed here. */
export const MATRIX_MODEL_CHECK_WRITES = {
  endpoint: MATRIX_MANAGED_ENDPOINT,
  endpointOptions: MATRIX_ENDPOINT_OPTIONS,
  contextLength: MATRIX_MANAGED_CONTEXT_LENGTH,
  auxiliary: MATRIX_TITLES_OFF,
  compression: MATRIX_COMPRESSION,
  full: MATRIX_FULL_HERMES_CONFIG
} as const

/** Current defaults for a profile set up by an earlier build (settings deep-merge). */
export async function applyMatrixManagedDefaults(connection: MatrixHermesConnection, signal: AbortSignal, managed = true) {
  signal.throwIfAborted()
  await connection.api('/api/config', {
    config: {
      ...(managed ? { model: { context_length: MATRIX_MANAGED_CONTEXT_LENGTH } } : {}),
      auxiliary: MATRIX_TITLES_OFF,
      compression: MATRIX_COMPRESSION
    }
  })
}

/** Read the selected provider from Hermes, not a stale UI flag. A missing credential
 * is not permission to replace an imported or explicitly selected key-based provider.
 *
 * A subscription connection Atum offers (for example `openai-codex`) is optional account
 * state, not assistant readiness. If that plan is selected but unusable, the profile returns to
 * the managed Atum endpoint automatically; Connections remains the place to add ChatGPT later. */
export async function prepareMatrixHermesModel(
  connection: MatrixHermesConnection,
  proxy: MatrixHermesModel,
  signal: AbortSignal
): Promise<{
  ownModel: boolean
  readiness: MatrixHermesSetupResult
  connected?: MatrixConnectedModel
  planSignIn?: string
}> {
  const value = await connection.gateway.request<{ config?: { model?: unknown } }>(REQUIRED_SETUP_METHODS.configGet, { key: 'full' }, 60_000, signal)
  signal.throwIfAborted()

  if (!value?.config || typeof value.config !== 'object') {
    throw new Error('matrix_setup_failed')
  }

  const model = value.config.model
  const provider = typeof model === 'object' && model !== null ? (model as { provider?: unknown }).provider : undefined

  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error('matrix_setup_failed')
  }

  const selected = typeof provider === 'string' ? provider.trim().toLowerCase() : ''

  const explicitOwn = typeof model === 'string'
    ? Boolean(model.trim())
    : Boolean(selected && selected !== 'auto' && selected !== MATRIX_MANAGED_ENDPOINT.id)

  const readiness = await matrixHermesReadiness(connection, signal)

  if (readiness.state === 'model_required') {
    if (explicitOwn) {
      if (matrixPlanSignInOffered(selected)) {
        return { ownModel: false, readiness: await configureMatrixManagedModel(connection, proxy, signal) }
      }

      return { ownModel: true, readiness }
    }

    return { ownModel: false, readiness: await configureMatrixManagedModel(connection, proxy, signal) }
  }

  // Hermes may resolve an automatically chosen provider from the person's environment.
  // Preserve that working choice too; only Atum's endpoint gets Atum's context cap.
  const ownModel = explicitOwn || selected !== MATRIX_MANAGED_ENDPOINT.id
  await applyMatrixManagedDefaults(connection, signal, !ownModel)

  // The connection's name for the picker, when the profile names both.
  const name = typeof model === 'object' && model !== null ? (model as { default?: unknown }).default : model
  const connected = ownModel ? parseMatrixConnectedModel({ provider: selected, model: name }) : undefined

  return {
    ownModel,
    readiness: await matrixHermesReadiness(connection, signal),
    ...(connected ? { connected } : {})
  }
}

async function configureEndpoint(
  connection: MatrixHermesConnection,
  endpoint: { id: string; name: string },
  model: MatrixHermesModel,
  signal: AbortSignal,
  extra: Record<string, unknown> = {}
): Promise<MatrixHermesSetupResult> {
  signal.throwIfAborted()
  // Hermes owns normalization, secret persistence, file modes and merging.
  // Only this owner/executor's profile is reachable; no profile selector on IPC.
  await connection.api('/api/providers/custom-endpoints', {
    ...endpoint,
    base_url: model.baseUrl,
    model: model.model,
    api_key: model.apiKey,
    ...MATRIX_ENDPOINT_OPTIONS
  })
  signal.throwIfAborted()
  // Only what Atum needs on top of Hermes's defaults; the rest stays Hermes's.
  await connection.api('/api/config', {
    config: { auxiliary: MATRIX_TITLES_OFF, compression: MATRIX_COMPRESSION, ...extra }
  })

  return matrixHermesReadiness(connection, signal)
}

/**
 * The readiness code for an agent whose setup did not finish (main's assistant gate step):
 * `plan_sign_in` when its last model check found the person's own plan signed out (the one
 * thing that helps is that sign-in, which the chat and the title bar offer), else
 * `setup_failed`. Undefined while nothing failed.
 */
export function matrixSetupBlock(input: {
  setup: 'working' | 'failed' | 'action_required' | undefined
  planSignIn: boolean
  enrolled: boolean
}): 'plan_sign_in' | 'setup_failed' | undefined {
  if (input.setup === 'failed' && input.planSignIn && input.enrolled) {
    return 'plan_sign_in'
  }

  return input.setup === 'failed' || !input.enrolled ? 'setup_failed' : undefined
}

/** An explicit switch back to Atum's model owns its own short-lived Hermes connection. The
 * assistant backend may be stopped precisely because its previous provider is unusable, so a
 * ready host is deliberately not part of this gate. */
export function matrixAtumModelSwitchBlocked(input: {
  operation: boolean
  agentOperation: boolean
  domainOperation: boolean
  invocation: boolean
  signIn: boolean
  accountReady: boolean
  runtime: boolean
  managedModel: boolean
}): boolean {
  return (
    input.operation ||
    input.agentOperation ||
    input.domainOperation ||
    input.invocation ||
    input.signIn ||
    !input.accountReady ||
    !input.runtime ||
    !input.managedModel
  )
}

/** A deliberate Atum-model switch is the event that releases a plan-sign-in gate. */
export function finishMatrixAtumModelSwitch(
  host: { planSignIn: boolean; readiness?: { recheck(): void } },
  ready: boolean
): void {
  if (!ready) {
    return
  }

  host.planSignIn = false
  host.readiness?.recheck()
}
