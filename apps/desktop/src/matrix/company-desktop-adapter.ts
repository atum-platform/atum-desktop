import type {
  MatrixCompanyPrivateCosCapabilityV12,
  MatrixCompanyPrivateCosCapabilityV13,
  MatrixCompanyPrivateCosEnsureClientRequest,
  MatrixCompanyPrivateCosOwnerReceipt,
  MatrixCompanyPrivateCosStopReceipt,
  MatrixCompanyPrivateCosStopRequest,
  MatrixCompanyPrivateCosView
} from '../../shared/matrix-company-private-cos'

/**
 * Renderer seam for the frozen Company AI Release B projections.
 *
 * D1 owns transport, strict parsing, retries and citation authority. D2 only
 * consumes these already-authorized shapes; it never supplies actors, payers,
 * room ids or provider URLs.
 */

export const COMPANY_BOARD_COLUMNS = ['suggested', 'to_do', 'in_progress', 'blocked', 'done'] as const
export const COMPANY_BOARD_TITLE_CHARACTERS = 160
export const COMPANY_BOARD_DESCRIPTION_CHARACTERS = 2_000
export const COMPANY_BOARD_CHECKLIST_TEXT_CHARACTERS = 240
export const COMPANY_BOARD_SEARCH_CHARACTERS = 160
export const COMPANY_BOARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export type CompanyBoardColumn = (typeof COMPANY_BOARD_COLUMNS)[number]
export type CompanyBoardDueFilter = 'all' | 'due_soon' | 'overdue' | 'no_due'
export type CompanyBoardPriority = (typeof COMPANY_BOARD_PRIORITIES)[number]
export type CompanyBoardContractVersion = '1' | '1.1'

export interface CompanyBoardDueDate {
  kind: 'date'
  date: string
  timeZone: string
  originalText: string
}
export interface CompanyBoardDueInstant {
  kind: 'instant'
  at: string
  timeZone: string
  originalText: string
}

export type CompanyBoardDue = CompanyBoardDueDate | CompanyBoardDueInstant

export interface CompanyAIChannelCitation {
  kind: 'channel'
  sourceId: string
  channelId: string
  eventId: string
  revisionEventId?: string
  at: string
}

export interface CompanyAIFileRefV1 {
  v: 1
  company_id: string
  channel_id: string
  file_id: string
  revision: 1
  name: string
  content_type: string
  size: number
  sha256: string
}

export interface CompanyAIFileRefV2 {
  v: 2
  company_id: string
  audience: { kind: 'channel'; channel_id: string; visibility: 'public' | 'private' }
  file_id: string
  revision: 1
  name: string
  content_type: string
  size: number
  sha256: string
}

export interface CompanyAIFileCitation {
  kind: 'company_file'
  sourceId: string
  channelId: string
  file: CompanyAIFileRefV1 | CompanyAIFileRefV2
}

export type CompanyAICitation = CompanyAIChannelCitation | CompanyAIFileCitation

export interface CompanyBoardActorHuman {
  kind: 'human'
  memberRef: string
}

export interface CompanyBoardActorCos {
  kind: 'cos'
  agentPrincipal: string
}

export type CompanyBoardActor = CompanyBoardActorHuman | CompanyBoardActorCos

export interface CompanyBoardEventReference {
  kind: 'board_event'
  eventId: string
  at: string
}

export interface CompanyBoardFieldProvenance {
  origin: 'human' | 'cos'
  actor: CompanyBoardActor
  at: string
  references: Array<CompanyAICitation | CompanyBoardEventReference>
}

export interface CompanyBoardCard {
  schemaVersion: 1
  companyId: string
  boardId: string
  cardId: string
  displayKey: string
  revision: number
  title: string
  description: string | null
  status: CompanyBoardColumn
  accepted: boolean
  owners: string[]
  primaryOwner: string | null
  participants: string[]
  due: CompanyBoardDue | null
  projectId: string | null
  citations: CompanyAICitation[]
  conversation: { channelId: string; threadRootEventId: string } | null
  publicationScope:
    | { kind: 'company' }
    | {
        kind: 'channel'
        channelId: string
        historyScope: 'shared'
        admissionGeneration: number
        scopeDigest: string
      }
  fieldProvenance: {
    title: CompanyBoardFieldProvenance
    description: CompanyBoardFieldProvenance | null
    owners: CompanyBoardFieldProvenance
    due: CompanyBoardFieldProvenance
    status: CompanyBoardFieldProvenance
    projectTag: CompanyBoardFieldProvenance | null
  }
  origin: 'human' | 'cos'
  createdBy: CompanyBoardActor
  createdAt: string
  updatedBy: CompanyBoardActor
  updatedAt: string
  archived: boolean
  canEdit: boolean
  canPropose: boolean
  canAccept: boolean
  canArchive: boolean
  canUndo: boolean
  /** Present only after the main process negotiated `atum.company-board/1.1`. */
  priority?: CompanyBoardPriority
  checklist?: CompanyBoardChecklistItem[]
  attachments?: CompanyBoardAttachment[]
  extensionProvenance?: {
    priority: CompanyBoardFieldProvenance
    checklist: CompanyBoardFieldProvenance
    attachments: CompanyBoardFieldProvenance
  }
}

export interface CompanyBoardChecklistItem {
  itemId: string
  text: string
  done: boolean
  order: number
  completedBy: CompanyBoardActor | null
  completedAt: string | null
}

export interface CompanyBoardAttachment {
  attachmentId: string
  file: CompanyAIFileRefV1 | CompanyAIFileRefV2
  addedBy: CompanyBoardActor
  addedAt: string
}

export interface CompanyBoardCardV11 extends CompanyBoardCard {
  priority: CompanyBoardPriority
  checklist: CompanyBoardChecklistItem[]
  attachments: CompanyBoardAttachment[]
  extensionProvenance: {
    priority: CompanyBoardFieldProvenance
    checklist: CompanyBoardFieldProvenance
    attachments: CompanyBoardFieldProvenance
  }
}

export function isCompanyBoardCardV11(card: CompanyBoardCard): card is CompanyBoardCardV11 {
  return (
    COMPANY_BOARD_PRIORITIES.includes(card.priority as CompanyBoardPriority) &&
    Array.isArray(card.checklist) &&
    Array.isArray(card.attachments) &&
    card.extensionProvenance !== undefined
  )
}

export interface CompanyBoardView {
  schemaVersion: 1
  companyId: string
  boardId: string
  revision: number
  columns: readonly ['suggested', 'to_do', 'in_progress', 'blocked', 'done']
}

export interface CompanyBoardPage {
  contractVersion: CompanyBoardContractVersion
  schemaVersion: 1
  board: CompanyBoardView
  cards: CompanyBoardCard[]
  nextCursor: string | null
}

export interface CompanyBoardFilters {
  cursor: string | null
  projectId: string | null
  ownerMemberRef: string | null
  due: CompanyBoardDueFilter
  includeArchived: boolean
}

export interface CompanyBoardSearchFilters extends Omit<CompanyBoardFilters, 'cursor'> {
  query: string
  cursor: string | null
}

export interface CompanyBoardSearchResult {
  cardId: string
  displayKey: string
  revision: number
  title: string
  description: string | null
  status: CompanyBoardColumn
  priority: CompanyBoardPriority
  checklistProgress: { done: number; total: number }
  owners: string[]
  primaryOwner: string | null
  due: CompanyBoardDue | null
  archived: boolean
  matchedFields: Array<'title' | 'description' | 'checklist_text'>
}

export interface CompanyBoardSearchPage {
  schemaVersion: 1
  board: CompanyBoardView
  results: CompanyBoardSearchResult[]
  nextCursor: string | null
}

export interface CompanyBoardActivityEvent {
  schemaVersion: 1
  eventId: string
  companyId: string
  boardId: string
  cardId: string
  cardRevision: number
  requestId: string
  operation: 'create' | 'patch' | 'checklist' | 'attachment' | 'accept' | 'archive' | 'undo' | 'derive' | 'remind'
  origin: 'human' | 'cos'
  actor: CompanyBoardActor
  sourceCitations: Array<CompanyAICitation | CompanyBoardEventReference>
  changes: Array<{
    field:
      | 'title'
      | 'description'
      | 'owners'
      | 'due'
      | 'status'
      | 'project_tag'
      | 'archived'
      | 'priority'
      | 'checklist'
      | 'attachments'
  }>
  compensatesEventId: string | null
  undo:
    | { state: 'available'; targetEventId: string; expectedCardRevision: number }
    | {
        state: 'unavailable'
        reason: 'already_compensated' | 'superseded' | 'not_reversible' | 'not_authorized' | 'card_archived'
      }
  at: string
}

export interface CompanyBoardActivityPage {
  schemaVersion: 1
  cardId: string
  events: CompanyBoardActivityEvent[]
  nextCursor: string | null
}

export type CompanyBoardCommand =
  | {
      schemaVersion: 1
      operation: 'create'
      requestId: string
      cardId: string
      title: string
      description?: string | null
      projectId?: string | null
      priority?: CompanyBoardPriority
      checklist?: Array<{ itemId: string; text: string; order: number }>
    }
  | {
      schemaVersion: 1
      operation: 'patch'
      requestId: string
      cardId: string
      expectedCardRevision: number
      patch: {
        title?: string
        description?: string | null
        owners?: string[]
        primaryOwner?: string | null
        participants?: string[]
        due?: CompanyBoardDue | null
        status?: CompanyBoardColumn
        projectId?: string | null
        priority?: CompanyBoardPriority
      }
    }
  | {
      schemaVersion: 1
      operation: 'checklist'
      requestId: string
      cardId: string
      expectedCardRevision: number
      mutation:
        | { action: 'add'; item: { itemId: string; text: string; order: number } }
        | { action: 'update'; itemId: string; patch: { text?: string; done?: boolean; order?: number } }
        | { action: 'remove'; itemId: string }
    }
  | {
      schemaVersion: 1
      operation: 'attachment'
      requestId: string
      cardId: string
      expectedCardRevision: number
      mutation:
        | { action: 'add'; file: CompanyAIFileRefV1 | CompanyAIFileRefV2 }
        | { action: 'remove'; attachmentId: string }
    }
  | {
      schemaVersion: 1
      operation: 'accept'
      requestId: string
      cardId: string
      expectedCardRevision: number
      status: 'to_do' | 'in_progress' | 'blocked'
    }
  | {
      schemaVersion: 1
      operation: 'archive'
      requestId: string
      cardId: string
      expectedCardRevision: number
      archived: boolean
    }
  | {
      schemaVersion: 1
      operation: 'undo'
      requestId: string
      cardId: string
      expectedCardRevision: number
      targetEventId: string
    }

export interface CompanyBoardCommandResponse {
  schemaVersion: 1
  duplicate: boolean
  card: CompanyBoardCard
}

export type CompanyBoardCommandResult =
  | CompanyBoardCommandResponse
  | { schemaVersion: 1; state: 'applied'; duplicate: boolean; eventId: string; card: CompanyBoardCardV11 }
  | {
      schemaVersion: 1
      state: 'conflict'
      reason: 'stale_card_revision'
      cardId: string
      expectedCardRevision: number
      currentCardRevision: number
      currentCard: CompanyBoardCardV11
    }

export interface CompanyProjectBrainTaskRef {
  cardId: string
  cardRevision: number
  title: string
  status: CompanyBoardColumn
  accepted: boolean
  primaryOwner: string | null
  due: CompanyBoardDue | null
  sourceThreadEventId: string | null
}

export interface CompanyProjectBrainEvidenceItem {
  itemId: string
  excerpt: string
  citation: CompanyAICitation
  assertion: 'source' | 'correction'
}

export interface CompanyProjectBrainCorrection {
  correctionId: string
  createdVersion: number
  targetKind: 'decision' | 'open_question'
  targetItemId: string
  text: string
  authorMemberRef: string
  createdAt: string
  carried: boolean
}

export interface CompanyProjectBrainCoverage {
  state: 'empty' | 'pending' | 'live' | 'partial' | 'stale' | 'paused' | 'attention'
  sourceAsOf: string | null
  boardAsOf: string | null
  lastCheckedAt: string | null
  gaps: string[]
}

export interface CompanyProjectBrainBriefV4 {
  version: number
  asOf: string
  freshness: {
    sourceAsOf: string
    boardAsOf: string
    boardRevision: number
    cardRevisionDigest: string
    evidenceDigest: string
  }
  goal: { displayName: string; text: string | null; citation: CompanyAICitation | null }
  tasks: {
    accepted: CompanyProjectBrainTaskRef[]
    suggested: CompanyProjectBrainTaskRef[]
    overdueAcceptedCount: number
  }
  decisions: CompanyProjectBrainEvidenceItem[]
  openQuestions: CompanyProjectBrainEvidenceItem[]
  fileNotes: CompanyProjectBrainEvidenceItem[]
  corrections: CompanyProjectBrainCorrection[]
}

export interface CompanyProjectBrainV4 {
  schemaVersion: 4
  companyId: string
  projectId: string
  authorityGeneration: number
  sourceGeneration: number
  publicationGeneration: number
  boardRevision: number
  projectionRevision: number
  coverage: CompanyProjectBrainCoverage
  brief?: CompanyProjectBrainBriefV4
}

export interface CompanyProjectBrainCorrectionRequestV4 {
  schemaVersion: 4
  requestId: string
  expectedBriefVersion: number
  expectedBoardRevision: number
  expectedSourceGeneration: number
  targetKind: 'decision' | 'open_question'
  targetItemId: string
  text: string
}

export interface CompanyAIView {
  schemaVersion: 1
  companyId: string
  agent: { principal: string; userId: string; displayName: 'Chief of Staff' }
  enabled: boolean
  revision: number
  state: 'preparing' | 'ready' | 'paused' | 'attention'
  canManage: boolean
}

export interface CompanyAIAnswerProjection {
  schemaVersion: 1
  companyId: string
  channelId: string
  threadRootEventId: string
  triggerEventId: string
  taskId: string
  scopeDigest: string
  correctionRevision: number
  text: string
  citations: CompanyAICitation[]
  coverage: {
    state: 'empty' | 'pending' | 'live' | 'partial' | 'stale' | 'paused' | 'attention'
    asOf: string | null
    gaps: string[]
  }
}

export interface CompanyWalletV2 {
  schemaVersion: 2
  companyId: string
  unit: 'micro_proton'
  balances: { paid: number; earned: number; promo: number; held: number; available: number }
  checkoutOpen: boolean
  canTopUp: boolean
  aiEnabled: boolean
  policyRevision: number
}

export interface CompanyProtonPackV2 {
  schemaVersion: 2
  packId: string
  protons: number
  paidMicroProtons: number
  promoMicroProtons: number
  totalMicroProtons: number
  amountVnd: number
}

export interface CompanyProtonPackCatalogV2 {
  schemaVersion: 2
  companyId: string
  packs: CompanyProtonPackV2[]
}

/** company-funding/2.1: the caller's Protons moved into the company wallet. */
export interface CompanyMemberFundV21 {
  schemaVersion: 2
  companyId: string
  requestId: string
  protons: number
  amountMicroProtons: number
  fromPromoMicroProtons: number
  fromPaidMicroProtons: number
  wallet: CompanyWalletV2
}

/** Renderer-safe order projection. D1 retains provider URLs in native. */
export interface CompanyProtonOrderV2 {
  schemaVersion: 2
  companyId: string
  orderId: string
  packId: string
  protons: number
  state: 'creating' | 'pending' | 'paid' | 'cancelled' | 'expired'
  credited: boolean
}

export interface CompanyDesktopAdapter {
  readBoardView(companyId: string): Promise<CompanyBoardView>
  listBoard(companyId: string, filters: CompanyBoardFilters): Promise<CompanyBoardPage>
  readBoardCard(companyId: string, cardId: string): Promise<CompanyBoardCard>
  searchBoard(companyId: string, filters: CompanyBoardSearchFilters): Promise<CompanyBoardSearchPage>
  readBoardActivity(companyId: string, cardId: string, cursor: string | null): Promise<CompanyBoardActivityPage>
  commandBoard(
    companyId: string,
    command: CompanyBoardCommand,
    contractVersion?: CompanyBoardContractVersion
  ): Promise<CompanyBoardCommandResult>
  openBoardAttachment(companyId: string, file: CompanyAIFileRefV1 | CompanyAIFileRefV2): Promise<void>
  readProjectBrain(companyId: string, projectId: string): Promise<CompanyProjectBrainV4>
  correctProjectBrain(
    companyId: string,
    projectId: string,
    request: CompanyProjectBrainCorrectionRequestV4
  ): Promise<CompanyProjectBrainV4>
  openCitation(companyId: string, citation: CompanyAICitation): Promise<void>
  readAI(companyId: string): Promise<CompanyAIView>
  configureAI(
    companyId: string,
    request: { schemaVersion: 1; requestId: string; expectedRevision: number; enabled: boolean }
  ): Promise<CompanyAIView>
  readPrivateCos?(companyId: string): Promise<MatrixCompanyPrivateCosView>
  readPrivateCosCapability?(
    companyId: string
  ): Promise<MatrixCompanyPrivateCosCapabilityV12 | MatrixCompanyPrivateCosCapabilityV13>
  ensurePrivateCos?(
    companyId: string,
    request: MatrixCompanyPrivateCosEnsureClientRequest
  ): Promise<MatrixCompanyPrivateCosView>
  readPrivateCosReceipt?(companyId: string, runId: string): Promise<MatrixCompanyPrivateCosOwnerReceipt>
  stopPrivateCos?(
    companyId: string,
    runId: string,
    request: MatrixCompanyPrivateCosStopRequest
  ): Promise<MatrixCompanyPrivateCosStopReceipt>
  readWallet(companyId: string): Promise<CompanyWalletV2>
  readPacks(companyId: string): Promise<CompanyProtonPackCatalogV2>
  createOrder(
    companyId: string,
    request: { schemaVersion: 2; requestId: string; packId: string }
  ): Promise<CompanyProtonOrderV2>
  readOrder(companyId: string, orderId: string): Promise<CompanyProtonOrderV2>
  openOrder(companyId: string, orderId: string): Promise<void>
  /** Owner/admin: move whole Protons from the caller's own wallet into the company's. */
  fundFromMember(
    companyId: string,
    request: { schemaVersion: 2; requestId: string; protons: number }
  ): Promise<CompanyMemberFundV21>
  /** A transfer submitted earlier that never got a definite answer, kept by native. */
  readPendingFund(companyId: string): Promise<{ pending: { requestId: string; protons: number } | null }>
}

function nextCursor(cursor: string | null, seen: Set<string>): string | null {
  if (cursor === null) {
    return null
  }

  if (seen.has(cursor)) {
    throw new Error('company_board_cursor_repeated')
  }

  seen.add(cursor)

  return cursor
}

/** The board contract exposes opaque pages; the desktop always consumes the complete projection. */
export async function listCompleteCompanyBoard(
  adapter: CompanyDesktopAdapter,
  companyId: string,
  filters: Omit<CompanyBoardFilters, 'cursor'>
): Promise<CompanyBoardPage> {
  const seen = new Set<string>()
  let cursorValue: string | null = null
  let combined: CompanyBoardPage | undefined

  do {
    const page = await adapter.listBoard(companyId, { ...filters, cursor: cursorValue })

    if (
      combined &&
      (page.contractVersion !== combined.contractVersion ||
        page.board.companyId !== combined.board.companyId ||
        page.board.boardId !== combined.board.boardId ||
        page.board.revision !== combined.board.revision)
    ) {
      throw new Error('company_board_page_changed')
    }

    combined = combined
      ? { ...combined, cards: [...combined.cards, ...page.cards], nextCursor: page.nextCursor }
      : page
    cursorValue = nextCursor(page.nextCursor, seen)
  } while (cursorValue !== null)

  if (!combined || new Set(combined.cards.map(card => card.cardId)).size !== combined.cards.length) {
    throw new Error('company_board_page_invalid')
  }

  return { ...combined, nextCursor: null }
}

export async function searchCompleteCompanyBoard(
  adapter: CompanyDesktopAdapter,
  companyId: string,
  filters: Omit<CompanyBoardSearchFilters, 'cursor'>
): Promise<CompanyBoardSearchPage> {
  const seen = new Set<string>()
  let cursorValue: string | null = null
  let combined: CompanyBoardSearchPage | undefined

  do {
    const page = await adapter.searchBoard(companyId, { ...filters, cursor: cursorValue })

    if (
      combined &&
      (page.board.companyId !== combined.board.companyId ||
        page.board.boardId !== combined.board.boardId ||
        page.board.revision !== combined.board.revision)
    ) {
      throw new Error('company_board_search_changed')
    }

    combined = combined
      ? { ...combined, results: [...combined.results, ...page.results], nextCursor: page.nextCursor }
      : page
    cursorValue = nextCursor(page.nextCursor, seen)
  } while (cursorValue !== null)

  if (!combined || new Set(combined.results.map(result => result.cardId)).size !== combined.results.length) {
    throw new Error('company_board_search_invalid')
  }

  return { ...combined, nextCursor: null }
}

export async function readCompleteCompanyBoardActivity(
  adapter: CompanyDesktopAdapter,
  companyId: string,
  cardId: string
): Promise<CompanyBoardActivityPage> {
  const seen = new Set<string>()
  let cursorValue: string | null = null
  let combined: CompanyBoardActivityPage | undefined

  do {
    const page = await adapter.readBoardActivity(companyId, cardId, cursorValue)

    if (combined && page.cardId !== combined.cardId) {
      throw new Error('company_board_activity_changed')
    }

    combined = combined
      ? { ...combined, events: [...combined.events, ...page.events], nextCursor: page.nextCursor }
      : page
    cursorValue = nextCursor(page.nextCursor, seen)
  } while (cursorValue !== null)

  if (!combined || new Set(combined.events.map(event => event.eventId)).size !== combined.events.length) {
    throw new Error('company_board_activity_invalid')
  }

  return { ...combined, nextCursor: null }
}

function isCompanyDesktopAdapter(value: unknown): value is CompanyDesktopAdapter {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<Record<keyof CompanyDesktopAdapter, unknown>>

  return [
    'readBoardView',
    'listBoard',
    'readBoardCard',
    'searchBoard',
    'readBoardActivity',
    'commandBoard',
    'openBoardAttachment',
    'readProjectBrain',
    'correctProjectBrain',
    'openCitation',
    'readAI',
    'configureAI',
    'readWallet',
    'readPacks',
    'createOrder',
    'readOrder',
    'openOrder',
    'fundFromMember',
    'readPendingFund'
  ].every(name => typeof candidate[name as keyof CompanyDesktopAdapter] === 'function')
}

/** D1 publishes this one renderer capability beside the existing Matrix bridge. */
export function companyDesktopAdapter(): CompanyDesktopAdapter | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  const bridge = (window as unknown as { atumMatrix?: unknown }).atumMatrix

  if (!bridge || typeof bridge !== 'object') {
    return undefined
  }

  const value = (bridge as { companyDesktop?: unknown }).companyDesktop

  return isCompanyDesktopAdapter(value) ? value : undefined
}

export type CompanyPrivateCosDesktopAdapter = Required<Pick<CompanyDesktopAdapter,
  'readPrivateCos' | 'readPrivateCosCapability' | 'ensurePrivateCos' | 'readPrivateCosReceipt' | 'stopPrivateCos'>>

/** An additive gate: an older preload keeps the existing Company Desktop features and exposes no row. */
export function companyPrivateCosDesktopAdapter(): CompanyPrivateCosDesktopAdapter | undefined {
  const adapter = companyDesktopAdapter()

  return adapter &&
    typeof adapter.readPrivateCos === 'function' &&
    typeof adapter.readPrivateCosCapability === 'function' &&
    typeof adapter.ensurePrivateCos === 'function' &&
    typeof adapter.readPrivateCosReceipt === 'function' &&
    typeof adapter.stopPrivateCos === 'function'
    ? adapter as CompanyPrivateCosDesktopAdapter
    : undefined
}
