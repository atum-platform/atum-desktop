import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, LOCALE_OPTIONS } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixAliasResult } from '../../../shared/matrix-aliases'
import type { MatrixFounderContactResult } from '../../../shared/matrix-founder'
import { MatrixAddFriend } from '../add-friend'

import { FounderContactUs } from './contact-us'
import { FOUNDER_COPY } from './founder-copy'
import {
  $founderChatRequests,
  $founderDraftOpen,
  $founderProfileOpen,
  closeFounderDraft,
  closeFounderProfile
} from './founder-store'
import { FounderHeaderIdentity } from './header-identity'
import { FounderIntroCard } from './intro-card'
import { FounderProfileSheet } from './profile-sheet'

const OWNER = '@owner:test'
const FOUNDER = '@user-0f1e2d3c4b5a69788796a5b4c3d2e1f0:test'

afterEach(() => {
  cleanup()
  closeFounderDraft()
  closeFounderProfile()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const founderChat: MatrixRoom = {
  id: '!founder:test',
  name: 'Founder',
  membership: 'join',
  encrypted: true,
  direct: true,
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: FOUNDER, membership: 'invite' }
  ]
}

function snapshot(extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: OWNER, deviceId: 'OWNER' },
    rooms: [founderChat],
    roomId: null,
    messages: [],
    error: null,
    founder: { userId: FOUNDER, verification: 'official', roomId: '!founder:test', handle: 'founder' },
    officialAccounts: [{ userId: FOUNDER, tier: 'official', role: 'founder', handle: 'founder' }],
    ...extra
  }
}

function inLocale(locale: string, node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale as 'en'}>
      {node}
    </I18nProvider>
  )
}

function bridge(contact?: () => Promise<MatrixFounderContactResult>) {
  const value = {
    command: vi.fn(async () => null),
    openLink: vi.fn(async () => {}),
    ...(contact ? { founder: { contact: vi.fn(contact) } } : {})
  }

  window.atumMatrix = value as unknown as MatrixUiBridge

  return value
}

describe('the Founder copy', () => {
  it("keeps the owner's intro word for word, and the name untranslated, in every language", () => {
    expect(FOUNDER_COPY.en.intro).toBe('Questions, ideas or problems? Message me here. I usually reply within a day.')
    expect(FOUNDER_COPY.vi.intro).toBe(
      'Có câu hỏi, ý tưởng hay gặp sự cố? Nhắn cho tôi ở đây. Tôi thường trả lời trong vòng một ngày.'
    )
    expect(Object.keys(FOUNDER_COPY).sort()).toEqual(LOCALE_OPTIONS.map(option => option.id).sort())

    for (const copy of Object.values(FOUNDER_COPY)) {
      expect(copy.name).toBe('Founder')
    }

    expect(FOUNDER_COPY.vi.subtitle).toBe('Nhà sáng lập Atum')
  })

  it('never says Matrix, names a person or shows a personal address', () => {
    const words = JSON.stringify(FOUNDER_COPY)

    expect(words).not.toMatch(/matrix|hermes|https?:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
  })
})

describe('the intro card', () => {
  it.each(LOCALE_OPTIONS.map(option => option.id))(
    'draws the raven, the name with its mark and the intro in %s',
    id => {
      const { container } = inLocale(id, <FounderIntroCard />)

      expect(container.querySelector('[data-founder-avatar]')).toBeTruthy()
      expect(screen.getByText('Founder')).toBeTruthy()
      expect(container.querySelector('[data-verified-mark="official"]')).toBeTruthy()
      expect(screen.getByText(FOUNDER_COPY[id].subtitle)).toBeTruthy()
      expect(container.querySelector('[data-founder-intro-text]')?.textContent).toBe(FOUNDER_COPY[id].intro)
    }
  )
})

describe('the chat header', () => {
  it('shows the raven, Founder with its mark and who they are, and opens the profile', () => {
    const { container } = inLocale('vi', <FounderHeaderIdentity />)
    const header = screen.getByRole('button', { name: 'Founder, Tài khoản chính thức của Atum, Nhà sáng lập Atum' })

    expect(container.querySelector('[data-founder-avatar]')).toBeTruthy()
    expect(within(header).getByRole('img', { name: 'Tài khoản chính thức của Atum' })).toBeTruthy()
    expect(container.querySelector('[data-matrix-chat-subtitle]')?.textContent).toBe('Nhà sáng lập Atum')
    fireEvent.click(header)
    expect($founderProfileOpen.get()).toBe(true)
  })
})

describe('the profile sheet', () => {
  it('shows who they are, the promise and what the filled mark means, and Message opens the chat', async () => {
    const native = bridge()
    const onOpenChat = vi.fn()
    inLocale('en', <FounderProfileSheet fail={vi.fn()} onOpenChat={onOpenChat} snapshot={snapshot()} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => $founderProfileOpen.set(true))
    const sheet = await screen.findByRole('dialog', { name: /Founder/ })

    expect(sheet.querySelector('[data-founder-avatar]')).toBeTruthy()
    expect(within(sheet).getByText('Atum founder')).toBeTruthy()
    expect(within(sheet).getByText('@founder')).toBeTruthy()
    expect(within(sheet).getByText('Usually replies within a day')).toBeTruthy()
    // The Founder is official only: one line on the filled mark, never the hollow one beside it.
    expect(within(sheet).getByText('Run by Atum')).toBeTruthy()
    expect(sheet.querySelector('[data-founder-legend] [data-verified-mark="official"]')).toBeTruthy()
    expect(sheet.querySelector('[data-verified-mark="verified"]')).toBeNull()
    // The title's mark is announced once; the legend's mark is not read a second time.
    expect(within(sheet).getAllByRole('img', { name: 'Official Atum account' })).toHaveLength(1)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Message' }))
    expect(onOpenChat).toHaveBeenCalled()
    expect(native.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!founder:test' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('never opens without the Founder chat', () => {
    bridge()
    inLocale('en', <FounderProfileSheet fail={vi.fn()} onOpenChat={vi.fn()} snapshot={snapshot({ rooms: [] })} />)
    act(() => $founderProfileOpen.set(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Contact us', () => {
  it('opens the Founder chat the person has', async () => {
    const native = bridge(async () => ({ unavailable: true }))
    const onClose = vi.fn()
    const requests = $founderChatRequests.get()
    inLocale('en', <FounderContactUs onClose={onClose} snapshot={snapshot()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Message' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(native.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!founder:test' })
    expect(native.founder!.contact).not.toHaveBeenCalled()
    expect($founderChatRequests.get()).toBe(requests + 1)
  })

  it('opens the draft, making and inviting nothing, while the Founder is only offered', async () => {
    const native = bridge(async () => ({ roomId: '!new:test' }))
    const onClose = vi.fn()
    const requests = $founderChatRequests.get()
    inLocale(
      'en',
      <FounderContactUs
        onClose={onClose}
        snapshot={snapshot({
          rooms: [],
          founder: { userId: FOUNDER, verification: 'official', handle: 'founder', offer: true }
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Message' }))

    expect(onClose).toHaveBeenCalled()
    expect($founderDraftOpen.get()).toBe(true)
    expect(native.founder!.contact).not.toHaveBeenCalled()
    expect(native.command).not.toHaveBeenCalled()
    expect($founderChatRequests.get()).toBe(requests + 1)
  })

  it('asks for the chat when there is none, and falls back to the support email when it cannot be had', async () => {
    const made = bridge(async () => ({ roomId: '!new:test' }))
    const onClose = vi.fn()
    const view = inLocale('en', <FounderContactUs onClose={onClose} snapshot={snapshot({ rooms: [] })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Message' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(made.founder!.contact).toHaveBeenCalledOnce()
    view.unmount()

    const unreachable = bridge(async () => ({ unavailable: true }))
    inLocale('en', <FounderContactUs onClose={onClose} snapshot={snapshot({ rooms: [] })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Message' }))
    expect(await screen.findByText("Founder can't be reached right now. You can email us instead.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Email support' }))
    expect(unreachable.openLink).toHaveBeenCalledWith('mailto:support@atumplatform.com?subject=Atum%20support')
  })

  it('offers only the support email when no founder is named, and nothing on the founder account', () => {
    const native = bridge(async () => ({ roomId: '!new:test' }))
    const view = inLocale('vi', <FounderContactUs onClose={vi.fn()} snapshot={snapshot({ founder: undefined })} />)

    expect(screen.queryByRole('button', { name: 'Nhắn tin' })).toBeNull()
    expect(screen.getByText('support@atumplatform.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Gửi email hỗ trợ' }))
    expect(native.openLink).toHaveBeenCalledWith(
      'mailto:support@atumplatform.com?subject=H%E1%BB%97%20tr%E1%BB%A3%20Atum'
    )
    view.unmount()

    const { container } = inLocale(
      'en',
      <FounderContactUs onClose={vi.fn()} snapshot={snapshot({ identity: { userId: FOUNDER, deviceId: 'FOUNDER' } })} />
    )

    expect(container.querySelector('[data-founder-contact]')).toBeNull()
  })
})

describe('Add friend', () => {
  function addFriend(
    rooms: MatrixRoom[],
    contact = vi.fn(async (): Promise<MatrixFounderContactResult> => ({ roomId: '!new:test' }))
  ) {
    const command = vi.fn(async () => null)

    const found: MatrixAliasResult = {
      ok: true,
      value: { kind: 'lookup', handle: 'founder', state: 'assigned', principalKind: 'human', matrixUser: FOUNDER }
    }

    window.atumMatrix = {
      command,
      founder: { contact },
      aliases: { pending: vi.fn(), request: vi.fn(async () => found) }
    } as unknown as MatrixUiBridge

    const spies = { onCreated: vi.fn(), onOpenRoom: vi.fn(), onOpenChange: vi.fn() }

    inLocale(
      'en',
      <MatrixAddFriend
        initialQuery="@founder"
        onOpenAssistant={vi.fn()}
        open
        snapshot={snapshot({ rooms })}
        {...spies}
      />
    )

    return { command, contact, ...spies }
  }

  const message = async () => {
    const row = await waitFor(() => {
      const value = window.document.querySelector<HTMLElement>('[data-matrix-person-found]')

      if (!value) {
        throw new Error('not found yet')
      }

      return value
    })

    fireEvent.click(within(row).getByRole('button', { name: /Message|Open/ }))
  }

  it('starts the Founder chat, never a plain one, when the founder has no chat yet', async () => {
    const f = addFriend([])

    await message()
    expect(f.contact).toHaveBeenCalledOnce()
    expect(f.command).not.toHaveBeenCalled()
    await waitFor(() => expect(f.onCreated).toHaveBeenCalledOnce())
  })

  it('opens the Founder chat the person already has', async () => {
    const f = addFriend([founderChat])

    await message()
    expect(f.onOpenRoom).toHaveBeenCalledWith('!founder:test')
    expect(f.contact).not.toHaveBeenCalled()
  })

  it('says it did not work when the chat cannot be had', async () => {
    const f = addFriend(
      [],
      vi.fn(async (): Promise<MatrixFounderContactResult> => ({ unavailable: true }))
    )

    await message()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(f.onCreated).not.toHaveBeenCalled()
    expect(f.command).not.toHaveBeenCalled()
  })
})
