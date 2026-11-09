import { describe, expect, it } from 'vitest'

import {
  isOpaqueMatrixId,
  matrixMemberLabel,
  matrixPersonLabel,
  matrixPersonLine,
  matrixPersonName,
  matrixReadableRoomName
} from './person-name'

const OWNER = '@user-00000000000000000000000000000000:atum.chat'
const LAN = '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:atum.chat'
const HOA = '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:atum.chat'
const AGENT = '@agent-0a1b2c3d4e5f60718293:atum.chat'
const UNNAMED = 'Atum user'

/** No label ever shows an allocated ID or its random part beyond a four-character mark. */
function expectNoId(text: string) {
  expect(text).not.toMatch(/user-[0-9a-f]{8}|agent-[0-9a-f]{8}/u)
}

describe('which IDs are opaque', () => {
  it('knows the families the platform allocates, and leaves early readable IDs alone', () => {
    expect(isOpaqueMatrixId(LAN)).toBe(true)
    expect(isOpaqueMatrixId(AGENT)).toBe(true)
    expect(isOpaqueMatrixId('@minh:atum.chat')).toBe(false)
    expect(isOpaqueMatrixId('@user-lan:example.invalid')).toBe(false)
  })
})

describe('a name someone set', () => {
  it('is never their ID, its localpart, or the SDK\'s " (@id)" tie-breaker', () => {
    expect(matrixPersonName('Lan', LAN)).toBe('Lan')
    expect(matrixPersonName(`Lan (${LAN})`, LAN)).toBe('Lan')
    expect(matrixPersonName(LAN, LAN)).toBeUndefined()
    expect(matrixPersonName('user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d', LAN)).toBeUndefined()
    expect(matrixPersonName('  ', LAN)).toBeUndefined()
    expect(matrixPersonName(undefined, LAN)).toBeUndefined()
  })
})

describe('a person as the window shows them', () => {
  it('pairs their name with a handle only when the directory gave it', () => {
    expect(matrixPersonLabel({ userId: LAN, name: 'Lan', handle: 'lan', ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({
      name: 'Lan',
      address: '@lan'
    })
    expect(matrixPersonLabel({ userId: LAN, name: 'Lan', ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({ name: 'Lan' })
  })

  it('falls back to the handle, then to the word for someone unnamed, never the ID', () => {
    expect(matrixPersonLabel({ userId: LAN, name: LAN, handle: 'lan', ownerUserId: OWNER, unnamed: UNNAMED }).name).toBe('@lan')
    expect(matrixPersonLabel({ userId: LAN, name: LAN, ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({ name: UNNAMED })
    expect(matrixPersonLabel({ userId: AGENT, ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({ name: UNNAMED })
  })

  it('refuses a handle that is not a handle', () => {
    expect(matrixPersonLabel({ userId: LAN, name: 'Lan', handle: 'Not A Handle', ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({
      name: 'Lan'
    })
  })

  it('reads an early readable ID as a name, but never presents it as a handle', () => {
    expect(matrixPersonLabel({ userId: '@minh:atum.chat', ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({ name: 'minh' })
  })

  it('keeps another server\'s full address in view, so a familiar name never passes as local', () => {
    expect(matrixPersonLabel({ userId: '@lan:example.org', name: 'Lan', handle: 'lan', ownerUserId: OWNER, unnamed: UNNAMED })).toEqual({
      name: 'Lan',
      address: '@lan:example.org'
    })
  })
})

describe('people in a chat', () => {
  const members = [
    { userId: OWNER, name: 'Minh', membership: 'join' },
    { userId: LAN, name: `Lan (${LAN})`, membership: 'join' },
    { userId: HOA, name: `Lan (${HOA})`, membership: 'join' }
  ]

  it('tells two people who share a name apart by handle, else by a short mark', () => {
    const context = { handles: { [LAN]: 'lan' }, members, ownerUserId: OWNER, unnamed: UNNAMED }

    expect(matrixPersonLine(LAN, context)).toBe('Lan (@lan)')
    expect(matrixPersonLine(HOA, context)).toBe('Lan (#7b1e)')
    expect(matrixPersonLine(OWNER, context)).toBe('Minh')
    expect(matrixMemberLabel(members[2]!, context)).toEqual({ name: 'Lan', address: '#7b1e', shared: true })

    for (const member of members) {
      expectNoId(matrixPersonLine(member.userId, context))
    }
  })

  it('adds no disambiguation suffix when only one member of the room has that name', () => {
    const onlyLinh = [
      { userId: OWNER, name: 'Minh', membership: 'join' },
      { userId: LAN, name: `Linh (${LAN})`, membership: 'join' }
    ]
    const context = { handles: {}, members: onlyLinh, ownerUserId: OWNER, unnamed: UNNAMED }

    expect(matrixPersonLine(LAN, context)).toBe('Linh')
    expect(matrixMemberLabel(onlyLinh[1]!, context)).toEqual({ name: 'Linh', shared: false })
  })

  it('names someone outside the member list without their ID', () => {
    expect(matrixPersonLine(HOA, { members: [], ownerUserId: OWNER, unnamed: UNNAMED })).toBe(UNNAMED)
  })
})

describe('a chat named after its members', () => {
  it('drops the SDK\'s ID tie-breakers, and a name built from an ID is no name', () => {
    expect(matrixReadableRoomName(`Lan (${LAN})`)).toBe('Lan')
    expect(matrixReadableRoomName(LAN)).toBe('')
    expect(matrixReadableRoomName(`${LAN} and Hoa`)).toBe('')
    expect(matrixReadableRoomName('Weekend plans')).toBe('Weekend plans')
  })
})
