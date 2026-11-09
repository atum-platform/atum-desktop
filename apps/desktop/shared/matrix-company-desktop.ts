import type { MatrixCompanyNativeErrorCode } from './matrix-company-ai'

/**
 * The closed main-process vocabulary behind `window.atumMatrix.companyDesktop`.
 *
 * The renderer sends identifiers and frozen contract requests only; actors,
 * payers, rooms, provenance, authority generations and provider URLs are
 * derived by the main process from the D1 native consumers.
 */
export type MatrixCompanyDesktopRequest =
  | { action: 'read-board-view'; companyId: string }
  | {
      action: 'list-board'
      companyId: string
      filters: {
        cursor: string | null
        projectId: string | null
        ownerMemberRef: string | null
        due: 'all' | 'due_soon' | 'overdue' | 'no_due'
        includeArchived: boolean
      }
    }
  | { action: 'read-board-card'; companyId: string; cardId: string }
  | {
      action: 'search-board'
      companyId: string
      filters: {
        query: string
        cursor: string | null
        projectId: string | null
        ownerMemberRef: string | null
        due: 'all' | 'due_soon' | 'overdue' | 'no_due'
        includeArchived: boolean
      }
    }
  | { action: 'read-board-activity'; companyId: string; cardId: string; cursor: string | null }
  | { action: 'command-board'; companyId: string; contractVersion: '1' | '1.1'; command: unknown }
  | { action: 'open-board-attachment'; companyId: string; file: unknown }
  | { action: 'read-project-brain'; companyId: string; projectId: string }
  | { action: 'correct-project-brain'; companyId: string; projectId: string; request: unknown }
  | { action: 'open-citation'; companyId: string; citation: unknown }
  | { action: 'read-ai'; companyId: string }
  | { action: 'configure-ai'; companyId: string; request: unknown }
  | { action: 'read-private-cos-capability'; companyId: string }
  | { action: 'read-private-cos'; companyId: string }
  | { action: 'ensure-private-cos'; companyId: string; request: unknown }
  | { action: 'read-private-cos-receipt'; companyId: string; runId: string }
  | { action: 'stop-private-cos'; companyId: string; runId: string; request: unknown }
  | { action: 'read-wallet'; companyId: string }
  | { action: 'read-packs'; companyId: string }
  | { action: 'create-order'; companyId: string; request: unknown }
  | { action: 'fund-from-member'; companyId: string; request: unknown }
  | { action: 'read-pending-fund'; companyId: string }
  | { action: 'read-order'; companyId: string; orderId: string }
  | { action: 'open-order'; companyId: string; orderId: string }

export type MatrixCompanyDesktopResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: MatrixCompanyNativeErrorCode }
