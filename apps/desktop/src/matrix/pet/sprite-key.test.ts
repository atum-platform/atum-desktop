import { describe, expect, it } from 'vitest'

import type { PetInfo } from '../../../shared/pet'

import { petSpriteKey } from './sprite-key'

const gigi: PetInfo = {
  enabled: true,
  slug: 'gigi',
  displayName: 'Gigi',
  mime: 'image/webp',
  spritesheetBase64: 'AAAA'.repeat(64),
  spritesheetRevision: '1700000000000000000:4096',
  frameW: 192,
  frameH: 208,
  loopMs: 1100,
  scale: 1,
  size: 1,
  stateRows: ['idle', 'running-right', 'running-left', 'jumping']
}

describe('sprite identity for the stage', () => {
  it('treats a re-read of the same pet (a new object over IPC) as the same companion', () => {
    expect(petSpriteKey(structuredClone(gigi))).toBe(petSpriteKey(gigi))
  })

  it.each([
    ['another pet', { slug: 'cookie' }],
    ['a new sheet revision', { spritesheetRevision: '1700000000000000001:4096' }],
    ['the person resizing her', { scale: 1.2 }],
    ["the pet's own size", { size: 0.85 }],
    ['being hidden', { enabled: false }],
    ['another gait', { locomotion: 'hop' as const }]
  ])('sees %s as a different sprite', (_label, change) => {
    expect(petSpriteKey({ ...gigi, ...change })).not.toBe(petSpriteKey(gigi))
  })
})
