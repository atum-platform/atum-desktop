import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { CompanyAIAnswer } from './company-ai-answer'
import { companyAIMentionMatch, companyAIMentionUserIds, insertCompanyAIMention } from './company-ai-mention'
import { CompanyAIAvatar, CompanyAIStatus } from './company-ai-status'
import { CompanyBoard } from './company-board'
import { CompanyProjectBrief } from './company-project-brief'
import { $companyAIStatuses, $companySpacePreferences } from './company-space-store'
import { CompanySpaceTabs } from './company-space-tabs'
import { CompanyWalletDrawer } from './company-wallet'
import {
  COMPANY_AI_ANSWER_FIXTURE,
  COMPANY_AI_CHANNEL_ID,
  COMPANY_BRAIN_FIXTURE,
  playgroundCompanyDesktopAdapter
} from './playground/company-ai-fixtures'
import { TEAM_COMPANY_ID, TEAM_PROJECT_ID } from './playground/team-space-fixtures'
import { CompanyMenu } from './team-space/company-menu'

const MEMBER = 'RiUVmyo5zEPwmNwDTzUkOZ9pssoNpuFAbofjwAsJyS8'
const LAN = 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew'
const QUAN = 'DBmU8tVC5nRl7iK9TD1_HUAMix4-Oxfk7bPM6--O_T8'

function withLocale(node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )
}

function installAdapter(adapter = playgroundCompanyDesktopAdapter()) {
  ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop: adapter }

  return adapter
}

function board(adapter = playgroundCompanyDesktopAdapter()) {
  installAdapter(adapter)
  withLocale(
    <CompanyBoard
      citationChannels={{ [COMPANY_AI_CHANNEL_ID]: 'launch' }}
      citationContext={{ senderName: citation => (citation.kind === 'channel' ? 'Quân' : undefined) }}
      companyId={TEAM_COMPANY_ID}
      members={[
        { memberRef: MEMBER, displayName: 'Minh' },
        { memberRef: LAN, displayName: 'Lan Nguyễn' },
        { memberRef: QUAN, displayName: 'Quân' }
      ]}
      projects={[{ id: TEAM_PROJECT_ID, displayName: 'Release B' }]}
      scope="account-a\u0000company-a"
      viewerMemberRef={MEMBER}
    />
  )

  return adapter
}

beforeEach(() => {
  $companyAIStatuses.set({})
  $companySpacePreferences.set({})
  installAdapter()
})

describe('Company pages in the title bar', () => {
  it('draws one tablist, centred inside the shell title bar, with roving arrow focus', async () => {
    const scope = 'account-a\u0000company-a'
    const header = document.createElement('div')
    header.setAttribute('data-atum-main-header', '')
    document.body.append(header)

    try {
      withLocale(<CompanySpaceTabs scope={scope} />)

      await waitFor(() => expect(header.querySelector('[data-company-title-tabs]')).toBeTruthy())
      const strip = header.querySelector('[data-company-title-tabs]') as HTMLElement
      const tabs = within(strip).getAllByRole('tab')

      expect(tabs.map(tab => tab.textContent)).toEqual(['Chat', 'Board'])
      expect(strip.className).toContain('-translate-x-1/2')
      expect(strip.className).toContain('[-webkit-app-region:no-drag]')

      fireEvent.click(within(strip).getByRole('tab', { name: 'Board' }))
      expect($companySpacePreferences.get()[scope]?.tab).toBe('board')

      act(() => within(strip).getByRole('tab', { name: 'Board' }).focus())
      fireEvent.keyDown(within(strip).getByRole('tab', { name: 'Board' }), { key: 'ArrowRight' })
      expect($companySpacePreferences.get()[scope]?.tab).toBe('chat')
      expect(document.activeElement).toBe(within(strip).getByRole('tab', { name: 'Chat' }))
    } finally {
      header.remove()
    }
  })

  it('keeps an inline fallback for stories and focused tests', () => {
    withLocale(<CompanySpaceTabs placement="inline" scope={'account-a\u0000company-a'} />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(document.querySelector('[data-company-title-tabs]')).toBeNull()
  })
})

describe('Company Board Release B UI', () => {
  it('keeps Add task, All projects and one Filter menu, with no wallet action on the board', async () => {
    const adapter = board()
    const listBoard = vi.spyOn(adapter, 'listBoard')

    await screen.findByText('Review supplier terms')

    expect(screen.getByRole('button', { name: 'Add task' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Top up' })).toBeNull()
    expect(screen.queryByText('Top up')).toBeNull()

    // Owner and due live inside the one Filter menu, not as toolbar pickers.
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Due' })).toBeNull()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Filter' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Quân' }))

    await waitFor(() =>
      expect(listBoard).toHaveBeenLastCalledWith(
        TEAM_COMPANY_ID,
        expect.objectContaining({ ownerMemberRef: QUAN, due: 'all', projectId: null })
      )
    )

    expect(document.querySelector('[data-company-filter-active]')).toBeTruthy()
  })

  it('accepts a suggestion, creates with a title and opens detail with owner, due and a human source', async () => {
    const adapter = board()
    const commandBoard = vi.spyOn(adapter, 'commandBoard')

    await screen.findByText('Review supplier terms')
    expect(document.querySelectorAll('[data-board-column]')).toHaveLength(5)

    fireEvent.click(screen.getByText('Review supplier terms'))
    const detail = await screen.findByRole('complementary', { name: 'Task details' })
    fireEvent.click(within(detail).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect((within(detail).getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('to_do'))
    fireEvent.click(within(detail).getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByText('Confirm support rota'))
    const card = await screen.findByRole('complementary', { name: 'Task details' })

    expect(within(card).getByText('Owner')).toBeTruthy()
    expect(within(card).getByRole('button', { name: /^Owner:/ })).toBeTruthy()
    expect(within(card).getByLabelText('Due date')).toBeTruthy()

    // A cited message reads as #channel · sender, never its raw event id.
    const source = within(card).getByRole('button', { name: /#launch · Quân/ })
    expect(source.getAttribute('data-variant')).toBe('link')
    expect(card.textContent).not.toContain('$brief-root')
    expect(card.textContent).not.toContain('from source')
    expect(within(card).getByText(/added this from #launch/)).toBeTruthy()
    expect(card.textContent).not.toMatch(/Checked/)

    fireEvent.change(within(card).getByLabelText('Due date'), { target: { value: '2026-11-01' } })
    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        TEAM_COMPANY_ID,
        expect.objectContaining({
          operation: 'patch',
          patch: expect.objectContaining({ due: expect.objectContaining({ kind: 'date', date: '2026-11-01' }) })
        })
      )
    )

    fireEvent.keyDown(within(card).getByRole('button', { name: /^Owner:/ }), { key: 'Enter' })
    // Quân already owns this task: adding Lan keeps Quân, and Quân stays the primary owner.
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Lan Nguyễn' }))
    await waitFor(() =>
      expect(commandBoard).toHaveBeenCalledWith(
        TEAM_COMPANY_ID,
        expect.objectContaining({
          operation: 'patch',
          patch: { owners: [QUAN, LAN], primaryOwner: QUAN, participants: [] }
        })
      )
    )
    // Several owners are picked in one visit, so the menu stays open until dismissed.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.click(within(card).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Ship release notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(await screen.findByText('Ship release notes')).toBeTruthy()
  })
})

describe('Company AI status and wallet', () => {
  it('shows the one owner switch without a Ready badge', async () => {
    withLocale(<CompanyAIStatus accountKey="account-a" companyId={TEAM_COMPANY_ID} manage />)
    const toggle = await screen.findByRole('switch', { name: 'Chief of Staff' })
    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(screen.queryByText('Ready')).toBeNull()
  })

  it('states only what the owner should act on', async () => {
    const off = playgroundCompanyDesktopAdapter()
    const ready = await off.readAI(TEAM_COMPANY_ID)
    off.readAI = async () => ({ ...ready, enabled: false, state: 'paused' })
    installAdapter(off)

    withLocale(<CompanyAIStatus accountKey="account-a" companyId={TEAM_COMPANY_ID} manage />)
    expect(await screen.findByText('Off')).toBeTruthy()
  })

  it('keeps the Chief of Staff on the neutral shared assistant face', () => {
    const { container } = withLocale(
      <CompanyAIAvatar className="size-8" name="Chief of Staff" principal="00000000-0000-4000-8000-9896148e0625" />
    )

    expect(container.querySelector('.atum-avatar')).toBeTruthy()
    expect(container.querySelector('[data-atum-agent-mark]')).toBeNull()
    expect(container.querySelector('.atum-avatar')?.textContent).toBe('C')
    expect(container.querySelector('[data-atum-assistant-avatar]')).toBeTruthy()
  })

  it('opens the wallet from the company menu only for owners and admins', () => {
    const common = {
      companies: [],
      currentId: TEAM_COMPANY_ID,
      disabled: false,
      onCreate: vi.fn(),
      onInvite: vi.fn(),
      onLeave: vi.fn(),
      onMembers: vi.fn(),
      onOverview: vi.fn(),
      onSettings: vi.fn(),
      onSwitch: vi.fn(),
      onWallet: vi.fn()
    }

    withLocale(
      <CompanyMenu allowed={{ create: false, invite: false, leave: false, members: true, overview: true, settings: true, wallet: true }} {...common}>
        <button type="button">Atum Studio</button>
      </CompanyMenu>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Atum Studio' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Company wallet' })).toBeTruthy()
  })

  it('dispatches every company menu action and company switch', () => {
    const callbacks = {
      onCreate: vi.fn(),
      onInvite: vi.fn(),
      onLeave: vi.fn(),
      onOverview: vi.fn(),
      onSettings: vi.fn(),
      onSwitch: vi.fn(),
      onWallet: vi.fn()
    }

    withLocale(
      <CompanyMenu
        allowed={{ create: true, invite: true, leave: true, members: true, overview: true, settings: true, wallet: true }}
        companies={[
          { id: TEAM_COMPANY_ID, displayName: 'Atum Studio', role: 'admin', badge: null },
          { id: '00000000-0000-4000-8000-9d6eb487c79e', displayName: 'Demoza', role: 'admin', badge: null }
        ]}
        currentId={TEAM_COMPANY_ID}
        disabled={false}
        {...callbacks}
      >
        <button type="button">Atum Studio</button>
      </CompanyMenu>
    )

    const select = (name: string) => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Atum Studio' }), { key: 'Enter' })
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }

    for (const [label, callback] of [
      ['Company overview', callbacks.onOverview],
      ['Company wallet', callbacks.onWallet],
      ['Invite teammates', callbacks.onInvite],
      ['Company settings', callbacks.onSettings],
      ['Add company', callbacks.onCreate],
      ['Leave company', callbacks.onLeave]
    ] as const) {
      select(label)
      expect(callback).toHaveBeenCalledOnce()
    }

    fireEvent.keyDown(screen.getByRole('button', { name: 'Atum Studio' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Demoza · Admin$/ }))
    expect(callbacks.onSwitch).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-9d6eb487c79e')
  })

  it('never draws the wallet menu entry for a member', () => {
    withLocale(
      <CompanyMenu
        allowed={{ create: false, invite: false, leave: false, members: true, overview: true, settings: false, wallet: false }}
        companies={[]}
        currentId={TEAM_COMPANY_ID}
        disabled={false}
        onCreate={vi.fn()}
        onInvite={vi.fn()}
        onLeave={vi.fn()}
        onMembers={vi.fn()}
        onOverview={vi.fn()}
        onSettings={vi.fn()}
        onSwitch={vi.fn()}
        onWallet={vi.fn()}
      >
        <button type="button">Atum Studio</button>
      </CompanyMenu>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Atum Studio' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Company wallet' })).toBeNull()
  })

  it('shows Available only, keeps Held in its tooltip and never exposes the provider URL', async () => {
    installAdapter(playgroundCompanyDesktopAdapter())
    withLocale(<CompanyWalletDrawer companyId={TEAM_COMPANY_ID} onClose={vi.fn()} />)

    const available = await screen.findByText('Available')
    expect(available.parentElement?.textContent).toContain('485,000')
    expect(screen.queryByText('Held')).toBeNull()
    expect(document.querySelector('[data-company-wallet-balances]')?.getAttribute('data-company-wallet-held')).toBe('20,000')

    fireEvent.click((await screen.findAllByRole('button', { name: 'Top up' }))[0]!)
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()
    expect(document.querySelector('[data-company-wallet]')?.textContent).not.toContain('pay.payos.vn')
  })

  it('refuses a member wallet read without drawing any balance', async () => {
    installAdapter(playgroundCompanyDesktopAdapter(true))
    withLocale(<CompanyWalletDrawer companyId={TEAM_COMPANY_ID} onClose={vi.fn()} />)

    expect(await screen.findByText('Only owners and admins can open the company wallet.')).toBeTruthy()
    expect(document.querySelector('[data-company-wallet-balances]')).toBeNull()
  })

  it('uses wallet-specific failure copy and retries the wallet read', async () => {
    const adapter = playgroundCompanyDesktopAdapter()
    const wallet = await adapter.readWallet(TEAM_COMPANY_ID)
    const readWallet = vi.spyOn(adapter, 'readWallet')
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(wallet)
    installAdapter(adapter)

    withLocale(<CompanyWalletDrawer companyId={TEAM_COMPANY_ID} onClose={vi.fn()} />)

    expect(await screen.findByText('Company wallet is unavailable.')).toBeTruthy()
    expect(screen.queryByText('Board is unavailable.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Available')).toBeTruthy()
    expect(readWallet).toHaveBeenCalledTimes(2)
  })
})

describe('Company AI and project summary', () => {
  it('sends the frozen revision-fenced configuration', async () => {
    const base = playgroundCompanyDesktopAdapter()
    const configureAI = vi.spyOn(base, 'configureAI')
    installAdapter(base)

    withLocale(<CompanyAIStatus accountKey="account-a" companyId={TEAM_COMPANY_ID} manage />)
    const toggle = await screen.findByRole('switch', { name: 'Chief of Staff' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(configureAI).toHaveBeenCalledWith(
        TEAM_COMPANY_ID,
        expect.objectContaining({ schemaVersion: 1, expectedRevision: 1, enabled: false })
      )
    )
  })

  it('completes and emits the Chief of Staff Matrix mention', () => {
    const match = companyAIMentionMatch('Please ask @Chief')!
    expect(insertCompanyAIMention('Please ask @Chief', match)).toBe('Please ask @Chief of Staff ')
    expect(
      companyAIMentionUserIds('@Chief of Staff what changed?', {
        schemaVersion: 1,
        companyId: TEAM_COMPANY_ID,
        agent: {
          principal: '00000000-0000-4000-8000-9896148e0625',
          userId: '@chief-of-staff:atum.example',
          displayName: 'Chief of Staff'
        },
        enabled: true,
        revision: 1,
        state: 'ready',
        canManage: false
      })
    ).toEqual(['@chief-of-staff:atum.example'])
  })

  it('renders cited answers as human source links and keeps Checked in the tooltip', async () => {
    withLocale(
      <CompanyAIAnswer
        answer={COMPANY_AI_ANSWER_FIXTURE}
        channelName="launch"
        citationContext={{ senderName: citation => (citation.kind === 'channel' ? 'Quân' : undefined) }}
      />
    )

    const source = screen.getByRole('button', { name: /#launch · Quân/ })
    expect(source.getAttribute('data-variant')).toBe('link')
    expect(document.body.textContent).not.toContain('$brief-root')
    expect(screen.queryByText(/Checked/)).toBeNull()
    expect(document.querySelector('[data-company-ai-freshness="live"]')).toBeTruthy()

    expect(source.getAttribute('data-slot')).toBe('tooltip-trigger')
    source.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await waitFor(() => expect(screen.getAllByText(/Checked Oct 27, 2026/).length).toBeGreaterThan(0))
  })

  it('renders the board-derived brief and routes Open task back to the board', async () => {
    const onOpenTask = vi.fn()
    withLocale(
      <div className="relative h-[700px]">
        <CompanyProjectBrief
          citationChannels={{ [COMPANY_AI_CHANNEL_ID]: 'launch' }}
          citationContext={{ senderName: citation => (citation.kind === 'channel' ? 'Quân' : undefined) }}
          companyId={TEAM_COMPANY_ID}
          onClose={vi.fn()}
          onOpenTask={onOpenTask}
          projectId={TEAM_PROJECT_ID}
        />
      </div>
    )

    expect(await screen.findByText(COMPANY_BRAIN_FIXTURE.brief!.goal.text!)).toBeTruthy()
    expect(screen.queryByText('$launch-root')).toBeNull()
    expect(screen.getAllByRole('button', { name: /#launch · Quân/ }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open task' })[0]!)
    expect(onOpenTask).toHaveBeenCalledWith(COMPANY_BRAIN_FIXTURE.brief!.tasks.accepted[0]!.cardId)
    expect(screen.getByText('Release B includes the master company board.')).toBeTruthy()
    expect(screen.getByText('Who reviews the final supplier terms?')).toBeTruthy()
  })
})
