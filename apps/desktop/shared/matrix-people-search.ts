import type { MatrixAliasErrorCode } from './matrix-aliases'

export const MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA = 'io.atum.profile.discovery'

export interface MatrixPeopleSearchRequest { query: string; limit: number }
export interface MatrixPeopleSearchPerson {
  userId: string
  name: string
  /** Present only when the public alias directory proved this exact handle. */
  handle?: string
  avatarUrl?: string
}
export interface MatrixPeopleSearchValue { results: MatrixPeopleSearchPerson[]; limited: boolean }
export type MatrixPeopleSearchResponse =
  | { ok: true; value: MatrixPeopleSearchValue }
  | { ok: false; error: MatrixAliasErrorCode; retryAfterSeconds?: number }
export type MatrixPeoplePrivacyResponse =
  | { ok: true; enabled: boolean }
  | { ok: false; error: MatrixAliasErrorCode }

export interface MatrixPeopleSearchBridge {
  search(input: MatrixPeopleSearchRequest): Promise<MatrixPeopleSearchResponse>
  privacy(): Promise<MatrixPeoplePrivacyResponse>
  setPrivacy(enabled: boolean): Promise<MatrixPeoplePrivacyResponse>
}

export type MatrixPeopleSearchSdkCommand =
  | { kind: 'peopleSearch'; query: string; limit: number; exactUserId?: string }
  | { kind: 'peoplePrivacyRead' }
  | { kind: 'peoplePrivacyWrite'; enabled: boolean }
