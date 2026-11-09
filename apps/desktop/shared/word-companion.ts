/** Word is an external app; these grants never permit overwriting its file. */
export interface WordCompanionDescriptor {
  id: string
  path: string
  name: string
}

export interface WordCompanionCapture {
  text: string
  revision: string
  saved: boolean
  selection?: { text: string; start: number; end: number }
  applied?: boolean
}

/** Candidate identity is ephemeral and authorized by the owning main process. */
export interface WordDocumentCandidate {
  id: string
  name: string
  path: string
}

export interface WordDocumentInventory {
  documents: WordDocumentCandidate[]
  reason?: 'permission' | 'not-running' | 'unavailable'
}

export type WordBindRequest = { requestId: string; candidateId: string; path?: never }
  | { requestId: string; path: string; candidateId?: never }

/** Main resolves the actual operation from the authenticated pending gateway request. */
export interface WordDocumentRequestRef {
  profile: string
  request_id: string
  session_id: string
  turn_id: string
}

export interface WordDocumentRequest extends WordDocumentRequestRef {
  action: 'read' | 'replace_text'
  durable_session_id: string
  expires_at: number
  revision?: string
  find?: string
  replacement?: string
}

export interface WordCompanionBridge {
  open: (path: string, requestId: string) => Promise<WordCompanionDescriptor>
  end: (id: string) => Promise<void>
  capture: (id: string) => Promise<WordCompanionCapture>
  execute: (id: string, request: WordDocumentRequestRef) => Promise<WordCompanionCapture>
  onEnded: (callback: (id: string) => void) => () => void
  /** Optional for compatibility with an older installed main/preload. */
  linkingVersion?: 1
  listDocuments?: () => Promise<WordDocumentInventory>
  bind?: (request: WordBindRequest) => Promise<WordCompanionDescriptor>
  unbind?: (id: string) => Promise<void>
  showBeside?: (id: string) => Promise<WordCompanionDescriptor>
  bringToFront?: (id: string) => Promise<void>
  onBindingEnded?: (callback: (id: string) => void) => () => void
}

export const WORD_COMPANION_CHANNELS = {
  open: 'atum:word-companion:open',
  end: 'atum:word-companion:end',
  capture: 'atum:word-companion:capture',
  execute: 'atum:word-companion:execute',
  ended: 'atum:word-companion:ended',
  listDocuments: 'atum:word-companion:list-documents',
  bind: 'atum:word-companion:bind',
  unbind: 'atum:word-companion:unbind',
  showBeside: 'atum:word-companion:show-beside',
  bringToFront: 'atum:word-companion:bring-to-front',
  bindingEnded: 'atum:word-companion:binding-ended'
} as const
