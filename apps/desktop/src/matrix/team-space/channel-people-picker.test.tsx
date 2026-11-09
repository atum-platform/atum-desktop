import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { channelPeopleCandidates, ChannelPeoplePicker } from './channel-people-picker'
import type { RosterMember } from './views'

afterEach(cleanup)

const person = (memberRef: string, displayName: string | null, handle: string | null, over: Partial<RosterMember> = {}): RosterMember =>
  ({ memberRef, role: 'member', state: 'active', self: false, handle, displayName, ...over })

const roster = [
  person('me', 'Minh', 'minh', { self: true }),
  person('a', 'Bảo', 'bao'),
  person('b', 'Lan Nguyễn', 'lan_nguyen'),
  person('c', null, 'tu'),
  person('d', 'Đức', 'duc', { state: 'invited' })
]

describe('channelPeopleCandidates', () => {
  it('lists active people other than the creator, matched by name or @username, accents ignored', () => {
    expect(channelPeopleCandidates(roster, '').map(row => row.memberRef)).toEqual(['a', 'b', 'c'])
    expect(channelPeopleCandidates(roster, 'nguyen').map(row => row.memberRef)).toEqual(['b'])
    expect(channelPeopleCandidates(roster, '@TU').map(row => row.memberRef)).toEqual(['c'])
    expect(channelPeopleCandidates(roster, 'minh')).toEqual([])
    expect(channelPeopleCandidates(roster, 'duc')).toEqual([])
  })
})

function Harness() {
  const [picked, setPicked] = useState<string[]>([])

  return (
    <I18nProvider configClient={null} initialLocale="en">
      <ChannelPeoplePicker onChange={setPicked} picked={picked} roster={roster} />
      <output data-testid="picked">{picked.join(',')}</output>
    </I18nProvider>
  )
}

describe('ChannelPeoplePicker keyboard', () => {
  it('moves with the arrows and picks the highlighted person with Enter', () => {
    render(<Harness />)
    const search = screen.getByRole('combobox', { name: 'Search by name or @username' })

    // Enter in an empty search before any arrow is left to the form (it submits the sheet).
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByTestId('picked').textContent).toBe('')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toContain('b')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByTestId('picked').textContent).toBe('b')

    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByTestId('picked').textContent).toBe('b,a')
  })

  it('says so when nobody else is in the company', () => {
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <ChannelPeoplePicker onChange={() => {}} picked={[]} roster={[roster[0]!]} />
      </I18nProvider>
    )
    expect(screen.getByText('Chưa có ai khác trong công ty.')).toBeTruthy()
  })
})
