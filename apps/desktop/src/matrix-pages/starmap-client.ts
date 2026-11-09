import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type { MatrixStarmapClient } from '../../shared/matrix-starmap'

export function createMatrixStarmapClient(request: <T>(value: MatrixPagesRequest) => Promise<T>): MatrixStarmapClient {
  return { graph: () => request({ path: '/api/starmap/graph' }) }
}
