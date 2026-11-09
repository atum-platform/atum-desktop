import assert from 'node:assert/strict'
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  AtumFilesystemActionBroker,
  AtumFilesystemCapabilityAuthority,
  type AtumFilesystemCapabilityAuthorityOptions,
  DEFAULT_PERSONAL_AGENT_ID,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor
} from './atum-filesystem-capability'
import { AtumInteractionCapabilityAuthority } from './atum-interaction-capability'
import { AccountRootAuthority } from './atum-messaging'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'

const ACTOR: Extract<FilesystemCapabilityActor, { kind: 'personal' }> = {
  kind: 'personal',
  personalAgentId: DEFAULT_PERSONAL_AGENT_ID
}

const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function harness(
  accountId = ACCOUNT_A,
  generation = 4,
  authorityOptions: AtumFilesystemCapabilityAuthorityOptions = {}
) {
  const userData = mkdtempSync(join(tmpdir(), 'atum-filesystem-capability-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(accountId)
  roots.commit(accountId, generation)
  const authority = new AtumFilesystemCapabilityAuthority(authorityOptions)
  const grant = authority.activateAccount({ accountId, generation, paths })
  const account: FilesystemAccountEnvelope = { accountId, accountGeneration: generation }

  return { account, authority, grant, paths, roots, userData }
}

function decide(
  authority: AtumFilesystemCapabilityAuthority,
  account: FilesystemAccountEnvelope,
  resourcePath: string,
  operationId: string,
  actor: FilesystemCapabilityActor = ACTOR,
  capability: 'filesystem.delete' | 'filesystem.read' | 'filesystem.write' = 'filesystem.read'
) {
  return authority.decide({ account, actor, capability, operationId, resourcePath })
}

test('issues one typed personal read grant and rejects account, generation, actor, mutation, and replay', () => {
  const { account, authority, grant, paths } = harness()
  const file = join(paths.workspaceRoot, 'note.txt')
  writeFileSync(file, 'account-a')

  assert.deepEqual(grant, {
    grantId: grant.grantId,
    accountId: ACCOUNT_A,
    accountGeneration: 4,
    actor: ACTOR,
    capability: 'filesystem.read',
    scope: {
      kind: 'filesystem-root',
      canonicalRoot: realpathSync(paths.workspaceRoot),
      operations: ['read']
    },
    expiresAt: null,
    revocationGeneration: 1,
    surface: 'backend'
  })
  assert.equal(decide(authority, account, file, 'allow-1').allowed, true)
  assert.deepEqual(decide(authority, account, file, 'allow-1'), {
    allowed: false,
    code: 'CAPABILITY_REPLAYED'
  })
  assert.deepEqual(
    decide(authority, { accountId: ACCOUNT_B, accountGeneration: 4 }, file, 'wrong-account'),
    { allowed: false, code: 'CAPABILITY_STALE' }
  )
  assert.deepEqual(decide(authority, { ...account, accountGeneration: 3 }, file, 'stale'), {
    allowed: false,
    code: 'CAPABILITY_STALE'
  })
  assert.deepEqual(
    decide(authority, account, file, 'conversation', { kind: 'conversation', conversationId: 'thread-1' }),
    { allowed: false, code: 'CAPABILITY_DENIED' }
  )
  assert.deepEqual(
    decide(authority, account, file, 'remote', { kind: 'remote_app', appId: 'moon', instanceId: 'one' }),
    { allowed: false, code: 'CAPABILITY_DENIED' }
  )
  assert.deepEqual(decide(authority, account, file, 'write', ACTOR, 'filesystem.write'), {
    allowed: false,
    code: 'CAPABILITY_DENIED'
  })

  authority.revoke(grant.grantId)
  assert.equal(decide(authority, account, file, 'after-revoke').allowed, false)
})

test('single-use text write grant binds account, actor, exact file, size, expiry, receipt, and replay', () => {
  let now = 1_000
  const { account, authority, grant: readGrant, paths } = harness(ACCOUNT_A, 4, { now: () => now })
  const target = join(paths.workspaceRoot, 'answer.md')
  const canonicalTarget = join(realpathSync(paths.workspaceRoot), 'answer.md')

  const grant = authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 2_000,
    maxBytes: 16
  })

  assert.deepEqual(grant, {
    grantId: grant.grantId,
    accountId: ACCOUNT_A,
    accountGeneration: 4,
    actor: ACTOR,
    capability: 'filesystem.write',
    scope: {
      kind: 'filesystem-file',
      canonicalPath: canonicalTarget,
      canonicalRoot: realpathSync(paths.workspaceRoot),
      maxBytes: 16,
      operations: ['write']
    },
    expiresAt: 2_000,
    revocationGeneration: 1,
    surface: 'backend'
  })

  const allowed = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 5,
    operationId: 'write-1',
    resourcePath: target
  })

  assert.equal(allowed.allowed, true)
  assert.equal(allowed.allowed && typeof allowed.writeReceiptId, 'string')
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'write-1',
      receiptId: allowed.allowed ? allowed.writeReceiptId! : ''
    }),
    { canonicalPath: canonicalTarget }
  )
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'write-1',
      receiptId: allowed.allowed ? allowed.writeReceiptId! : ''
    }),
    { code: 'CAPABILITY_REPLAYED' }
  )

  const wrongPath = join(paths.workspaceRoot, 'other.md')

  const wrongPathGrant = authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 2_000
  })

  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 5,
      operationId: 'write-2',
      resourcePath: wrongPath
    }),
    { allowed: false, code: 'CAPABILITY_SCOPE_ESCAPE' }
  )
  authority.revoke(wrongPathGrant.grantId)

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 2_000,
    maxBytes: 4
  })
  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 5,
      operationId: 'write-3',
      resourcePath: target
    }),
    { allowed: false, code: 'CAPABILITY_TOO_LARGE' }
  )

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 2_000
  })
  now = 2_001
  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 1,
      operationId: 'write-4',
      resourcePath: target
    }),
    { allowed: false, code: 'CAPABILITY_EXPIRED' }
  )

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 3_000
  })

  const revocable = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 1,
    operationId: 'write-5',
    resourcePath: target
  })

  assert.equal(revocable.allowed, true)
  authority.revoke(readGrant.grantId)
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'write-5',
      receiptId: revocable.allowed ? revocable.writeReceiptId! : ''
    }),
    { canonicalPath: canonicalTarget }
  )

  const revokedDecisionGrant = authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 3_000
  })

  const revokedDecision = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 1,
    operationId: 'write-revoked',
    resourcePath: target
  })

  assert.equal(revokedDecision.allowed, true)
  authority.revoke(revokedDecisionGrant.grantId)
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'write-revoked',
      receiptId: revokedDecision.allowed ? revokedDecision.writeReceiptId! : ''
    }),
    { code: 'CAPABILITY_REVOKED' }
  )

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: 3_100
  })

  const expiringReceipt = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 1,
    operationId: 'write-6',
    resourcePath: target
  })

  assert.equal(expiringReceipt.allowed, true)
  now = 3_101
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'write-6',
      receiptId: expiringReceipt.allowed ? expiringReceipt.writeReceiptId! : ''
    }),
    { code: 'CAPABILITY_EXPIRED' }
  )
})

test('approved write issuance binds the fresh Hermes operation and expires closed', () => {
  let now = 1_000
  const { account, authority, paths } = harness(ACCOUNT_A, 4, { now: () => now })
  const target = join(paths.workspaceRoot, 'approved.md')

  authority.issueApprovedWriteGrant({
    account,
    actor: ACTOR,
    contentByteSize: 4,
    operationId: 'approved-operation',
    resourcePath: target
  })

  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 4,
      operationId: 'wrong-operation',
      resourcePath: target
    }),
    { allowed: false, code: 'CAPABILITY_DENIED' }
  )
  assert.equal(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 4,
      operationId: 'approved-operation',
      resourcePath: target
    }).allowed,
    true
  )

  authority.issueApprovedWriteGrant({
    account,
    actor: ACTOR,
    contentByteSize: 1,
    operationId: 'expired-operation',
    resourcePath: join(paths.workspaceRoot, 'expired.txt')
  })
  now += 30_001
  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 1,
      operationId: 'expired-operation',
      resourcePath: join(paths.workspaceRoot, 'expired.txt')
    }),
    { allowed: false, code: 'CAPABILITY_EXPIRED' }
  )
})

test('relative Hermes write paths resolve inside the active account workspace', () => {
  const { account, authority, paths } = harness(ACCOUNT_A, 4)
  const canonicalTarget = join(realpathSync(paths.workspaceRoot), 'answer.md')

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: 'answer.md',
    expiresAt: Date.now() + 10_000
  })

  const allowed = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 5,
    operationId: 'relative-write',
    resourcePath: 'answer.md'
  })

  assert.equal(allowed.allowed, true)
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'relative-write',
      receiptId: allowed.allowed ? allowed.writeReceiptId! : ''
    }),
    { canonicalPath: canonicalTarget }
  )
})

test('approval can issue a path-scoped grant after an initial denied tool call', () => {
  const { account, authority, paths } = harness()
  const target = join(paths.workspaceRoot, 'approved.txt')

  assert.deepEqual(
    authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 5,
      operationId: 'before-approval',
      resourcePath: target
    }),
    { allowed: false, code: 'CAPABILITY_DENIED' }
  )

  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: target,
    expiresAt: Date.now() + 10_000
  })

  const retry = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 5,
    operationId: 'after-approval',
    resourcePath: target
  })

  assert.equal(retry.allowed, true)
})

test('write issuance rejects non-text, scope escape, wrong actor, stale account, and revoked receipt', () => {
  const { account, authority, paths } = harness()
  const target = join(paths.workspaceRoot, 'answer.txt')
  const danglingLink = join(paths.workspaceRoot, 'dangling.txt')

  symlinkSync(join(paths.root, 'outside-missing.txt'), danglingLink)

  assert.throws(
    () => authority.issueWriteGrant({ account, actor: ACTOR, resourcePath: join(paths.workspaceRoot, 'a.bin'), expiresAt: Date.now() + 10_000 }),
    /CAPABILITY_DENIED/u
  )
  assert.throws(
    () => authority.issueWriteGrant({ account, actor: ACTOR, resourcePath: join(paths.root, 'outside.txt'), expiresAt: Date.now() + 10_000 }),
    /capability_scope_escape/u
  )
  assert.throws(
    () => authority.issueWriteGrant({ account, actor: ACTOR, resourcePath: danglingLink, expiresAt: Date.now() + 10_000 }),
    /capability_scope_escape/u
  )

  authority.issueWriteGrant({ account, actor: ACTOR, resourcePath: target, expiresAt: Date.now() + 10_000 })

  const decision = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: 1,
    operationId: 'receipt',
    resourcePath: target
  })

  assert.equal(decision.allowed, true)
  authority.revokeAccount(account)
  assert.deepEqual(
    authority.consumeWriteReceipt({
      account,
      actor: ACTOR,
      operationId: 'receipt',
      receiptId: decision.allowed ? decision.writeReceiptId! : ''
    }),
    { code: 'CAPABILITY_REPLAYED' }
  )
})

test('independent write decisions do not revoke each other receipts', () => {
  const { account, authority, paths } = harness()
  const operations = ['parallel-a', 'parallel-b'] as const

  const receipts = operations.map(operationId => {
    const resourcePath = join(paths.workspaceRoot, `${operationId}.txt`)
    authority.issueWriteGrant({
      account,
      actor: ACTOR,
      resourcePath,
      expiresAt: Date.now() + 10_000
    })

    const decision = authority.decide({
      account,
      actor: ACTOR,
      capability: 'filesystem.write',
      contentByteSize: 1,
      operationId,
      resourcePath
    })

    assert.equal(decision.allowed, true)

    return { operationId, resourcePath, receiptId: decision.allowed ? decision.writeReceiptId! : '' }
  })

  for (const receipt of receipts) {
    const consumed = authority.consumeWriteReceipt({ account, actor: ACTOR, ...receipt })
    assert.equal('canonicalPath' in consumed, true)
  }
})

test('canonical scope rejects traversal, symlink escapes and swaps, and changed or deleted roots', () => {
  const { account, authority, paths } = harness()
  const outside = join(paths.root, '..', 'outside.txt')
  const inside = join(paths.workspaceRoot, 'inside.txt')
  const link = join(paths.workspaceRoot, 'link.txt')
  writeFileSync(outside, 'outside')
  writeFileSync(inside, 'inside')
  symlinkSync(outside, link)

  assert.deepEqual(decide(authority, account, join(paths.workspaceRoot, '..', 'outside.txt'), 'traversal'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })
  assert.deepEqual(decide(authority, account, link, 'symlink'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })

  rmSync(link)
  writeFileSync(link, 'safe')
  assert.equal(decide(authority, account, link, 'before-swap').allowed, true)
  rmSync(link)
  symlinkSync(outside, link)
  assert.deepEqual(decide(authority, account, link, 'after-swap'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })

  if (process.platform === 'darwin') {
    const unicode = join(paths.workspaceRoot, 'café.txt')
    writeFileSync(unicode, 'unicode')
    assert.equal(decide(authority, account, join(paths.workspaceRoot, 'cafe\u0301.txt'), 'unicode').allowed, true)
  }

  const renamed = `${paths.workspaceRoot}-renamed`
  renameSync(paths.workspaceRoot, renamed)
  assert.deepEqual(decide(authority, account, join(renamed, 'inside.txt'), 'renamed-root'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })
  rmSync(renamed, { recursive: true })
  assert.deepEqual(decide(authority, account, join(paths.workspaceRoot, 'inside.txt'), 'deleted-root'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })
})

test('opaque renderer intent reads once, rejects scope escape and becomes stale across account switch', () => {
  const { account, authority, paths, roots } = harness()
  writeFileSync(join(paths.workspaceRoot, 'hello.txt'), 'xin chào')
  const intent = authority.issueRendererIntent({ account, rootPath: paths.workspaceRoot })

  assert.equal(Object.values(intent).includes(paths.workspaceRoot), false)
  assert.deepEqual(authority.readRendererIntent(intent.intentId, 'hello.txt'), {
    byteSize: Buffer.byteLength('xin chào'),
    text: 'xin chào',
    truncated: false
  })
  assert.throws(() => authority.readRendererIntent(intent.intentId, 'hello.txt'), /CAPABILITY_REPLAYED/u)

  const escaping = authority.issueRendererIntent({ account, rootPath: paths.workspaceRoot })
  assert.throws(() => authority.readRendererIntent(escaping.intentId, '../outside.txt'), /CAPABILITY_SCOPE_ESCAPE/u)

  const stale = authority.issueRendererIntent({ account, rootPath: paths.workspaceRoot })
  authority.revokeAccount(account)
  const pathsB = roots.prepare(ACCOUNT_B)
  roots.commit(ACCOUNT_B, 5)
  authority.activateAccount({ accountId: ACCOUNT_B, generation: 5, paths: pathsB })
  assert.throws(() => authority.readRendererIntent(stale.intentId, 'hello.txt'), /CAPABILITY_REPLAYED/u)
})

test('renderer intent grant cannot widen the standing backend actor grant', () => {
  const { account, authority, paths } = harness()
  const outsideRoot = mkdtempSync(join(tmpdir(), 'atum-renderer-intent-root-'))
  cleanups.push(outsideRoot)
  const outsideFile = join(outsideRoot, 'picked.txt')
  writeFileSync(outsideFile, 'picked')
  const intent = authority.issueRendererIntent({ account, rootPath: outsideRoot })

  assert.deepEqual(decide(authority, account, outsideFile, 'backend-cannot-inherit'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })
  assert.equal(authority.readRendererIntent(intent.intentId, 'picked.txt').text, 'picked')
  assert.deepEqual(decide(authority, account, outsideFile, 'intent-was-revoked'), {
    allowed: false,
    code: 'CAPABILITY_SCOPE_ESCAPE'
  })
})

test('revocation remains authoritative when audit append fails', () => {
  const { account, authority, paths } = harness(ACCOUNT_A, 4, {
    appendAudit: (file, data, options) => {
      if (String(data).includes('"event":"revoke"')) {
        throw new Error('audit disk unavailable')
      }

      appendFileSync(file, data, options)
    }
  })

  const file = join(paths.workspaceRoot, 'still-denied.txt')
  writeFileSync(file, 'deny')

  authority.revokeAccount(account)

  assert.equal(authority.currentAuthority(), null)
  assert.deepEqual(decide(authority, account, file, 'after-audit-failure'), {
    allowed: false,
    code: 'CAPABILITY_REVOKED'
  })
})

test('audit is private, account scoped, and contains no raw account, path, content, or opaque token', () => {
  const { account, authority, grant, paths } = harness()
  const secretContent = 'never-log-file-content'
  const file = join(paths.workspaceRoot, 'private-name.txt')
  writeFileSync(file, secretContent)
  decide(authority, account, file, 'audit-operation')
  authority.issueWriteGrant({
    account,
    actor: ACTOR,
    resourcePath: file,
    expiresAt: Date.now() + 10_000
  })

  const writeDecision = authority.decide({
    account,
    actor: ACTOR,
    capability: 'filesystem.write',
    contentByteSize: Buffer.byteLength(secretContent),
    operationId: 'audit-write',
    resourcePath: file
  })

  assert.equal(writeDecision.allowed, true)
  authority.consumeWriteReceipt({
    account,
    actor: ACTOR,
    operationId: 'audit-write',
    receiptId: writeDecision.allowed ? writeDecision.writeReceiptId! : ''
  })
  authority.revoke(grant.grantId)

  const audit = readFileSync(paths.capabilityAuditLog, 'utf8')
  assert.equal(audit.includes(ACCOUNT_A), false)
  assert.equal(audit.includes(paths.workspaceRoot), false)
  assert.equal(audit.includes('private-name.txt'), false)
  assert.equal(audit.includes(secretContent), false)
  assert.equal(audit.includes(grant.grantId), false)
  assert.match(audit, /"event":"allow"/u)
  assert.match(audit, /"reason":"completed"/u)
  assert.match(audit, /"event":"revoke"/u)
  assert.equal(statSync(paths.capabilityAuditLog).mode & 0o777, 0o600)
  assert.equal(lstatSync(join(paths.root, 'audit')).mode & 0o777, 0o700)
})

test('authenticated loopback broker binds current authority and denies invalid bearer and stale envelopes', async () => {
  const { account, authority, paths } = harness()
  const file = join(paths.workspaceRoot, 'broker.txt')
  writeFileSync(file, 'broker')
  const broker = new AtumFilesystemActionBroker(authority)
  await broker.start()

  try {
    const environment = broker.backendEnvironment()
    const baseUrl = environment.ATUM_FILESYSTEM_BROKER_URL
    const token = environment.ATUM_FILESYSTEM_BROKER_TOKEN

    const denied = await fetch(`${baseUrl}/v1/filesystem/authority`, {
      headers: { authorization: 'Bearer wrong' }
    })

    assert.equal(denied.status, 401)

    const authorityResponse = await fetch(`${baseUrl}/v1/filesystem/authority`, {
      headers: { authorization: `Bearer ${token}` }
    })

    assert.equal(authorityResponse.status, 200)
    assert.deepEqual(await authorityResponse.json(), { account, actor: ACTOR })

    const allowed = await fetch(`${baseUrl}/v1/filesystem/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account,
        actor: ACTOR,
        capability: 'filesystem.read',
        operationId: 'http-allow',
        resourcePath: file
      })
    })

    assert.equal((await allowed.json() as { allowed: boolean }).allowed, true)

    const stale = await fetch(`${baseUrl}/v1/filesystem/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { ...account, accountGeneration: 3 },
        actor: ACTOR,
        capability: 'filesystem.read',
        operationId: 'http-stale',
        resourcePath: file
      })
    })

    assert.deepEqual(await stale.json(), { allowed: false, code: 'CAPABILITY_STALE' })
  } finally {
    await broker.stop()
  }
})

test('broker describes an interaction for the Hermes card, then leases only a Hermes-approved operation', async () => {
  const { account, authority, paths } = harness()
  const interaction = new AtumInteractionCapabilityAuthority({ now: () => 1_800_000_000_000 })
  interaction.activateAccount({ accountId: ACCOUNT_A, generation: 4, paths })
  const broker = new AtumFilesystemActionBroker(authority, undefined, interaction)
  await broker.start()

  try {
    const environment = broker.backendEnvironment()

    const headers = {
      authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`,
      'content-type': 'application/json'
    }

    const describeBody = {
      account,
      actor: ACTOR,
      runtimeSessionId: 'session-http',
      toolName: 'browser_navigate',
      toolArgs: { url: 'https://example.com/private?token=secret' }
    }

    const describedResponse = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/describe`, {
      method: 'POST', headers, body: JSON.stringify(describeBody)
    })

    const described = await describedResponse.json() as any
    assert.equal(describedResponse.status, 200)
    assert.equal(described.ok, true)
    assert.equal(described.consent, 'browser')
    assert.equal(described.ruleKey, `atum:${paths.accountKey}:browser`)
    assert.equal(described.intendedEffect, 'Open https://example.com')
    assert.equal(JSON.stringify(described).includes(ACCOUNT_A), false)
    assert.equal(JSON.stringify(described).includes('token=secret'), false)
    assert.deepEqual(interaction.listGrants(), [])

    const body = { ...describeBody, operationId: 'browser-request', durationMs: 120_000 }

    const unapproved = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/request-use`, {
      method: 'POST', headers, body: JSON.stringify(body)
    })

    assert.deepEqual(await unapproved.json(), {
      allowed: false,
      code: 'CAPABILITY_DENIED',
      rendererMessage: 'This action needs your permission before it can run.'
    })

    const startedResponse = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/request-use`, {
      method: 'POST', headers, body: JSON.stringify({ ...body, approval: { authority: 'hermes' } })
    })

    const started = await startedResponse.json() as any
    assert.equal(started.allowed, true)
    assert.equal(started.operationId, 'browser-request')
    interaction.revoke(started.grantId)

    const finished = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/finish-use`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: 'browser-request',
        runtimeSessionId: 'session-http',
        completedOperation: true
      })
    })

    assert.deepEqual(await finished.json(), {
      allowed: false,
      code: 'CAPABILITY_REVOKED',
      safeBoundary: 'partial_effects',
      completedOperation: true,
      rendererMessage:
        'Permission was revoked while the action was running. The operation reported completion before it stopped.'
    })

    const spoofed = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/request-use`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, approval: { authority: 'hermes' }, account: { ...account, accountGeneration: 3 } })
    })

    assert.equal(spoofed.status, 400)

    const spoofedDescribe = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/interaction/describe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...describeBody, actor: { kind: 'conversation', conversationId: 'thread' } })
    })

    assert.equal(spoofedDescribe.status, 400)
  } finally {
    await broker.stop()
  }
})

test('broker describes a workspace write for the Hermes card and performs only a Hermes-approved write', async () => {
  const { account, authority, paths } = harness()
  const target = join(paths.workspaceRoot, 'answer.txt')
  const requests: unknown[] = []

  const assistantWrites = {
    requestWrite: async (input: unknown) => {
      const { abortSignal: _abortSignal, ...request } = input as Record<string, unknown>
      requests.push(request)

      return {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'opaque-write-http', displayName: 'answer.txt' }
      } as const
    },
    trackReceipt: () => undefined,
    complete: () => undefined
  }

  const broker = new AtumFilesystemActionBroker(authority, assistantWrites)

  await broker.start()

  try {
    const environment = broker.backendEnvironment()

    const headers = {
      authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`,
      'content-type': 'application/json'
    }

    const described = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/describe-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        contentByteSize: 2,
        operationId: 'write-http',
        resourcePath: target,
        sessionId: 'session-http'
      })
    })

    assert.equal(described.status, 200)
    assert.deepEqual(await described.json(), {
      ok: true,
      version: 1,
      consent: 'workspace.write',
      ruleKey: `atum:${paths.accountKey}:workspace.write`,
      intendedEffect: 'Create answer.txt (2 B) in your workspace',
      workspaceRelativePath: 'answer.txt',
      disposition: 'create',
      byteSize: 2,
      existingByteSize: 0
    })

    const outside = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/describe-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        contentByteSize: 2,
        operationId: 'outside-http',
        resourcePath: join(paths.root, 'outside.txt'),
        sessionId: 'session-http'
      })
    })

    assert.deepEqual(await outside.json(), { ok: false, code: 'CAPABILITY_SCOPE_ESCAPE' })

    const binary = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/describe-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        contentByteSize: 2,
        operationId: 'binary-http',
        resourcePath: join(paths.workspaceRoot, 'blob.bin'),
        sessionId: 'session-http'
      })
    })

    assert.deepEqual(await binary.json(), { ok: false, code: 'CAPABILITY_UNSUPPORTED_TYPE' })

    const staleDescribe = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/describe-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account: { ...account, accountGeneration: account.accountGeneration - 1 },
        actor: ACTOR,
        contentByteSize: 2,
        operationId: 'stale-describe',
        resourcePath: target,
        sessionId: 'session-http'
      })
    })

    assert.equal(staleDescribe.status, 400)

    const spoofedBearer = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer renderer-spoof' },
      body: JSON.stringify({})
    })

    assert.equal(spoofedBearer.status, 401)

    const staleWrite = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account: { ...account, accountGeneration: account.accountGeneration - 1 },
        actor: ACTOR,
        approval: { authority: 'hermes' },
        content: 'ok',
        operationId: 'stale-write',
        resourcePath: target,
        sessionId: 'session-stale'
      })
    })

    assert.equal(staleWrite.status, 400)

    const missingSession = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        approval: { authority: 'hermes' },
        content: 'ok',
        operationId: 'missing-session',
        resourcePath: target,
        sessionId: ''
      })
    })

    assert.equal(missingSession.status, 400)

    const unapproved = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        content: 'ok',
        operationId: 'unapproved-write',
        resourcePath: target,
        sessionId: 'session-http'
      })
    })

    assert.equal(unapproved.status, 403)
    assert.deepEqual(await unapproved.json(), { ok: false, code: 'CAPABILITY_DENIED' })
    assert.deepEqual(requests, [])

    const approved = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        approval: { authority: 'hermes' },
        content: 'ok',
        operationId: 'write-http',
        resourcePath: target,
        sessionId: 'session-http'
      })
    })

    assert.equal(approved.status, 200)
    assert.deepEqual(await approved.json(), { ok: true })

    // The write carries the agent the credential was issued to, not anything
    // the caller claimed.
    assert.deepEqual(requests, [{
      account,
      actor: ACTOR,
      agentId: 'default',
      content: 'ok',
      operationId: 'write-http',
      resourcePath: target,
      sessionId: 'session-http'
    }])

    const bearerDecision = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/decide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account,
        actor: ACTOR,
        capability: 'filesystem.write',
        contentByteSize: 2,
        operationId: 'bearer-cannot-write',
        resourcePath: target,
        sessionId: 'session-http'
      })
    })

    assert.deepEqual(await bearerDecision.json(), { allowed: false, code: 'CAPABILITY_DENIED' })
  } finally {
    await broker.stop()
  }
})

test('request-write reports the closed failure when trusted main cannot perform the approved write', async () => {
  const { account, authority, paths } = harness()

  const broker = new AtumFilesystemActionBroker(
    authority,
    {
      requestWrite: async () => ({
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'conflict',
        retryable: true,
        rendererMessage: 'The file changed before the write completed.'
      })
    }
  )

  await broker.start()

  try {
    const environment = broker.backendEnvironment()

    const response = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        account,
        actor: ACTOR,
        approval: { authority: 'hermes' },
        content: 'must not land',
        operationId: 'denied-write-http',
        resourcePath: join(paths.workspaceRoot, 'denied-write-http.txt'),
        sessionId: 'session-denied-http'
      })
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      ok: false,
      code: 'CAPABILITY_DENIED',
      rendererMessage: 'The file changed before the write completed.'
    })
  } finally {
    await broker.stop()
  }
})

test('broker startup failure environment keeps the mandatory marker without credentials', () => {
  const { authority } = harness()
  const environment = new AtumFilesystemActionBroker(authority).backendEnvironment()

  assert.deepEqual(environment, { ATUM_FILESYSTEM_CAPABILITY_REQUIRED: '1' })
})

test('request-write rejects when trusted main configured no write provider', async () => {
  const { account, authority, paths } = harness()
  const broker = new AtumFilesystemActionBroker(authority)

  await broker.start()

  try {
    const environment = broker.backendEnvironment()

    const response = await fetch(`${environment.ATUM_FILESYSTEM_BROKER_URL}/v1/filesystem/request-write`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.ATUM_FILESYSTEM_BROKER_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        account,
        actor: ACTOR,
        approval: { authority: 'hermes' },
        content: 'blocked',
        operationId: 'no-provider',
        resourcePath: join(paths.workspaceRoot, 'no-provider.txt'),
        sessionId: 'session-no-provider'
      })
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { ok: false, code: 'CAPABILITY_DENIED' })
  } finally {
    await broker.stop()
  }
})
