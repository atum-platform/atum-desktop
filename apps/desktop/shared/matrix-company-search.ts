import type { MatrixCompanyErrorCode } from './matrix-company'
import type { MatrixCompanySearchFileType, MatrixCompanySearchTab } from './matrix-company-search-query'

export const MATRIX_COMPANY_MESSAGE_SEARCH_SNIPPET_MAX = 600

export interface MatrixCompanyMessageSearchRequest {
  companyId: string
  query: string
  limit: number
  tab?: MatrixCompanySearchTab
  fileType?: MatrixCompanySearchFileType
  nextBatch?: string
}

export interface MatrixCompanyMessageSearchTarget {
  targetType?: 'channel' | 'conversation'
  channelId: string
  roomId: string
  channelName: string
  state: 'active' | 'archived' | 'read_only'
  authorityGeneration: number
  channelGeneration: number
}

export interface MatrixCompanyMessageSearchResult {
  channelId: string
  roomId: string
  channelName: string
  eventId: string
  sender: string
  snippet: string
  at: number
  threadRootId?: string
  file?: {
    name: string
    mimeType?: string
    size?: number
    type: Exclude<MatrixCompanySearchFileType, 'all'>
  }
}

export interface MatrixCompanyMessageSearchValue {
  schemaVersion: 1
  companyId: string
  query: string
  coverage: {
    eligibleRooms: number
    searchedRooms: number
    truncated: boolean
    source?: 'server' | 'loaded_history'
    encryptedRooms?: number
  }
  results: MatrixCompanyMessageSearchResult[]
  nextBatch?: string
}

export interface MatrixCompanyMessageSearchOpenRequest {
  companyId: string
  channelId: string
  roomId: string
  eventId: string
  threadRootId?: string
}

export type MatrixCompanyMessageSearchResponse =
  | { ok: true; value: MatrixCompanyMessageSearchValue }
  | { ok: false; error: MatrixCompanyErrorCode }

export type MatrixCompanyMessageSearchOpenResponse =
  | { ok: true }
  | { ok: false; error: MatrixCompanyErrorCode }

/** One exact message of a company channel, re-read before it may be shown. */
export interface MatrixCompanyCitationOpenRequest {
  companyId: string
  channelId: string
  roomId: string
  eventId: string
}

export interface MatrixCompanyCitationOpenValue {
  /** The message's own thread root, when it is a thread reply; null for a top-level message. */
  threadRootEventId: string | null
}

/** Trusted main → human SDK only. The renderer never supplies room targets. */
export type MatrixCompanyMessageSearchSdkCommand =
  | {
      kind: 'companyMessageSearch'
      companyId: string
      query: string
      limit: number
      tab?: MatrixCompanySearchTab
      fileType?: MatrixCompanySearchFileType
      nextBatch?: string
      /** Main-resolved public handle. The renderer cannot provide this authority-bearing value. */
      senderUserId?: string
      rooms: MatrixCompanyMessageSearchTarget[]
    }
  | ({ kind: 'companyMessageOpen'; targetType?: 'channel' | 'conversation' } & MatrixCompanyMessageSearchOpenRequest)
  | ({ kind: 'companyCitationOpen' } & MatrixCompanyCitationOpenRequest)
  | {
      kind: 'companyMessageSelect'
      companyId: string
      channelId: string
      roomId: string
      targetType?: 'channel' | 'conversation'
    }

export interface MatrixCompanyMessageSearchBridge {
  search?(input: MatrixCompanyMessageSearchRequest): Promise<MatrixCompanyMessageSearchResponse>
  open?(input: MatrixCompanyMessageSearchOpenRequest): Promise<MatrixCompanyMessageSearchOpenResponse>
}
