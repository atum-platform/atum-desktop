// Pure parser, no store: src/matrix/message.ts (bundled by the cloud controller) imports it.
const UUID = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const BOARD_LINK = new RegExp(
  `^https://atumplatform\\.com/#atum-board/(${UUID})/(${UUID})(?:/card/(${UUID}))?$`,
  'u'
)

export interface CompanyBoardLinkTarget {
  kind: 'company_board' | 'company_board_card'
  companyId: string
  boardId: string
  cardId?: string
}

export function parseCompanyBoardLink(value: string): CompanyBoardLinkTarget | undefined {
  const match = BOARD_LINK.exec(value)

  return match
    ? {
        kind: match[3] ? 'company_board_card' : 'company_board',
        companyId: match[1]!,
        boardId: match[2]!,
        ...(match[3] ? { cardId: match[3] } : {})
      }
    : undefined
}
