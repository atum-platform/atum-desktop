import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $atumAppCatalog } from '@/lib/atum-app-catalog'

import { GroupParticipantIdentity } from './group-participant-identity'

vi.mock('../atum/agents', () => ({
  $atumAgents: atom([
    {
      hostedId: 'owned-agent',
      title: 'Marketing',
      description: 'Launch planning',
      avatarUrl: 'https://cdn.atum.test/marketing.webp'
    }
  ])
}))

vi.mock('../atum/assistant-directory', () => ({
  $atumAssistantDirectory: atom({
    accountId: 'owner',
    entries: [{ id: 'hosted-only', displayName: 'Research', avatarUrl: 'https://cdn.atum.test/research.webp' }],
    state: 'ready'
  })
}))

afterEach(cleanup)

it('uses the same localized app identity as the roster instead of legacy room metadata', () => {
  $atumAppCatalog.set({ accountId: 'owner', apps: [{ app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: { en: 'Astrology specialist', vi: 'Chuyên gia chiêm tinh' }, icon: { url: 'https://cdn.atum.test/moon.png', sha256: 'a'.repeat(64) }, verified: true, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }], state: 'ready' })
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="vi">
      <GroupParticipantIdentity displayName="Legacy Moon label" target={{ type: 'specialist', id: 'moon' }} />
    </I18nProvider>
  )

  expect(screen.getByText('Moon')).toBeTruthy()
  expect(screen.getByText('Chuyên gia chiêm tinh')).toBeTruthy()
  expect(screen.queryByText('Legacy Moon label')).toBeNull()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.atum.test/moon.png')
})

it('resolves the owned agent by hosted ID and preserves its photo and description', () => {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <GroupParticipantIdentity displayName="Old name" target={{ type: 'assistant', id: 'owned-agent' }} />
    </I18nProvider>
  )

  expect(screen.getByText('Marketing')).toBeTruthy()
  expect(screen.getByText('Launch planning')).toBeTruthy()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.atum.test/marketing.webp')
})

it('does not give an unknown app another participant’s identity', () => {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <GroupParticipantIdentity
        displayName="New app"
        status="Unavailable"
        target={{ type: 'specialist', id: 'owned-agent' }}
      />
    </I18nProvider>
  )

  expect(screen.getByText('New app')).toBeTruthy()
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(container.querySelector('img')).toBeNull()
})

it('uses the hosted photo even when this machine has no matching local profile', () => {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <GroupParticipantIdentity displayName="Old name" target={{ type: 'assistant', id: 'hosted-only' }} />
    </I18nProvider>
  )

  expect(screen.getByText('Research')).toBeTruthy()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.atum.test/research.webp')
})

it('uses the shared-room agent projection instead of this machine’s local profile', () => {
  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <GroupParticipantIdentity
        assistant={{
          assistantId: 'owned-agent',
          displayName: 'Shared marketing',
          avatarUrl: 'https://cdn.atum.test/shared-marketing.webp',
          ownerUserId: 'lan',
          ownerDisplayName: 'Lan',
          membershipEpoch: 2,
          availability: 'assistant_not_owned'
        }}
        displayName="Old local name"
        target={{ type: 'assistant', id: 'owned-agent' }}
      />
    </I18nProvider>
  )

  expect(screen.getByText('Shared marketing')).toBeTruthy()
  expect(screen.getByText("Lan's Shared marketing")).toBeTruthy()
  expect(screen.queryByText('Launch planning')).toBeNull()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.atum.test/shared-marketing.webp')
})
