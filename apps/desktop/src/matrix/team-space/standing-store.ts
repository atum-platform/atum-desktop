import { map } from 'nanostores'

import type { CompanyStanding } from './abilities'
import { teamSpaceKey } from './keys'

/**
 * The viewer's role and the company's channel-creation policy, published by the workspace once it
 * has resolved them (from the 1.3 snapshot when there is one, else the 1.1 role). The open
 * channel's header and menu read it instead of asking the platform a second time.
 */
export const $companyStanding = map<Record<string, CompanyStanding>>({})

export function publishCompanyStanding(accountKey: string, companyId: string, standing: CompanyStanding | undefined): void {
  const key = teamSpaceKey(accountKey, companyId)
  const current = $companyStanding.get()[key]

  if (standing && current?.role === standing.role && current.policy === standing.policy) {
    return
  }

  if (standing) {
    $companyStanding.setKey(key, standing)
  } else if (current) {
    $companyStanding.set(Object.fromEntries(Object.entries($companyStanding.get()).filter(([entry]) => entry !== key)))
  }
}

export function clearCompanyStanding(accountKey: string): void {
  $companyStanding.set(
    Object.fromEntries(Object.entries($companyStanding.get()).filter(([key]) => !key.startsWith(`${accountKey}\n`)))
  )
}
