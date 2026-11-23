import { describe, expect, it } from 'vitest'

import { memorySecretStore, T3Sessions } from './sessions'

// The agent's session id outlives a failed revocation, so the next pass finds it again.

function build(auth: { revokeSession(id: string): Promise<void>; sessionIds(): Promise<string[]> }) {
  const store = memorySecretStore()
  store.set('agent:luna', JSON.stringify({ token: 'tok', sessionId: 'sess-1' }))

  const sessions = new T3Sessions({
    origin: () => 'http://127.0.0.1:1',
    pairing: { create: async () => 'x' },
    auth,
    store,
    agentName: () => 'Luna',
    knownAgents: () => ['luna'],
    unfinished: () => false
  })

  return { sessions, store }
}

describe('T3Sessions.revokeAgent', () => {
  it('keeps the session id (memory and store) while T3 still lists the session and revocation fails, then drops it on success', async () => {
    let failing = true
    const revoked: string[] = []

    const { sessions, store } = build({
      revokeSession: async id => {
        if (failing) {
          throw new Error('t3_auth_session_revoke')
        }

        revoked.push(id)
      },
      sessionIds: async () => ['sess-1']
    })

    await expect(sessions.revokeAgent('luna')).rejects.toThrow('t3_auth_session_revoke')
    expect(sessions.agentSessionId('luna')).toBe('sess-1')
    expect(store.get('agent:luna')).toBeDefined()

    failing = false
    await sessions.revokeAgent('luna')
    expect(revoked).toEqual(['sess-1'])
    expect(sessions.agentSessionId('luna')).toBeUndefined()
    expect(store.get('agent:luna')).toBeUndefined()
  })

  it('a session T3 no longer lists counts as revoked; an unreadable list does not', async () => {
    const gone = build({ revokeSession: async () => Promise.reject(new Error('x')), sessionIds: async () => [] })
    await gone.sessions.revokeAgent('luna')
    expect(gone.store.get('agent:luna')).toBeUndefined()

    const unknown = build({ revokeSession: async () => Promise.reject(new Error('x')), sessionIds: async () => Promise.reject(new Error('y')) })
    await expect(unknown.sessions.revokeAgent('luna')).rejects.toThrow('x')
    expect(unknown.store.get('agent:luna')).toBeDefined()
  })
})
