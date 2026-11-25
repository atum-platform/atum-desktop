import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { expect, it, vi } from 'vitest'

// Run main's startup callback with account and SDK I/O replaced.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function mainFunction(name: string, context: Record<string, unknown>) {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  return runInNewContext(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText, context)
}

it('starts the owner SDK and waits for the authenticated roster', async () => {
  const hosts = new Map()
  const startHost = vi.fn(async (role: string) => {hosts.set(role, {})})
  const setAgentRosterReadiness = vi.fn()
  const request = vi.fn()
  const accountReady = vi.fn(async () => {})
  let finishRoster!: () => void
  const syncAgents = vi.fn(async () => new Promise<void>(resolve => {finishRoster = resolve}))
  const start = mainFunction('startSdk', {
    account: { identity: () => ({}), appScope: () => ({}), sessionEnded: () => false, signOutPending: () => false },
    agentRoster: { request },
    cloudEnrollments: undefined,
    config: { domain: {} },
    deviceBootstrap: { accountReady },
    deviceLaunch: 'interactive',
    hosts,
    publish: vi.fn(),
    setAgentRosterReadiness,
    startHost,
    state: {},
    syncAgents
  })

  const pending = start()
  const finished = vi.fn()
  void pending.then(finished)
  await vi.waitFor(() => expect(syncAgents).toHaveBeenCalledOnce())
  expect(startHost).toHaveBeenCalledExactlyOnceWith('human')
  expect(accountReady).toHaveBeenCalledExactlyOnceWith('interactive')
  expect(setAgentRosterReadiness).toHaveBeenCalledExactlyOnceWith('loading')
  expect(request).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  finishRoster()
  await pending
  expect(finished).toHaveBeenCalledOnce()
})

it('requires the hub only for authenticated legacy roster agents, including mixed accounts', () => {
  const scope = { accountKey: 'owner', generation: 1 }
  const context = { account: { appScope: () => scope }, hireRoster: undefined as unknown }
  const required = mainFunction('controllerHubRequired', context)
  // Unknown placement is distinct from a confirmed roster with no legacy agents.
  expect(required()).toBeUndefined()
  context.hireRoster = { scope, roster: [{ status: 'active', runtime: 'hermes' }] }
  expect(required()).toBe(false)
  context.hireRoster = { scope, roster: [{ status: 'active', runtime: 'hermes' }, { status: 'active', answering: 'cloud' }] }
  expect(required()).toBe(true)
  context.hireRoster = { scope: { ...scope, generation: 0 }, roster: [{ status: 'active' }] }
  expect(required()).toBeUndefined()
})
