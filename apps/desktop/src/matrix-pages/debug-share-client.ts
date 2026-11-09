import type { MatrixDebugClient } from '../../shared/matrix-debug-share'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

export function createMatrixDebugClient(request: <T>(value: MatrixPagesRequest) => Promise<T>): MatrixDebugClient {
  const prefix = '/api/command-center/debug-share/'

  return {
    preview: () => request({ path: prefix + 'preview', method: 'POST' }),
    status: () => request({ path: prefix + 'status' }),
    upload: (destination, labels) =>
      request({ path: prefix + 'upload', method: 'POST', body: { destination, labels } }),
    open: label => request({ path: prefix + 'open/' + label, method: 'POST' }),
    copy: label => request({ path: prefix + 'copy/' + label, method: 'POST' })
  }
}
