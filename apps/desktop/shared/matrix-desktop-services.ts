import type { DiagnosticError, ReportingStatus } from './atum-observability'
import type { AtumUpdateChannel, AtumUpdateStatus } from './atum-update-flow'

export const MATRIX_DESKTOP_SERVICES = {
  status: 'matrix:desktop-services:status',
  enabled: 'matrix:desktop-services:enabled',
  feedback: 'matrix:desktop-services:feedback',
  active: 'matrix:desktop-services:active',
  ready: 'matrix:desktop-services:ready',
  error: 'matrix:desktop-services:error',
  check: 'matrix:desktop-services:check',
  channel: 'matrix:desktop-services:channel',
  restart: 'matrix:desktop-services:restart',
  changed: 'matrix:desktop-services:changed'
} as const

export interface MatrixDesktopServicesStatus {
  reporting: ReportingStatus
  update: AtumUpdateStatus
  version: string
  busy: boolean
}

/** Main owns events and identity. Renderers can only signal shell activity/errors. */
export interface MatrixDesktopServicesBridge {
  status(): Promise<MatrixDesktopServicesStatus>
  setEnabled(enabled: boolean): Promise<MatrixDesktopServicesStatus>
  feedback(message: string): Promise<{ sent: boolean }>
  active(): void
  ready(): void
  error(error: DiagnosticError): void
  setUpdateChannel(channel: AtumUpdateChannel): Promise<boolean>
  checkUpdates(): Promise<boolean>
  restart(): Promise<boolean>
  onChanged(callback: (status: MatrixDesktopServicesStatus) => void): () => void
}

declare global {
  interface Window {
    atumDesktopServices?: MatrixDesktopServicesBridge
    atumDiagnostics?: Pick<MatrixDesktopServicesBridge, 'error'>
  }
}
