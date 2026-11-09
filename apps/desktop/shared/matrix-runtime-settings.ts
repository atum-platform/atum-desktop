/** Narrow presentation contract; no config, credentials or profile selectors. */
export interface MatrixRuntimeSnapshot {
  main: { provider: string; model: string; contextLength?: number } | null
  modelEditable: boolean
  models: string[]
  memory: {
    active: string
    providers: { name: string; description: string; status: 'ready' | 'needs_config' | 'unavailable' }[]
  }
}

export type MatrixRuntimeWriteResult =
  | { status: 'applied'; kind: 'model'; provider: string; model: string; staleAux: boolean }
  | { status: 'applied'; kind: 'memory'; active: string }
  | { status: 'cancelled' }

export type MatrixRuntimeConfirmation =
  | { kind: 'expensive-model'; provider: string; model: string; message: string }
  | { kind: 'memory'; provider: string }

export interface MatrixRuntimeSettingsClient {
  snapshot(): Promise<MatrixRuntimeSnapshot>
  setModel(provider: string, model: string): Promise<MatrixRuntimeWriteResult>
  setMemory(provider: string): Promise<MatrixRuntimeWriteResult>
}
