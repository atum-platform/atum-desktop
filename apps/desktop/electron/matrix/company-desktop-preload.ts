import type { MatrixCompanyDesktopRequest, MatrixCompanyDesktopResult } from '../../shared/matrix-company-desktop'
import type { CompanyDesktopAdapter } from '../../src/matrix/company-desktop-adapter'

export type CompanyDesktopInvoke = (request: MatrixCompanyDesktopRequest) => Promise<MatrixCompanyDesktopResult>

async function call<T>(invoke: CompanyDesktopInvoke, request: MatrixCompanyDesktopRequest): Promise<T> {
  const result = await invoke(request)

  if (!result || typeof result !== 'object' || result.ok !== true) {
    throw new Error(result && typeof result === 'object' && 'error' in result ? result.error : 'unavailable')
  }

  return result.value as T
}

/**
 * The renderer-facing release B adapter, over the closed main-process request
 * vocabulary. Every method returns the main process's already-parsed value; a
 * refusal rejects so the D2 surface keeps its documented failure state.
 */
export function createMatrixCompanyDesktopBridge(invoke: CompanyDesktopInvoke): CompanyDesktopAdapter {
  return {
    readBoardView: companyId => call(invoke, { action: 'read-board-view', companyId }),
    listBoard: (companyId, filters) => call(invoke, { action: 'list-board', companyId, filters }),
    readBoardCard: (companyId, cardId) => call(invoke, { action: 'read-board-card', companyId, cardId }),
    searchBoard: (companyId, filters) => call(invoke, { action: 'search-board', companyId, filters }),
    readBoardActivity: (companyId, cardId, cursor) =>
      call(invoke, { action: 'read-board-activity', companyId, cardId, cursor }),
    commandBoard: (companyId, command, contractVersion = '1') =>
      call(invoke, { action: 'command-board', companyId, contractVersion, command }),
    openBoardAttachment: async (companyId, file) => {
      await call<void>(invoke, { action: 'open-board-attachment', companyId, file })
    },
    readProjectBrain: (companyId, projectId) =>
      call(invoke, { action: 'read-project-brain', companyId, projectId }),
    correctProjectBrain: (companyId, projectId, request) =>
      call(invoke, { action: 'correct-project-brain', companyId, projectId, request }),
    openCitation: async (companyId, citation) => {
      await call<void>(invoke, { action: 'open-citation', companyId, citation })
    },
    readAI: companyId => call(invoke, { action: 'read-ai', companyId }),
    configureAI: (companyId, request) => call(invoke, { action: 'configure-ai', companyId, request }),
    readPrivateCosCapability: companyId => call(invoke, { action: 'read-private-cos-capability', companyId }),
    readPrivateCos: companyId => call(invoke, { action: 'read-private-cos', companyId }),
    ensurePrivateCos: (companyId, request) => call(invoke, { action: 'ensure-private-cos', companyId, request }),
    readPrivateCosReceipt: (companyId, runId) =>
      call(invoke, { action: 'read-private-cos-receipt', companyId, runId }),
    stopPrivateCos: (companyId, runId, request) =>
      call(invoke, { action: 'stop-private-cos', companyId, runId, request }),
    readWallet: companyId => call(invoke, { action: 'read-wallet', companyId }),
    readPacks: companyId => call(invoke, { action: 'read-packs', companyId }),
    createOrder: (companyId, request) => call(invoke, { action: 'create-order', companyId, request }),
    fundFromMember: (companyId, request) => call(invoke, { action: 'fund-from-member', companyId, request }),
    readPendingFund: companyId => call(invoke, { action: 'read-pending-fund', companyId }),
    readOrder: (companyId, orderId) => call(invoke, { action: 'read-order', companyId, orderId }),
    openOrder: async (companyId, orderId) => {
      await call<void>(invoke, { action: 'open-order', companyId, orderId })
    }
  }
}
