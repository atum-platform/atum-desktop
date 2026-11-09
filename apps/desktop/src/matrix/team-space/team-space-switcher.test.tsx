import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { companySpacePreferences, companySpaceScope, patchCompanySpacePreferences } from '../company-space-store'

import { writeLastChannelId } from './company-switcher'
import { requestTeamSpaceIntent } from './intents'
import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  OTHER_COMPANY_ID,
  platform,
  type Platform,
  renderTeamSpace,
  resetTeamSpace,
  type Script,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const THIRD_COMPANY_ID = '00000000-0000-4000-8000-3570bef6c8ca'
const ATUM = { id: COMPANY_ID, displayName: 'Atum Studio' }
const BETA = { id: OTHER_COMPANY_ID, displayName: 'Beta Works' }
const GAMMA = { id: THIRD_COMPANY_ID, displayName: 'Gamma Labs' }
const lastCompanyKey = 'atum.team-space.last-company:account-a'

const trigger = () => document.querySelector('[data-matrix-company-menu-trigger]') as HTMLElement
const companyHeading = () => document.querySelector('[data-matrix-company-title] h1') as HTMLElement | null

function openMenu() {
  fireEvent.keyDown(trigger(), { key: 'Enter' })
}

const menuItems = () => screen.queryAllByRole('menuitem').map(item => item.textContent)
const menuCompanies = () => screen.queryAllByRole('menuitemradio')

const menuCompanyNames = () =>
  menuCompanies().map(item => item.querySelector('[data-company-initials]')?.nextElementSibling?.textContent)

async function ready(source: Platform, props: Parameters<typeof renderTeamSpace>[1] = {}) {
  const view = renderTeamSpace(source, props)
  await screen.findByRole('button', { name: 'Open # general' })

  return view
}

async function finishCompanyDialog(dialog: HTMLElement, name: string) {
  fireEvent.change(within(dialog).getByLabelText('Company name'), { target: { value: name } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
}

function stubLogoPreparation() {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:company-logo') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 800, close() {} })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
    const blob = new Blob([webp], { type })
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => webp.slice().buffer })
    done(blob)
  })

  return webp
}

const withCompanies = (over: Partial<Script> = {}) => ({ companies: [ATUM], ...over })

describe('the company menu', () => {
  it('is a menu even with one company, and holds only what this person may do: no switch to make, and no rail', async () => {
    await ready(platform(withCompanies()))

    expect(document.querySelector('[data-matrix-company-rail]')).toBeNull()
    openMenu()
    expect(menuCompanyNames()).toEqual(['Atum Studio'])
    expect(menuCompanies()[0]!.getAttribute('aria-checked')).toBe('true')
    // The owner has company, so there is no Leave to offer; creating is not on offer to this person.
    expect(menuItems()).toEqual(['Company overview', 'Invite teammates', 'Company settings'])
  })

  it('gives a member the way to the roster and the way out, and nothing to administer', async () => {
    await ready(platform(withCompanies({ viewer: 'member' })))

    openMenu()
    expect(menuItems()).toEqual(['Company overview', 'Leave company'])
  })

  it('offers Create company only when the directory says this person may, and nothing else', async () => {
    const source = platform({ companies: [ATUM, BETA], canCreate: true })
    await ready(source)

    openMenu()
    expect(menuItems()).toContain('Add company')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Create company' })).toBeNull()
    cleanup()
    resetTeamSpace()

    await ready(platform({ companies: [ATUM, BETA], canCreate: false }))
    openMenu()
    expect(menuItems()).not.toContain('Add company')
  })

  it('creates a company from the menu after the four-step dialog and opens it', async () => {
    const NEW_ID = '00000000-0000-4000-8000-ead8b47493fd'

    const source: Platform = platform({
      companies: [ATUM],
      canCreate: true,
      mutations: {
        create: input => {
          const { displayName } = input as { displayName: string }
          source.state.companies.push({ id: NEW_ID, displayName })

          return { ok: true, value: { schemaVersion: 2, defaultChannelId: CHANNEL_IDS.general, projects: [], members: [],
            company: { id: NEW_ID, displayName, role: 'admin', authorityGeneration: 1 } } }
        }
      }
    })

    const onOpenChannel = vi.fn(async () => {})
    await ready(source, { convergenceDelayMs: 5, onOpenChannel })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))

    const dialog = await screen.findByRole('dialog', { name: 'New company' })
    expect(within(dialog).getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    await finishCompanyDialog(dialog, ' Delta Works ')

    await waitFor(() => expect(source.calls('create')).toHaveLength(1))
    expect(source.calls('create')[0]).toMatchObject({ displayName: 'Delta Works' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New company' })).toBeNull())
    expect(await screen.findByRole('heading', { name: 'Delta Works' })).toBeTruthy()
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: /^Delta Works · / }).getAttribute('aria-checked')).toBe('true')
  })

  it('says why a company could not be made, in its dialog', async () => {
    const source = platform({ companies: [ATUM], canCreate: true, mutations: {
      create: () => ({ ok: false, error: 'denied', reason: 'company_creation_closed' })
    } })

    await ready(source)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))
    const dialog = await screen.findByRole('dialog', { name: 'New company' })
    await finishCompanyDialog(dialog, 'Delta')

    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Invite members' })).toBeTruthy()
  })

  it('finishes optional description and invitations through the existing channel and invite paths', async () => {
    const newId = COMPANY_ID
    const source: Platform = platform({ companies: [ATUM], canCreate: true, mutations: {
      create: input => {
        const { displayName } = input as { displayName: string }
        return { ok: true, value: { schemaVersion: 2, defaultChannelId: CHANNEL_IDS.general, projects: [],
          members: [], company: { id: newId, displayName, role: 'admin', authorityGeneration: 1 } } }
      },
      'invitation-create': () => ({ ok: true, value: { schemaVersion: 4, replayed: false, authorityGeneration: 1,
        invitation: { id: '00000000-0000-4000-8000-5683b005addd', companyId: newId, targetHandle: 'lan',
          role: 'member', state: 'pending', createdAt: 1_800_000_000, expiresAt: 1_800_604_800,
          inviter: { handle: 'minh', displayName: 'Minh' } } } })
    } })

    await ready(source)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))
    const dialog = await screen.findByRole('dialog', { name: 'New company' })
    fireEvent.change(within(dialog).getByLabelText('Company name'), { target: { value: 'Delta Works' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
    fireEvent.change(within(dialog).getByPlaceholderText('What does this company do?'), {
      target: { value: 'Makes teamwork calmer.' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.change(within(dialog).getByPlaceholderText('@lan, @minh'), { target: { value: '@lan' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create company' }))

    await waitFor(() => expect(source.calls('invitation-create')).toHaveLength(1))
    expect(source.calls('invitation-create')[0]).toMatchObject({ companyId: newId, memberHandle: '@lan', role: 'member' })
    await waitFor(() => expect(source.calls('channel-command').some(call => call.action === 'channel-command' &&
      call.command.operation === 'update_metadata' && call.command.topic === 'Makes teamwork calmer.')).toBe(true))
  })

  it('uploads the prepared logo after invitations and description, then retries the exact uncertain avatar mutation', async () => {
    const webp = stubLogoPreparation()
    let avatarAttempts = 0
    const uploadAvatar = vi.fn<NonNullable<MatrixCompanyBridge['uploadAvatar']>>(async photo => {
      expect(photo).toEqual({ type: 'image/webp', bytes: webp })

      return 'mxc://matrix.atum.app/company-logo'
    })
    const source = platform({ companies: [ATUM], canCreate: true, mutations: {
      create: input => {
        const { displayName } = input as { displayName: string }

        return { ok: true, value: { schemaVersion: 2, defaultChannelId: CHANNEL_IDS.general, projects: [], members: [],
          company: { id: COMPANY_ID, displayName, role: 'admin', authorityGeneration: 1 } } }
      },
      'invitation-create': () => ({ ok: true, value: { schemaVersion: 4, replayed: false, authorityGeneration: 1,
        invitation: { id: '00000000-0000-4000-8000-24ec437dbdf3', companyId: COMPANY_ID, targetHandle: 'lan',
          role: 'member', state: 'pending', createdAt: 1_800_000_000, expiresAt: 1_800_604_800,
          inviter: { handle: 'minh', displayName: 'Minh' } } } }),
      'set-avatar': input => {
        avatarAttempts += 1

        return avatarAttempts === 1
          ? { ok: false, error: 'unavailable' }
          : { ok: true, value: { schemaVersion: 8, operation: 'set_avatar', companyId: COMPANY_ID,
              avatarUri: (input as { avatarUri: string }).avatarUri, avatarRevision: 1, replayed: true } }
      }
    } }, { uploadAvatar })

    await ready(source)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))
    const dialog = await screen.findByRole('dialog', { name: 'New company' })
    fireEvent.change(within(dialog).getByLabelText('Company name'), { target: { value: 'Delta Works' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.change(dialog.querySelector('input[type="file"]')!, {
      target: { files: [new File([webp], 'logo.webp', { type: 'image/webp' })] }
    })
    await within(dialog).findByText('Choose another')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.change(within(dialog).getByPlaceholderText('What does this company do?'), {
      target: { value: 'Makes teamwork calmer.' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.change(within(dialog).getByPlaceholderText('@lan, @minh'), { target: { value: '@lan' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create company' }))

    await waitFor(() => expect(source.calls('set-avatar')).toHaveLength(1))
    expect(source.mutations().map(mutation => mutation.action)).toEqual([
      'create', 'invitation-create', 'channel-command', 'set-avatar'
    ])
    const first = source.calls('set-avatar')[0] as { requestId: string; avatarUri: string }
    expect(first.avatarUri).toBe('mxc://matrix.atum.app/company-logo')
    expect(uploadAvatar).toHaveBeenCalledTimes(1)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(source.calls('set-avatar')).toHaveLength(2))
    expect(source.calls('set-avatar')[1]).toMatchObject(first)
    expect(uploadAvatar).toHaveBeenCalledTimes(1)
  })

  it.each(['owner', 'admin'] as const)('lets a company %s change the logo from Company settings', async viewer => {
    const webp = stubLogoPreparation()
    const uploadAvatar = vi.fn<NonNullable<MatrixCompanyBridge['uploadAvatar']>>(async () =>
      'mxc://matrix.atum.app/settings-logo')
    const source = platform(withCompanies({ viewer }), { uploadAvatar })

    await ready(source)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Company settings' }))
    const settings = await screen.findByText('Company logo')
    const section = settings.closest('[data-matrix-company-avatar-settings]') as HTMLElement
    fireEvent.change(section.querySelector('input[type="file"]')!, {
      target: { files: [new File([webp], 'settings.webp', { type: 'image/webp' })] }
    })
    fireEvent.click(await within(section).findByRole('button', { name: 'Save logo' }))

    await waitFor(() => expect(source.calls('set-avatar')).toHaveLength(1))
    expect(source.calls('set-avatar')[0]).toMatchObject({
      companyId: COMPANY_ID, avatarUri: 'mxc://matrix.atum.app/settings-logo'
    })
    expect(uploadAvatar).toHaveBeenCalledTimes(1)
  })

  it('shows the authenticated company avatar in the company header and sidebar menu', async () => {
    const avatarMxc = 'mxc://matrix.atum.app/company-logo'
    const avatarUrl = 'data:image/png;base64,iVBORw0KGgo='
    const room = channelRoom(CHANNEL_IDS.general, 'general', { roomAvatarMxc: avatarMxc })
    const source = platform(withCompanies(), {
      avatar: vi.fn(async roomId => ({ roomId, avatarMxc, avatarUrl }))
    })

    await ready(source, { rooms: [room] })
    await waitFor(() => expect(trigger().querySelector('img')?.getAttribute('src')).toBe(avatarUrl))
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: /^Atum Studio · / }).querySelector('img')?.getAttribute('src'))
      .toBe(avatarUrl)
    expect(document.querySelector('[data-matrix-company-bot-row]')).toBeNull()
  })

  it('asks before leaving, names the company and says an invitation is needed to come back, then leaves', async () => {
    const source = platform({ ...withCompanies({ viewer: 'member' }), mutations: {
      leave: () => ({ ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, state: 'removed', retired: false, authorityGeneration: 9 } })
    } })

    await ready(source)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave company' }))

    const dialog = await screen.findByRole('dialog', { name: 'Leave Atum Studio?' })
    expect(dialog.textContent).toContain('Leave now; returning needs a new invitation.')
    expect(source.calls('leave')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(source.calls('leave')).toHaveLength(0)

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave company' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave Atum Studio?' })).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(source.calls('leave')).toHaveLength(1))
    expect(source.calls('leave')[0]).toMatchObject({ companyId: COMPANY_ID })
  })

  it('opens the roster, the settings and the invitation from beside an open channel, not only from the overview page', async () => {
    const scrolled: HTMLElement[] = []
    const previous = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) { scrolled.push(this) }
    })

    try {
      const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }
      const source = platform({ ...withCompanies(), channels: [general] })

      renderTeamSpace(source, {
        rooms: [channelRoom(general.id, 'general')],
        activeRoomId: '!general:atum.example',
        preferredCompanyId: COMPANY_ID,
        channelContent: <div data-testid="open-channel">A channel is open</div>
      })

      await screen.findByTestId('open-channel')
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Invite teammates' }))
      expect(await screen.findByRole('dialog', { name: /^Add people to / })).toBeTruthy()
      // The channel is still the page: only the dialog came up.
      expect(screen.getByTestId('open-channel')).toBeTruthy()
      fireEvent.click(within(screen.getByRole('dialog', { name: /^Add people to / })).getAllByRole('button', { name: 'Close' })[0]!)

      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Company overview' }))
      expect(document.querySelector('[data-matrix-company-members]')).toBeTruthy()
      expect(screen.getByTestId('open-channel')).toBeTruthy()
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Company overview' })).getByRole('button', { name: 'Close' }))

      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Company settings' }))
      await waitFor(() => expect(scrolled.at(-1)?.hasAttribute('data-matrix-company-avatar-settings')).toBe(true))
    } finally {
      if (previous) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', previous)
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      }
    }
  })

  it('switches company from the menu', async () => {
    await ready(platform({ companies: [ATUM, BETA] }))

    openMenu()
    expect(menuCompanyNames()).toEqual(['Atum Studio', 'Beta Works'])
    fireEvent.click(menuCompanies()[1]!)

    expect(await screen.findByRole('heading', { name: 'Beta Works' })).toBeTruthy()
    openMenu()
    expect(screen.getByRole('menuitemradio', { name: /^Beta Works · / }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('the company menu’s entries', () => {
  it('lists companies by name whatever order the directory sent, and the window draws no rail', async () => {
    await ready(platform({ companies: [BETA, ATUM] }))

    expect(document.querySelector('[data-matrix-company-rail]')).toBeNull()
    openMenu()
    expect(menuCompanyNames()).toEqual(['Atum Studio', 'Beta Works'])
  })

  it('draws each company’s squircle of two letters, and checks the one that is open', async () => {
    await ready(platform({ companies: [ATUM, BETA] }))

    openMenu()
    const [atum, beta] = menuCompanies()
    expect(atum!.getAttribute('aria-label')).toBe('Atum Studio · Admin')
    expect(beta!.getAttribute('aria-label')).toBe('Beta Works · Admin')
    expect(atum!.querySelector('[data-company-initials]')?.textContent).toBe('AS')
    expect(beta!.querySelector('[data-company-initials]')?.textContent).toBe('BW')
    expect(atum!.querySelector('[data-company-initials]')?.className).toContain('atum-avatar')
    expect(atum!.getAttribute('aria-checked')).toBe('true')
    expect(beta!.getAttribute('aria-checked')).toBe('false')
  })

  it('shows the shortcut beside a company’s name, and takes nothing away from a tenth company', async () => {
    await ready(platform({ companies: [ATUM, BETA] }))

    openMenu()
    const shortcuts = menuCompanies().map(item => item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent)
    expect(shortcuts).toHaveLength(2)
    expect(shortcuts[0]).toMatch(/1/)
    expect(shortcuts[1]).toMatch(/2/)
  })

  it('offers Create company from its own row only for a person who may, and opens the same dialog as before', async () => {
    await ready(platform({ companies: [ATUM, BETA], canCreate: true }))

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))
    expect(await screen.findByRole('dialog', { name: 'New company' })).toBeTruthy()
  })

  it('keeps one sidebar invite action and joins another company from Add company', async () => {
    await ready(platform({ companies: [ATUM, BETA], canCreate: true }))

    expect(document.querySelector('[data-team-space-invite-teammates]')).toBeTruthy()
    expect(document.querySelector('[data-team-space-join-invite-link]')).toBeNull()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add company' }))
    const add = await screen.findByRole('dialog', { name: 'New company' })
    fireEvent.click(within(add).getByRole('button', { name: 'Join with invite link' }))

    expect(await screen.findByRole('dialog', { name: 'Join a company' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'New company' })).toBeNull()
  })

  it('makes overview and settings visible when chosen from Board', async () => {
    const source = platform({ companies: [ATUM] })
    const scope = companySpaceScope('account-a', COMPANY_ID)
    patchCompanySpacePreferences(scope, { tab: 'board' })
    await ready(source)

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Company overview' }))
    expect(await screen.findByRole('dialog', { name: 'Company overview' })).toBeTruthy()
    expect(companySpacePreferences(scope).tab).toBe('chat')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Company overview' })).getByRole('button', { name: 'Close' }))

    patchCompanySpacePreferences(scope, { tab: 'board' })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Company settings' }))
    expect(await screen.findByRole('dialog', { name: 'Company overview' })).toBeTruthy()
    expect(companySpacePreferences(scope).tab).toBe('chat')
  })

  it('offers no Marketplace page until a company can hire from it', async () => {
    await ready(platform({ companies: [ATUM] }))

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Chat', 'Board'])
    expect(screen.queryByRole('tab', { name: 'Marketplace' })).toBeNull()
  })
})

describe('moving between companies from the keyboard', () => {
  const current = () => companyHeading()?.textContent

  it('goes to the Nth company in the menu’s order, and to nothing past the last', async () => {
    await ready(platform({ companies: [ATUM, BETA, GAMMA] }))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 3 } }))
    await waitFor(() => expect(current()).toBe('Gamma Labs'))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 2 } }))
    await waitFor(() => expect(current()).toBe('Beta Works'))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 4 } }))
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 0 } }))
    expect(current()).toBe('Beta Works')
  })

  it('steps to the company before or after, wrapping at either end', async () => {
    await ready(platform({ companies: [ATUM, BETA, GAMMA] }))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: -1 } }))
    await waitFor(() => expect(current()).toBe('Gamma Labs'))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: 1 } }))
    await waitFor(() => expect(current()).toBe('Atum Studio'))

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: 1 } }))
    await waitFor(() => expect(current()).toBe('Beta Works'))
  })

  it('has nowhere to go with one company, and does not reload the one it is on', async () => {
    const source = platform({ companies: [ATUM] })
    await ready(source)
    const reads = source.calls('read').length

    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: 1 } }))
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 1 } }))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(source.calls('read')).toHaveLength(reads)
    expect(document.querySelector('[data-matrix-company-rail]')).toBeNull()
  })
})

describe('which company opens first', () => {
  /** The sidebar's title, once a company has opened (the roster is its page). */
  const title = () => document.querySelector('[data-matrix-company-title] h1') as HTMLElement

  const open = async (source: Platform, rooms: MatrixRoom[] = []) => {
    renderTeamSpace(source, { rooms })
    await screen.findByRole('button', { name: 'Open # general' })

    return title()
  }

  it('opens the company last open on this device, by id, over the newest activity and the first by name', async () => {
    window.localStorage.setItem(lastCompanyKey, GAMMA.id)
    const busy = channelRoom(CHANNEL_IDS.ops, 'busy', { companyChannel: { companyId: BETA.id, channelId: CHANNEL_IDS.ops }, lastActiveAt: 9_000 })

    expect((await open(platform({ companies: [ATUM, BETA, GAMMA] }), [busy])).textContent).toBe('Gamma Labs')
  })

  it('falls back to the company with the newest activity when nothing is remembered', async () => {
    const quiet = channelRoom(CHANNEL_IDS.general, 'quiet', { lastActiveAt: 100 })
    const busy = channelRoom(CHANNEL_IDS.ops, 'busy', { companyChannel: { companyId: GAMMA.id, channelId: CHANNEL_IDS.ops }, lastActiveAt: 9_000 })

    expect((await open(platform({ companies: [ATUM, BETA, GAMMA] }), [quiet, busy])).textContent).toBe('Gamma Labs')
  })

  it('falls back to the first by name when there is neither', async () => {
    expect((await open(platform({ companies: [GAMMA, BETA, ATUM] }))).textContent).toBe('Atum Studio')
  })

  it('does not open a company the person is no longer in', async () => {
    window.localStorage.setItem(lastCompanyKey, '00000000-0000-4000-8000-c24048d7f808')

    expect((await open(platform({ companies: [BETA, ATUM] }))).textContent).toBe('Atum Studio')
  })

  it('remembers the company opened, per account, for the next time', async () => {
    await ready(platform({ companies: [ATUM, BETA] }))
    expect(window.localStorage.getItem(lastCompanyKey)).toBe(ATUM.id)

    openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Beta Works · / }))
    await waitFor(() => expect(window.localStorage.getItem(lastCompanyKey)).toBe(BETA.id))
    expect(window.localStorage.getItem('atum.team-space.last-company:account-b')).toBeNull()
  })

  it('does not reopen a company just left, even while the directory still lists it', async () => {
    const source = platform({ companies: [ATUM, BETA], viewer: 'member', mutations: {
      leave: () => ({ ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, state: 'removed', retired: false, authorityGeneration: 9 } })
    } })

    await ready(source)
    window.localStorage.setItem(lastCompanyKey, COMPANY_ID)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave company' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave Atum Studio?' })).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(title().textContent).toBe('Beta Works'))
    // The list the platform answers still has the company in it; it must not be opened again from there.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(title().textContent).toBe('Beta Works')
    expect(source.calls('read').filter(call => (call as { companyId: string }).companyId === COMPANY_ID)).toHaveLength(1)
  })
})

describe('which channel opens with a company', () => {
  const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }
  const ops = { id: CHANNEL_IDS.ops, name: 'ops', actions: ['update_metadata' as const] }

  it('lands in #general on first use and restores the last channel later', async () => {
    const source = platform({ channels: [general, ops] })
    const onOpenChannel = vi.fn(async () => {})
    renderTeamSpace(source, { convergenceDelayMs: 5, onOpenChannel, rooms: [channelRoom(general.id, 'general'), channelRoom(ops.id, 'ops')] })

    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    cleanup()
    resetTeamSpace()

    writeLastChannelId('account-a', COMPANY_ID, CHANNEL_IDS.ops)
    const reopened = vi.fn(async () => {})
    renderTeamSpace(platform({ channels: [general, ops] }), {
      convergenceDelayMs: 5,
      onOpenChannel: reopened,
      rooms: [channelRoom(general.id, 'general'), channelRoom(ops.id, 'ops')]
    })

    await waitFor(() => expect(reopened).toHaveBeenCalledWith('!ops:atum.example', expect.any(Function)))
  })
})

describe('a company just left, with one of its channels open', () => {
  it('is gone at once from the menu and the shortcuts, and a stale preference for it does not reselect it', async () => {
    const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }

    const source = platform({ companies: [ATUM, BETA, GAMMA], viewer: 'member', channels: [general], mutations: {
      leave: () => ({ ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, state: 'removed', retired: false, authorityGeneration: 9 } })
    } })

    // The window is on Atum Studio's channel: the app still names that company as the one wanted, as it will after the leave.
    renderTeamSpace(source, {
      rooms: [channelRoom(general.id, 'general')],
      activeRoomId: '!general:atum.example',
      preferredCompanyId: COMPANY_ID,
      channelContent: <div data-testid="open-channel">A channel is open</div>
    })

    await screen.findByTestId('open-channel')
    expect(companyHeading()?.textContent).toBe('Atum Studio')
    const readsOfLeft = () => source.calls('read').filter(call => (call as { companyId: string }).companyId === COMPANY_ID).length
    const readsBeforeLeaving = readsOfLeft()

    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave company' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Leave Atum Studio?' })).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(source.calls('leave')).toHaveLength(1))

    // The fallback order picks the company that is first by name, and the window still shows no rail.
    await waitFor(() => expect(companyHeading()?.textContent).toBe('Beta Works'))
    expect(document.querySelector('[data-matrix-company-rail]')).toBeNull()

    // The menu.
    openMenu()
    expect(menuCompanyNames()).toEqual(['Beta Works', 'Gamma Labs'])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    // The shortcuts: slot 1 is Beta now, slot 2 Gamma, and there is no slot 3; a step wraps within the two that remain.
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 2 } }))
    await waitFor(() => expect(companyHeading()?.textContent).toBe('Gamma Labs'))
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 3 } }))
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: 1 } }))
    await waitFor(() => expect(companyHeading()?.textContent).toBe('Beta Works'))
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { step: -1 } }))
    await waitFor(() => expect(companyHeading()?.textContent).toBe('Gamma Labs'))

    // Through the stale preference and the directory read that still lists the company, it was never read again.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(readsOfLeft()).toBe(readsBeforeLeaving)
  })
})

describe('the line about creating companies not being open yet', () => {
  const closed = 'Creating companies is not open yet.'

  it('is said to a person with no company who may not create one, and only then', async () => {
    renderTeamSpace(platform({ companies: [], canCreate: false }))

    expect(await screen.findByText(closed)).toBeTruthy()
  })

  it('is never said to a person who has a company, in the page or in the menu', async () => {
    await ready(platform({ companies: [ATUM, BETA], canCreate: false }))

    expect(screen.queryByText(closed)).toBeNull()
    openMenu()
    expect(document.body.textContent).not.toContain(closed)
  })

  it('gives a person with no company who may create one the stepped dialog instead', async () => {
    renderTeamSpace(platform({ companies: [], canCreate: true }))

    fireEvent.click(await screen.findByRole('button', { name: 'Create company' }))
    expect(await screen.findByLabelText('Company name')).toBeTruthy()
    expect(screen.queryByText(closed)).toBeNull()
  })
})
