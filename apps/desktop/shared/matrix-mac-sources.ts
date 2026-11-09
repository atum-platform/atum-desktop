/** Account-scoped sources the owner may stop from Settings without rebuilding Hermes. */
export const MATRIX_MAC_KNOWLEDGE_SOURCES = [
  'google',
  'folders',
  'messages',
  'browser',
  'location',
  'teamSpaces'
] as const

export type MatrixMacKnowledgeSource = (typeof MATRIX_MAC_KNOWLEDGE_SOURCES)[number]

export type MatrixMacSourcesConsent = Record<MatrixMacKnowledgeSource, boolean>

export const MATRIX_MAC_SOURCES_IPC = {
  read: 'matrix:mac-sources:read',
  set: 'matrix:mac-sources:set'
} as const

export interface MatrixMacSourcesBridge {
  read(): Promise<MatrixMacSourcesConsent>
  set(source: MatrixMacKnowledgeSource, enabled: boolean): Promise<MatrixMacSourcesConsent>
}
