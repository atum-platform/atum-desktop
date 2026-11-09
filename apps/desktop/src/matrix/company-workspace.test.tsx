import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom } from '../../shared/matrix'
import type {
  MatrixCompanyBridge,
  MatrixCompanyChannelDirectory,
  MatrixCompanyDirectory,
  MatrixCompanyProjectReaderStatus,
  MatrixCompanyProjectSources,
  MatrixCompanyRequest,
  MatrixCompanySnapshot
} from '../../shared/matrix-company'
import type {
  MatrixCompanyPrivateCosCapabilityV13,
  MatrixCompanyPrivateCosView
} from '../../shared/matrix-company-private-cos'

import { MatrixCompanyWorkspace } from './company-workspace'
import { playgroundCompanyDesktopAdapter } from './playground/company-ai-fixtures'
import { TEAM_COMPANY_ID } from './playground/team-space-fixtures'
import { $companyDirectories, companyDirectoryCache } from './team-space/directory-store'
import { teamSpaceKey } from './team-space/keys'
import {
  $companyPrivateCos,
  $companyPrivateCosDiscovery,
  clearCompanyPrivateCos,
  loadCompanyPrivateCos
} from './team-space/private-cos-store'

/** A balance drawn as the Proton mark and the number; the word stays in the DOM for screen readers. */
function protonPhrase(phrase: string) {
  return (_content: string, element: Element | null) => Boolean(element?.matches('[data-proton-amount]') && element.textContent === phrase)
}

afterEach(() => {
  cleanup()
  // The company last open is remembered on the device: one test's choice must not open the next one's.
  window.localStorage.clear()
  $companyDirectories.set({})
  clearCompanyPrivateCos('account-a')
})

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)

const directory = (
  companies: MatrixCompanyDirectory['companies'],
  invitations: MatrixCompanyDirectory['invitations'] = []
): MatrixCompanyDirectory => ({
  schemaVersion: 1,
  companies,
  invitations
})

const snapshot = (id: string, displayName: string, role: 'admin' | 'member' = 'admin'): MatrixCompanySnapshot => ({
  schemaVersion: 1,
  company: { id, displayName, role, authorityGeneration: 1 },
  members: [],
  projects: []
})

const channelDirectory = (companyId: string, names: string[] = []): MatrixCompanyChannelDirectory => ({
  schemaVersion: 1,
  channels: names.map((displayName, index) => ({
    schemaVersion: 1,
    channel: { id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, companyId, displayName,
      visibility: 'company', state: 'provisioning', projectId: null, authorityGeneration: 1, channelGeneration: 1 },
    memberPrincipals: [], room: { state: 'not_provisioned', roomId: null }
  }))
})

const sourceDocument = (companyId: string, projectId: string): MatrixCompanyProjectSources => {
  const channelId = '00000000-0000-4000-8000-e70014261c8b'

  return {
    schemaVersion: 1,
    companyId,
    projectId,
    authorityGeneration: 2,
    sourceGeneration: 0,
    eligibleChannels: [{ channelId, displayName: 'launch-room', state: 'ready' }],
    eligibleFiles: [{
      channelId,
      eventId: '$company-file',
      publishedAt: '2026-10-15T09:00:00+00:00',
      file: { v: 1, company_id: companyId, channel_id: channelId,
        file_id: '00000000-0000-4000-8000-91e33b24c3fd', revision: 1,
        name: 'brief.pdf', content_type: 'application/pdf', size: 12, sha256: 'a'.repeat(64) }
    }],
    sources: [],
    coverage: { state: 'empty' }
  }
}

const noPending = () => Promise.resolve({ ok: true as const, request: null })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, reject, resolve }
}

function renderWorkspace(props: Partial<ComponentProps<typeof MatrixCompanyWorkspace>> = {}) {
  const bridge: MatrixCompanyBridge = {
    pending: noPending,
    request: vi.fn(async input =>
      input.action === 'list'
        ? { ok: true as const, value: directory([]) }
        : { ok: false as const, error: 'missing' as const }
    )
  }

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCompanyWorkspace accountKey="account-a" bridge={bridge} ensureDefaultChannels={false}
        onOpenChannel={vi.fn(async () => {})} overviewFallback projectsEnabled searchEnabled {...props} />
    </I18nProvider>
  )
}

async function submitEmptyCompany(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Create company' }))
  const dialog = await screen.findByRole('dialog', { name: 'New company' })
  fireEvent.change(within(dialog).getByLabelText('Company name'), { target: { value: name } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
}

/** The company name is a menu, even with one company: open it from the keyboard and choose an entry. */
async function chooseFromCompanyMenu(entry: string) {
  fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: entry }))
}

/** The window draws no company rail: another company is chosen from the name menu. */
async function switchCompany(name: string) {
  fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(`^${name} · (Admin|Member)$`) }))
}

/** One company is the page title; two or more keep a chip to select one. */
async function openCompany(name: string) {
  const chip = () => screen.queryByRole('button', { name: new RegExp(`^${name} · (Admin|Member)$`) })

  await waitFor(() => {
    expect(screen.queryByRole('heading', { name }) ?? screen.queryByText(name) ?? chip()).toBeTruthy()
  })

  if (chip()) {fireEvent.click(chip()!)}

  await waitFor(() => expect(chip()?.getAttribute('aria-pressed') ?? 'true').toBe('true'))
  await waitFor(() => expect(document.querySelector('[data-matrix-company-detail]')).toBeTruthy())
}

describe('company funding integration', () => {
  const company = { id: 'company-a', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }

  const wallet = { schemaVersion: 1 as const, companyId: company.id, unit: 'micro_proton' as const, checkoutOpen: false as const,
    balances: { paid: 2000000, earned: 0, promo: 0, held: 0, available: 2000000 },
    funding: { enabled: false, taskLimit: 1000000, revision: 1 } }

  it('discloses retained pending consent after a gate-off restart and blocks other company changes', async () => {
    const intent = { action: 'funding' as const, companyId: company.id, requestId: '00000000-0000-4000-8000-b4b6412c243e', enabled: true, taskLimit: 1000000 }

    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: intent })),
      request: vi.fn<MatrixCompanyBridge['request']>(async () => ({ ok: true, value: directory([company]) })) }

    renderWorkspace({ bridge, fundingEnabled: false })
    await screen.findByText(/Shared spending is turned off for now/)
    expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
    // Creation lives only in the empty state: never under an existing company.
    expect(screen.queryByLabelText('Company name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create company' })).toBeNull()
    // Personal stays one click away: Workplace's switch owns it (workspace.test.tsx).
    expect(bridge.request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet' }))
  })

  it('keeps a different company policy known while an older company consent awaits recovery', async () => {
    const other = { ...company, id: 'company-b', displayName: 'Beta' }
    const intent = { action: 'funding' as const, companyId: company.id, requestId: '00000000-0000-4000-8000-b4b6412c243e', enabled: true, taskLimit: 1000000 }

    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: intent })),
      request: vi.fn<MatrixCompanyBridge['request']>(async input => {
        if (input.action === 'list') { return { ok: true, value: directory([company, other]) } }

        if (input.action === 'read') { return { ok: true, value: snapshot(other.id, other.displayName) } }

        return { ok: true, value: { ...wallet, companyId: other.id, funding: { ...wallet.funding, enabled: true } } }
      }) }

    renderWorkspace({ bridge, fundingEnabled: true })
    await screen.findByRole('button', { name: 'Retry' })
    await switchCompany('Beta')
    await screen.findByText(protonPhrase('2 Protons'))
    expect(screen.getByRole('checkbox', { name: 'Let assistants spend company Protons' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: 'Save spending settings' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('Checking the current settings…')).toBeNull()
  })

  it.each([{ fundingEnabled: false, role: 'admin' }, { fundingEnabled: true, role: 'member' }] as const)(
    'never reads a company wallet when controls are disabled or the person is a member (%j)', async ({ fundingEnabled, role }) => {
      const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn<MatrixCompanyBridge['request']>(async input => input.action === 'list'
        ? { ok: true, value: directory([{ ...company, role }]) }
        : { ok: true, value: snapshot(company.id, company.displayName, role) }) }

      renderWorkspace({ bridge, fundingEnabled })
      await openCompany('Acme')
      await screen.findByRole('heading', { name: 'Acme' })
      expect(screen.queryByRole('region', { name: 'Shared spending' })).toBeNull()
      expect(bridge.request).not.toHaveBeenCalledWith({ action: 'wallet', companyId: company.id })
    }
  )

  it('retries funding consent with its exact request and revalidates the current wallet after success', async () => {
    const inputs: MatrixCompanyRequest[] = []
    let configured = false
    let fundingAttempts = 0

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn<MatrixCompanyBridge['request']>(async input => {
      inputs.push(input)

      if (input.action === 'list') { return { ok: true, value: directory([company]) } }

      if (input.action === 'read') { return { ok: true, value: snapshot(company.id, company.displayName) } }

      if (input.action === 'funding') {
        if (++fundingAttempts === 1) { return { ok: false, error: 'unavailable' } }
        configured = true
      }

      return { ok: true, value: { ...wallet, funding: { ...wallet.funding, enabled: configured } } }
    }) }

    renderWorkspace({ bridge, fundingEnabled: true })
    await openCompany('Acme')
    await screen.findByText(protonPhrase('2 Protons'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let assistants spend company Protons' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByText('Checking the current settings…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save spending settings' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fundingAttempts).toBe(2))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Let assistants spend company Protons' }).getAttribute('aria-checked')).toBe('true'))
    const funding = inputs.filter(input => input.action === 'funding')
    expect(funding[0]).toEqual(funding[1])
    expect(funding[0]).toMatchObject({ companyId: company.id, enabled: true, taskLimit: 1000000 })
    expect(inputs.filter(input => input.action === 'wallet')).toHaveLength(2)
  })

  it('withdraws the selected company details and wallet after definitive mutation denial', async () => {
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn<MatrixCompanyBridge['request']>(async input => {
      if (input.action === 'list') { return { ok: true, value: directory([company]) } }

      if (input.action === 'read') { return { ok: true, value: snapshot(company.id, company.displayName) } }

      if (input.action === 'funding') { return { ok: false, error: 'denied' } }

      return { ok: true, value: wallet }
    }) }

    renderWorkspace({ bridge, fundingEnabled: true })
    await openCompany('Acme')
    await screen.findByText(protonPhrase('2 Protons'))
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Acme' })).toBeNull())
    expect(screen.queryByText(protonPhrase('2 Protons'))).toBeNull()
  })
})

describe('MatrixCompanyWorkspace', () => {
  it('never mounts an unverified private-CoS transcript, including behind company overview', async () => {
    const company = {
      id: '00000000-0000-4000-8000-4423c334534f',
      displayName: 'Acme',
      role: 'admin' as const,
      authorityGeneration: 1
    }
    const room: MatrixRoom = {
      id: '!stale-private-cos:test',
      name: 'Chief of Staff',
      membership: 'join',
      encrypted: false,
      roomType: 'io.atum.assistant',
      companyPrivateCos: {
        v: 1,
        classification: 'company_private_cos',
        companyId: company.id,
        membershipIncarnation: '00000000-0000-4000-8000-a6350151b493',
        executorId: '00000000-0000-4000-8000-01670d853f95'
      }
    }
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {
          return { ok: true as const, value: snapshot(company.id, company.displayName) }
        }
        if (input.action === 'list-channels') {
          return { ok: true as const, value: channelDirectory(company.id) }
        }

        return { ok: false as const, error: 'missing' as const }
      })
    }

    renderWorkspace({
      activeRoomId: room.id,
      bridge,
      channelContent: <div>stale private transcript secret</div>,
      overviewFallback: false,
      preferredCompanyId: company.id,
      rooms: [room]
    })

    await screen.findByRole('heading', { name: 'Acme' })
    expect(screen.queryByText('stale private transcript secret')).toBeNull()
    await chooseFromCompanyMenu('Company overview')
    expect(await screen.findByRole('heading', { name: 'Company overview' })).toBeTruthy()
    expect(screen.queryByText('stale private transcript secret')).toBeNull()
  })

  it('searches exact company messages and opens one reauthorized result', async () => {
    const company = { id: '00000000-0000-4000-8000-4423c334534f', displayName: 'Acme', role: 'admin' as const,
      authorityGeneration: 1 }
    const channelId = '00000000-0000-4000-8000-a6350151b493'
    const channels = channelDirectory(company.id, ['general'])
    channels.channels[0]!.channel.id = channelId
    channels.channels[0]!.channel.state = 'active'
    channels.channels[0]!.room = { state: 'ready', roomId: '!general:test' }
    const found = { channelId, roomId: '!general:test', channelName: 'general', eventId: '$message',
      sender: '@avery:test', snippet: 'Exact launch needle', at: 100 }
    const open = vi.fn(async () => ({ ok: true as const }))
    const search = vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, companyId: company.id,
      query: 'launch', coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false }, results: [found] } }))
    const reveal = vi.fn(async () => {})
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => input.action === 'list'
        ? { ok: true as const, value: directory([company]) }
        : input.action === 'read'
          ? { ok: true as const, value: snapshot(company.id, company.displayName) }
          : { ok: true as const, value: channels }),
      search,
      open
    }

    renderWorkspace({ bridge, onOpenSearchResult: reveal })
    await openCompany('Acme')
    const input = await screen.findByRole('textbox', { name: 'Search company messages' })
    fireEvent.change(input, { target: { value: ' launch ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Exact launch needle')).toBeTruthy()
    expect(screen.getByText('Searched 1 of 1 ready channels')).toBeTruthy()
    const resultButton = screen.getByRole('button', { name: /Open result in # general.*Exact launch needle/ })
    expect(resultButton.getAttribute('aria-label')).toBeNull()
    fireEvent.click(resultButton)
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(found))
    expect(search).toHaveBeenCalledWith({ companyId: company.id, query: 'launch', limit: 25, tab: 'messages', fileType: 'all' })
    expect(open).toHaveBeenCalledWith({ companyId: company.id, channelId, roomId: '!general:test', eventId: '$message' })
  })

  it('offers operator autocomplete, paints parsed chips, and labels client-filtered history', async () => {
    // The before: suggestion is built from today's date; pin only Date so the typed chip and the
    // suggestion agree on any run day (timers stay real for findBy/waitFor).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const company = { id: '00000000-0000-4000-8000-4423c334534f', displayName: 'Acme', role: 'admin' as const,
      authorityGeneration: 1 }
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => input.action === 'list'
        ? { ok: true as const, value: directory([company]) }
        : input.action === 'read'
          ? { ok: true as const, value: snapshot(company.id, company.displayName) }
          : { ok: true as const, value: channelDirectory(company.id, ['general']) }),
      search: vi.fn(async input => ({ ok: true as const, value: { schemaVersion: 1 as const, companyId: company.id,
        query: input.query, coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false,
          source: 'loaded_history' as const }, results: [] } })),
      open: vi.fn()
    }

    renderWorkspace({ bridge, onOpenSearchResult: vi.fn() })
    await openCompany('Acme')
    const input = await screen.findByRole('textbox', { name: 'Search company messages' })
    fireEvent.focus(input)
    expect(screen.getByRole('option', { name: /from:@.*From a person/ })).toBeTruthy()
    fireEvent.change(input, { target: { value: '"launch plan" from:@nguyễn before:2026-11-01' } })
    expect(screen.getByText('“launch plan”')).toBeTruthy()
    expect(screen.getByText('from:@nguyễn')).toBeTruthy()
    expect(screen.getAllByText('before:2026-11-01')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Showing results from loaded history.')).toBeTruthy()
  })

  it('filters the Files tab by type and reports an authority refusal without revealing the file', async () => {
    const company = { id: '00000000-0000-4000-8000-4423c334534f', displayName: 'Acme', role: 'admin' as const,
      authorityGeneration: 1 }
    const channelId = '00000000-0000-4000-8000-a6350151b493'
    const file = { channelId, roomId: '!general:test', channelName: 'general', eventId: '$pdf', sender: '@avery:test',
      snippet: 'Launch brief.pdf', at: 100, file: { name: 'Launch brief.pdf', mimeType: 'application/pdf', size: 42,
        type: 'pdfs' as const } }
    const search = vi.fn(async input => ({ ok: true as const, value: { schemaVersion: 1 as const, companyId: company.id,
      query: input.query, coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false,
        source: 'loaded_history' as const }, results: input.fileType === 'pdfs' ? [file] : [] } }))
    const open = vi.fn(async () => ({ ok: false as const, error: 'denied' as const }))
    const reveal = vi.fn(async () => {})
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => input.action === 'list'
        ? { ok: true as const, value: directory([company]) }
        : input.action === 'read'
          ? { ok: true as const, value: snapshot(company.id, company.displayName) }
          : { ok: true as const, value: channelDirectory(company.id, ['general']) }),
      search,
      open
    }

    renderWorkspace({ bridge, onOpenSearchResult: reveal })
    await openCompany('Acme')
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search company messages' }), {
      target: { value: 'launch' }
    })
    fireEvent.click(await screen.findByRole('radio', { name: 'Files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({ tab: 'files', fileType: 'all' })))
    fireEvent.click(screen.getByRole('radio', { name: 'PDFs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Launch brief.pdf')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Launch brief.pdf in # general' }))
    expect((await screen.findByRole('alert')).textContent).toContain('You no longer have access to this company.')
    expect(open).toHaveBeenCalledWith({ companyId: company.id, channelId, roomId: '!general:test', eventId: '$pdf' })
    expect(reveal).not.toHaveBeenCalled()
  })

  it('lists and creates Unicode company channels independently of projects', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const requests: MatrixCompanyRequest[] = []
    let created = false

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      requests.push(input)

      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}

      if (input.action === 'list-channels') {
        return { ok: true as const, value: channelDirectory(company.id, created ? ['Ra mắt Việt Nam'] : []) }
      }

      if (input.action === 'create-channel') {
        created = true

        return { ok: true as const, value: channelDirectory(company.id, ['Ra mắt Việt Nam']).channels[0]! }
      }

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge })
    await openCompany('Acme')
    await screen.findByText('No channels yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))
    const channelInput = screen.getByLabelText('Channel name')
    expect(channelInput.getAttribute('maxlength')).toBe('160')
    fireEvent.change(channelInput, { target: { value: 'Ra mắt Việt Nam' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Create channel' }).at(-1)!)
    await screen.findByText('Ra mắt Việt Nam')
    expect(requests).toContainEqual({ action: 'create-channel', companyId: company.id,
      requestId: expect.any(String), displayName: 'Ra mắt Việt Nam' })
    expect(requests).not.toContainEqual(expect.objectContaining({ projectId: expect.anything() }))
  })

  it('opens a flat project hub and creates a channel with that exact project binding', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const requests: MatrixCompanyRequest[] = []
    const onOpenChannel = vi.fn(async () => {})

    const projects = [{ id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const },
      { id: '00000000-0000-4000-8000-287b5ddbe266', displayName: 'Support', memberPrincipals: [], collaboration: 'not_provisioned' as const }]

    const channels = channelDirectory(company.id, ['general', 'launch-room'])
    channels.channels[0]!.channel.state = 'active'
    channels.channels[0]!.room = { state: 'ready', roomId: '!general:test' }
    channels.channels[1]!.channel.state = 'active'
    channels.channels[1]!.channel.projectId = projectId
    channels.channels[1]!.room = { state: 'ready', roomId: '!launch:test' }

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      requests.push(input)

      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {
        return { ok: true as const, value: { ...snapshot(company.id, company.displayName), projects } }
      }

      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      if (input.action === 'create-channel') {
        const created = channelDirectory(company.id, [input.displayName]).channels[0]!
        created.channel.projectId = input.projectId ?? null

        return { ok: true as const, value: created }
      }

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, onOpenChannel })
    await openCompany('Acme')
    await screen.findByRole('button', { name: 'Launch' })
    expect(screen.queryByRole('region', { name: 'Launch' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    const project = screen.getByRole('region', { name: 'Launch' })
    expect(within(project).getByRole('button', { name: 'Open # launch-room' })).toBeTruthy()
    expect(within(project).queryByRole('button', { name: 'Open # general' })).toBeNull()
    fireEvent.click(within(project).getByRole('button', { name: 'Open # launch-room' }))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!launch:test', expect.any(Function)))

    fireEvent.change(within(project).getByRole('textbox', { name: 'Channel name · Launch' }), {
      target: { value: 'decisions' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    expect((within(project).getByRole('textbox', { name: 'Channel name · Launch' }) as HTMLInputElement).value).toBe('decisions')
    fireEvent.click(within(project).getByRole('button', { name: 'Create channel' }))
    await waitFor(() => expect(requests).toContainEqual({
      action: 'create-channel',
      companyId: company.id,
      projectId,
      requestId: expect.any(String),
      displayName: 'decisions'
    }))
    expect((within(project).getByRole('textbox', { name: 'Channel name · Launch' }) as HTMLInputElement).value).toBe('')
  })

  it('lets a member navigate project channels without exposing create controls', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'member' as const, authorityGeneration: 1 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const channels = channelDirectory(company.id, ['launch-room'])
    channels.channels[0]!.channel.state = 'active'
    channels.channels[0]!.channel.projectId = projectId
    channels.channels[0]!.room = { state: 'ready', roomId: '!launch:test' }

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {
        return { ok: true as const, value: { ...snapshot(company.id, company.displayName, 'member'), projects: [
          { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
        ] } }
      }

      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    const project = screen.getByRole('region', { name: 'Launch' })
    expect(within(project).getByRole('button', { name: 'Open # launch-room' })).toBeTruthy()
    expect(within(project).queryByRole('form')).toBeNull()
    expect(screen.queryByLabelText('Project name')).toBeNull()
  })

  it('loads project sources only after selection and enrolls one channel plus one file at the current generation', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const requests: MatrixCompanyRequest[] = []
    let value = sourceDocument(company.id, projectId)

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      requests.push(input)
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: { ...snapshot(company.id, company.displayName), projects: [project] } }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      if (input.action === 'project-sources') {return { ok: true as const, value }}
      if (input.action === 'include-project-channel-source') {
        value = { ...value, sourceGeneration: 1, coverage: { state: 'pending' }, sources: [{
          id: '00000000-0000-4000-8000-47261dd3dd93', kind: 'channel', state: 'active',
          channelId: input.channelId, enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
        }] }

        return { ok: true as const, value }
      }
      if (input.action === 'include-project-file-source') {
        value = { ...value, sourceGeneration: 2, sources: [...value.sources, {
          id: '00000000-0000-4000-8000-a575cda4f7e5', kind: 'company_file', state: 'active',
          channelId: value.eligibleFiles[0]!.channelId, file: value.eligibleFiles[0]!.file,
          enrolledAt: '2026-10-15T10:01:00+00:00', withdrawnAt: null
        }] }

        return { ok: true as const, value }
      }

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, projectSourcesEnabled: true })
    await openCompany('Acme')
    expect(requests.some(input => input.action === 'project-sources')).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    await screen.findByText('Company brain sources')
    expect(screen.getByText('No sources selected.')).toBeTruthy()
    const channelRow = screen.getByText('# launch-room · Available').closest('li')!
    fireEvent.click(within(channelRow).getByRole('button', { name: 'Add # launch-room' }))
    await screen.findByText('Sources selected · reader pending')
    expect(requests).toContainEqual({ action: 'include-project-channel-source', companyId: company.id, projectId,
      requestId: expect.any(String), channelId: value.eligibleChannels[0]!.channelId, expectedSourceGeneration: 0 })

    const fileRow = screen.getByText('brief.pdf · Available').closest('li')!
    fireEvent.click(within(fileRow).getByRole('button', { name: 'Add brief.pdf' }))
    await waitFor(() => expect(requests).toContainEqual({ action: 'include-project-file-source', companyId: company.id,
      projectId, requestId: expect.any(String), fileId: value.eligibleFiles[0]!.file.file_id, revision: 1,
      expectedSourceGeneration: 1 }))
    expect(value.sourceGeneration).toBe(2)
  })

  it('lets project members see selected source lineage without exposing mutation controls', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'member' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const base = sourceDocument(company.id, projectId)
    const value: MatrixCompanyProjectSources = { ...base, sourceGeneration: 2, coverage: { state: 'pending' }, sources: [{
      id: '00000000-0000-4000-8000-47261dd3dd93', kind: 'channel', state: 'active',
      channelId: base.eligibleChannels[0]!.channelId, enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
    }, {
      id: '00000000-0000-4000-8000-a575cda4f7e5', kind: 'channel', state: 'withdrawn',
      channelId: '00000000-0000-4000-8000-58989c5fa7a2', enrolledAt: '2026-10-15T09:00:00+00:00',
      withdrawnAt: '2026-10-15T09:30:00+00:00'
    }] }
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: { ...snapshot(company.id, company.displayName, 'member'), projects: [project] } }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      if (input.action === 'project-sources') {return { ok: true as const, value }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, projectSourcesEnabled: true })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    await screen.findByText('Sources selected · reader pending')
    expect(screen.getAllByText('# launch-room · Selected').length).toBeGreaterThan(0)
    expect(screen.getByText('# Channel source · Removed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })

  it('overlays only receipt-derived reader coverage and fences it to the selected project generations', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'member' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const base = sourceDocument(company.id, projectId)
    const sourceId = '00000000-0000-4000-8000-47261dd3dd93'
    const sources: MatrixCompanyProjectSources = { ...base, sourceGeneration: 1, coverage: {state: 'pending'}, sources: [{
      id: sourceId, kind: 'channel', state: 'active', channelId: base.eligibleChannels[0]!.channelId,
      enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
    }] }
    const live: MatrixCompanyProjectReaderStatus = {schemaVersion: 2, companyId: company.id, projectId,
      authorityGeneration: 2, sourceGeneration: 1, coverage: {state: 'live', lastIngestedAt: '2026-10-15T10:02:00+00:00'},
      sources: [{sourceId, kind: 'channel', state: 'active', channelId: base.eligibleChannels[0]!.channelId,
        receiptState: 'live', lastIngestedAt: '2026-10-15T10:02:00+00:00'}]}
    const requests: MatrixCompanyRequest[] = []
    const bridge: MatrixCompanyBridge = {pending: noPending, request: vi.fn(async input => {
      requests.push(input)
      if (input.action === 'list') {return {ok: true as const, value: directory([company])}}
      if (input.action === 'read') {return {ok: true as const,
        value: {...snapshot(company.id, company.displayName, 'member'), projects: [project]}}}
      if (input.action === 'list-channels') {return {ok: true as const, value: channelDirectory(company.id)}}
      if (input.action === 'project-sources') {return {ok: true as const, value: sources}}
      if (input.action === 'project-reader') {return {ok: true as const, value: live}}
      return {ok: false as const, error: 'invalid' as const}
    })}

    renderWorkspace({bridge, projectSourcesEnabled: true, projectReaderEnabled: true})
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', {name: 'Launch'}))
    await screen.findByText('Reader live')
    expect(screen.getByText(/Last ingested/)).toBeTruthy()
    expect(requests).toContainEqual({action: 'project-reader', companyId: company.id, projectId})
    expect(screen.queryByRole('button', {name: /evidence|brief|citation/i})).toBeNull()
  })

  it('retries an uncertain source enrollment with the exact request and generation', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const value = sourceDocument(company.id, projectId)
    const mutations: MatrixCompanyRequest[] = []
    let attempts = 0
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: { ...snapshot(company.id, company.displayName), projects: [project] } }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      if (input.action === 'project-sources') {return { ok: true as const, value }}
      if (input.action === 'include-project-channel-source') {
        mutations.push(input)
        if (++attempts === 1) {return { ok: false as const, error: 'unavailable' as const }}

        return { ok: true as const, value: { ...value, sourceGeneration: 1, coverage: { state: 'pending' as const }, sources: [{
          id: '00000000-0000-4000-8000-47261dd3dd93', kind: 'channel' as const, state: 'active' as const,
          channelId: input.channelId, enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
        }] } }
      }

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, projectSourcesEnabled: true })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    const channelRow = (await screen.findByText('# launch-room · Available')).closest('li')!
    fireEvent.click(within(channelRow).getByRole('button', { name: 'Add # launch-room' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await screen.findByText('Sources selected · reader pending')
    expect(mutations).toHaveLength(2)
    expect(mutations[1]).toEqual(mutations[0])
  })

  it('keeps an uncertain source change visible but non-retryable while the source gate is off', async () => {
    const intent = { action: 'include-project-channel-source' as const, companyId: 'company-1',
      projectId: '00000000-0000-4000-8000-072e4e6126bd',
      requestId: '00000000-0000-4000-8000-b4b6412c243e',
      channelId: '00000000-0000-4000-8000-e70014261c8b', expectedSourceGeneration: 0 }
    const bridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: intent })),
      request: vi.fn(async input => input.action === 'list'
        ? { ok: true as const, value: directory([]) }
        : { ok: false as const, error: 'unavailable' as const })
    }

    renderWorkspace({ bridge, projectSourcesEnabled: false })
    await screen.findByText(/Company brain sources are turned off for now/)
    expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
    expect(bridge.request).toHaveBeenCalledExactlyOnceWith({ action: 'list' })
  })

  it('clears project source state immediately when a source mutation is denied', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const base = sourceDocument(company.id, projectId)
    const value: MatrixCompanyProjectSources = { ...base, sourceGeneration: 1, coverage: { state: 'pending' }, sources: [{
      id: '00000000-0000-4000-8000-47261dd3dd93', kind: 'channel', state: 'active',
      channelId: base.eligibleChannels[0]!.channelId, enrolledAt: '2026-10-15T10:00:00+00:00', withdrawnAt: null
    }] }
    let removed = false
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: {
        ...snapshot(company.id, company.displayName), projects: removed ? [] : [project]
      } }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      if (input.action === 'project-sources') {return { ok: true as const, value }}

      if (input.action === 'withdraw-project-source') {removed = true;

 return { ok: false as const, error: 'denied' as const }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, projectSourcesEnabled: true })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove # launch-room' }))
    await screen.findByText('You no longer have access to this company.')
    expect(screen.queryByRole('region', { name: 'Launch' })).toBeNull()
    expect(screen.queryByText('Company brain sources')).toBeNull()
  })

  it('does not publish a late source read after refresh removes the project', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 2 }
    const projectId = '00000000-0000-4000-8000-072e4e6126bd'
    const project = { id: projectId, displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const value = sourceDocument(company.id, projectId)
    const late = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()
    let removed = false
    let sourceReads = 0
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: {
        ...snapshot(company.id, company.displayName), projects: removed ? [] : [project]
      } }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      if (input.action === 'project-sources') {return ++sourceReads === 1 ? { ok: true as const, value } : late.promise}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, projectSourcesEnabled: true })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    await screen.findByText('Company brain sources')
    removed = true
    window.dispatchEvent(new Event('focus'))
    await screen.findByText('No projects yet.')
    expect(screen.queryByText('Company brain sources')).toBeNull()
    await act(async () => late.resolve({ ok: true, value }))
    expect(screen.queryByText('Company brain sources')).toBeNull()
  })

  it('clears the selected project before another company becomes visible', async () => {
    const alpha = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const beta = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }
    const launch = { id: 'project-launch', displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const support = { id: 'project-support', displayName: 'Support', memberPrincipals: [], collaboration: 'not_provisioned' as const }

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([alpha, beta]) }}

      if (input.action === 'read') {
        return { ok: true as const, value: {
          ...snapshot(input.companyId, input.companyId === alpha.id ? alpha.displayName : beta.displayName),
          projects: input.companyId === alpha.id ? [launch] : [support]
        } }
      }

      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(input.companyId) }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge })
    await openCompany('Alpha')
    fireEvent.click(await screen.findByRole('button', { name: 'Create channel' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Channel name' }), {
      target: { value: 'alpha-draft' }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    expect(screen.getByRole('region', { name: 'Launch' })).toBeTruthy()

    await switchCompany('Beta')
    await screen.findByRole('button', { name: 'Support' })
    expect(screen.queryByRole('region', { name: 'Launch' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Channel name · Launch' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Channel name' })).toBeNull()
  })

  it('retries an uncertain project-channel creation without retargeting a later project selection', async () => {
    const company = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const launch = { id: 'project-launch', displayName: 'Launch', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const support = { id: 'project-support', displayName: 'Support', memberPrincipals: [], collaboration: 'not_provisioned' as const }
    const requests: MatrixCompanyRequest[] = []
    let attempts = 0

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      requests.push(input)

      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {
        return { ok: true as const, value: { ...snapshot(company.id, company.displayName), projects: [launch, support] } }
      }

      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}

      if (input.action === 'create-channel') {
        if (++attempts === 1) {return { ok: false as const, error: 'unavailable' as const }}
        const created = channelDirectory(company.id, [input.displayName]).channels[0]!
        created.channel.projectId = input.projectId ?? null

        return { ok: true as const, value: created }
      }

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge })
    await openCompany('Alpha')
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    const launchHub = screen.getByRole('region', { name: 'Launch' })
    fireEvent.change(within(launchHub).getByRole('textbox', { name: 'Channel name · Launch' }), {
      target: { value: 'launch-decisions' }
    })
    fireEvent.click(within(launchHub).getByRole('button', { name: 'Create channel' }))
    await screen.findByRole('button', { name: 'Retry' })

    fireEvent.click(screen.getByRole('button', { name: 'Support' }))
    const supportHub = screen.getByRole('region', { name: 'Support' })
    const supportInput = within(supportHub).getByRole('textbox', { name: 'Channel name · Support' }) as HTMLInputElement
    fireEvent.change(supportInput, { target: { value: 'support-draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(attempts).toBe(2))

    const creates = requests.filter(
      (request): request is Extract<MatrixCompanyRequest, { action: 'create-channel' }> => request.action === 'create-channel'
    )

    expect(creates).toHaveLength(2)
    expect(creates[1]).toBe(creates[0])
    expect(creates[1]).toMatchObject({ projectId: launch.id, displayName: 'launch-decisions' })
    expect(screen.getByRole('region', { name: 'Support' })).toBeTruthy()
    expect(supportInput.value).toBe('support-draft')
  })

  it('distinguishes an archived channel from a room that is still preparing', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const channels = channelDirectory(company.id, ['decisions'])
    channels.channels[0]!.channel.state = 'archived'

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}

      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge })
    await openCompany('Acme')
    await screen.findByText('decisions')
    expect(screen.getByText('Archived')).toBeTruthy()
    expect(screen.queryByText('Preparing')).toBeNull()
  })

  it('only makes ready company rooms openable', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const onOpenChannel = vi.fn(async () => {})
    const channels = channelDirectory(company.id, ['decisions'])
    channels.channels[0]!.room = { state: 'provisioning', roomId: null }

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}

      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, onOpenChannel })
    await openCompany('Acme')
    await screen.findByText('decisions')
    expect(screen.queryByRole('button', { name: 'Open # decisions' })).toBeNull()
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it.each(['not_provisioned', 'reconciling', 'failed'] as const)(
    'keeps a %s company room non-openable',
    async state => {
      const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
      const onOpenChannel = vi.fn(async () => {})
      const channels = channelDirectory(company.id, ['decisions'])
      channels.channels[0]!.room = { state, roomId: null }
      const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
        if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

        return { ok: false as const, error: 'invalid' as const }
      }) }

      renderWorkspace({ bridge, onOpenChannel })
      await openCompany('Acme')
      await screen.findByText('decisions')
      expect(screen.queryByRole('button', { name: 'Open # decisions' })).toBeNull()
      expect(onOpenChannel).not.toHaveBeenCalled()
    }
  )

  it('opens a ready archived channel as a read-only conversation destination', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const onOpenChannel = vi.fn(async () => {})
    const channels = channelDirectory(company.id, ['decisions'])
    channels.channels[0]!.channel.state = 'archived'
    channels.channels[0]!.room = { state: 'ready', roomId: '!decisions:test' }
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, onOpenChannel })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Open # decisions' }))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledExactlyOnceWith('!decisions:test', expect.any(Function)))
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('keeps Company visible and gives a useful error when opening a ready channel fails', async () => {
    const company = { id: 'company-1', displayName: 'Acme', role: 'admin' as const, authorityGeneration: 1 }
    const onOpenChannel = vi.fn(async () => { throw new Error('join denied') })
    const channels = channelDirectory(company.id, ['decisions'])
    channels.channels[0]!.channel.state = 'active'
    channels.channels[0]!.room = { state: 'ready', roomId: '!decisions:test' }

    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}

      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}

      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'invalid' as const }
    }) }

    renderWorkspace({ bridge, onOpenChannel })
    await openCompany('Acme')
    fireEvent.click(await screen.findByRole('button', { name: 'Open # decisions' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeTruthy()
    expect(screen.getByText('Couldn’t open this channel. It may have changed; try again in a moment.')).toBeTruthy()
  })

  it('shows an unavailable directory as an error, never as an empty company list', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const }))
    }

    renderWorkspace({ bridge })
    expect(await screen.findByText(/Atum is unreachable/)).toBeTruthy()
    expect(screen.queryByText('You’re not in a company yet.')).toBeNull()
  })

  it('retries an uncertain invitation acceptance with the exact same request id', async () => {
    const invitation = { id: 'invite-1', companyId: 'company-1', displayName: 'Acme', role: 'member' as const }
    const requests: unknown[] = []
    let acceptAttempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') {
          return { ok: true as const, value: directory([], [invitation]) }
        }

        if (input.action === 'accept' && ++acceptAttempts === 1) {
          throw new Error('transport dropped')
        }

        return { ok: true as const, value: snapshot('company-1', 'Acme', 'member') }
      })
    }

    renderWorkspace({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }))
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('button', { name: 'Join' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(acceptAttempts).toBe(2))

    const accept = requests.filter(
      (value): value is { action: 'accept'; requestId: string } =>
        typeof value === 'object' && value !== null && (value as { action?: string }).action === 'accept'
    )

    expect(accept).toHaveLength(2)
    expect(accept[0]!.requestId).toBe(accept[1]!.requestId)
  })

  it('does not offer project creation to a member', async () => {
    const company = { id: 'company-1', displayName: 'Member company', role: 'member' as const, authorityGeneration: 1 }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input =>
        input.action === 'list'
          ? { ok: true as const, value: directory([company]) }
          : input.action === 'read'
            ? { ok: true as const, value: snapshot(company.id, company.displayName, 'member') }
            : { ok: false as const, error: 'denied' as const }
      )
    }

    renderWorkspace({ bridge })
    await openCompany('Member company')
    await screen.findByRole('heading', { name: 'Member company' })
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull()
  })

  it('never lets a late company read overwrite the currently selected company', async () => {
    const first = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()
    const companyA = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const companyB = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(input => {
        if (input.action === 'list') {
          return Promise.resolve({ ok: true as const, value: directory([companyA, companyB]) })
        }

        if (input.action === 'read' && input.companyId === companyA.id) {
          return first.promise
        }

        return Promise.resolve({ ok: true as const, value: snapshot(companyB.id, companyB.displayName) })
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Alpha' })
    await switchCompany('Beta')
    await screen.findByRole('heading', { name: 'Beta' })
    await act(async () => first.resolve({ ok: true, value: snapshot(companyA.id, companyA.displayName) }))
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy()
  })

  it('selects the active room company from its authority binding when several companies exist', async () => {
    const alpha = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const beta = { id: 'company-b', displayName: 'Beta', role: 'member' as const, authorityGeneration: 1 }
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([alpha, beta]) }}

      if (input.action === 'read') {
        return { ok: true as const, value: snapshot(input.companyId,
          input.companyId === beta.id ? beta.displayName : alpha.displayName,
          input.companyId === beta.id ? 'member' : 'admin') }
      }

      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(input.companyId) }}

      return { ok: false as const, error: 'missing' as const }
    }) }

    renderWorkspace({ bridge, preferredCompanyId: beta.id,
      channelContent: <div data-testid="bound-channel">Beta channel</div> })
    await screen.findByRole('heading', { name: 'Beta' })
    expect(screen.getByTestId('bound-channel')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull()
    await chooseFromCompanyMenu('Company overview')
    expect(screen.getByTestId('bound-channel')).toBeTruthy()
    expect(document.querySelector('[data-matrix-company-detail]')).toBeTruthy()
    await switchCompany('Alpha')
    await screen.findByRole('heading', { name: 'Alpha' })
    expect(screen.queryByTestId('bound-channel')).toBeNull()
  })

  it('follows a newly selected bound room into its company without overriding a manual company choice', async () => {
    const alpha = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const beta = { id: 'company-b', displayName: 'Beta', role: 'member' as const, authorityGeneration: 1 }
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([alpha, beta]) }}
      if (input.action === 'read') {return { ok: true as const, value: snapshot(input.companyId,
        input.companyId === alpha.id ? alpha.displayName : beta.displayName) }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(input.companyId) }}

      return { ok: false as const, error: 'missing' as const }
    }) }
    const onOpenChannel = vi.fn(async () => {})
    const content = <div data-testid="external-channel">Channel</div>
    const view = renderWorkspace({ activeRoomId: '!alpha:test', bridge, channelContent: content,
      onOpenChannel, preferredCompanyId: alpha.id })
    await screen.findByRole('heading', { name: 'Alpha' })
    expect(await screen.findByTestId('external-channel')).toBeTruthy()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace accountKey="account-a" activeRoomId="!beta:test" bridge={bridge}
          channelContent={content} onOpenChannel={onOpenChannel} preferredCompanyId={beta.id}
          projectsEnabled searchEnabled />
      </I18nProvider>
    )
    await screen.findByRole('heading', { name: 'Beta' })
    expect(screen.getByTestId('external-channel')).toBeTruthy()

    await switchCompany('Alpha')
    await screen.findByRole('heading', { name: 'Alpha' })
    expect(screen.queryByTestId('external-channel')).toBeNull()
  })

  it('follows a bound company that arrives in a later directory refresh', async () => {
    const alpha = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const beta = { id: 'company-b', displayName: 'Beta', role: 'member' as const, authorityGeneration: 1 }
    let betaVisible = false
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {
        return { ok: true as const, value: directory(betaVisible ? [alpha, beta] : [alpha]) }
      }

      if (input.action === 'read') {return { ok: true as const, value: snapshot(input.companyId, beta.displayName) }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(input.companyId) }}

      return { ok: false as const, error: 'missing' as const }
    }) }

    renderWorkspace({ activeRoomId: '!beta:test', bridge, channelContent: <div>Beta channel</div>,
      preferredCompanyId: beta.id })
    await screen.findByRole('heading', { name: 'Alpha' })
    betaVisible = true
    // The refresh-on-focus listener is only attached once the pending/mutation loads settle, which can
    // land after the Alpha heading, so keep focusing until the refresh is actually listening.
    await waitFor(() => {
      fireEvent(window, new Event('focus'))
      expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy()
    })
    expect(screen.getByText('Beta channel')).toBeTruthy()
  })

  it('uses a compact channel drawer instead of squeezing the transcript at the minimum window width', async () => {
    const previous = window.matchMedia
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) })
    const company = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const channels = channelDirectory(company.id, ['decisions'])
    channels.channels[0] = {
      ...channels.channels[0]!,
      channel: { ...channels.channels[0]!.channel, state: 'active' },
      room: { state: 'ready', roomId: '!decisions:test' }
    }
    const onOpenChannel = vi.fn(async () => {})
    const onChannelVisibilityChange = vi.fn()
    const bridge: MatrixCompanyBridge = { pending: noPending, request: vi.fn(async input => {
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channels }}

      return { ok: false as const, error: 'missing' as const }
    }) }

    try {
      renderWorkspace({ activeRoomId: '!decisions:test', bridge,
        channelContent: <div data-testid="compact-transcript">Transcript</div>, onOpenChannel,
        onChannelVisibilityChange,
        preferredCompanyId: company.id })
      await screen.findByRole('button', { name: 'Back to channels' })
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to channels' })))
      expect(onChannelVisibilityChange).toHaveBeenLastCalledWith(true)
      expect(screen.queryByRole('complementary', { name: 'Channels' })).toBeNull()
      expect(screen.getByTestId('compact-transcript').closest('[hidden]')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Back to channels' }))
      expect(await screen.findByRole('complementary', { name: 'Channels' })).toBeTruthy()
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open # decisions' })))
      expect(document.querySelector('[data-matrix-company-content]')?.hasAttribute('hidden')).toBe(true)
      expect(onChannelVisibilityChange).toHaveBeenLastCalledWith(false)

      await chooseFromCompanyMenu('Company overview')
      await screen.findByRole('button', { name: 'Back to channels' })
      expect(document.querySelector('[data-matrix-company-content]')?.hasAttribute('hidden')).toBe(false)
      expect(document.querySelector('[data-matrix-company-detail]')).toBeTruthy()
      expect(document.querySelector('[aria-label="Open # decisions"]')?.getAttribute('aria-current')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Back to channels' }))
      await screen.findByRole('complementary', { name: 'Channels' })

      fireEvent.click(screen.getByRole('button', { name: 'Open # decisions' }))
      await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!decisions:test', expect.any(Function)))
      await screen.findByRole('button', { name: 'Back to channels' })
      expect(onChannelVisibilityChange).toHaveBeenLastCalledWith(true)
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: previous })
    }
  })

  it('hides the previous account directory before its late request returns', async () => {
    const oldDirectory = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()
    const newCompany = { id: 'company-new', displayName: 'New account', role: 'admin' as const, authorityGeneration: 1 }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(input => {
        if (input.action !== 'list') {
          return Promise.resolve({ ok: false as const, error: 'missing' as const })
        }

        return oldDirectory.promise
      })
    }

    const { rerender } = renderWorkspace({ bridge })
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace
          accountKey="account-b"
          bridge={{ pending: vi.fn(async () => ({ ok: true as const, request: null })), request: vi.fn(async () => ({ ok: true as const, value: directory([newCompany]) })) }}
          onOpenChannel={vi.fn(async () => {})}
        />
      </I18nProvider>
    )
    await screen.findByRole('heading', { name: 'New account' })
    await act(async () =>
      oldDirectory.resolve({
        ok: true,
        value: directory([{ id: 'company-old', displayName: 'Old account', role: 'admin', authorityGeneration: 1 }])
      })
    )
    expect(screen.queryByRole('heading', { name: 'Old account' })).toBeNull()
    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    expect(screen.queryByRole('menuitemradio', { name: /^Old account/ })).toBeNull()
  })
})

describe('private Chief of Staff locale retry', () => {
  const company = {
    id: '00000000-0000-4000-8000-24ec437dbdf3',
    displayName: 'Acme',
    role: 'admin' as const,
    authorityGeneration: 1
  }
  const pair = {
    companyPrincipal: company.id,
    memberPrincipal: '00000000-0000-4000-8000-7acf30c68b5e',
    membershipIncarnation: '00000000-0000-4000-8000-2003d0eebf32'
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
    roomType: 'io.atum.assistant',
    roomName: 'Chief of Staff',
    roomEncrypted: false,
    greetingVersion: 2,
    ensureLocale: true
  }
  const preparing: MatrixCompanyPrivateCosView = {
    schemaVersion: 2,
    profile: 'atum.company-private-cos/1.1',
    state: 'preparing',
    pair,
    greetingState: 'pending',
    operationId: '00000000-0000-4000-8000-8d9d536cf024'
  }

  it('sends the current UI locale when dm_open retries a negotiated 1.3 pair', async () => {
    const base = playgroundCompanyDesktopAdapter()
    const ensurePrivateCos = vi.fn(async () => preparing)
    const companyDesktop = {
      ...base,
      readPrivateCosCapability: vi.fn(async () => capability),
      readPrivateCos: vi.fn(async () => preparing),
      ensurePrivateCos,
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop }
    onTestFinished(() => {
      Reflect.deleteProperty(window, 'atumMatrix')
    })

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
        if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}

        return { ok: false as const, error: 'missing' as const }
      })
    }

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixCompanyWorkspace
          accountKey="account-a"
          bridge={bridge}
          onOpenChannel={vi.fn(async () => {})}
        />
      </I18nProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Chief of Staff' }))
    await waitFor(() => expect(ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(company.id, {
      schemaVersion: 1,
      requestId: expect.any(String),
      action: 'ensure',
      trigger: 'dm_open',
      locale: 'vi'
    }))
  })

  it('ensures the private Chief of Staff when its capability switches on under a running window', async () => {
    let on = false
    let ensured = false
    const uncreated: MatrixCompanyPrivateCosView = { schemaVersion: 1, state: 'uncreated', pair, greetingState: 'pending' }
    const base = playgroundCompanyDesktopAdapter()
    const ensurePrivateCos = vi.fn(async () => {
      ensured = true

      return preparing
    })
    const companyDesktop = {
      ...base,
      // Off is a 404 on the capability route, which the bridge reports as missing.
      readPrivateCosCapability: vi.fn(async () => {
        if (!on) {throw new Error('missing')}

        return capability
      }),
      readPrivateCos: vi.fn(async () => (ensured ? preparing : uncreated)),
      ensurePrivateCos,
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop }
    onTestFinished(() => {
      Reflect.deleteProperty(window, 'atumMatrix')
    })

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
        if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}

        return { ok: false as const, error: 'missing' as const }
      })
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace accountKey="account-a" bridge={bridge} onOpenChannel={vi.fn(async () => {})} />
      </I18nProvider>
    )

    await waitFor(() => expect(companyDesktop.readPrivateCosCapability).toHaveBeenCalled())
    await waitFor(() => expect($companyPrivateCosDiscovery.get()[teamSpaceKey('account-a', company.id)])
      .toBe('not_available'))
    expect(ensurePrivateCos).not.toHaveBeenCalled()

    on = true
    fireEvent.focus(window)

    await waitFor(() => expect(ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(company.id, expect.objectContaining({
      action: 'ensure', trigger: 'first_company_visit'
    })))
    await waitFor(() => expect($companyPrivateCos.get()[teamSpaceKey('account-a', company.id)]?.view).toEqual(preparing))

    fireEvent.focus(window)
    await waitFor(() => expect(companyDesktop.readPrivateCos).toHaveBeenCalledTimes(2))
    expect(ensurePrivateCos).toHaveBeenCalledOnce()
  })

  it('does not let a rejected first-visit ensure clear a newer incarnation', async () => {
    let rejectEnsure!: (error: Error) => void
    const uncreated: MatrixCompanyPrivateCosView = {
      schemaVersion: 1,
      state: 'uncreated',
      pair,
      greetingState: 'pending'
    }
    const base = playgroundCompanyDesktopAdapter()
    const ensurePrivateCos = vi.fn(() => new Promise<MatrixCompanyPrivateCosView>((_resolve, reject) => {
      rejectEnsure = reject
    }))
    const companyDesktop = {
      ...base,
      readPrivateCosCapability: vi.fn(async () => capability),
      readPrivateCos: vi.fn(async () => uncreated),
      ensurePrivateCos,
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop }
    onTestFinished(() => {
      Reflect.deleteProperty(window, 'atumMatrix')
    })

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName) }}
        if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}

        return { ok: false as const, error: 'missing' as const }
      })
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace accountKey="account-a" bridge={bridge} onOpenChannel={vi.fn(async () => {})} />
      </I18nProvider>
    )
    await waitFor(() => expect(ensurePrivateCos).toHaveBeenCalledExactlyOnceWith(company.id, expect.objectContaining({
      action: 'ensure', trigger: 'first_company_visit'
    })))

    clearCompanyPrivateCos('account-a', company.id)
    const nextPair = { ...pair, membershipIncarnation: '00000000-0000-4000-8000-574a85d37f85' }
    const nextReady: MatrixCompanyPrivateCosView = {
      schemaVersion: 1,
      state: 'ready',
      pair: nextPair,
      greetingState: 'published',
      binding: {
        scope: { pair: nextPair, authorityEpoch: 2, contextEpoch: 2, homeGeneration: 2 },
        agentPrincipal: '00000000-0000-4000-8000-eb8abd3c16e2',
        agentUserId: '@private-cos:atum.example',
        executorId: '00000000-0000-4000-8000-c43aa9490abe',
        homeId: '00000000-0000-4000-8000-8a1bed04e212',
        roomId: '!new-private-cos:atum.example',
        storeGeneration: 2,
        profileDigest: 'b'.repeat(64)
      }
    }
    await loadCompanyPrivateCos({ ...companyDesktop, readPrivateCos: vi.fn(async () => nextReady) },
      'account-a', company.id, capability)
    rejectEnsure(new Error('unavailable'))

    await waitFor(() => expect($companyPrivateCos.get()[teamSpaceKey('account-a', company.id)]?.view)
      .toEqual(nextReady))
  })
})

describe('company menu wallet', () => {
  function installCompanyDesktop(member = false) {
    ;(window as unknown as { atumMatrix: unknown }).atumMatrix = { companyDesktop: playgroundCompanyDesktopAdapter(member) }
  }

  function walletBridge(role: 'admin' | 'member'): MatrixCompanyBridge {
    const company = { id: TEAM_COMPANY_ID, displayName: 'Acme', role, authorityGeneration: 1 }

    return {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
        if (input.action === 'read') {return { ok: true as const, value: snapshot(TEAM_COMPANY_ID, 'Acme', role) }}
        if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(TEAM_COMPANY_ID) }}

        return { ok: false as const, error: 'missing' as const }
      })
    }
  }

  it('opens the company wallet from the company menu for an admin', async () => {
    installCompanyDesktop()
    renderWorkspace({ bridge: walletBridge('admin') })
    await screen.findByRole('heading', { name: 'Acme' })

    await chooseFromCompanyMenu('Company wallet')
    expect(await screen.findByText('Available')).toBeTruthy()
    expect(document.querySelector('[data-company-wallet]')).toBeTruthy()
    expect((await screen.findAllByRole('button', { name: 'Top up' })).length).toBeGreaterThan(0)
  })

  it('never draws the wallet entry for a member', async () => {
    installCompanyDesktop(true)
    renderWorkspace({ bridge: walletBridge('member') })
    await screen.findByRole('heading', { name: 'Acme' })

    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Company overview' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Company wallet' })).toBeNull()
  })
})

describe('company workspace revalidation', () => {
  it('disables company selection while a mutation is pending', async () => {
    const companyA = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const companyB = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }
    const create = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(input => {
        if (input.action === 'list') {
          return Promise.resolve({ ok: true as const, value: directory([companyA, companyB]) })
        }

        if (input.action === 'read') {
          return Promise.resolve({ ok: true as const, value: snapshot(input.companyId,
            input.companyId === companyA.id ? 'Alpha' : 'Beta') })
        }

        if (input.action === 'list-channels') {
          return Promise.resolve({ ok: true as const, value: channelDirectory(input.companyId) })
        }

        return input.action === 'create-channel' ? create.promise
          : Promise.resolve({ ok: false as const, error: 'missing' as const })
      })
    }

    renderWorkspace({ bridge })
    await openCompany('Alpha')
    fireEvent.click(await screen.findByRole('button', { name: 'Create channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'launch' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Create channel' }).at(-1)!)

    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: /^Alpha · / }).getAttribute('aria-disabled')).toBe('true')
    )
    expect(screen.getByRole('menuitemradio', { name: /^Beta · / }).getAttribute('aria-disabled')).toBe('true')

    await act(async () => create.resolve({ ok: false, error: 'unavailable' }))
  })

  it('retries an uncertain company creation exactly from the empty state', async () => {
    const newCompany = { id: 'company-new', displayName: 'New company', role: 'admin' as const, authorityGeneration: 1 }
    const requests: MatrixCompanyRequest[] = []
    let createAttempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') {
          return { ok: true as const, value: directory(createAttempts > 0 ? [newCompany] : []) }
        }

        if (input.action === 'read') {
          return { ok: true as const, value: snapshot(newCompany.id, newCompany.displayName) }
        }

        if (input.action === 'list-channels') {
          return { ok: true as const, value: channelDirectory(newCompany.id) }
        }

        if (input.action === 'create' && ++createAttempts === 1) {
          return { ok: false as const, error: 'unavailable' as const }
        }

        return { ok: true as const, value: snapshot(newCompany.id, newCompany.displayName) }
      })
    }

    renderWorkspace({ bridge })
    await submitEmptyCompany('New company')
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(createAttempts).toBe(2))

    const creates = requests.filter(
      (request): request is Extract<MatrixCompanyRequest, { action: 'create' }> => request.action === 'create'
    )

    expect(creates).toHaveLength(2)
    expect(creates[1]).toBe(creates[0])
    expect(creates[1]?.requestId).toBe(creates[0]?.requestId)
    expect(await screen.findByRole('heading', { name: 'New company' })).toBeTruthy()
    expect(screen.queryByLabelText('Company name')).toBeNull()
  })

  it('retries an uncertain invitation acceptance exactly without replacing a later company selection', async () => {
    const companyA = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const companyB = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }
    const invitation = { id: 'invite-1', companyId: 'company-invited', displayName: 'Invited', role: 'member' as const }
    const requests: MatrixCompanyRequest[] = []
    let acceptAttempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') {
          return { ok: true as const, value: directory([companyA, companyB], [invitation]) }
        }

        if (input.action === 'read') {
          return {
            ok: true as const,
            value: snapshot(input.companyId, input.companyId === companyA.id ? 'Alpha' : 'Beta')
          }
        }

        if (input.action === 'accept' && ++acceptAttempts === 1) {
          return { ok: false as const, error: 'unavailable' as const }
        }

        return { ok: true as const, value: snapshot(invitation.companyId, invitation.displayName, 'member') }
      })
    }

    renderWorkspace({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }))
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: /^Beta · / }).getAttribute('aria-disabled')).not.toBe('true')
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Beta · / }))
    await screen.findByRole('heading', { name: 'Beta' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(acceptAttempts).toBe(2))

    const accepts = requests.filter(
      (request): request is Extract<MatrixCompanyRequest, { action: 'accept' }> => request.action === 'accept'
    )

    expect(accepts).toHaveLength(2)
    expect(accepts[1]).toBe(accepts[0])
    expect(accepts[1]?.requestId).toBe(accepts[0]?.requestId)
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Invited' })).toBeNull()
  })

  it('retries an uncertain project creation exactly without replacing a later company selection', async () => {
    const companyA = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const companyB = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }
    const requests: MatrixCompanyRequest[] = []
    let projectAttempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') {
          return { ok: true as const, value: directory([companyA, companyB]) }
        }

        if (input.action === 'read') {
          return {
            ok: true as const,
            value: snapshot(input.companyId, input.companyId === companyA.id ? 'Alpha' : 'Beta')
          }
        }

        if (input.action === 'create-project' && ++projectAttempts === 1) {
          return { ok: false as const, error: 'unavailable' as const }
        }

        return {
          ok: true as const,
          value: {
            ...snapshot(companyA.id, companyA.displayName),
            projects: [
              {
                id: 'project-new',
                displayName: 'New project',
                memberPrincipals: [],
                collaboration: 'not_provisioned' as const
              }
            ]
          }
        }
      })
    }

    renderWorkspace({ bridge })
    await openCompany('Alpha')
    await screen.findByRole('heading', { name: 'Alpha' })
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: /^Beta · / }).getAttribute('aria-disabled')).not.toBe('true')
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Beta · / }))
    await screen.findByRole('heading', { name: 'Beta' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(projectAttempts).toBe(2))

    const projects = requests.filter(
      (request): request is Extract<MatrixCompanyRequest, { action: 'create-project' }> =>
        request.action === 'create-project'
    )

    expect(projects).toHaveLength(2)
    expect(projects[1]).toBe(projects[0])
    expect(projects[1]?.requestId).toBe(projects[0]?.requestId)
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy()
    expect(screen.queryByText('New project')).toBeNull()
  })

  it('clears project details when a quiet refresh is denied', async () => {
    const company = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    let reads = 0
    const denied = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()
    const project = {
      id: 'project-a',
      displayName: 'Restricted project',
      memberPrincipals: [],
      collaboration: 'not_provisioned' as const
    }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(input => {
        if (input.action === 'list') {
          return Promise.resolve({ ok: true as const, value: directory([company]) })
        }

        if (input.action === 'list-channels') {
          return Promise.resolve({ ok: true as const, value: channelDirectory(company.id) })
        }

        if (input.action === 'read' && ++reads !== 2) {
          return Promise.resolve({
            ok: true as const,
            value: { ...snapshot(company.id, company.displayName), projects: [project] }
          })
        }

        return denied.promise
      })
    }

    renderWorkspace({ bridge })
    await openCompany('Alpha')
    fireEvent.click(await screen.findByRole('button', { name: 'Restricted project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Channel name · Restricted project' }), {
      target: { value: 'private-draft' }
    })
    window.dispatchEvent(new Event('focus'))
    await act(async () => denied.resolve({ ok: false, error: 'denied' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Restricted project' })).toBeNull())
    expect(screen.getByText(/You no longer have access/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Channel name · Restricted project' })).toBeNull()
  })

  it('does not let an old account mutation hold the next account controls or publish there', async () => {
    const mutation = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(input =>
        input.action === 'list' ? Promise.resolve({ ok: true as const, value: directory([]) }) : mutation.promise
      )
    }

    const { rerender } = renderWorkspace({ bridge })
    await submitEmptyCompany('Old account company')

    const next: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async () => ({ ok: true as const, value: directory([]) }))
    }

    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace accountKey="account-b" bridge={next} ensureDefaultChannels={false}
          onOpenChannel={vi.fn(async () => {})} overviewFallback />
      </I18nProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Create company' }))
    const nextDialog = await screen.findByRole('dialog', { name: 'New company' })
    fireEvent.change(within(nextDialog).getByLabelText('Company name'), { target: { value: 'New account company' } })
    expect(within(nextDialog).getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false)
    await act(async () => mutation.resolve({ ok: true, value: snapshot('company-old', 'Old account company') }))
    expect(screen.queryByRole('heading', { name: 'Old account company' })).toBeNull()
  })
})

describe('company workspace durable recovery', () => {
  it('recovers the exact pending request after remount without replacing a later company selection', async () => {
    const companyA = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
    const companyB = { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }

    const mutation = {
      action: 'create' as const,
      requestId: '00000000-0000-4000-8000-b4b6412c243e',
      displayName: 'Recovered company'
    }

    const pending = vi.fn(async () => ({ ok: true as const, request: mutation }))

    const request = vi.fn(async (input: MatrixCompanyRequest) => {
      if (input.action === 'list') {
        return { ok: true as const, value: directory([companyA, companyB]) }
      }

      if (input.action === 'read') {
        return {
          ok: true as const,
          value: snapshot(input.companyId, input.companyId === companyB.id ? 'Beta' : 'Alpha')
        }
      }

      return { ok: true as const, value: snapshot('company-new', 'Recovered company') }
    })

    const bridge: MatrixCompanyBridge = { pending, request }
    const first = renderWorkspace({ bridge })

    await screen.findByRole('button', { name: 'Retry' })
    first.unmount()
    renderWorkspace({ bridge })

    await screen.findByRole('button', { name: 'Retry' })
    await switchCompany('Beta')
    await screen.findByRole('heading', { name: 'Beta' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(request.mock.calls.filter(([input]) => input === mutation)).toHaveLength(1))

    expect(pending).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.find(([input]) => input === mutation)?.[0]).toBe(mutation)
    expect(screen.getByRole('heading', { name: 'Beta' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Recovered company' })).toBeNull()
  })

  it.each([
    { error: 'limit' as const, retryAfterSeconds: 30, label: '429 limit' },
    { error: 'authentication' as const, label: 'authentication' }
  ])('keeps a recovered pending request exact after $label', async ({ error, retryAfterSeconds }) => {
    const mutation = {
      action: 'create' as const,
      requestId: '00000000-0000-4000-8000-15dc18308a11',
      displayName: 'Retry company'
    }

    let attempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: mutation })),
      request: vi.fn(async input => {
        if (input.action === 'list') {
          return { ok: true as const, value: directory([]) }
        }

        attempts += 1

        return attempts === 1
          ? { ok: false as const, error, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }
          : { ok: true as const, value: snapshot('company-new', 'Retry company') }
      })
    }

    renderWorkspace({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(attempts).toBe(2))

    const retries = vi
      .mocked(bridge.request)
      .mock.calls.map(([input]) => input)
      .filter(input => input.action === 'create')

    expect(retries).toHaveLength(2)
    expect(retries[0]).toBe(mutation)
    expect(retries[1]).toBe(mutation)
  })

  it('blocks new writes until pending recovery succeeds and retries that recovery on refresh', async () => {
    let pendingAttempts = 0

    const bridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => {
        pendingAttempts += 1

        return pendingAttempts === 1
          ? { ok: false as const, error: 'unavailable' as const }
          : { ok: true as const, request: null }
      }),
      request: vi.fn(async input =>
        input.action === 'list'
          ? { ok: true as const, value: directory([]) }
          : { ok: true as const, value: snapshot('company-new', 'Recovered company') }
      )
    }

    renderWorkspace({ bridge })
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Create company' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(pendingAttempts).toBe(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create company' }).hasAttribute('disabled')).toBe(false)
    )

    await submitEmptyCompany('Recovered company')
    await waitFor(() =>
      expect(vi.mocked(bridge.request).mock.calls.some(([input]) => input.action === 'create')).toBe(true)
    )
  })
})


it('keeps cached companies during a transport failure and recovers on online without a manual reload', async () => {
  const company = { id: 'resilience-company', displayName: 'Resilience', role: 'member' as const, authorityGeneration: 1 }
  let offline = false
  const bridge: MatrixCompanyBridge = {
    pending: noPending,
    request: vi.fn(async input => {
      if (offline) {return { ok: false as const, error: 'unavailable' as const }}
      if (input.action === 'list') {return { ok: true as const, value: directory([company]) }}
      if (input.action === 'read') {return { ok: true as const, value: snapshot(company.id, company.displayName, 'member') }}
      if (input.action === 'list-channels') {return { ok: true as const, value: channelDirectory(company.id) }}
      return { ok: false as const, error: 'missing' as const }
    })
  }
  renderWorkspace({ bridge })
  await openCompany('Resilience')
  offline = true
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(document.querySelector('[data-matrix-company-directory-refreshing]')).toBeTruthy())
  expect(screen.getByRole('heading', { name: 'Resilience' })).toBeTruthy()
  offline = false
  act(() => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(screen.queryByText('Atum is unreachable. Try again shortly.')).toBeNull())
  expect(screen.getByRole('heading', { name: 'Resilience' })).toBeTruthy()
})


it('paints durable companies immediately while a cold-start live directory is pending', async () => {
  companyDirectoryCache.set('account-a', directory([{ id: 'cold', displayName: 'Cold start company', role: 'member', authorityGeneration: 1 }]))
  $companyDirectories.set({})

  const source: MatrixCompanyBridge = {
    pending: noPending,
    request: vi.fn(() => new Promise<Awaited<ReturnType<MatrixCompanyBridge['request']>>>(() => {}))
  }

  renderWorkspace({ bridge: source })
  expect(screen.getByText('Cold start company')).toBeTruthy()
  expect(document.querySelector('[data-matrix-company-directory-refreshing]')).toBeTruthy()
  expect(screen.queryByText('Atum is unreachable. Try again shortly.')).toBeNull()
})
