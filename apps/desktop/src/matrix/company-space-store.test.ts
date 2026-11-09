import { beforeEach, expect, it } from 'vitest'

import {
  $companySpacePreferences,
  clearCompanySpaceFilters,
  companySpacePreferences,
  companySpaceScope,
  patchCompanySpacePreferences
} from './company-space-store'

beforeEach(() => $companySpacePreferences.set({}))

it('scopes company tabs, filters and card selection by account and company', () => {
  const alpha = companySpaceScope('account-a', 'company-a')
  const beta = companySpaceScope('account-a', 'company-b')

  patchCompanySpacePreferences(alpha, {
    tab: 'board',
    boardView: 'my_tasks',
    projectId: 'project-a',
    ownerMemberRef: 'owner-a',
    due: 'overdue',
    selectedCardId: 'card-a'
  })

  expect(companySpacePreferences(alpha)).toMatchObject({
    tab: 'board',
    boardView: 'my_tasks',
    projectId: 'project-a',
    selectedCardId: 'card-a'
  })
  expect(companySpacePreferences(beta)).toMatchObject({
    tab: 'chat',
    boardView: 'board',
    projectId: null,
    selectedCardId: null
  })

  clearCompanySpaceFilters(alpha)
  expect(companySpacePreferences(alpha)).toMatchObject({
    tab: 'board',
    boardView: 'my_tasks',
    projectId: null,
    ownerMemberRef: null,
    due: 'all',
    selectedCardId: 'card-a'
  })
})

it('persists the list view per account and company scope', () => {
  const alpha = companySpaceScope('account-a', 'company-a')
  const beta = companySpaceScope('account-a', 'company-b')

  patchCompanySpacePreferences(alpha, { boardView: 'list' })

  expect(companySpacePreferences(alpha).boardView).toBe('list')
  expect(companySpacePreferences(beta).boardView).toBe('board')
})
