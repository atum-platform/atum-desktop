import { describe, expect, it, vi } from 'vitest'

import { MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA } from '../../shared/matrix-people-search'

import { readPeoplePrivacy, searchMatrixPeople, writePeoplePrivacy } from './people-search-sdk'

describe('native Synapse people search', () => {
  it('uses the native directory, deduplicates identities and supports an exact target fence', async () => {
    const searchUserDirectory = vi.fn(async () => ({ limited: true, results: [
      { user_id: '@nguyen:test', display_name: 'Nguyễn' },
      { user_id: '@nguyen:test', display_name: 'Duplicate' },
      { user_id: '@linh:test', display_name: 'Linh' }
    ] }))
    const client = { searchUserDirectory } as never
    await expect(searchMatrixPeople(client, { kind: 'peopleSearch', query: 'nguyen', limit: 20 }))
      .resolves.toEqual({ limited: true, results: [
        { userId: '@nguyen:test', name: 'Nguyễn' }, { userId: '@linh:test', name: 'Linh' }
      ] })
    await expect(searchMatrixPeople(client, { kind: 'peopleSearch', query: '@nguyen:test', limit: 20,
      exactUserId: '@nguyen:test' })).resolves.toEqual({ limited: true,
      results: [{ userId: '@nguyen:test', name: 'Nguyễn' }] })
  })

  it('defaults discovery on and persists an explicit switch value', async () => {
    // Methods that need their receiver, like the real MatrixClient: a detached call throws.
    const receiver: { getAccountDataFromServer?: unknown; setAccountDataRaw?: unknown } = {}
    const getAccountDataFromServer = vi.fn(async function (this: unknown): Promise<Record<string, unknown> | null> {
      if (this !== receiver) {throw new TypeError('detached getAccountDataFromServer')}
      return null
    })
    const setAccountDataRaw = vi.fn(async function (this: unknown) {
      if (this !== receiver) {throw new TypeError('detached setAccountDataRaw')}
      return {}
    })
    receiver.getAccountDataFromServer = getAccountDataFromServer
    receiver.setAccountDataRaw = setAccountDataRaw
    const client = receiver as never
    await expect(readPeoplePrivacy(client)).resolves.toBe(true)
    getAccountDataFromServer.mockResolvedValueOnce({ enabled: false })
    await expect(readPeoplePrivacy(client)).resolves.toBe(false)
    await expect(writePeoplePrivacy(client, false)).resolves.toBe(false)
    expect(setAccountDataRaw).toHaveBeenCalledWith(MATRIX_PEOPLE_DISCOVERY_ACCOUNT_DATA, { enabled: false })
  })
})
