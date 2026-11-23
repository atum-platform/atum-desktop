import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { afterEach, describe, expect, it } from 'vitest'

import { workSessionPaths } from './paths'
import { resetAuth } from './reset'
import { createPairingGrantLookup, createT3AuthCli } from './t3-auth'

/**
 * Runs the pinned, real `t3` standalone binary against throwaway homes. It is
 * skipped unless ATUM_WORK_T3_BIN names that binary, because the binary is a
 * 166 MB build artifact: `ATUM_WORK_T3_BIN=<resources>/work-runtime/t3`.
 * Nothing leaves loopback, and no Atum home or credential is involved.
 */
const T3 = process.env.ATUM_WORK_T3_BIN
const dirs: string[] = []
const servers: ChildProcess[] = []

afterEach(() => {
  for (const child of servers.splice(0)) {
    child.kill('SIGKILL')
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function freePort(): Promise<number> {
  return await new Promise(resolve => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

function environment(root: string) {
  return { HOME: join(root, 'os'), PATH: '/usr/bin:/bin', T3CODE_HOME: join(root, 'server'), T3CODE_TELEMETRY_ENABLED: 'false' }
}

async function startServer(root: string) {
  const port = await freePort()

  const child = spawn(T3!, ['--mode', 'web', '--no-browser', '--host', '127.0.0.1', '--port', String(port)], {
    env: environment(root),
    stdio: ['ignore', 'pipe', 'ignore']
  })

  servers.push(child)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const lines = createInterface({ input: child.stdout! })

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pairing line')), 30_000)
    lines.on('line', line => {
      const match = /^\s*pairingUrl:\s*(\S+)\s*$/u.exec(line)

      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })

  child.stdout!.resume()

  return { child, exited, port, url, origin: `http://127.0.0.1:${port}` }
}

async function exchange(origin: string, credential: string) {
  const response = await fetch(`${origin}/api/auth/browser-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential })
  })

  return {
    status: response.status,
    cookie: response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).find(cookie => cookie.startsWith('t3_session_'))
  }
}

async function authenticated(origin: string, cookie: string | undefined) {
  const response = await fetch(`${origin}/api/auth/session`, { headers: cookie ? { cookie } : {} })

  return ((await response.json()) as { authenticated?: boolean }).authenticated === true
}

async function waitUp(origin: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${origin}/api/auth/session`)

      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  throw new Error('server never opened')
}

describe.skipIf(!T3)('against the real pinned t3 binary', () => {
  it('finds the hidden startup grant by its token, revokes it while the server runs, and resets a stopped home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'work-real-t3-'))
    dirs.push(root)
    mkdirSync(join(root, 'os'), { recursive: true })
    const paths = workSessionPaths({ root })
    // This test's home IS the t3 home (no `work/` nesting): point the paths there.
    const home = join(root, 'server')
    const real = { ...paths, home, userdata: join(home, 'userdata'), database: join(home, 'userdata', 'statev2.sqlite'), signingKey: join(home, 'userdata', 'secrets', 'server-signing-key.bin') }
    const cli = createT3AuthCli({ executable: T3!, home, environment: environment(root) })
    const grants = createPairingGrantLookup(real.database)

    const first = await startServer(root)
    await waitUp(first.origin)
    const token = /#token=(.+)$/u.exec(first.url)![1]

    // T3 does not list a startup grant; the lookup by the held token does find it.
    expect(await cli.pairingIds()).toEqual([])
    const id = grants.idForCredential(token)
    expect(id).toBeTruthy()
    expect(grants.unusedIds()).toContain(id)

    // An unused grant is revoked with T3's own command while the server runs, and then refused.
    expect(await cli.revokePairing(id!)).toBe(true)
    expect(await cli.revokePairing(id!)).toBe(false)
    expect((await exchange(first.origin, token)).status).toBe(401)
    first.child.kill('SIGTERM')
    await first.exited

    // Second boot: a fresh startup grant. Consume it: an owner browser session exists.
    const second = await startServer(root)
    await waitUp(second.origin)
    const secondToken = /#token=(.+)$/u.exec(second.url)![1]
    const minted = await exchange(second.origin, secondToken)
    expect(minted.status).toBe(200)
    expect(await authenticated(second.origin, minted.cookie)).toBe(true)
    // A second hidden-grant boot leaves one more unused row to find after the stop.
    second.child.kill('SIGTERM')
    await second.exited

    const third = await startServer(root)
    await waitUp(third.origin)
    const thirdToken = /#token=(.+)$/u.exec(third.url)![1]
    third.child.kill('SIGTERM')
    await third.exited
    expect(grants.unusedIds().length).toBeGreaterThan(0)

    const report = await resetAuth({ paths: real, cli, grants, homeRunning: () => false })
    expect(report.hiddenGrantsRevoked).toBeGreaterThan(0)
    expect(report.sessionsRevoked).toBeGreaterThan(0)
    expect(grants.unusedIds()).toEqual([])

    // Fourth boot: nothing from before is honoured, hidden grant included.
    const fourth = await startServer(root)
    await waitUp(fourth.origin)
    expect(await authenticated(fourth.origin, minted.cookie)).toBe(false)
    expect((await exchange(fourth.origin, thirdToken)).status).toBe(401)
    const fresh = await exchange(fourth.origin, /#token=(.+)$/u.exec(fourth.url)![1])
    expect(await authenticated(fourth.origin, fresh.cookie)).toBe(true)
  }, 180_000)
})
