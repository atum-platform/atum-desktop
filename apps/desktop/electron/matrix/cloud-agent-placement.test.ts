import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { MatrixExecutionPolicyView } from '../../shared/execution-policy'

import { matrixLocalExecutorRequired } from './assistant-setup'
import {
  matrixAgentAnswerReady,
  matrixAgentJobsPlan,
  matrixCloudAgentAnswersInCloud,
  matrixCloudAgentMacRole,
  matrixCloudAgentNeedsLocalReadiness,
  matrixCloudAgentReadinessForUser,
  matrixCloudAgentSetupForUser,
  MatrixPlacedAgents,
  matrixPlacedCloudOnly
} from './cloud-agent-placement'
import { applyMatrixJobsHold, MatrixCronHolds } from './cron-hold'

const pack = new URL('../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/', import.meta.url)
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, pack), 'utf8'))
const MAC_A = '00000000-0000-4000-8000-b454f82c5857'
const MAC_B = '00000000-0000-4000-8000-f6222a1106ee'
const saved = fixture<MatrixExecutionPolicyView['policy']>('policy-saved.response.json')

/** Local/cloud placement follows the saved execution policy and current lease. */
const raymond: MatrixExecutionPolicyView = {
  policy: { ...saved, order: [`mac:${MAC_A}`, `mac:${MAC_B}`, 'cloud'], disabled: ['cloud'] },
  stale: false
}

/** Alfred: the cloud first, then both Macs. */
const alfred: MatrixExecutionPolicyView = {
  policy: { ...saved, order: ['cloud', `mac:${MAC_A}`, `mac:${MAC_B}`], disabled: [] },
  stale: false
}

const role = (view: MatrixExecutionPolicyView | undefined, leaseState: string | undefined, powerEligible = true) =>
  matrixCloudAgentMacRole({ view, deviceServiceId: MAC_A, leaseState, powerEligible })

describe('where a cloud-route agent is served from on this Mac', () => {
  it('is answering only while this Mac holds the term, standby while only the policy keeps it', () => {
    expect(role(raymond, 'held')).toBe('answering')
    expect(role(raymond, 'idle')).toBe('standby')
    expect(role(raymond, 'elsewhere')).toBe('standby')
    expect(role(alfred, 'held')).toBe('answering')
    expect(role(alfred, 'elsewhere')).toBe('standby')
  })

  it('is cloud-only here with no fresh saved policy that names this Mac', () => {
    expect(role(undefined, 'held')).toBeUndefined()
    expect(role({ ...raymond, stale: true }, 'idle')).toBeUndefined()
    expect(
      role({ policy: { ...raymond.policy, source: 'default', revision: 0 }, stale: false }, 'held')
    ).toBeUndefined()
    expect(
      matrixCloudAgentMacRole({
        view: raymond,
        deviceServiceId: '00000000-0000-4000-8000-f1d11edf5c5c',
        leaseState: 'held',
        powerEligible: true
      })
    ).toBeUndefined()
    // This Mac turned off for the agent and holds nothing: it serves nothing.
    expect(role({ policy: { ...raymond.policy, disabled: [`mac:${MAC_A}`] }, stale: false }, 'idle')).toBeUndefined()
  })

  it('takes a MacBook on battery out unless a term it holds is still draining (FC D3)', () => {
    expect(role(raymond, 'idle', false)).toBeUndefined()
    expect(role(raymond, 'held', false)).toBe('answering')
  })

  it('keeps a standby Mac provider-local while the cloud remains the answering destination', () => {
    expect(matrixCloudAgentAnswersInCloud({ cloudRoute: true, role: 'standby' })).toBe(true)
    expect(matrixCloudAgentAnswersInCloud({ cloudRoute: true, role: undefined })).toBe(true)
    expect(matrixCloudAgentAnswersInCloud({ cloudRoute: true, role: 'answering' })).toBe(false)
    expect(matrixCloudAgentAnswersInCloud({ cloudRoute: false, role: 'standby' })).toBe(false)
  })

  it('publishes cloud and standby assistants ready without borrowing this Mac readiness', () => {
    expect(
      matrixAgentAnswerReady({ cloudRoute: true, role: undefined, localAuthority: false, localHostReady: false })
    ).toBe(true)
    expect(
      matrixAgentAnswerReady({ cloudRoute: true, role: 'standby', localAuthority: true, localHostReady: false })
    ).toBe(true)

    // Once this Mac holds the answering term, its real authority and host gate the assistant.
    expect(
      matrixAgentAnswerReady({ cloudRoute: true, role: 'answering', localAuthority: true, localHostReady: false })
    ).toBe(false)
    expect(
      matrixAgentAnswerReady({ cloudRoute: true, role: 'answering', localAuthority: true, localHostReady: true })
    ).toBe(true)
    expect(
      matrixAgentAnswerReady({ cloudRoute: false, role: undefined, localAuthority: false, localHostReady: true })
    ).toBe(false)
  })

  it('runs local readiness for all five production-shaped saved policies on this Mac', () => {
    const macBook = `mac:${MAC_A}` as const
    const macMini = `mac:${MAC_B}` as const
    const production = [
      { name: 'Raymond', revision: 9, order: ['cloud', macMini, macBook] },
      { name: 'Alfred', revision: 3, order: ['cloud', macBook, macMini] },
      { name: 'Axe/Luna/Wendy', revision: 1, order: ['cloud', macBook, macMini] },
      { name: 'agent 3e4e6736', revision: 1, order: ['cloud', macBook, macMini] },
      { name: 'agent 7c7e39cc', revision: 1, order: ['cloud', macBook, macMini] }
    ] as const

    for (const agent of production) {
      const view: MatrixExecutionPolicyView = {
        policy: { ...saved, revision: agent.revision, order: [...agent.order], disabled: [] },
        stale: false
      }
      const macRole = matrixCloudAgentMacRole({
        view,
        deviceServiceId: MAC_A,
        leaseState: 'elsewhere',
        powerEligible: true
      })

      expect(macRole, agent.name).toBe('standby')
      expect(matrixCloudAgentAnswersInCloud({ cloudRoute: true, role: macRole }), agent.name).toBe(true)
      expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: true, role: macRole }), agent.name).toBe(true)
    }
  })

  it('skips local readiness only when this Mac has no saved-policy role', () => {
    expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: true, role: undefined })).toBe(false)
    expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: true, role: 'standby' })).toBe(true)
    expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: true, role: 'answering' })).toBe(true)
    expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: false, role: undefined })).toBe(true)
  })

  it('never presents standby setup failure or blocked local readiness as a broken assistant', () => {
    expect(matrixCloudAgentSetupForUser({
      cloudRoute: true,
      role: 'standby',
      setup: 'failed'
    })).toBeUndefined()
    expect(matrixCloudAgentReadinessForUser({
      cloudRoute: true,
      role: 'standby',
      local: { phase: 'blocked', step: 'assistant', code: 'setup_failed', since: 7 },
      since: 9
    })).toEqual({ phase: 'ready', since: 7 })

    // Once this Mac answers, its local setup is the actual route and remains honest.
    expect(matrixCloudAgentSetupForUser({
      cloudRoute: true,
      role: 'answering',
      setup: 'failed'
    })).toBe('failed')
  })
})

describe('a placed answer is kept only by the session and roster that own it', () => {
  const principal = '00000000-0000-4000-8000-e701d04e702f'
  const other = '00000000-0000-4000-8000-8728d438aca6'

  it('drops a placed id once a roster read no longer lists it as active, and keeps it while it does', () => {
    const placed = new MatrixPlacedAgents([principal])

    // The switch has not landed yet: the row still says local, so the id stays placed.
    placed.retain([{ principal, status: 'active' }])
    expect(placed.has(principal)).toBe(true)

    // Retired/tombstoned or removed entirely: the platform will never show `answering: cloud`.
    placed.retain([{ principal, status: 'retired' }])
    expect(placed.has(principal)).toBe(false)
    placed.add(principal)
    placed.retain([{ principal, status: 'active' }])
    placed.retain([])
    expect(placed.has(principal)).toBe(false)
  })

  it('keeps a just-placed id through a stale read that does not list it yet', () => {
    // A read already in flight when the create answered can come back without the new agent;
    // dropping the id then would let this Mac set up a local executor for a cloud agent.
    const placed = new MatrixPlacedAgents([principal])

    placed.retain([])
    expect(placed.has(principal)).toBe(true)
    placed.retain([{ principal, status: 'active' }])
    placed.retain([])
    expect(placed.has(principal)).toBe(false)
  })

  it('clears every placed id when a fresh sign-in/account starts', () => {
    // The ended session's placements are not the new session's: this path never ran sign-out.
    const placed = new MatrixPlacedAgents([principal, other])

    placed.reset()

    expect(placed.size).toBe(0)
  })
})

describe('a just-created agent the platform placed in the cloud', () => {
  const principal = '00000000-0000-4000-8000-e1059ba50f1e'
  const placed = new Set([principal])
  const pending = new Set<string>()
  const answering = new Set([principal])

  it('is cloud-only from the create answer until the roster shows answering: cloud', () => {
    expect(matrixPlacedCloudOnly({ principal, placed, cloudRoster: pending })).toBe(true)
    // The switch shows in the roster: the ordinary saved-policy/lease decision owns it again.
    expect(matrixPlacedCloudOnly({ principal, placed, cloudRoster: answering })).toBe(false)
    expect(matrixPlacedCloudOnly({ principal: undefined, placed, cloudRoster: pending })).toBe(false)
    expect(matrixPlacedCloudOnly({ principal: 'other', placed, cloudRoster: pending })).toBe(false)
  })

  it('never enrolls a local executor while its roster row still says local', () => {
    // setUpAgent and the enrollment paths ask `isCloudOnlyAgent`, which composes this predicate.
    expect(
      matrixLocalExecutorRequired({
        principal,
        defaultCloudOnly: false,
        namedCloudOnly: each => matrixPlacedCloudOnly({ principal: each, placed, cloudRoster: pending })
      })
    ).toBe(false)
  })
})

describe("an agent's scheduled work follows the placement, not the roster's answering flag", () => {
  const plan = (cloudRoute: boolean, mac: ReturnType<typeof role>, runsJobsHere = true) =>
    matrixAgentJobsPlan({ cloudRoute, role: mac, runsJobsHere })

  it("lets Raymond's jobs, Store schedules and check-ins run on the Mac that answers for him", () => {
    // The old rule was `runsJobsHere && !isCloudAgent(agent)`: false for him on both Macs.
    expect(plan(true, role(raymond, 'held'))).toEqual({ attach: true, tick: true, holdUntilAnswering: false })
  })

  it('holds a standby Mac for a cloud-route agent, so a job never runs on two machines', () => {
    expect(plan(true, role(raymond, 'elsewhere'))).toEqual({ attach: true, tick: true, holdUntilAnswering: true })
    expect(plan(true, role(alfred, 'elsewhere'))).toEqual({ attach: true, tick: true, holdUntilAnswering: true })
  })

  it('keeps a failover to a Mac firing for a cloud-first agent, then holds again when the cloud is back', () => {
    expect(plan(true, role(alfred, 'held')).holdUntilAnswering).toBe(false)
    expect(plan(true, role(alfred, 'yielding'))).toMatchObject({ attach: true, holdUntilAnswering: true })
  })

  it('runs nothing for an agent this Mac does not serve', () => {
    expect(plan(true, undefined)).toEqual({ attach: false, tick: false, holdUntilAnswering: true })
  })

  it('leaves a plain local agent exactly as before, and the Mac that is switched off for jobs off', () => {
    expect(plan(false, undefined)).toEqual({ attach: true, tick: true, holdUntilAnswering: false })
    expect(plan(false, undefined, false)).toEqual({ attach: true, tick: false, holdUntilAnswering: false })
    expect(plan(true, role(raymond, 'held'), false)).toEqual({ attach: true, tick: false, holdUntilAnswering: false })
  })
})

describe("the ticker's hold follows the lease, with no restart that would hand the term back", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function ticker() {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-jobs-hold-'))
    roots.push(root)
    const holds = new MatrixCronHolds(path.join(root, 'cron-holds'))

    return {
      holds,
      /** One reconcile of a cloud-route agent at a lease state; whether its ticker is held after it. */
      cloud: (view: MatrixExecutionPolicyView | undefined, leaseState: string | undefined) => {
        const may = applyMatrixJobsHold(
          holds,
          'agent:raymond',
          matrixAgentJobsPlan({ cloudRoute: true, role: role(view, leaseState), runsJobsHere: true })
        )

        return { held: holds.held('agent:raymond'), may }
      }
    }
  }

  it('holds a standby Mac, lifts the hold the moment this Mac holds the term, and holds again when it hands it back', () => {
    const f = ticker()

    expect(f.cloud(raymond, 'acquiring')).toEqual({ held: true, may: true })
    expect(f.cloud(raymond, 'elsewhere')).toEqual({ held: true, may: true })
    expect(f.cloud(raymond, 'held')).toEqual({ held: false, may: true })
    expect(f.cloud(raymond, 'held')).toEqual({ held: false, may: true })
    // The higher-priority destination is taking over: nothing new is dispatched from here on.
    expect(f.cloud(raymond, 'yielding')).toEqual({ held: true, may: true })
    expect(f.cloud(raymond, 'elsewhere')).toEqual({ held: true, may: true })
  })

  it('holds an agent no policy keeps on this Mac, and lifts the hold once it is a plain local agent again', () => {
    const f = ticker()

    expect(f.cloud(undefined, 'held')).toEqual({ held: true, may: true })

    // The off switch ran: back to a local agent, its jobs run wherever matrix-run-jobs says.
    applyMatrixJobsHold(
      f.holds,
      'agent:raymond',
      matrixAgentJobsPlan({ cloudRoute: false, role: undefined, runsJobsHere: true })
    )
    expect(f.holds.held('agent:raymond')).toBe(false)
  })

  it('refuses to launch a ticker when a hold the plan needs cannot be written', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atum-jobs-hold-'))
    roots.push(root)
    // A file where the markers' folder should be: nothing can be written there.
    const blocked = new MatrixCronHolds(path.join(root, 'not-a-folder', 'cron-holds'))
    writeFileSync(path.join(root, 'not-a-folder'), '')

    expect(
      applyMatrixJobsHold(
        blocked,
        'agent:raymond',
        matrixAgentJobsPlan({ cloudRoute: true, role: role(raymond, 'elsewhere'), runsJobsHere: true })
      )
    ).toBe(false)
  })
})
