import type { MatrixRoom } from '../../../shared/matrix'
import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  type MatrixCompanyPrivateCosCapabilityV13,
  type MatrixCompanyPrivateCosView
} from '../../../shared/matrix-company-private-cos'
import type {
  CompanyAICitation,
  CompanyAIView,
  CompanyBoardCard,
  CompanyBoardColumn,
  CompanyBoardCommand,
  CompanyDesktopAdapter,
  CompanyProjectBrainV4,
  CompanyProtonOrderV2,
  CompanyWalletV2
} from '../company-desktop-adapter'

import { TEAM_COMPANY_ID, TEAM_COS_USER_ID, TEAM_PROJECT_ID } from './team-space-fixtures'

const BOARD_ID = '00000000-0000-4000-8000-320ce5ad961c'
const COS_PRINCIPAL = '00000000-0000-4000-8000-9896148e0625'
const SOURCE_ID = '00000000-0000-4000-8000-7c028b2713e7'
export const COMPANY_AI_CHANNEL_ID = '00000000-0000-4000-8000-a6350151b493'
const CHANNEL_ID = COMPANY_AI_CHANNEL_ID
const MEMBER = 'RiUVmyo5zEPwmNwDTzUkOZ9pssoNpuFAbofjwAsJyS8'
const LAN = 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew'
const QUAN = 'DBmU8tVC5nRl7iK9TD1_HUAMix4-Oxfk7bPM6--O_T8'
const AT = '2026-10-27T03:00:00Z'

const source = (eventId: string, at = AT): CompanyAICitation => ({
  kind: 'channel',
  sourceId: SOURCE_ID,
  channelId: CHANNEL_ID,
  eventId,
  at
})

const humanProvenance = (eventId: string, at = AT) => ({
  origin: 'human' as const,
  actor: { kind: 'human' as const, memberRef: MEMBER },
  at,
  references: [{ kind: 'board_event' as const, eventId, at }]
})

const cosProvenance = (eventId: string, at = AT) => ({
  origin: 'cos' as const,
  actor: { kind: 'cos' as const, agentPrincipal: COS_PRINCIPAL },
  at,
  references: [source(eventId, at)]
})

function card(
  suffix: string,
  title: string,
  status: CompanyBoardColumn,
  patch: Partial<CompanyBoardCard> = {}
): CompanyBoardCard {
  const suggested = status === 'suggested'
  const provenance = suggested
    ? cosProvenance(`$${suffix}:atum.example`)
    : humanProvenance(`77000000-0000-4000-8000-${suffix.padStart(12, '0')}`)
  const citation = suggested ? source(`$${suffix}:atum.example`) : []
  const actor = provenance.actor

  return {
    schemaVersion: 1,
    companyId: TEAM_COMPANY_ID,
    boardId: BOARD_ID,
    cardId: `77000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    displayKey: `tsk_${suffix.padStart(8, '0')}`,
    revision: 1,
    title,
    description: null,
    status,
    accepted: !suggested,
    owners: suggested ? [] : [MEMBER],
    primaryOwner: suggested ? null : MEMBER,
    participants: [],
    due: null,
    projectId: TEAM_PROJECT_ID,
    citations: Array.isArray(citation) ? citation : [citation],
    conversation: suggested ? { channelId: CHANNEL_ID, threadRootEventId: '$launch-root' } : null,
    publicationScope: suggested
      ? {
          kind: 'channel',
          channelId: CHANNEL_ID,
          historyScope: 'shared',
          admissionGeneration: 5,
          scopeDigest: 'a'.repeat(64)
        }
      : { kind: 'company' },
    fieldProvenance: {
      title: provenance,
      description: null,
      owners: provenance,
      due: provenance,
      status: provenance,
      projectTag: provenance
    },
    origin: suggested ? 'cos' : 'human',
    createdBy: actor,
    createdAt: AT,
    updatedBy: actor,
    updatedAt: AT,
    archived: false,
    canEdit: !suggested,
    canPropose: true,
    canAccept: suggested,
    canArchive: !suggested,
    canUndo: !suggested,
    ...patch
  }
}

export const COMPANY_BOARD_FIXTURE_CARDS: CompanyBoardCard[] = [
  card('11', 'Review supplier terms', 'suggested'),
  card('12', 'Send launch draft', 'to_do', {
    owners: [LAN],
    primaryOwner: LAN,
    due: { kind: 'date', date: '2026-10-30', timeZone: 'Asia/Ho_Chi_Minh', originalText: 'Friday' }
  }),
  card('13', 'Polish pricing page', 'in_progress', {
    owners: [MEMBER, QUAN],
    primaryOwner: MEMBER,
    due: { kind: 'date', date: '2026-10-29', timeZone: 'Asia/Ho_Chi_Minh', originalText: 'Wednesday' }
  }),
  card('14', 'Confirm support rota', 'blocked', {
    owners: [QUAN],
    primaryOwner: QUAN,
    citations: [source('$brief-root', '2026-10-27T02:30:00Z')],
    conversation: { channelId: CHANNEL_ID, threadRootEventId: '$brief-root' },
    publicationScope: {
      kind: 'channel',
      channelId: CHANNEL_ID,
      historyScope: 'shared',
      admissionGeneration: 5,
      scopeDigest: 'b'.repeat(64)
    },
    due: { kind: 'date', date: '2026-10-24', timeZone: 'Asia/Ho_Chi_Minh', originalText: 'last Friday' },
    origin: 'cos',
    createdBy: { kind: 'cos', agentPrincipal: COS_PRINCIPAL },
    updatedBy: { kind: 'cos', agentPrincipal: COS_PRINCIPAL },
    canUndo: true
  }),
  card('15', 'Publish mobile fixes', 'done', { owners: [MEMBER], primaryOwner: MEMBER })
]

export const COMPANY_AI_ANSWER_FIXTURE = {
  schemaVersion: 1 as const,
  companyId: TEAM_COMPANY_ID,
  channelId: CHANNEL_ID,
  threadRootEventId: '$launch-root',
  triggerEventId: '$mention:atum.example',
  taskId: '00000000-0000-4000-8000-eb4362c069a7',
  scopeDigest: 'c'.repeat(64),
  correctionRevision: 0,
  text: 'Release B includes the company board, cited project brief, and shared Chief of Staff.',
  citations: [source('$brief-root', '2026-10-27T02:30:00Z')],
  coverage: { state: 'live' as const, asOf: '2026-10-27T03:00:00Z', gaps: [] }
}

export const COMPANY_BRAIN_FIXTURE: CompanyProjectBrainV4 = {
  schemaVersion: 4,
  companyId: TEAM_COMPANY_ID,
  projectId: TEAM_PROJECT_ID,
  authorityGeneration: 8,
  sourceGeneration: 3,
  publicationGeneration: 2,
  boardRevision: 4,
  projectionRevision: 2,
  coverage: {
    state: 'live',
    sourceAsOf: '2026-10-27T03:00:00Z',
    boardAsOf: '2026-10-27T03:05:00Z',
    lastCheckedAt: '2026-10-27T03:06:00Z',
    gaps: []
  },
  brief: {
    version: 1,
    asOf: '2026-10-27T03:00:00Z',
    freshness: {
      sourceAsOf: '2026-10-27T03:00:00Z',
      boardAsOf: '2026-10-27T03:05:00Z',
      boardRevision: 4,
      cardRevisionDigest: 'a'.repeat(64),
      evidenceDigest: 'b'.repeat(64)
    },
    goal: {
      displayName: 'Release B',
      text: 'Ship the company board and cited summary.',
      citation: source('$launch-root', '2026-10-27T02:00:00Z')
    },
    tasks: {
      accepted: [
        {
          cardId: COMPANY_BOARD_FIXTURE_CARDS[3]!.cardId,
          cardRevision: 1,
          title: COMPANY_BOARD_FIXTURE_CARDS[3]!.title,
          status: 'blocked',
          accepted: true,
          primaryOwner: QUAN,
          due: COMPANY_BOARD_FIXTURE_CARDS[3]!.due,
          sourceThreadEventId: '$brief-root'
        }
      ],
      suggested: [
        {
          cardId: COMPANY_BOARD_FIXTURE_CARDS[0]!.cardId,
          cardRevision: 1,
          title: COMPANY_BOARD_FIXTURE_CARDS[0]!.title,
          status: 'suggested',
          accepted: false,
          primaryOwner: null,
          due: null,
          sourceThreadEventId: '$launch-root'
        }
      ],
      overdueAcceptedCount: 1
    },
    decisions: [
      {
        itemId: 'c'.repeat(64),
        excerpt: 'Release B includes the master company board.',
        citation: source('$brief-root', '2026-10-27T02:30:00Z'),
        assertion: 'source'
      }
    ],
    openQuestions: [
      {
        itemId: 'd'.repeat(64),
        excerpt: 'Who reviews the final supplier terms?',
        citation: source('$launch-root', '2026-10-27T02:40:00Z'),
        assertion: 'source'
      }
    ],
    fileNotes: [],
    corrections: []
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function playgroundCompanyDesktopAdapter(member = false): CompanyDesktopAdapter {
  let cards = clone(COMPANY_BOARD_FIXTURE_CARDS)
  let boardRevision = 4

  let ai: CompanyAIView = {
    schemaVersion: 1,
    companyId: TEAM_COMPANY_ID,
    agent: { principal: COS_PRINCIPAL, userId: TEAM_COS_USER_ID, displayName: 'Chief of Staff' },
    enabled: true,
    revision: 1,
    state: 'ready',
    canManage: !member
  }

  let order: CompanyProtonOrderV2 | undefined

  const wallet: CompanyWalletV2 = {
    schemaVersion: 2,
    companyId: TEAM_COMPANY_ID,
    unit: 'micro_proton',
    balances: {
      paid: 500_000_000_000,
      earned: 0,
      promo: 5_000_000_000,
      held: 20_000_000_000,
      available: 485_000_000_000
    },
    checkoutOpen: true,
    canTopUp: true,
    aiEnabled: true,
    policyRevision: 1
  }

  const update = (command: CompanyBoardCommand) => {
    const current = cards.find(card => card.cardId === command.cardId)

    if (command.operation === 'create') {
      const created = card(command.cardId.slice(-2), command.title, 'to_do', {
        cardId: command.cardId,
        displayKey: `tsk_${command.cardId.slice(-8)}`,
        description: command.description ?? null,
        projectId: command.projectId ?? null
      })

      cards = [created, ...cards]
      boardRevision += 1

      return created
    }

    if (!current) {
      throw new Error('not_found')
    }

    let next = current

    if (command.operation === 'accept') {
      next = {
        ...current,
        status: command.status,
        accepted: true,
        canAccept: false,
        canEdit: true,
        revision: current.revision + 1
      }
    } else if (command.operation === 'patch') {
      const status = command.patch.status ?? current.status
      next = { ...current, ...command.patch, status, accepted: status !== 'suggested', revision: current.revision + 1 }
    } else if (command.operation === 'archive') {
      next = { ...current, archived: command.archived, revision: current.revision + 1 }
    } else {
      next = { ...current, revision: current.revision + 1 }
    }

    cards = cards.map(item => (item.cardId === next.cardId ? next : item))
    boardRevision += 1

    return next
  }

  return {
    async readBoardView(companyId) {
      return clone({
        schemaVersion: 1,
        companyId,
        boardId: BOARD_ID,
        revision: boardRevision,
        columns: ['suggested', 'to_do', 'in_progress', 'blocked', 'done'] as const
      })
    },
    async listBoard(companyId, filters) {
      let visible = companyId === TEAM_COMPANY_ID ? cards.filter(card => !card.archived) : []

      if (filters.projectId) {
        visible = visible.filter(card => card.projectId === filters.projectId)
      }

      if (filters.ownerMemberRef) {
        visible = visible.filter(card => card.owners.includes(filters.ownerMemberRef!))
      }

      if (filters.due === 'no_due') {
        visible = visible.filter(card => card.due === null)
      }

      if (filters.due === 'overdue') {
        visible = visible.filter(card => card.due?.kind === 'date' && card.due.date < '2026-10-27')
      }

      if (filters.due === 'due_soon') {
        visible = visible.filter(
          card => card.due !== null && (card.due.kind !== 'date' || card.due.date >= '2026-10-27')
        )
      }

      return clone({
        contractVersion: '1' as const,
        schemaVersion: 1,
        board: {
          schemaVersion: 1,
          companyId,
          boardId: BOARD_ID,
          revision: boardRevision,
          columns: ['suggested', 'to_do', 'in_progress', 'blocked', 'done'] as const
        },
        cards: visible,
        nextCursor: null
      })
    },
    async readBoardCard(_companyId, cardId) {
      const found = cards.find(card => card.cardId === cardId)

      if (!found) {
        throw new Error('not_found')
      }

      return clone(found)
    },
    async searchBoard() {
      throw new Error('not_supported')
    },
    async readBoardActivity() {
      throw new Error('not_supported')
    },
    async commandBoard(_companyId, command) {
      return { schemaVersion: 1, duplicate: false, card: clone(update(command)) }
    },
    async openBoardAttachment() {
      throw new Error('not_supported')
    },
    async readProjectBrain() {
      return clone(COMPANY_BRAIN_FIXTURE)
    },
    async correctProjectBrain(_companyId, _projectId, request) {
      const next = clone(COMPANY_BRAIN_FIXTURE)

      if (next.brief) {
        next.brief = {
          ...next.brief,
          version: next.brief.version + 1,
          corrections: [
            ...next.brief.corrections,
            {
              correctionId: request.requestId,
              createdVersion: next.brief.version + 1,
              targetKind: request.targetKind,
              targetItemId: request.targetItemId,
              text: request.text,
              authorMemberRef: MEMBER,
              createdAt: '2026-10-27T03:10:00Z',
              carried: true
            }
          ]
        }
      }

      return next
    },
    async openCitation() {},
    async readAI() {
      return clone(ai)
    },
    async configureAI(_companyId, request) {
      ai = { ...ai, enabled: request.enabled, revision: ai.revision + 1, state: request.enabled ? 'ready' : 'paused' }

      return clone(ai)
    },
    async readWallet() {
      if (member) {
        throw { code: 'denied' }
      }

      return clone(wallet)
    },
    async readPacks() {
      if (member) {
        throw { code: 'denied' }
      }

      return {
        schemaVersion: 2,
        companyId: TEAM_COMPANY_ID,
        packs: [
          {
            schemaVersion: 2,
            packId: 'protons-100k',
            protons: 100_000,
            paidMicroProtons: 95_000_000_000,
            promoMicroProtons: 5_000_000_000,
            totalMicroProtons: 100_000_000_000,
            amountVnd: 95_000
          },
          {
            schemaVersion: 2,
            packId: 'protons-500k',
            protons: 500_000,
            paidMicroProtons: 395_000_000_000,
            promoMicroProtons: 105_000_000_000,
            totalMicroProtons: 500_000_000_000,
            amountVnd: 395_000
          }
        ]
      }
    },
    async createOrder(_companyId, request) {
      if (member) {
        throw { code: 'denied' }
      }

      const pack = request.packId === 'protons-500k' ? 500_000 : 100_000
      order = {
        schemaVersion: 2,
        companyId: TEAM_COMPANY_ID,
        orderId: '00000000-0000-4000-8000-2f5656bb7927',
        packId: request.packId,
        protons: pack,
        state: 'pending',
        credited: false
      }

      return clone(order)
    },
    async readOrder() {
      if (!order) {
        throw new Error('not_found')
      }

      return clone(order)
    },
    async openOrder() {},
    async readPendingFund() {
      return { pending: null }
    },
    async fundFromMember(_companyId, request) {
      if (member) {
        throw { code: 'denied' }
      }

      const amount = request.protons * 1_000_000
      const fromPromo = Math.min(amount, 30_000_000)
      wallet.balances = {
        ...wallet.balances,
        promo: wallet.balances.promo + fromPromo,
        paid: wallet.balances.paid + amount - fromPromo,
        available: wallet.balances.available + amount
      }

      return clone({
        schemaVersion: 2 as const,
        companyId: TEAM_COMPANY_ID,
        requestId: request.requestId,
        protons: request.protons,
        amountMicroProtons: amount,
        fromPromoMicroProtons: fromPromo,
        fromPaidMicroProtons: amount - fromPromo,
        wallet
      })
    }
  }
}

/**
 * `?scenario=team-space-private-cos&company=team`: the person's private chat with the company's Chief of
 * Staff (private-cos/1.3), bound by the platform and open in the workspace. Dev only.
 */
export const PLAYGROUND_PRIVATE_COS_ROOM_ID = '!private-cos:example.invalid'

const PRIVATE_COS_MEMBER = '00000000-0000-4000-8000-4af9a86e17b6'
const PRIVATE_COS_INCARNATION = '00000000-0000-4000-8000-ae985e49793d'
const PRIVATE_COS_EXECUTOR = '00000000-0000-4000-8000-f4d6b5ede7d6'
const PRIVATE_COS_MANAGER = '@atum-team-space:atum.example'

export function playgroundPrivateCosRoom(ownerUserId: string, lastActiveAt: number): MatrixRoom {
  return {
    id: PLAYGROUND_PRIVATE_COS_ROOM_ID,
    name: 'Chief of Staff',
    membership: 'join',
    encrypted: false,
    plainAgent: true,
    roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
    roomVersion: '11',
    companyPrivateCos: {
      v: 1,
      classification: 'company_private_cos',
      companyId: TEAM_COMPANY_ID,
      membershipIncarnation: PRIVATE_COS_INCARNATION,
      executorId: PRIVATE_COS_EXECUTOR
    },
    joinRule: 'invite',
    historyVisibility: 'joined',
    lastActiveAt,
    participants: [
      { userId: ownerUserId, membership: 'join' },
      { userId: TEAM_COS_USER_ID, membership: 'join' }
    ],
    powerLevels: {
      users: { [PRIVATE_COS_MANAGER]: 100, [ownerUserId]: 0, [TEAM_COS_USER_ID]: 0 },
      users_default: 0,
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      events: {}
    }
  }
}

/** The platform's private-CoS answers for the playground's company: ready, bound to the room above. */
export function withPlaygroundPrivateCos(adapter: CompanyDesktopAdapter): CompanyDesktopAdapter {
  const pair = {
    companyPrincipal: TEAM_COMPANY_ID,
    memberPrincipal: PRIVATE_COS_MEMBER,
    membershipIncarnation: PRIVATE_COS_INCARNATION
  }

  const view: MatrixCompanyPrivateCosView = {
    schemaVersion: 1,
    state: 'ready',
    pair,
    greetingState: 'published',
    binding: {
      scope: { pair, authorityEpoch: 1, contextEpoch: 1, homeGeneration: 1 },
      agentPrincipal: COS_PRINCIPAL,
      agentUserId: TEAM_COS_USER_ID,
      executorId: PRIVATE_COS_EXECUTOR,
      homeId: '00000000-0000-4000-8000-966eff851862',
      roomId: PLAYGROUND_PRIVATE_COS_ROOM_ID,
      storeGeneration: 1,
      profileDigest: 'a'.repeat(64)
    }
  }

  const capability: MatrixCompanyPrivateCosCapabilityV13 = {
    schemaVersion: 4,
    profile: 'atum.company-private-cos/1.3',
    capability: 'company.private-cos',
    supportedProfiles: [
      'atum.company-private-cos/1',
      'atum.company-private-cos/1.1',
      'atum.company-private-cos/1.2',
      'atum.company-private-cos/1.3'
    ],
    wire: { header: 'Atum-Company-Wire', value: '1.3' },
    displayName: 'Chief of Staff',
    teamDmPosition: 2,
    lazyCreation: true,
    fundingKind: 'company_wallet',
    separatePrice: false,
    purgeAfterDays: 30,
    userExport: false,
    roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
    roomName: 'Chief of Staff',
    roomEncrypted: false,
    greetingVersion: 2,
    ensureLocale: true
  }

  return {
    ...adapter,
    readPrivateCosCapability: async () => capability,
    readPrivateCos: async () => view,
    ensurePrivateCos: async () => view,
    readPrivateCosReceipt: async () => {throw new Error('matrix_company_private_cos_unavailable')},
    stopPrivateCos: async () => {throw new Error('matrix_company_private_cos_unavailable')}
  }
}
