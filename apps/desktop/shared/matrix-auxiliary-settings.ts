/** Tasks exposed by Hermes' existing auxiliary GET/single-task writer. */
export const MATRIX_AUXILIARY_TASKS = [
  'vision',
  'web_extract',
  'compression',
  'skills_hub',
  'approval',
  'mcp',
  'title_generation',
  'pet_hatch',
  'triage_specifier',
  'kanban_decomposer',
  'profile_describer',
  'curator'
] as const
export type MatrixAuxiliaryTask = (typeof MATRIX_AUXILIARY_TASKS)[number]

export interface MatrixAuxiliaryAssignment {
  task: MatrixAuxiliaryTask
  provider: string
  model: string
}

/** Projected facts only; no credentials, endpoints or profile selectors. */
export interface MatrixAuxiliarySnapshot {
  tasks: MatrixAuxiliaryAssignment[]
  providers: { id: string; models: string[] }[]
}

export type MatrixAuxiliaryWriteResult =
  | { status: 'applied'; task: MatrixAuxiliaryTask; provider: string; model: string }
  | { status: 'cancelled' }

export interface MatrixAuxiliaryConfirmation extends MatrixAuxiliaryAssignment {
  kind: 'pin' | 'expensive-model'
}

export interface MatrixAuxiliaryClient {
  snapshot(): Promise<MatrixAuxiliarySnapshot>
  set(task: MatrixAuxiliaryTask, provider: string, model: string): Promise<MatrixAuxiliaryWriteResult>
}
