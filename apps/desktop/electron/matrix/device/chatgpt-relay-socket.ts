import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'

import type { ChatGptRelayHandler, RelaySshBinding } from './chatgpt-relay'

const MAX = 800_000
export const relaySocketPath = (home: string) => path.join(home, '.atum-chatgpt-relay', 'relay.sock')

/** One JSON envelope per half-closed stream. Never retries submitted inference. */
export class ChatGptRelaySocket {
  private server?: Server
  private readonly clients = new Set<Socket>()
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string, private readonly handler: ChatGptRelayHandler,
    private readonly bindings: () => readonly RelaySshBinding[]) {}

  setEnabled(enabled: boolean): Promise<void> {
    const result = this.chain.then(() => enabled ? this.start() : this.stop())
    this.chain = result.catch(() => undefined)

    return result
  }

  private async start(): Promise<void> {
    if (this.server) { return }
    const dir = path.dirname(this.file)
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') { throw error } })
    const info = await lstat(dir)

    if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) {
      throw new Error('unsafe_relay_directory')
    }

    const old = await lstat(this.file).catch(error => {
      if (error.code !== 'ENOENT') { throw error }

      return null
    })

    if (old) {
      if (!old.isSocket() || old.uid !== process.getuid!()) { throw new Error('unsafe_relay_socket') }
      await unlink(this.file)
    }

    const server = createServer({ allowHalfOpen: true }, client => this.accept(client))

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.file, () => { server.removeListener('error', reject); resolve() })
      })
      await chmod(this.file, 0o600)
      server.on('error', () => { void this.setEnabled(false) })
      this.server = server
    } catch {
      server.close()
      throw new Error('relay_socket_unavailable')
    }
  }

  private accept(client: Socket): void {
    this.clients.add(client)
    const controller = new AbortController()
    const timer = setTimeout(() => client.destroy(), 65_000)
    const chunks: Buffer[] = []
    let bytes = 0
    client.on('error', () => {})
    client.on('close', () => {
      clearTimeout(timer); controller.abort(); this.clients.delete(client)
    })
    client.on('data', chunk => {
      bytes += chunk.length

      if (bytes > MAX) { client.destroy();

 return }

      chunks.push(Buffer.from(chunk))
    })
    client.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>

        const binding = this.bindings().find(row => row.ownerPrincipal === body.ownerPrincipal &&
          row.agentPrincipal === body.agentPrincipal && row.connectionEpoch === body.connectionEpoch)

        if (!binding) { throw new Error('unbound_relay') }

        const check = setInterval(() => {
          if (!this.bindings().some(row => row.ownerPrincipal === binding.ownerPrincipal &&
              row.agentPrincipal === binding.agentPrincipal && row.connectionEpoch === binding.connectionEpoch)) {
            controller.abort()
          }
        }, 250)

        try {
          const response = Buffer.from(JSON.stringify(await this.handler.handleSsh(body, binding, controller.signal)))

          if (controller.signal.aborted || !this.bindings().some(row => row.ownerPrincipal === binding.ownerPrincipal &&
              row.agentPrincipal === binding.agentPrincipal && row.connectionEpoch === binding.connectionEpoch)) {
            throw new Error('relay_revoked')
          }

          if (response.length > MAX) { throw new Error('relay_response_too_large') }
          client.end(response)
        } finally { clearInterval(check) }
      })().catch(() => client.end(JSON.stringify({ state: 'refused', status: 409, code: 'stopped' })))
    })
  }

  private async stop(): Promise<void> {
    this.handler.disable()

    for (const client of this.clients) { client.destroy() }
    const server = this.server
    this.server = undefined

    if (server) { await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}
