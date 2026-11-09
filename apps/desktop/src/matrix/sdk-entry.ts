import { installMatrixDiagnostics } from './diagnostics'
import type { MatrixSdkHostPort } from './sdk-host-port'
import { serveMatrixSdk } from './sdk-host-serve'

// The desktop's host: the SDK window's preload bridges the port to the main process over
// IPC (electron/matrix/sdk-preload.ts). Browser and headless hosts serve the same engine
// through the same seam (sdk-host-port.ts).
const host = (window as unknown as { matrixSdkHost: MatrixSdkHostPort }).matrixSdkHost

installMatrixDiagnostics()
serveMatrixSdk(host)
