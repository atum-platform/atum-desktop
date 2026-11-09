import pack from '../../../../packages/device-protocol/fixtures/workspace-transactions/contract.json'

/** Provisional native test port. This is not workspace-transactions/1.1 or a network API. */
export const MAC_DELIVERABLE_LIMITS = {
  files: pack.parameters.outputs_max,
  fileBytes: pack.parameters.output_max_bytes,
  totalBytes: pack.parameters.total_max_bytes,
  dependencies: pack.parameters.manifest_max_entries,
  resourcePart: pack.types.resource.required.storage.max
} as const

export interface MacDeliverableFile {
  /** Relative to the native Workspace root. Never supplied through a renderer bridge. */
  path: string
  /** A known starting server version only; absent means create beside any existing name. */
  baseEtag?: string | null
}

export interface MacDeliverableDependency {
  path: string
  etag: string
}

export interface MacDeliverableInput {
  /** Stable invocation identity, reused after restart and answer publication retries. */
  taskId: string
  files: readonly MacDeliverableFile[]
  dependencies?: readonly MacDeliverableDependency[]
}

/** Main-owned captured facts. No grant, credential or cloud lease is minted here. */
export interface MacWriterContext {
  accountKey: string
  agentPrincipal: string
  deviceId: string
  epoch: number
  generation: number
  answeringMode: 'local' | 'cloud' | 'moving'
  allowLocalWriter: boolean
}

export interface MacBrokerFence {
  scopeId: string
  deviceId: string
  epoch: number
  generation: number
  answeringMode: MacWriterContext['answeringMode']
  allowLocalWriter: boolean
}

export interface MacPreparedDeliverable {
  path: string
  baseEtag: string | null
  bytes: Buffer
  sha256: string
}

export interface MacStageRequest extends MacPreparedDeliverable {
  fence: MacBrokerFence
  taskId: string
  artifactId: string
}

export interface MacPlacement {
  path: string
  mode: 'create' | 'replace'
  baseEtag: string | null
  artifactId: string
  sha256: string
}

export interface MacCommitRequest {
  fence: MacBrokerFence
  taskId: string
  dependencies: readonly MacDeliverableDependency[]
  placements: readonly MacPlacement[]
}

export interface MacPlacedResource {
  resource: { storage: string; space: string; opaque: string }
  etag: string
}

export interface MacPlacementReply {
  path: string
  state: 'placed' | 'sibling' | 'unknown' | 'not_attempted'
  placed: MacPlacedResource | null
  siblingPath: string | null
}

export interface MacCommitReply {
  /** drive_full/fenced are provisional extensions. stale_inputs is terminal unknown in this publisher. */
  result: 'committed' | 'committed_with_siblings' | 'stale_inputs' | 'unknown' | 'drive_full' | 'fenced'
  outputs: readonly MacPlacementReply[]
}

export interface MacBrokerPort {
  stage(
    request: MacStageRequest
  ): Promise<{ staged: true; artifactId: string } | { reason: 'fenced' | 'drive_full' | 'failed' }>
  commit(request: MacCommitRequest): Promise<MacCommitReply>
}
