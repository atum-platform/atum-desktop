import { expect, it } from 'vitest'

import { groupChainPublication, parseGroupChain } from './group-chain-publish'

it('stamps the stored request lineage and turns literal Unicode own names into standard mentions', () => {
  expect(
    groupChainPublication('@Quân Anh and @Atum?', {
      origin: '$owner',
      parent: '$request',
      depth: 2,
      recipients: [
        { userId: '@a:test', name: 'Quân' },
        { userId: '@b:test', name: 'Quân Anh' },
        { userId: '@c:test', name: 'Atum' }
      ]
    })
  ).toEqual({
    'io.atum.chain': { origin: '$owner', parent: '$request', depth: 2 },
    'm.mentions': { user_ids: ['@b:test', '@c:test'] }
  })
})

it('carries a stamp without naming anyone when the text names no unique own assistant', () => {
  const recipients = [
    { userId: '@a:test', name: 'Atum' },
    { userId: '@b:test', name: 'Atum' }
  ]

  expect(
    groupChainPublication('@Atum?', { origin: '$owner', parent: '$request', depth: 1, recipients })
  ).not.toHaveProperty('m.mentions')
})

it.each([
  null,
  {},
  { origin: '$owner', parent: '$request', depth: 4 },
  { origin: '$owner', parent: '$request', depth: 1, authority: true },
  { origin: '!room', parent: '$request', depth: 1 },
  { origin: '$owner', parent: '$request', depth: 1.1 }
])('refuses malformed content stamp %j', stamp => {
  expect(parseGroupChain(stamp)).toBeUndefined()
})
