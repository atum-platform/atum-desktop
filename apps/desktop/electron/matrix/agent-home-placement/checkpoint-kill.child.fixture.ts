/**
 * Test support only: the app's agent-home model in a process of its own, for `checkpoint-kill.integration.test.ts`.
 *
 * It is the real thing wherever that matters for a crash: `createAgentHomeApp` (the real controller, journal, standing, signing,
 * archive store and key source), a real `EncryptedStore` file for the journal, the real Python tool, real staging folders, and
 * the platform and its object store over real sockets. Only the agent's runtime is a stand-in (`MacAgentHandle`): this process
 * has no Hermes, so the hold on its writers is a function that grants.
 *
 * It takes one checkpoint and prints `OUTCOME <json>`. Given a step to die at, it prints `KILLPOINT <step>` the moment the
 * flow reports that step (after the journal has recorded it) and then does nothing for ever, blocking its thread, so that
 * the test can kill it with SIGKILL while it is exactly there: no `finally` runs, no cleanup, no exit handler.
 */
import { createPrivateKey } from 'node:crypto'
import { writeSync } from 'node:fs'
import path from 'node:path'

import type { SafeStorageLike } from '../../encrypted-store'
import { EncryptedStore } from '../../encrypted-store'
import { softwareSign } from '../device/device-signer.fixture'

import { createAgentHomeApp } from './app'
import type { ExecutorKey } from './executor-auth'
import type { MacAgentHandle } from './runtime-adapter'

export interface KillChildConfig {
  shellOrigin: string
  token: string
  python: string
  source: string
  /** The Mac's own folders: the journal file, and the work, backup and quarantine folders. */
  root: string
  home: string
  agent: string
  ownerPrincipal: string
  device: { deviceServiceId: string; enrollmentEpoch: number; kid: string; spki: string; privateKeyPem: string }
  lease: { leaseId: string; leaseExpiresAtPlatform: number; executorTerm: number }
  /** The platform's clock, which does not move in these tests. */
  now: number
  /**
   * A step to die at (`reserved`, `captured`, `sealed`, `uploaded`, `committing`), or `hold`: while the writers are being held,
   * or `after-commit`: when the platform has committed and the answer has not yet been read.
   */
  dieAt: string | null
}

/** A reversible stand-in for the OS keychain: what the real store does to a value is not what is being tested. */
export const toySafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8').reverse(),
  decryptString: value => Buffer.from(value).reverse().toString('utf8')
}

export const journalFile = (root: string): string => path.join(root, 'journal.json')

function dieHere(step: string): never {
  // Written straight to the descriptor, so it is out before the thread stops.
  writeSync(1, `KILLPOINT ${step}\n`)
  // The whole process stands still until it is killed: no timer, no callback, no `finally`.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)

  throw new Error('unreachable')
}

async function main(): Promise<void> {
  const config = JSON.parse(process.env.ATUM_KILL_CONFIG ?? '') as KillChildConfig
  const privateKey = createPrivateKey(config.device.privateKeyPem)
  const softwareKey = { public: { kid: config.device.kid, spki: config.device.spki }, privateKey }

  const key: ExecutorKey = {
    deviceServiceId: config.device.deviceServiceId,
    enrollmentEpoch: config.device.enrollmentEpoch,
    identityKid: config.device.kid,
    signIdentity: async bytes => ({ kid: config.device.kid, sig: softwareSign(softwareKey, bytes) })
  }

  const handle: MacAgentHandle = {
    home: () => config.home,
    leaseFacts: () => config.lease,
    drain: async () => undefined,
    stopWriters: async () => undefined,
    restart: () => undefined,
    beginHere: () => undefined,
    running: async () => true,
    atRest: async () => true,
    holdWrites: async () => (config.dieAt === 'hold' ? dieHere('hold') : () => undefined),
    readiness: () => ({ homeAccessible: true, runtimeUsable: true, matrixIntakeWorking: true })
  }

  // `after-commit`: the platform has the commit and the answer is on its way back, when this process dies. The journal still
  // says the commit was being sent.
  const isCommit = (init: RequestInit | undefined) =>
    typeof init?.body === 'string' && init.body.includes('"operation":"commit"') && init.body.includes('"uploadVerified":true')

  const app = createAgentHomeApp({
    request: send => send(config.token, `${config.shellOrigin}/api/matrix/v1`),
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init)

      return config.dieAt === 'after-commit' && isCommit(init) ? dieHere('after-commit') : response
    },
    key: () => key,
    store: new EncryptedStore(journalFile(config.root), toySafeStorage),
    runtime: () => ({ python: config.python, source: config.source }),
    dirs: { work: path.join(config.root, 'work'), backups: path.join(config.root, 'backups'), quarantine: path.join(config.root, 'quarantine') },
    handle: () => handle,
    publicationStore: () => null,
    agents: () => [config.agent],
    ready: () => true,
    scope: () => '@owner:atum.example',
    ownerPrincipal: async () => config.ownerPrincipal,
    changed: () => undefined,
    log: line => writeSync(2, `${line}\n`),
    now: () => config.now,
    budgets: { drainMs: 1_000, targetWaitMs: 15 * 60_000, attempts: 3 },
    step: name => {
      if (config.dieAt !== null && name === `checkpoint:${config.dieAt}`) {
        dieHere(config.dieAt)
      }
    }
  })

  app.controller.ctx.journal.update(config.agent, entry => {
    entry.managed = true
  })

  const outcome = await app.controller.checkpoint(config.agent, new AbortController().signal, 'idle')

  writeSync(1, `OUTCOME ${JSON.stringify(outcome)}\n`)
  process.exit(0)
}

// Run only as the process the test spawns, never when something imports this file.
if (process.env.ATUM_KILL_CONFIG) {
  main().catch((error: unknown) => {
    writeSync(2, `CHILD FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
}
