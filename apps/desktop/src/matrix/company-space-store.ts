import { atom } from 'nanostores'

import type { CompanyAIView, CompanyBoardDueFilter } from './company-desktop-adapter'

export type CompanySpaceTab = 'chat' | 'board' | 'marketplace'
export type CompanyBoardViewMode = 'board' | 'list' | 'my_tasks'

export interface CompanySpacePreferences {
  tab: CompanySpaceTab
  boardView: CompanyBoardViewMode
  projectId: string | null
  ownerMemberRef: string | null
  due: CompanyBoardDueFilter
  selectedCardId: string | null
}

const defaults: CompanySpacePreferences = {
  tab: 'chat',
  boardView: 'board',
  projectId: null,
  ownerMemberRef: null,
  due: 'all',
  selectedCardId: null
}

export const $companySpacePreferences = atom<Record<string, CompanySpacePreferences>>({})
export const $companyAIStatuses = atom<Record<string, CompanyAIView>>({})
/**
 * The one company (by `companySpaceScope`) whose wallet the open workspace will show this account now:
 * its company-menu gate. Anything offering to open the wallet asks here, so a button never promises
 * what the workspace would refuse.
 */
export const $companyWalletScope = atom<string | null>(null)

export function companySpaceScope(accountKey: string, companyId: string): string {
  return `${accountKey}\u0000${companyId}`
}

export function companySpacePreferences(scope: string): CompanySpacePreferences {
  return $companySpacePreferences.get()[scope] ?? defaults
}

export function patchCompanySpacePreferences(scope: string, patch: Partial<CompanySpacePreferences>): void {
  const current = $companySpacePreferences.get()
  const previous = current[scope] ?? defaults
  const next = { ...previous, ...patch }

  if (
    next.tab === previous.tab &&
    next.boardView === previous.boardView &&
    next.projectId === previous.projectId &&
    next.ownerMemberRef === previous.ownerMemberRef &&
    next.due === previous.due &&
    next.selectedCardId === previous.selectedCardId
  ) {
    return
  }

  $companySpacePreferences.set({ ...current, [scope]: next })
}

export function clearCompanySpaceFilters(scope: string): void {
  patchCompanySpacePreferences(scope, {
    projectId: null,
    ownerMemberRef: null,
    due: 'all'
  })
}

export function publishCompanyAIStatus(accountKey: string, view: CompanyAIView | null): void {
  const current = $companyAIStatuses.get()

  if (!view) {
    const prefix = `${accountKey}\u0000`
    const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)))

    if (Object.keys(next).length !== Object.keys(current).length) {
      $companyAIStatuses.set(next)
    }

    return
  }

  const key = companySpaceScope(accountKey, view.companyId)

  if (current[key] !== view) {
    $companyAIStatuses.set({ ...current, [key]: view })
  }
}

export function companyAIStatus(accountKey: string, companyId: string): CompanyAIView | undefined {
  return $companyAIStatuses.get()[companySpaceScope(accountKey, companyId)]
}
