import { map } from 'nanostores'

import type { MatrixCompanyDirectory, MatrixCompanyDirectory11 } from '../../../shared/matrix-company'
import { readJson, writeJson } from '../../lib/storage'

import { clearCompanyChannels, discardStoredCompanyChannels } from './channels-store'

type Directory = MatrixCompanyDirectory | MatrixCompanyDirectory11
const storageKey = (accountKey: string) => `atum.team-space.directory.v1:${accountKey}`
const accountStorageKey = 'atum.team-space.cache-account.v1'
export const $companyDirectories = map<Record<string, Directory>>({})

/** Persist navigation only. Invitations and permission to act always require a live read. */
export const companyDirectoryCache = {
  get(accountKey: string): Directory | undefined {
    const held = $companyDirectories.get()[accountKey]

    if (held) {return held}
    const saved = readJson<MatrixCompanyDirectory>(storageKey(accountKey))

    if (!saved || saved.schemaVersion !== 1 || !Array.isArray(saved.companies) ||
      !saved.companies.every(company => company && typeof company.id === 'string' &&
        typeof company.displayName === 'string' && ['admin', 'member'].includes(company.role) &&
        Number.isFinite(company.authorityGeneration))) {return undefined}

    const value: Directory = { schemaVersion: 1, companies: saved.companies, invitations: [] }
    $companyDirectories.setKey(accountKey, value)

    return value
  },
  has(accountKey: string): boolean {return this.get(accountKey) !== undefined},
  set(accountKey: string, value: Directory): void {
    for (const previous of this.get(accountKey)?.companies ?? []) {
      if (!value.companies.some(company => company.id === previous.id)) {
        clearCompanyChannels(accountKey, previous.id)
      }
    }
    $companyDirectories.setKey(accountKey, value)
    writeJson(storageKey(accountKey), { schemaVersion: 1, companies: value.companies, invitations: [] })
  },
  delete(accountKey: string): void {
    clearCompanyChannels(accountKey)
    discardStoredCompanyChannels(accountKey)
    $companyDirectories.setKey(accountKey, undefined)
    writeJson(storageKey(accountKey), null)
  }
}

/** Called only with a settled account snapshot, never the initial signed-out placeholder. */
export function activateTeamSpaceCacheAccount(accountKey: string | null): void {
  const previous = readJson<string>(accountStorageKey)

  if (previous && previous !== accountKey) {
    companyDirectoryCache.delete(previous)
  }

  writeJson(accountStorageKey, accountKey)
}
