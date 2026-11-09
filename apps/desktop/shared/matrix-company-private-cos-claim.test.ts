import { describe, expect, it } from 'vitest'

import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  matrixCompanyPrivateCosPowerLevels,
  matrixCompanyPrivateCosRoomBinding
} from './matrix-company-private-cos-claim'

const id = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`
const v12 = { v: 1, classification: 'company_private_cos', companyId: id(1), membershipIncarnation: id(2), executorId: id(3) }
const bind = (content: unknown, roomType: unknown = MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, stateKey: unknown = '') =>
  matrixCompanyPrivateCosRoomBinding(roomType, MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, stateKey, content)

describe('private CoS room marker', () => {
  it('accepts exactly the 1.2 marker and the 1.3 marker with attemptId', () => {
    expect(bind(v12)).toEqual(v12)
    expect(bind({ ...v12, attemptId: id(4) })).toEqual({ ...v12, attemptId: id(4) })
  })

  it('refuses unknown keys, wrong literals, non-lowercase or missing ids', () => {
    expect(bind({ ...v12, extra: true })).toBeUndefined()
    expect(bind({ ...v12, attemptId: undefined })).toBeUndefined()
    expect(bind({ ...v12, attemptId: 'x' })).toBeUndefined()
    expect(bind({ ...v12, v: 2 })).toBeUndefined()
    expect(bind({ ...v12, classification: 'company_channel' })).toBeUndefined()
    expect(bind({ ...v12, companyId: `${id(1)}0` })).toBeUndefined()
    expect(bind({ ...v12, executorId: '00000000-0000-4000-8000-01A12F84A42E' })).toBeUndefined()
    const { executorId: _omit, ...missing } = v12
    expect(bind(missing)).toBeUndefined()
    expect(bind([v12])).toBeUndefined()
    expect(bind(null)).toBeUndefined()
  })

  it('refuses the marker outside an assistant room or with a state key', () => {
    expect(bind(v12, 'm.space')).toBeUndefined()
    expect(bind(v12, MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, 'x')).toBeUndefined()
  })
})

describe('private CoS power levels', () => {
  const levels = {
    users: { '@a:x': 100 }, users_default: 0, events_default: 0, state_default: 100,
    invite: 100, kick: 100, ban: 100, redact: 50, events: { 'm.room.name': 100 }, historical: 100
  }

  it('keeps every field and passes other keys through', () => {
    expect(matrixCompanyPrivateCosPowerLevels(levels)).toEqual(levels)
  })

  it('refuses missing fields and levels outside 0..100 or non-integers', () => {
    const { redact: _omit, ...missing } = levels
    expect(matrixCompanyPrivateCosPowerLevels(missing)).toBeUndefined()
    expect(matrixCompanyPrivateCosPowerLevels({ ...levels, kick: 101 })).toBeUndefined()
    expect(matrixCompanyPrivateCosPowerLevels({ ...levels, ban: 1.5 })).toBeUndefined()
    expect(matrixCompanyPrivateCosPowerLevels({ ...levels, users: { '@a:x': -1 } })).toBeUndefined()
    expect(matrixCompanyPrivateCosPowerLevels({ ...levels, events: [] })).toBeUndefined()
  })
})
