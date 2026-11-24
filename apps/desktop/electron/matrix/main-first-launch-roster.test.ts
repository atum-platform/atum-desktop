import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { matrixAssistantSetupRosterRetry, matrixAssistantSetupRunsLocally } from './assistant-setup'

// Run main's real setup ordering with only account/host I/O replaced.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function mainFunction(name: string, context: Record<string, unknown>) {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  return runInNewContext(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText, context)
}

function setupFixture() {
  const enroll = vi.fn()
  const startHost = vi.fn()
  let resolve!: () => void
  const delayed = new Promise<void>(done => { resolve = done })
  const context: Record<string, unknown> = {
    account: { enrollment: () => ({ state: 'absent' }), appScope: () => ({}), readDomain: vi.fn(async () => {}), enrollHermes: enroll },
    config: { domain: {} }, closing: false, defaultAgent: {},
    isCloudOnlyAgent: () => false, isMovingAgent: () => false,
    matrixEnrollmentAuthority: () => ({ ok: true }), unusedRoot: () => false,
    agentPlacementKnown: () => false, agentRoster: { request: vi.fn() },
    assistantSetup: undefined, assistantSetupState: undefined, assistantSetupRetryAt: undefined, startupState: undefined,
    matrixAssistantSetupRosterRetry, matrixAssistantSetupRunsLocally, publish: vi.fn(), state: {},
    startHost, Date, console,
    syncAgents: vi.fn(async () => {
      await delayed
      context.agentPlacementKnown = () => true
      context.isCloudOnlyAgent = () => true
    })
  }
  return { context, enroll, startHost, resolve }
}

describe('cold-start placement before local enrollment', () => {
  it('does not enroll or show setup while the authenticated roster is delayed, then accepts cloud placement', async () => {
    const f = setupFixture()
    const pending = mainFunction('setUpAssistant', f.context)(false)
    await Promise.resolve()
    expect(f.enroll).not.toHaveBeenCalled()
    expect(f.context.assistantSetupState).toBeUndefined()
    f.resolve()
    await pending
    expect(f.enroll).not.toHaveBeenCalled()
    expect(f.startHost).not.toHaveBeenCalled()
    expect(f.context.assistantSetupState).toBeUndefined()
  })

  it('leaves failed roster discovery pending for retry, never missing setup', async () => {
    const f = setupFixture()
    f.context.syncAgents = async () => ({ ok: false, code: 'agent_roster_unavailable' })
    await mainFunction('setUpAssistant', f.context)(false)
    expect(f.enroll).not.toHaveBeenCalled()
    expect(f.context.assistantSetupState).toBeUndefined()
    expect(f.context.assistantSetupRetryAt).toBeGreaterThan(Date.now())
  })
})

it('requires the hub only for authenticated legacy roster agents, including mixed accounts', () => {
  const scope = { accountKey: 'owner', generation: 1 }
  const context = { account: { appScope: () => scope }, hireRoster: undefined as unknown }
  const required = mainFunction('controllerHubRequired', context)
  expect(required()).toBe(false)
  context.hireRoster = { scope, roster: [{ status: 'active', runtime: 'hermes' }] }
  expect(required()).toBe(false)
  context.hireRoster = { scope, roster: [{ status: 'active', runtime: 'hermes' }, { status: 'active', answering: 'cloud' }] }
  expect(required()).toBe(true)
  context.hireRoster = { scope: { ...scope, generation: 0 }, roster: [{ status: 'active' }] }
  expect(required()).toBe(false)
})
