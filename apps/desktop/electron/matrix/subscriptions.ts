import type {
  MatrixProviderConfirmation,
  MatrixProviderRow,
  MatrixProviderSnapshot
} from '../../shared/matrix-provider-settings'
import {
  MATRIX_SUBSCRIPTION_PROVIDERS,
  type MatrixSubscriptionCatalog,
  type MatrixSubscriptionProvider,
  matrixSubscriptionProviderLabel,
  type MatrixSubscriptionProviderStatus
} from '../../shared/matrix-subscriptions'

import type { MatrixPagesForwardRequest } from './pages-bridge'
import { MatrixPagesProvidersScope } from './pages-providers'

/**
 * The picker's subscriptions (2026-10-27). Read through the same Connections adapter the
 * model catalog uses, but only the two account subscriptions and only safe model names.
 * A cloud-only agent never reaches this: it has no Mac runtime to read.
 */
export interface MatrixSubscriptionAgent {
  agentName?: string
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  isCurrent(): boolean
}

function subscriptionScope(agent: MatrixSubscriptionAgent): MatrixPagesProvidersScope {
  return new MatrixPagesProvidersScope({
    // Settings › Connections may start a plan sign-in but this read starts nothing.
    surface: 'connections',
    readPlanAcknowledgment: () => undefined,
    savePlanAcknowledgment: () => {
      throw new Error('matrix_pages_request_forbidden')
    },
    forward: request => agent.forward(request),
    isCurrent: () => agent.isCurrent(),
    confirm: (_: MatrixProviderConfirmation) => false,
    openExternal: () => {
      throw new Error('matrix_pages_request_forbidden')
    }
  })
}

/** The same model-identifier policy the route parser applies. */
function modelSupported(model: string): boolean {
  return (
    model.length > 0 &&
    model.length <= 1024 &&
    model === model.trim() &&
    !model.startsWith('-') &&
    !/[\p{Cc}\s]/u.test(model)
  )
}

function providerStatus(row: MatrixProviderRow | undefined, provider: MatrixSubscriptionProvider): MatrixSubscriptionProviderStatus {
  if (!row) {
    return { id: provider, connected: false }
  }

  const connected =
    provider === 'openai-codex'
      ? row.oauth?.connected === true || row.ready
      : row.ready

  return {
    id: provider,
    connected,
    // A signed-out connection contributes no models, exactly as the picker's accounts do.
    ...(connected
      ? { models: [...new Set(row.models)].filter(modelSupported) }
      : {})
  }
}

export function matrixSubscriptionCatalogFromSnapshot(snapshot: MatrixProviderSnapshot): MatrixSubscriptionCatalog {
  return {
    destination: 'this_mac',
    providers: MATRIX_SUBSCRIPTION_PROVIDERS.map(provider =>
      providerStatus(snapshot.providers.find(row => row.id === provider), provider)
    )
  }
}

export async function listMatrixSubscriptionCatalog(agent: MatrixSubscriptionAgent): Promise<MatrixSubscriptionCatalog> {
  const snapshot = (await subscriptionScope(agent).request({
    path: '/api/provider-settings/snapshot',
    method: 'GET'
  })) as MatrixProviderSnapshot

  return matrixSubscriptionCatalogFromSnapshot(snapshot)
}

/**
 * The account's saved ChatGPT grant beside this assistant's live view of it. A grant Hermes
 * quarantined (expired or revoked) shows as "sign in again", never as a plan that was never
 * connected; a live view the assistant already has always wins.
 */
export function matrixSubscriptionCatalogWithGrant(
  catalog: MatrixSubscriptionCatalog,
  grant: 'none' | 'saved' | 'needs_sign_in'
): MatrixSubscriptionCatalog {
  return {
    ...catalog,
    providers: catalog.providers.map(provider =>
      provider.id === 'openai-codex' && !provider.connected && grant === 'needs_sign_in'
        ? { ...provider, needsSignIn: true }
        : provider
    )
  }
}

/** Safe, untranslated service labels for a catalog; exported for tests and presentation. */
export function matrixSubscriptionLabel(provider: MatrixSubscriptionProvider): string {
  return matrixSubscriptionProviderLabel(provider)
}
