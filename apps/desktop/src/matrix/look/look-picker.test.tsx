import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import moonFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import type { AppDescriptor } from '../../../shared/app-catalog'
import { decodeLookPack, type LookRoomAccountData } from '../../../shared/look-pack'
import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'

import { ChatLookPicker } from './look-picker'

const pack = decodeLookPack(moonFixture)!
const galleryPack = {
  ...pack,
  pack_id: '00000000-0000-4000-8000-2b8030a8cdd8',
  publisher: { kind: 'atum' as const },
  name: { en: 'Paper', vi: 'Giấy' }
}
const app: AppDescriptor = {
  app: 'luna',
  app_id: '00000000-0000-4000-8000-e79acd97ac88',
  app_version_id: '00000000-0000-4000-8000-993224b4fe85',
  name: { en: 'Luna', vi: 'Luna' },
  subtitle: null,
  description: null,
  icon: null,
  accent: '#D8612F',
  affiliation: 'partner',
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: ['direct'],
  has_surface: false,
  link: { mode: 'none', state: 'never_linked' },
  bot: {
    v: 1,
    user_id: '@app-luna:atumplatform.com',
    handle: 'luna_bot',
    display_name: 'Luna',
    avatar: { url: '', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'LUNA', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: false,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: false,
    purchase_route_id: 'chat'
  },
  look: { ...pack, publisher: { kind: 'app', app_id: '00000000-0000-4000-8000-e79acd97ac88' } }
}
const room: MatrixRoom = {
  id: '!luna:test',
  name: 'Luna',
  membership: 'join',
  encrypted: false,
  direct: true,
  participants: [
    { userId: '@owner:test', membership: 'join' },
    { userId: '@app-luna:atumplatform.com', membership: 'join' }
  ]
}
const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'OWNER' },
  rooms: [room],
  roomId: room.id,
  messages: [],
  error: null,
  apps: { state: 'ready', apps: [app], connections: {}, gallery: [galleryPack] }
}
const defaultLook: LookRoomAccountData = { v: 1, background: { kind: 'default' } }

function mount(command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)) {
  window.atumMatrix = { command } as unknown as MatrixUiBridge
  const preview = vi.fn()

  function Harness() {
    const [current, setCurrent] = useState(defaultLook)

    return (
      <ChatLookPicker
        appearance="light"
        current={current}
        onOpenChange={vi.fn()}
        onPreview={look => {
          preview(look)
          setCurrent(look)
        }}
        open
        room={room}
        snapshot={snapshot}
      />
    )
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <Harness />
    </I18nProvider>
  )

  return { command, preview }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('shows the app pack, applies live, and writes the exact room account-data record', async () => {
  const { command, preview } = mount()
  const choice = await screen.findByRole('gridcell', { name: 'Luna' })
  fireEvent.click(choice)
  const look = { v: 1, background: { kind: 'pack', pack_id: pack.pack_id } }

  expect(preview).toHaveBeenCalledExactlyOnceWith(look)
  expect(choice.getAttribute('aria-pressed')).toBe('true')
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'chatLook', roomId: room.id, look }))
})

it('merges the platform gallery with roster app packs without repeating either source', async () => {
  mount()
  expect(await screen.findByRole('gridcell', { name: 'Default' })).toBeTruthy()
  expect(screen.getByRole('gridcell', { name: 'Paper' })).toBeTruthy()
  expect(screen.getByRole('gridcell', { name: 'Luna' })).toBeTruthy()
  expect(screen.getByText('Atum')).toBeTruthy()
  expect(screen.getByText('From apps')).toBeTruthy()
})

it('walks the tile grid with arrows and keeps every tile keyboard named', async () => {
  mount()
  const first = await screen.findByRole('gridcell', { name: 'Default' })
  const second = screen.getByRole('gridcell', { name: 'Paper' })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(second)
  fireEvent.keyDown(second, { key: 'Home' })
  expect(document.activeElement).toBe(first)
})

it('rolls the live preview back and shows one short line when account-data persistence fails', async () => {
  const command = vi.fn<MatrixUiBridge['command']>().mockRejectedValue(new Error('offline'))
  const { preview } = mount(command)
  fireEvent.click(await screen.findByRole('gridcell', { name: 'Luna' }))

  await screen.findByText('Couldn’t save. Try again.')
  expect(preview.mock.calls).toEqual([
    [{ v: 1, background: { kind: 'pack', pack_id: pack.pack_id } }],
    [defaultLook]
  ])
})
