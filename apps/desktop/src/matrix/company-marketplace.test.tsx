import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'
import type { MatrixCompanyStoreSnapshot } from '../../shared/matrix-company-store'
import type { MatrixStoreOffer } from '../../shared/matrix-store'

import { CompanyMarketplace } from './company-marketplace'
import {
  $companyMarketplaces,
  companySpaceTabIds,
  effectiveCompanySpaceTab,
  refreshCompanyMarketplace,
  resetCompanyMarketplaces
} from './company-marketplace-store'
import { $companySpacePreferences, patchCompanySpacePreferences } from './company-space-store'
import { CompanySpaceTabs } from './company-space-tabs'
import { playgroundCompanyDesktopAdapter } from './playground/company-ai-fixtures'
import {
  PLAYGROUND_BOOKKEEPER_AGENT,
  PLAYGROUND_CHIEF_PRINCIPAL,
  PLAYGROUND_MARKETER_AGENT,
  playgroundCompanyStore,
  type PlaygroundCompanyStoreMode
} from './playground/company-store-fixtures'
import { TEAM_COMPANY_ID } from './playground/team-space-fixtures'
import { companyActionText, companyTermsText } from './store/company-store-detail'
import { matrixStoreCopy } from './store/store-copy'

const SCOPE = `account-a\u0000${TEAM_COMPANY_ID}`

function install(mode: PlaygroundCompanyStoreMode = 'owner') {
  const companyStore = playgroundCompanyStore(mode)
  const companyDesktop = playgroundCompanyDesktopAdapter(mode === 'member')
  // The personal Store is present, as in the app, so a test can prove the company page never uses it.
  const store = { purchase: vi.fn(), refresh: vi.fn(), resume: vi.fn(), cancel: vi.fn() }
  const readWallet = vi.spyOn(companyDesktop, 'readWallet')
  ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop, companyStore, store }

  return { companyStore, readWallet, store }
}

function view(node: React.ReactNode, locale = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

async function marketplace(mode: PlaygroundCompanyStoreMode = 'owner') {
  const bridge = install(mode)
  await act(async () => {
    await refreshCompanyMarketplace(SCOPE, TEAM_COMPANY_ID)
  })
  view(<CompanyMarketplace chief={{ principal: PLAYGROUND_CHIEF_PRINCIPAL, name: 'Chief of Staff', ready: true }} companyId={TEAM_COMPANY_ID} scope={SCOPE} />)
  await screen.findByRole('region', { name: 'Your team' })

  return bridge
}

function openItem(title: string) {
  const shelf = screen.getByRole('region', { name: title === 'Research brief' || title === 'Spreadsheet cleanup' ? 'Skills' : 'Assistants' })
  fireEvent.click(within(shelf).getByText(title))

  return screen.findByRole('dialog')
}

/** The line under the Hire press, as read aloud (the Proton mark keeps its words for screen readers). */
function dialogTerms(dialog: HTMLElement) {
  return dialog.querySelector('[data-company-store-terms]')?.textContent?.replace(/\s+/gu, ' ').trim()
}

function purchases(bridge: ReturnType<typeof install>) {
  return bridge.companyStore.calls.filter(call => call.action === 'purchase')
}

beforeEach(() => {
  resetCompanyMarketplaces()
  $companySpacePreferences.set({})
})

afterEach(() => {
  delete (window as unknown as { atumMatrix?: unknown }).atumMatrix
})

describe('Company title pages', () => {
  it('shows Chat · Board · Marketplace once the company Store answers, with roving arrow keys', async () => {
    install()
    view(<CompanySpaceTabs placement="inline" scope={SCOPE} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Chat', 'Board'])

    await act(async () => {
      await refreshCompanyMarketplace(SCOPE, TEAM_COMPANY_ID)
    })

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Chat', 'Board', 'Marketplace'])

    act(() => tabs[1]!.focus())
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect($companySpacePreferences.get()[SCOPE]?.tab).toBe('marketplace')
    expect(window.document.activeElement).toBe(screen.getByRole('tab', { name: 'Marketplace' }))
    expect(screen.getByRole('tab', { name: 'Marketplace' }).getAttribute('aria-selected')).toBe('true')

    // It wraps: right from Marketplace is Chat.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Marketplace' }), { key: 'ArrowRight' })
    expect($companySpacePreferences.get()[SCOPE]?.tab).toBe('chat')
  })

  it('has no Marketplace page without the capability or anything to get, and a remembered one opens Chat', () => {
    const absent: MatrixCompanyStoreSnapshot = {
      companyId: TEAM_COMPANY_ID,
      state: 'ready',
      capability: 'absent',
      marketplaceAvailable: false,
      viewer: { canAct: true },
      items: [],
      entitlements: [],
      agents: [],
      pending: []
    }

    expect(companySpaceTabIds(undefined)).toEqual(['chat', 'board'])
    expect(companySpaceTabIds(absent)).toEqual(['chat', 'board'])
    expect(companySpaceTabIds({ ...absent, capability: 'supported' })).toEqual(['chat', 'board'])
    expect(effectiveCompanySpaceTab('marketplace', absent)).toBe('chat')

    $companyMarketplaces.set({ [SCOPE]: absent })
    patchCompanySpacePreferences(SCOPE, { tab: 'marketplace' })
    view(<CompanySpaceTabs placement="inline" scope={SCOPE} />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('Company Marketplace', () => {
  it('lists only what the company can use now, with the Chief of Staff and hires under Your team', async () => {
    await marketplace()

    const assistants = screen.getByRole('region', { name: 'Assistants' })
    expect(within(assistants).getByText('Researcher')).toBeTruthy()
    // The undeliverable listing is never drawn: no dead Hire.
    expect(screen.queryByText('Travel planner')).toBeNull()

    const team = screen.getByRole('region', { name: 'Your team' })
    expect(within(team).getByText('Chief of Staff')).toBeTruthy()
    expect(within(team).getByText('Included')).toBeTruthy()
    expect(within(team).getByText('Renews Dec 7')).toBeTruthy()
    expect(within(team).getByText('Paused')).toBeTruthy()
  })

  it('gives a member the listings and prices, one line in place of Hire, and no balance', async () => {
    const bridge = await marketplace('member')

    expect(screen.queryByText('Company wallet')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Protons' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop renewing' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull()
    expect(bridge.readWallet).not.toHaveBeenCalled()

    const dialog = await openItem('Researcher')
    expect(within(dialog).getByText('Owners and admins can hire.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Hire/u })).toBeNull()
    expect(within(dialog).queryByText('Company wallet')).toBeNull()
    expect(within(dialog).getByText(/39,000/u)).toBeTruthy()
    expect(purchases(bridge)).toHaveLength(0)
    expect(bridge.store.purchase).not.toHaveBeenCalled()
  })

  it('hires into the company with one labelled press, from the company wallet, and never the personal Store', async () => {
    const bridge = await marketplace()
    await waitFor(() => expect(screen.getByText('485,000')).toBeTruthy())

    const dialog = await openItem('Researcher')
    expect(within(dialog).getByText('Assistant for the company')).toBeTruthy()
    expect(dialogTerms(dialog)).toBe('then 39,000/mo · Paid from the company wallet. Cancel anytime.')
    // No renewal checkbox and no personal assistant picker: the labelled press is the consent.
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(within(dialog).queryByRole('combobox')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire · 8,000 Protons first month' }))

    expect(await within(dialog).findByText('Researcher joined the company.')).toBeTruthy()
    expect(purchases(bridge)).toEqual([
      {
        action: 'purchase',
        companyId: TEAM_COMPANY_ID,
        input: { offerId: expect.any(String), offerVersion: 1, target: { hire: {} }, consentRenewal: true }
      }
    ])
    expect(bridge.store.purchase).not.toHaveBeenCalled()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const team = screen.getByRole('region', { name: 'Your team' })
    await waitFor(() => expect(within(team).getByText('Researcher')).toBeTruthy())
    expect(within(team).getByText('Getting ready…')).toBeTruthy()
  })

  it('adds a skill to the Chief of Staff by default, choosable among company agents only', async () => {
    const bridge = await marketplace()
    const dialog = await openItem('Research brief')

    expect(within(dialog).getByText(/Chief of Staff/u)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }))
    const picker = within(dialog).getByRole('combobox')
    expect(within(picker).getAllByRole('option').map(option => option.textContent)).toEqual(['Chief of Staff', 'Marketer'])
    fireEvent.change(picker, { target: { value: PLAYGROUND_MARKETER_AGENT } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add · 12,000 Protons' }))
    expect(await within(dialog).findByText('Added to Marketer.')).toBeTruthy()
    expect(purchases(bridge)[0]?.input).toMatchObject({ target: { agentId: PLAYGROUND_MARKETER_AGENT } })
    expect(purchases(bridge)[0]?.input).not.toHaveProperty('consentRenewal')
  })

  it('turns a short company wallet into the company fund action, filled with what is missing', async () => {
    const bridge = await marketplace('short')
    const dialog = await openItem('Researcher')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire · 8,000 Protons first month' }))
    expect(await within(dialog).findByText('The company needs 5,500 more Protons.')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Protons' }))
    const amount = await within(dialog).findByRole('textbox', { name: 'Protons to move' })
    expect((amount as HTMLInputElement).value).toBe('5500')
    // The person still reviews the exact debit; nothing moved yet.
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(within(dialog).getByRole('button', { name: 'Add Protons' })).toBeTruthy()
    expect(purchases(bridge)).toHaveLength(1)
    expect(bridge.store.purchase).not.toHaveBeenCalled()
  })

  it('keeps an unconfirmed hire to Check again, which replays it instead of buying twice', async () => {
    const bridge = await marketplace('uncertain')
    const dialog = await openItem('Researcher')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire · 8,000 Protons first month' }))
    expect(await within(dialog).findByText('Not confirmed yet. Checking again never charges twice.')).toBeTruthy()
    // The pending row is back from native: the sheet offers only Check again.
    const check = await within(dialog).findByRole('button', { name: 'Check again' })
    expect(within(dialog).queryByRole('button', { name: /Hire/u })).toBeNull()

    fireEvent.click(check)
    expect(await within(dialog).findByText('Researcher joined the company.')).toBeTruthy()
    expect(purchases(bridge)).toHaveLength(1)
    expect(bridge.companyStore.calls.filter(call => call.action === 'resume')).toHaveLength(1)
  })

  it('shows a hire left unconfirmed by an earlier run as In progress, and its sheet as Check again only', async () => {
    const bridge = await marketplace('pending')
    const progress = screen.getByRole('region', { name: 'In progress' })
    expect(within(progress).getByText('Writer & Editor')).toBeTruthy()

    const dialog = await openItem('Writer & Editor')
    expect(within(dialog).getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /Hire/u })).toBeNull()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(within(progress).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull())
    expect(purchases(bridge)).toHaveLength(0)
  })

  it('stops renewing after a confirm, and renews a paused hire for the same agent', async () => {
    const bridge = await marketplace()
    const marketer = window.document.querySelector(`[data-company-marketplace-agent="${PLAYGROUND_MARKETER_AGENT}"]`) as HTMLElement

    fireEvent.click(within(marketer).getByRole('button', { name: 'Stop renewing' }))
    expect(within(marketer).getByText('Marketer keeps working until Dec 7.')).toBeTruthy()
    expect(bridge.companyStore.calls.some(call => call.action === 'cancel')).toBe(false)
    fireEvent.click(within(marketer).getByRole('button', { name: 'Stop renewing' }))
    await waitFor(() => expect(within(marketer).getByText('Ends Dec 7')).toBeTruthy())
    expect(bridge.companyStore.calls.filter(call => call.action === 'cancel')).toHaveLength(1)

    const bookkeeper = window.document.querySelector(`[data-company-marketplace-agent="${PLAYGROUND_BOOKKEEPER_AGENT}"]`) as HTMLElement
    fireEvent.click(within(bookkeeper).getByRole('button', { name: 'Renew' }))
    await waitFor(() => expect(within(bookkeeper).getByText('Renews Dec 7')).toBeTruthy())
    expect(purchases(bridge)[0]?.input).toMatchObject({
      target: { agentId: PLAYGROUND_BOOKKEEPER_AGENT },
      consentRenewal: true
    })
    expect(bridge.store.purchase).not.toHaveBeenCalled()
  })

  it('charges a first-month offer at its first-month price on the badge and the press, with the renewal under it', async () => {
    await marketplace()
    const assistants = screen.getByRole('region', { name: 'Assistants' })
    // Every badge is what today costs: the first month where an offer has one, otherwise the month.
    expect(within(assistants).getByRole('button', { name: '8,000 Protons: Researcher' })).toBeTruthy()
    expect(within(assistants).getByRole('button', { name: '39,000 Protons: Writer & Editor' })).toBeTruthy()

    const researcher = await openItem('Researcher')
    expect(within(researcher).getByRole('button', { name: 'Hire · 8,000 Protons first month' })).toBeTruthy()
    expect(dialogTerms(researcher)).toBe('then 39,000/mo · Paid from the company wallet. Cancel anytime.')
    expect(within(researcher).queryByRole('button', { name: /39,000/u })).toBeNull()
    fireEvent.keyDown(researcher, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // A plain monthly hire: the press already says the month, so the line only says who pays.
    const writer = await openItem('Writer & Editor')
    expect(within(writer).getByRole('button', { name: 'Hire · 39,000 Protons / month' })).toBeTruthy()
    expect(dialogTerms(writer)).toBe('Paid from the company wallet. Cancel anytime.')
  })

  it('words the press and the renewal line for a free first month and a skill, in English and Vietnamese', () => {
    const offer = (priceMicroProtons: number, renewal?: number): MatrixStoreOffer => ({
      id: 'offer',
      version: 1,
      priceMicroProtons,
      scope: renewal === undefined ? 'agent' : 'account',
      billingInterval: renewal === undefined ? 'one_time' : 'month',
      delivery: 'cloud',
      ...(renewal === undefined ? {} : { renewalPriceMicroProtons: renewal })
    })

    const say = (locale: string, value: MatrixStoreOffer) => {
      const copy = matrixCompanyBoardCopy(locale)
      const storeCopy = matrixStoreCopy(locale)

      return [companyActionText(value, copy, storeCopy, locale).text, companyTermsText(value, copy, storeCopy, locale).text]
    }

    expect(say('en', offer(0, 39_000_000_000))).toEqual([
      'Hire · free first month',
      'then 39,000/mo · Paid from the company wallet. Cancel anytime.'
    ])
    expect(say('en', offer(12_000_000_000))).toEqual(['Add · 12,000 Protons', 'Paid from the company wallet.'])
    expect(say('vi', offer(8_000_000_000, 39_000_000_000))).toEqual([
      'Thuê · 8.000 Proton tháng đầu',
      'sau đó 39.000/tháng · Trả từ ví công ty. Hủy bất cứ lúc nào.'
    ])
    expect(say('vi', offer(0, 39_000_000_000))[0]).toBe('Thuê · tháng đầu miễn phí')
  })

  it('speaks Vietnamese', async () => {
    install()
    await act(async () => {
      await refreshCompanyMarketplace(SCOPE, TEAM_COMPANY_ID)
    })
    view(<CompanyMarketplace companyId={TEAM_COMPANY_ID} scope={SCOPE} />, 'vi')
    expect(await screen.findByRole('region', { name: 'Đội của bạn' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nạp Proton' })).toBeTruthy()
  })
})
