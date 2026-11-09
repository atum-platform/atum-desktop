import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  AtumFilesystemActionBroker,
  AtumFilesystemCapabilityAuthority,
  DEFAULT_PERSONAL_AGENT_ID,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor
} from './atum-filesystem-capability'
import { AtumInteractionCapabilityAuthority } from './atum-interaction-capability'
import { AccountRootAuthority } from './atum-messaging'

/**
 * Agent identity at the authorization boundary.
 *
 * Atum agents are Hermes profiles, and several of their backends run at once.
 * They deliberately SHARE the account's document workspace, so these tests do
 * not assert that one agent cannot read another's files. What they assert is
 * that the broker can always tell which agent is calling, and that the things
 * which must never be shared — credentials, leases, write receipts, replay
 * slots — are not.
 */

const ACCOUNT = '00000000-0000-4000-8000-bd7662a5eeb4'

const ACTOR: Extract<FilesystemCapabilityActor, { kind: 'personal' }> = {
  kind: 'personal',
  personalAgentId: DEFAULT_PERSONAL_AGENT_ID
}

const HERMES = { authority: 'hermes' } as const
const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function harness() {
  const userData = mkdtempSync(join(tmpdir(), 'atum-agent-identity-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT)
  roots.commit(ACCOUNT, 4)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT, generation: 4, paths })
  const interaction = new AtumInteractionCapabilityAuthority({ now: () => 1_800_000_000_000 })
  interaction.activateAccount({ accountId: ACCOUNT, generation: 4, paths })
  const account: FilesystemAccountEnvelope = { accountId: ACCOUNT, accountGeneration: 4 }

  return { account, authority, interaction, paths }
}

function headers(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

function leaseBody(account: FilesystemAccountEnvelope, operationId: string, runtimeSessionId = 'session-1') {
  return {
    account,
    actor: ACTOR,
    operationId,
    runtimeSessionId,
    toolName: 'computer_use',
    toolArgs: { action: 'capture', app: 'Safari' },
    durationMs: 120_000,
    approval: HERMES
  }
}

test('every backend gets its own credential, and a respawn retires the one it replaced', async () => {
  const { authority, interaction } = harness()
  const broker = new AtumFilesystemActionBroker(authority, undefined, interaction)
  await broker.start()

  try {
    const atum = broker.backendEnvironment()
    const alfred = broker.backendEnvironment('alfred')
    const analyst = broker.backendEnvironment('analyst')

    assert.notEqual(atum.ATUM_FILESYSTEM_BROKER_TOKEN, alfred.ATUM_FILESYSTEM_BROKER_TOKEN)
    assert.notEqual(alfred.ATUM_FILESYSTEM_BROKER_TOKEN, analyst.ATUM_FILESYSTEM_BROKER_TOKEN)
    assert.equal(atum.ATUM_FILESYSTEM_BROKER_URL, alfred.ATUM_FILESYSTEM_BROKER_URL)

    const url = `${atum.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/authority`
    assert.equal((await fetch(url, { headers: headers(alfred.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 200)

    // Respawning Alfred invalidates the previous generation's token.
    const alfredAgain = broker.backendEnvironment('alfred')
    assert.notEqual(alfredAgain.ATUM_FILESYSTEM_BROKER_TOKEN, alfred.ATUM_FILESYSTEM_BROKER_TOKEN)
    assert.equal((await fetch(url, { headers: headers(alfred.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 401)
    assert.equal((await fetch(url, { headers: headers(alfredAgain.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 200)

    // Stopping an agent revokes its credential and leaves the others alone.
    broker.revokeBackendCredential('alfred')
    assert.equal((await fetch(url, { headers: headers(alfredAgain.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 401)
    assert.equal((await fetch(url, { headers: headers(analyst.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 200)
    assert.equal((await fetch(url, { headers: headers(atum.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 200)

    // An unknown or empty bearer is never accepted.
    assert.equal((await fetch(url, { headers: headers('not-a-real-token') })).status, 401)
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' } })).status, 401)

    broker.revokeAllBackendCredentials()
    assert.equal((await fetch(url, { headers: headers(atum.ATUM_FILESYSTEM_BROKER_TOKEN!) })).status, 401)
  } finally {
    await broker.stop()
  }
})

test('two agents run the same session and operation ids without touching each other lease', async () => {
  const { account, authority, interaction } = harness()
  const broker = new AtumFilesystemActionBroker(authority, undefined, interaction)
  await broker.start()

  try {
    const base = broker.backendEnvironment().ATUM_FILESYSTEM_BROKER_URL!
    const atum = broker.backendEnvironment().ATUM_FILESYSTEM_BROKER_TOKEN!
    const alfred = broker.backendEnvironment('alfred').ATUM_FILESYSTEM_BROKER_TOKEN!
    const lease = `${base}/v1/interaction/request-use`
    const finish = `${base}/v1/interaction/finish-use`

    // Deliberately identical session and operation ids in both agents.
    const started = await (await fetch(lease, {
      method: 'POST', headers: headers(atum), body: JSON.stringify(leaseBody(account, 'op-1'))
    })).json() as { allowed: boolean; grantId: string }

    assert.equal(started.allowed, true)

    const startedB = await (await fetch(lease, {
      method: 'POST', headers: headers(alfred), body: JSON.stringify(leaseBody(account, 'op-1'))
    })).json() as { allowed: boolean; grantId: string }

    assert.equal(startedB.allowed, true, 'the second agent is not blocked by the first agent operation')
    assert.notEqual(startedB.grantId, started.grantId)
    assert.equal(interaction.listGrants().length, 2)

    // Neither agent can finish the other's operation: each finish resolves
    // only its own lease, and a second finish under the same agent fails.
    const finishBody = JSON.stringify({ operationId: 'op-1', runtimeSessionId: 'session-1', completedOperation: true })
    assert.deepEqual(await (await fetch(finish, { method: 'POST', headers: headers(atum), body: finishBody })).json(), {
      allowed: true
    })
    assert.equal(interaction.listGrants().length, 1, 'the other agent lease is still live')

    const doubleFinish = await (await fetch(finish, { method: 'POST', headers: headers(atum), body: finishBody })).json() as {
      allowed: boolean
    }

    assert.equal(doubleFinish.allowed, false)

    assert.deepEqual(await (await fetch(finish, { method: 'POST', headers: headers(alfred), body: finishBody })).json(), {
      allowed: true
    })
    assert.deepEqual(interaction.listGrants(), [])

    // Replay is per agent too: each agent's own id is spent, independently.
    for (const token of [atum, alfred]) {
      const replay = await (await fetch(lease, {
        method: 'POST', headers: headers(token), body: JSON.stringify(leaseBody(account, 'op-1'))
      })).json() as { code: string }

      assert.equal(replay.code, 'CAPABILITY_REPLAYED')
    }
  } finally {
    await broker.stop()
  }
})

test('a revoked agent cannot lease, and the audit names the agent that acted', async () => {
  const { account, authority, interaction, paths } = harness()
  const appended: string[] = []

  const audited = new AtumInteractionCapabilityAuthority({
    now: () => 1_800_000_000_000,
    appendAudit: ((_path: string, line: string) => appended.push(String(line))) as never
  })

  audited.activateAccount({ accountId: ACCOUNT, generation: 4, paths })
  const broker = new AtumFilesystemActionBroker(authority, undefined, audited)
  await broker.start()

  try {
    const base = broker.backendEnvironment().ATUM_FILESYSTEM_BROKER_URL!
    const alfred = broker.backendEnvironment('alfred').ATUM_FILESYSTEM_BROKER_TOKEN!
    const lease = `${base}/v1/interaction/request-use`

    const started = await (await fetch(lease, {
      method: 'POST', headers: headers(alfred), body: JSON.stringify(leaseBody(account, 'op-audit'))
    })).json() as { allowed: boolean }

    assert.equal(started.allowed, true)

    const records = appended.map(line => JSON.parse(line) as { agent?: string; event: string })
    assert.ok(records.length > 0)
    assert.ok(records.every(record => record.agent === 'alfred'), 'every audited action names the acting agent')
    assert.ok(records.some(record => record.event === 'use'))

    broker.revokeBackendCredential('alfred')

    const afterRevoke = await fetch(lease, {
      method: 'POST', headers: headers(alfred), body: JSON.stringify(leaseBody(account, 'op-after-revoke'))
    })

    assert.equal(afterRevoke.status, 401)
    void interaction
  } finally {
    await broker.stop()
  }
})

test('one agent cannot consume another agent write receipt', () => {
  const { account, authority, paths } = harness()
  const target = join(paths.workspaceRoot, 'shared.md')

  authority.issueApprovedWriteGrant({
    account,
    actor: ACTOR,
    contentByteSize: 4,
    operationId: 'write-1',
    resourcePath: target
  })

  const decision = authority.decide({
    account,
    actor: ACTOR,
    agentId: 'alfred',
    capability: 'filesystem.write',
    contentByteSize: 4,
    operationId: 'write-1',
    resourcePath: target
  })

  assert.equal(decision.allowed, true)
  assert.ok(decision.allowed === true && decision.writeReceiptId)

  if (decision.allowed !== true || !decision.writeReceiptId) {
    return
  }

  // The analyst tries to spend Alfred's receipt.
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      agentId: 'analyst',
      operationId: 'write-1',
      receiptId: decision.writeReceiptId
    }),
    { code: 'CAPABILITY_DENIED' }
  )

  // Alfred's own receipt still works afterwards: the refusal did not burn it.
  const consumed = authority.consumeWriteReceipt({
    account,
    actor: ACTOR,
    agentId: 'alfred',
    operationId: 'write-1',
    receiptId: decision.writeReceiptId
  })

  assert.ok('canonicalPath' in consumed)
})

test('agents share the account workspace by design, and that stays true per agent', () => {
  const { account, authority, paths } = harness()
  const target = join(paths.workspaceRoot, 'shared-doc.md')

  // The same document is readable through either agent's calls: this is the
  // owner's shared-workspace decision, asserted so a future change is loud.
  for (const agentId of ['default', 'alfred']) {
    const decision = authority.decide({
      account,
      actor: ACTOR,
      agentId,
      capability: 'filesystem.read',
      operationId: `read-${agentId}`,
      resourcePath: paths.workspaceRoot
    })

    assert.equal(decision.allowed, true, `${agentId} reads the shared workspace`)
  }

  void target
})
