import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type {
  MatrixProviderOAuthResult,
  MatrixProviderOAuthSession,
  MatrixProviderSettingsClient,
  MatrixProviderSnapshot,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'

/** Typed leaf adapter; the page bridge still owns selected-agent identity. */
export function createMatrixProviderSettingsClient(
  request: (request: MatrixPagesRequest) => Promise<unknown>
): MatrixProviderSettingsClient {
  const post = (action: string, body: unknown) =>
    request({ path: `/api/provider-settings/${action}`, method: 'POST', body })

  return {
    snapshot: () =>
      request({ path: '/api/provider-settings/snapshot', method: 'GET' }) as Promise<MatrixProviderSnapshot>,
    saveKey: (provider, value) =>
      request({
        path: '/api/provider-settings/key',
        method: 'PUT',
        body: { provider, value }
      }) as Promise<MatrixProviderWriteResult>,
    selectModel: (provider, model) => post('select', { provider, model }) as Promise<MatrixProviderWriteResult>,
    addEndpoint: input => post('endpoint', input) as Promise<MatrixProviderWriteResult>,
    startOAuth: async provider => {
      const consent = (await post('oauth/acknowledge', { provider })) as MatrixProviderWriteResult

      if (consent.status !== 'applied') {
        return { status: 'cancelled' }
      }

      return post('oauth/start', { provider }) as Promise<MatrixProviderOAuthSession | MatrixProviderWriteResult>
    },
    pollOAuth: session => post('oauth/poll', { session }) as Promise<MatrixProviderOAuthResult>,
    submitOAuth: (session, code) => post('oauth/submit', { session, code }) as Promise<MatrixProviderOAuthResult>,
    cancelOAuth: session => post('oauth/cancel', { session }) as Promise<MatrixProviderOAuthResult>,
    disconnectOAuth: provider => post('oauth/disconnect', { provider }) as Promise<MatrixProviderWriteResult>
  }
}
