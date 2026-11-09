import { describe, expect, it } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

import { swapProfileLabel } from './chat-swap-overlay'

const profile = (name: string, display?: string): ProfileInfo =>
  ({ display_name: display, has_env: true, is_default: name === 'default', model: 'm', name, path: `/h/${name}`, provider: null, skill_count: 1 }) as ProfileInfo

describe('swapProfileLabel', () => {
  it('says the assistant name, never the folder its profile lives in', () => {
    // The wake overlay is the one place a backend swap is visible. A user who
    // named an assistant "Trợ lý Marketing" has never seen "tro-ly-marketing".
    expect(swapProfileLabel('tro-ly-marketing', [profile('tro-ly-marketing', 'Trợ lý Marketing')])).toBe(
      'Trợ lý Marketing'
    )
  })

  it('keeps the key for a profile made by hand, as the stock shell always did', () => {
    expect(swapProfileLabel('coder', [profile('coder')])).toBe('coder')
    expect(swapProfileLabel('coder', [profile('coder', '   ')])).toBe('coder')
  })

  it('keeps the key while the profile list has not loaded', () => {
    expect(swapProfileLabel('tro-ly-marketing', [])).toBe('tro-ly-marketing')
  })

  it('has nothing to say when nothing is swapping', () => {
    expect(swapProfileLabel(null, [profile('a', 'A')])).toBeNull()
  })
})
