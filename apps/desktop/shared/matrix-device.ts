/** Public local device controls; no signer, command arguments or credentials reach the renderer. */
export interface MatrixDeviceStatus {
  available: boolean
  reason?: string
  enrolled: boolean
  deviceName: string | null
  cloudAgents: readonly { userId: string; name: string }[]
  grants: readonly { id: string; capability: string; target: string; label: string; agentName: string | null }[]
  grantable: readonly string[]
  active: boolean
}

export interface MatrixDeviceBridge {
  status(): Promise<MatrixDeviceStatus>
  addGrant(capability: string, agentUserId: string): Promise<unknown>
  revokeGrant(id: string): Promise<unknown>
  stop(): Promise<unknown>
}
