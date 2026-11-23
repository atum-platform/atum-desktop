import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createPairingGrantLookup, createT3AuthCli } from './t3-auth'

const dirs: string[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'work-t3auth-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('T3 auth commands', () => {
  it('lists ids only and runs against the given home with a telemetry-off environment', async () => {
    const calls: { args: string[]; environment: Record<string, string> }[] = []

    const cli = createT3AuthCli({
      executable: '/pin/t3',
      home: '/acct/work/server',
      environment: { HOME: '/acct/work/environment', PATH: '/usr/bin' },
      run: async (_exe, args, environment) => {
        calls.push({ args, environment })

        return { code: 0, stdout: args[2] === 'list' ? JSON.stringify([{ sessionId: 's1', token: 'SECRET' }, { sessionId: 's2' }]) : 'Revoked pairing credential x.\n' }
      }
    })

    expect(await cli.sessionIds()).toEqual(['s1', 's2'])
    expect(await cli.revokePairing('p1')).toBe(true)
    expect(calls[0].environment).toMatchObject({ T3CODE_HOME: '/acct/work/server', T3CODE_TELEMETRY_ENABLED: 'false' })
    expect(calls[1].args).toEqual(['auth', 'pairing', 'revoke', 'p1'])
  })

  it('says a link was already gone, and never puts command output in an error', async () => {
    const gone = createT3AuthCli({
      executable: 't3', home: 'h', environment: {},
      run: async () => ({ code: 0, stdout: 'No active pairing credential found for p1.\n' })
    })

    expect(await gone.revokePairing('p1')).toBe(false)

    const failing = createT3AuthCli({
      executable: 't3', home: 'h', environment: {},
      run: async () => ({ code: 1, stdout: 'pairingUrl: http://127.0.0.1:1/pair#token=LEAKME' })
    })

    const error = await failing.pairingIds().catch(caught => caught as Error)
    expect((error as Error).message).toBe('t3_auth_pairing_list')
    expect(JSON.stringify(error)).not.toContain('LEAKME')

    const garbage = createT3AuthCli({ executable: 't3', home: 'h', environment: {}, run: async () => ({ code: 0, stdout: 'x' }) })
    await expect(garbage.sessionIds()).rejects.toThrow('t3_auth_unparseable')
  })
})

describe('hidden startup grant lookup (read-only SQLite)', () => {
  function database(columns = 'id TEXT, credential TEXT, consumed_at TEXT, revoked_at TEXT') {
    const dir = tempDir()
    mkdirSync(join(dir, 'userdata'))
    const path = join(dir, 'userdata', 'statev2.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE auth_pairing_links (${columns})`)

    return { db, path }
  }

  it('finds a live row by the token main holds, and every unused row, but not spent or revoked ones', () => {
    const { db, path } = database()
    const insert = db.prepare('INSERT INTO auth_pairing_links VALUES (?, ?, ?, ?)')
    insert.run('hidden', 'TOKEN-A', null, null)
    insert.run('spent', 'TOKEN-B', '2026-11-21', null)
    insert.run('revoked', 'TOKEN-C', null, '2026-11-21')
    db.close()
    const lookup = createPairingGrantLookup(path)

    expect(lookup.idForCredential('TOKEN-A')).toBe('hidden')
    expect(lookup.idForCredential('TOKEN-C')).toBeUndefined()
    expect(lookup.idForCredential('nope')).toBeUndefined()
    expect(lookup.unusedIds()).toEqual(['hidden'])
  })

  it('treats a missing database or table as nothing to revoke, but an unfamiliar layout as an error', () => {
    expect(createPairingGrantLookup(join(tempDir(), 'none.sqlite')).unusedIds()).toEqual([])

    const bare = join(tempDir(), 'bare.sqlite')
    new DatabaseSync(bare).close()
    expect(createPairingGrantLookup(bare).unusedIds()).toEqual([])

    const { db, path } = database('id TEXT, secret TEXT')
    db.close()
    expect(() => createPairingGrantLookup(path).unusedIds()).toThrow('t3_pairing_schema_unrecognised')
  })
})
