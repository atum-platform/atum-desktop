export interface TerminalReadOptions {
  start?: number
  count?: number
}

export interface TerminalReadResult {
  total_lines: number
  start: number
  end: number
  viewport_rows: number
  cursor_row: number
  text: string
}

export interface MatrixTerminalTab {
  id: string
  ordinal: number
  open: boolean
}

export interface MatrixTerminalData {
  id: string
  scope: string
  sequence: number
  output: string
}

export interface MatrixTerminalChunk {
  id: string
  scope: string
  sequence: number
  chunk: string
}

export interface MatrixTerminalReadRequest extends TerminalReadOptions {
  id: string
}

/** Existing gateway process events, retained only inside native custody. */
export type MatrixHermesTerminalEvent =
  | { kind: 'output'; processId: string; chunk: string }
  | { kind: 'close'; processId: string }

export interface MatrixTerminalBridge {
  open(roomId: string, id: string): Promise<void>
  close(roomId: string, id: string): Promise<void>
  read(roomId: string, id: string): Promise<MatrixTerminalData>
  respond(roomId: string, id: string, result: TerminalReadResult | null): Promise<void>
  subscribe(listener: (value: MatrixTerminalChunk) => void): () => void
}
