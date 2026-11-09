import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { isIP, type Socket } from 'node:net'

import { createHttpProxyServer } from '@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'
import { canonicalizeHost } from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import {
  createResolvedAddressGuard,
  type ResolvedAddressGuard
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js'

import type { AuditWriter } from '../audit'

/** Hosts an agent routinely needs for builds and package installs. Matched case-insensitively; a
 * leading `.` means "this domain and any subdomain". Since owner decision 2026-10-20 every public host
 * is allowed silently (no per-host Touch ID, which turned one `npm install` into ~15 prompts); this
 * list now only labels the audit line ("allowlist" vs "open"). The private/loopback/metadata guard
 * below still applies to every host.  */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'github.com',
  '.github.com',
  '.githubusercontent.com',
  'codeload.github.com',
  'registry.npmjs.org',
  '.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'deb.debian.org',
  'security.debian.org',
  'archive.ubuntu.com',
  'ghcr.io',
  'quay.io',
  'auth.docker.io',
  'registry-1.docker.io',
  'production.cloudflare.docker.com'
]

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase()
  const p = pattern.toLowerCase()

  if (p.startsWith('.')) {
    return h === p.slice(1) || h.endsWith(p)
  }

  return h === p
}

export interface EgressDecisionInput {
  readonly host: string
  readonly allowlist: readonly string[]
}

export type EgressDecision = { readonly outcome: 'allow'; readonly reason: 'allowlist' | 'open' }

/** Decide an egress host without any I/O. Every host is allowed; the reason is only the audit label. */
export function decideEgress(input: EgressDecisionInput): EgressDecision {
  const host = input.host.toLowerCase()

  return { outcome: 'allow', reason: input.allowlist.some(pattern => hostMatches(host, pattern)) ? 'allowlist' : 'open' }
}

export interface EgressProxyDeps {
  /** Whether any device grant is live right now. With none, nothing is proxied. */
  active?(): boolean
  /** Trusted test seam; production always checks public destinations. */
  addressGuard?: ResolvedAddressGuard
  audit: AuditWriter
  allowlist?: readonly string[]
}

const PORT_HOST = '127.0.0.1'
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7']

export class EgressProxy {
  private server?: Server
  private readonly allowlist: readonly string[]
  private readonly sockets = new Set<Socket>()
  private generation = 0
  private readonly addresses: ResolvedAddressGuard
  /** Main-process session credential; A-APP passes it only to the constrained command host. */
  readonly authToken = randomBytes(32).toString('hex')

  constructor(private readonly deps: EgressProxyDeps) {
    this.allowlist = deps.allowlist ?? DEFAULT_EGRESS_ALLOWLIST
    // 0.0.78 always retains DENIED_CLASSES (loopback/metadata/link-local/etc.);
    // deniedResolvedAddresses adds these private ranges, rather than replacing them.
    this.addresses = deps.addressGuard ?? createResolvedAddressGuard({ deniedResolvedAddresses: PRIVATE_RANGES })
  }

  private live(generation = this.generation): boolean {
    return Boolean(this.server && generation === this.generation && this.deps.active?.())
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error('egress_proxy_already_started')
    }

    const server = createHttpProxyServer({
      proxyAuthToken: this.authToken,
      filter: async (port, rawHost, socket) => {
        const generation = this.generation
        const host = canonicalizeHost(rawHost)

        if (!host || !this.live(generation) || socket.destroyed) {
          return false
        }

        // srt's resolved-address guard intentionally exempts IP literals; Atum
        // checks them too, before the host is let through.
        const addressHost = host === 'localhost' || host.endsWith('.localhost') ? '127.0.0.1' : host

        if (isIP(addressHost) && !this.addresses.permits('atum-public-destination.invalid', addressHost, port)) {
          this.deps.audit.record({ decision: 'refused', tool: 'egress', summary: `${host} (private destination)` })

          return false
        }

        this.authorize(host)

        return this.live(generation) && !socket.destroyed
      },
      // The checked DNS answer is the answer dialed; no second resolution can
      // rebind an allowlisted hostname to a daemon or cloud metadata address.
      lookupFor: port => {
        const generation = this.generation
        const lookup = this.addresses.lookupFor(port)

        return (host, options, callback) => {
          lookup(host, options, (error, address, family) => {
            if (!this.live(generation)) {
              const stopped = Object.assign(new Error('egress_proxy_stopped'), { code: 'ECONNABORTED' })
              callback(stopped, address, family)
            } else {
              callback(error, address, family)
            }
          })
        }
      }
    })

    this.server = server
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => socket.destroy())
    })

    try {
      return await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, PORT_HOST, () => {
          const address = server.address()

          if (address && typeof address === 'object') {
            resolve(address.port)
          } else {
            reject(new Error('egress_proxy_no_port'))
          }
        })
      })
    } catch (error) {
      this.server = undefined
      server.close()
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.closeAll()

    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  /** Stop fences open tunnels and approvals that were already waiting. */
  closeAll(): void {
    this.generation++

    for (const socket of this.sockets) {
      socket.destroy()
    }

    this.sockets.clear()
  }

  /** Every public host is let through, and every new one is written to the audit log. */
  private authorize(host: string): void {
    const decision = decideEgress({ host, allowlist: this.allowlist })

    this.deps.audit.record({ decision: 'admitted', tool: 'egress', summary: `${host} (${decision.reason})` })
  }
}

/** `host:port` or `[v6]:port` from a CONNECT line. */
export function parseAuthority(
  target: string,
  defaultPort: number
): { host: string; port: number; path: string } | null {
  const match = target.match(/^(?:\[([0-9a-fA-F:.]+)\]|([^:\s/]+))(?::(\d{1,5}))?$/)

  if (!match) {
    return null
  }

  const port = match[3] ? Number(match[3]) : defaultPort

  return port > 0 && port < 65536 ? { host: (match[1] ?? match[2]).toLowerCase(), port, path: '' } : null
}
