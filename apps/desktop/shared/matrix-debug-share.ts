export const MATRIX_DEBUG_LABELS = ['report', 'agent.log', 'gateway.log', 'gui.log', 'desktop.log'] as const
export const MATRIX_DEBUG_DESTINATIONS = ['paste.rs', 'dpaste.com'] as const
export type MatrixDebugLabel = (typeof MATRIX_DEBUG_LABELS)[number]
export type MatrixDebugDestination = (typeof MATRIX_DEBUG_DESTINATIONS)[number]
export interface MatrixDebugFile {
  label: MatrixDebugLabel
  text: string
  bytes: number
}
export interface MatrixDebugPreview {
  files: MatrixDebugFile[]
}
export interface MatrixDebugStatus {
  state: 'unknown' | 'running' | 'succeeded' | 'uncertain'
  destination: MatrixDebugDestination | null
  urls: { label: MatrixDebugLabel; url: string }[]
  uncertainLabel: MatrixDebugLabel | null
}
export interface MatrixDebugConfirmation {
  destination: MatrixDebugDestination
  files: { label: MatrixDebugLabel; bytes: number }[]
}
export interface MatrixDebugClient {
  preview(): Promise<MatrixDebugPreview>
  status(): Promise<MatrixDebugStatus>
  upload(
    destination: MatrixDebugDestination,
    labels: MatrixDebugLabel[]
  ): Promise<{ status: 'cancelled' } | { status: 'started'; value: MatrixDebugStatus }>
  open(label: MatrixDebugLabel): Promise<unknown>
  copy(label: MatrixDebugLabel): Promise<unknown>
}
