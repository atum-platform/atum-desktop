import { describe, expect, it } from 'vitest'

import type { ExecutionPolicySnapshot, MatrixExecutionPolicyView } from '../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../shared/execution-policy'
import savedPolicyFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'

import {
  executionPolicyOffersChoice,
  executionPolicyRosterLine,
  executionPolicyRowSummary,
  executionPolicyTrigger
} from './execution-policy-trigger'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'

const policy = (disabled: string[] = []): ExecutionPolicySnapshot =>
  parseExecutionPolicySnapshot({
    ...savedPolicyFixture,
    order: ['cloud', MAC_A, MAC_B],
    disabled
  })!

const status = (overrides: Record<string, unknown> = {}, disabled: string[] = []) =>
  parseExecutionStatusSnapshot({
    profile: 'atum.execution-status/1',
    agentPrincipal: AGENT,
    policyRevision: 2,
    asOf: 1791877000000,
    state: 'idle',
    current: null,
    desired: MAC_A,
    order: ['cloud', MAC_A, MAC_B],
    disabled,
    destinations: {
      cloud: { state: 'ready', observedAt: 1791876998000 },
      [MAC_A]: { state: 'ready', observedAt: 1791876999000 },
      [MAC_B]: { state: 'ready', observedAt: 1791876997000 },
      ...Object.fromEntries(
        disabled.map(id => [id, { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876996000 }])
      )
    },
    ...overrides
  })!

const view = (overrides: Partial<MatrixExecutionPolicyView> = {}): MatrixExecutionPolicyView => ({
  policy: policy(),
  status: status(),
  stale: false,
  ...overrides
})

describe('execution policy trigger choice', () => {
  it('names the destination answering now, never the first row of the order', () => {
    // Local/cloud placement follows the saved execution policy and current lease.
    const answered = view({
      status: status({
        state: 'working',
        current: MAC_A,
        desired: MAC_A,
        destinations: {
          cloud: { state: 'offline', reason: 'not_present', observedAt: 1791876998000 },
          [MAC_A]: { state: 'working', observedAt: 1791876999000 },
          [MAC_B]: { state: 'ready', observedAt: 1791876997000 }
        }
      })
    })

    const trigger = executionPolicyTrigger('en', answered)

    expect(trigger.kind).toBe('destination')
    expect(trigger.kind === 'destination' && trigger.destination.id).toBe(MAC_A)
    expect(trigger.kind === 'destination' && trigger.destination.kind).toBe('mac')
    expect(trigger.tooltip).toBe('Answering on Mac 1')
  })

  it('names the destination about to take over when nobody is answering yet', () => {
    const trigger = executionPolicyTrigger('en', view({ status: status({ desired: MAC_B }) }))

    expect(trigger.kind === 'destination' && trigger.destination.id).toBe(MAC_B)
    expect(trigger.tooltip).toBe('About to answer on Mac 2')
  })

  it('names the Mac the owner named, with this Mac marked', () => {
    const named = view({
      status: status({ desired: MAC_A }),
      deviceNames: {
        [MAC_A.slice('mac:'.length)]: { displayName: "Example's MacBook Air", model: 'MacBook Air', thisMac: true }
      }
    })

    expect(executionPolicyTrigger('vi', named).tooltip).toBe('Sắp trả lời trên MacBook Air (máy này)')
    expect(executionPolicyTrigger('en', view({ status: status({ desired: MAC_A }) })).tooltip).toBe(
      'About to answer on Mac 1'
    )
  })

  it('falls back to the first reachable enabled row when the status names no destination', () => {
    // No destination is ready and nothing is desired, but a Mac is merely busy: it is online and
    // will answer, so the trigger may still name it.
    const busy = parseExecutionStatusSnapshot({
      profile: 'atum.execution-status/1',
      agentPrincipal: AGENT,
      policyRevision: 2,
      asOf: 1791877000000,
      state: 'unavailable',
      current: null,
      desired: null,
      order: ['cloud', MAC_A, MAC_B],
      disabled: ['cloud'],
      destinations: {
        cloud: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876998000 },
        [MAC_A]: { state: 'busy', reason: 'busy', observedAt: 1791876999000 },
        [MAC_B]: { state: 'offline', reason: 'not_present', observedAt: 1791876997000 }
      }
    })!

    const trigger = executionPolicyTrigger('en', view({ policy: policy(['cloud']), status: busy }))

    expect(trigger.kind === 'destination' && trigger.destination.id).toBe(MAC_A)
    expect(trigger.tooltip).toBe('About to answer on Mac 1')
  })

  it('never names an offline row as about to answer', () => {
    // Cloud is off, both Macs are merely offline: nobody answers, nobody is next by name yet. The
    // first enabled row is not a fact to paint — the icon says the truth is not known yet.
    const offline = parseExecutionStatusSnapshot({
      profile: 'atum.execution-status/1',
      agentPrincipal: AGENT,
      policyRevision: 2,
      asOf: 1791877000000,
      state: 'unavailable',
      current: null,
      desired: null,
      order: ['cloud', MAC_A, MAC_B],
      disabled: ['cloud'],
      destinations: {
        cloud: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876998000 },
        [MAC_A]: { state: 'offline', reason: 'not_present', observedAt: 1791876999000 },
        [MAC_B]: { state: 'offline', reason: 'not_present', observedAt: 1791876997000 }
      }
    })!

    const trigger = executionPolicyTrigger('en', view({ policy: policy(['cloud']), status: offline }))

    expect(trigger).toEqual({ kind: 'loading', tooltip: 'Where this assistant answers' })
  })

  it('names the owner’s pause when every destination is off', () => {
    const disabled = ['cloud', MAC_A, MAC_B]

    const trigger = executionPolicyTrigger(
      'en',
      view({
        policy: policy(disabled),
        status: status({ state: 'paused', desired: null }, disabled)
      })
    )

    expect(trigger.kind).toBe('paused')
    expect(trigger.tooltip).toBe('Paused')
  })

  it('shows one honest icon while the cache is stale or a read has not answered yet', () => {
    expect(executionPolicyTrigger('en', view({ stale: true })).kind).toBe('loading')
    expect(executionPolicyTrigger('en', view({ status: undefined })).kind).toBe('loading')
    expect(executionPolicyTrigger('en', view({ status: undefined })).tooltip).toBe('Where this assistant answers')
  })

  it('speaks Vietnamese for the same facts', () => {
    const answered = view({
      status: status({
        state: 'working',
        current: MAC_A,
        desired: MAC_A,
        destinations: {
          cloud: { state: 'ready', observedAt: 1791876998000 },
          [MAC_A]: { state: 'working', observedAt: 1791876999000 },
          [MAC_B]: { state: 'ready', observedAt: 1791876997000 }
        }
      })
    })

    expect(executionPolicyTrigger('vi', answered).tooltip).toBe('Đang trả lời trên Máy Mac 1')
    expect(executionPolicyTrigger('vi', view({ status: status({ desired: MAC_B }) })).tooltip).toBe(
      'Sắp trả lời trên Máy Mac 2'
    )
  })
})

describe('the card row and the roster read the same policy', () => {
  it('summarises the place alone (the row’s label says "where it answers"), or says why not', () => {
    // Just the destination: no "answering" verb repeated next to the label.
    expect(executionPolicyRowSummary('vi', view())).toEqual({ kind: 'destination', text: 'Máy Mac 1' })
    expect(executionPolicyRowSummary('en', view({ status: status({ desired: 'cloud' }) }))).toEqual({
      kind: 'destination',
      text: 'Cloud'
    })

    const disabled = ['cloud', MAC_A, MAC_B]
    const paused = view({ policy: policy(disabled), status: status({ state: 'paused', desired: null }, disabled) })
    expect(executionPolicyRowSummary('en', paused)).toEqual({ kind: 'paused', text: 'Paused' })
    expect(executionPolicyRowSummary('vi', paused)).toEqual({ kind: 'paused', text: 'Tạm dừng' })

    expect(executionPolicyRowSummary('en', view({ stale: true }))).toEqual({
      kind: 'unavailable',
      text: 'Status unavailable'
    })
    expect(executionPolicyRowSummary('en', view({ status: undefined }))).toEqual({
      kind: 'unavailable',
      text: 'Status unavailable'
    })
  })

  it('names where an assistant answers from a Mac that is not ready, never a pause or an unknown', () => {
    const answered = view({
      status: status({
        state: 'working',
        current: MAC_A,
        desired: MAC_A,
        destinations: {
          cloud: { state: 'ready', observedAt: 1791876998000 },
          [MAC_A]: { state: 'working', observedAt: 1791876999000 },
          [MAC_B]: { state: 'ready', observedAt: 1791876997000 }
        }
      })
    })

    // The roster has little room: only the place, never the full sentence the tooltip speaks.
    expect(executionPolicyRosterLine('vi', answered, false)).toBe('Trên Máy Mac 1')
    expect(executionPolicyRosterLine('en', view({ status: status({ desired: MAC_B }) }), false)).toBe('On Mac 2')
    expect(executionPolicyRosterLine('en', answered)).toBeUndefined()

    const disabled = ['cloud', MAC_A, MAC_B]
    const paused = view({ policy: policy(disabled), status: status({ state: 'paused', desired: null }, disabled) })
    expect(executionPolicyRosterLine('en', paused)).toBeUndefined()
    expect(executionPolicyRosterLine('en', view({ stale: true }))).toBeUndefined()
    expect(executionPolicyRosterLine('en', view({ status: undefined }))).toBeUndefined()

    // Every destination offline: the trigger's first-enabled fallback is not an answer.
    const offline = parseExecutionStatusSnapshot({
      profile: 'atum.execution-status/1',
      agentPrincipal: AGENT,
      policyRevision: 2,
      asOf: 1791877000000,
      state: 'unavailable',
      current: null,
      desired: null,
      order: ['cloud', MAC_A, MAC_B],
      disabled: ['cloud'],
      destinations: {
        cloud: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876998000 },
        [MAC_A]: { state: 'offline', reason: 'not_present', observedAt: 1791876999000 },
        [MAC_B]: { state: 'offline', reason: 'not_present', observedAt: 1791876997000 }
      }
    })!

    expect(executionPolicyRosterLine('en', view({ policy: policy(['cloud']), status: offline }))).toBeUndefined()
  })
})

describe('when the title bar offers the placement control', () => {
  it('hides it under cloud-only and preserves the multi-Mac choice with the switch off', () => {
    // Cloud and Macs A and B: a real choice of who answers first.
    expect(executionPolicyOffersChoice(view())).toBe(false)
    expect(executionPolicyOffersChoice(view(), false)).toBe(true)

    // Cloud and one Mac (a new account on its first Mac): nothing to reorder, nothing in the first chat.
    const one = { ...policy(), order: ['cloud', MAC_A] } as ExecutionPolicySnapshot
    expect(executionPolicyOffersChoice({ policy: one }, false)).toBe(false)

    // The cloud alone, and one Mac alone, are not choices either.
    expect(executionPolicyOffersChoice({ policy: { ...policy(), order: ['cloud'] } as ExecutionPolicySnapshot }, false)).toBe(
      false
    )
    expect(executionPolicyOffersChoice({ policy: { ...policy(), order: [MAC_A] } as ExecutionPolicySnapshot }, false)).toBe(
      false
    )
  })

  it('does not depend on what is switched off or on how fresh the status is', () => {
    expect(executionPolicyOffersChoice(view({ policy: policy([MAC_B]) }), false)).toBe(true)
    expect(executionPolicyOffersChoice(view({ stale: true, status: undefined }), false)).toBe(true)
  })
})
