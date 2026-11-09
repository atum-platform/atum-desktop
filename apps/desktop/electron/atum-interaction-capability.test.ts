import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { InteractionCapabilityEvent } from '../shared/atum-interaction-capability'

import {
  DEFAULT_PERSONAL_AGENT_ID,
  type FilesystemAccountEnvelope,
  type FilesystemCapabilityActor
} from './atum-filesystem-capability'
import {
  AtumInteractionCapabilityAuthority,
  type InteractionCapabilityDescribeResult,
  type InteractionCapabilityUseDecision,
  type InteractionCapabilityUseInput
} from './atum-interaction-capability'
import { AccountRootAuthority } from './atum-messaging'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'

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

function harness(now = 1_800_000_000_000) {
  const userData = mkdtempSync(join(tmpdir(), 'atum-interaction-capability-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 7)
  let clock = now
  const authority = new AtumInteractionCapabilityAuthority({ now: () => clock })
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 7, paths })
  const account: FilesystemAccountEnvelope = { accountId: ACCOUNT_A, accountGeneration: 7 }
  const events: InteractionCapabilityEvent[] = []
  authority.subscribe(event => events.push(event))

  return { account, authority, events, paths, roots, setNow: (value: number) => (clock = value) }
}

function requestInput(
  account: FilesystemAccountEnvelope,
  input: Partial<InteractionCapabilityUseInput> = {}
): InteractionCapabilityUseInput {
  return {
    account,
    actor: ACTOR,
    operationId: 'operation-1',
    runtimeSessionId: 'session-1',
    toolName: 'browser_navigate',
    toolArgs: { url: 'https://example.com/path?secret=hidden' },
    durationMs: 120_000,
    approval: HERMES,
    ...input
  }
}

function expectDenied(decision: InteractionCapabilityUseDecision) {
  assert.equal(decision.allowed, false)

  return decision as Extract<InteractionCapabilityUseDecision, { allowed: false }>
}

function expectAllowed(decision: InteractionCapabilityUseDecision) {
  assert.equal(decision.allowed, true)

  return decision as Extract<InteractionCapabilityUseDecision, { allowed: true }>
}

function expectDescribed(result: InteractionCapabilityDescribeResult) {
  assert.equal(result.ok, true)

  return result as Extract<InteractionCapabilityDescribeResult, { ok: true }>
}

function expectUndescribed(result: InteractionCapabilityDescribeResult) {
  assert.equal(result.ok, false)

  return result as Extract<InteractionCapabilityDescribeResult, { ok: false }>
}

test('revocation without an active interaction account is an idempotent close', () => {
  const authority = new AtumInteractionCapabilityAuthority()

  assert.doesNotThrow(() => authority.revokeAccount({ accountId: ACCOUNT_A, accountGeneration: 1 }))
})

test('describe is pure: it names the consent and stable account-scoped rule key without minting or leaking detail', () => {
  const { account, authority, events, paths } = harness()
  const described = expectDescribed(authority.describe(requestInput(account)))

  assert.deepEqual(described, {
    ok: true,
    version: 1,
    capability: 'browser.navigate',
    intendedEffect: 'Open https://example.com',
    scope: { kind: 'browser-origin', origin: 'https://example.com', workspaceId: paths.accountKey },
    consent: 'browser',
    ruleKey: `atum:${paths.accountKey}:browser`
  })
  assert.equal(JSON.stringify(described).includes(ACCOUNT_A), false)
  assert.equal(JSON.stringify(described).includes(paths.workspaceRoot), false)
  assert.equal(JSON.stringify(described).includes('secret=hidden'), false)
  assert.deepEqual(authority.listGrants(), [])
  assert.deepEqual(events, [])

  // Describing again is idempotent and the key is stable across operations and sessions.
  const again = expectDescribed(
    authority.describe(requestInput(account, { runtimeSessionId: 'session-2', toolArgs: { url: 'https://other.example/x' } }))
  )

  assert.equal(again.ruleKey, described.ruleKey)
  assert.equal(again.intendedEffect, 'Open https://other.example')
})

test('web search, web extract, navigation, and every other browser tool share the browser consent', () => {
  const { account, authority, paths } = harness()
  const browserKey = `atum:${paths.accountKey}:browser`

  const search = expectDescribed(
    authority.describe(requestInput(account, { toolName: 'web_search', toolArgs: { query: 'private query text' } }))
  )

  assert.equal(search.capability, 'browser.navigate')
  assert.deepEqual(search.scope, { kind: 'public-web', mode: 'search', workspaceId: paths.accountKey })
  assert.equal(search.ruleKey, browserKey)
  assert.equal(JSON.stringify(search).includes('private query text'), false)

  const extract = expectDescribed(
    authority.describe(
      requestInput(account, {
        toolName: 'web_extract',
        toolArgs: { urls: ['https://example.com/private?secret=hidden', 'https://docs.example.org/guide'] }
      })
    )
  )

  assert.equal(extract.intendedEffect, 'Read 2 public web pages')
  assert.deepEqual(extract.scope, { kind: 'public-web', mode: 'read', workspaceId: paths.accountKey })
  assert.equal(extract.ruleKey, browserKey)
  assert.equal(JSON.stringify(extract).includes('secret=hidden'), false)

  assert.equal(
    expectDescribed(
      authority.describe(requestInput(account, { toolName: 'web_extract', toolArgs: { urls: [{ url: 'https://example.net/r' }] } }))
    ).intendedEffect,
    'Read a public web page'
  )
  assert.equal(
    expectDescribed(
      authority.describe(requestInput(account, { toolName: 'web_extract', toolArgs: { urls: [{ href: 'https://docs.example.net/r' }] } }))
    ).intendedEffect,
    'Read a public web page'
  )
  assert.equal(
    expectDescribed(
      authority.describe(
        requestInput(account, {
          toolName: 'web_extract',
          toolArgs: { urls: Array.from({ length: 6 }, (_, index) => `https://example.com/page-${index + 1}`) }
        })
      )
    ).intendedEffect,
    'Read 5 public web pages'
  )

  for (const toolName of ['browser_click', 'browser_type', 'browser_screenshot', 'browser_scroll']) {
    const interact = expectDescribed(authority.describe(requestInput(account, { toolName, toolArgs: { selector: '#x' } })))
    assert.equal(interact.capability, 'browser.interact')
    assert.equal(interact.consent, 'browser')
    assert.equal(interact.ruleKey, browserKey)
    assert.deepEqual(interact.scope, { kind: 'public-web', mode: 'interact', workspaceId: paths.accountKey })
  }

  assert.equal(
    expectDescribed(authority.describe(requestInput(account, { toolName: 'browser_click', toolArgs: {} }))).intendedEffect,
    'Use the browser (click)'
  )
})

test('malformed, stale, spoofed, and unsupported operations are not described and never lease', () => {
  const { account, authority } = harness()

  assert.equal(
    expectUndescribed(authority.describe(requestInput(account, { toolArgs: { url: 'file:///private/secret' } }))).code,
    'CAPABILITY_INVALID'
  )
  assert.equal(
    expectUndescribed(authority.describe(requestInput({ accountId: ACCOUNT_B, accountGeneration: 7 }))).code,
    'CAPABILITY_STALE'
  )
  assert.equal(
    expectUndescribed(
      authority.describe(requestInput(account, { actor: { kind: 'conversation', conversationId: 'thread' } }))
    ).code,
    'CAPABILITY_INVALID'
  )

  for (const urls of [['file:///private/account/data'], [], [{ url: '   ', href: 'https://example.com' }]]) {
    assert.equal(
      expectUndescribed(authority.describe(requestInput(account, { toolName: 'web_extract', toolArgs: { urls } }))).code,
      'CAPABILITY_INVALID'
    )
  }

  for (const toolName of ['terminal', 'read_file', 'browser_', 'browser_Bad-Name', 'mcp__filesystem__read']) {
    assert.equal(expectUndescribed(authority.describe(requestInput(account, { toolName }))).code, 'CAPABILITY_INVALID')
    assert.equal(expectDenied(authority.requestUse(requestInput(account, { toolName }))).code, 'CAPABILITY_INVALID')
  }

  assert.equal(
    expectDenied(authority.requestUse(requestInput(account, { toolArgs: { url: 'file:///private/secret' } }))).code,
    'CAPABILITY_INVALID'
  )
  assert.equal(
    expectDenied(authority.requestUse(requestInput({ accountId: ACCOUNT_B, accountGeneration: 7 }))).code,
    'CAPABILITY_STALE'
  )
  assert.equal(
    expectDenied(authority.requestUse(requestInput(account, { durationMs: 10 * 60_000 }))).code,
    'CAPABILITY_INVALID'
  )
  assert.deepEqual(authority.listGrants(), [])
})

test('a lease requires the Hermes approval assertion and is bound to the exact account, session, and operation', () => {
  const { account, authority, events, paths } = harness()

  for (const approval of [undefined, null, 'hermes', { authority: 'renderer' }, ['hermes'], {}]) {
    assert.equal(expectDenied(authority.requestUse(requestInput(account, { approval }))).code, 'CAPABILITY_DENIED')
  }

  assert.deepEqual(authority.listGrants(), [])
  assert.deepEqual(events, [])

  const started = expectAllowed(authority.requestUse(requestInput(account)))
  assert.equal(started.operationId, 'operation-1')
  assert.equal(started.capability, 'browser.navigate')

  const [lease] = authority.listGrants()
  assert.ok(lease)
  assert.deepEqual(lease, {
    version: 1,
    grantId: started.grantId,
    accountSubject: paths.accountKey,
    workspaceId: paths.accountKey,
    runtimeSessionId: 'session-1',
    sourceOperationId: 'operation-1',
    capability: 'browser.navigate',
    intendedEffect: 'Open https://example.com',
    scope: { kind: 'browser-origin', origin: 'https://example.com', workspaceId: paths.accountKey },
    status: 'active',
    expiresAt: new Date(1_800_000_120_000).toISOString()
  })
  assert.equal(JSON.stringify(lease).includes('secret=hidden'), false)
  assert.equal(events[0]?.type, 'use_started')

  // The same operation cannot be leased twice while active, and another
  // session cannot settle it.
  assert.equal(expectDenied(authority.requestUse(requestInput(account))).code, 'CAPABILITY_INVALID')
  assert.equal(authority.finishUse('session-2', 'operation-1', true).allowed, false)
  assert.deepEqual(authority.finishUse('session-1', 'operation-1', true), { allowed: true })
  assert.deepEqual(authority.listGrants(), [])
  assert.equal(expectDenied(authority.requestUse(requestInput(account))).code, 'CAPABILITY_REPLAYED')
})

test('computer observe and control are separate consents and OS readiness is not treated as authority', () => {
  const { account, authority, paths } = harness()

  const observe = expectDescribed(
    authority.describe(
      requestInput(account, { toolName: 'computer_use', toolArgs: { action: 'capture', app: 'Safari\nspoofed detail' } })
    )
  )

  const control = expectDescribed(
    authority.describe(
      requestInput(account, {
        toolName: 'computer_use',
        toolArgs: { action: 'click', app: 'Safari', osPermissionGranted: true }
      })
    )
  )

  assert.equal(observe.capability, 'computer.observe')
  assert.equal(observe.consent, 'computer.observe')
  assert.equal(observe.ruleKey, `atum:${paths.accountKey}:computer.observe`)
  assert.equal(observe.intendedEffect, 'Observe Safari spoofed detail')
  assert.equal(control.capability, 'computer.control')
  assert.equal(control.consent, 'computer.control')
  assert.equal(control.ruleKey, `atum:${paths.accountKey}:computer.control`)
  assert.equal(control.intendedEffect, 'Use click in Safari')
  assert.notEqual(observe.ruleKey, control.ruleKey)
  assert.equal(JSON.stringify(control).includes('osPermissionGranted'), false)
  assert.equal(
    expectUndescribed(
      authority.describe(requestInput(account, { toolName: 'computer_use', toolArgs: { action: 'format_disk' } }))
    ).code,
    'CAPABILITY_INVALID'
  )
})

test('launch-app wording names the target and bounded launch inputs', () => {
  const { account, authority } = harness()

  const launch = expectDescribed(
    authority.describe(
      requestInput(account, {
        toolName: 'computer_use',
        toolArgs: {
          action: 'launch_app',
          bundle_id: 'com.apple.calculator',
          name: 'Calculator\nspoofed detail',
          urls: ['atum://first', 'atum://second', 'atum://not-present'],
          additional_arguments: ['--first', '--second', '--not-present'],
          creates_new_application_instance: true
        }
      })
    )
  )

  assert.equal(launch.capability, 'computer.control')
  assert.equal(
    launch.intendedEffect,
    'Launch "Calculator spoofed detail" (bundle id "com.apple.calculator"); URLs: "atum://first", "atum://second" (+1 more); arguments: "--first", "--second" (+1 more); open a new application instance'
  )
  assert.equal(launch.intendedEffect.includes('atum://not-present'), false)
  assert.equal(launch.intendedEffect.includes('--not-present'), false)
})

test('active use is visible, mid-operation revoke reports partial effects, and the finished operation cannot replay', () => {
  const { account, authority, events } = harness()

  const started = expectAllowed(
    authority.requestUse(
      requestInput(account, { operationId: 'initial-control', toolName: 'computer_use', toolArgs: { action: 'click', app: 'Notes' } })
    )
  )

  assert.equal(authority.listGrants()[0]?.status, 'active')
  const revoked = authority.revoke(started.grantId)
  assert.equal(revoked.type, 'revoked')
  assert.equal(revoked.safeBoundary, 'partial_effects')
  assert.deepEqual(authority.finishUse('session-1', 'initial-control', true), {
    allowed: false,
    code: 'CAPABILITY_REVOKED',
    safeBoundary: 'partial_effects',
    completedOperation: true,
    rendererMessage:
      'Permission was revoked while the action was running. The operation reported completion before it stopped.'
  })
  assert.throws(() => authority.revoke(started.grantId), /CAPABILITY_REVOKED/u)
  assert.equal(
    expectDenied(
      authority.requestUse(
        requestInput(account, { operationId: 'initial-control', toolName: 'computer_use', toolArgs: { action: 'click', app: 'Notes' } })
      )
    ).code,
    'CAPABILITY_REPLAYED'
  )
  assert.ok(events.some(event => event.type === 'use_started'))
  assert.ok(events.some(event => event.type === 'use_finished' && event.outcome === 'revoked'))
})

test('a lease that outlives its duration is reported as revoked at the safe boundary', () => {
  const { account, authority, setNow } = harness()
  expectAllowed(authority.requestUse(requestInput(account, { operationId: 'slow', durationMs: 1_000 })))
  setNow(1_800_000_001_001)

  const finished = authority.finishUse('session-1', 'slow', false)
  assert.equal(finished.allowed, false)
  assert.equal(finished.allowed === false && finished.safeBoundary, 'partial_effects')
})

test('account switch and restart clear live leases without crossing partitions; durable consent lives in Hermes', () => {
  const { account, authority, events, paths, roots } = harness()
  const started = expectAllowed(authority.requestUse(requestInput(account, { operationId: 'in-flight' })))

  const pathsB = roots.prepare(ACCOUNT_B)
  roots.commit(ACCOUNT_B, 8)
  authority.activateAccount({ accountId: ACCOUNT_B, generation: 8, paths: pathsB })

  assert.ok(events.some(event => event.type === 'revoked' && event.grantId === started.grantId && event.safeBoundary === 'partial_effects'))
  assert.equal(expectDenied(authority.requestUse(requestInput(account, { operationId: 'old-account' }))).code, 'CAPABILITY_STALE')
  assert.deepEqual(authority.listGrants(), [])

  const accountB: FilesystemAccountEnvelope = { accountId: ACCOUNT_B, accountGeneration: 8 }
  const describedB = expectDescribed(authority.describe(requestInput(accountB)))
  assert.equal(describedB.ruleKey, `atum:${pathsB.accountKey}:browser`)
  assert.notEqual(describedB.ruleKey, `atum:${paths.accountKey}:browser`)

  const restarted = new AtumInteractionCapabilityAuthority()
  restarted.activateAccount({ accountId: ACCOUNT_A, generation: 9, paths })
  assert.deepEqual(restarted.listGrants(), [])
  assert.equal(
    expectDescribed(restarted.describe(requestInput({ accountId: ACCOUNT_A, accountGeneration: 9 }))).ruleKey,
    `atum:${paths.accountKey}:browser`
  )
})

test('identical tool-call ids remain isolated by runtime session through the safe boundary', () => {
  const { account, authority } = harness()
  expectAllowed(authority.requestUse(requestInput(account, { operationId: 'same-call' })))
  expectAllowed(authority.requestUse(requestInput(account, { operationId: 'same-call', runtimeSessionId: 'session-2' })))

  assert.equal(authority.listGrants().length, 2)
  assert.deepEqual(authority.finishUse('session-2', 'same-call', true), { allowed: true })
  assert.deepEqual(authority.finishUse('session-1', 'same-call', true), { allowed: true })
  assert.equal(authority.finishUse('session-1', 'same-call', true).allowed, false)
})

test('account-scoped audit is durable and contains no raw account, path, origin, query, app, or authority ids', () => {
  const { account, authority, paths } = harness()

  const started = expectAllowed(
    authority.requestUse(
      requestInput(account, {
        operationId: 'private-operation',
        toolName: 'computer_use',
        toolArgs: { action: 'click', app: 'Private Customer Window' }
      })
    )
  )

  authority.revoke(started.grantId)
  authority.finishUse('session-1', 'private-operation', true)

  const audit = readFileSync(paths.capabilityAuditLog, 'utf8')
  assert.equal(audit.includes(ACCOUNT_A), false)
  assert.equal(audit.includes(paths.workspaceRoot), false)
  assert.equal(audit.includes('Private Customer Window'), false)
  assert.equal(audit.includes(started.grantId), false)
  assert.equal(audit.includes('private-operation'), false)
  assert.match(audit, /"capability":"computer.control"/u)
  assert.match(audit, /"reason":"hermes_consent"/u)
  assert.match(audit, /"event":"revoke"/u)
  assert.equal(statSync(paths.capabilityAuditLog).mode & 0o777, 0o600)
})
