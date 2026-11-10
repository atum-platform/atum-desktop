import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { ApprovalResult } from './approvals'
import type { AuditEntry } from './audit'
import { deviceFenceBeforeOperationLock } from './bootstrap'
import { argsHash, deviceMessageHash } from './canonical'
import type { DeviceExecutor, DeviceExecutorContext, ProgressOrReceipt, VerifiedExecute } from './contracts'
import type { StandingGrant } from './grants-store'
import { DeviceLedger, type LedgerStore } from './ledger'
import {
  boundedResultData,
  type DeviceInboundFrameFacts,
  DeviceService,
  type DeviceServiceDeps,
  type DeviceSessionFacts
} from './service'

const OWNER = '@owner-3f9a1c7e5b2d:atumplatform.com'
const AGENT = '@synthetic-user-0011:atumplatform.com'
const OTHER_AGENT = '@agent-other:atumplatform.com'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition never held')
    }

    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function memoryStore(): LedgerStore & { failWrites: boolean } {
  const data = new Map<string, string>()

  const store = {
    failWrites: false,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (store.failWrites) {
        throw new Error('auth_storage_write_failed')
      }

      data.set(key, value)
    }
  }

  return store
}

/** An executor whose runs the test controls: each run waits for `release` or for its abort. */
class FakeExecutor implements DeviceExecutor {
  readonly releaseGrant = vi.fn()
  readonly runs: { command: VerifiedExecute; context: DeviceExecutorContext; release: (receipt?: Partial<ProgressOrReceipt>) => void }[] = []
  hold = false

  async *run(command: VerifiedExecute, context: DeviceExecutorContext): AsyncIterable<ProgressOrReceipt> {
    let release!: (receipt?: Partial<ProgressOrReceipt>) => void
    const released = new Promise<Partial<ProgressOrReceipt> | undefined>(resolve => (release = resolve))
    this.runs.push({ command, context, release })

    if (!this.hold) {
      release()
    }

    const aborted = new Promise<'aborted'>(resolve => context.signal.addEventListener('abort', () => resolve('aborted')))
    const outcome = await Promise.race([released, aborted])

    if (outcome === 'aborted') {
      yield { kind: 'receipt', commandId: command.commandId, state: 'unknown', artifacts: [] }

      return
    }

    yield {
      kind: 'receipt',
      commandId: command.commandId,
      state: 'completed',
      artifacts: [],
      result: { exitCode: 0, data: { output: `ran ${command.tool}`, exit_code: 0 } },
      ...(outcome ?? {})
    } as ProgressOrReceipt
  }
}

function harness(overrides: Partial<DeviceServiceDeps> = {}) {
  let wall = 1_800_000_000_000
  let mono = 50_000
  const store = memoryStore()
  const ledger = new DeviceLedger(store, () => wall)
  const executor = new FakeExecutor()
  const sent: { type: string; body: Record<string, unknown> }[] = []
  const audit: Omit<AuditEntry, 'at'>[] = []
  const indicator = { grantActive: vi.fn(), firstAction: vi.fn(), grantEnded: vi.fn() }
  const standing: StandingGrant[] = []

  let approval: (input: { capability: string; target: string }) => Promise<ApprovalResult> = async () => ({
    outcome: 'approved',
    record: {} as never,
    kid: 'kid',
    sig: 'sig',
    approvalHash: 'A'.repeat(43)
  })

  const approveCalls: { capability: string; target: string; agentUserId: string }[] = []
  let signedIn = true
  const killAllGroups = vi.fn()

  const session: DeviceSessionFacts = {
    connectionId: randomUUID(),
    connectionEpoch: 12,
    localGeneration: 1,
    deviceServiceId: randomUUID(),
    enrollmentEpoch: 3,
    accountEpoch: 7
  }

  const deps: DeviceServiceDeps = {
    ledger,
    executor,
    standingGrants: { list: () => standing },
    approve: input => {
      approveCalls.push(input)

      return approval(input)
    },
    identity: () => ({ ownerUserId: OWNER, signedIn, localScopes: ['terminal', 'files', 'computer', 'send_file'], cloudAgents: [AGENT, OTHER_AGENT] }),
    originLog: () => [],
    send: async (type, body) => {
      sent.push({ type, body })

      return true
    },
    audit: { record: entry => void audit.push(entry) },
    indicator,
    killAllGroups,
    now: () => wall,
    monotonic: () => mono,
    ...overrides
  }

  const service = new DeviceService(deps)

  const frame = (type: DeviceInboundFrameFacts['type'], body: Record<string, unknown>, verdict: DeviceInboundFrameFacts['verdict'] = 'ok'): DeviceInboundFrameFacts => ({
    type,
    body,
    kid: 'controller-kid',
    verdict,
    receivedAt: mono
  })

  function grantBody(agentUserId = AGENT, overrides: Record<string, unknown> = {}) {
    return {
      grantId: randomUUID(),
      ownerUserId: OWNER,
      agentPrincipal: randomUUID(),
      agentUserId,
      invocationId: randomUUID(),
      originKind: 'other',
      originAssertionHash: null,
      writerEpoch: { leaseGeneration: 41, leaseTokenHash: 'gDY09Edy88FdgWR6miyz0BiM2JsbZurUySyPwVe3Mt4' },
      targetDeviceServiceId: session.deviceServiceId,
      enrollmentEpoch: session.enrollmentEpoch,
      accountEpoch: session.accountEpoch,
      scopes: ['terminal', 'files', 'computer', 'send_file'],
      connectionId: session.connectionId,
      issuedAt: wall,
      expiresAt: wall + 30 * 60_000,
      ...overrides
    }
  }

  function executeBody(grantId: string, seq: number, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      commandId: randomUUID(),
      grantId,
      seq,
      connectionId: session.connectionId,
      connectionEpoch: session.connectionEpoch,
      deviceServiceId: session.deviceServiceId,
      enrollmentEpoch: session.enrollmentEpoch,
      accountEpoch: session.accountEpoch,
      tool,
      toolVersion: 1,
      args,
      argsHash: argsHash(args),
      inputManifestHash: null,
      needs: [],
      proposedEffect: 'ordinary',
      admitBy: wall + 15_000,
      timeoutMs: 120_000,
      issuedAt: wall,
      ...extra
    }
  }

  async function grant(agentUserId = AGENT) {
    const body = grantBody(agentUserId)
    const [ack] = await service.frame(frame('TurnGrant', body), session)

    expect(ack.body.accepted).toBe(true)

    return body.grantId
  }

  const receipts = () => sent.filter(each => each.type === 'Receipt').map(each => each.body)

  return {
    service,
    session,
    ledger,
    store,
    executor,
    sent,
    receipts,
    audit,
    indicator,
    standing,
    approveCalls,
    killAllGroups,
    frame,
    grantBody,
    executeBody,
    grant,
    setApproval: (fn: typeof approval) => void (approval = fn),
    signOut: () => void (signedIn = false),
    advance: (ms: number) => {
      wall += ms
      mono += ms
    }
  }
}

describe('DeviceService: grants', () => {
  it('accepts a grant for a cloud agent of this owner and shows the indicator', async () => {
    const h = harness()
    const body = h.grantBody()
    const [ack] = await h.service.frame(h.frame('TurnGrant', body), h.session)

    expect(ack).toEqual({
      type: 'GrantAck',
      body: { grantId: body.grantId, accepted: true, effectiveScopes: ['terminal', 'files', 'computer', 'send_file'] }
    })
    expect(h.indicator.grantActive).toHaveBeenCalledWith(body.grantId, AGENT)
    expect(h.service.liveGrantIds()).toEqual([body.grantId])
  })

  it('refuses a grant for another owner, an unpinned key, or a signed-out Mac', async () => {
    const h = harness()
    const wrongOwner = await h.service.frame(h.frame('TurnGrant', h.grantBody(AGENT, { ownerUserId: '@mallory:example.com' })), h.session)
    expect(wrongOwner[0].body).toMatchObject({ accepted: false, refusal: 'wrong_owner' })

    const unpinned = await h.service.frame(h.frame('TurnGrant', h.grantBody(), 'unpinned_controller_key'), h.session)
    expect(unpinned[0].body).toMatchObject({ accepted: false, refusal: 'unpinned_controller_key' })

    h.signOut()
    const signedOut = await h.service.frame(h.frame('TurnGrant', h.grantBody()), h.session)
    expect(signedOut[0].body).toMatchObject({ accepted: false, refusal: 'signed_out' })
    expect(h.service.liveGrants()).toBe(false)
  })

  it('a grant ends at its expiry and the indicator goes away', async () => {
    vi.useFakeTimers()

    try {
      const h = harness()
      const grantId = await h.grant()
      vi.advanceTimersByTime(31 * 60_000)
      expect(h.indicator.grantEnded).toHaveBeenCalledWith(grantId)
      expect(h.executor.releaseGrant).toHaveBeenCalledWith(grantId)
      expect(h.service.liveGrants()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DeviceService: the admission order and the ledger', () => {
  it('admits an ordinary command, records intent before the spawn, and sends one Receipt', async () => {
    const h = harness()
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' })

    expect(await h.service.frame(h.frame('Execute', body), h.session)).toEqual([])
    await until(() => h.receipts().length === 1)

    expect(h.executor.runs).toHaveLength(1)
    expect(h.executor.runs[0].command.needs).toEqual([])
    expect(h.receipts()[0]).toMatchObject({
      commandId: body.commandId,
      commandHash: deviceMessageHash('Execute', body),
      seq: 1,
      state: 'completed',
      result: { exitCode: 0, data: { output: 'ran terminal', exit_code: 0 } }
    })
    expect(h.ledger.get(body.commandId)?.state).toBe('completed')
    expect(h.indicator.firstAction).toHaveBeenCalledTimes(1)
  })

  it('an identical re-send returns the stored Receipt and never runs twice; a different payload is a replay', async () => {
    const h = harness()
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' })
    await h.service.frame(h.frame('Execute', body), h.session)
    await until(() => h.receipts().length === 1)

    const again = await h.service.frame(h.frame('Execute', body), h.session)
    expect(again).toEqual([{ type: 'Receipt', body: h.receipts()[0] }])

    const altered = { ...body, args: { command: 'rm -rf ~' }, argsHash: argsHash({ command: 'rm -rf ~' }) }
    const replay = await h.service.frame(h.frame('Execute', altered), h.session)
    expect(replay[0].body).toMatchObject({ state: 'refused', refusal: 'replayed' })
    expect(h.executor.runs).toHaveLength(1)
    expect(h.ledger.get(body.commandId)?.commandHash).toBe(deviceMessageHash('Execute', body))
  })

  it('refuses altered arguments, a seq gap, a bad signature and an unknown grant without running', async () => {
    const h = harness()
    const grantId = await h.grant()

    const altered = { ...h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' }), argsHash: argsHash({ command: 'other' }) }
    expect((await h.service.frame(h.frame('Execute', altered), h.session))[0].body).toMatchObject({ refusal: 'args_hash_mismatch' })

    const gap = h.executeBody(grantId, 5, 'terminal', { command: 'echo hi' })
    expect((await h.service.frame(h.frame('Execute', gap), h.session))[0].body).toMatchObject({ refusal: 'seq_gap' })

    const forged = h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' })
    expect((await h.service.frame(h.frame('Execute', forged, 'bad_signature'), h.session))[0].body).toMatchObject({ refusal: 'bad_signature' })
    // An unauthenticated frame never writes the ledger.
    expect(h.ledger.get(forged.commandId)).toBeUndefined()

    const stranger = h.executeBody(randomUUID(), 1, 'terminal', { command: 'echo hi' })
    expect((await h.service.frame(h.frame('Execute', stranger), h.session))[0].body).toMatchObject({ refusal: 'stopped' })

    expect(h.executor.runs).toHaveLength(0)
  })

  it('a command whose intent cannot be persisted is refused and never spawned', async () => {
    const h = harness()
    const grantId = await h.grant()
    h.store.failWrites = true

    const body = h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' })
    const [receipt] = await h.service.frame(h.frame('Execute', body), h.session)

    expect(receipt.body).toMatchObject({ state: 'refused' })
    await flush()
    expect(h.executor.runs).toHaveLength(0)
  })

  it('a Renew extends the authority window; without it a command arriving later is refused as expired', async () => {
    const h = harness()
    const grantId = await h.grant()
    h.advance(10_000)
    // A Renew reaching more than the 15 s window ahead is ignored.
    await h.service.frame(h.frame('Renew', { grantId, until: 1_800_000_000_000 + 10_000 + 60_000 }), h.session)
    const renewUntil = 1_800_000_000_000 + 10_000 + 12_000
    await h.service.frame(h.frame('Renew', { grantId, until: renewUntil }), h.session)
    h.advance(8_000)
    expect(await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'read_file', { path: 'a' }, { admitBy: renewUntil })), h.session)).toEqual([])

    h.advance(20_000)
    const late = await h.service.frame(h.frame('Execute', h.executeBody(grantId, 2, 'read_file', { path: 'b' }, { admitBy: renewUntil + 20_000 })), h.session)
    expect(late[0].body).toMatchObject({ refusal: 'expired' })
  })

  it('caps Execute at 10 a second', async () => {
    const h = harness()
    const grantId = await h.grant()

    for (let seq = 1; seq <= 10; seq += 1) {
      expect(await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'read_file', { path: `f${seq}` })), h.session)).toEqual([])
    }

    const eleventh = await h.service.frame(h.frame('Execute', h.executeBody(grantId, 11, 'read_file', { path: 'f11' })), h.session)
    expect(eleventh[0].body).toMatchObject({ refusal: 'rate_limited' })
  })

  it('answers a StatusQuery from the ledger, and only for commands it knows', async () => {
    const h = harness()
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'echo hi' })
    await h.service.frame(h.frame('Execute', body), h.session)
    await until(() => h.receipts().length === 1)

    const status = h.service.status({ commandIds: [body.commandId, randomUUID()] })
    expect(status.receipts).toEqual([h.receipts()[0]])
  })
})

describe('DeviceService: protected capabilities', () => {
  it('asks one Touch ID for a Keychain command, then runs it with exactly that relaxation', async () => {
    const h = harness()
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'security find-generic-password -s x' }, { needs: ['keychain'], proposedEffect: 'keychain' })

    expect(await h.service.frame(h.frame('Execute', body), h.session)).toEqual([])
    await until(() => h.receipts().length === 1)

    expect(h.approveCalls).toEqual([{ commandHash: deviceMessageHash('Execute', body), capability: 'keychain', target: 'security find-generic-password -s x', agentUserId: AGENT }])
    expect(h.executor.runs[0].command.needs).toEqual(['keychain'])
    expect(h.receipts()[0]).toMatchObject({ state: 'completed', approvalHash: 'A'.repeat(43) })
  })

  it('classifies an undeclared protected effect itself (a command that did not say it needs the Keychain)', async () => {
    const h = harness()
    const grantId = await h.grant()
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'terminal', { command: 'security dump-keychain' })), h.session)
    await until(() => h.receipts().length === 1)
    expect(h.approveCalls.map(call => call.capability)).toEqual(['keychain'])
  })

  it('a denial refuses without running; after three denials it stops asking', async () => {
    const h = harness()
    h.setApproval(async () => ({ outcome: 'denied', reason: 'approval_denied' }))
    const grantId = await h.grant()

    for (let seq = 1; seq <= 3; seq += 1) {
      await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'terminal', { command: 'security dump-keychain' })), h.session)
      await until(() => h.receipts().length === seq)
    }

    expect(h.receipts().map(receipt => receipt.refusal)).toEqual(['approval_denied', 'approval_denied', 'approval_denied'])
    expect(h.ledger.get(h.receipts()[0].commandId as string)?.state).toBe('refused')

    const fourth = await h.service.frame(h.frame('Execute', h.executeBody(grantId, 4, 'terminal', { command: 'security dump-keychain' })), h.session)
    expect(fourth[0].body).toMatchObject({ refusal: 'approval_denied' })
    expect(h.approveCalls).toHaveLength(3)
    expect(h.executor.runs).toHaveLength(0)
  })

  it('an owner who is away (sheet timed out) is told so plainly, is not counted as having refused, and no second sheet is raised while away', async () => {
    const h = harness()
    h.setApproval(async () => ({ outcome: 'denied', reason: 'approval_timeout' }))
    const grantId = await h.grant()

    // Five commands while the owner is away: one sheet, five plain answers, and the floor never trips.
    for (let seq = 1; seq <= 5; seq += 1) {
      await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'terminal', { command: 'security dump-keychain' })), h.session)
      await until(() => h.receipts().length === seq)
    }

    expect(h.receipts().map(receipt => receipt.refusal)).toEqual(Array(5).fill('approval_timeout'))
    expect(h.approveCalls).toHaveLength(1)
    expect(h.executor.runs).toHaveLength(0)
  })

  it("a standing grant for this agent covers the capability; another agent's does not", async () => {
    const h = harness()
    h.standing.push({ id: 's1', capability: 'keychain', target: '*', label: '', createdAt: 0, agent: OTHER_AGENT })
    const grantId = await h.grant()
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'terminal', { command: 'security dump-keychain' })), h.session)
    await until(() => h.receipts().length === 1)
    expect(h.approveCalls).toHaveLength(1)

    h.standing.push({ id: 's2', capability: 'keychain', target: '*', label: '', createdAt: 0, agent: AGENT })
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, 2, 'terminal', { command: 'security dump-keychain' })), h.session)
    await until(() => h.receipts().length === 2)
    expect(h.approveCalls).toHaveLength(1)
    expect(h.executor.runs.map(run => run.command.needs)).toEqual([['keychain'], ['keychain']])
  })

  it('refuses a GUI action while an approval sheet is up (paused)', async () => {
    const h = harness()
    const grantId = await h.grant()
    h.service.setPaused(true)
    const [receipt] = await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'computer_use', { action: 'click', element: 3 })), h.session)
    expect(receipt.body).toMatchObject({ refusal: 'paused' })
    h.service.setPaused(false)
  })
})

// Owner decision 2026-10-20 (overrides the G0 "every protected action asks" design): agents never ask for
// routine work, and a Touch ID covers a capability for the agent's whole task, not one command.
describe('DeviceService: Touch ID only for risky things, once per task window', () => {
  /** Run one command on a grant (`seq` counts within that grant) and wait for the `total`-th Receipt. */
  const run = async (h: ReturnType<typeof harness>, grantId: string, seq: number, command: string, needs: string[] = [], total = seq) => {
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'terminal', { command }, { needs })), h.session)
    await until(() => h.receipts().length === total)
  }

  it('a package install sequence (new hosts, downloaded exec, npmrc, ssh, startup files) raises ZERO approval requests', async () => {
    const h = harness()
    const grantId = await h.grant()

    const steps: [string, string[]][] = [
      ['curl -fsSL https://brand-new-host.example/pkg.tgz -o ~/Downloads/pkg.tgz', ['network_new_host']],
      ['~/Downloads/pkg/install.sh', ['exec_downloaded', 'network_new_host']],
      ['cat ~/.npmrc && npm install --registry https://registry.example.org', ['network_new_host']],
      ['pip install --index-url https://pypi.example.net/simple left-pad', ['network_new_host']],
      ['git clone git@github.com:acme/widget.git', ['ssh_agent']],
      ['crontab -l', ['persistence']],
      ['echo export PATH=$PATH >> ~/.zshrc', ['persistence', 'other_agent_write']]
    ]

    for (const [index, [command, needs]] of steps.entries()) {
      await run(h, grantId, index + 1, command, needs)
    }

    expect(h.approveCalls).toEqual([])
    expect(h.receipts().map(receipt => receipt.state)).toEqual(steps.map(() => 'completed'))
    // The Seatbelt lifts still reach the host for the commands that name them, and it is all audited.
    expect(h.executor.runs.map(each => each.command.needs)).toContainEqual(['exec_downloaded', 'network_new_host'])
    expect(h.audit.filter(entry => entry.summary === 'policy_silent').length).toBeGreaterThanOrEqual(steps.length - 1)
  })

  it.each([
    ['sudo', 'sudo apt-get install -y jq', 'sudo ls /var'],
    ['bulk_destructive', 'rm -rf ~/Documents', 'rm -rf ~/Desktop'],
    ['keychain', 'security find-generic-password -s a', 'security find-generic-password -s b'],
    ['browser_store', 'cat ~/Library/Cookies/a', 'cat ~/Library/Cookies/b'],
    ['cloud_cli', 'aws s3 ls', 'aws ec2 describe-instances']
  ])('%s asks once; the second same-capability command in the window does not', async (capability, first, second) => {
    const h = harness()
    const grantId = await h.grant()

    await run(h, grantId, 1, first)
    expect(h.approveCalls.map(call => call.capability)).toEqual([capability])

    await run(h, grantId, 2, second)
    expect(h.approveCalls).toHaveLength(1)
    expect(h.receipts().map(receipt => receipt.state)).toEqual(['completed', 'completed'])
    // The second command still carries the capability, so the sandbox lifts exactly what it needs.
    expect(h.executor.runs[1].command.needs).toContain(capability)
    expect(h.audit.some(entry => entry.summary === 'task_window')).toBe(true)
  })

  it('the window is per agent and per capability', async () => {
    const h = harness()
    const mine = await h.grant()
    const theirs = await h.grant(OTHER_AGENT)

    await run(h, mine, 1, 'security dump-keychain')
    await run(h, mine, 2, 'cat ~/Library/Cookies/a')
    expect(h.approveCalls.map(call => call.capability)).toEqual(['keychain', 'browser_store'])

    await run(h, theirs, 1, 'security dump-keychain', [], 3)
    expect(h.approveCalls.map(call => [call.agentUserId, call.capability])).toEqual([
      [AGENT, 'keychain'],
      [AGENT, 'browser_store'],
      [OTHER_AGENT, 'keychain']
    ])
  })

  it('the window outlives the turn grant (the same task) but not 30 minutes', async () => {
    const h = harness()
    const first = await h.grant()
    await run(h, first, 1, 'security dump-keychain')
    expect(h.approveCalls).toHaveLength(1)

    h.advance(10 * 60_000)
    const nextTurn = await h.grant()
    await run(h, nextTurn, 1, 'security dump-keychain', [], 2)
    expect(h.approveCalls).toHaveLength(1)

    h.advance(21 * 60_000)
    const afterWindow = await h.grant()
    await run(h, afterWindow, 1, 'security dump-keychain', [], 3)
    expect(h.approveCalls).toHaveLength(2)
  })

  it('two commands arriving together share one sheet and one prompt-budget slot', async () => {
    const h = harness()
    let approve!: (result: ApprovalResult) => void
    h.setApproval(() => new Promise(resolve => (approve = resolve)))
    const grantId = await h.grant()

    for (let seq = 1; seq <= 5; seq += 1) {
      await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'terminal', { command: `security find-generic-password -s k${seq}` })), h.session)
    }

    await until(() => h.approveCalls.length === 1)
    await flush()
    expect(h.approveCalls).toHaveLength(1)
    approve({ outcome: 'approved', record: {} as never, kid: 'k', sig: 's', approvalHash: 'C'.repeat(43) })
    await until(() => h.receipts().length === 5)

    expect(h.receipts().map(receipt => receipt.state)).toEqual(Array(5).fill('completed'))
    expect(h.approveCalls).toHaveLength(1)
  })

  it('a denial is counted once however many commands were waiting on the sheet', async () => {
    const h = harness()
    let deny!: (result: ApprovalResult) => void
    h.setApproval(() => new Promise(resolve => (deny = resolve)))
    const grantId = await h.grant()

    for (let seq = 1; seq <= 3; seq += 1) {
      await h.service.frame(h.frame('Execute', h.executeBody(grantId, seq, 'terminal', { command: 'security dump-keychain' })), h.session)
    }

    await until(() => h.approveCalls.length === 1)
    deny({ outcome: 'denied', reason: 'approval_denied' })
    await until(() => h.receipts().length === 3)
    expect(h.receipts().map(receipt => receipt.refusal)).toEqual(['approval_denied', 'approval_denied', 'approval_denied'])

    // Three waiters, one denial: the owner is still asked on the next command.
    h.setApproval(async () => ({ outcome: 'approved', record: {} as never, kid: 'k', sig: 's', approvalHash: 'D'.repeat(43) }))
    await run(h, grantId, 4, 'security dump-keychain')
    expect(h.receipts()[3]).toMatchObject({ state: 'completed' })
  })

  it('a Stop ends the window: the next command asks again', async () => {
    const h = harness()
    const grantId = await h.grant()
    await run(h, grantId, 1, 'security dump-keychain')
    await h.service.stop('local_stop')

    const next = await h.grant()
    await run(h, next, 1, 'security dump-keychain', [], 2)
    expect(h.approveCalls).toHaveLength(2)
  })
})

describe('DeviceService: the Stop fence', () => {
  it('Stop during a command: synchronous refusal and kill, an unknown Receipt, a Stop frame, and the next turn still works', async () => {
    const h = harness()
    h.executor.hold = true
    const grantId = await h.grant()
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'terminal', { command: 'sleep 60' })), h.session)
    await until(() => h.executor.runs.length === 1)

    h.service.setPaused(true)
    const tail = h.service.stop('local_stop')
    // Before any await: the grant is gone, the groups were killed, the command's signal fired.
    expect(h.service.liveGrants()).toBe(false)
    expect(h.killAllGroups).toHaveBeenCalledTimes(1)
    expect(h.executor.runs[0].context.signal.aborted).toBe(true)
    expect(h.executor.releaseGrant).toHaveBeenCalledWith(grantId)

    const late = await h.service.frame(h.frame('Execute', h.executeBody(grantId, 2, 'terminal', { command: 'echo late' })), h.session)
    expect(late[0].body).toMatchObject({ refusal: 'stopped' })

    await tail
    await until(() => h.receipts().some(receipt => receipt.state === 'unknown'))
    expect(h.sent.find(each => each.type === 'Stop')?.body).toMatchObject({ reason: 'local_stop', grantIds: [grantId] })
    expect(h.indicator.grantEnded).toHaveBeenCalledWith(grantId)

    // The connection is still good for the next turn after a local Stop.
    h.service.setPaused(false)
    await h.grant()
  })

  it('a sign-out refused by the operation lock still kills the command, tells the controller, and leaves the next turn working (B3)', async () => {
    const h = harness()
    h.executor.hold = true
    const grantId = await h.grant()
    await h.service.frame(h.frame('Execute', h.executeBody(grantId, 1, 'terminal', { command: 'sleep 60' })), h.session)
    await until(() => h.executor.runs.length === 1)

    // Main's pre-lock fence for a sign-out, then the request is refused (`matrix_operation_pending`).
    const reason = deviceFenceBeforeOperationLock('signOut')!
    const tail = h.service.stop(reason)
    expect(h.executor.runs[0].context.signal.aborted).toBe(true)
    expect(h.service.liveGrants()).toBe(false)
    await tail

    // The controller learns why its grant ended ...
    expect(h.sent.find(each => each.type === 'Stop')?.body).toMatchObject({ grantIds: [grantId] })
    // ... and the owner, still signed in, can keep using reach-down on the same connection.
    await h.grant()
  })

  it('sign-out while the approval sheet is up: the late approval runs nothing', async () => {
    const h = harness()
    let approve!: (result: ApprovalResult) => void
    h.setApproval(() => new Promise(resolve => (approve = resolve)))
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'security dump-keychain' })
    await h.service.frame(h.frame('Execute', body), h.session)
    await until(() => h.approveCalls.length === 1)

    h.signOut()
    void h.service.stop('sign_out')
    approve({ outcome: 'approved', record: {} as never, kid: 'k', sig: 's', approvalHash: 'B'.repeat(43) })
    await until(() => h.receipts().length === 1)

    expect(h.receipts()[0]).toMatchObject({ commandId: body.commandId, state: 'refused', refusal: 'stopped' })
    expect(h.executor.runs).toHaveLength(0)
    // Sign-out ends the connection's authority: nothing more is admitted on it.
    const after = await h.service.frame(h.frame('TurnGrant', h.grantBody()), h.session)
    expect(after[0].body).toMatchObject({ accepted: false })
  })

  it('a dropped connection ends its grants but lets a running command finish into the ledger', async () => {
    const h = harness()
    h.executor.hold = true
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'terminal', { command: 'make' })
    await h.service.frame(h.frame('Execute', body), h.session)
    await until(() => h.executor.runs.length === 1)

    h.service.closed(h.session, 'drop')
    expect(h.service.liveGrants()).toBe(false)
    expect(h.executor.runs[0].context.signal.aborted).toBe(false)

    h.executor.runs[0].release()
    await until(() => h.ledger.get(body.commandId)?.state === 'completed')
    // The next connection's status exchange carries it.
    expect(h.service.status({ commandIds: [body.commandId] }).receipts[0]).toMatchObject({ state: 'completed' })
  })

  it('a Cancel for one command aborts just that command', async () => {
    const h = harness()
    h.executor.hold = true
    const grantId = await h.grant()
    const first = h.executeBody(grantId, 1, 'terminal', { command: 'sleep 60' })
    const second = h.executeBody(grantId, 2, 'terminal', { command: 'sleep 60' })
    await h.service.frame(h.frame('Execute', first), h.session)
    await h.service.frame(h.frame('Execute', second), h.session)
    await until(() => h.executor.runs.length === 2)

    await h.service.frame(h.frame('Cancel', { grantId, commandId: first.commandId, reason: 'superseded' }), h.session)
    expect(h.executor.runs[0].context.signal.aborted).toBe(true)
    expect(h.executor.runs[1].context.signal.aborted).toBe(false)
    expect(h.service.liveGrants()).toBe(true)
    h.executor.runs[1].release()
  })
})

describe('boundedResultData', () => {
  it('keeps a result signable: no fractions, no undefined, safe integers only', () => {
    expect(boundedResultData({ a: 1.5, b: undefined, c: [1, undefined, 2 ** 60], d: 'x' })).toEqual({
      a: '1.5',
      c: [1, null, String(2 ** 60)],
      d: 'x'
    })
  })

  it('cuts the longest output until the result fits, and says so', () => {
    const data = boundedResultData({ output: 'x'.repeat(2_000_000), exit_code: 0 }, 100_000) as { output: string; exit_code: number }
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(100_000)
    expect(data.output).toContain('truncated on the device')
    expect(data.exit_code).toBe(0)
  })
})

describe('workspace collection fence', () => {
  it('aborts the shared host and refuses every tool until frozen bytes exist', async () => {
    const h = harness()
    h.executor.hold = true
    const grantId = await h.grant()
    const peer = await h.grant(OTHER_AGENT)
    await h.service.frame(h.frame('Execute', h.executeBody(peer, 1, 'terminal', { command: 'echo peer' })), h.session)
    await until(() => h.executor.runs.length === 1)
    let swept!: () => void
    let copied!: () => void

    const collect = vi.fn(async () => {
      await new Promise<void>(resolve => { copied = resolve })

      return 'frozen'
    })

    const pending = h.service.collectWorkspace(grantId, h.session,
      () => new Promise<void>(resolve => { swept = resolve }), collect)

    expect(h.executor.runs[0]!.context.signal.aborted).toBe(true)
    expect(collect).not.toHaveBeenCalled()
    swept()
    await until(() => collect.mock.calls.length === 1)
    const [refused] = await h.service.frame(h.frame('Execute', h.executeBody(peer, 2, 'write_file', { path: '/tmp/file', content: 'racing' })), h.session)
    expect(refused.body.refusal).toBe('paused')
    expect(h.executor.runs).toHaveLength(1)
    copied()
    expect(await pending).toBe('frozen')
    expect(h.service.grantLive(grantId)).toBe(false)
    await h.service.frame(h.frame('Execute', h.executeBody(peer, 2, 'terminal', { command: 'echo next' })), h.session)
    await until(() => h.executor.runs.length === 2)
    await h.service.stop('local_stop')
  })

  it('never collects after a failed quiescence proof', async () => {
    const h = harness()
    const grantId = await h.grant()
    const collect = vi.fn(async () => 'unsafe')
    await expect(h.service.collectWorkspace(grantId, h.session, async () => { throw Error('sweep failed') }, collect)).rejects.toThrow('sweep failed')
    expect(collect).not.toHaveBeenCalled()
    expect(h.service.grantLive(grantId)).toBe(false)
  })

  it('Stop during quiescence or collection cannot return a publishable snapshot', async () => {
    for (const during of ['sweep', 'copy']) {
      const h = harness()
      const grantId = await h.grant()
      let release!: () => void
      const wait = () => new Promise<void>(resolve => { release = resolve })

      const collect = vi.fn(async () => { if (during === 'copy') {await wait()}

 return 'unsafe' })

      const pending = h.service.collectWorkspace(grantId, h.session,
        async () => { if (during === 'sweep') {await wait()} }, collect)

      await until(() => typeof release === 'function')
      await h.service.stop('local_stop')
      release()
      expect(await pending).toBeNull()

      if (during === 'sweep') {expect(collect).not.toHaveBeenCalled()}
    }
  })

  it('a different connection or account never quiesces or reads a copy', async () => {
    const h = harness()
    const grantId = await h.grant()
    const sweep = vi.fn(async () => {})
    const collect = vi.fn(async () => 'unsafe')

    for (const session of [{ ...h.session, connectionId: randomUUID() }, { ...h.session, accountEpoch: h.session.accountEpoch + 1 }]) {
      expect(await h.service.collectWorkspace(grantId, session, sweep, collect)).toBeNull()
    }

    expect(sweep).not.toHaveBeenCalled()
    expect(collect).not.toHaveBeenCalled()
    await h.service.stop('local_stop')
  })
})

describe('Mac sources use the existing device admission and ledger', () => {
  it('dispatches admitted source reads in main, never to the sandbox host', async () => {
    const macSource = vi.fn<NonNullable<DeviceServiceDeps['macSource']>>(async () => '{"timeZone":"UTC"}')
    const h = harness({ macSource })
    const grantId = await h.grant()
    const body = h.executeBody(grantId, 1, 'mac_source', { mode: 'read', request: { op: 'location.current', precision: 'city' } })
    await h.service.frame(h.frame('Execute', body), h.session)
    await until(() => h.receipts().some(receipt => receipt.state === 'completed'))
    expect(macSource).toHaveBeenCalledTimes(1)
    expect(macSource.mock.calls[0]?.[1]).toMatchObject({ grantId, originKind: 'other' })
    expect(h.executor.runs).toHaveLength(0)
    expect(h.ledger.get(body.commandId)?.state).toBe('completed')
    expect(h.ledger.get(body.commandId)?.result?.output).toBeUndefined()
    expect(h.receipts().find(receipt => receipt.state === 'completed')?.result).toEqual({ output: '{"timeZone":"UTC"}' })
    expect(h.service.status({ commandIds: [body.commandId] }).receipts[0]?.result).toBeUndefined()
    await h.service.frame(h.frame('Execute', body), h.session)
    expect(macSource).toHaveBeenCalledTimes(1)
  })
})
