/** Narrow renderer-to-main consent capability for a locally hosted group agent. */
export const ATUM_SHARED_GROUP_PERSONA_IPC = {
  approve: 'atum:shared-groups:approve',
  preview: 'atum:shared-groups:preview',
  revoke: 'atum:shared-groups:revoke'
} as const

export type SharedGroupModelAlias = 'binh-minh' | 'nguyet-thuc' | 'nhat-thuc'

export interface SharedGroupPersonaRequest {
  assistantId: string
  /** Local profile routing key. Main re-resolves and authorizes it. */
  profile: string
}

export interface SharedGroupPersonaPreview {
  content: string
  digest: string
  identityId: string
  approvalRevision: number | null
  approved: boolean
  modelAlias: SharedGroupModelAlias
}

export interface AtumSharedGroupPersonaClient {
  preview: (input: SharedGroupPersonaRequest) => Promise<SharedGroupPersonaPreview>
  approve: (input: SharedGroupPersonaRequest & { expectedDigest: string }) => Promise<{ ok: true }>
  revoke: (input: SharedGroupPersonaRequest) => Promise<{ ok: true }>
}
