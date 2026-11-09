/**
 * Test support only: a Mac wired the way the app wires it (`createAgentHomeApp`), around the simulated platform, a
 * simulated homeserver for the platform's publication worker, and one agent's SDK window (`FakeHandle`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type AgentHomeApp, type AgentHomeAppDeps, createAgentHomeApp } from './app'
import { MemoryStore, type TestMac } from './mac.fixture'
import { FakeHomeTool } from './node.fixture'
import { FakeHandle } from './service.fixture'
import { StubMatrixServer } from './stub-platform.fixture'
import { scratchDirectory, type World } from './world.fixture'

export interface MacAppOptions {
  runtime?: boolean
  ready?: () => boolean
  matrix?: StubMatrixServer
  cadence?: AgentHomeAppDeps['cadence']
  sleep?: AgentHomeAppDeps['sleep']
  /** The platform answers through this instead (a platform that never answers, say). */
  fetch?: typeof fetch
  /** The files of the agent's Hermes home. */
  files?: Record<string, string>
  tool?: FakeHomeTool
  /** Who the platform says the signed-in owner is (by default the owner the fake Shell derives data keys for). */
  ownerPrincipal?: AgentHomeAppDeps['ownerPrincipal']
  /** Runs before the app is made: what a process that was killed earlier left in this Mac's work folder (the app sweeps it at start). */
  beforeStart?: (folders: { work: string }) => void
}

export function macApp(world: World, mac: TestMac, options: MacAppOptions = {}) {
  const matrix = options.matrix ?? new StubMatrixServer()
  const root = scratchDirectory(`atum-home-app-${mac.name.replace(/\W+/gu, '-')}-`)
  const home = path.join(root, 'hermes-home')
  mkdirSync(path.join(home, 'memories'), { recursive: true })
  writeFileSync(path.join(home, 'memories/MEMORY.md'), `${mac.name} remembers.`)
  writeFileSync(path.join(home, 'SOUL.md'), 'You are Test.')

  for (const [relative, content] of Object.entries(options.files ?? {})) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
    writeFileSync(path.join(home, relative), content)
  }

  options.beforeStart?.({ work: path.join(root, 'work') })

  const handle = new FakeHandle(world, mac, home)
  const agentStore = new MemoryStore()
  const logs: string[] = []
  let changes = 0

  const app: AgentHomeApp = createAgentHomeApp({
    request: send => send(world.stub.token, 'https://shell.test/api/matrix/v1'),
    fetch: options.fetch ?? world.stub.fetch,
    key: mac.key,
    store: mac.store,
    runtime: () => (options.runtime === false ? undefined : { python: '/unused/python', source: '/unused/source' }),
    tool: options.runtime === false ? undefined : (options.tool ?? new FakeHomeTool()),
    dirs: { work: path.join(root, 'work'), backups: path.join(root, 'backups'), quarantine: path.join(root, 'quarantine') },
    handle: () => handle,
    publicationStore: () => agentStore,
    // The platform's worker comes round whenever this Mac looks: time passes, the lease is renewed, the row is sent.
    publicationTiming: {
      pollMs: 1_000,
      waitMs: 30_000,
      sleep: async ms => {
        world.clock.advance(ms)

        if (world.stub.lease(world.agent)) {
          world.stub.renewLease(world.agent)
        }

        world.stub.sweepPublications(matrix)
      }
    },
    agents: () => [world.agent],
    ready: options.ready ?? (() => true),
    scope: () => '@owner:atum.example',
    ownerPrincipal: options.ownerPrincipal ?? (async () => world.stub.ownerPrincipal),
    changed: () => {
      changes += 1
    },
    log: line => logs.push(line),
    now: world.clock.now,
    budgets: { drainMs: 1_000, targetWaitMs: 15 * 60_000, attempts: 3 },
    sleep: options.sleep,
    cadence: options.cadence
  })

  // The agent host's queue, wrapped by the very function main.ts wraps it with.
  handle.guardWith((queue, agent) => app.guard(queue, agent))

  return { app, handle, home, logs, matrix, store: agentStore, changes: () => changes }
}

export async function beats(world: World, nodes: Array<ReturnType<typeof macApp>>, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const node of nodes) {
      if (world.stub.lease(world.agent)) {
        world.stub.renewLease(world.agent)
      }

      node.app.service.kick()
      await node.app.service.tick()
    }

    world.clock.advance(1_000)
  }
}

/** The kinds of command that reached the agent's SDK window, in order. */
export const kindsSent = (node: ReturnType<typeof macApp>) => node.handle.queue.sent.map(command => command.kind)
