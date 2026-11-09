import { describe, expect, it } from 'vitest'

import { servedAgentUsers } from './served-agents'

const RAYMOND = '@agent-raymond:atumplatform.com'
const OTHER = '@agent-other:atumplatform.com'
const LOCAL = '@agent-local:atumplatform.com'

describe('servedAgentUsers', () => {
  it('serves every active agent: the default agent (no roster user), cloud and Mac-answering alike', () => {
    expect(servedAgentUsers([{ userId: RAYMOND }, { userId: OTHER }, { userId: LOCAL }])).toEqual([RAYMOND, OTHER, LOCAL])
  })

  it('skips an agent with no Matrix user yet or one that is closed, and lists each user once', () => {
    expect(servedAgentUsers([{}, { userId: OTHER, closed: true }, { userId: RAYMOND }, { userId: RAYMOND }])).toEqual([RAYMOND])
  })

  it('is empty for an owner with no agents', () => {
    expect(servedAgentUsers([])).toEqual([])
  })
})
