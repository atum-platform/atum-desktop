import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { CompanyBoard } from './company-board'
import type {
  CompanyBoardActivityEvent,
  CompanyBoardCard,
  CompanyBoardCommand,
  CompanyBoardCommandResponse,
  CompanyBoardPage,
  CompanyDesktopAdapter
} from './company-desktop-adapter'
import { $companySpacePreferences } from './company-space-store'

const actor = { kind: 'human' as const, memberRef: 'member-1' }

const provenance = {
  origin: 'human' as const,
  actor,
  at: '2026-10-29T08:00:00.000Z',
  references: []
}

function boardCard(overrides: Partial<CompanyBoardCard> = {}): CompanyBoardCard {
  return {
    schemaVersion: 1,
    companyId: 'company-1',
    boardId: 'board-1',
    cardId: 'card-1',
    displayKey: 'ATUM-1',
    revision: 3,
    title: 'Welcome to your board',
    description: null,
    status: 'to_do',
    accepted: true,
    owners: [],
    primaryOwner: null,
    participants: [],
    due: null,
    projectId: null,
    citations: [],
    conversation: null,
    publicationScope: { kind: 'company' },
    fieldProvenance: {
      title: provenance,
      description: null,
      owners: provenance,
      due: provenance,
      status: provenance,
      projectTag: null
    },
    origin: 'human',
    createdBy: actor,
    createdAt: '2026-10-29T08:00:00.000Z',
    updatedBy: actor,
    updatedAt: '2026-10-29T08:00:00.000Z',
    archived: false,
    canEdit: true,
    canPropose: false,
    canAccept: false,
    canArchive: true,
    canUndo: false,
    ...overrides
  }
}

function boardCardV11(overrides: Partial<CompanyBoardCard> = {}): CompanyBoardCard {
  return boardCard({
    priority: 'normal',
    checklist: [],
    attachments: [],
    extensionProvenance: {
      priority: provenance,
      checklist: provenance,
      attachments: provenance
    },
    ...overrides
  })
}

function boardPage(
  cards: CompanyBoardCard[],
  revision = 9,
  contractVersion: CompanyBoardPage['contractVersion'] = cards.some(card => card.priority !== undefined) ? '1.1' : '1'
): CompanyBoardPage {
  return {
    contractVersion,
    schemaVersion: 1,
    board: {
      schemaVersion: 1,
      companyId: 'company-1',
      boardId: 'board-1',
      revision,
      columns: ['suggested', 'to_do', 'in_progress', 'blocked', 'done']
    },
    cards,
    nextCursor: null
  }
}

function unused(): never {
  throw new Error('Unexpected adapter call')
}

interface FixtureOptions {
  citationChannels?: Readonly<Record<string, string>>
  listBoard?: CompanyDesktopAdapter['listBoard']
  members?: Array<{ memberRef: string; displayName: string }>
  openBoardAttachment?: CompanyDesktopAdapter['openBoardAttachment']
  readBoardActivity?: CompanyDesktopAdapter['readBoardActivity']
  readBoardView?: CompanyDesktopAdapter['readBoardView']
  searchBoard?: CompanyDesktopAdapter['searchBoard']
  scope?: string
  viewerManages?: boolean
  viewerMemberRef?: string
}

function fixture(
  cards: CompanyBoardCard[],
  commandBoard: CompanyDesktopAdapter['commandBoard'],
  options: FixtureOptions = {}
) {
  const adapter = {
    listBoard: options.listBoard ?? vi.fn(async () => boardPage(cards)),
    readBoardView: options.readBoardView ?? vi.fn(async () => boardPage(cards).board),
    readBoardCard: vi.fn(async () => unused()),
    searchBoard: options.searchBoard ?? vi.fn(async () => unused()),
    readBoardActivity: options.readBoardActivity ?? vi.fn(async (_companyId, cardId) => ({
      schemaVersion: 1 as const,
      cardId,
      events: [],
      nextCursor: null
    })),
    commandBoard,
    openBoardAttachment: options.openBoardAttachment ?? vi.fn(async () => {}),
    readProjectBrain: vi.fn(async () => unused()),
    correctProjectBrain: vi.fn(async () => unused()),
    openCitation: vi.fn(async () => {}),
    readAI: vi.fn(async () => unused()),
    configureAI: vi.fn(async () => unused()),
    readWallet: vi.fn(async () => unused()),
    readPacks: vi.fn(async () => unused()),
    createOrder: vi.fn(async () => unused()),
    readOrder: vi.fn(async () => unused()),
    openOrder: vi.fn(async () => {}),
    fundFromMember: vi.fn(async () => unused()),
    readPendingFund: vi.fn(async () => ({ pending: null }))
  } satisfies CompanyDesktopAdapter

  const matrixWindow = window as unknown as { atumMatrix: unknown }

  matrixWindow.atumMatrix = { companyDesktop: adapter }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CompanyBoard
        citationChannels={options.citationChannels}
        companyId="company-1"
        members={options.members ?? []}
        projects={[]}
        scope={options.scope ?? 'company-1'}
        viewerManages={options.viewerManages}
        viewerMemberRef={options.viewerMemberRef}
      />
    </I18nProvider>
  )

  return adapter
}

function patchResponse(card: CompanyBoardCard, patch: Extract<CompanyBoardCommand, { operation: 'patch' }>['patch']) {
  return {
    schemaVersion: 1 as const,
    duplicate: false,
    card: { ...card, ...patch, revision: card.revision + 1 }
  }
}

function archiveResponse(card: CompanyBoardCard): CompanyBoardCommandResponse {
  return {
    schemaVersion: 1,
    duplicate: false,
    card: { ...card, archived: true, revision: card.revision + 1 }
  }
}

beforeEach(() => {
  $companySpacePreferences.set({})
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { atumMatrix?: unknown }).atumMatrix
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('company board owners', () => {
  const members = [
    { memberRef: 'member-1', displayName: 'Minh' },
    { memberRef: 'member-2', displayName: 'Quân' },
    { memberRef: 'member-3', displayName: 'Lan' }
  ]

  async function openOwners(card: CompanyBoardCard) {
    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    const trigger = within(detail).getByRole('button', { name: /^Owner:/ })

    return { detail, trigger }
  }

  // The open menu hides the rest of the window from the accessibility tree, so read the trigger directly.
  const ownerLabel = (detail: HTMLElement) =>
    detail.querySelector('[data-company-card-owners]')?.getAttribute('aria-label')

  it('shows every owner, primary first, and adds a co-owner without dropping anyone', async () => {
    const card = boardCard({ owners: ['member-2', 'member-1'], primaryOwner: 'member-1', participants: ['member-3'] })
    const commandBoard = vi.fn(async (_companyId: string, command: CompanyBoardCommand) =>
      patchResponse(card, (command as Extract<CompanyBoardCommand, { operation: 'patch' }>).patch)
    )
    fixture([card], commandBoard, { members, viewerManages: true, viewerMemberRef: 'member-1' })

    const { detail, trigger } = await openOwners(card)
    expect(trigger.getAttribute('aria-label')).toBe('Owner: Minh, Quân')

    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitemcheckbox').map(item => item.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'false'
    ])
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Lan' }))

    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        'company-1',
        expect.objectContaining({
          operation: 'patch',
          expectedCardRevision: card.revision,
          patch: { owners: ['member-2', 'member-1', 'member-3'], primaryOwner: 'member-1', participants: ['member-3'] }
        })
      )
    )
    // The menu stays open for the next pick, and the panel already names all three.
    expect(screen.getByRole('menu')).toBeTruthy()
    await waitFor(() =>
      expect(ownerLabel(detail)).toBe('Owner: Minh, Quân, Lan')
    )
  })

  it('rolls a refused owner change back to every owner it had', async () => {
    const card = boardCard({ owners: ['member-1', 'member-2'], primaryOwner: 'member-1' })
    let rejectCommand!: (reason: Error) => void
    const command = new Promise<CompanyBoardCommandResponse>((_resolve, reject) => {
      rejectCommand = reject
    })
    fixture([card], vi.fn(() => command), { members, viewerManages: true })

    const { detail, trigger } = await openOwners(card)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'Minh' }))

    expect(ownerLabel(detail)).toBe('Owner: Quân')
    // While it is in flight, nothing else can be picked (a second pick would be lost).
    expect(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'Lan' }).getAttribute('aria-disabled')).toBe('true')

    await act(async () => rejectCommand(new Error('denied')))
    expect(ownerLabel(detail)).toBe('Owner: Minh, Quân')
    expect(screen.getByRole('alert').textContent).toContain('Board is unavailable.')
  })

  it('shows the current card when the owner change met a newer revision', async () => {
    const card = boardCardV11({ owners: ['member-1'], primaryOwner: 'member-1' })
    const current = boardCardV11({ owners: ['member-1', 'member-2'], primaryOwner: 'member-1', revision: card.revision + 1 })
    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'conflict' as const,
      reason: 'stale_card_revision' as const,
      cardId: card.cardId,
      expectedCardRevision: card.revision,
      currentCardRevision: current.revision,
      currentCard: current
    }))
    fixture([card], commandBoard as unknown as CompanyDesktopAdapter['commandBoard'], { members, viewerManages: true })

    const { detail, trigger } = await openOwners(card)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'Lan' }))

    await waitFor(() => expect(ownerLabel(detail)).toBe('Owner: Minh, Quân'))
    expect(screen.getByText('This task changed. The latest version is shown.')).toBeTruthy()
  })

  it('holds every other card’s owner picks while one card’s change is running, then takes them', async () => {
    const cardA = boardCard({ owners: ['member-1'], primaryOwner: 'member-1' })
    const cardB = boardCard({ cardId: 'card-2', displayKey: 'ATUM-2', title: 'Second task', owners: [], primaryOwner: null })
    let resolveA!: (value: CompanyBoardCommandResponse) => void

    const commandBoard = vi.fn((_companyId: string, command: CompanyBoardCommand) =>
      command.cardId === cardA.cardId
        ? new Promise<CompanyBoardCommandResponse>(resolve => {
            resolveA = resolve
          })
        : Promise.resolve(patchResponse(cardB, (command as Extract<CompanyBoardCommand, { operation: 'patch' }>).patch)))

    fixture([cardA, cardB], commandBoard, { members, viewerManages: true })

    // Card A's change goes out and stays in flight.
    fireEvent.click(await screen.findByText(cardA.title))
    const detailA = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.change(within(detailA).getByRole('combobox', { name: 'Status' }), { target: { value: 'in_progress' } })
    expect(commandBoard).toHaveBeenCalledTimes(1)

    // Card B's panel: every control that would send a change is visibly disabled, not silently ignored.
    fireEvent.click(screen.getByText(cardB.title))

    const detailB = await waitFor(() => {
      const found = screen.getByRole('complementary', { name: 'Task details' })
      expect(found.getAttribute('data-company-card-detail')).toBe(cardB.cardId)

      return found
    })

    expect((within(detailB).getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).disabled).toBe(true)

    const trigger = within(detailB).getByRole('button', { name: /^Owner:/ })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const held = within(await screen.findByRole('menu')).getByRole('menuitemcheckbox', { name: 'Lan' })
    expect(held.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(held)
    expect(commandBoard).toHaveBeenCalledTimes(1)

    // Once A settles, B's pick goes through, with its complete ownership patch.
    await act(async () => resolveA(patchResponse(cardA, { status: 'in_progress' })))
    const lan = within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: 'Lan' })
    await waitFor(() => expect(lan.getAttribute('aria-disabled')).toBeNull())
    fireEvent.click(lan)
    await waitFor(() =>
      expect(commandBoard).toHaveBeenLastCalledWith(
        'company-1',
        expect.objectContaining({
          cardId: cardB.cardId,
          patch: { owners: ['member-3'], primaryOwner: 'member-3', participants: [] }
        })
      )
    )
    expect(commandBoard).toHaveBeenCalledTimes(2)
  })

  it('lets a member claim an unowned task, and only themselves', async () => {
    const card = boardCard({ owners: [], primaryOwner: null })
    const commandBoard = vi.fn(async (_companyId: string, command: CompanyBoardCommand) =>
      patchResponse(card, (command as Extract<CompanyBoardCommand, { operation: 'patch' }>).patch)
    )
    fixture([card], commandBoard, { members, viewerManages: false, viewerMemberRef: 'member-3' })

    const { trigger } = await openOwners(card)
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(1)
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Lan' }))

    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        'company-1',
        expect.objectContaining({ patch: { owners: ['member-3'], primaryOwner: 'member-3', participants: [] } })
      )
    )
  })

  it('gives a member no owner change on a task someone else owns', async () => {
    const card = boardCard({ owners: ['member-2'], primaryOwner: 'member-2' })
    const commandBoard = vi.fn(async () => unused())
    fixture([card], commandBoard, { members, viewerManages: false, viewerMemberRef: 'member-3' })

    const { trigger } = await openOwners(card)
    expect(trigger.getAttribute('aria-label')).toBe('Owner: Quân')
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    expect(commandBoard).not.toHaveBeenCalled()
  })
})

describe('a suggested task in its panel', () => {
  it('offers Dismiss beside Accept, and Dismiss archives the suggestion', async () => {
    const card = boardCard({
      status: 'suggested',
      accepted: false,
      origin: 'cos',
      createdBy: { kind: 'cos', agentPrincipal: 'agent-1' },
      canAccept: true,
      canArchive: true
    })
    const commandBoard = vi.fn(async () => archiveResponse(card))
    fixture([card], commandBoard)

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    const actions = detail.querySelector('[data-company-card-suggestion]') as HTMLElement
    expect(within(actions).getAllByRole('button').map(button => button.textContent)).toEqual(['Accept', 'Dismiss'])

    fireEvent.click(within(actions).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        'company-1',
        expect.objectContaining({ operation: 'archive', cardId: card.cardId, archived: true })
      )
    )
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull())
  })

  it('brings a dismissed suggestion back, as it now stands, when someone changed it first', async () => {
    const card = boardCardV11({
      status: 'suggested',
      accepted: false,
      origin: 'cos',
      createdBy: { kind: 'cos', agentPrincipal: 'agent-1' },
      canAccept: true,
      canArchive: true
    })

    const current = { ...card, title: 'Renamed by Quân', revision: card.revision + 1 }

    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'conflict' as const,
      reason: 'stale_card_revision' as const,
      cardId: card.cardId,
      expectedCardRevision: card.revision,
      currentCardRevision: current.revision,
      currentCard: current
    }))

    fixture([card], commandBoard as unknown as CompanyDesktopAdapter['commandBoard'])

    fireEvent.click(await screen.findByText(card.title))

    const detail = await screen.findByRole('complementary', { name: 'Task details' })

    fireEvent.click(within(detail).getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ operation: 'archive', cardId: card.cardId }),
      '1.1'
    ))
    // Not archived: it is back on the board in its current version, with the existing conflict notice.
    expect(await screen.findByText('This task changed. The latest version is shown.')).toBeTruthy()
    expect(screen.getAllByText('Renamed by Quân').length).toBeGreaterThan(0)
    expect(screen.queryByText(card.title)).toBeNull()
    expect(screen.getByRole('alert').getAttribute('data-company-board-conflict')).toBe(card.cardId)
  })

  it('offers no Dismiss on an accepted task', async () => {
    const card = boardCard()
    fixture([card], vi.fn(async () => unused()))

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    expect(within(detail).queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })
})

describe('company board archive', () => {
  it('shows Archive only for cards the board marks archivable', async () => {
    const archivable = boardCard()
    const fixed = boardCard({ cardId: 'card-2', displayKey: 'ATUM-2', title: 'Keep me', canArchive: false })
    fixture([archivable, fixed], vi.fn(async () => archiveResponse(archivable)))

    expect(await screen.findByRole('button', { name: 'Archive: Welcome to your board' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive: Keep me' })).toBeNull()
  })

  it('removes the card optimistically and dispatches the archive command', async () => {
    const card = boardCard()
    let resolveCommand!: (value: CompanyBoardCommandResponse) => void

    const command = new Promise<CompanyBoardCommandResponse>(resolve => {
      resolveCommand = resolve
    })

    const commandBoard = vi.fn(() => command)
    fixture([card], commandBoard)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive: Welcome to your board' }))

    expect(screen.queryByText('Welcome to your board')).toBeNull()
    expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'archive',
        cardId: 'card-1',
        expectedCardRevision: 3,
        archived: true
      })
    )

    await act(async () => resolveCommand(archiveResponse(card)))
    expect(screen.queryByText('Welcome to your board')).toBeNull()
  })

  it('keeps the archive control keyboard reachable without opening card details', async () => {
    const card = boardCard()
    const commandBoard = vi.fn(async () => archiveResponse(card))
    fixture([card], commandBoard)
    const archive = await screen.findByRole('button', { name: 'Archive: Welcome to your board' })

    archive.focus()
    fireEvent.keyDown(archive, { key: 'Enter' })
    expect(screen.queryByLabelText('Task details')).toBeNull()
    fireEvent.keyUp(archive, { key: 'Enter' })
    fireEvent.click(archive)

    await waitFor(() => expect(commandBoard).toHaveBeenCalledOnce())
    expect(screen.queryByText('Welcome to your board')).toBeNull()
  })

  it('restores the card and uses the existing board error state when archive fails', async () => {
    const card = boardCard()
    fixture([card], vi.fn(async () => Promise.reject(new Error('offline'))))

    fireEvent.click(await screen.findByRole('button', { name: 'Archive: Welcome to your board' }))

    expect(await screen.findByText('Welcome to your board')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Board is unavailable.')
  })
})

describe('company board inline editing', () => {
  it.each(['Enter', 'blur'] as const)('saves a title on %s with an optimistic revision-fenced patch', async finish => {
    const card = boardCard()
    let resolveCommand!: (value: CompanyBoardCommandResponse) => void

    const command = new Promise<CompanyBoardCommandResponse>(resolve => {
      resolveCommand = resolve
    })

    const commandBoard = vi.fn(() => command)
    fixture([card], commandBoard)

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: `Edit title: ${card.title}` }))
    const input = within(detail).getByRole('textbox', { name: 'Task title' })
    fireEvent.change(input, { target: { value: 'Ship the launch plan' } })

    if (finish === 'Enter') {
      fireEvent.keyDown(input, { key: 'Enter' })
    } else {
      fireEvent.blur(input)
    }

    expect(within(detail).getByRole('button', { name: 'Edit title: Ship the launch plan' })).not.toBeNull()
    expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'patch',
        cardId: card.cardId,
        expectedCardRevision: card.revision,
        patch: { title: 'Ship the launch plan' }
      })
    )

    await act(async () => resolveCommand(patchResponse(card, { title: 'Ship the launch plan' })))
  })

  it('enters description editing from the keyboard and saves with Cmd/Ctrl+Enter', async () => {
    const card = boardCard({ description: 'First draft' })

    const commandBoard = vi.fn(async (_companyId: string, command: CompanyBoardCommand) =>
      patchResponse(card, command.operation === 'patch' ? command.patch : {})
    )

    fixture([card], commandBoard)

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    const description = within(detail).getByRole('button', { name: 'Edit description: First draft' })
    description.focus()
    fireEvent.keyDown(description, { key: 'Enter' })

    const editor = within(detail).getByRole('textbox', { name: 'Description' })
    fireEvent.change(editor, { target: { value: 'Ready for review' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        'company-1',
        expect.objectContaining({
          operation: 'patch',
          expectedCardRevision: card.revision,
          patch: { description: 'Ready for review' }
        })
      )
    )
    expect(within(detail).getByRole('button', { name: 'Edit description: Ready for review' })).not.toBeNull()
  })

  it('cancels an edit with Escape without dispatching a command', async () => {
    const card = boardCard()
    const commandBoard = vi.fn(async () => patchResponse(card, { title: 'Wrong' }))
    fixture([card], commandBoard)

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: `Edit title: ${card.title}` }))
    const input = within(detail).getByRole('textbox', { name: 'Task title' })
    fireEvent.change(input, { target: { value: 'Do not save' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(within(detail).getByRole('button', { name: `Edit title: ${card.title}` })).not.toBeNull()
    expect(commandBoard).not.toHaveBeenCalled()
  })

  it('keeps title and description read-only without the card edit permission', async () => {
    const card = boardCard({ canEdit: false, description: 'Read only details' })
    fixture([card], vi.fn(async () => unused()))

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })

    expect(within(detail).queryByRole('button', { name: /Edit title/u })).toBeNull()
    expect(within(detail).queryByRole('button', { name: /Edit description/u })).toBeNull()
    expect(within(detail).getByText('Read only details')).not.toBeNull()
  })

  it('rolls an optimistic edit back through the existing board failure path', async () => {
    const card = boardCard()
    let rejectCommand!: (reason: Error) => void

    const command = new Promise<CompanyBoardCommandResponse>((_resolve, reject) => {
      rejectCommand = reject
    })

    fixture([card], vi.fn(() => command))

    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: `Edit title: ${card.title}` }))
    const input = within(detail).getByRole('textbox', { name: 'Task title' })
    fireEvent.change(input, { target: { value: 'Optimistic title' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(within(detail).getByRole('button', { name: 'Edit title: Optimistic title' })).not.toBeNull()
    await act(async () => rejectCommand(new Error('conflict')))
    expect(within(detail).getByRole('button', { name: `Edit title: ${card.title}` })).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Board is unavailable.')
  })

  it('defers a live refresh while a title edit is in progress and reconciles after cancel', async () => {
    vi.useFakeTimers()
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('visible')

    const card = boardCard()
    const remote = boardCard({ revision: 4, title: 'Remote title' })
    const listBoard = vi.fn().mockResolvedValueOnce(boardPage([card])).mockResolvedValue(boardPage([remote], 10))
    const readBoardView = vi.fn(async () => boardPage([remote], 10).board)
    fixture([card], vi.fn(async () => unused()), { listBoard, readBoardView })

    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByText(card.title))
    const detail = screen.getByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: `Edit title: ${card.title}` }))

    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(readBoardView).toHaveBeenCalledOnce()
    expect(listBoard).toHaveBeenCalledOnce()
    expect(within(detail).getByRole('textbox', { name: 'Task title' })).not.toBeNull()

    fireEvent.keyDown(within(detail).getByRole('textbox', { name: 'Task title' }), { key: 'Escape' })
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(listBoard).toHaveBeenCalledTimes(2)
    expect(within(detail).getByRole('button', { name: 'Edit title: Remote title' })).not.toBeNull()
  })
})

describe('company board My tasks view', () => {
  it('requests the viewer owner filter and keeps other owners out of the compact list', async () => {
    const mine = boardCard({ owners: ['member-1'], primaryOwner: 'member-1' })
    const theirs = boardCard({ cardId: 'card-2', displayKey: 'ATUM-2', owners: ['member-2'], title: 'Their task' })
    const cards = [mine, theirs]

    const listBoard = vi.fn(async (_companyId: string, filters: Parameters<CompanyDesktopAdapter['listBoard']>[1]) =>
      boardPage(filters.ownerMemberRef ? cards.filter(card => card.owners.includes(filters.ownerMemberRef!)) : cards)
    )

    fixture(cards, vi.fn(async () => unused()), {
      listBoard,
      members: [
        { memberRef: 'member-1', displayName: 'Minh' },
        { memberRef: 'member-2', displayName: 'Lan' }
      ],
      viewerMemberRef: 'member-1'
    })

    await screen.findByText(mine.title)
    fireEvent.click(screen.getByRole('button', { name: 'My tasks' }))

    await waitFor(() =>
      expect(listBoard).toHaveBeenLastCalledWith(
        'company-1',
        expect.objectContaining({ ownerMemberRef: 'member-1' })
      )
    )
    expect(screen.getByText(mine.title)).not.toBeNull()
    expect(screen.queryByText(theirs.title)).toBeNull()
    expect($companySpacePreferences.get()['company-1']?.boardView).toBe('my_tasks')
  })

  it('groups accepted work by status, sorts by priority then due, and collapses Done', async () => {
    const due = (date: string) => ({ kind: 'date' as const, date, timeZone: 'Asia/Ho_Chi_Minh', originalText: date })

    const withPriority = (card: CompanyBoardCard, priority: string) =>
      Object.assign(card, { priority }) as CompanyBoardCard

    const cards = [
      withPriority(
        boardCard({ cardId: 'card-later', displayKey: 'ATUM-2', due: due('2026-11-02'), owners: ['member-1'], title: 'Later' }),
        'high'
      ),
      withPriority(
        boardCard({ cardId: 'card-low', displayKey: 'ATUM-3', due: due('2026-11-01'), owners: ['member-1'], title: 'Low' }),
        'low'
      ),
      withPriority(
        boardCard({ cardId: 'card-urgent', displayKey: 'ATUM-4', due: due('2026-11-01'), owners: ['member-1'], title: 'Urgent' }),
        'urgent'
      ),
      boardCard({ cardId: 'card-progress', displayKey: 'ATUM-5', owners: ['member-1'], status: 'in_progress', title: 'Progress' }),
      boardCard({ cardId: 'card-blocked', displayKey: 'ATUM-6', owners: ['member-1'], status: 'blocked', title: 'Blocked task' }),
      boardCard({ cardId: 'card-done', displayKey: 'ATUM-7', owners: ['member-1'], status: 'done', title: 'Finished' }),
      boardCard({ cardId: 'card-suggested', displayKey: 'ATUM-8', owners: ['member-1'], status: 'suggested', title: 'Suggestion' })
    ]

    const listBoard = vi.fn(async () => boardPage(cards))
    fixture(cards, vi.fn(async () => unused()), { listBoard, viewerMemberRef: 'member-1' })

    await screen.findByText('Later')
    fireEvent.click(screen.getByRole('button', { name: 'My tasks' }))
    await screen.findByText('Urgent')

    const groups = window.document.querySelectorAll('[data-my-tasks-group]')
    expect([...groups].map(group => group.getAttribute('data-my-tasks-group'))).toEqual([
      'to_do',
      'in_progress',
      'blocked'
    ])

    const ordered = [...window.document.querySelectorAll('[data-my-task-card]')]
      .slice(0, 3)
      .map(row => row.textContent)

    expect(ordered).toEqual(expect.arrayContaining(['UrgentNov 1', 'LowNov 1', 'LaterNov 2']))
    expect(ordered.indexOf('UrgentNov 1')).toBeLessThan(ordered.indexOf('LowNov 1'))
    expect(ordered.indexOf('LaterNov 2')).toBeLessThan(ordered.indexOf('LowNov 1'))
    expect(screen.queryByText('Suggestion')).toBeNull()
    expect((window.document.querySelector('[data-my-tasks-done]') as HTMLDetailsElement).open).toBe(false)
  })
})

describe('company board list view', () => {
  it('renders compact rows from the board projection with 1.1 fields', async () => {
    const card = boardCardV11({
      checklist: [
        {
          itemId: 'item-1',
          text: 'Confirm audience',
          done: true,
          order: 0,
          completedBy: actor,
          completedAt: '2026-10-29T08:20:00.000Z'
        },
        {
          itemId: 'item-2',
          text: 'Send draft',
          done: false,
          order: 1,
          completedBy: null,
          completedAt: null
        }
      ],
      due: { kind: 'date', date: '2026-11-02', timeZone: 'Asia/Ho_Chi_Minh', originalText: '2 Nov' },
      owners: ['member-1'],
      primaryOwner: 'member-1',
      priority: 'urgent',
      status: 'in_progress'
    })

    fixture([card], vi.fn(async () => unused()), {
      members: [{ memberRef: 'member-1', displayName: 'Minh' }]
    })

    await screen.findByText(card.title)
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    const row = window.document.querySelector(`[data-company-board-list-row="${card.cardId}"]`)
    expect(row?.textContent).toContain(card.title)
    expect(row?.textContent).toContain('In progress')
    expect(row?.textContent).toContain('Minh')
    expect(row?.textContent).toContain('Nov 2')
    expect(row?.textContent).toContain('Urgent')
    expect(row?.textContent).toContain('Progress 1/2')

    fireEvent.click(row!)
    expect(screen.getByRole('complementary', { name: 'Task details' })).not.toBeNull()
  })

  it('sorts rows by due date and priority from compact controls', async () => {
    const due = (date: string) => ({ kind: 'date' as const, date, timeZone: 'Asia/Ho_Chi_Minh', originalText: date })

    const cards = [
      boardCardV11({ cardId: 'card-low', displayKey: 'ATUM-2', due: due('2026-11-01'), priority: 'low', title: 'Low first due' }),
      boardCardV11({ cardId: 'card-urgent', displayKey: 'ATUM-3', due: due('2026-11-03'), priority: 'urgent', title: 'Urgent later due' }),
      boardCardV11({ cardId: 'card-high', displayKey: 'ATUM-4', due: due('2026-11-02'), priority: 'high', title: 'High middle due' })
    ]

    fixture(cards, vi.fn(async () => unused()))
    await screen.findByText('Low first due')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    const rowTitles = () => [...window.document.querySelectorAll('[data-company-board-list-row]')]
      .map(row => row.getAttribute('aria-label'))

    expect(rowTitles()).toEqual(['Low first due', 'High middle due', 'Urgent later due'])

    const sortControls = screen.getByRole('group', { name: 'Sort' })
    fireEvent.click(within(sortControls).getByRole('button', { name: /Due date/u }))
    expect(rowTitles()).toEqual(['Urgent later due', 'High middle due', 'Low first due'])

    fireEvent.click(within(sortControls).getByRole('button', { name: /Priority/u }))
    expect(rowTitles()).toEqual(['Urgent later due', 'High middle due', 'Low first due'])
  })

  it('sorts malformed due values last without crashing the list', async () => {
    const valid = boardCardV11({
      title: 'Valid due',
      due: { kind: 'date', date: '2026-11-02', timeZone: 'UTC', originalText: '2026-11-02' }
    })
    const malformed = boardCardV11({
      cardId: 'card-malformed',
      displayKey: 'ATUM-2',
      title: 'Malformed due',
      due: { kind: 'instant', at: 'not-a-date', originalText: 'not-a-date' } as CompanyBoardCard['due']
    })

    fixture([malformed, valid], vi.fn(async () => unused()))
    await screen.findByText(valid.title)
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    expect([...window.document.querySelectorAll('[data-company-board-list-row]')]
      .map(row => row.getAttribute('aria-label'))).toEqual(['Valid due', 'Malformed due'])
  })

  it('resets a priority sort to due when the board falls back to the legacy contract', async () => {
    const due = (date: string) => ({ kind: 'date' as const, date, timeZone: 'UTC', originalText: date })
    const modern = [
      boardCardV11({ title: 'Z early', due: due('2026-11-01'), owners: ['member-1'], priority: 'low' }),
      boardCardV11({ cardId: 'card-2', displayKey: 'ATUM-2', title: 'A late', due: due('2026-11-03'), owners: ['member-1'], priority: 'urgent' })
    ]
    const legacy = modern.map(card => boardCard({
      cardId: card.cardId,
      displayKey: card.displayKey,
      title: card.title,
      due: card.due,
      owners: card.owners
    }))
    const listBoard = vi.fn()
      .mockResolvedValueOnce(boardPage(modern))
      .mockResolvedValueOnce(boardPage(legacy, 10, '1'))

    fixture(modern, vi.fn(async () => unused()), { listBoard, viewerMemberRef: 'member-1' })
    await screen.findByText('Z early')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Sort' })).getByRole('button', { name: /Priority/u }))

    expect([...window.document.querySelectorAll('[data-company-board-list-row]')]
      .map(row => row.getAttribute('aria-label'))).toEqual(['A late', 'Z early'])

    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Priority/u })).toBeNull())
    await waitFor(() => expect([...window.document.querySelectorAll('[data-company-board-list-row]')]
      .map(row => row.getAttribute('aria-label'))).toEqual(['Z early', 'A late']))
  })

  it('applies and clears the viewer owner filter with one-tap Mine', async () => {
    const mine = boardCardV11({ owners: ['member-1'], primaryOwner: 'member-1', title: 'Mine task' })
    const theirs = boardCardV11({ cardId: 'card-2', displayKey: 'ATUM-2', owners: ['member-2'], title: 'Their task' })
    const cards = [mine, theirs]

    const listBoard = vi.fn(async (_companyId: string, filters: Parameters<CompanyDesktopAdapter['listBoard']>[1]) =>
      boardPage(filters.ownerMemberRef ? cards.filter(card => card.owners.includes(filters.ownerMemberRef!)) : cards)
    )

    fixture(cards, vi.fn(async () => unused()), {
      listBoard,
      members: [
        { memberRef: 'member-1', displayName: 'Minh' },
        { memberRef: 'member-2', displayName: 'Lan' }
      ],
      viewerMemberRef: 'member-1'
    })

    await screen.findByText('Mine task')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))

    await waitFor(() =>
      expect(listBoard).toHaveBeenLastCalledWith(
        'company-1',
        expect.objectContaining({ ownerMemberRef: 'member-1' })
      )
    )
    expect(screen.getByText('Mine task')).not.toBeNull()
    expect(screen.queryByText('Their task')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Mine' }))
    await screen.findByText('Their task')
    expect(listBoard).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ ownerMemberRef: null })
    )
  })

  it('keeps priority and checklist columns hidden for a legacy /1 projection', async () => {
    const card = boardCard({ title: 'Legacy task' })
    fixture([card], vi.fn(async () => unused()))

    await screen.findByText(card.title)
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    expect(screen.queryByRole('columnheader', { name: 'Priority' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Checklist' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Priority/u })).toBeNull()
    expect(window.document.querySelector('[data-board-checklist-progress]')).toBeNull()
    expect(window.document.querySelector('[data-board-priority]')).toBeNull()
  })

  it('moves row focus with arrow keys and opens focused tasks with Enter or Space', async () => {
    const first = boardCardV11({ title: 'First task' })
    const second = boardCardV11({ cardId: 'card-2', displayKey: 'ATUM-2', title: 'Second task' })
    fixture([first, second], vi.fn(async () => unused()))

    await screen.findByText(first.title)
    fireEvent.click(screen.getByRole('button', { name: 'List' }))

    const rows = [...window.document.querySelectorAll<HTMLElement>('[data-company-board-list-row]')]
    rows[0]?.focus()
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    expect(window.document.activeElement).toBe(rows[1])

    fireEvent.keyDown(rows[1]!, { key: 'Enter' })
    const detail = screen.getByRole('complementary', { name: 'Task details' })
    expect(within(detail).getByText('Second task')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(rows[0]!, { key: ' ' })
    expect(within(screen.getByRole('complementary', { name: 'Task details' })).getByText('First task')).not.toBeNull()
  })
})

describe('company board 1.1 mechanics', () => {
  it('consumes every board cursor before rendering the permission-filtered projection', async () => {
    const first = boardCardV11({ title: 'First page' })
    const second = boardCardV11({ cardId: 'card-2', displayKey: 'ATUM-2', title: 'Second page' })

    const listBoard = vi
      .fn()
      .mockResolvedValueOnce({ ...boardPage([first]), nextCursor: 'next-page' })
      .mockResolvedValueOnce(boardPage([second]))

    fixture([], vi.fn(async () => unused()), { listBoard })

    expect(await screen.findByText('First page')).not.toBeNull()
    expect(screen.getByText('Second page')).not.toBeNull()
    expect(listBoard).toHaveBeenNthCalledWith(1, 'company-1', expect.objectContaining({ cursor: null }))
    expect(listBoard).toHaveBeenNthCalledWith(2, 'company-1', expect.objectContaining({ cursor: 'next-page' }))
  })

  it('adds, checks, reorders and removes checklist items while keeping Done independent', async () => {
    const first = {
      itemId: 'item-1',
      text: 'Confirm audience',
      done: false,
      order: 0,
      completedBy: null,
      completedAt: null
    }

    const second = {
      itemId: 'item-2',
      text: 'Send draft',
      done: true,
      order: 1,
      completedBy: actor,
      completedAt: '2026-10-29T08:10:00.000Z'
    }

    let current = boardCardV11({ checklist: [first, second] })

    const commandBoard = vi.fn(async (_companyId: string, command: CompanyBoardCommand) => {
      if (command.operation === 'checklist') {
        let checklist = [...(current.checklist ?? [])]
        const mutation = command.mutation

        if (mutation.action === 'add') {
          checklist.push({ ...mutation.item, done: false, completedBy: null, completedAt: null })
        } else if (mutation.action === 'remove') {
          checklist = checklist.filter(item => item.itemId !== mutation.itemId)
        } else {
          const index = checklist.findIndex(item => item.itemId === mutation.itemId)
          const item = checklist[index]!

          if (mutation.patch.order !== undefined) {
            checklist.splice(index, 1)
            checklist.splice(mutation.patch.order, 0, item)
          } else {
            checklist[index] = {
              ...item,
              ...mutation.patch,
              ...(mutation.patch.done === true
                ? { completedBy: actor, completedAt: '2026-10-29T08:20:00.000Z' }
                : mutation.patch.done === false
                  ? { completedBy: null, completedAt: null }
                  : {})
            }
          }

          checklist = checklist.map((entry, order) => ({ ...entry, order }))
        }

        current = boardCardV11({ ...current, checklist, revision: current.revision + 1 })
      }

      return {
        schemaVersion: 1 as const,
        state: 'applied' as const,
        duplicate: false,
        eventId: globalThis.crypto.randomUUID(),
        card: current as never
      }
    })

    fixture([current], commandBoard)
    await waitFor(() => {
      expect(window.document.querySelector('[data-board-checklist-progress]')?.textContent).toContain('Progress 1/2')
    })
    fireEvent.click(screen.getByText(current.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })

    fireEvent.change(within(detail).getByRole('textbox', { name: 'Checklist item' }), {
      target: { value: 'Publish notes' }
    })
    fireEvent.click(within(detail).getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ operation: 'checklist', mutation: expect.objectContaining({ action: 'add' }) }),
      '1.1'
    ))

    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Confirm audience' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'checklist',
        mutation: { action: 'update', itemId: 'item-1', patch: { done: true } }
      }),
      '1.1'
    ))

    fireEvent.click(within(detail).getByRole('button', { name: 'Move up: Send draft' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'checklist',
        mutation: { action: 'update', itemId: 'item-2', patch: { order: 0 } }
      }),
      '1.1'
    ))

    fireEvent.click(within(detail).getByRole('button', { name: 'Remove: Confirm audience' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ operation: 'checklist', mutation: { action: 'remove', itemId: 'item-1' } }),
      '1.1'
    ))
    expect(current.status).toBe('to_do')
  })

  it('shows the fixed priority badge and dispatches a revision-fenced priority change', async () => {
    const card = boardCardV11({ priority: 'urgent' })
    const updated = boardCardV11({ ...card, priority: 'low', revision: 4 })

    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'applied' as const,
      duplicate: false,
      eventId: 'event-1',
      card: updated as never
    }))

    fixture([card], commandBoard)
    expect(await screen.findByText('Urgent')).not.toBeNull()
    fireEvent.click(screen.getByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.change(within(detail).getByLabelText('Priority'), { target: { value: 'low' } })

    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'patch',
        expectedCardRevision: 3,
        patch: { priority: 'low' }
      }),
      '1.1'
    ))
  })

  it('searches every result page and opens a result through the full-card reader', async () => {
    const card = boardCardV11()

    const result = {
      cardId: card.cardId,
      displayKey: card.displayKey,
      revision: card.revision,
      title: 'Launch checklist',
      description: 'Ready for review',
      status: card.status,
      priority: 'high' as const,
      checklistProgress: { done: 1, total: 2 },
      owners: [],
      primaryOwner: null,
      due: null,
      archived: false,
      matchedFields: ['title' as const]
    }

    const searchBoard = vi
      .fn()
      .mockResolvedValueOnce({ schemaVersion: 1, board: boardPage([card]).board, results: [result], nextCursor: 'next' })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        board: boardPage([card]).board,
        results: [{ ...result, cardId: 'card-2', displayKey: 'ATUM-2', title: 'Launch notes' }],
        nextCursor: null
      })

    fixture([card], vi.fn(async () => unused()), { searchBoard })
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'launch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))

    expect(await screen.findByText('Launch checklist')).not.toBeNull()
    expect(screen.getByText('Launch notes')).not.toBeNull()
    expect(searchBoard).toHaveBeenNthCalledWith(1, 'company-1', expect.objectContaining({ query: 'launch', cursor: null }))
    expect(searchBoard).toHaveBeenNthCalledWith(2, 'company-1', expect.objectContaining({ query: 'launch', cursor: 'next' }))
  })

  it('renders paged activity with CoS source copy and Undo only for an available event', async () => {
    const card = boardCardV11()

    const channelCitation = {
      kind: 'channel' as const,
      sourceId: 'source-1',
      channelId: 'channel-1',
      eventId: '$event',
      at: '2026-10-29T08:00:00.000Z'
    }

    const activity = (eventId: string, undo: CompanyBoardActivityEvent['undo']): CompanyBoardActivityEvent => ({
      schemaVersion: 1,
      eventId,
      companyId: 'company-1',
      boardId: 'board-1',
      cardId: card.cardId,
      cardRevision: 3,
      requestId: `request-${eventId}`,
      operation: 'patch',
      origin: 'cos',
      actor: { kind: 'cos', agentPrincipal: 'agent-1' },
      sourceCitations: [channelCitation],
      changes: [{ field: 'priority' }],
      compensatesEventId: null,
      undo,
      at: '2026-10-29T08:00:00.000Z'
    })

    const available = activity('event-available', {
      state: 'available',
      targetEventId: 'event-available',
      expectedCardRevision: 3
    })

    const unavailable = activity('event-unavailable', { state: 'unavailable', reason: 'superseded' })

    const readBoardActivity = vi
      .fn()
      .mockResolvedValueOnce({ schemaVersion: 1, cardId: card.cardId, events: [available], nextCursor: 'next' })
      .mockResolvedValueOnce({ schemaVersion: 1, cardId: card.cardId, events: [unavailable], nextCursor: null })

    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'applied' as const,
      duplicate: false,
      eventId: 'undo-event',
      card: boardCardV11({ ...card, revision: 4 }) as never
    }))

    fixture([card], commandBoard, { citationChannels: { 'channel-1': 'Sales' }, readBoardActivity })
    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })

    expect(await within(detail).findAllByText(/Chief of Staff · from #Sales/u)).toHaveLength(2)
    expect(within(detail).getAllByRole('button', { name: 'Undo' })).toHaveLength(1)
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'undo',
        targetEventId: 'event-available',
        expectedCardRevision: 3
      }),
      '1.1'
    ))
  })

  it('adds, removes and revalidates protected Company Drive attachments', async () => {
    const attached = {
      v: 1 as const,
      company_id: 'company-1',
      channel_id: 'channel-1',
      file_id: 'file-attached',
      revision: 1 as const,
      name: 'plan.pdf',
      content_type: 'application/pdf',
      size: 10,
      sha256: 'a'.repeat(64)
    }

    const choice = { ...attached, file_id: 'file-choice', name: 'notes.md', content_type: 'text/markdown' }

    const card = boardCardV11({
      citations: [{ kind: 'company_file', sourceId: 'source-1', channelId: 'channel-1', file: choice }],
      attachments: [{ attachmentId: 'attachment-1', file: attached, addedBy: actor, addedAt: provenance.at }]
    })

    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'applied' as const,
      duplicate: false,
      eventId: 'event-1',
      card: boardCardV11({ ...card, revision: 4 }) as never
    }))

    const openBoardAttachment = vi.fn(async () => {})

    fixture([card], commandBoard, { openBoardAttachment })
    fireEvent.click(await screen.findByText(card.title))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: 'plan.pdf' }))
    expect(openBoardAttachment).toHaveBeenCalledWith('company-1', attached)

    fireEvent.change(within(detail).getByLabelText('Add from Company Drive'), { target: { value: '0' } })
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ operation: 'attachment', mutation: { action: 'add', file: choice } }),
      '1.1'
    ))

    fireEvent.click(within(detail).getByRole('button', { name: 'Remove: plan.pdf' }))
    await waitFor(() => expect(commandBoard).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        operation: 'attachment',
        mutation: { action: 'remove', attachmentId: 'attachment-1' }
      }),
      '1.1'
    ))
  })

  it('adopts currentCard on a stale write and hides every 1.1 control on legacy fallback', async () => {
    const card = boardCardV11({ title: 'Local title', priority: 'high' })
    const current = boardCardV11({ ...card, title: 'Server title', priority: 'urgent', revision: 4 })

    const commandBoard = vi.fn(async () => ({
      schemaVersion: 1 as const,
      state: 'conflict' as const,
      reason: 'stale_card_revision' as const,
      cardId: card.cardId,
      expectedCardRevision: 3,
      currentCardRevision: 4,
      currentCard: current as never
    }))

    fixture([card], commandBoard)
    fireEvent.click(await screen.findByText('Local title'))
    fireEvent.change(within(await screen.findByRole('complementary', { name: 'Task details' })).getByLabelText('Priority'), {
      target: { value: 'urgent' }
    })
    expect(await screen.findAllByText('Server title')).toHaveLength(2)
    expect(screen.getByText('This task changed. The latest version is shown.')).not.toBeNull()

    cleanup()
    const legacy = boardCard({ title: 'Legacy task' })
    fixture([legacy], vi.fn(async () => unused()), { scope: 'legacy' })
    expect(await screen.findByText('Legacy task')).not.toBeNull()
    expect(screen.queryByRole('searchbox', { name: 'Search tasks' })).toBeNull()
    fireEvent.click(screen.getByText('Legacy task'))
    const legacyDetail = await screen.findByRole('complementary', { name: 'Task details' })
    expect(within(legacyDetail).queryByLabelText('Priority')).toBeNull()
    expect(within(legacyDetail).queryByRole('region', { name: 'Checklist' })).toBeNull()
    expect(within(legacyDetail).queryByRole('region', { name: 'Attachments' })).toBeNull()
  })
})
