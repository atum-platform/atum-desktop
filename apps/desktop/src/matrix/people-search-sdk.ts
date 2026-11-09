import type { MatrixClient } from 'matrix-js-sdk'

import {
  MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA,
  type MatrixPeopleSearchSdkCommand,
  type MatrixPeopleSearchValue
} from '../../shared/matrix-people-search'

const USER_ID = /^@[^:\s]+:[^\s]+$/u

function unavailable(): never { throw new Error('matrix_people_search_unavailable') }

export async function searchMatrixPeople(
  client: MatrixClient,
  command: Extract<MatrixPeopleSearchSdkCommand, { kind: 'peopleSearch' }>
): Promise<MatrixPeopleSearchValue> {
  if (command.query !== command.query.trim() || [...command.query].length < 2 || [...command.query].length > 80 ||
    !Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 25 ||
    (command.exactUserId !== undefined && !USER_ID.test(command.exactUserId))) {
    return unavailable()
  }
  const response = await client.searchUserDirectory({ term: command.query, limit: command.limit })
  if (!Array.isArray(response.results) || typeof response.limited !== 'boolean') {
    return unavailable()
  }
  const seen = new Set<string>()
  const results = response.results.flatMap(value => {
    if (!USER_ID.test(value.user_id) || seen.has(value.user_id) ||
      command.exactUserId !== undefined && value.user_id !== command.exactUserId) {
      return []
    }
    seen.add(value.user_id)
    const localpart = value.user_id.slice(1).split(':', 1)[0]!
    const name = typeof value.display_name === 'string' && value.display_name.trim()
      ? value.display_name.trim()
      : `@${localpart}`
    return [{ userId: value.user_id, name, ...(typeof value.avatar_url === 'string' ? { avatarUrl: value.avatar_url } : {}) }]
  })
  return { results, limited: response.limited }
}

export async function readPeoplePrivacy(client: MatrixClient): Promise<boolean> {
  // Call on the client: SDK methods need their receiver (store, credentials, HTTP transport).
  const value = (await client.getAccountDataFromServer(MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA as never)) as
    Record<string, unknown> | null
  return !(value && typeof value === 'object' && Reflect.get(value, 'enabled') === false)
}

export async function writePeoplePrivacy(client: MatrixClient, enabled: boolean): Promise<boolean> {
  await client.setAccountDataRaw(MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA as never, { enabled } as never)
  return enabled
}
