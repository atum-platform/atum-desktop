import { describe, expect, it } from 'vitest'

import { teamSpaceSidebarEntryVisibility } from './sidebar-entry-visibility'

describe('Team Space utility rows', () => {
  it('hides empty destinations and gives Threads its own row; Activity is never a row', () => {
    expect(teamSpaceSidebarEntryVisibility({ threads: 0, saved: 0, drafts: 0 })).toEqual({
      threads: false,
      saved: false,
      drafts: false
    })
    expect(teamSpaceSidebarEntryVisibility({ threads: 2, saved: 1, drafts: 3 })).toEqual({
      threads: true,
      saved: true,
      drafts: true
    })
    expect(teamSpaceSidebarEntryVisibility({ threads: 2, saved: 0, drafts: 0 })).not.toHaveProperty('activity')
  })
})
