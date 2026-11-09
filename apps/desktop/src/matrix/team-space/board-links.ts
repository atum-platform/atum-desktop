import { atom } from 'nanostores'

import { type CompanyBoardLinkTarget, parseCompanyBoardLink } from './board-link-target'

export { type CompanyBoardLinkTarget, parseCompanyBoardLink }

export interface CompanyBoardLinkRequest {
  serial: number
  target: CompanyBoardLinkTarget
}

export const $companyBoardLinkRequest = atom<CompanyBoardLinkRequest | undefined>(undefined)
let serial = 0

export function requestCompanyBoardLink(target: CompanyBoardLinkTarget): void {
  $companyBoardLinkRequest.set({ serial: ++serial, target })
}

export function clearCompanyBoardLink(request: CompanyBoardLinkRequest): void {
  if ($companyBoardLinkRequest.get() === request) {
    $companyBoardLinkRequest.set(undefined)
  }
}
