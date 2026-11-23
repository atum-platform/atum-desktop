import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { bindGateSocket, type BoundGateSocket, GateSocketError } from './socket'

// The gate's only listener (plan §11.2, S0-3): a Unix socket in a directory only this user can enter, never TCP,
// never a fallback address. A live socket or a non-socket file on the path is left alone; a stale one is recovered.

const dirs: string[] = []
const bound: BoundGateSocket[] = []

const tmp = () => {
  const dir = mkdtempSync('/tmp/wgk-')

  dirs.push(dir)

  return dir
}

const handler = (_req: unknown, res: { writeHead(code: number): void; end(text: string): void }) => {
  res.writeHead(200)
  res.end('gate')
}

const get = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const req = request({ socketPath: path, path: '/', method: 'GET' }, response => {
      let body = ''

      response.on('data', chunk => (body += chunk))
      response.on('end', () => resolve(body))
    })

    req.on('error', reject)
    req.end()
  })

afterEach(async () => {
  for (const item of bound.splice(0)) {
    await item.close()
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const reason = async (promise: Promise<unknown>) => {
  try {
    await promise

    return 'bound'
  } catch (error) {
    return error instanceof GateSocketError ? error.code : String(error)
  }
}

describe('binding the gate\'s socket', () => {
  it('binds in a protected directory: directory 0700, socket 0600, no TCP', async () => {
    const dir = join(tmp(), 'run')
    const socket = await bindGateSocket(join(dir, 'g.sock'), handler as never)

    bound.push(socket)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(socket.path).isSocket()).toBe(true)
    expect(lstatSync(socket.path).mode & 0o777).toBe(0o600)
    expect(typeof socket.server.address()).toBe('string')
    expect(await get(socket.path)).toBe('gate')
  })

  it('refuses a path over the contract\'s 100 bytes', async () => {
    const dir = join(tmp(), 'x'.repeat(95))

    expect(await reason(bindGateSocket(join(dir, 'g.sock'), handler as never))).toBe('socket_path_too_long')
  })

  it.each([['0755', 0o755], ['0750', 0o750], ['0770', 0o770]])('refuses a directory with mode %s', async (_name, mode) => {
    const dir = join(tmp(), 'run')

    mkdirSync(dir)
    chmodSync(dir, mode)

    expect(await reason(bindGateSocket(join(dir, 'g.sock'), handler as never))).toBe('dir_not_protected')
    expect(existsSync(join(dir, 'g.sock'))).toBe(false)
  })

  it('refuses a directory that is a symbolic link', async () => {
    const base = tmp()
    const real = join(base, 'real')

    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, join(base, 'link'))

    expect(await reason(bindGateSocket(join(base, 'link', 'g.sock'), handler as never))).toBe('dir_not_protected')
  })

  it('leaves a live socket alone and keeps serving through it', async () => {
    const dir = join(tmp(), 'run')
    const first = await bindGateSocket(join(dir, 'g.sock'), handler as never)

    bound.push(first)

    expect(await reason(bindGateSocket(first.path, handler as never))).toBe('path_taken_live')
    expect(await get(first.path)).toBe('gate')
  })

  it('leaves a file that is not a socket in place', async () => {
    const dir = join(tmp(), 'run')

    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'g.sock'), 'not a socket')

    expect(await reason(bindGateSocket(join(dir, 'g.sock'), handler as never))).toBe('path_taken_not_a_socket')
    expect(lstatSync(join(dir, 'g.sock')).isFile()).toBe(true)
  })

  it('recovers a stale socket left by a gate that died', async () => {
    const dir = join(tmp(), 'run')

    mkdirSync(dir, { mode: 0o700 })

    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(join(dir, 'g.sock'))},()=>console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] })

    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()))
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))

    expect(lstatSync(join(dir, 'g.sock')).isSocket()).toBe(true)

    const socket = await bindGateSocket(join(dir, 'g.sock'), handler as never)

    bound.push(socket)
    expect(await get(socket.path)).toBe('gate')
  })

  it('closing removes the socket, so a switch leaves no address to reach', async () => {
    const dir = join(tmp(), 'run')
    const socket = await bindGateSocket(join(dir, 'g.sock'), handler as never)

    await socket.close()
    expect(existsSync(socket.path)).toBe(false)
  })
})
