import { describe, expect, it } from 'vitest'

import { matrixHubSkillName, matrixPagesHubAllowed } from './matrix-pages'

describe('a Store hand-off into the Skills Hub', () => {
  it('admits no Hub skill on any page, and an official one on the Skills page only', () => {
    expect(matrixPagesHubAllowed({ page: 'scheduled' })).toBe(true)
    expect(matrixPagesHubAllowed({ page: 'skills', hub: 'official/creative/pixel-art' })).toBe(true)
    expect(matrixPagesHubAllowed({ page: 'connections', hub: 'official/creative/pixel-art' })).toBe(false)
  })

  it.each([
    'community/creative/pixel-art',
    'official/pixel-art',
    'official/creative/pixel-art/extra',
    'official/creative/../pixel-art',
    'official/Creative/pixel-art',
    `official/creative/${'a'.repeat(200)}`,
    '',
    42,
    null
  ])('refuses anything but an official identifier: %j', hub => {
    expect(matrixPagesHubAllowed({ page: 'skills', hub })).toBe(false)
  })

  it('names the skill Hermes installs from its identifier', () => {
    expect(matrixHubSkillName('official/creative/pixel-art')).toBe('pixel-art')
    expect(matrixHubSkillName('official/finance/stocks')).toBe('stocks')
  })
})
