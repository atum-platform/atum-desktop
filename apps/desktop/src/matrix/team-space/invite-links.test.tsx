import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { InviteLinks } from './invite-links'
import type { MutationOutcome, TeamSpaceMutate } from './outcome'
import { COMPANY_ID, OTHER_COMPANY_ID, platform, type Platform } from './test-support'

const urlOf = (letter: string) => `https://atum.app/j/${letter.repeat(43)}`
const LINK_ID = '00000000-0000-4000-8000-05d9ec66b6d2'

const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(cleanup)

/** The workspace's mutate, minus the journal: straight to the scripted platform. */
const direct =
  (source: Platform): TeamSpaceMutate =>
  async mutation => {
    const result = await source.bridge.request(mutation)

    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: result.error, ...(result.reason ? { reason: result.reason } : {}), uncertain: false }
  }

interface Props {
  companyId?: string
  dialogInstance?: number
  mutate?: TeamSpaceMutate
  replayedLinkIds?: ReadonlySet<string>
}

const links = (source: Platform, { companyId = COMPANY_ID, dialogInstance = 1, mutate, replayedLinkIds = new Set() }: Props = {}) => (
  <I18nProvider configClient={null} initialLocale="en">
    <InviteLinks
      blocked={false}
      bridge={source.bridge}
      companyId={companyId}
      dialogInstance={dialogInstance}
      mutate={mutate ?? direct(source)}
      replayedLinkIds={replayedLinkIds}
    />
  </I18nProvider>
)

const create = () => fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }))

describe('an invite link’s one-time text', () => {
  it('belongs to one company in one dialog: a new company or a new opening never sees it, and it does not come back', async () => {
    const source = platform()
    const view = render(links(source))

    create()
    expect(await screen.findByDisplayValue(urlOf('A'))).toBeTruthy()

    // Another company: gone at once (not after an effect), and not there when this company returns.
    view.rerender(links(source, { companyId: OTHER_COMPANY_ID }))
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()
    view.rerender(links(source))
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()

    // The same company, a new opening of the dialog.
    create()
    expect(await screen.findByDisplayValue(urlOf('A'))).toBeTruthy()
    view.rerender(links(source, { dialogInstance: 2 }))
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()

    // Unmounting leaves nothing of it in the document.
    view.unmount()
    expect(document.body.textContent).not.toContain(urlOf('A'))
  })

  it('is not kept, nor copied, when the answer arrives after the company has moved on', async () => {
    const source = platform()
    let answer!: (outcome: MutationOutcome) => void
    const slow: TeamSpaceMutate = () => new Promise<MutationOutcome>(resolve => void (answer = resolve))
    const view = render(links(source, { mutate: slow }))

    create()
    view.rerender(links(source, { companyId: OTHER_COMPANY_ID, mutate: slow }))

    answer({
      ok: true,
      value: {
        schemaVersion: 3,
        replayed: false,
        link: { id: LINK_ID, companyId: COMPANY_ID, role: 'member', state: 'active', createdAt: 1_800_000_000,
          expiresAt: 1_800_604_800, maxUses: 10, uses: 0, url: urlOf('A') }
      }
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy invite link' }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()
    expect(document.body.textContent).not.toContain(urlOf('A'))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('is shown to the company and dialog that made it, and copied', async () => {
    const source = platform()
    render(links(source, { companyId: OTHER_COMPANY_ID }))

    create()
    expect(await screen.findByDisplayValue(urlOf('B'))).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(urlOf('B'))
  })
})

describe('a link whose create was replayed', () => {
  const summary = { id: LINK_ID, uses: 0, maxUses: 10, expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 3 }

  it('says on its own row that its text can only be shown once, and that it can be revoked', async () => {
    const source = platform({ links: [summary] })
    render(links(source, { replayedLinkIds: new Set([LINK_ID]) }))

    const row = (await screen.findByText(/0 of 10 used/)).closest('li') as HTMLElement
    expect(row.getAttribute('data-invite-link-id')).toBe(LINK_ID)
    expect(within(row).getByText(/can only be shown once/)).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('puts the notice on no other row, and on none for a link nobody replayed', async () => {
    const other = { id: '00000000-0000-4000-8000-751ad2c298e5', uses: 1, maxUses: 5, expiresAt: summary.expiresAt }
    const source = platform({ links: [summary, other] })
    render(links(source, { replayedLinkIds: new Set([LINK_ID]) }))

    await screen.findByText(/1 of 5 used/)
    expect(document.querySelectorAll('[data-invite-link-replayed]')).toHaveLength(1)
    expect(document.querySelector(`[data-invite-link-id="${other.id}"] [data-invite-link-replayed]`)).toBeNull()
  })

  it('reads the list again when a replay is noted while it is open, so the row is there to say it', async () => {
    const source = platform()
    const view = render(links(source))

    await waitFor(() => expect(source.calls('invite-links')).toHaveLength(1))
    expect(document.querySelector('[data-invite-link-replayed]')).toBeNull()

    // The workspace's Retry ran the create; the platform now lists the link.
    source.state.links.push(summary)
    view.rerender(links(source, { replayedLinkIds: new Set([LINK_ID]) }))

    expect(await screen.findByText(/can only be shown once/)).toBeTruthy()
    expect(source.calls('invite-links')).toHaveLength(2)
  })
})
