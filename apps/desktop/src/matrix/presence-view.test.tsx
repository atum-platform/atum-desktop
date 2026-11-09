import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { MatrixMemberAvatar } from './member-avatar'
import { bindMatrixPresenceSnapshot, clearMatrixPresence } from './presence-store'

afterEach(() => {
  cleanup()
  clearMatrixPresence()
})

it('shows observed online and DND beside a teammate avatar', () => {
  bindMatrixPresenceSnapshot({
    identity: { userId: '@me:test', deviceId: 'ONE' },
    presence: {
      users: [{
        userId: '@linh:test', state: 'online', displayName: 'Linh',
        status: { dnd: true, emoji: '🏡', text: 'Working from home', expiresAt: Date.now() + 60_000 }
      }]
    }
  })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixMemberAvatar className="size-8" id="@linh:test" name="Linh" />
    </I18nProvider>
  )

  const indicator = screen.getByRole('img', { name: /Do not disturb.*Working from home/ })
  expect(indicator.getAttribute('data-person-presence')).toBe('dnd')
})

it('draws no dot when the homeserver supplied no presence evidence', () => {
  bindMatrixPresenceSnapshot({ identity: { userId: '@me:test', deviceId: 'ONE' }, presence: { users: [] } })

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixMemberAvatar className="size-8" id="@linh:test" name="Linh" />
    </I18nProvider>
  )

  expect(view.container.querySelector('[data-person-presence]')).toBeNull()
})

it('leaves the dot off a face whose place asks for none, keeping the face and its tooltip', () => {
  bindMatrixPresenceSnapshot({
    identity: { userId: '@me:test', deviceId: 'ONE' },
    presence: { users: [{ userId: '@linh:test', state: 'online', displayName: 'Linh' }] }
  })

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixMemberAvatar className="size-7" id="@linh:test" name="Linh" presence={false} />
      <MatrixMemberAvatar className="size-8" id="@linh:test" name="Linh" />
    </I18nProvider>
  )

  const faces = view.container.querySelectorAll('[data-person-avatar="@linh:test"]')
  expect(faces).toHaveLength(2)
  expect(faces[0]!.querySelector('[data-person-presence]')).toBeNull()
  expect(faces[0]!.getAttribute('title')).toBe('Online')
  expect(faces[1]!.querySelector('[data-person-presence]')?.getAttribute('data-person-presence')).toBe('online')
})
