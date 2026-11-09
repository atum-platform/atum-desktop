import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom } from '../../shared/matrix'
import { companyAIStatusText } from '../../shared/matrix-company-ai-status'
import { matrixMessageLink, parseMatrixMessageLink } from '../../shared/matrix-message-link'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import { companyAIMentionUserIds } from './company-ai-mention'
import { COMPANY_AI_RECHECK_MS, useCompanyAIRecheck } from './company-ai-status'
import {
  companyAIActivityStatusHidden,
  companyAIPrivateCosStatus,
  companyAIThreadStatus,
  CompanyAIThreadStatusLine
} from './company-ai-thread-status'
import { CompanyBoard } from './company-board'
import {
  COMPANY_BOARD_CAPTURE_DESCRIPTION,
  COMPANY_BOARD_CAPTURE_TITLE,
  companyBoardCaptureDraft,
  companyBoardCardSource,
  useCompanyBoardCapture
} from './company-board-capture'
import type { CompanyAIView, CompanyDesktopAdapter } from './company-desktop-adapter'
import {
  $companyAIStatuses,
  $companySpacePreferences,
  $companyWalletScope,
  companySpacePreferences
} from './company-space-store'
import { COMPANY_AI_ANSWER_FIXTURE, playgroundCompanyDesktopAdapter } from './playground/company-ai-fixtures'
import { TEAM_COMPANY_ID } from './playground/team-space-fixtures'
import { ChannelMembersDialog } from './team-space/channel-members-dialog'
import { $companyChannels } from './team-space/channels-store'
import { $teamSpaceIntent } from './team-space/intents'
import { teamSpaceKey } from './team-space/keys'
import { TeamSpaceMentionMenu } from './team-space/mention-menu'
import { $matrixMessageLinkRequest } from './team-space/message-links'
import {
  $companyPrivateCos,
  $companyPrivateCosDiscovery,
  clearCompanyPrivateCos,
  type CompanyPrivateCosState
} from './team-space/private-cos-store'
import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  OTHER_COMPANY_ID,
  platform,
  REFS,
  renderTeamSpace,
  resetTeamSpace,
  type ScriptedChannel,
  TestResizeObserver
} from './team-space/test-support'
import type { CompanyChannelView } from './team-space/views'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

const COS = '@chief-of-staff:atum.example'

function aiView(over: Partial<CompanyAIView> = {}): CompanyAIView {
  return {
    schemaVersion: 1,
    companyId: COMPANY_ID,
    agent: { principal: '00000000-0000-4000-8000-9896148e0625', userId: COS, displayName: 'Chief of Staff' },
    enabled: true,
    revision: 1,
    state: 'ready',
    canManage: true,
    ...over
  }
}

/** The playground company store, answering this company's Chief of Staff view as the platform would. */
function installCompanyDesktop(view: CompanyAIView, adapter: CompanyDesktopAdapter = playgroundCompanyDesktopAdapter()) {
  const installed: CompanyDesktopAdapter = { ...adapter, readAI: vi.fn(async () => view) }
  const current = (window as unknown as { atumMatrix?: Record<string, unknown> }).atumMatrix ?? {}
  ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { ...current, companyDesktop: installed }

  return installed
}

function inEnglish(node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )
}

beforeEach(() => {
  resetTeamSpace()
  $companyAIStatuses.set({})
  $companySpacePreferences.set({})
  $teamSpaceIntent.set(undefined)
  $matrixMessageLinkRequest.set(null)
  $companyWalletScope.set(null)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('S5 the Chief of Staff in a channel’s members', () => {
  const channel = { id: CHANNEL_IDS.general, ownerMemberRef: REFS.owner } as CompanyChannelView

  const PRIVATE_KEY = teamSpaceKey('account-a', COMPANY_ID)

  /** Only the fields the row reads: availability, loading and the platform's view state. */
  const privateCos = (availability: CompanyPrivateCosState['availability'], viewState = 'preparing') =>
    ({ served: true, availability, loading: false, view: { state: viewState } }) as unknown as CompanyPrivateCosState

  afterEach(() => clearCompanyPrivateCos('account-a'))

  function members(
    view: CompanyAIView,
    onOpenPrivateCos = vi.fn(async () => {}),
    onRetryPrivateCos: (() => Promise<void>) | undefined = vi.fn(async () => {})
  ) {
    const source = platform()
    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companies: source.bridge }
    installCompanyDesktop(view)

    inEnglish(
      <ChannelMembersDialog
        abilities={{ leave: false, archive: false, restore: false, edit: false, addPeople: false, removeMembers: false,
          seeMembers: true }}
        accountKey="account-a"
        bridge={source.bridge}
        channel={channel}
        companyId={COMPANY_ID}
        mutate={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
        onOpenPrivateCos={onOpenPrivateCos}
        onRetryPrivateCos={onRetryPrivateCos}
        open
        roster={[]}
      />
    )

    return screen.findByRole('list', { name: 'Channel members' })
  }

  const serviceRow = (list: HTMLElement) => waitFor(() => {
    const found = list.querySelector<HTMLElement>('[data-company-channel-service-member]')
    expect(found).toBeTruthy()

    return found!
  })

  it('lists a ready Chief of Staff as a member, with no state line', async () => {
    $companyPrivateCos.setKey(PRIVATE_KEY, privateCos('ready', 'ready'))
    const list = await members(aiView())
    const row = await serviceRow(list)

    expect(within(row).getByText('Chief of Staff')).toBeTruthy()
    expect(within(row).queryByRole('status')).toBeNull()
    expect(document.querySelector('[data-company-ai-member-state]')).toBeNull()
  })

  it('opens a ready Chief of Staff through the private conversation callback', async () => {
    $companyPrivateCos.setKey(PRIVATE_KEY, privateCos('ready', 'ready'))
    const openPrivateCos = vi.fn(async () => {})
    const list = await members(aiView(), openPrivateCos)

    const open = within(list).getByRole('button', { name: 'Open conversation with Chief of Staff' })
    expect(open.textContent).toBe('Open')
    fireEvent.click(open)
    await waitFor(() => expect(openPrivateCos).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['still being asked for', undefined, undefined],
    ['being ensured', privateCos('preparing', 'uncreated'), undefined],
    ['preparing on the platform', privateCos('preparing'), undefined]
  ])('says Setting up… with no action while the private Chief of Staff is %s', async (_label, state, discovery) => {
    if (state) {$companyPrivateCos.setKey(PRIVATE_KEY, { ...state, loading: true })}
    if (discovery) {$companyPrivateCosDiscovery.setKey(PRIVATE_KEY, discovery)}
    const list = await members(aiView())
    const row = await serviceRow(list)

    expect(row.getAttribute('data-company-private-cos-member-status')).toBe('setting_up')
    expect(within(row).getByRole('status').textContent).toBe('Setting up…')
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it.each([
    ['capability not served', undefined, 'not_available' as const, 'Not available yet'],
    ['ensure failed', privateCos('unavailable', 'uncreated'), undefined, 'Not available yet'],
    ['paused', privateCos('paused'), undefined, 'Paused']
  ])('says what is wrong and offers Retry when %s', async (_label, state, discovery, line) => {
    if (state) {$companyPrivateCos.setKey(PRIVATE_KEY, state)}
    if (discovery) {$companyPrivateCosDiscovery.setKey(PRIVATE_KEY, discovery)}
    let finish!: () => void
    const retry = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
    const list = await members(aiView(), vi.fn(async () => {}), retry)
    const row = await serviceRow(list)

    expect(row.getAttribute('data-company-private-cos-member-status')).toBe(state?.availability === 'paused'
      ? 'paused'
      : 'not_available')
    expect(within(row).getByRole('status').textContent).toBe(line)
    expect(within(row).getAllByRole('button')).toHaveLength(1)

    fireEvent.click(within(row).getByRole('button', { name: 'Retry · Chief of Staff' }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    // While asking again the row says so and offers nothing twice.
    expect(within(row).getByRole('status').textContent).toBe('Setting up…')
    expect(within(row).queryByRole('button')).toBeNull()

    act(() => {
      $companyPrivateCosDiscovery.set({})
      $companyPrivateCos.setKey(PRIVATE_KEY, privateCos('ready', 'ready'))
      finish()
    })
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Open conversation with Chief of Staff' }))
      .toBeTruthy())
  })

  it.each([
    ['being set up', { state: 'preparing' as const }, 'preparing', 'Chief of Staff · Not available yet'],
    ['needing recovery', { state: 'attention' as const }, 'unavailable', 'Chief of Staff · Not available right now'],
    ['turned off', { enabled: false, state: 'paused' as const }, 'off', 'Chief of Staff · Off']
  ])('says in one line that a Chief of Staff %s is not a member who answers', async (_label, over, state, line) => {
    const list = await members(aiView(over))

    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-company-ai-member-state]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(notice.getAttribute('data-company-ai-member-state')).toBe(state)
    expect(within(notice).getByText(line)).toBeTruthy()
    expect(list.querySelector('[data-company-channel-service-member]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open conversation with Chief of Staff' })).toBeNull()
  })
})

describe('S5 mentioning the Chief of Staff', () => {
  it('attaches the Chief of Staff mention only while it can answer', () => {
    expect(companyAIMentionUserIds('@Chief of Staff what changed?', aiView())).toEqual([COS])
    expect(companyAIMentionUserIds('@Chief of Staff what changed?', aiView({ state: 'preparing' }))).toEqual([])
    expect(companyAIMentionUserIds('@Chief of Staff what changed?', aiView({ state: 'attention' }))).toEqual([])
    expect(companyAIMentionUserIds('@Chief of Staff what changed?', aiView({ enabled: false, state: 'paused' }))).toEqual([])
  })

  it('draws a not-ready Chief of Staff as a quiet line that cannot be picked', () => {
    const onPick = vi.fn()

    render(
      <TeamSpaceMentionMenu
        companyAINotice={{ view: aiView({ state: 'preparing' }), line: 'Not available yet' }}
        copy={matrixTeamSpaceCopy('en')}
        onPick={onPick}
        options={[]}
        selected={0}
      />
    )

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    const notice = document.querySelector<HTMLElement>('[data-company-ai-mention-state="preparing"]')!
    expect(notice.textContent).toContain('Chief of Staff')
    expect(notice.textContent).toContain('Not available yet')
    expect(screen.getByRole('status')).toBe(notice)
    fireEvent.click(notice)
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('S5 looking again while someone waits on a Chief of Staff that is not ready', () => {
  function Recheck({ reload, waiting }: { reload(): void; waiting: boolean }) {
    useCompanyAIRecheck(waiting, reload)

    return null
  }

  afterEach(() => vi.useRealTimers())

  it('looks at once, then every 15 s while waiting, and stops when the wait ends', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const view = render(<Recheck reload={reload} waiting />)

    expect(reload).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_AI_RECHECK_MS))
    expect(reload).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_AI_RECHECK_MS * 2))
    expect(reload).toHaveBeenCalledTimes(4)

    view.rerender(<Recheck reload={reload} waiting={false} />)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_AI_RECHECK_MS * 3))
    expect(reload).toHaveBeenCalledTimes(4)
  })

  it('does not look twice within 15 s when the wait starts again', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const view = render(<Recheck reload={reload} waiting />)

    view.rerender(<Recheck reload={reload} waiting={false} />)
    view.rerender(<Recheck reload={reload} waiting />)
    expect(reload).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_AI_RECHECK_MS))
    expect(reload).toHaveBeenCalledTimes(2)
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(COMPANY_AI_RECHECK_MS * 3))
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

describe('S5 the Chief of Staff’s no-answer line in a thread', () => {
  const statusMessage = (body: string, over: { sender?: string; thread?: boolean } = {}) => ({
    body, sender: over.sender ?? COS, thread: over.thread ?? true, redacted: false
  })

  it('reads every controller status sentence back as its code (the controller and the app agree)', () => {
    for (const code of ['unfunded', 'stopped', 'couldnt_confirm', 'failed'] as const) {
      expect(companyAIThreadStatus(statusMessage(companyAIStatusText(code)), aiView())).toBe(code)
    }
  })

  it('reads it only from this company’s own Chief of Staff, in a thread', () => {
    const text = companyAIStatusText('unfunded')

    expect(companyAIThreadStatus(statusMessage(text, { sender: '@linh:atum.example' }), aiView())).toBeUndefined()
    expect(companyAIThreadStatus(statusMessage(text, { thread: false }), aiView())).toBeUndefined()
    expect(companyAIThreadStatus(statusMessage(text), undefined)).toBeUndefined()
    expect(companyAIThreadStatus(statusMessage('Company AI needs Protons, maybe?'), aiView())).toBeUndefined()
  })

  it('reads the private-room line only from the exact bound private agent', () => {
    const message = { body: companyAIStatusText('unfunded'), sender: COS, redacted: false }

    expect(companyAIPrivateCosStatus(message, COS)).toBe('unfunded')
    expect(companyAIPrivateCosStatus(message, '@look-alike:atum.example')).toBeUndefined()
    expect(companyAIPrivateCosStatus({ ...message, redacted: true }, COS)).toBeUndefined()
  })

  it('gives the company wallet, one click away, to whoever the workspace will show it to', () => {
    $companyWalletScope.set(`account-a\u0000${COMPANY_ID}`)
    inEnglish(<CompanyAIThreadStatusLine accountKey="account-a" companyId={COMPANY_ID} status="unfunded" />)

    expect(screen.getByText(/Chief of Staff needs Protons to answer\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Top up' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'open-wallet', companyId: COMPANY_ID })
  })

  it.each([
    ['the workspace will not open its wallet', null],
    ['the workspace would open another company’s wallet', `account-a\u0000${OTHER_COMPANY_ID}`],
    ['the workspace would open it for another account', `account-b\u0000${COMPANY_ID}`]
  ])('tells the reader who can top up, with nothing to click, when %s', (_label, scope) => {
    $companyWalletScope.set(scope)
    inEnglish(<CompanyAIThreadStatusLine accountKey="account-a" companyId={COMPANY_ID} status="unfunded" />)

    expect(screen.getByText('Chief of Staff needs Protons to answer. Ask the company owner to top up.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing for the uncertain “couldn’t confirm” outcome, in any language', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      const view = render(
        <I18nProvider configClient={null} initialLocale={locale}>
          <CompanyAIThreadStatusLine accountKey="account-a" companyId={COMPANY_ID} status="couldnt_confirm" />
        </I18nProvider>
      )

      expect(view.container.textContent).toBe('')
      view.unmount()
    }
  })

  it('never reads a status out of a reply that carries an answer, even with the frozen words', () => {
    const text = companyAIStatusText('couldnt_confirm')
    const answered = { ...statusMessage(text), companyAIAnswer: COMPANY_AI_ANSWER_FIXTURE }

    expect(companyAIThreadStatus(statusMessage(text), aiView())).toBe('couldnt_confirm')
    expect(companyAIThreadStatus(answered, aiView())).toBeUndefined()
    expect(companyAIPrivateCosStatus({ body: text, sender: COS, redacted: false }, COS)).toBe('couldnt_confirm')
    const privateAnswered = { body: text, sender: COS, redacted: false, companyAIAnswer: COMPANY_AI_ANSWER_FIXTURE }
    expect(companyAIPrivateCosStatus(privateAnswered, COS)).toBeUndefined()
  })

  it('hides that line from Activity only under the thread’s own scope, and never an answer', () => {
    const text = companyAIStatusText('couldnt_confirm')
    const PRIVATE_ROOM = '!private-cos:atum.example'
    const PRIVATE_COS = '@private-cos:atum.example'
    const reply = { body: text, senderId: COS, roomId: '!channel:atum.example', threadRootId: '$root' }
    const privateLine = { body: ` ${text} `, senderId: PRIVATE_COS, roomId: PRIVATE_ROOM }
    const privateCos = { roomId: PRIVATE_ROOM, agentUserId: PRIVATE_COS }

    // The company's CoS replying in one of its channel threads; the bound agent in the private room.
    expect(companyAIActivityStatusHidden(reply, { channelAgentUserId: COS })).toBe(true)
    expect(companyAIActivityStatusHidden(privateLine, { privateCos })).toBe(true)
    // A reply that carries an answer projection is an answer, whatever its words.
    expect(companyAIActivityStatusHidden({ ...reply, companyAIAnswer: true }, { channelAgentUserId: COS })).toBe(false)
    expect(companyAIActivityStatusHidden({ ...privateLine, companyAIAnswer: true }, { privateCos })).toBe(false)
    // Out of scope: not in a thread, a channel of another company (no agent), the private agent in
    // another room, a person typing the same words, or a line that does show.
    expect(companyAIActivityStatusHidden({ ...reply, threadRootId: undefined }, { channelAgentUserId: COS })).toBe(false)
    expect(companyAIActivityStatusHidden(reply, {})).toBe(false)
    expect(companyAIActivityStatusHidden({ ...privateLine, roomId: '!elsewhere:atum.example' }, { privateCos })).toBe(false)
    expect(companyAIActivityStatusHidden({ ...reply, senderId: '@linh:atum.example' }, { channelAgentUserId: COS })).toBe(false)
    expect(companyAIActivityStatusHidden({ ...reply, body: companyAIStatusText('unfunded') }, { channelAgentUserId: COS })).toBe(false)
  })

  it('says the line in the reader’s language', () => {
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <CompanyAIThreadStatusLine accountKey="account-a" companyId={COMPANY_ID} status="unfunded" />
      </I18nProvider>
    )

    expect(screen.getByText('Chief of Staff cần thêm Proton để trả lời. Nhờ chủ công ty nạp thêm Proton.')).toBeTruthy()
  })
})

const LINK = matrixMessageLink({ companyId: COMPANY_ID, roomId: '!general:atum.example', eventId: '$quote:atum.example' })

describe('S10 a message becomes a task', () => {
  it('titles it with the first line and keeps the whole message and its link in the description', () => {
    const draft = companyBoardCaptureDraft('  Send the quote before Friday\nInclude the shipping terms.  ', LINK)!

    expect(draft.title).toBe('Send the quote before Friday')
    expect(draft.description).toBe(`Send the quote before Friday\nInclude the shipping terms.\n\n${LINK}`)
    expect(companyBoardCardSource(draft.description)).toEqual({
      text: 'Send the quote before Friday\nInclude the shipping terms.',
      target: parseMatrixMessageLink(LINK)
    })
  })

  it('keeps a one-line message as the title only, with the link as the whole description', () => {
    const draft = companyBoardCaptureDraft('Call Lan', LINK)!

    expect(draft).toEqual({ title: 'Call Lan', description: LINK })
    expect(companyBoardCardSource(draft.description)).toEqual({ text: null, target: parseMatrixMessageLink(LINK) })
  })

  it('stays inside the board contract’s limits and never splits a character', () => {
    const long = `${'Đặt lịch họp với nhà cung cấp 😀 '.repeat(20)}\n${'chi tiết '.repeat(400)}`
    const draft = companyBoardCaptureDraft(long, LINK)!

    expect(draft.title.length).toBeLessThanOrEqual(COMPANY_BOARD_CAPTURE_TITLE)
    expect(draft.title.endsWith('…')).toBe(true)
    expect(draft.description.length).toBeLessThanOrEqual(COMPANY_BOARD_CAPTURE_DESCRIPTION)
    expect(draft.description.endsWith(LINK)).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(draft.title)).toBe(false)
    expect(companyBoardCaptureDraft('   \n  ', LINK)).toBeNull()
  })

  it('reads no source from a description that does not end with a message link', () => {
    expect(companyBoardCardSource('Plain notes')).toBeNull()
    expect(companyBoardCardSource(`${LINK}\nmore words`)).toBeNull()
    expect(companyBoardCardSource(null)).toBeNull()
  })
})

describe('S10 Turn into task, only where the whole company can read', () => {
  const general: ScriptedChannel = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default', actions: ['update_metadata'] }

  const leadership: ScriptedChannel = {
    id: CHANNEL_IDS.leadership, name: 'leadership', visibility: 'private', ownerRef: REFS.owner,
    actions: ['leave', 'invite', 'remove', 'update_metadata', 'archive'], generation: 11, admissionGeneration: 6
  }

  const old: ScriptedChannel = { id: CHANNEL_IDS.old, name: 'old', state: 'archived', actions: ['restore'] }

  let captured: ReturnType<typeof useCompanyBoardCapture>

  function Probe({ room }: { room: MatrixRoom }) {
    const capture = useCompanyBoardCapture('account-a', room)
    captured = capture

    return <output data-capture={capture ? 'offered' : 'none'} data-room={room.id} />
  }

  function open(channel: ScriptedChannel, adapter = playgroundCompanyDesktopAdapter()) {
    const source = platform({ channels: [general, leadership, old] })
    const room = channelRoom(channel.id, channel.name)
    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { command: vi.fn(async () => null), companies: source.bridge }
    const installed = installCompanyDesktop(aiView(), adapter)

    renderTeamSpace(source, { rooms: [general, leadership, old].map(each => channelRoom(each.id, each.name)) })
    render(<Probe room={room} />)

    return { installed, probe: () => document.querySelector<HTMLElement>(`[data-room="${room.id}"]`)! }
  }

  it('is offered in an active public channel, keeps the person in chat and opens the task only when asked', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')
    const { probe } = open(general, adapter)

    await waitFor(() => expect(probe().getAttribute('data-capture')).toBe('offered'))
    let cardId: string | undefined
    await act(async () => {
      cardId = await captured!.capture('Send the quote before Friday', LINK)
    })

    expect(commandBoard).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ operation: 'create', title: 'Send the quote before Friday', description: LINK }),
      '1.1'
    )
    const created = (await commandBoard.mock.results[0]!.value) as { card: { cardId: string; description: string } }
    expect(created.card.description).toBe(LINK)
    expect(cardId).toBe(created.card.cardId)
    // Nothing moved: the conversation stays in front until the person opens the task.
    expect(companySpacePreferences(`account-a\u0000${COMPANY_ID}`).tab).toBe('chat')

    act(() => captured!.open(cardId!))
    const preferences = companySpacePreferences(`account-a\u0000${COMPANY_ID}`)
    expect(preferences.tab).toBe('board')
    expect(preferences.selectedCardId).toBe(created.card.cardId)
  })

  /** The platform's directory changes this channel while a menu offering the action is still open. */
  function changeChannel(channelId: string, patch: Partial<CompanyChannelView>) {
    const key = teamSpaceKey('account-a', COMPANY_ID)
    const state = $companyChannels.get()[key]!

    act(() => $companyChannels.setKey(key, {
      ...state, channels: state.channels.map(each => (each.id === channelId ? { ...each, ...patch } : each))
    }))
  }

  it.each([
    ['archived', { state: 'archived' as const }],
    ['made private', { visibility: 'private' as const }]
  ])('refuses, with nothing created, when the channel was %s under an open menu', async (_label, patch) => {
    const adapter = playgroundCompanyDesktopAdapter()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')
    const { probe } = open(general, adapter)

    await waitFor(() => expect(probe().getAttribute('data-capture')).toBe('offered'))
    const stale = captured!
    changeChannel(general.id, patch)

    await expect(stale.capture('Send the quote before Friday', LINK)).rejects.toThrow('company_board_capture_unavailable')
    expect(commandBoard).not.toHaveBeenCalled()
  })

  it('refuses a link to another room or company than the open channel', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')
    const { probe } = open(general, adapter)

    await waitFor(() => expect(probe().getAttribute('data-capture')).toBe('offered'))
    const elsewhere = matrixMessageLink({ companyId: COMPANY_ID, roomId: '!leadership:atum.example', eventId: '$x:atum.example' })
    const otherCompany = matrixMessageLink({ companyId: OTHER_COMPANY_ID, roomId: '!general:atum.example', eventId: '$x:atum.example' })

    await expect(captured!.capture('Words', elsewhere)).rejects.toThrow('company_board_capture_unavailable')
    await expect(captured!.capture('Words', otherCompany)).rejects.toThrow('company_board_capture_unavailable')
    expect(commandBoard).not.toHaveBeenCalled()
  })

  it('creates one task however fast it is activated twice', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')
    const { probe } = open(general, adapter)

    await waitFor(() => expect(probe().getAttribute('data-capture')).toBe('offered'))
    const capture = captured!
    await act(() => Promise.all([capture.capture('Send the quote', LINK), capture.capture('Send the quote', LINK)]))

    expect(commandBoard).toHaveBeenCalledOnce()
  })

  it('asks for the same task again when the same person turns the same message into one again', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')
    const { probe } = open(general, adapter)

    await waitFor(() => expect(probe().getAttribute('data-capture')).toBe('offered'))
    await act(() => captured!.capture('Send the quote', LINK))
    await act(() => captured!.capture('Send the quote', LINK))
    await act(() => captured!.capture('Send the quote, edited', LINK))

    const [first, second, edited] = commandBoard.mock.calls.map(call => call[1] as { requestId: string; cardId: string })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    expect(first!.requestId).toMatch(uuid)
    expect(first!.cardId).toMatch(uuid)
    expect(second).toMatchObject({ requestId: first!.requestId, cardId: first!.cardId })
    expect(edited!.requestId).not.toBe(first!.requestId)
    expect(edited!.cardId).not.toBe(first!.cardId)
  })

  it.each([
    ['a private channel', leadership],
    ['an archived channel', old]
  ])('is not offered in %s, so its words never become a company-wide card', async (_label, channel) => {
    const { probe } = open(channel)

    // The directory has loaded (the public channel is drawn) and still nothing is offered here.
    await screen.findByRole('button', { name: 'Open # general' })
    expect(probe().getAttribute('data-capture')).toBe('none')
  })
})

describe('S10 a task made from a message leads back to it', () => {
  it('shows the message link as Open message, not raw text, and opens that message in Chat', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const created = await adapter.commandBoard(TEAM_COMPANY_ID, {
      schemaVersion: 1, operation: 'create', requestId: globalThis.crypto.randomUUID(),
      cardId: '00000000-0000-4000-8000-95da4980735f', title: 'Send the quote', description: `Before Friday\n\n${LINK}`
    }, '1.1')
    const cardId = 'card' in created ? created.card.cardId : created.currentCard.cardId
    installCompanyDesktop(aiView({ companyId: TEAM_COMPANY_ID }), adapter)
    const scope = `account-a\u0000${TEAM_COMPANY_ID}`
    $companySpacePreferences.set({ [scope]: { ...companySpacePreferences(scope), tab: 'board', selectedCardId: cardId } })

    inEnglish(<CompanyBoard companyId={TEAM_COMPANY_ID} members={[]} projects={[]} scope={scope} />)

    const source = await screen.findByRole('button', { name: 'Open message' })
    const detail = source.closest('aside') ?? document.body
    expect(within(detail as HTMLElement).queryByText(LINK)).toBeNull()
    expect(within(detail as HTMLElement).getByText('Before Friday')).toBeTruthy()

    fireEvent.click(source)
    expect($matrixMessageLinkRequest.get()?.target).toEqual(parseMatrixMessageLink(LINK))
    expect(companySpacePreferences(scope).tab).toBe('chat')
  })
})

describe('S10 the board says when it may be behind', () => {
  const scope = `account-a\u0000${TEAM_COMPANY_ID}`

  async function openBoard(adapter: CompanyDesktopAdapter) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    installCompanyDesktop(aiView({ companyId: TEAM_COMPANY_ID }), adapter)
    inEnglish(<CompanyBoard companyId={TEAM_COMPANY_ID} members={[]} projects={[]} scope={scope} />)
    await screen.findByText('Send launch draft')
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the cards, shows one Not up to date line with Retry, and clears it once a check gets through', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const readBoardView = vi.spyOn(adapter, 'readBoardView')
    await openBoard(adapter)
    readBoardView.mockRejectedValueOnce(new Error('unavailable'))

    await act(() => vi.advanceTimersByTimeAsync(15_000))
    const stale = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-company-board-stale]')
      expect(found).toBeTruthy()

      return found!
    })
    expect(stale.textContent).toContain('Not up to date')
    expect(screen.getByText('Send launch draft')).toBeTruthy()

    fireEvent.click(within(stale).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(document.querySelector('[data-company-board-stale]')).toBeNull())
    expect(readBoardView).toHaveBeenCalledTimes(2)
  })

  it('stops showing the board once the platform refuses this person', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const readBoardView = vi.spyOn(adapter, 'readBoardView')
    await openBoard(adapter)
    readBoardView.mockRejectedValue(new Error('denied'))

    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(await screen.findByText('Board is unavailable.')).toBeTruthy()
    expect(screen.queryByText('Send launch draft')).toBeNull()
    expect(document.querySelector('[data-company-board-stale]')).toBeNull()
  })
})
