import type { MatrixMcpResult, MatrixMcpSettingsClient, MatrixMcpSnapshot } from '../../shared/matrix-mcp-settings'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

export function createMatrixMcpSettingsClient(
  request: (value: MatrixPagesRequest) => Promise<unknown>
): MatrixMcpSettingsClient {
  const post = (path: string, body?: unknown) =>
    request({ path, method: 'POST', ...(body === undefined ? {} : { body }) }) as Promise<MatrixMcpResult>

  return {
    snapshot: () => request({ path: '/api/mcp/snapshot', method: 'GET' }) as Promise<MatrixMcpSnapshot>,
    add: input => post('/api/mcp/add', input),
    remove: name => post('/api/mcp/remove', { name }),
    test: name => post('/api/mcp/test', { name }),
    authenticate: name => post('/api/mcp/auth', { name }),
    authStatus: operationId => post('/api/mcp/auth/status', { operationId }),
    cancelAuth: operationId => post('/api/mcp/auth/cancel', { operationId }),
    setEnabled: (name, enabled) => post('/api/mcp/enabled', { name, enabled }),
    install: (name, env) => post('/api/mcp/install', { name, env }),
    installStatus: operationId => post('/api/mcp/install/status', { operationId }),
    reload: () => post('/api/mcp/reload')
  }
}
