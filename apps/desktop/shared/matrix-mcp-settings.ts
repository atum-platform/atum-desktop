/** Closed selected-agent MCP presentation contract. Saved connection/configuration
 * and OAuth URLs/tokens never cross this boundary. Inputs are provisioning only. */
export interface MatrixMcpServer {
  name: string
  transport: 'stdio' | 'http' | 'unknown'
  auth: 'none' | 'oauth' | 'header' | 'unknown'
  enabled: boolean
}

export interface MatrixMcpCatalogEntry {
  name: string
  description: string
  transport: 'stdio' | 'http' | 'unknown'
  auth: 'none' | 'oauth' | 'api_key' | 'unknown'
  installed: boolean
  enabled: boolean
  needsInstall: boolean
  requiredEnv: { name: string; prompt: string; required: boolean }[]
}

export interface MatrixMcpSnapshot {
  servers: MatrixMcpServer[]
  catalog: MatrixMcpCatalogEntry[]
}

export type MatrixMcpAddInput =
  | { name: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: 'http'; url: string; auth: 'none' | 'oauth' | 'header'; bearerToken?: string }

export type MatrixMcpConfirmation =
  | { kind: 'mcp-add'; name: string; transport: 'stdio' | 'http'; target: string }
  | { kind: 'mcp-remove' | 'mcp-test' | 'mcp-auth'; name: string }
  | { kind: 'mcp-enabled'; name: string; enabled: boolean }
  | { kind: 'mcp-install'; name: string; needsInstall: boolean }
  | { kind: 'mcp-reload' }

export type MatrixMcpOperationStatus =
  | 'starting'
  | 'authorization_required'
  | 'pending'
  | 'applied'
  | 'failed'
  | 'cancelled'

export type MatrixMcpResult =
  | { status: 'cancelled' }
  | { status: 'applied' }
  | { status: 'failed' }
  | { status: 'tested'; ok: boolean; toolCount: number; prompts: number; resources: number }
  | { status: 'operation'; operationId: string; state: MatrixMcpOperationStatus }

export interface MatrixMcpSettingsClient {
  snapshot(): Promise<MatrixMcpSnapshot>
  add(input: MatrixMcpAddInput): Promise<MatrixMcpResult>
  remove(name: string): Promise<MatrixMcpResult>
  test(name: string): Promise<MatrixMcpResult>
  authenticate(name: string): Promise<MatrixMcpResult>
  authStatus(operationId: string): Promise<MatrixMcpResult>
  cancelAuth(operationId: string): Promise<MatrixMcpResult>
  setEnabled(name: string, enabled: boolean): Promise<MatrixMcpResult>
  install(name: string, env: Record<string, string>): Promise<MatrixMcpResult>
  installStatus(operationId: string): Promise<MatrixMcpResult>
  reload(): Promise<MatrixMcpResult>
}
