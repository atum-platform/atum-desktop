import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixMember, MatrixMessage } from '../../shared/matrix'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import {
  filterMatrixHumanMentions,
  insertMatrixMention,
  matrixHumanMentions,
  matrixHumanMentionUserIds,
  matrixMentionMarkdown,
  matrixMentionMatch,
  matrixMentionProjection,
  matrixRoomMentionNeedsConfirmation,
  matrixRoomMentionRequested
} from './matrix-mentions'
import { TeamSpaceMentionContent } from './team-space/mention-content'
import { TeamSpaceMentionMenu } from './team-space/mention-menu'

const me = '@user-owner:test'
const linh = '@user-linh:test'
const otherLinh = '@user-other:test'

const members: MatrixMember[] = [
  { userId: me, name: 'Minh', membership: 'join', canRemove: false },
  { userId: linh, name: 'Linh', membership: 'join', avatarMxc: null, canRemove: false },
  { userId: otherLinh, name: 'Linh', membership: 'join', canRemove: false },
  { userId: '@service-room:test', name: 'Room manager', membership: 'join', canRemove: false },
  { userId: '@user-away:test', name: 'Away', membership: 'leave', canRemove: false }
]

const people = {
  ownerUserId: me,
  members,
  handles: { [linh]: 'linh', [otherLinh]: 'linh_two' },
  unnamed: 'Atum user'
}

describe('Team Space human mentions', () => {
  it('lists joined humans by name while excluding self, services and existing agent paths', () => {
    const candidates = matrixHumanMentions({
      excluded: new Set(['@agent-cos:test']),
      locale: 'en',
      members: [
        ...members,
        { userId: '@agent-cos:test', name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      people
    })

    expect(new Map(candidates.map(candidate => [candidate.userId, candidate.token]))).toEqual(
      new Map([
        [linh, '@linh'],
        [otherLinh, '@linh_two']
      ])
    )
    expect(filterMatrixHumanMentions(candidates, 'two').map(candidate => candidate.userId)).toEqual([otherLinh])
  })

  it('inserts at the caret and keeps duplicate display names bound to the picked identity', () => {
    const candidates = matrixHumanMentions({ excluded: new Set(), locale: 'en', members, people })
    const match = matrixMentionMatch('Ask @li today', 7)!

    const text = insertMatrixMention(
      'Ask @li today',
      match,
      candidates.find(candidate => candidate.userId === linh)!.token
    )

    expect(text).toBe('Ask @linh  today')
    expect(matrixHumanMentionUserIds(text, candidates, new Set([linh]))).toEqual([linh])
  })

  it('treats only an authorized whole @channel token as a room mention and confirms at twenty people', () => {
    expect(matrixRoomMentionRequested('Please read @channel.', true)).toBe(true)
    expect(matrixRoomMentionRequested('Please read @channel.', false)).toBe(false)
    expect(matrixRoomMentionRequested('mail@channel.example', true)).toBe(false)
    expect(matrixRoomMentionNeedsConfirmation(true, 19)).toBe(false)
    expect(matrixRoomMentionNeedsConfirmation(true, 20)).toBe(true)
  })

  it('projects bounded standard Matrix mention metadata', () => {
    expect(matrixMentionProjection({ user_ids: [linh, linh, 'bad'], room: true })).toEqual({
      userIds: [linh],
      room: true
    })
    expect(matrixMentionProjection({ user_ids: [] })).toBeUndefined()
  })

  it('turns declared mentions into pills without changing inline code', () => {
    const rendered = matrixMentionMarkdown(
      'Hi @linh and `@linh`; @channel',
      { userIds: [linh], room: true },
      people,
      '!room:test'
    )

    expect(rendered.text).toContain('[@linh](https://matrix.to/#/%40user-linh%3Atest)')
    expect(rendered.text).toContain('`@linh`')
    expect(rendered.text).toContain('[@channel](https://matrix.to/#/!room%3Atest)')
  })
})

describe('Team Space mention presentation', () => {
  it('orders people before @channel and picks the keyboard-selected row', () => {
    const candidates = matrixHumanMentions({ excluded: new Set(), locale: 'en', members, people })
    const onPick = vi.fn()
    render(
      <TeamSpaceMentionMenu
        copy={matrixTeamSpaceCopy('en')}
        onPick={onPick}
        options={[...candidates.map(mention => ({ kind: 'person' as const, mention })), { kind: 'channel' }]}
        selected={1}
      />
    )

    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      expect.stringContaining('Linh'),
      expect.stringContaining('Linh'),
      expect.stringContaining('@channel')
    ])
    fireEvent.click(screen.getAllByRole('option')[1]!)
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'person' }))
  })

  it('renders human and room mentions as inert pills inside the message', async () => {
    const message = {
      id: '$m',
      sender: '@other:test',
      body: 'Hi @linh and @channel',
      timestamp: 1,
      own: false,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      mentions: { userIds: [linh], room: true }
    } satisfies MatrixMessage

    const view = render(<TeamSpaceMentionContent message={message} people={people} roomId="!room:test" />)

    expect((await screen.findByText('@linh')).getAttribute('data-matrix-mention-pill')).not.toBeNull()
    expect((await screen.findByText('@channel')).getAttribute('data-matrix-mention-pill')).not.toBeNull()
    expect(view.container.querySelectorAll('a')).toHaveLength(0)
  })
})
