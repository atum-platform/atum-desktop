import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixPeopleSearchBridge } from '../../shared/matrix-people-search'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import { matrixChatTitle } from './chat-title'
import { matrixForwardTargets } from './forward-targets'
import { filterMatrixHumanMentions, matrixHumanMentions } from './matrix-mentions'
import { PersonHandleLine, personHandleText } from './person-handle-line'
import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'
import { matrixPersonLine } from './person-name'
import { companyAbilities } from './team-space/abilities'
import { InviteSheet } from './team-space/invite-sheet'
import { TeamSpaceMentionMenu } from './team-space/mention-menu'

const OWNER = '@synthetic-user-0013:example.invalid'
const POON = '@synthetic-user-0021:example.invalid'
const LAN = '@synthetic-user-0019:example.invalid'
const RAW_ID = /user-[0-9a-f]{8}/u

afterEach(() => {
  cleanup()
  resetMatrixHandlesForTest()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the @handle line', () => {
  it('shows a directory-shaped handle with or without its @, and nothing for an ID or no handle', () => {
    expect(personHandleText('poon')).toBe('@poon')
    expect(personHandleText('@poon')).toBe('@poon')
    expect(personHandleText(POON)).toBeUndefined()
    expect(personHandleText('user-4c65aa0b1c2d3e4f5a6b7c8d9e0f1a2b')).toBeUndefined()
    expect(personHandleText(null)).toBeUndefined()

    const { container } = render(
      <>
        <PersonHandleLine handle={POON} name="Poon" />
        <PersonHandleLine handle="poon" name="@poon" />
      </>
    )

    // An ID never passes as a handle, and a handle that is the name is not said twice.
    expect(container.querySelector('[data-person-handle]')).toBeNull()
  })
})

describe('company invite search', () => {
  function withDirectory(results: Awaited<ReturnType<MatrixPeopleSearchBridge['search']>>) {
    const search = vi.fn(async () => results)
    Object.assign(window, { atumMatrix: { people: { search } } })

    return search
  }

  const abilities = { ...companyAbilities({ admin: true, channels: true, rooms: true, conversations: false },
    { role: 'owner', policy: 'members' }), inviteLink: false }

  function sheet(query: string, mutate = vi.fn(async () => undefined)) {
    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <InviteSheet
          abilities={abilities}
          blocked={false}
          bridge={{} as never}
          companyId="00000000-0000-4000-8000-72805976e3a7"
          companyName="Atum Studio"
          dialogInstance={1}
          invitations={[]}
          mutate={mutate}
          notAllowed={false}
          nowSeconds={0}
          onClose={() => {}}
          onInvitationAction={() => {}}
          onRetry={async () => undefined}
          profile={{ admin: true, channels: true, rooms: true, conversations: false }}
          replayedLinkIds={new Set()}
          roster={[]}
          viewer="owner"
        />
      </I18nProvider>
    )

    fireEvent.change(screen.getByLabelText('Name, @username or email'), { target: { value: query } })

    return view
  }

  it.each(['poon', '@poon'])('finds someone by their handle typed as %s, shows it under the name and adds them by ID', async query => {
    const search = withDirectory({ ok: true, value: { limited: false, results: [{ userId: POON, name: 'Poon Nguyen', handle: 'poon' }] } })
    const mutate = vi.fn(async () => undefined)
    sheet(query, mutate)

    const add = await screen.findByRole('button', { name: 'Add Poon Nguyen' })
    expect(search).toHaveBeenCalledWith({ query, limit: 20 })
    expect(within(add.closest('li') as HTMLElement).getByText('@poon')).toBeTruthy()
    add.click()
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'invitation-create-directory', memberMatrixUser: POON }))
  })

  it('shows a handle the directory vouched for earlier, and no line (never an ID) for someone without one', async () => {
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(LAN, 'lan')
    withDirectory({
      ok: true,
      value: {
        limited: false,
        results: [
          { userId: LAN, name: 'Lan Nguyễn' },
          { userId: POON, name: 'Poon Nguyen' }
        ]
      }
    })

    const { container } = sheet('nguy')

    const lan = (await screen.findByRole('button', { name: 'Add Lan Nguyễn' })).closest('li') as HTMLElement
    expect(within(lan).getByText('@lan')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add Poon Nguyen' }).closest('li') as HTMLElement).querySelector('[data-person-handle]')).toBeNull()
    expect(container.textContent).not.toMatch(RAW_ID)
  })
})

describe('mentions', () => {
  const members = [
    { userId: OWNER, name: 'Minh', membership: 'join', canRemove: false },
    { userId: POON, name: 'Poon Nguyen', membership: 'join', canRemove: false },
    { userId: LAN, name: 'Lan', membership: 'join', canRemove: false }
  ]

  const people = { handles: { [POON]: 'poon' }, members, ownerUserId: OWNER, unnamed: 'Atum user' }

  it('lists a person under their name with their @handle, finds them by it, and adds no line without one', async () => {
    const candidates = matrixHumanMentions({ excluded: new Set(), locale: 'en', members, people })
    expect(filterMatrixHumanMentions(candidates, 'poon').map(each => each.name)).toEqual(['Poon Nguyen'])

    render(
      <TeamSpaceMentionMenu
        copy={matrixTeamSpaceCopy('en')}
        onPick={() => {}}
        options={candidates.map(mention => ({ kind: 'person' as const, mention }))}
        selected={0}
      />
    )

    const poon = screen.getByRole('option', { name: /Poon Nguyen/u })
    expect(within(poon).getByText('@poon')).toBeTruthy()
    const lan = screen.getByRole('option', { name: /Lan/u })
    expect(lan.querySelector('[data-person-handle]')).toBeNull()
    // Without a handle the menu does not repeat the name as "@Lan".
    expect(lan.textContent).not.toContain('@Lan')
  })
})

describe('inside a conversation, a known person is their name alone', () => {
  const room: MatrixRoom = {
    id: '!poon:example.invalid',
    name: 'Poon Nguyen',
    membership: 'join',
    encrypted: false,
    direct: true,
    participants: [
      { userId: OWNER, membership: 'join' },
      { userId: POON, membership: 'join' }
    ]
  }

  it('keeps the title bar, sender names and typing lines free of the handle', () => {
    const members = [
      { userId: POON, name: 'Poon Nguyen' },
      { userId: LAN, name: 'Lan' }
    ]

    expect(matrixChatTitle(room, { locale: 'en', untitled: 'Untitled chat', chatOn: date => date })).toBe('Poon Nguyen')
    expect(matrixPersonLine(POON, { handles: { [POON]: 'poon' }, members, ownerUserId: OWNER, unnamed: 'Atum user' })).toBe(
      'Poon Nguyen'
    )
  })

  it('gives a person\'s chat its handle where a message is forwarded to someone (picking who)', async () => {
    const [target] = matrixForwardTargets({
      rooms: [room],
      ownerUserId: OWNER,
      sourceRoomId: '!other:example.invalid',
      encryptedFile: false,
      defaultAssistantName: 'Assistant',
      handles: { [POON]: 'poon' }
    })

    await waitFor(() => expect(target?.subtitle).toBe('@poon'))
    expect(target?.name).toBe('Poon Nguyen')
  })
})

describe('create-channel people picker', () => {
  it('puts the @handle on its own line under the name and finds people by it with or without @', async () => {
    const { ChannelPeoplePicker } = await import('./team-space/channel-people-picker')

    const roster = [
      { memberRef: 'me', role: 'member' as const, state: 'active' as const, self: true, handle: 'minh', displayName: 'Minh' },
      { memberRef: 'a', role: 'member' as const, state: 'active' as const, self: false, handle: 'poon', displayName: 'Poon Nguyen' }
    ]

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <ChannelPeoplePicker onChange={() => {}} picked={[]} roster={roster} />
      </I18nProvider>
    )

    const row = screen.getByRole('option', { name: /Poon Nguyen/u })
    expect(row.querySelector('[data-person-handle]')?.textContent).toBe('@poon')
  })
})
