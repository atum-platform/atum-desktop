import type { MatrixCommandCenterOpsClient } from '../../shared/matrix-command-center-ops'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

export function createMatrixCommandCenterOpsClient(
  request: <T>(value: MatrixPagesRequest) => Promise<T>
): MatrixCommandCenterOpsClient {
  return {
    status: action => request({ path: `/api/command-center/maintenance/${action}/status` }),
    run: action => request({ path: `/api/command-center/maintenance/${action}/run`, method: 'POST' }),
    revealBackup: () => request({ path: '/api/command-center/maintenance/backup/reveal', method: 'POST' })
  }
}
