import type { MatrixCommandCenterClient } from '../../shared/matrix-command-center'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

export function createMatrixCommandCenterClient(
  request: <T>(value: MatrixPagesRequest) => Promise<T>
): MatrixCommandCenterClient {
  return {
    status: () => request({ path: '/api/command-center/status' }),
    logs: (file, level) => request({ path: `/api/command-center/logs?${new URLSearchParams({ file, level })}` }),
    usage: days => request({ path: `/api/command-center/usage?days=${days}` }),
    curator: () => request({ path: '/api/command-center/curator' })
  }
}
