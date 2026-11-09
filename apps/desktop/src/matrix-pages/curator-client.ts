import type { MatrixCuratorClient } from '../../shared/matrix-curator'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

export function createMatrixCuratorClient(request: (value: MatrixPagesRequest) => Promise<unknown>): MatrixCuratorClient {
  return {
    status: () =>
      request({ path: '/api/command-center/curator/status', method: 'GET' }) as ReturnType<
        MatrixCuratorClient['status']
      >,
    act: action =>
      request({ path: `/api/command-center/curator/${action}`, method: 'POST' }) as ReturnType<
        MatrixCuratorClient['act']
      >
  }
}
