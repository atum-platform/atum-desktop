import { diagnosticFrames } from '../../shared/diagnostic-frames'
import type {} from '../../shared/matrix-desktop-services'

function diagnosticKind(error: unknown): string {
  if (!(error instanceof Error) || !/^[A-Za-z][A-Za-z0-9_]{0,119}$/.test(error.name)) {
    return 'Error'
  }

  return error.name
}

/** Only shipped bundle coordinates survive. Main repeats the same allowlist. */
export function reportMatrixRendererError(error: unknown): void {
  const diagnostics = window.atumDiagnostics ?? window.atumDesktopServices
  const frames = diagnosticFrames(error instanceof Error ? error.stack : undefined)
  diagnostics?.error({
    operation: 'renderer',
    kind: diagnosticKind(error),
    ...(frames.length
      ? {
          stack: frames
            .map(frame => `at ${frame.filename}:${frame.lineno}:${frame.colno}`)
            .reverse()
            .join('\n')
        }
      : {})
  })
}

export function installMatrixDiagnostics(): () => void {
  const onError = (event: ErrorEvent) => reportMatrixRendererError(event.error)
  const onRejection = (event: PromiseRejectionEvent) => reportMatrixRendererError(event.reason)

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
