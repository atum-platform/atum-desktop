import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { matrixCompanyScope } from '../../shared/matrix-company-ai'
import type { MatrixCompanyBoardCard } from '../../shared/matrix-company-board'
import {
  companyBoardOwnerChoice,
  companyBoardOwnershipPatch,
  toggleCompanyBoardOwner
} from '../../shared/matrix-company-board-ownership'

import { requestMatrixCompanyBoard } from './company-board'

/**
 * Owner edits from the board's owner picker, through the main-process board client and its
 * parsers, against a stand-in for the platform authority: the ownership branch of
 * `atum.company_board_command` (atum-platform migration 0324, delegated unchanged by the v1.1
 * command in 0351). The stand-in keeps exactly the rules that decide whether an owner edit lands:
 * all three membership fields or `matrix_invalid`, a member may name no owner but themselves or
 * `matrix_denied`, a stale revision conflicts, and an accepted patch replaces the whole membership.
 */
const contracts = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts')
const json = <T>(file: string): T => JSON.parse(readFileSync(resolve(contracts, file), 'utf8')) as T

const companyId = '00000000-0000-4000-8000-3fff02fcbe73'
const MINH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const QUAN = 'QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'
const LAN = 'LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL'
const BAO = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

type Role = 'owner' | 'admin' | 'member'

/** A real-schema card; the fields this test reads are spelled out for every tsconfig. */
type Card = MatrixCompanyBoardCard & {
  cardId: string
  revision: number
  owners: string[]
  primaryOwner: string | null
  participants: string[]
}

/** The card as the platform stores it; every reply is a real-schema card projected from it. */
function platformAuthority(seed: Card, actor: { memberRef: string; role: Role }) {
  let card = structuredClone(seed)
  const commands: unknown[] = []

  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as {
      expectedCardRevision: number
      patch: Record<string, unknown>
    }

    const v11 = (init?.headers as Record<string, string> | undefined)?.['X-Atum-Company-Board'] === '1.1'
    commands.push(command)

    if (command.expectedCardRevision !== card.revision) {
      return v11
        ? Response.json({
            schemaVersion: 1,
            state: 'conflict',
            reason: 'stale_card_revision',
            cardId: card.cardId,
            expectedCardRevision: command.expectedCardRevision,
            currentCardRevision: card.revision,
            currentCard: card
          })
        : Response.json({ error: 'conflict' }, { status: 409 })
    }

    const { owners, primaryOwner, participants } = command.patch as {
      owners?: string[]
      primaryOwner?: string | null
      participants?: string[]
    }

    if (owners !== undefined || primaryOwner !== undefined || participants !== undefined) {
      if (!Array.isArray(owners) || primaryOwner === undefined || !Array.isArray(participants)) {
        return Response.json({ error: 'invalid' }, { status: 400 })
      }

      if (actor.role === 'member' && owners.some(owner => owner !== actor.memberRef)) {
        return Response.json({ error: 'denied' }, { status: 403 })
      }

      card = {
        ...card,
        revision: card.revision + 1,
        owners: [...owners].sort(),
        primaryOwner: primaryOwner !== null && owners.includes(primaryOwner) ? primaryOwner : null,
        participants: [...participants].sort()
      }
    }

    return Response.json(
      v11
        ? { schemaVersion: 1, state: 'applied', duplicate: false, eventId: crypto.randomUUID(), card }
        : { schemaVersion: 1, duplicate: false, card }
    )
  })

  vi.stubGlobal('fetch', fetcher)

  return { card: () => card, commands, fetcher }
}

function context() {
  const entries = new Map<string, string>()

  return {
    resource: 'https://api.test/api/matrix/v1',
    accessToken: 'native-only',
    signal: AbortSignal.timeout(2000),
    scope: matrixCompanyScope('account', companyId),
    assertCurrent: () => {},
    journal: {
      read: (scope: string) => entries.get(scope) ?? null,
      write: (scope: string, value: string) => void entries.set(scope, value),
      clear: (scope: string, value: string) => {
        if (entries.get(scope) === value) {
          entries.delete(scope)
        }
      }
    }
  }
}

const v1Card = (overrides: Partial<Card> = {}): Card => ({
  ...json<Card>('atum-company-board-v1/fixtures/card-human.response.json'),
  ...overrides
})

const v11Card = (overrides: Partial<Card> = {}): Card => ({
  ...json<Card>('atum-company-board-v1.1/fixtures/card.response.json'),
  ...overrides
})

function ownerCommand(card: Card, patch: object, requestId = crypto.randomUUID()) {
  return {
    schemaVersion: 1 as const,
    operation: 'patch' as const,
    requestId,
    cardId: card.cardId,
    expectedCardRevision: card.revision,
    patch
  }
}

async function send(card: Card, patch: object, profile: '1' | '1.1') {
  const command = ownerCommand(card, patch)

  return profile === '1.1'
    ? requestMatrixCompanyBoard(context(), { action: 'board-command-v11', companyId, command } as never)
    : requestMatrixCompanyBoard(context(), { action: 'board-command', companyId, command } as never)
}

afterEach(() => vi.unstubAllGlobals())

describe.each(['1', '1.1'] as const)('owner edits on board profile %s', profile => {
  const seed = (overrides: Partial<Card>): Card => (profile === '1.1' ? v11Card(overrides) : v1Card(overrides))

  it('adds a co-owner: the platform keeps the primary owner, the other owners and the participants', async () => {
    const card = seed({ owners: [MINH, QUAN], primaryOwner: MINH, participants: [BAO] })
    const platform = platformAuthority(card, { memberRef: MINH, role: 'admin' })

    await expect(send(card, toggleCompanyBoardOwner(card, LAN), profile)).resolves.toBeTruthy()

    expect(platform.commands[0]).toMatchObject({
      patch: { owners: [MINH, QUAN, LAN], primaryOwner: MINH, participants: [BAO] }
    })
    expect(platform.card()).toMatchObject({ owners: [LAN, MINH, QUAN].sort(), primaryOwner: MINH, participants: [BAO] })
  })

  it('removes the primary owner: the next owner becomes primary and nobody else is dropped', async () => {
    const card = seed({ owners: [MINH, QUAN, LAN], primaryOwner: MINH, participants: [BAO] })
    const platform = platformAuthority(card, { memberRef: MINH, role: 'owner' })

    await send(card, toggleCompanyBoardOwner(card, MINH), profile)

    expect(platform.card()).toMatchObject({ owners: [LAN, QUAN].sort(), primaryOwner: QUAN, participants: [BAO] })
  })

  it('removes a co-owner without touching the primary owner', async () => {
    const card = seed({ owners: [MINH, QUAN], primaryOwner: MINH, participants: [] })
    const platform = platformAuthority(card, { memberRef: MINH, role: 'admin' })

    await send(card, toggleCompanyBoardOwner(card, QUAN), profile)

    expect(platform.card()).toMatchObject({ owners: [MINH], primaryOwner: MINH, participants: [] })
  })

  it('removes the last owner: unassigned, with the participants kept', async () => {
    const card = seed({ owners: [QUAN], primaryOwner: QUAN, participants: [BAO] })
    const platform = platformAuthority(card, { memberRef: MINH, role: 'admin' })

    await send(card, toggleCompanyBoardOwner(card, QUAN), profile)

    expect(platform.card()).toMatchObject({ owners: [], primaryOwner: null, participants: [BAO] })
  })

  it('refuses the old singleton patch before it reaches the platform', async () => {
    const card = seed({ owners: [MINH, QUAN], primaryOwner: MINH })
    const platform = platformAuthority(card, { memberRef: MINH, role: 'admin' })

    // What the picker used to send: no participants, and every other owner gone.
    await expect(send(card, { owners: [LAN], primaryOwner: LAN }, profile)).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      send(card, { owners: [LAN], primaryOwner: MINH, participants: [] }, profile)
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(platform.fetcher).not.toHaveBeenCalled()
    expect(platform.card().owners).toEqual([MINH, QUAN])
  })

  it('a stale revision changes nothing and hands back the current card', async () => {
    const card = seed({ owners: [MINH], primaryOwner: MINH })
    const newer = { ...card, revision: card.revision + 1, owners: [MINH, QUAN] }
    const platform = platformAuthority(newer, { memberRef: MINH, role: 'admin' })

    const result = send(card, toggleCompanyBoardOwner(card, LAN), profile)

    if (profile === '1.1') {
      await expect(result).resolves.toMatchObject({
        negotiatedProfile: '1.1',
        value: { state: 'conflict', currentCard: { owners: [MINH, QUAN] } }
      })
    } else {
      await expect(result).rejects.toMatchObject({ code: 'conflict' })
    }

    expect(platform.card().owners).toEqual([MINH, QUAN])
  })
})

describe('owner edits by a member', () => {
  it('may claim an unowned task and release it again', async () => {
    const card = v11Card({ owners: [], primaryOwner: null, participants: [BAO] })
    const choose = companyBoardOwnerChoice(card, { memberRef: LAN, manages: false })
    const platform = platformAuthority(card, { memberRef: LAN, role: 'member' })

    expect(choose(LAN)).toBe(true)
    expect(choose(QUAN)).toBe(false)

    await send(card, toggleCompanyBoardOwner(card, LAN), '1.1')
    expect(platform.card()).toMatchObject({ owners: [LAN], primaryOwner: LAN, participants: [BAO] })

    const claimed = platform.card()
    expect(companyBoardOwnerChoice(claimed, { memberRef: LAN, manages: false })(LAN)).toBe(true)
    await send(claimed, toggleCompanyBoardOwner(claimed, LAN), '1.1')
    expect(platform.card()).toMatchObject({ owners: [], primaryOwner: null, participants: [BAO] })
  })

  it('is offered no owner change on a task someone else owns, which the platform would refuse', async () => {
    const card = v11Card({ owners: [QUAN], primaryOwner: QUAN, participants: [] })
    const choose = companyBoardOwnerChoice(card, { memberRef: LAN, manages: false })

    expect([LAN, QUAN, MINH].some(choose)).toBe(false)

    // The authority agrees: adding themselves next to Quân is denied, and nothing changes.
    const platform = platformAuthority(card, { memberRef: LAN, role: 'member' })
    await expect(send(card, toggleCompanyBoardOwner(card, LAN), '1.1')).rejects.toMatchObject({ code: 'denied' })
    expect(platform.card().owners).toEqual([QUAN])
  })

  it('owners and admins, and a viewer whose role is not known yet, may change anyone until the owner limit', () => {
    const card = v11Card({ owners: [MINH], primaryOwner: MINH })

    expect(companyBoardOwnerChoice(card, { memberRef: MINH, manages: true })(QUAN)).toBe(true)
    expect(companyBoardOwnerChoice(card, { memberRef: MINH })(QUAN)).toBe(true)

    const full = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, '0')}${'A'.repeat(41)}`)
    const crowded = v11Card({ owners: full, primaryOwner: full[0]! })
    const choose = companyBoardOwnerChoice(crowded, { memberRef: MINH, manages: true })

    expect(choose(QUAN)).toBe(false)
    expect(choose(full[3]!)).toBe(true)
  })
})

describe('companyBoardOwnershipPatch', () => {
  it('always carries all three membership fields, with the primary among the owners', () => {
    const card = v1Card({ owners: [MINH, QUAN], primaryOwner: QUAN, participants: [BAO] })

    expect(companyBoardOwnershipPatch(card, [LAN, LAN, MINH])).toEqual({
      owners: [LAN, MINH],
      primaryOwner: LAN,
      participants: [BAO]
    })
    expect(companyBoardOwnershipPatch(card, [MINH, QUAN, LAN])).toEqual({
      owners: [MINH, QUAN, LAN],
      primaryOwner: QUAN,
      participants: [BAO]
    })
  })
})
