import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { MATRIX_AGENT_PROPOSALS_IPC } from '../../shared/matrix-agent-proposals'
import { EncryptedStore } from '../encrypted-store'

import {
  type MatrixAgentProposalPlatform,
  MatrixAgentProposals,
  type MatrixAgentProposalsDependencies,
  registerMatrixAgentProposalsIpc
} from './agent-proposals'

// Invented identities; no segment is a long run of digits.
const PERSON = 'a1b2c3d4-0000-4000-8000-aaaaaaaaaaa1'
const OTHER = 'a1b2c3d4-0000-4000-8000-bbbbbbbbbbb2'
const PROPOSAL = 'c0ffee00-0000-4000-8000-ccccccccccc3'
const REQUEST = 'd00dfeed-0000-4000-8000-ddddddddddd4'
const SIBLING = 'e1e1e1e1-0000-4000-8000-eeeeeeeeeee5'
const OFFER = 'f0f0f0f0-0000-4000-8000-fffffffffff6'
const ROOM = '!assistant:atum.test'
const EVENT = '$answer-one'
const CREATED = '2026-11-11T08:00:00.000Z'
const EXPIRES = '2026-11-12T08:00:00.000Z'
const NOW = Date.parse('2026-11-11T09:00:00.000Z')
const scopeA = { accountKey: 'a'.repeat(64), generation: 1 }
const placement = { proposalId: PROPOSAL, roomId: ROOM, eventId: EVENT }

function record(change: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    owner: PERSON,
    ownerKind: 'person',
    requester: PERSON,
    visibility: 'requester',
    operation: 'create',
    intent: {
      displayName: 'Researcher',
      definition: { schema_version: 1, soul: '', model_alias: 'nguyet-thuc', reasoning: null, skills: [] }
    },
    quote: { amountMicroProtons: 60_000 * 1_000_000, periodDays: 30, policyVersion: '0314/1', renews: true },
    requestId: REQUEST,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    state: 'pending',
    ...change
  }
}

function harness(
  raw: unknown = record(),
  overrides: Partial<MatrixAgentProposalsDependencies> = {}
) {
  let now = NOW
  let scope: typeof scopeA | null = scopeA
  const changed: string[] = []

  const platform = {
    fetch: vi.fn<MatrixAgentProposalPlatform['fetch']>(async () => raw),
    confirm: vi.fn<MatrixAgentProposalPlatform['confirm']>(async () => ({ status: 'authorised', requestId: REQUEST }))
  }

  const proposals = new MatrixAgentProposals({
    scope: () => scope,
    platform,
    agentName: principal => (principal === SIBLING ? 'Lan' : undefined),
    offerName: (offerId, version) => (offerId === OFFER && version === 2 ? 'Bookkeeper' : undefined),
    changed: roomId => void changed.push(roomId),
    now: () => now,
    ...overrides
  })

  return {
    proposals,
    platform,
    changed,
    advance: (ms: number) => void (now += ms),
    setScope: (next: typeof scope) => void (scope = next)
  }
}

describe('admitting a proposal', () => {
  it('stays off without the owner-session routes: nothing is fetched or shown', async () => {
    const { proposals, platform } = harness(record(), { platform: undefined })

    expect(await proposals.offer(placement)).toBe(false)
    expect(proposals.read(ROOM)).toEqual([])
    expect(platform.fetch).not.toHaveBeenCalled()
  })

  it('builds the card from the platform record: name and monthly price', async () => {
    const { proposals, changed } = harness()

    expect(await proposals.offer(placement)).toBe(true)
    expect(proposals.read(ROOM)).toEqual([
      {
        id: PROPOSAL,
        roomId: ROOM,
        eventId: EVENT,
        operation: 'create',
        agentName: 'Researcher',
        protons: 60_000,
        state: 'pending',
        expiresAt: Date.parse(EXPIRES)
      }
    ])
    expect(changed).toEqual([ROOM])
  })

  it('shows no price when the change is free, and names a retired sibling from main’s roster', async () => {
    const retire = record({
      operation: 'propose_retire',
      intent: { target: SIBLING, expectedDefinitionRevision: 3, expectedIdentityRevision: 1 },
      quote: null
    })

    const { proposals } = harness(retire)

    await proposals.offer(placement)
    const [card] = proposals.read(ROOM)

    expect(card).toMatchObject({ operation: 'retire', agentName: 'Lan', state: 'pending' })
    expect(card).not.toHaveProperty('protons')
  })

  it('names a hire from the Store listing and shows a zero quote as free', async () => {
    const hire = record({
      operation: 'propose_hire',
      intent: { offerId: OFFER, offerVersion: 2 },
      quote: { offerId: OFFER, offerVersion: 2, amountMicroProtons: 0, billingInterval: 'month', policyVersion: 'store/1', renews: true }
    })

    const { proposals } = harness(hire)

    await proposals.offer(placement)
    expect(proposals.read(ROOM)[0]).toMatchObject({ operation: 'hire', agentName: 'Bookkeeper' })
    expect(proposals.read(ROOM)[0]).not.toHaveProperty('protons')
  })

  it.each([
    ['another person asked', record({ requester: OTHER })],
    ['a company proposal (O4)', record({ ownerKind: 'company', visibility: 'company' })],
    ['already consumed', record({ state: 'consumed' })],
    ['already past its expiry', record({ createdAt: '2026-11-10T08:00:00.000Z', expiresAt: '2026-11-11T08:00:00.000Z' })],
    ['not exactly 24 hours long', record({ expiresAt: '2026-11-13T08:00:00.000Z' })],
    ['a different proposal', record({ id: OTHER })],
    ['an extra field', { ...record(), confirmed: true }],
    ['an intent that does not match', record({ operation: 'propose_retire' })],
    ['a retire target main cannot name', record({
      operation: 'propose_retire',
      intent: { target: OTHER, expectedDefinitionRevision: 0, expectedIdentityRevision: 1 },
      quote: null
    })],
    ['malformed', 'confirmation_required']
  ])('refuses a record that is %s', async (_label, raw) => {
    const { proposals, changed } = harness(raw)

    expect(await proposals.offer(placement)).toBe(false)
    expect(proposals.read(ROOM)).toEqual([])
    expect(changed).toEqual([])
  })

  it('refuses a placement that is not a proposal, room and event ID', async () => {
    const { proposals, platform } = harness()

    expect(await proposals.offer({ ...placement, proposalId: 'not-a-uuid' })).toBe(false)
    expect(await proposals.offer({ ...placement, roomId: 'room' })).toBe(false)
    expect(await proposals.offer({ ...placement, eventId: 'answer' })).toBe(false)
    expect(platform.fetch).not.toHaveBeenCalled()
  })

  it('keeps a settled card when the same proposal arrives again', async () => {
    const { proposals, platform } = harness()

    await proposals.offer(placement)
    proposals.decline(PROPOSAL)
    await proposals.offer(placement)

    expect(platform.fetch).toHaveBeenCalledTimes(1)
    expect(proposals.read(ROOM)[0]?.state).toBe('declined')
  })

  it('drops every card when the account changes', async () => {
    const { proposals, setScope, changed } = harness()

    await proposals.offer(placement)
    setScope({ ...scopeA, generation: 2 })

    expect(proposals.read(ROOM)).toEqual([])
    expect(changed).toEqual([ROOM, ROOM])
  })

  it('expires a pending card once 24 hours have passed', async () => {
    const { proposals, advance } = harness()

    await proposals.offer(placement)
    advance(Date.parse(EXPIRES) - NOW)

    expect(proposals.read(ROOM)[0]?.state).toBe('expired')
  })
})

describe('confirming', () => {
  it('confirms with the proposal ID alone and settles as confirmed', async () => {
    const { proposals, platform } = harness()

    await proposals.offer(placement)
    const card = await proposals.confirm(PROPOSAL)

    expect(platform.confirm).toHaveBeenCalledTimes(1)
    expect(platform.confirm.mock.calls[0]?.[0]).toBe(PROPOSAL)
    expect(card.state).toBe('confirmed')
    expect(proposals.read(ROOM)[0]?.state).toBe('confirmed')
  })

  it('sends one confirmation for two taps', async () => {
    const { proposals, platform } = harness()

    await proposals.offer(placement)
    const [first, second] = await Promise.all([proposals.confirm(PROPOSAL), proposals.confirm(PROPOSAL)])

    expect(platform.confirm).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect((await proposals.confirm(PROPOSAL)).state).toBe('confirmed')
    expect(platform.confirm).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a short balance', { error: 'awaiting_funds' }, { state: 'failed', failure: 'funds' }],
    ['funds spent before finish', { status: 'awaiting_funds', requestId: REQUEST }, { state: 'failed', failure: 'funds' }],
    ['changed terms', { status: 'terms_changed', requestId: REQUEST }, { state: 'expired' }],
    ['an expired proposal', { error: 'expired' }, { state: 'expired' }],
    ['a refusal', { error: 'conflict' }, { state: 'failed', failure: 'unavailable' }],
    ['another request’s answer', { status: 'finished', requestId: OTHER }, { state: 'failed', failure: 'unavailable' }],
    ['a retire answer for a create', { status: 'retired', target: SIBLING }, { state: 'failed', failure: 'unavailable' }],
    ['an unknown shape', { ok: true }, { state: 'failed', failure: 'unavailable' }]
  ])('settles %s', async (_label, answer, expected) => {
    const { proposals, platform } = harness()
    platform.confirm.mockResolvedValueOnce(answer)

    await proposals.offer(placement)
    expect(await proposals.confirm(PROPOSAL)).toMatchObject(expected)
  })

  it('treats a lost answer as failed and lets the person try again', async () => {
    const { proposals, platform } = harness()
    platform.confirm.mockRejectedValueOnce(new Error('offline'))

    await proposals.offer(placement)
    expect(await proposals.confirm(PROPOSAL)).toMatchObject({ state: 'failed', failure: 'unavailable' })

    const card = await proposals.confirm(PROPOSAL)
    expect(card.state).toBe('confirmed')
    expect(card).not.toHaveProperty('failure')
  })

  it('accepts a retirement only for the proposed sibling', async () => {
    const retire = record({
      operation: 'propose_retire',
      intent: { target: SIBLING, expectedDefinitionRevision: 3, expectedIdentityRevision: 1 },
      quote: null
    })

    const { proposals, platform } = harness(retire)
    platform.confirm.mockResolvedValueOnce({ status: 'retired', target: OTHER })

    await proposals.offer(placement)
    expect((await proposals.confirm(PROPOSAL)).state).toBe('failed')

    platform.confirm.mockResolvedValueOnce({ status: 'retired', target: SIBLING })
    expect((await proposals.confirm(PROPOSAL)).state).toBe('confirmed')
  })

  it('does not confirm an expired card', async () => {
    const { proposals, platform, advance } = harness()

    await proposals.offer(placement)
    advance(Date.parse(EXPIRES) - NOW + 1)

    expect((await proposals.confirm(PROPOSAL)).state).toBe('expired')
    expect(platform.confirm).not.toHaveBeenCalled()
  })

  it('refuses a proposal it never admitted', async () => {
    const { proposals, platform } = harness()

    await expect(proposals.confirm(PROPOSAL)).rejects.toThrow('matrix_agent_proposal_unavailable')
    expect(() => proposals.decline(PROPOSAL)).toThrow('matrix_agent_proposal_unavailable')
    expect(platform.confirm).not.toHaveBeenCalled()
  })

  it('discards an answer that arrives after the account changed', async () => {
    const { proposals, platform, setScope } = harness()
    let resolve!: (value: unknown) => void
    platform.confirm.mockReturnValueOnce(new Promise(done => (resolve = done)))

    await proposals.offer(placement)
    const pending = proposals.confirm(PROPOSAL)
    setScope({ ...scopeA, generation: 2 })
    resolve({ status: 'finished', requestId: REQUEST })

    await expect(pending).rejects.toThrow('matrix_agent_proposal_stale')
    expect(proposals.read(ROOM)).toEqual([])
  })

  it('declines locally and never confirms afterwards', async () => {
    const { proposals, platform } = harness()

    await proposals.offer(placement)
    expect(proposals.decline(PROPOSAL).state).toBe('declined')
    expect((await proposals.confirm(PROPOSAL)).state).toBe('declined')
    expect(platform.confirm).not.toHaveBeenCalled()
  })
})

describe('the IPC boundary', () => {
  function ipcHarness() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    const assertTrusted = vi.fn((event: unknown) => {
      if (event !== 'ui') {throw new Error('untrusted')}
    })

    const proposals = {
      read: vi.fn(() => []),
      confirm: vi.fn(async () => ({}) as never),
      decline: vi.fn(() => ({}) as never)
    }

    registerMatrixAgentProposalsIpc({ handle: (channel, handler) => void handlers.set(channel, handler as never) }, {
      assertTrusted: assertTrusted as never,
      proposals
    })

    return { call: (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args), proposals }
  }

  it('passes only a room or a proposal ID from the trusted window', async () => {
    const { call, proposals } = ipcHarness()

    call(MATRIX_AGENT_PROPOSALS_IPC.read, 'ui', ROOM)
    await call(MATRIX_AGENT_PROPOSALS_IPC.confirm, 'ui', PROPOSAL)
    call(MATRIX_AGENT_PROPOSALS_IPC.decline, 'ui', PROPOSAL)

    expect(proposals.read).toHaveBeenCalledWith(ROOM)
    expect(proposals.confirm).toHaveBeenCalledWith(PROPOSAL)
    expect(proposals.decline).toHaveBeenCalledWith(PROPOSAL)
  })

  it('refuses another window, extra arguments and anything but a proposal ID', () => {
    const { call, proposals } = ipcHarness()

    expect(() => call(MATRIX_AGENT_PROPOSALS_IPC.confirm, 'page', PROPOSAL)).toThrow('untrusted')
    expect(() => call(MATRIX_AGENT_PROPOSALS_IPC.confirm, 'ui', PROPOSAL, { protons: 0 })).toThrow(
      'matrix_agent_proposal_invalid_request'
    )
    expect(() => call(MATRIX_AGENT_PROPOSALS_IPC.confirm, 'ui', { id: PROPOSAL })).toThrow(
      'matrix_agent_proposal_invalid_request'
    )
    expect(() => call(MATRIX_AGENT_PROPOSALS_IPC.read, 'ui', 'room')).toThrow('matrix_agent_proposal_invalid_request')
    expect(proposals.confirm).not.toHaveBeenCalled()
    expect(proposals.read).not.toHaveBeenCalled()
  })
})


describe('durable Not now', () => {
  it.each(['switch', 'sign-out'] as const)('survives restart and clears on %s', async transition => {
    const directory = mkdtempSync(join(tmpdir(), 'proposal-declines-'))
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }
    const storage = () => new EncryptedStore(join(directory, 'outcomes.json'), safeStorage)
    try {
      const first = harness(record(), { storage: storage() })
      await first.proposals.offer(placement)
      expect(first.proposals.decline(PROPOSAL).state).toBe('declined')
      const restarted = harness(record(), { storage: storage() })
      await restarted.proposals.offer(placement)
      expect(restarted.proposals.read(ROOM)[0]?.state).toBe('declined')
      await restarted.proposals.confirm(PROPOSAL)
      expect(restarted.platform.confirm).not.toHaveBeenCalled()
      restarted.setScope(transition === 'sign-out' ? null : { accountKey: 'b'.repeat(64), generation: 2 })
      restarted.proposals.refreshScope()
      expect(restarted.proposals.read(ROOM)).toEqual([])
      const returned = harness(record(), { storage: storage() })
      await returned.proposals.offer(placement)
      expect(returned.proposals.read(ROOM)[0]?.state).toBe('pending')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
