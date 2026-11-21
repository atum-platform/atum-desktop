import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, type Server } from 'node:net'
import { dirname } from 'node:path'

import { WORK_SOCKET_PATH_MAX_BYTES } from './contract'

// The Work gate's only listener (plan §11.2, S0-3). The connector reaches the gate through a Unix socket in a
// directory main creates for this enrollment, owned by the macOS user, mode 0700; the socket is 0600. There is no
// TCP listener and no fallback address: if the path cannot be bound, the route is down and nothing moves.
// A live socket on the path, or a file that is not a socket, is left in place; a stale socket from a dead gate is
// recovered. A socket path is at most about 104 bytes on macOS: the contract says 100.

export class GateSocketError extends Error {
  constructor(readonly code: 'socket_path_too_long' | 'dir_not_protected' | 'path_taken_live' | 'path_taken_not_a_socket' | 'bind_failed' | 'socket_not_protected') {
    super(code)
    this.name = 'GateSocketError'
  }
}

export type GateHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

export function assertProtectedDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const stat = lstatSync(directory)

  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid() !== undefined && stat.uid !== uid()) || (stat.mode & 0o077) !== 0) {
    throw new GateSocketError('dir_not_protected')
  }
}

function isLive(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createConnection({ path })

    const done = (live: boolean) => {
      probe.destroy()
      resolve(live)
    }

    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    probe.setTimeout(1000, () => done(true))
  })
}

export interface BoundGateSocket {
  readonly path: string
  readonly server: Server
  close(): Promise<void>
}

/** Bind the gate's socket, or throw a typed reason. Never binds anything else. */
export async function bindGateSocket(path: string, handler: GateHandler): Promise<BoundGateSocket> {
  if (Buffer.byteLength(path) > WORK_SOCKET_PATH_MAX_BYTES) {
    throw new GateSocketError('socket_path_too_long')
  }

  assertProtectedDirectory(dirname(path))

  if (existsSync(path)) {
    const stat = lstatSync(path)

    if (!stat.isSocket()) {
      throw new GateSocketError('path_taken_not_a_socket')
    }

    if (await isLive(path)) {
      throw new GateSocketError('path_taken_live')
    }

    unlinkSync(path)
  }

  const server = createServer(
    { maxHeaderSize: 16 * 1024, headersTimeout: 15_000, requestTimeout: 90_000, keepAliveTimeout: 5000 },
    (request, response) => {
      void Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'cache-control': 'no-store' })
        }

        response.end()
      })
    }
  )

  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new GateSocketError('bind_failed')))
    server.listen({ path }, () => resolve())
  })

  try {
    chmodSync(path, 0o600)
    const stat = lstatSync(path)

    if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (uid() !== undefined && stat.uid !== uid())) {
      throw new GateSocketError('socket_not_protected')
    }
  } catch (error) {
    server.close()
    throw error
  }

  return {
    path,
    server,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => {
          try {
            unlinkSync(path)
          } catch {
            // already gone
          }

          resolve()
        })
      })
  }
}
