import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Follow existing main callback tests, executing the committed dispatcher without Electron.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'cloudAgentRequest')!
const code = ts.transpileModule(`(${declaration.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
const principal = '00000000-0000-4000-8000-159badba71cd'
const request = { action: 'stopTurn', roomId: '!room:test', eventId: '$source' }
function fixture(host: boolean, answering: boolean, domain = true) {
  const scope = { accountKey: 'owner', generation: 1 }
  const fetcher = vi.fn()
  const requestHostStop = vi.fn(async () => ({ state: 'stop_requested' }))
  const stopCloudTurn = vi.fn(async () => ({ state: 'stop_requested' }))
  const s1Request = vi.fn(async (work: (token: string, base: string, signal: AbortSignal) => Promise<unknown>) => work('synthetic-grant', 'https://shell.test/api/matrix/v1', AbortSignal.timeout(30_000)))
  const run = runInNewContext(code, {
    account: { appScope: () => scope, s1Request }, closing: false,
    requireRoomAgent: () => ({}), cloudPrincipal: () => principal, isCloudAgent: () => answering,
    hostRuntimeAgents: new Set(host ? [principal] : []), config: { domain: domain ? { resource: 'https://shell.test/api/matrix/v1' } : undefined },
    requestHostStop, stopCloudTurn, s1Call: vi.fn(), session: { defaultSession: { fetch: fetcher } }, AbortSignal, Error
  })
  return { run, s1Request, requestHostStop, stopCloudTurn }
}
describe('main host Stop dispatch', () => {
  it.each([true, false])('uses account domain grant for Hermes with legacy cloud answering %s', async answering => {
    const f = fixture(true, answering)
    await f.run(request)
    expect(f.s1Request).toHaveBeenCalledOnce()
    expect(f.requestHostStop).toHaveBeenCalledWith('https://shell.test/api/matrix/v1', 'synthetic-grant', principal, request.roomId, request.eventId, expect.any(AbortSignal), expect.any(Function))
    expect(f.stopCloudTurn).not.toHaveBeenCalled()
  })
  it('retains the legacy cloud Stop path', async () => {
    const f = fixture(false, true)
    await f.run(request)
    expect(f.stopCloudTurn).toHaveBeenCalledOnce()
    expect(f.s1Request).not.toHaveBeenCalled()
  })
  it('refuses a legacy local agent', async () => {
    await expect(fixture(false, false).run(request)).rejects.toThrow('matrix_agent_unavailable')
  })
  it('requires configured domain for host Stop', async () => {
    await expect(fixture(true, false, false).run(request)).rejects.toThrow('matrix_not_ready')
  })
})
