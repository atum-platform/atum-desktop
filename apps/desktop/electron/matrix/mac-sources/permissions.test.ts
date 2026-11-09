import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { probeFullDiskAccess } from './permissions'

describe('passive Full Disk Access detection', () => {
  it('opens existing databases read-only and returns granted only when every probe works', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('CREATE TABLE proof (id INTEGER)')
    const open = vi.fn(() => database)

    expect(
      probeFullDiskAccess(
        { messages: '/fixture/chat.db', safari: '/fixture/history.db' },
        { exists: file => file.endsWith('chat.db'), open }
      )
    ).toBe('granted')
    expect(open).toHaveBeenCalledWith('/fixture/chat.db')
  })

  it('returns not-granted for TCC-style open failures and unknown when no database exists', () => {
    const denied = () => {
      const error = new Error('unable to open database file') as Error & { code: string }
      error.code = 'SQLITE_CANTOPEN'
      throw error
    }

    expect(
      probeFullDiskAccess(
        { messages: '/fixture/chat.db', safari: '/fixture/history.db' },
        { exists: () => true, open: denied }
      )
    ).toBe('not-granted')
    expect(
      probeFullDiskAccess(
        { messages: '/fixture/chat.db', safari: '/fixture/history.db' },
        { exists: () => false, open: denied }
      )
    ).toBe('unknown')
  })
})
