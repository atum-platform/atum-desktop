import type { MatrixUiBridge } from '../../shared/matrix'
import type { WorkspaceTextFileLease } from '../lib/workspace-text-file-lease'

/** Shape adapter only. Main owns the selected file and every scope/revision
 * check; a preview token cannot address another file or another room. */
export function matrixTextDocumentLease(bridge: MatrixUiBridge, token: string, name: string, recoverable: boolean): WorkspaceTextFileLease {
  const api = bridge.textDocument

  if (!api) {throw new Error('matrix_document_unavailable')}

  return {
    fileRef: token, displayName: name,
    read: () => api.read(token),
    write: input => api.write(token, input),
    preserveSibling: () => Promise.reject(new Error('MATRIX_TEXT_DOCUMENT_UNSUPPORTED')),
    ...(recoverable ? { recovery: {
      read: () => api.recoveryRead(token), write: input => api.recoveryWrite(token, input),
      discard: revision => api.recoveryDiscard(token, revision)
    } } : {}),
    watch: callback => {
      let active = true
      let running = false
      let revision: string | undefined

      const timer = setInterval(() => {
        if (!active || running) {return}
        running = true
        void api.read(token).then(snapshot => {
          if (!active) {return}

          if (revision && snapshot.revision !== revision) {callback(snapshot.revision)}
          revision = snapshot.revision
        }).catch(() => {}).finally(() => {running = false})
      }, 1000)

      return () => {active = false; clearInterval(timer)}
    },
    release: () => bridge.closeDocumentPreview(token)
  }
}
